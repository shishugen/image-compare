//! 局域网接收端：一个极简 HTTP/1.1 服务，只提供 /ping、/msg、/file 三条路由。
//!
//! 所有请求都要带签名头，口令不匹配一律 403；文件流式落盘并边写边算 sha256，
//! 校验不过就删掉临时文件回 422，绝不留下半成品。

use super::Hub;
use crate::store::{self, safe_rel_join, HashWriter, Message, MAX_BODY_BYTES, MAX_FILE_BYTES};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
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

    let dev_id = hs.get("x-device").cloned().unwrap_or_default();
    let ts: i64 = hs.get("x-ts").and_then(|s| s.parse().ok()).unwrap_or(0);
    let sig = hs.get("x-sig").cloned().unwrap_or_default();

    match (method.as_str(), path.as_str()) {
        ("GET", "/ping") => {
            let digest = store::sha256_hex(b"");
            if !store::verify_sig(&device.passphrase, &dev_id, ts, &digest, &sig) {
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
            // as_reader 返回 &mut dyn Read（没有 by_ref/take），所以手动限量读；
            // 这个块只负责把 body 收完，借用结束后才能把 req 交给 answer
            let mut body: Vec<u8> = Vec::new();
            let mut oversize = false;
            {
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
            }
            // 签名基于请求体，必须在读完后才算
            let digest = store::sha256_hex(&body);
            if !store::verify_sig(&device.passphrase, &dev_id, ts, &digest, &sig) {
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
            match handle_text(&hub, &body) {
                Ok(msg) => {
                    let id = msg.id.clone();
                    hub.emit("msg-in", serde_json::json!({ "message": msg }));
                    answer(req, 200, &serde_json::json!({ "ok": true, "msg_id": id }))
                }
                Err(e) => answer(req, 400, &serde_json::json!({ "ok": false, "error": e })),
            }
        }
        ("PUT", "/file") => handle_file(hub, req, &device, &hs, &dev_id, ts, &sig),
        _ => answer(
            req,
            404,
            &serde_json::json!({ "ok": false, "error": format!("未知路由 {method} {path}") }),
        ),
    }
}

fn handle_text(hub: &Arc<Hub>, body: &[u8]) -> Result<Message, String> {
    #[derive(serde::Deserialize)]
    struct InMsg {
        msg_id: String,
        ts: i64,
        text: String,
    }
    let parsed: InMsg =
        serde_json::from_slice(body).map_err(|e| format!("消息体不是合法 JSON: {e}"))?;
    let peer = hub
        .peer_snapshot()
        .map(|p| p.id)
        .unwrap_or_default();
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
        peer,
    };
    hub.store
        .append_message(&msg)
        .map_err(|e| format!("落库失败: {e}"))?;
    Ok(msg)
}

fn handle_file(
    hub: Arc<Hub>,
    mut req: tiny_http::Request,
    device: &store::Device,
    hs: &HashMap<String, String>,
    dev_id: &str,
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

    // 签名基于文件摘要，无需先读体即可拒绝
    let reject: Option<(u16, String)> = if rel.is_empty() {
        Some((400, "缺少或非法的 X-Rel-Path".to_string()))
    } else if size == 0 || size > MAX_FILE_BYTES {
        Some((400, format!("非法文件大小: {size}")))
    } else if !store::verify_sig(&device.passphrase, dev_id, ts, &want_sha, sig) {
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

    let result = write_stream(req.as_reader(), &dest, size, &want_sha, &hub, &batch, &rel);
    // 上面借用的 &mut req 到此结束，之后 respond 可以消耗 req
    match result {
        Ok(()) => {
            if is_last {
                let msg = build_inbox_message(&root, &rel, &name, size, &batch, &hub);
                let _ = hub.store.append_message(&msg);
                hub.emit("xfer-done", serde_json::json!({ "message": msg }));
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
                    "msg_id": batch, "dir": "in", "sent": sent, "total": size, "name": rel
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

/// 收完一批后的那条消息：rel 带子路径说明这是文件夹的最后一件
fn build_inbox_message(
    root: &Path,
    rel: &str,
    name: &str,
    size: u64,
    batch: &str,
    hub: &Hub,
) -> Message {
    let is_folder = rel.contains('/');
    let path = if is_folder {
        root.to_path_buf()
    } else {
        root.join(sanitize_component(if name.is_empty() { rel } else { name }))
    };
    let peer = hub
        .peer_snapshot()
        .map(|p| p.id)
        .unwrap_or_default();
    Message {
        id: batch.to_string(),
        dir: "in".into(),
        kind: if is_folder { "folder".into() } else { "file".into() },
        text: None,
        name: Some(if name.is_empty() {
            rel.to_string()
        } else {
            name.to_string()
        }),
        size: Some(size),
        path: Some(path.to_string_lossy().to_string()),
        state: "sent".into(),
        ts: store::now_ms(),
        peer,
    }
}

/// 批量目录名/文件名单独取用时也要防穿越
fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').trim();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
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
