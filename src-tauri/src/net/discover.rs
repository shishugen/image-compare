//! mDNS 广播与浏览：让两台设备在同一局域网里自动看见对方。
//!
//! 注意公司网络/VLAN 常常屏蔽 multicast，这条路径可能整段失效，
//! 所以 pair.rs 里的手动填 IP:端口 兜底是必做项，不是可选项。

use super::{Discovered, Hub};
use crate::store;
use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// 服务类型。mdns-sd 要求类型段（"_imagecmp._tcp"）不超过 15 字节
pub const SERVICE_TYPE: &str = "_imagecmp._tcp.local.";
const TXT_ID: &str = "id";
const TXT_NAME: &str = "name";
/// 等接收线程把实际监听端口写出来的最长时限
const PORT_WAIT_MS: u64 = 10_000;

pub fn spawn(hub: Arc<Hub>) {
    std::thread::spawn(move || {
        let daemon = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                // 发现失败不影响手动 IP 配对，所以只提示不阻断
                let msg = format!("mDNS 服务启动失败，只能用手动 IP 配对: {e}");
                eprintln!("[net] {msg}");
                hub.set_net_error(msg);
                return;
            }
        };

        let port = wait_port(&hub);
        if port == 0 {
            eprintln!("[net] 接收服务未就绪，跳过 mDNS 广播（仍可浏览到对端）");
        } else if let Err(e) = advertise(&daemon, &hub, port) {
            let msg = format!("mDNS 广播失败，对端无法自动发现本机: {e}");
            eprintln!("[net] {msg}");
            hub.set_net_error(msg);
        }

        let receiver = match daemon.browse(SERVICE_TYPE) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[net] mDNS 浏览启动失败: {e}");
                return;
            }
        };
        // fullname -> 我们的设备 id，ServiceRemoved 只给 fullname，靠这张表回查
        let mut by_fullname: HashMap<String, String> = HashMap::new();

        loop {
            if hub.stop.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let event = match receiver.recv_timeout(Duration::from_secs(2)) {
                Ok(ev) => ev,
                Err(mdns_sd::RecvTimeoutError::Timeout) => continue,
                Err(mdns_sd::RecvTimeoutError::Disconnected) => {
                    eprintln!("[net] mDNS 浏览通道已关闭，发现线程退出");
                    break;
                }
            };
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let my_id = hub.device_snapshot().id;
                    let peer_id = info.get_property_val_str(TXT_ID).unwrap_or_default().to_string();
                    if peer_id.is_empty() || peer_id == my_id {
                        continue; // 广播里没有设备 id 的就是别人家的服务，或是本机自己
                    }
                    let host = match pick_address(&*info) {
                        Some(h) => h,
                        None => {
                            eprintln!("[net] 发现 {peer_id} 但没有可用地址，忽略");
                            continue;
                        }
                    };
                    let name = info
                        .get_property_val_str(TXT_NAME)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| info.get_hostname())
                        .to_string();
                    let d = Discovered {
                        id: peer_id.clone(),
                        name,
                        host,
                        port: info.get_port(),
                        seen: store::now_ms(),
                    };
                    by_fullname.insert(info.get_fullname().to_string(), peer_id.clone());
                    if hub.upsert_discovered(d) {
                        eprintln!("[net] 发现候选设备 #{peer_id} {}", hub.discovered_snapshot().len());
                        hub.emit_peers_changed();
                    }
                }
                ServiceEvent::ServiceRemoved(_ty, fullname) => {
                    if let Some(id) = by_fullname.remove(&fullname) {
                        hub.remove_discovered(&id);
                    }
                }
                _ => {}
            }
        }
        let _ = daemon.shutdown();
    });
}

/// 接收线程是异步绑定的，端口要等它写进 Hub 才拿来广播
fn wait_port(hub: &Hub) -> u16 {
    let mut waited = 0u64;
    loop {
        let p = hub.port_snapshot();
        if p != 0 || waited >= PORT_WAIT_MS {
            return p;
        }
        std::thread::sleep(Duration::from_millis(100));
        waited += 100;
    }
}

fn advertise(daemon: &ServiceDaemon, hub: &Hub, port: u16) -> Result<(), String> {
    let d = hub.device_snapshot();
    // 实例名给人看，主机名只当 DNS 标签用，所以后者必须是 ASCII，直接拿设备 id 前缀。
    // mdns-sd 要求主机名以 ".local." 结尾（带尾点），少一个点就注册不进去。
    let host_name = format!("imgcmp-{}.local.", d.id.chars().take(8).collect::<String>());
    let mut props = HashMap::new();
    props.insert(TXT_ID.to_string(), d.id.clone());
    props.insert(TXT_NAME.to_string(), d.name.clone());
    let info = ServiceInfo::new(SERVICE_TYPE, &d.name, &host_name, (), port, props)
        .map_err(|e| format!("构造服务记录失败: {e}"))?
        .enable_addr_auto(); // 让系统按本机网卡自动填地址
    daemon.register(info).map_err(|e| format!("{e}"))
}

/// 优先非回环 IPv4：我们的 HTTP 服务监听 0.0.0.0，v4 是两台机器最通用的一条路径。
/// 多网卡（Wi-Fi + 有线）时 HashSet 顺序不定，先排序再挑，保证结果可复现。
fn pick_address(info: &ResolvedService) -> Option<String> {
    let mut v4: Vec<String> = info
        .get_addresses()
        .iter()
        .filter(|a| a.is_ipv4() && !a.is_loopback())
        .map(|a| a.to_ip_addr().to_string())
        .collect();
    if !v4.is_empty() {
        v4.sort();
        return Some(v4.remove(0));
    }
    let mut other: Vec<String> = info
        .get_addresses()
        .iter()
        .filter(|a| !a.is_loopback())
        .map(|a| a.to_ip_addr().to_string())
        .collect();
    if other.is_empty() {
        other = info
            .get_addresses()
            .iter()
            .map(|a| a.to_ip_addr().to_string())
            .collect();
    }
    other.sort();
    other.into_iter().next()
}
