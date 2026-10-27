//! 局域网接收端：一个极简 HTTP/1.1 服务，只提供 /ping、/msg、/file 三条路由。
//!
//! 所有请求都要带签名头，口令不匹配一律 403；文件流式落盘并边写边算 sha256，
//! 校验不过就删掉临时文件回 422，绝不留下半成品。

use super::Hub;
use crate::store::{self, safe_rel_join, HashWriter, Message, MAX_BODY_BYTES, MAX_FILE_BYTES};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tiny_http::{Header, Response, Server};

pub const APP_TAG: &str = "image-compare";

/// 从 DEFAULT_PORT 起最多试 10 个端口，返回（服务、实际端口）。
fn bind_first_free() -> Result<(Server, u16), String> {
    let mut last_err = String::from("没有可用端口");
    for offset in 0..super::PORT_TRIES {
        let port = super::DEFAULT_PORT + offset;
        match Server::http(("0.0.0.0", port)) {
            Ok(s) => return Ok((s, port)),
            Err(e) => last_err = format!("{e}"),
        }
    }
    Err(format!(
        "{}~{} 端口全部监听失败：{last_err}",
        super::DEFAULT_PORT,
        super::DEFAULT_PORT + super::PORT_TRIES - 1
    ))
}

pub fn spawn(hub: Arc<Hub>) {
    std::thread::spawn(move || {
        let (server, port) = match bind_first_free() {
            Ok(v) => v,
            Err(e) => {
                hub.set_net_error(e.clone());
                eprintln!("[net] {e}");
                return;
            }
        };
        *hub.port.lock().expect("port 锁中毒") = port;
        eprintln!("[net] 接收服务已监听 0.0.0.0:{port}");
        hub.emit_peers_changed();

        // 每个请求起一个线程：大文件上传期间心跳不能被堵住，否则会误判对端离线
        for req in server.incoming_requests() {
            let hub2 = hub.clone();
            std::thread::spawn(move || {
                if let Err(e) = handle(hub2, req) {
                    eprintln!("[net] 处理请求失败: {e}");
                }
            });
        }
    });
}

fn header_map(req: &tiny_http::Request) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for h in req.headers() {
        m.insert(
            h.field.as_str().to_ascii_lowercase().to_string(),
            h.value.as_str().to_string(),
        );
    }
    m
}

fn reply_json(status: u16, obj: &serde_json::Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(obj).unwrap_or_else(|_| b"{}".to_vec());
    let ct: Header =
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
            .expect("固定 Content-Type 头不可能非法");
    Response::from_data(body)
        .with_status_code(status)
        .with_header(ct)
        .with_header(
            Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).expect("固定头不可能非法"),
        )
}

/// 回复并把 io 错误转成本模块统一的 String（tiny_http 的 respond 消耗 self，
/// 所以每条路由都是「先读完 body，最后再 respond」的顺序）
fn answer(
    req: tiny_http::Request,
    status: u16,
    obj: &serde_json::Value,
) -> Result<(), String> {
    req.respond(reply_json(status, obj))
        .map_err(|e| format!("回复 {status} 失败: {e}"))
}

/// 限量读完 body：/msg 与 /recall 都是「先把 JSON 收完才能算签名」。
/// 返回 (内容, 是否超限) —— 超限那一条也得把后面的字节吃干，否则残体会
/// 当成下一个请求的开头读，把这条连接上的后续请求串坏
fn read_bounded(req: &mut tiny_http::Request) -> Result<(Vec<u8>, bool), String> {
    let mut body: Vec<u8> = Vec::new();
    let mut oversize = false;
    let mut buf = [0u8; 16 * 1024];
    let reader = req.as_reader();
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("读取消息体失败: {e}"))?;
        if n == 0 {
            break;
        }
        if oversize {
            continue; // 已超限，只负责把后面的字节吃干
        }
        if body.len() as u64 + n as u64 > MAX_BODY_BYTES {
            oversize = true;
            continue;
        }
        body.extend_from_slice(&buf[..n]);
    }
    Ok((body, oversize))
}

