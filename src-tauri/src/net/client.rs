//! 局域网发送端与在线心跳。
//!
//! /ping 返回 200 即代表对端与本机口令一致（口令不同会被对端拒成 403），
//! 因此发现线程看到一个能通过 /ping 的设备就直接登记为可发对端，无需手动配对。
//! 登记不等于选中：当前聊哪个对话框（active）由用户点，不能在三台里随机挑。

use super::Hub;
use crate::http;
use crate::store::{self, Message, Peer, Session};
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
        name: None,
        size: None,
        path: None,
        state: "sending".into(),
        ts: store::now_ms(),
        peer: peer.id.clone(),
        sid: sess.id.clone(),
    };
    hub.store.append_message(&msg)?;
    hub.emit("msg-updated", serde_json::json!({ "message": msg }));

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
        Ok(r) if r.ok() => {
            let done = Message {
                state: "sent".into(),
                ..msg.clone()
            };
            hub.store.append_message(&done)?;
            hub.emit("msg-updated", serde_json::json!({ "message": done }));
            Ok(done)
        }
        Ok(r) => Err(finalize_failed(hub, &msg, format!("对端返回 {}", r.status))),
        Err(e) => Err(finalize_failed(hub, &msg, e)),
    }
}

/// 失败也要留下记录：messages.jsonl 是追加式，同 ID 以最后一条为准
fn finalize_failed(hub: &Arc<Hub>, msg: &Message, err: String) -> String {
    let failed = Message {
        state: "failed".into(),
        ..msg.clone()
    };
    let _ = hub.store.append_message(&failed);
    hub.emit("msg-updated", serde_json::json!({ "message": failed }));
    err
}

/// 发送一批路径（文件或文件夹）到同一个对话框。文件夹会递归成多个 PUT，共用一个气泡与 batch id。
pub fn send_paths(hub: &Arc<Hub>, peer: &Peer, sess: &Session, paths: Vec<String>) -> Result<Vec<Message>, String> {
    let mut out = Vec::new();
    for p in paths {
        out.push(send_one(hub, peer, sess, Path::new(&p))?);
    }
    Ok(out)
}

fn send_one(hub: &Arc<Hub>, peer: &Peer, sess: &Session, path: &Path) -> Result<Message, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("读不到 {} : {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("跳过符号链接: {}", path.display()));
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| format!("{} 没有文件名", path.display()))?;
    let is_dir = meta.is_dir();
    let batch = uuid::Uuid::new_v4().simple().to_string();

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

    let msg = Message {
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
    };
    hub.store.append_message(&msg)?;
    hub.emit("msg-updated", serde_json::json!({ "message": msg }));

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
                return Err(finalize_failed(hub, &msg, format!("发送 {rel} 失败: {e}")));
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
