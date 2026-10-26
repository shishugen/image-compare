//! 配对与设备管理命令：口令、本机名、手动 IP 兜底、解绑。
//!
//! 配对就是把一台设备「登记」进来：同时可以登记多台，每台都是一个独立会话，
//! 都能主动发。新登记不会顶掉旧的，也不会自动把当前会话抢过去。
//! 只有口令不一致 / 不是本应用这类确定错才会把候选从列表里去掉。
//! 用户主动解绑过的那台会进一份名单，后台从此不再替他把它绑回来（见 `unbind_peer`）。

use crate::net::{client, Hub};
use crate::store::Peer;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

/// 口令太短在这个场景里没有意义（局域网里可被穷举），给个下限
const MIN_PASSPHRASE: usize = 4;

/// 已登记的对端 + 当前会话 + 候选列表，前端连接面板用
#[tauri::command]
pub fn list_peers(hub: State<'_, Arc<Hub>>) -> Value {
    json!({
        "peers": hub.peers_snapshot(),
        "active": hub.active_snapshot(),
        "discovered": hub.discovered_json(),
    })
}

/// 设置配对口令与本机显示名。两台填同一口令即互认。
#[tauri::command]
pub fn set_pair_config(
    hub: State<'_, Arc<Hub>>,
    passphrase: Option<String>,
    name: Option<String>,
) -> Result<Value, String> {
    let hub = hub.inner().clone();
    let mut device = hub.device_snapshot();

    if let Some(p) = passphrase {
        let p = p.trim().to_string();
        if p.len() < MIN_PASSPHRASE {
            return Err(format!("配对口令至少 {MIN_PASSPHRASE} 个字符"));
        }
        device.passphrase = p;
    }
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() {
            return Err("设备名不能为空".into());
        }
        if n.chars().count() > 40 {
            return Err("设备名过长（最多 40 个字符）".into());
        }
        device.name = n;
    }
    if device.passphrase.is_empty() {
        return Err("还没设置配对口令".into());
    }
    hub.store
        .save_device(&device)
        .map_err(|e| format!("保存设备信息失败: {e}"))?;
    hub.set_device(device);
    // 口令变了，之前扫到的候选需要重新验证，先清空避免心跳拿旧地址反复失败
    hub.clear_discovered();
    Ok(hub.status_json())
}

/// 手动配对兜底：填对端 IP（可带端口），端口留空则从默认端口连续试探。
/// 公司网络/VLAN 常屏蔽 multicast，mDNS 整段失效时这是唯一入口。
/// 多台共存时这里不拒第三台：按地址 ping，成功就是把这一台登记进来
/// （bind_peer 按设备 ID 插入，顺手会把会话建好）。
#[tauri::command]
pub async fn bind_peer_addr(
    hub: State<'_, Arc<Hub>>,
    addr: String,
) -> Result<Value, String> {
    let hub = hub.inner().clone();
    let addr = addr.trim().to_string();
    let (host, port) = split_addr(&addr)?;
    tauri::async_runtime::spawn_blocking(move || {
        let ports: Vec<u16> = match port {
            Some(p) => vec![p],
            None => (0..crate::net::PORT_TRIES).map(|o| crate::net::DEFAULT_PORT + o).collect(),
        };
        let mut last_err = String::from("没有可试的端口");
        for p in ports {
            match client::ping(&hub, &host, p) {
                Ok(peer) => {
                    hub.bind_peer(peer.clone());
                    return Ok(json!({ "peer": peer }));
                }
                Err(e) => {
                    // 口令不一致这类明确错误不必再把十个端口试一遍
                    if e.contains("口令") {
                        return Err(format!("{host} 连不上：{e}"));
                    }
                    last_err = e;
                }
            }
        }
        Err(format!("{host} 连不上：{last_err}"))
    })
    .await
    .map_err(|e| format!("配对任务被中断: {e}"))?
}

/// 解绑一台。会话与历史都留着，只失去「主动发给它」的地址；
/// 同时把它记进解绑名单，否则 mDNS 还在广播、心跳下一拍 ping 得通就又自动登记回来了
#[tauri::command]
pub fn unbind_peer(hub: State<'_, Arc<Hub>>, peer: String) -> Result<Value, String> {
    let hub = hub.inner().clone();
    hub.unbind_peer_id(&peer)?;
    Ok(hub.status_json())
}

/// 给一台已登记的对端改备注名（像微信里给好友设的备注）：只影响本机显示，
/// 不会传给对端。传空串就是清掉备注，退回对方上报的设备名。
/// 名字只在本机这一侧，所以改完不需要对端在线
#[tauri::command]
pub fn set_peer_alias(
    hub: State<'_, Arc<Hub>>,
    peer: String,
    alias: String,
) -> Result<Value, String> {
    let hub = hub.inner().clone();
    hub.set_peer_alias(&peer, &alias)?;
    Ok(hub.status_json())
}

/// 重新探测一台已登记设备的地址。失败只把它标离线，不删：
/// 离线不等于解绑，否则对端重启一次就要重新配一次
#[tauri::command]
pub async fn reprobe_peer(hub: State<'_, Arc<Hub>>, peer: String) -> Result<Value, String> {
    let hub = hub.inner().clone();
    let target = hub
        .peer_by_id(&peer)
        .ok_or_else(|| "还没有登记这台对端".to_string())?;
    tauri::async_runtime::spawn_blocking(move || match client::ping(&hub, &target.host, target.port) {
        Ok(fresh) => {
            let p = Peer {
                online: true,
                ..fresh.clone()
            };
            hub.bind_peer(p.clone());
            Ok(json!({ "peer": p, "online": true }))
        }
        Err(e) => {
            hub.set_peer_online(&target.id, false);
            Err(e)
        }
    })
    .await
    .map_err(|e| format!("探测任务被中断: {e}"))?
}

/// 接受 "192.168.1.8"、"192.168.1.8:45790"、"fe80::1" 三种写法
fn split_addr(s: &str) -> Result<(String, Option<u16>), String> {
    if s.is_empty() {
        return Err("地址不能为空".into());
    }
    // IPv6 带端口时形如 [fe80::1]:45789
    if let Some(rest) = s.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| "IPv6 地址缺少收尾的 ]".to_string())?;
        let port = match tail.strip_prefix(':') {
            Some(p) => Some(p.parse::<u16>().map_err(|e| format!("端口不合法: {e}"))?),
            None => None,
        };
        if host.is_empty() {
            return Err("IPv6 地址为空".into());
        }
        return Ok((host.to_string(), port));
    }
    // 只有唯一一个冒号时才当作 host:port，否则（裸 IPv6）整体当主机
    match s.matches(':').count() {
        1 => {
            let (host, port) = s.split_once(':').expect("上面已判定有一个冒号");
            if host.is_empty() {
                return Err("缺少主机地址".into());
            }
            let port: u16 = port.parse().map_err(|e| format!("端口不合法: {e}"))?;
            Ok((host.to_string(), Some(port)))
        }
        0 => {
            if s.contains('/') || s.contains(' ') {
                return Err("只填 IP 或 IP:端口，不要带其它内容".into());
            }
            Ok((s.to_string(), None))
        }
        _ => Ok((s.to_string(), None)), // 裸 IPv6，端口走试探
    }
}