fn handle(hub: Arc<Hub>, mut req: tiny_http::Request) -> Result<(), String> {
    let path = req.url().split('?').next().unwrap_or("/").to_string();
    let method = req.method().as_str().to_string();
    let hs = header_map(&req);
    let device = hub.device_snapshot();

    if device.passphrase.is_empty() {
        // 未设口令时不接收任何请求，避免局域网里任何人可写
        return answer(
            req,
            403,
            &serde_json::json!({ "ok": false, "error": "本机未设置配对口令" }),
        );
    }

    // 对端上报的显示名（base64，头值只能 ASCII）。不参与签名，只用来给
    // 陌生会话起个名字；老版本不发这个头，名字退回设备 ID 自定显示
    let dev_name = hs
        .get("x-device-name")
        .and_then(|v| store::hdr_decode(v))
        .unwrap_or_default();
    let ts: i64 = hs.get("x-ts").and_then(|s| s.parse().ok()).unwrap_or(0);
    let sig = hs.get("x-sig").cloned().unwrap_or_default();
    // 对方当前那个对话框（同一台可以有多个）。老版本这两个头都不发，都是空串
    let from = Sender {
        dev_id: hs.get("x-device").cloned().unwrap_or_default(),
        dev_name,
        sid: hs.get("x-session").cloned().unwrap_or_default(),
        sid_name: hs
            .get("x-session-name")
            .and_then(|v| store::hdr_decode(v))
            .unwrap_or_default(),
    };

    match (method.as_str(), path.as_str()) {
        ("GET", "/ping") => {
            let digest = store::sha256_hex(b"");
            if !store::verify_sig(&device.passphrase, &from.dev_id, ts, &digest, &sig) {
                return answer(
                    req,
                    403,
                    &serde_json::json!({ "ok": false, "error": "配对口令不匹配或时间戳超窗" }),
                );
            }
            let body = serde_json::json!({
                "ok": true,
                "device_id": device.id,
                "name": device.name,
                "app": APP_TAG,
                "version": env!("CARGO_PKG_VERSION"),
                "port": *hub.port.lock().expect("port 锁中毒"),
            });
            answer(req, 200, &body)
        }
        ("POST", "/msg") => {
            // 签名基于请求体，必须在读完后才算
            let (body, oversize) = read_bounded(&mut req)?;
            let digest = store::sha256_hex(&body);
            if !store::verify_sig(&device.passphrase, &from.dev_id, ts, &digest, &sig) {
                return answer(
                    req,
                    403,
                    &serde_json::json!({ "ok": false, "error": "签名校验失败" }),
                );
            }
            if oversize {
                return answer(
                    req,
                    413,
                    &serde_json::json!({ "ok": false, "error": "消息超过 1MB 上限" }),
                );
            }
            match handle_text(&hub, &body, &from) {
                Ok(msg) => {
                    let id = msg.id.clone();
                    hub.emit("msg-in", serde_json::json!({ "message": msg }));
                    // 响一声放在推事件之后：声音是给用户当下看的，不能排在落库前面拖住响应
                    hub.notify_arrived(&id);
                    answer(req, 200, &serde_json::json!({ "ok": true, "msg_id": id }))
                }
                Err(e) => answer(req, 400, &serde_json::json!({ "ok": false, "error": e })),
            }
        }
        ("PUT", "/file") => handle_file(hub, req, &device, &hs, &from, ts, &sig),
        // 对方要撤回它发过来的那一条。靠的仍是请求体签名 + X-Device，
        // 只有这条的发送者本人能撤（发起方设备 ID 在签名里，伪造过不了 verify_sig）
        ("POST", "/recall") => {
            let (body, oversize) = read_bounded(&mut req)?;
            let digest = store::sha256_hex(&body);
            if !store::verify_sig(&device.passphrase, &from.dev_id, ts, &digest, &sig) {
                return answer(
                    req,
                    403,
                    &serde_json::json!({ "ok": false, "error": "签名校验失败" }),
                );
            }
            if oversize {
                return answer(
                    req,
                    413,
                    &serde_json::json!({ "ok": false, "error": "撤回请求超过 1MB 上限" }),
                );
            }
            match handle_recall(&hub, &body, &from) {
                Ok(()) => answer(req, 200, &serde_json::json!({ "ok": true })),
                Err(e) => answer(req, 403, &serde_json::json!({ "ok": false, "error": e })),
            }
        }
        _ => answer(
            req,
            404,
            &serde_json::json!({ "ok": false, "error": format!("未知路由 {method} {path}") }),
        ),
    }
}

