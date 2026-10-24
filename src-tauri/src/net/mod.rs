//! 局域网收发子模块。
//!
//! `Hub` 是这块功能的唯一运行时状态：本机身份、监听端口、已绑定对端、
//! 候选设备表、停止标志。三个后台线程（接收服务 / mDNS 发现 / 心跳）
//! 和所有 Tauri 命令都只通过它交换数据。

pub mod client;
pub mod discover;
pub mod server;

use crate::store::{self, Device, Message, Peer, Store};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// 默认监听端口，被占用时依次 +1 试探
pub const DEFAULT_PORT: u16 = 45789;
pub const PORT_TRIES: u16 = 10;
/// 一次最多回给前端多少条历史（够铺满首屏，且不让 IPC 载荷过大）
const HISTORY_LIMIT: usize = 500;

/// mDNS 浏览到的候选设备，尚未通过 /ping 校验
#[derive(Clone, Serialize)]
pub struct Discovered {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub seen: i64,
}

pub struct Hub {
    pub app: AppHandle,
    pub store: Arc<Store>,
    device: Mutex<Device>,
    /// 实际监听端口，0 表示还没监听成功
    pub port: Mutex<u16>,
    peer: Mutex<Option<Peer>>,
    discovered: Mutex<HashMap<String, Discovered>>,
    /// 接收服务起不来之类的错误，原样显示给用户
    net_error: Mutex<Option<String>>,
    pub stop: AtomicBool,
}

impl Hub {
    pub fn new(app: AppHandle, store: Arc<Store>) -> Result<Arc<Self>, String> {
        let device = store.load_or_create_device()?;
        let peer = store.load_peers();
        if let Some(p) = &peer {
            eprintln!("[net] 已加载绑定对端 {} ({}:{})", p.name, p.host, p.port);
        }
        Ok(Arc::new(Self {
            app,
            store,
            device: Mutex::new(device),
            port: Mutex::new(0),
            peer: Mutex::new(peer),
            discovered: Mutex::new(HashMap::new()),
            net_error: Mutex::new(None),
            stop: AtomicBool::new(false),
        }))
    }

    pub fn device_snapshot(&self) -> Device {
        self.device.lock().expect("device 锁中毒").clone()
    }

    pub fn port_snapshot(&self) -> u16 {
        *self.port.lock().expect("port 锁中毒")
    }

    /// 改了口令或设备名后调用：内存与 UI 同步，监听端口不重跑
    pub fn set_device(&self, d: Device) {
        *self.device.lock().expect("device 锁中毒") = d;
        self.emit_peers_changed();
    }

    pub fn clear_discovered(&self) {
        let had = !self.discovered.lock().expect("discovered 锁中毒").is_empty();
        self.discovered.lock().expect("discovered 锁中毒").clear();
        if had {
            self.emit_peers_changed();
        }
    }

    pub fn peer_snapshot(&self) -> Option<Peer> {
        self.peer.lock().expect("peer 锁中毒").clone()
    }

    /// 绑定/替换对端并落库。只允许一台，所以直接覆盖。
    pub fn bind_peer(&self, peer: Peer) {
        if let Err(e) = self.store.save_peer(&peer) {
            eprintln!("[net] 保存对端失败: {e}");
        }
        *self.peer.lock().expect("peer 锁中毒") = Some(peer);
        self.emit_peers_changed();
    }

    pub fn set_peer_online(&self, online: bool) {
        {
            let mut g = self.peer.lock().expect("peer 锁中毒");
            if let Some(p) = g.as_mut() {
                p.online = online;
                if online {
                    p.last_seen = store::now_ms();
                }
            } else {
                return;
            }
        }
        // 状态变了也要持久化，否则重启后显示的还是上次的在线标记
        if let Some(p) = self.peer_snapshot() {
            if let Err(e) = self.store.save_peer(&p) {
                eprintln!("[net] 保存对端状态失败: {e}");
            }
        }
        self.emit_peers_changed();
    }

    /// 心跳成功但未改变在线状态时，只刷新 last_seen（不落库，避免每秒写盘）
    pub fn touch_peer(&self, last_seen: i64, host: &str, port: u16) {
        let mut g = self.peer.lock().expect("peer 锁中毒");
        if let Some(p) = g.as_mut() {
            p.last_seen = last_seen;
            // mDNS 重新解析可能换 IP，绑定地址跟着更新
            if p.host != host || p.port != port {
                eprintln!("[net] 对端地址变化 {}:{} -> {host}:{port}", p.host, p.port);
                p.host = host.to_string();
                p.port = port;
            }
        }
    }

    pub fn unbind_peer(&self) -> Result<(), String> {
        self.store.clear_peer()?;
        *self.peer.lock().expect("peer 锁中毒") = None;
        self.emit_peers_changed();
        Ok(())
    }

