//! 局域网发送端与在线心跳。
//!
//! /ping 返回 200 即代表对端与本机口令一致（口令不同会被对端拒成 403），
//! 因此发现线程看到一个能通过 /ping 的设备就直接登记为可发对端，无需手动配对。
//! 登记不等于选中：当前聊哪个对话框（active）由用户点，不能在三台里随机挑。

use super::Hub;
use crate::http;
use crate::store::{self, Message, Peer, Session, Store};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

const HEARTBEAT_MS: u64 = 1000;
const OFFLINE_THRESHOLD: u32 = 3;

#[derive(serde::Deserialize)]
struct PingResp {
    ok: bool,
    device_id: String,
    name: String,
    #[serde(default)]
    app: String,
}

pub fn signed_headers(hub: &Hub, digest: &str) -> Vec<(String, String)> {
    let d = hub.device_snapshot();
    let ts = store::now_ms();
    vec![
        ("X-Device".into(), d.id.clone()),
        // 设备名跟着报上去，对端第一次看到本机时才能把会话名字写实。
        // 中文必须 base64（同 X-Name），且故意不进签名：改名不该让旧请求失效
        ("X-Device-Name".into(), store::hdr_encode(&d.name)),
        ("X-Ts".into(), ts.to_string()),
        ("X-Sig".into(), store::sign(&d.passphrase, &d.id, ts, digest)),
    ]
}

/// 会话信息跟着每条消息带上：对端要靠 `X-Session` 把消息落进同一个对话框
/// （同一台可以有多个）。会话 ID 是 UUID 或设备 ID，都是纯 ASCII，不用 base64；
/// 名字只在对方第一次见到这个会话时用来起名，之后两边各改各的。
/// 与 X-Device-Name 同样故意不进签名：重命名不该让旧请求失效
fn session_headers(sess: &Session) -> Vec<(String, String)> {
    vec![
        ("X-Session".into(), sess.id.clone()),
        ("X-Session-Name".into(), store::hdr_encode(&sess.name)),
    ]
}

/// 探测一台设备。Ok(Peer) 表示口令一致且在线。
pub fn ping(hub: &Hub, host: &str, port: u16) -> Result<Peer, String> {
    let d = hub.device_snapshot();
    if d.passphrase.is_empty() {
        return Err("本机还没设置配对口令，无法与对端互认".into());
    }
    let headers = signed_headers(hub, &store::sha256_hex(b""));
    let resp = http::request_small(host, port, "GET", "/ping", &headers, b"", Duration::from_secs(3))?;
    if resp.status == 403 {
        return Err("对端拒绝：配对口令与本机不一致".into());
    }
    if !resp.ok() {
        return Err(format!("对端返回异常状态 {}", resp.status));
    }
    let parsed: PingResp =
        serde_json::from_slice(&resp.body).map_err(|e| format!("对端 /ping 响应无法解析: {e}"))?;
    if !parsed.ok {
        return Err("对端 /ping 明确返回失败".into());
    }
    if parsed.app != super::server::APP_TAG {
        return Err(format!("对端不是本应用（app={}）", parsed.app));
    }
    if parsed.device_id == d.id {
        return Err("探测到的是本机自己，已忽略".into());
    }
    Ok(Peer {
        id: parsed.device_id,
        name: parsed.name,
        // 刚 ping 回来的设备当然还没有备注：那是本机用户打的字，不在这份响应里
        alias: String::new(),
        host: host.to_string(),
        port,
        online: true,
        last_seen: store::now_ms(),
    })
}

/// 口令不一致／不是本应用／是自己，这类结果不会因为重试而改变
fn is_hard_mismatch(err: &str) -> bool {
    err.contains("口令") || err.contains("不是本应用") || err.contains("本机自己")
}