/// 一条请求带来的身份与会话信息。`dev_id` 在签名里（伪造过不了校验），
/// 其余几个都只是显示用的，故意不进签名：改设备名/会话名不该让旧请求失效
struct Sender {
    /// 发送方的设备 ID
    dev_id: String,
    /// 发送方的设备名
    dev_name: String,
    /// 对方当前那个对话框的会话 ID。空 = 上一版，落在这台的基础对话
    sid: String,
    /// 对方那个框的显示名，只在本机第一次见到这个会话 ID 时用来起名
    sid_name: String,
}

impl Sender {
    /// 这条消息该落进本机哪个对话框（不认识的框会顺手建出来）。
    /// 名字用会话名，没有就退回设备名（上一版只发 X-Device-Name）
    fn session(&self, hub: &Hub) -> String {
        let name = if self.sid_name.is_empty() { &self.dev_name } else { &self.sid_name };
        hub.session_for_incoming(&self.dev_id, &self.sid, name)
    }
}

/// 入向消息的 `peer` 取的是**签名里的发送方设备 ID**，不是本机绑定的那台：
/// 会话归属靠的就是这个字段（加上 `sid`），写错了历史无法回溯修正。
/// 伪造 X-Device 会过不了 verify_sig，所以这里可以直信。
fn handle_text(hub: &Arc<Hub>, body: &[u8], from: &Sender) -> Result<Message, String> {
    #[derive(serde::Deserialize)]
    struct InMsg {
        msg_id: String,
        ts: i64,
        text: String,
        /// 引用卡片：老对端不发这个字段，缺失就是 None；收到了就原样落库，
        /// 内容可信度与正文同级（都是对端自填的显示内容，本机只渲染不回显命令）
        #[serde(default)]
        quote: Option<store::Quote>,
    }
    let parsed: InMsg =
        serde_json::from_slice(body).map_err(|e| format!("消息体不是合法 JSON: {e}"))?;
    // 陌生设备的第一条消息、或对方新开的第一个话题，都是在这里把会话建好的
    let sid = from.session(hub);
    let msg = Message {
        id: parsed.msg_id,
        dir: "in".into(),
        kind: "text".into(),
        text: Some(parsed.text),
        name: None,
        size: None,
        path: None,
        state: "sent".into(),
        ts: parsed.ts,
        peer: from.dev_id.clone(),
        sid,
        quote: parsed.quote,
        ..Default::default()
    };
    hub.store
        .append_message(&msg)
        .map_err(|e| format!("落库失败: {e}"))?;
    Ok(msg)
}

/// 撤回落到本机这一份：只改「这一条怎么显示」，收件箱里那个文件一动不动
///（文件可能早就被人打开过，删它风险远大于收益）
fn handle_recall(hub: &Arc<Hub>, body: &[u8], from: &Sender) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct InRecall {
        msg_id: String,
    }
    let parsed: InRecall =
        serde_json::from_slice(body).map_err(|e| format!("撤回请求体不是合法 JSON: {e}"))?;
    // 找不到就当它已经不在了：本机删过那一条、或那条本来就不是发给本机的。
    // 撤回的目的就是让对方不再显示它，而这里已经不显示 —— 回失败反倒让发起方
    // 以为撤不掉（它的原文还挂着气泡）
    let Some(m) = hub.store.raw_message(&parsed.msg_id) else {
        eprintln!("[net] 撤回请求找不到消息 {}", parsed.msg_id);
        return Ok(());
    };
    if m.hidden {
        return Ok(()); // 本机已经把它删了，不必再追一行、更不该把它画回来
    }
    if m.dir != "in" {
        return Err("这条不是发给本机的，撤不了".into());
    }
    // 谁发的才能撤谁的那一条：拿签名里的设备 ID 比，不看请求体（body 里没有身份字段）
    if m.peer != from.dev_id {
        return Err("撤回请求的发起方不是这条的发送者".into());
    }
    if m.recalled {
        return Ok(()); // 幂等：重推不该把同一行历史越写越长
    }
    let done = hub.store.patch_flags(&parsed.msg_id, |x| x.recalled = true)?;
    hub.emit("msg-updated", serde_json::json!({ "message": done }));
    Ok(())
}