    pub fn discovered_snapshot(&self) -> Vec<Discovered> {
        let mut v: Vec<Discovered> = self.discovered.lock().expect("discovered 锁中毒").values().cloned().collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    /// 返回是否发生了变化（新设备，或名称/地址有变），调用方据此决定是否推事件
    pub fn upsert_discovered(&self, d: Discovered) -> bool {
        let mut g = self.discovered.lock().expect("discovered 锁中毒");
        if let Some(old) = g.get(&d.id) {
            if old.host == d.host && old.port == d.port && old.name == d.name {
                return false;
            }
        }
        g.insert(d.id.clone(), d);
        true
    }

    pub fn remove_discovered(&self, id: &str) {
        let removed = self.discovered.lock().expect("discovered 锁中毒").remove(id);
        if removed.is_some() {
            eprintln!("[net] 候选设备 {id} 已移除");
            self.emit_peers_changed();
        }
    }

    pub fn set_net_error(&self, msg: String) {
        *self.net_error.lock().expect("net_error 锁中毒") = Some(msg);
        self.emit_peers_changed();
    }

    pub fn emit(&self, event: &str, payload: Value) {
        if let Err(e) = self.app.emit(event, payload) {
            eprintln!("[net] 推送 {event} 失败: {e}");
        }
    }

    /// 前端只监听这一个事件即可刷新连接面板；载荷与 net_status 完全一致
    pub fn emit_peers_changed(&self) {
        self.emit("peers-changed", self.status_json());
    }

    pub fn status_json(&self) -> Value {
        let d = self.device_snapshot();
        json!({
            "device_id": d.id,
            "device_name": d.name,
            "passphrase_set": !d.passphrase.is_empty(),
            "port": self.port_snapshot(),
            "default_port": DEFAULT_PORT,
            "peer": self.peer_snapshot(),
            "discovered": self.discovered_snapshot(),
            "error": self.net_error.lock().expect("net_error 锁中毒").clone(),
            "server_ok": self.port_snapshot() != 0,
        })
    }
}

fn require_peer(hub: &Hub) -> Result<Peer, String> {
    match hub.peer_snapshot() {
        None => Err("还没有绑定对端：请确认两台填了同一个配对口令，并在同一局域网内".into()),
        Some(p) if !p.online => Err(format!("对端「{}」离线，稍后重试", p.name)),
        Some(p) => Ok(p),
    }
}

/// 数据目录与收件箱：收藏、消息、设备身份都落在这里
pub fn prepare_store(app: &AppHandle) -> Result<Arc<Store>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取 app_data_dir 失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录 {} 失败: {e}", dir.display()))?;
    std::fs::create_dir_all(dir.join("inbox")).map_err(|e| format!("创建收件箱失败: {e}"))?;
    eprintln!("[net] 数据目录 {}", dir.display());
    Ok(Arc::new(Store::new(dir)))
}

/// 拉起三个后台线程。在 setup 里调用，此时 AppHandle 已可用。
pub fn start(app: &AppHandle, store: Arc<Store>) -> Result<Arc<Hub>, String> {
    let hub = Hub::new(app.clone(), store)?;
    server::spawn(hub.clone());
    discover::spawn(hub.clone());
    client::spawn_heartbeat(hub.clone());
    Ok(hub)
}

/* --------------------------------------------------------------------------
 * 命令
 * ------------------------------------------------------------------------ */

#[tauri::command]
pub fn net_status(hub: State<'_, Arc<Hub>>) -> Value {
    hub.status_json()
}

/// 文字消息：同步等对端 2xx 才算「已送达」，所以放 blocking 线程里跑
#[tauri::command]
pub async fn send_text(hub: State<'_, Arc<Hub>>, text: String) -> Result<Message, String> {
    let hub = hub.inner().clone();
    if text.trim().is_empty() {
        return Err("内容为空".into());
    }
    if text.len() as u64 > store::MAX_BODY_BYTES {
        return Err("单条文字超过 1MB，请拆分后发送".into());
    }
    let peer = require_peer(&hub)?;
    tauri::async_runtime::spawn_blocking(move || client::send_text(&hub, &peer, text))
        .await
        .map_err(|e| format!("发送任务被中断: {e}"))?
}

#[tauri::command]
pub async fn send_paths(hub: State<'_, Arc<Hub>>, paths: Vec<String>) -> Result<Vec<Message>, String> {
    let hub = hub.inner().clone();
    if paths.is_empty() {
        return Err("没有要发送的文件".into());
    }
    let peer = require_peer(&hub)?;
    tauri::async_runtime::spawn_blocking(move || client::send_paths(&hub, &peer, paths))
        .await
        .map_err(|e| format!("发送任务被中断: {e}"))?
}

#[tauri::command]
pub fn msg_history(hub: State<'_, Arc<Hub>>, limit: Option<usize>) -> Vec<Message> {
    hub.store.read_messages(limit.unwrap_or(HISTORY_LIMIT).clamp(1, 5000))
}

/// 打开收件箱目录（在系统文件管理器里定位到具体文件）
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&p);
        c
    } else if cfg!(target_os = "windows") {
        // /select, 要求反斜杠路径，且必须和参数在同一枚 token 里
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", p.display()));
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(p.parent().unwrap_or(&p));
        c
    };
    cmd.spawn()
        .map_err(|e| format!("调用系统文件管理器失败: {e}"))?;
    Ok(())
}

/// 发送用的文件夹选择（不加任何扩展名过滤，什么目录都能选）
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    app.dialog()
        .file()
        .set_title("选择要发送的文件夹")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let folder = rx.await.map_err(|e| format!("文件夹对话框异常: {e}"))?;
    Ok(folder.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

/// 发送用的文件选择：与选图对比用的 pick_images 分开，这里不限制张数也不限类型
#[tauri::command]
pub async fn pick_send_files(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<tauri_plugin_dialog::FilePath>>>();
    app.dialog().file().set_title("选择要发送的文件（可多选）").pick_files(move |files| {
        let _ = tx.send(files);
    });
    let files = rx.await.map_err(|e| format!("文件对话框异常: {e}"))?;
    Ok(files.unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect())
}