/// 心跳线程：维持每一台已登记对端的在线状态，并把扫到的新设备登记进来。
pub fn spawn_heartbeat(hub: Arc<Hub>) {
    std::thread::spawn(move || {
        // 已登记对端的连续失败次数（逐台算，不能共用一个计数器）
        let mut fails: HashMap<String, u32> = HashMap::new();
        // 候选设备的连续失败次数：超时不能当成“不是我的对端”，否则网络抖一下就丢设备
        let mut miss: HashMap<String, u32> = HashMap::new();
        loop {
            if hub.stop.load(Ordering::Relaxed) {
                break;
            }
            if hub.device_snapshot().passphrase.is_empty() {
                // 本机还没口令，任何 ping 都只会拿到「无法互认」，不该因此踢掉发现的设备
                std::thread::sleep(Duration::from_millis(HEARTBEAT_MS));
                continue;
            }
            let peers = hub.peers_snapshot();
            // 该自动登记哪些候选全在 auto_bind_targets 里判：登记过的不必再探，
            // 而被用户解绑过的那台即使还 ping 得通也不能擅自绑回来
            let bound: Vec<String> = peers.iter().map(|p| p.id.clone()).collect();
            let candidates = super::auto_bind_targets(
                &hub.discovered_snapshot(),
                &bound,
                &hub.ignored_snapshot(),
            );
            // 并发 ping：串行会被 3 秒超时拖垮节拍（八台全离线就是 24 秒一轮，
            // 在线标记会慢得看不出实际状态）。先把线程全部开出去再依次取结果，
            // 在循环里直接 join 等于又退回串行去了
            let probed: Vec<(String, Result<Peer, String>)> = std::thread::scope(|s| {
                let mut handles = Vec::new();
                for target in peers
                    .iter()
                    .map(|p| (p.id.clone(), p.host.clone(), p.port))
                    .chain(candidates.iter().map(|c| (c.id.clone(), c.host.clone(), c.port)))
                {
                    let hub = hub.clone();
                    handles.push(s.spawn(move || (target.0.clone(), ping(&hub, &target.1, target.2))));
                }
                handles
                    .into_iter()
                    // 某个 ping 线程 panic 就少这一台的一拍，不值得让整个心跳线程跟着退出
                    .filter_map(|h| h.join().ok())
                    .collect()
            });
            for (id, result) in probed {
                if bound.contains(&id) {
                    let online = hub.peer_by_id(&id).map(|p| p.online).unwrap_or(false);
                    match result {
                        Ok(fresh) => {
                            fails.remove(&id);
                            if online {
                                hub.touch_peer(&id, fresh.last_seen, &fresh.host, fresh.port);
                            } else {
                                hub.set_peer_online(&id, true);
                            }
                        }
                        Err(e) => {
                            let n = fails.entry(id.clone()).or_insert(0);
                            *n += 1;
                            let hits = *n;
                            if hits >= OFFLINE_THRESHOLD && online {
                                hub.set_peer_online(&id, false);
                                eprintln!("[net] 对端 {id} 连续 {hits} 次探测失败，判为离线: {e}");
                            }
                        }
                    }
                } else {
                    match result {
                        // ping 通就登记为已知可发对端，但不设当前会话（谁被选中是用户的事）
                        Ok(peer) => {
                            hub.bind_peer(peer.clone());
                            eprintln!("[net] 已登记对端 {} ({}:{})", peer.name, peer.host, peer.port);
                        }
                        Err(e) => {
                            let hard = is_hard_mismatch(&e);
                            let n = miss.entry(id.clone()).or_insert(0);
                            *n += 1;
                            // 只在第一次与确定不匹配时记日志，否则每秒一条会刷满控制台
                            if hard || *n == 1 {
                                eprintln!("[net] 探测 {e}");
                            }
                            if hard || *n >= OFFLINE_THRESHOLD {
                                miss.remove(&id);
                                hub.remove_discovered(&id);
                            }
                        }
                    }
                }
            }
            // 已经不在线也没被再探测的设备（刚解绑），计数器不能留着
            fails.retain(|k, _| bound.contains(k));
            // 待发队列只挂在这一拍上：在线状态就是在这里改的，补发紧接着跑。
            // 不靠「离线转在线」的边沿 —— 重启后头一拍、解绑后头一次探测都会假触发
            hub.spawn_due_flush();
            std::thread::sleep(Duration::from_millis(HEARTBEAT_MS));
        }
    });
}