fn handle_file(
    hub: Arc<Hub>,
    mut req: tiny_http::Request,
    device: &store::Device,
    hs: &HashMap<String, String>,
    from: &Sender,
    ts: i64,
    sig: &str,
) -> Result<(), String> {
    let want_sha = hs.get("x-sha256").cloned().unwrap_or_default();
    let size: u64 = hs.get("x-size").and_then(|s| s.parse().ok()).unwrap_or(0);
    // X-Name / X-Rel-Path 是 base64（头值只能 ASCII），解不开就当作非法请求
    let rel = match hs.get("x-rel-path") {
        Some(raw) => store::hdr_decode(raw).unwrap_or_default(),
        None => String::new(),
    };
    let name = match hs.get("x-name") {
        Some(raw) => store::hdr_decode(raw).unwrap_or_default(),
        None => String::new(),
    };
    let batch = hs.get("x-batch").cloned().unwrap_or_default();
    let is_last = hs.get("x-last").map(|v| v == "1").unwrap_or(false);
    // 发送端知道整批（文件夹）的总字节数，带过来才能给出跨文件的累计进度
    let declared_total: u64 = hs
        .get("x-batch-size")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // 签名基于文件摘要，无需先读体即可拒绝
    let reject: Option<(u16, String)> = if rel.is_empty() {
        Some((400, "缺少或非法的 X-Rel-Path".to_string()))
    } else if size == 0 || size > MAX_FILE_BYTES {
        Some((400, format!("非法文件大小: {size}")))
    } else if !store::verify_sig(&device.passphrase, &from.dev_id, ts, &want_sha, sig) {
        Some((403, "签名校验失败".to_string()))
    } else {
        let root = hub.store.inbox_dir().join(sanitize_component(&batch));
        match safe_rel_join(&root, &rel) {
            Ok(_) => None,
            Err(e) => Some((400, e)),
        }
    };
    if let Some((code, msg)) = reject {
        drain(req.as_reader(), size.min(MAX_FILE_BYTES));
        return answer(req, code, &serde_json::json!({ "ok": false, "error": msg }));
    }

    let batch = if batch.is_empty() {
        uuid::Uuid::new_v4().simple().to_string()
    } else {
        batch
    };
    let root = hub.store.inbox_dir().join(sanitize_component(&batch));
    let dest = safe_rel_join(&root, &rel)?;
    // 进度事件要在文件收完之前就知道归属，可那时还不该为一个没收完的传输
    // 建会话 —— 所以先算落点（不建），收完那个真正落库的消息时再建
    let route_sid = hub.route_session(&from.dev_id, &from.sid);

    // 这批此前已收到的字节数 = 进度基准；整批总大小未知时退回单文件口径
    let acc = hub.batch_touch(&batch, declared_total);
    let batch_total = if acc.total > 0 { acc.total } else { size };
    let result = write_stream(
        req.as_reader(),
        &dest,
        size,
        &want_sha,
        &hub,
        &batch,
        &rel,
        &from.dev_id,
        &route_sid,
        acc.written,
        batch_total,
    );
    // 上面借用的 &mut req 到此结束，之后 respond 可以消耗 req
    match result {
        Ok(()) => {
            hub.batch_add_file(&batch, size);
            if is_last {
                let fin = hub.batch_finish(&batch);
                // 收件箱按微信的习惯摆放：一张图就是 inbox/<图名>，一个文件夹就是
                // inbox/<文件夹名>/…；UUID 批次目录只是传输途中的工位，收完摊平后删掉。
                // 摊平的落脚点可能是 inbox 根，也可能是它下面按天/按月分的日期子目录
                let mut target = hub.store.inbox_delivery_dir();
                if let Err(e) = fs::create_dir_all(&target) {
                    // 日期目录建不出来（盘满/权限）就退回根目录：宁可今天这几样混在
                    // 根上，也不要因为缺一层子目录让整批退回去看 uuid 目录名
                    eprintln!(
                        "[net] 建收件日期目录 {} 失败，退回根目录: {e}",
                        target.display()
                    );
                    target = hub.store.inbox_dir();
                }
                let landing = flatten_batch(&target, &root, &name);
                let landing_name = landing
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| name.clone());
                let sid = from.session(&hub);
                let msg = build_inbox_message(
                    &landing,
                    &landing_name,
                    &rel,
                    &fin,
                    &batch,
                    &from.dev_id,
                    &sid,
                );
                let _ = hub.store.append_message(&msg);
                // 下面把 msg 整体搬进了事件载荷，id 得先存一份
                let fid = msg.id.clone();
                hub.emit("xfer-done", serde_json::json!({ "message": msg }));
                // 一个文件夹只在这里响一声：整批收完才落这一条消息，
                // 不需要为「几十个文件别叫几十声」再加时间节流
                hub.notify_arrived(&fid);
            }
            answer(
                req,
                200,
                &serde_json::json!({ "ok": true, "msg_id": batch }),
            )
        }
        Err(e) => {
            let _ = fs::remove_file(&dest);
            let code = if matches!(e.kind, ErrKind::Hash) { 422 } else { 500 };
            answer(
                req,
                code,
                &serde_json::json!({ "ok": false, "error": e.msg }),
            )
        }
    }
}