/// 发一条文字到 `sess` 那个对话框（目标地址取自会话所属的那台）
pub fn send_text(hub: &Arc<Hub>, peer: &Peer, sess: &Session, text: String) -> Result<Message, String> {
    let msg = Message {
        id: uuid::Uuid::new_v4().simple().to_string(),
        dir: "out".into(),
        kind: "text".into(),
        text: Some(text.clone()),
        state: "sending".into(),
        ts: store::now_ms(),
        peer: peer.id.clone(),
        sid: sess.id.clone(),
        ..Default::default()
    };
    hub.store.append_message(&msg)?;
    hub.emit("msg-updated", serde_json::json!({ "message": msg }));
    // 当场发不出去就是「失败」：这条没进过队列，retry 保持 0、也不留原因文案，
    // 与补发那条路（超上限才失败）共用 retry() 但含义分得清
    try_send_text(hub, peer, sess, &msg).map_err(|e| finalize_failed(hub, &msg, e, false, false))
}

/// 把一条文字投给 `peer`（不建气泡，状态收尾由调用方决定）。
/// 在线直发与离线补发共用这一段，两条路的协议与签名口径只有一份
pub(crate) fn try_send_text(
    hub: &Arc<Hub>,
    peer: &Peer,
    sess: &Session,
    msg: &Message,
) -> Result<Message, String> {
    let text = msg.text.clone().unwrap_or_default();
    // ts 用当初那一刻：补发的消息在对端显示的仍是用户写它的时间
    let body = serde_json::json!({ "msg_id": msg.id, "ts": msg.ts, "text": text })
        .to_string()
        .into_bytes();
    let headers = {
        let mut h = signed_headers(hub, &store::sha256_hex(&body));
        h.extend(session_headers(sess));
        h.push(("Content-Type".into(), "application/json".into()));
        h
    };
    let resp = http::request_small(
        &peer.host,
        peer.port,
        "POST",
        "/msg",
        &headers,
        &body,
        Duration::from_secs(10),
    );
    match resp {
        Ok(r) if r.ok() => Ok(mark_sent(hub, msg)),
        Ok(r) => Err(format!("对端返回 {}", r.status)),
        Err(e) => Err(e),
    }
}

/// 投成功：同 ID 再追一行 sent。计数与原因一并清掉，否则下次断线时
/// 「第 4 次失败」会接在一个已经成功的消息后面往下算
fn mark_sent(hub: &Arc<Hub>, msg: &Message) -> Message {
    let done = Message {
        state: "sent".into(),
        retry: 0,
        reason: None,
        ..msg.clone()
    };
    if let Err(e) = hub.store.append_message(&done) {
        eprintln!("[net] 落库送达状态失败: {e}");
    }
    hub.emit("msg-updated", serde_json::json!({ "message": done }));
    done
}

/// 投之前先把气泡标成「传输中」：一条排队几小时的消息不能还在显示「待发」
fn mark_sending(hub: &Arc<Hub>, msg: &Message) {
    let t = Message {
        state: "sending".into(),
        ..msg.clone()
    };
    let _ = hub.store.append_message(&t);
    hub.emit("msg-updated", serde_json::json!({ "message": t }));
}

/// 失败也要留下记录：messages.jsonl 是追加式，同 ID 以最后一条为准。
/// `allow_retry` 才走计数（只有进过队列的消息才有「第几次」这回事），
/// `hard` 是一次都不该再试的错（比如文件已经不在了）
fn finalize_failed(hub: &Arc<Hub>, msg: &Message, err: String, allow_retry: bool, hard: bool) -> String {
    if allow_retry {
        super::retry_with(hub, msg, &err, hard);
    } else {
        let failed = Message {
            state: "failed".into(),
            reason: Some(err.clone()),
            ..msg.clone()
        };
        let _ = hub.store.append_message(&failed);
        hub.emit("msg-updated", serde_json::json!({ "message": failed }));
    }
    err
}