#[derive(PartialEq)]
enum ErrKind {
    Hash,
    Other,
}

struct StreamErr {
    kind: ErrKind,
    msg: String,
}

fn write_stream(
    reader: &mut dyn Read,
    dest: &Path,
    size: u64,
    want_sha: &str,
    hub: &Hub,
    batch: &str,
    rel: &str,
    // 发送方设备 ID：进度气泡可能比 xfer-done 先到，没这个字段就不知道该铺进哪个会话
    dev_id: &str,
    // 这条传输落进的对话框（同一台的几个框各有归属）。只算出来的，可能还没建
    sid: &str,
    base: u64,
    batch_total: u64,
) -> Result<(), StreamErr> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| StreamErr {
            kind: ErrKind::Other,
            msg: format!("创建目录 {} 失败: {e}", parent.display()),
        })?;
    }
    let file = fs::File::create(dest).map_err(|e| StreamErr {
        kind: ErrKind::Other,
        msg: format!("创建文件 {} 失败: {e}", dest.display()),
    })?;
    let mut writer = HashWriter::new(std::io::BufWriter::new(file));
    let mut buf = vec![0u8; 64 * 1024];
    let mut last_emit = 0i64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| StreamErr {
            kind: ErrKind::Other,
            msg: format!("接收数据失败: {e}"),
        })?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(|e| StreamErr {
            kind: ErrKind::Other,
            msg: format!("写盘失败: {e}"),
        })?;
        let sent = writer.written();
        // 进度事件限流：最多每 200ms 一条，避免高频刷 UI
        if sent >= size || store::now_ms() - last_emit > 200 {
            last_emit = store::now_ms();
            hub.emit(
                "xfer-progress",
                serde_json::json!({
                    // msg_id 就是批次 id，一个文件夹的所有文件共用一个气泡，
                    // 所以报「基准 + 当前文件已写」而不是单文件百分比
                    "msg_id": batch,
                    "dir": "in",
                    "peer": dev_id,
                    "sid": sid,
                    "sent": base + sent,
                    "total": batch_total,
                    "name": rel
                }),
            );
        }
    }
    // BufWriter 里可能还有最后几 KB 没落盘，finish 前必须 flush
    writer.flush().map_err(|e| StreamErr {
        kind: ErrKind::Other,
        msg: format!("落盘失败: {e}"),
    })?;
    let (hex, written) = writer.finish();
    if written != size {
        return Err(StreamErr {
            kind: ErrKind::Other,
            msg: format!("字节数不符：声明 {size}，实收 {written}"),
        });
    }
    if !hex.eq_ignore_ascii_case(want_sha) {
        return Err(StreamErr {
            kind: ErrKind::Hash,
            msg: format!("sha256 校验失败：期望 {want_sha}，实得 {hex}"),
        });
    }
    Ok(())
}

/// 收完一批后的那条消息。路径就是摊平后的落点，是不是文件夹直接看它本身，
/// 不再靠 rel 里有没有斜杠猜（旧写法会让单文件报出最后一个文件的大小、也可能把单图判成文件夹）
fn build_inbox_message(
    landing: &Path,
    landing_name: &str,
    rel: &str,
    acc: &super::BatchAcc,
    batch: &str,
    dev_id: &str,
    sid: &str,
) -> Message {
    let is_folder = landing.is_dir() || acc.files > 1;
    let size = if acc.total > 0 {
        acc.total
    } else {
        acc.written
    };
    Message {
        id: batch.to_string(),
        dir: "in".into(),
        kind: if is_folder { "folder".into() } else { "file".into() },
        text: None,
        name: Some(if landing_name.is_empty() {
            rel.to_string()
        } else {
            landing_name.to_string()
        }),
        size: Some(size),
        path: Some(landing.to_string_lossy().to_string()),
        state: "sent".into(),
        ts: store::now_ms(),
        peer: dev_id.to_string(),
        sid: sid.to_string(),
        ..Default::default()
    }
}

/// 把批次工位目录里的唯一顶层条目移到收件落脚点（inbox 根，或它下面按日期分的
/// 子目录）。挪不动（权限/异常名字）就退回工位目录，总之不能丢文件；
/// 多于一个顶层条目（理论上不会发生）也留在工位目录里。
fn flatten_batch(inbox: &Path, root: &Path, declared_name: &str) -> PathBuf {
    let entries = match fs::read_dir(root) {
        Ok(e) => e.filter_map(|x| x.ok()).collect::<Vec<_>>(),
        Err(_) => return root.to_path_buf(),
    };
    if entries.len() != 1 {
        return root.to_path_buf();
    }
    let only = entries[0].path();
    let wanted = if declared_name.is_empty() {
        only
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        declared_name.to_string()
    };
    let dest = unique_dest(inbox, &sanitize_component(&wanted));
    match fs::rename(&only, &dest) {
        Ok(_) => {
            // 工位目录此时应当空了；删不掉就留着，不影响已落好的文件
            let _ = fs::remove_dir(root);
            dest
        }
        Err(e) => {
            eprintln!("[net] 摊平收件箱失败（{} -> {}）: {e}", only.display(), dest.display());
            root.to_path_buf()
        }
    }
}