/// 一个要发出去的路径该长成什么气泡：kind 按当下是文件还是目录定，
/// 大小现算。在线直发与离线入队共用它，两条路的气泡口径必须一致
///（排队那条要是各写一份，将来改字段一定会漏改一处）
pub(crate) fn outbound_bubble(
    _device: &store::Device,
    peer: &Peer,
    sess: &Session,
    path: &Path,
    state: &str,
) -> Result<Message, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("读不到 {} : {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("跳过符号链接: {}", path.display()));
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| format!("{} 没有文件名", path.display()))?;
    let is_dir = meta.is_dir();
    Ok(Message {
        // 待发阶段先占一个 ID：补发时把它当 batch id 用，两边的气泡才对得上
        id: uuid::Uuid::new_v4().simple().to_string(),
        dir: "out".into(),
        kind: if is_dir { "folder".into() } else { "file".into() },
        name: Some(name),
        // 目录没有「一个大小」可显示，留空比写个当下算出来的总和诚实
        //（补发时 send_one 会按那一刻的真实总量覆盖）
        size: if is_dir { None } else { Some(meta.len()) },
        path: Some(path.to_string_lossy().to_string()),
        state: state.into(),
        ts: store::now_ms(),
        peer: peer.id.clone(),
        sid: sess.id.clone(),
        ..Default::default()
    })
}

/// 补发一个对话框里挂着的那几条。只在这一个线程里跑（会话级许可已拿到），
/// 所以同一框的顺序天然是「旧的先走」
pub(crate) fn flush_session(hub: &Arc<Hub>, sess: &Session, ids: &[String]) {
    let pending = hub.store.pending_messages();
    for id in ids {
        let Some(msg) = pending.iter().find(|m| m.id == *id) else {
            continue; // 已经被投出去或被别的写覆盖了一行，跳过就是对的
        };
        let Some(peer) = hub.peer_by_id(&msg.peer) else {
            // 解绑了：不投也不计数 —— 那台被亲手加回来时这几条还得接着投
            continue;
        };
        if !peer.online {
            continue;
        }
        let r = match msg.kind.as_str() {
            // 文字这里必须自己补上失败收尾：try_send_text 只报错不计数，
            // 少了这一步那条发不出去的文字会永远挂着「待发」、每一拍都重投一次
            //（计数与上限全白设）。文件那条在 try_send_file 里已经做过了（它还要分硬错误）
            "text" => try_send_text(hub, &peer, sess, msg)
                .map_err(|e| finalize_failed(hub, msg, e, true, false)),
            _ => try_send_file(hub, &peer, sess, msg),
        };
        if let Err(e) = r {
            eprintln!("[net] 补发 {id} 失败: {e}");
        }
    }
}

/// 一条待发消息归属的会话已经不在了（用户删了那个框）：直接标失败落库，
/// 不能让它永远挂着「待发」
pub(crate) fn abandon_session_msgs(store: &Store, sid: &str, ids: &[String]) {
    let why = "这个对话框已经被删了";
    for m in store.pending_messages().iter().filter(|m| m.sid_of() == sid) {
        if !ids.contains(&m.id) {
            continue;
        }
        let _ = super::retry(store, m, why, true);
    }
}

/// 补发一条排队的文件/文件夹。send_one 会自己再算一遍总量并展开目录
///（排队期间可能又塞了东西进去），完成后把气泡改成同 ID 的 sent
fn try_send_file(hub: &Arc<Hub>, peer: &Peer, sess: &Session, msg: &Message) -> Result<Message, String> {
    let Some(p) = msg.path.as_deref() else {
        return Err(finalize_failed(hub, msg, "这条记录没有本机路径，发不出去".into(), true, true));
    };
    let path = Path::new(p);
    if fs::symlink_metadata(path).is_err() {
        // 路径没了不是网络问题，重试三次只会白跑三趟
        return Err(finalize_failed(
            hub,
            msg,
            format!("要发的 {} 已经不在这个位置了", path.display()),
            true,
            true,
        ));
    }
    mark_sending(hub, msg);
    // 排了几个小时队的气泡不能跳到当下：ts 以入队那一刻为准
    let sent_ts = msg.ts;
    match send_one(hub, peer, sess, path, Some(msg)) {
        Ok(done) => {
            let done = Message {
                ts: sent_ts,
                ..done
            };
            Ok(mark_sent(hub, &done))
        }
        Err(e) => Err(finalize_failed(hub, msg, e, true, false)),
    }
}

/// 发送一批路径（文件或文件夹）到同一个对话框。文件夹会递归成多个 PUT，共用一个气泡与 batch id。
pub fn send_paths(hub: &Arc<Hub>, peer: &Peer, sess: &Session, paths: Vec<String>) -> Result<Vec<Message>, String> {
    let mut out = Vec::new();
    for p in paths {
        out.push(send_one(hub, peer, sess, Path::new(&p), None)?);
    }
    Ok(out)
}

/// `queued` 是从待发队列里拉出来的那一条：复用它的气泡（同一个 id、同一行历史），
/// 不再新建 —— 否则补发一个文件夹会在对方界面上多出一条重复气泡
fn send_one(
    hub: &Arc<Hub>,
    peer: &Peer,
    sess: &Session,
    path: &Path,
    queued: Option<&Message>,
) -> Result<Message, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("读不到 {} : {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("跳过符号链接: {}", path.display()));
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| format!("{} 没有文件名", path.display()))?;
    let is_dir = meta.is_dir();
    // 进待发队列的那一条已经有一个 id 了，补发时拿它当 batch id：进度事件带的就是
    // batch id，另造一个 UUID 会让前端找不到对应气泡（它找不到时会先占一个「接收中」
    // 的**入向**气泡，等于自己发文件却凭空多出一个对方发来的气泡）。
    // 直发那一路本来就是 id = batch，两条路到这里口径一致
    let batch = match queued {
        Some(m) => m.id.clone(),
        None => uuid::Uuid::new_v4().simple().to_string(),
    };

    // 先算总量，才能给出跨文件的累计进度
    let items: Vec<(PathBuf, String)> = if is_dir {
        let mut v = Vec::new();
        collect_dir(path, Path::new(&name), &mut v)?;
        v
    } else {
        vec![(path.to_path_buf(), name.clone())]
    };
    if items.is_empty() {
        return Err(format!("{} 里没有任何文件", path.display()));
    }
    let total: u64 = items
        .iter()
        .map(|(f, _)| fs::metadata(f).map(|m| m.len()).unwrap_or(0))
        .sum();

    let msg = match queued {
        // 排队期间这个文件夹可能又被塞了东西、那张图可能变大了：气泡上的大小与类型
        // 要以补发这一刻算出的总量为准（入队时那个数只是当时的一眼，
        // 文件夹入队时干脆没大小）。这里不另追一行也不推事件：
        // 底下那份 done 会把这个新值一并落库
        Some(m) => Message {
            size: Some(total),
            kind: if is_dir { "folder".into() } else { "file".into() },
            name: Some(name.clone()),
            ..m.clone()
        },
        None => {
            let fresh = Message {
                id: batch.clone(),
                dir: "out".into(),
                kind: if is_dir { "folder".into() } else { "file".into() },
                text: None,
                name: Some(name.clone()),
                size: Some(total),
                path: Some(path.to_string_lossy().to_string()),
                state: "sending".into(),
                ts: store::now_ms(),
                peer: peer.id.clone(),
                sid: sess.id.clone(),
                ..Default::default()
            };
            hub.store.append_message(&fresh)?;
            hub.emit("msg-updated", serde_json::json!({ "message": fresh }));
            fresh
        }
    };

    let mut sent_acc: u64 = 0;
    let mut last_emit = 0i64;
    for (idx, (file, rel)) in items.iter().enumerate() {
        let is_last = idx + 1 == items.len();
        let res = put_file(
            hub,
            peer,
            sess,
            file,
            rel,
            &name,
            &batch,
            is_last,
            total,
            &mut |sent: u64, _one: u64| {
                let now = store::now_ms();
                let acc = sent_acc + sent;
                if is_last || now - last_emit > 200 {
                    last_emit = now;
                    hub.emit(
                        "xfer-progress",
                        serde_json::json!({
                            // sid 也带上：前端要知道这个进度该铺进哪个对话框，同一台的其它框不能跟着动
                            "msg_id": batch, "dir": "out", "peer": peer.id.clone(), "sid": sess.id,
                            "sent": acc.min(total), "total": total, "name": rel
                        }),
                    );
                }
            },
        );
        match res {
            Ok(n) => sent_acc += n,
            Err(e) => {
                return Err(finalize_failed(
                    hub,
                    &msg,
                    format!("发送 {rel} 失败: {e}"),
                    queued.is_some(),
                    false,
                ));
            }
        }
    }

    let done = Message {
        state: "sent".into(),
        ..msg.clone()
    };
    hub.store.append_message(&done)?;
    hub.emit("xfer-done", serde_json::json!({ "message": done }));
    Ok(done)
}