/// 重名时按微信的习惯加 “ (1)” “ (2)” …，而不是默默覆盖已收的文件
/// （粘贴落盘也复用这条规则，见 clip.rs）
pub(crate) fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..1000u32 {
        let cand = dir.join(format!("{stem} ({i}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!("{stem} ({}){ext}", store::now_ms()))
}

/// 单个路径段的字符上限。微信转发出来的图片名常有 150 字符，直接砍到上限会把
/// `.jpg` 整个削掉 —— 那样收件箱里的图既出不了缩略图，也没法按扩展名判类型
const MAX_COMPONENT_CHARS: usize = 120;

/// 批量目录名/文件名单独取用时也要防穿越
pub(crate) fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').trim();
    if trimmed.is_empty() {
        return "_".to_string();
    }
    clamp_keep_ext(trimmed, MAX_COMPONENT_CHARS)
}

/// 超长时截断，但把扩展名留在尾部：宁可名字短一截，也不能让 `.jpg` 消失
fn clamp_keep_ext(name: &str, limit: usize) -> String {
    let chars: Vec<char> = name.chars().collect();
    if chars.len() <= limit {
        return name.to_string();
    }
    let ext: String = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    // 扩展名长到快占满上限时只能整体硬截，拼出一个怪名字不如短一点
    if ext.chars().count() >= limit / 2 {
        return chars.iter().take(limit).collect();
    }
    let mut head: String = chars.iter().take(limit - ext.chars().count()).collect();
    // 截断处留下的点/空格是看不见的尾巴，去掉再拼扩展名更干净
    while head.ends_with('.') || head.ends_with(' ') {
        head.pop();
    }
    head.push_str(&ext);
    head
}

/// 拒绝请求时把 body 读空，避免对端在写大 body 时被连接重置、报错信息难读。
/// 注意参数是 `&mut dyn Read`：tiny_http 的 as_reader 返回的就是 trait object。
fn drain(reader: &mut dyn Read, up_to: u64) {
    let mut buf = [0u8; 16 * 1024];
    let mut left = up_to;
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        match reader.read(&mut buf[..want]) {
            Ok(0) | Err(_) => break,
            Ok(n) => left -= n as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立临时目录，避免并行测试互相踩
    fn tmp_inbox(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("imgcmp-inbox-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).expect("建临时收件箱目录");
        d
    }

    #[test]
    fn 单文件批次收完摊平到收件箱根() {
        let inbox = tmp_inbox("one");
        let station = inbox.join("batch0001");
        fs::create_dir_all(&station).unwrap();
        fs::write(station.join("图 1.jpg"), b"payload").unwrap();

        let landed = flatten_batch(&inbox, &station, "图 1.jpg");
        assert_eq!(landed, inbox.join("图 1.jpg"));
        assert_eq!(fs::read(&landed).unwrap(), b"payload");
        assert!(!station.exists(), "工位目录收完就该没了");
        fs::remove_dir_all(&inbox).ok();
    }

    #[test]
    fn 文件夹批次整棵子树搬到收件箱根() {
        let inbox = tmp_inbox("dir");
        let station = inbox.join("batch0002");
        let inner = station.join("自检目录").join("内层");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("中文 名.txt"), b"a").unwrap();
        fs::write(station.join("自检目录").join("根文件.txt"), b"b").unwrap();

        let landed = flatten_batch(&inbox, &station, "自检目录");
        assert!(landed.is_dir());
        assert!(landed.join("内层").join("中文 名.txt").is_file());
        assert!(landed.join("根文件.txt").is_file());
        assert!(!station.exists());
        fs::remove_dir_all(&inbox).ok();
    }

    #[test]
    fn 重名不覆盖而是加序号() {
        let inbox = tmp_inbox("dup");
        fs::write(inbox.join("a.png"), b"old").unwrap();
        let second = unique_dest(&inbox, "a.png");
        assert_eq!(second, inbox.join("a (1).png"));
        fs::write(&second, b"new").unwrap();
        assert_eq!(fs::read(inbox.join("a.png")).unwrap(), b"old", "原件不能被覆盖");

        fs::create_dir_all(inbox.join("my dir")).unwrap();
        assert_eq!(unique_dest(&inbox, "my dir"), inbox.join("my dir (1)"));
        fs::remove_dir_all(&inbox).ok();
    }

    #[test]
    fn 超长名字截断后仍然保住扩展名() {
        // 真实形态：微信网页版转存的图片名 150 字符，旧写法砍到 120 就没扩展名了
        let long = format!("{}_wx_webfilehelper.jpg", "_cgi-bin_mmwebwx-bin_webwxgetmsgimg_".repeat(4));
        let clipped = sanitize_component(&long);
        assert!(clipped.chars().count() <= MAX_COMPONENT_CHARS, "超长没截断");
        assert!(clipped.ends_with(".jpg"), "扩展名被削掉了: {clipped}");
        // 普通名字不受影响
        assert_eq!(sanitize_component("图 1.jpg"), "图 1.jpg");
        assert_eq!(sanitize_component("没有扩展名的文件"), "没有扩展名的文件");
        // 摊平后落在收件箱里的那个名字确实带扩展名，前端才认得出是图
        let inbox = tmp_inbox("longname");
        let station = inbox.join("batch0004");
        fs::create_dir_all(&station).unwrap();
        fs::write(station.join(&long), b"jpegbytes").unwrap();
        let landed = flatten_batch(&inbox, &station, &long);
        assert!(landed.is_file());
        assert_eq!(landed.extension().and_then(|e| e.to_str()), Some("jpg"));
        assert!(
            landed
                .file_name()
                .unwrap()
                .to_string_lossy()
                .chars()
                .count()
                <= MAX_COMPONENT_CHARS,
            "摊平后的名字还是超长: {}",
            landed.display()
        );
        fs::remove_dir_all(&inbox).ok();
    }

    #[test]
    fn 摊平不成立时退回工位目录不丢文件() {
        let inbox = tmp_inbox("multi");
        let station = inbox.join("batch0003");
        fs::create_dir_all(&station).unwrap();
        fs::write(station.join("x.txt"), b"1").unwrap();
        fs::write(station.join("y.txt"), b"2").unwrap();

        // 两个顶层条目（正常不会发生）→ 原地留着，不能丢任何一个
        let landed = flatten_batch(&inbox, &station, "");
        assert_eq!(landed, station);
        assert!(landed.join("x.txt").is_file() && landed.join("y.txt").is_file());
        fs::remove_dir_all(&inbox).ok();
    }
}