fn put_file<F: FnMut(u64, u64)>(
    hub: &Hub,
    peer: &Peer,
    sess: &Session,
    file: &Path,
    rel: &str,
    top_name: &str,
    batch: &str,
    is_last: bool,
    batch_total: u64,
    on_progress: F,
) -> Result<u64, String> {
    let size = fs::metadata(file).map_err(|e| format!("读 {} 失败: {e}", file.display()))?.len();
    let sha = hash_file(file)?;
    let mut f = fs::File::open(file).map_err(|e| format!("打开 {} 失败: {e}", file.display()))?;
    let headers = {
        let mut h = signed_headers(hub, &sha);
        h.extend(session_headers(sess));
        h.push(("X-Sha256".into(), sha));
        h.push(("X-Size".into(), size.to_string()));
        h.push(("X-Name".into(), store::hdr_encode(top_name)));
        // 头值只能 ASCII，中文路径必须 base64（见 store::hdr_encode）
        h.push(("X-Rel-Path".into(), store::hdr_encode(rel)));
        h.push(("X-Batch".into(), batch.to_string()));
        // 整批总大小：接收端据此把文件夹气泡的大小与进度算对（旧版本不发，接收端会退回单文件口径）
        h.push(("X-Batch-Size".into(), batch_total.to_string()));
        h.push(("X-Last".into(), if is_last { "1".into() } else { "0".into() }));
        h
    };
    let resp = http::put_stream(&peer.host, peer.port, "/file", &headers, &mut f, size, on_progress)?;
    if !resp.ok() {
        return Err(format!("对端返回 {}：{}", resp.status, resp.body_str()));
    }
    Ok(size)
}

fn hash_file(path: &Path) -> Result<String, String> {
    use crate::store::HashWriter;
    let mut f = fs::File::open(path).map_err(|e| format!("打开 {} 失败: {e}", path.display()))?;
    let mut sink = HashWriter::new(std::io::sink());
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        use std::io::Read;
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("读 {} 失败: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        sink.write_all(&buf[..n])
            .map_err(|e| format!("计算哈希失败: {e}"))?;
    }
    let (hex, _) = sink.finish();
    Ok(hex)
}

/// 递归收集目录下的普通文件，rel 始终以目录自身名开头，保证对端还原出同名根目录。
fn collect_dir(dir: &Path, prefix: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读目录 {} 失败: {e}", dir.display()))?;
    for e in entries {
        let e = e.map_err(|e| format!("遍历 {} 失败: {e}", dir.display()))?;
        let p = e.path();
        let ft = e
            .file_type()
            .map_err(|er| format!("取 {} 类型失败: {er}", p.display()))?;
        if ft.is_symlink() {
            eprintln!("[net] 跳过符号链接 {}", p.display());
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let next = prefix.join(&name);
        if ft.is_dir() {
            collect_dir(&p, &next, out)?;
        } else if ft.is_file() {
            out.push((p, next.to_string_lossy().replace('\\', "/")));
        }
    }
    Ok(())
}
