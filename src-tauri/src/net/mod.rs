//! 局域网收发子模块。
//!
//! `Hub` 是这块功能的唯一运行时状态：本机身份、监听端口、已登记的对端（可多台）、
//! 会话表与焦点、候选设备表、解绑名单、停止标志。三个后台线程（接收服务 / mDNS 发现 /
//! 心跳）和所有 Tauri 命令都只通过它交换数据。
//!
//! 会话（对话框）以 `Session.id` 为主键：一台对端的基础对话就用它的设备 ID，
//! 同一台再开的对话用另造的 UUID，并随消息带 `X-Session` 过去 —— 同一个框在两边是同一个。

pub mod client;
pub mod discover;
pub mod server;

use crate::store::{self, Device, Message, PeersFile, Peer, Session, SessionsFile, Store};
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
/// 一次最多回给前端多少条历史（翻页的上限，也是游标失效时的兜底页大小）
const HISTORY_LIMIT: usize = 500;
/// 首屏铺多少条：像微信那样先只看最近几条，滚到顶再补上一页
const HISTORY_PAGE: usize = 10;

/// mDNS 浏览到的候选设备，尚未通过 /ping 校验
#[derive(Clone, Serialize)]
pub struct Discovered {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub seen: i64,
}

/// 一批传输（同一个 batch id，文件夹会拆成多个 PUT）在接收端的累计状态。
/// 没有它，文件夹气泡只能拿到「最后一个文件的大小」，进度条也只能按单件算。
#[derive(Clone, Copy)]
pub struct BatchAcc {
    /// 已完整收到的字节数，作为下一个文件的进度基准
    pub written: u64,
    /// 发送端通过 X-Batch-Size 告知的整批总大小，0 表示对方没告知
    pub total: u64,
    /// 已收到的文件个数
    pub files: u64,
    pub seen: i64,
}

impl Default for BatchAcc {
    fn default() -> Self {
        Self {
            written: 0,
            total: 0,
            files: 0,
            seen: 0,
        }
    }
}

/// 会话列表里每一行要的统计，一遍历史算完：未读数、最后一条的时间与摘要
#[derive(Default, Clone)]
struct SessionStat<'a> {
    unread: usize,
    last: i64,
    summary: String,
    /// 这个框里最后一条是谁发的：只从历史里露出来的会话要靠它找回所属对端
    peer: &'a str,
}

pub struct Hub {
    pub app: AppHandle,
    pub store: Arc<Store>,
    device: Mutex<Device>,
    /// 实际监听端口，0 表示还没监听成功
    pub port: Mutex<u16>,
    /// 已登记的每一台对端，key 是设备 ID。同时可以有多台，每台都能主动发
    peers: Mutex<HashMap<String, Peer>>,
    /// 用户主动解绑过的设备 ID。mDNS 一直在广播，这一台下一拍仍会被发现、ping 通，
    /// 没有这份名单的话「解绑」只撑一秒：心跳又把同一台自动登记回来
    ignored: Mutex<Vec<String>>,
    /// 会话表 + 焦点。主键是会话 ID（一台可以有多个框），所以与 peers 不是同一套 key
    sessions: Mutex<SessionsFile>,
    discovered: Mutex<HashMap<String, Discovered>>,
    /// 接收中的批次累计，收完（X-Last）就取走
    batches: Mutex<HashMap<String, BatchAcc>>,
    /// 接收服务起不来之类的错误，原样显示给用户
    net_error: Mutex<Option<String>>,
    pub stop: AtomicBool,
}

impl Hub {
    pub fn new(app: AppHandle, store: Arc<Store>) -> Result<Arc<Self>, String> {
        let device = store.load_or_create_device()?;
        let peers_file = store.load_peers();
        let peers: HashMap<String, Peer> =
            peers_file.peers.into_iter().map(|p| (p.id.clone(), p)).collect();
        let mut sessions = store.load_sessions();
        // 旧版本只有「绑定的那台」，没有会话表：首次跨到多台时按对端各建一个。
        // 光看 peers.json 不够 —— 老历史里还有已经解绑的设备，那些消息不能没人认领
        let seen: Vec<String> = {
            let mut v: Vec<String> = Vec::new();
            for m in store.read_messages(usize::MAX) {
                if !m.peer.is_empty() && !v.contains(&m.peer) {
                    v.push(m.peer);
                }
            }
            v
        };
        if migrate_sessions(&mut sessions, &peers, &seen) {
            if let Err(e) = store.save_sessions(&sessions) {
                eprintln!("[net] 保存迁移后的会话失败: {e}");
            } else {
                eprintln!("[net] 已为 {} 台对端建好会话", sessions.sessions.len());
            }
        }
        for p in peers.values() {
            eprintln!("[net] 已加载对端 {} ({}:{})", p.name, p.host, p.port);
        }
        Ok(Arc::new(Self {
            app,
            store,
            device: Mutex::new(device),
            port: Mutex::new(0),
            peers: Mutex::new(peers),
            ignored: Mutex::new(peers_file.ignored),
            sessions: Mutex::new(sessions),
            discovered: Mutex::new(HashMap::new()),
            batches: Mutex::new(HashMap::new()),
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

    /* ---- peers：同时可以绑着多台，key 是设备 ID ---- */

    /// peers.json 的完整一份：对端 + 解绑名单。所有写盘都走这一条，
    /// 免得哪条路径只写了对端而把名单抹掉（那等于偷偷恢复了自动登记）
    fn peers_file(&self) -> PeersFile {
        PeersFile {
            peers: self.peers.lock().expect("peers 锁中毒").values().cloned().collect(),
            ignored: self.ignored.lock().expect("ignored 锁中毒").clone(),
        }
    }

    pub fn peers_snapshot(&self) -> Vec<Peer> {
        let mut v: Vec<Peer> = self.peers.lock().expect("peers 锁中毒").values().cloned().collect();
        v.sort_by(|a, b| a.display_name().cmp(&b.display_name()).then_with(|| a.id.cmp(&b.id)));
        v
    }

    pub fn peer_by_id(&self, id: &str) -> Option<Peer> {
        self.peers.lock().expect("peers 锁中毒").get(id).cloned()
    }

    /// 这台是不是被用户解绑过（解绑过的只允许用户亲手再加，后台一律不能替他拿主意）
    pub fn is_ignored(&self, id: &str) -> bool {
        self.ignored.lock().expect("ignored 锁中毒").iter().any(|i| i == id)
    }

    /// 把一台从解绑名单里放出来（用户亲手重新添加就等于撤回了「别再连它」）
    fn unignore_peer(&self, id: &str) {
        let mut g = self.ignored.lock().expect("ignored 锁中毒");
        g.retain(|i| i != id);
    }

    pub fn ignored_snapshot(&self) -> Vec<String> {
        self.ignored.lock().expect("ignored 锁中毒").clone()
    }

    /// 登记/更新一台对端并落库。同一台设备重复绑定只覆盖它自己那一条，
    /// 不会像单台时期那样把别人挤掉。
    pub fn bind_peer(&self, peer: Peer) {
        let (peer, changed) = {
            let mut g = self.peers.lock().expect("peers 锁中毒");
            // 备注名是本机打上去的，对方 /ping 响应里压根没这个字段：重新登记时必须
            // 从旧记录里搬过来，否则心跳每一拍都会拿对方报的名把用户刚写的备注顶掉
            let peer = match g.get(&peer.id) {
                Some(old) if peer.alias.trim().is_empty() => {
                    Peer { alias: old.alias.clone(), ..peer }
                }
                _ => peer,
            };
            let same = g
                .insert(peer.id.clone(), peer.clone())
                .map(|o| {
                    o.host == peer.host
                        && o.port == peer.port
                        && o.name == peer.name
                        && o.alias == peer.alias
                        && o.online == peer.online
                })
                .unwrap_or(false);
            (peer, !same)
        };
        // 能走到这里的都是用户自己点的（手动 IP / 候选 / 重新探测）或头一回见，
        // 一律把解绑名单里那条撤掉
        self.unignore_peer(&peer.id);
        if let Err(e) = self.store.save_peers(&self.peers_file()) {
            eprintln!("[net] 保存对端失败: {e}");
        }
        // 登记了就给一个会话，否则这台设备发来的历史没有落脚的对话框
        self.upsert_session(&peer.id, &peer.display_name());
        if changed {
            self.emit_peers_changed();
        }
    }

    /// 给一台对端改备注名。空串 = 清掉备注，退回对方上报的设备名。
    /// 只改本机这一份，不会发给对端。顺手把「原本就叫旧显示名」的那些对话框一起改名，
    /// 否则备注改了但会话栏里还是老名字，等于只改了一半
    pub fn set_peer_alias(&self, id: &str, alias: &str) -> Result<(), String> {
        let alias = alias.trim();
        if alias.chars().count() > 40 {
            return Err("备注名过长（最多 40 个字符）".into());
        }
        let (prev, now) = {
            let mut g = self.peers.lock().expect("peers 锁中毒");
            let p = g
                .get_mut(id)
                .ok_or_else(|| "没有登记这台对端：先添加再改备注".to_string())?;
            let prev = p.display_name();
            p.alias = alias.to_string();
            (prev, p.display_name())
        };
        if let Err(e) = self.store.save_peers(&self.peers_file()) {
            eprintln!("[net] 保存备注名失败: {e}");
        }
        self.rename_sessions_from(id, &prev, &now);
        self.emit_peers_changed();
        Ok(())
    }

    /// 备注名改了之后，把这台名下还叫旧显示名的对话框一起改（见 `rename_by_display`）
    fn rename_sessions_from(&self, peer: &str, prev: &str, now: &str) {
        let f = {
            let mut g = self.sessions.lock().expect("sessions 锁中毒");
            if !rename_by_display(&mut g.sessions, peer, prev, now) {
                return;
            }
            g.clone()
        };
        if let Err(e) = self.store.save_sessions(&f) {
            eprintln!("[net] 保存会话改名失败: {e}");
        }
        self.emit("sessions-changed", self.sessions_json());
    }

    pub fn set_peer_online(&self, id: &str, online: bool) {
        {
            let mut g = self.peers.lock().expect("peers 锁中毒");
            match g.get_mut(id) {
                Some(p) => {
                    p.online = online;
                    if online {
                        p.last_seen = store::now_ms();
                    }
                }
                None => return,
            }
        }
        // 状态变了也要持久化，否则重启后显示的还是上次的在线标记
        if let Err(e) = self.store.save_peers(&self.peers_file()) {
            eprintln!("[net] 保存对端状态失败: {e}");
        }
        self.emit_peers_changed();
    }

    /// 心跳成功但未改变在线状态时，只刷新 last_seen（不落库，避免每秒写盘）
    pub fn touch_peer(&self, id: &str, last_seen: i64, host: &str, port: u16) {
        let mut g = self.peers.lock().expect("peers 锁中毒");
        if let Some(p) = g.get_mut(id) {
            p.last_seen = last_seen;
            // mDNS 重新解析可能换 IP，绑定地址跟着更新
            if p.host != host || p.port != port {
                eprintln!("[net] 对端 {} 地址变化 {}:{} -> {host}:{port}", p.name, p.host, p.port);
                p.host = host.to_string();
                p.port = port;
            }
        }
    }

    /// 解绑一台。会话和历史都留着：聊天记录属于本机，不该因为「不再主动发给它」就消失
    pub fn unbind_peer_id(&self, id: &str) -> Result<(), String> {
        {
            let mut g = self.peers.lock().expect("peers 锁中毒");
            if g.remove(id).is_none() {
                return Err("没有登记过这台对端".into());
            }
        }
        // 光把它从 peers 里拿掉只撑一秒：mDNS 还在广播、ping 也还通，心跳下一拍就把它
        // 自动登记回来。记进这份名单才是「不再主动连它」，要恢复只能用户亲手再加一次
        {
            let mut g = self.ignored.lock().expect("ignored 锁中毒");
            if !g.iter().any(|i| i == id) {
                g.push(id.to_string());
            }
        }
        self.store.save_peers(&self.peers_file())
    }

    /* ---- sessions：一台可以有多个对话框，主键是会话 ID ---- */

    /// 当前那个对话框（只是界面焦点）。空串表示还没选定
    pub fn active_snapshot(&self) -> String {
        self.sessions.lock().expect("sessions 锁中毒").active.clone()
    }

    pub fn session_by_id(&self, id: &str) -> Option<Session> {
        self.sessions
            .lock()
            .expect("sessions 锁中毒")
            .sessions
            .iter()
            .find(|s| s.id == id)
            .cloned()
    }

    /// 消息到达或设备登记时确保那台的基础对话存在（基础对话的 id 就是设备 ID）
    pub fn upsert_session(&self, peer: &str, name: &str) -> bool {
        self.ensure_session(peer, peer, name)
    }

    /// 这条请求该落进哪个对话框 —— 只看，不建。接收中的进度事件要在
    /// 文件收完之前就知道归属，可那时还不该为一个没收完的传输建会话
    pub fn route_session(&self, peer: &str, sid: &str) -> String {
        let f = self.sessions.lock().expect("sessions 锁中毒").clone();
        resolve_incoming(peer, sid, &f)
    }

    /// 入向消息的落点：先决定归哪个框，再把框建出来（陌生设备的第一条消息就
    /// 是在这里把会话建好的，否则这条历史没人认领）。
    /// 名字用对方报的那个，只在第一次见到这个会话时用
    pub fn session_for_incoming(&self, peer: &str, sid: &str, name: &str) -> String {
        let id = self.route_session(peer, sid);
        if !id.is_empty() {
            self.ensure_session(&id, peer, name);
        }
        id
    }

    /// 确保某个对话框在会话表里，返回是否新建。已存在时**只**在「正看着这个框」
    /// 时推读指针（非当前会话的未读数因此能自然累加），不改名字：名字建的时候
    /// 定下，之后两边各改各的 —— 用户可以重命名，对方改名不该覆盖本机那一份
    pub fn ensure_session(&self, id: &str, peer: &str, name: &str) -> bool {
        if id.is_empty() {
            return false;
        }
        let now = store::now_ms();
        let created = {
            let mut g = self.sessions.lock().expect("sessions 锁中毒");
            // 先把焦点判下来：下面拿着 sessions 的可变借用，不能再读 g.active
            let is_active = g.active == id;
            match g.sessions.iter_mut().find(|s| s.id == id) {
                Some(s) => {
                    // 正在看这个框时来消息，等于看见了：顺手推到已读
                    if is_active {
                        s.read = now;
                    }
                    false
                }
                None => {
                    // 之前被用户删过这个框的，一旦再收到消息就自动回到列表：
                    // 历史一直在磁盘上，没有丢东西，只是不再藏着
                    g.hidden.retain(|p| p != id);
                    g.sessions.push(Session {
                        id: id.to_string(),
                        peer: peer.to_string(),
                        name: name.to_string(),
                        created: now,
                        // 新建时读指针从 0 起：对方头一回敲门的条消息本身就是个未读
                        read: if is_active { now } else { 0 },
                    });
                    true
                }
            }
        };
        // 新建与推已读都得活过重启，所以两种情况一律落盘
        let f = self.sessions.lock().expect("sessions 锁中毒").clone();
        if let Err(e) = self.store.save_sessions(&f) {
            eprintln!("[net] 保存会话失败: {e}");
        }
        if created {
            self.emit("sessions-changed", self.sessions_json());
        }
        created
    }

    /// 在同一台上再开一个对话框：另造会话 ID（UUID），名字由发起方给（前端按
    /// 「设备名 · 月-日」起 —— 本地日期只有前端知道，Rust 侧只有 epoch 毫秒），
    /// 没给就退回「设备名 · 话题 N」。同一台撞名会自动加 (2)、(3)。
    /// 焦点直接切过去 —— 前端拿到列表就能接着读历史，少一次往返
    pub fn new_session(&self, peer: &str, name: &str) -> Result<String, String> {
        if peer.is_empty() {
            return Err("得先有一台对端才能开新话题".into());
        }
        let peer_name = self.peer_by_id(peer).map(|p| p.display_name()).unwrap_or_default();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let now = store::now_ms();
        let f = {
            let mut g = self.sessions.lock().expect("sessions 锁中毒");
            let same = |s: &Session| s.peer == peer;
            // 退回口径的编号按「这台已经有几个框」算，基础对话算第一个，所以新开的永远从话题 2 起
            let n = g.sessions.iter().filter(|s| same(s)).count() + 1;
            let base = session_name(peer, peer, "", Some(peer_name.as_str()));
            let want = name.trim();
            let want = if want.is_empty() { topic_name(&base, n) } else { want.to_string() };
            // 名字先算完再动手改会话表：拿 &str 迭代会借住 g，下面的 retain/push 就动不了
            let taken: Vec<String> = g.sessions.iter().filter(|s| same(s)).map(|s| s.name.clone()).collect();
            let name = unique_name(&taken.iter().map(String::as_str).collect::<Vec<_>>(), &want);
            g.hidden.retain(|p| p != &id);
            g.sessions.push(Session {
                id: id.clone(),
                peer: peer.to_string(),
                name,
                created: now,
                // 自己刚开的框当然算已经读过，不该回头就挂个未读
                read: now,
            });
            g.active = id.clone();
            g.clone()
        };
        if let Err(e) = self.store.save_sessions(&f) {
            eprintln!("[net] 保存会话失败: {e}");
        }
        self.emit("sessions-changed", self.sessions_json());
        Ok(id)
    }

    /// 重命名：只改本机这一侧的显示名，不会传给对端（对端那份名归它自己维护）
    pub fn rename_session(&self, id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("会话名不能为空".into());
        }
        let f = {
            let mut g = self.sessions.lock().expect("sessions 锁中毒");
            match g.sessions.iter_mut().find(|s| s.id == id) {
                Some(s) => s.name = name.to_string(),
                None => return Err("没有这个会话".into()),
            }
            g.clone()
        };
        self.store.save_sessions(&f)?;
        self.emit("sessions-changed", self.sessions_json());
        Ok(())
    }

    /// 切到某个对话框：设焦点并把读指针推到当下（切进来即已读）
    pub fn focus_session(&self, id: &str) {
        {
            let mut g = self.sessions.lock().expect("sessions 锁中毒");
            g.active = id.to_string();
            if let Some(s) = g.sessions.iter_mut().find(|s| s.id == id) {
                s.read = store::now_ms();
            }
        }
        let f = self.sessions.lock().expect("sessions 锁中毒").clone();
        if let Err(e) = self.store.save_sessions(&f) {
            eprintln!("[net] 保存会话失败: {e}");
        }
        self.emit_peers_changed();
    }

    /// 只删这一个对话框与它的读指针：messages.jsonl 和收件箱里的文件都不动，
    /// 对方下次在那个框里再发一条过来还会自动重建（历史本来就还在）。
    /// 顺手记进 hidden：这个框的历史还在磁盘上，不记的话列表会把它
    /// 从历史里补回来，「删除」点了等于没点
    pub fn remove_session(&self, id: &str) -> Result<(), String> {
        let f = {
            let mut g = self.sessions.lock().expect("sessions 锁中毒");
            let before = g.sessions.len();
            g.sessions.retain(|s| s.id != id);
            if before == g.sessions.len() {
                return Err("没有这个会话".into());
            }
            if !g.hidden.iter().any(|p| p == id) {
                g.hidden.push(id.to_string());
            }
            if g.active == id {
                g.active = String::new();
            }
            g.clone()
        };
        self.store.save_sessions(&f)?;
        self.emit("sessions-changed", self.sessions_json());
        Ok(())
    }

    /// 会话列表：每个框自己的未读数、最后一条时间与摘要，加上所属那台的在线态。
    /// 都要在这一遍历史扫描里算出来。只有 sessions() 命令用 —— 它要整读历史，
    /// 绝不能塞进每秒都可能被心跳推的 status_json。
    pub fn sessions_json(&self) -> Value {
        let f = self.sessions.lock().expect("sessions 锁中毒").clone();
        let peers = self.peers.lock().expect("peers 锁中毒").clone();
        let msgs = self.store.read_messages(usize::MAX);
        // 读指针按会话 ID 存：同一台的两个框各自读到自己哪儿了
        let reads: HashMap<&str, i64> = f.sessions.iter().map(|s| (s.id.as_str(), s.read)).collect();

        let stats = session_stats(&msgs, &reads);

        let mut rows: Vec<Value> = f
            .sessions
            .iter()
            .map(|s| session_row(&s.id, &s.peer, &s.name, s.created, true, &stats, &peers))
            .collect();
        // 历史里露出来、但会话表里没有的框也要建行（手改过 sessions.json、或旧版升级
        // 上来的历史才会这样）。“未标记”本来就不入会话表，靠这里露出来。
        // 先把 key 拷出来：别在推行的时候迭代 stats
        for id in orphan_sessions(&stats, &f) {
            // 所属那台从历史里反推：同一个框的消息都带着同一个发送方设备 ID
            let peer = stats.get(id).map(|s| s.peer).unwrap_or_default();
            rows.push(session_row(id, peer, "", 0, false, &stats, &peers));
        }
        rows.sort_by(|a, b| {
            b["last"]
                .as_i64()
                .unwrap_or_default()
                .cmp(&a["last"].as_i64().unwrap_or_default())
        });
        json!({ "sessions": rows, "active": f.active })
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

    /// 开始收一个文件：登记整批总大小并返回此前的累计快照（进度基准）
    pub fn batch_touch(&self, id: &str, declared_total: u64) -> BatchAcc {
        let mut g = self.batches.lock().expect("batches 锁中毒");
        // 对端中途掉线不会再发 X-Last，不清会无限增长，留 32 批够并发余量
        if g.len() > 32 {
            let mut old: Vec<(i64, String)> = g.iter().map(|(k, v)| (v.seen, k.clone())).collect();
            old.sort_by(|a, b| a.0.cmp(&b.0));
            for (_, k) in old.iter().take(g.len() - 32) {
                g.remove(k);
            }
        }
        let e = g.entry(id.to_string()).or_default();
        if declared_total > e.total {
            e.total = declared_total;
        }
        e.seen = store::now_ms();
        *e
    }

    /// 一个文件写完后累加
    pub fn batch_add_file(&self, id: &str, size: u64) -> BatchAcc {
        let mut g = self.batches.lock().expect("batches 锁中毒");
        let e = g.entry(id.to_string()).or_default();
        e.written += size;
        e.files += 1;
        e.seen = store::now_ms();
        *e
    }

    /// 最后一个文件收完：取走累计并顺手清掉条目
    pub fn batch_finish(&self, id: &str) -> BatchAcc {
        self.batches
            .lock()
            .expect("batches 锁中毒")
            .remove(id)
            .unwrap_or_default()
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
            // 单台时期的 "peer" 单对象没了：多台之后不存在「唯一那个对端」，
            // 留个兼容字段只会让前端忘记自己读的是哪一台
            "peers": self.peers_snapshot(),
            // 焦点：当前那个对话框的会话 ID（不再等于设备 ID，一台可以有多个框）
            "active": self.active_snapshot(),
            "discovered": self.discovered_json(),
            "error": self.net_error.lock().expect("net_error 锁中毒").clone(),
            "server_ok": self.port_snapshot() != 0,
        })
    }

    /// 候选设备，外加每台一句「是不是被解绑过」。解绑过的那台后台不会再自动连，
    /// 界面上得标清楚：否则用户看到的是「这台又自己冒出来了」，分不清
    /// 是自动连回来的还是他自己刚点的重新添加
    pub fn discovered_json(&self) -> Vec<Value> {
        self.discovered_snapshot()
            .into_iter()
            .map(|d| {
                let unbound = self.is_ignored(&d.id);
                json!({
                    "id": d.id,
                    "name": d.name,
                    "host": d.host,
                    "port": d.port,
                    "seen": d.seen,
                    "unbound": unbound,
                })
            })
            .collect()
    }
}

/// 一遍历史算出每个对话框的未读数、最后一条时间与摘要。
/// 拆成纯函数是为了能把未读口径当面议定：只数对方发来的、只数读指针之后的。
/// key 是会话 ID（不是对端 ID）：同一台的几个框要各算各的
fn session_stats<'a>(msgs: &'a [Message], reads: &HashMap<&str, i64>) -> HashMap<&'a str, SessionStat<'a>> {
    let mut stats: HashMap<&str, SessionStat> = HashMap::new();
    for m in msgs {
        let key = m.sid_of();
        let e = stats.entry(key).or_default();
        // 所属对端跟着最后一条消息走：只从历史里露出来的框要靠它找回那台
        e.peer = m.peer.as_str();
        if m.ts >= e.last {
            e.last = m.ts;
            e.summary = match m.kind.as_str() {
                "text" => m.text.clone().unwrap_or_default(),
                "file" => format!("[文件] {}", m.name.clone().unwrap_or_default()),
                "folder" => format!("[文件夹] {}", m.name.clone().unwrap_or_default()),
                other => other.to_string(),
            };
        }
        // 未读只数对方发来的，自己发的不算
        if m.dir == "in" && m.ts > *reads.get(key).unwrap_or(&0) {
            e.unread += 1;
        }
    }
    stats
}

/// 历史里出现过、会话表里却没有的对话框：不建行就那些消息在任何界面都看不见
/// （手改过 sessions.json、或会话没存成功时才会这样）。“未标记”（空串）本来就不入
/// 会话表，靠这里露出来。被用户删过的那个（hidden）不补 —— 否则「删除」点了
/// 等于没点；对方在那个框里再发一条过来就自己回到列表了。
/// 拆成纯函数是因为这一步同时动 sessions/hidden/历史三份口径，值得单独测
fn orphan_sessions<'a>(
    stats: &'a HashMap<&'a str, SessionStat<'a>>,
    f: &SessionsFile,
) -> Vec<&'a str> {
    stats
        .keys()
        .filter(|k| {
            !f.sessions.iter().any(|s| s.id == **k) && !f.hidden.iter().any(|p| p.as_str() == **k)
        })
        .copied()
        .collect()
}

/// 会话列表里的一行。单独拆出来是因为 sessions_json 里的借用关系很挤：
/// stats 的 key 借自历史，写成闭包就只能可变捕获，与后面的补漏行冲突。
/// `tracked` = 会话表里有没有这个框：只从历史里露出来的行（手改过会话文件的）
/// 没有读指针可言，按「全没读过」算会让这种行凭空挂上一堆未读。
/// 在线态与地址取自**所属那台**：一台的几个框共用一个对端，也一起可发/不可发
#[allow(clippy::too_many_arguments)]
fn session_row(
    id: &str,
    peer: &str,
    stored: &str,
    created: i64,
    tracked: bool,
    stats: &HashMap<&str, SessionStat>,
    peers: &HashMap<String, Peer>,
) -> Value {
    let st = stats.get(id).cloned().unwrap_or_default();
    let p = peers.get(peer);
    json!({
        "id": id,
        "peer": peer,
        // 备注名优先：这台在界面上叫什么，会话行就得叫什么
        "name": session_name(id, peer, stored, p.map(|x| x.display_name()).as_deref()),
        "host": p.map(|x| x.host.clone()).unwrap_or_default(),
        "port": p.map(|x| x.port).unwrap_or(0),
        "online": p.map(|x| x.online).unwrap_or(false),
        "bound": p.is_some(),
        "created": created,
        // 「未标记」与补漏行只用于查看历史，挂个常驻未读只会让人以为是新消息
        "unread": if peer.is_empty() || !tracked { 0 } else { st.unread },
        "last": st.last,
        "summary": st.summary,
    })
}

/// 会话显示名：会话表里存的那份优先（用户可以重命名，新话题的名字就是在这里
/// 定的）；没存过就退回所属那台的**显示名**（有备注名用备注，否则用对方报的设备名）；
/// 连那台都不认识就露一截会话 ID —— 宁可难看，也别让两个框都叫「未知设备」分不清
fn session_name(id: &str, peer: &str, stored: &str, peer_name: Option<&str>) -> String {
    if !stored.is_empty() {
        return stored.to_string();
    }
    if !peer.is_empty() {
        return match peer_name {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => format!("设备 {}", short_id(peer)),
        };
    }
    // 没有对端只可能是两种：未标记（id 也是空）或只知道会话 ID 的补漏行
    if id.is_empty() {
        "未标记".into()
    } else {
        format!("会话 {}", short_id(id))
    }
}

/// 名字兜底时露的那一截 ID：完整设备 ID 太长，列表里摆不下
fn short_id(s: &str) -> String {
    s.chars().take(8).collect()
}

/// 把这台名下**还叫旧显示名**的对话框改成新显示名，返回到底动过没有。
/// 用户自己另起过名字的那些不动：那是他给这个框起的名字，不是一台设备的名字。
/// 拆成纯函数同样是为了能被单测拿到
fn rename_by_display(sessions: &mut [Session], peer: &str, prev: &str, now: &str) -> bool {
    if prev == now {
        return false;
    }
    let hits: Vec<usize> = sessions
        .iter()
        .enumerate()
        .filter(|(_, s)| s.peer == peer && s.name == prev)
        .map(|(i, _)| i)
        .collect();
    if hits.is_empty() {
        return false;
    }
    for i in hits {
        // 名字先算完再写回去：同一台可能已经有别的框叫这个名，不能改出两个一模一样的
        let taken: Vec<&str> = sessions
            .iter()
            .enumerate()
            .filter(|(j, o)| o.peer == peer && *j != i)
            .map(|(_, o)| o.name.as_str())
            .collect();
        let name = unique_name(&taken, now);
        sessions[i].name = name;
    }
    true
}

/// 心跳这一拍可以替用户自动登记哪些候选设备。两条排除缺一不可：
/// - 已经绑过的不必再绑（它们下一轮就在 peers 里了，重复绑等于每秒写一次盘）
/// - **被解绑过的不能擅自绑回来**：mDNS 还在广播、ping 也还通，少了这一条，
///   用户点「解绑」只撑一秒 —— 下一拍心跳就把同一台又登记回来了
/// 拆成纯函数就是为了这两条能被单测拿到：心跳本身是个线程循环，测不了
pub(crate) fn auto_bind_targets(
    discovered: &[Discovered],
    bound: &[String],
    ignored: &[String],
) -> Vec<Discovered> {
    discovered
        .iter()
        .filter(|c| !bound.contains(&c.id) && !ignored.contains(&c.id))
        .cloned()
        .collect()
}

/// 话题名：同一台第 2 个框起带编号。两个框都叫「甲机」是分不清的
fn topic_name(base: &str, n: usize) -> String {
    if n <= 1 {
        return base.to_string();
    }
    format!("{base} · 话题 {n}")
}

/// 同一台的对话框名字不能撞：前端按「设备名 · 月-日」起名，同一天再开一个必然
/// 重名，这里加 (2)、(3) 区分。只在同一台范围内比 —— 两台各自叫「甲机 · 10-25」
/// 与「乙机 · 10-25」本来就不会混
fn unique_name(taken: &[&str], want: &str) -> String {
    if !taken.contains(&want) {
        return want.to_string();
    }
    (2..=99)
        .find_map(|k| {
            let cand = format!("{want} ({k})");
            (!taken.contains(&cand.as_str())).then_some(cand)
        })
        // 连开 98 个同名框才会走到这里（实质上不可能）：至少得有个名字
        .unwrap_or_else(|| format!("{want} (99+)"))
}

/// 决定一条入向消息该落进哪个对话框（纯函数，「冒用」这条口径值得当面议）：
/// - 没带会话 ID（上一版根本没发这个头）或带的就是自己的设备 ID
///   → 这台的基础对话
/// - 带的 ID 本机已有且确实属于这台 → 就用它，同一个框在两边才对得上
/// - 带的 ID 本机已有但属于另一台 → 退回基础对话：不能拿别人的会话 ID 往别人框里塞消息
/// - 带的 ID 本机没有 → 认下来（对方先在那边开了这个话题，这边跟着有个框）
fn resolve_incoming(peer: &str, sid: &str, f: &SessionsFile) -> String {
    if peer.is_empty() {
        // 认不出谁发的（未标记）：不新建会话，那类历史进只读的虚拟行
        return String::new();
    }
    if sid.is_empty() || sid == peer {
        return peer.to_string();
    }
    match f.sessions.iter().find(|s| s.id == sid) {
        Some(s) if s.peer == peer => sid.to_string(),
        Some(_) => peer.to_string(),
        None => sid.to_string(),
    }
}

/// 首次从「单台绑定」跨到「多会话」时的一次性迁移：会话表是空的，但历史里
/// 出现过对端（或已登记了对端），就按每台各建一个会话，全部是**基础对话**
/// （id = 设备 ID）—— 老历史里那些没有 sid 的消息才能按 peer 归到自己那个框。
/// 读指针直接推到当下 —— 老历史本来就是已经看过的东西，否则第一次进来
/// 会凭空冒出一堆莫名未读。
fn migrate_sessions(f: &mut SessionsFile, peers: &HashMap<String, Peer>, history: &[String]) -> bool {
    if !f.sessions.is_empty() {
        return false;
    }
    // 保序去重：先已登记的对端（旧的单台绑定就在这），再补历史里露出过的对端
    let mut ids: Vec<String> = Vec::new();
    let kept = |id: &str| !id.is_empty() && !f.hidden.iter().any(|p| p == id);
    for id in peers.keys() {
        if kept(id) {
            ids.push(id.clone());
        }
    }
    ids.sort();
    for id in history {
        if kept(id) && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return false;
    }
    let now = store::now_ms();
    f.sessions = ids
        .iter()
        .map(|id| Session {
            // 基础对话：会话 ID 就用那台的设备 ID
            id: id.clone(),
            peer: id.clone(),
            name: peers.get(id).map(|p| p.display_name()).unwrap_or_default(),
            created: now,
            read: now,
        })
        .collect();
    f.active = f.sessions[0].id.clone();
    true
}

/// 发送目标：`to` 是**会话 ID**，不传就取当前会话（收藏视图「发给对端」走这条）。
/// 会话里带着所属那台，真正的地址从 peers 表拿 —— 一台有几个框都用同一个对端，只是落点不同。
/// 空 peer（未标记）从来不在会话表里，天然落进「没有这个会话」分支 ——
/// 它只用来查看历史，本来就不该能发东西
fn require_target(hub: &Hub, to: Option<&str>) -> Result<(Session, Peer), String> {
    let id = match to.filter(|s| !s.is_empty()) {
        Some(t) => t.to_string(),
        None => hub.active_snapshot(),
    };
    if id.is_empty() {
        return Err("还没选定聊天对象：请先在左侧开一个会话".into());
    }
    let sess = hub
        .session_by_id(&id)
        .ok_or_else(|| "这个会话已经不在了：先在左侧选一个聊天框".to_string())?;
    match hub.peer_by_id(&sess.peer) {
        None => Err("这台对端还没有添加：请先配对，或等它给你发一条消息".into()),
        Some(p) if !p.online => Err(format!("对端「{}」离线，稍后重试", p.display_name())),
        Some(p) => Ok((sess, p)),
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
    // 粘贴的图片要有个落点（与收件箱分开，免得混进“别人发来的东西”里）
    std::fs::create_dir_all(dir.join("pastebox")).map_err(|e| format!("创建粘贴暂存失败: {e}"))?;
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

/// 文字消息：同步等对端 2xx 才算「已送达」，所以放 blocking 线程里跑。
/// `to` 是目标**会话 ID**，不传就发给当前会话
#[tauri::command]
pub async fn send_text(
    hub: State<'_, Arc<Hub>>,
    text: String,
    to: Option<String>,
) -> Result<Message, String> {
    let hub = hub.inner().clone();
    if text.trim().is_empty() {
        return Err("内容为空".into());
    }
    if text.len() as u64 > store::MAX_BODY_BYTES {
        return Err("单条文字超过 1MB，请拆分后发送".into());
    }
    let (sess, peer) = require_target(&hub, to.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || client::send_text(&hub, &peer, &sess, text))
        .await
        .map_err(|e| format!("发送任务被中断: {e}"))?
}

#[tauri::command]
pub async fn send_paths(
    hub: State<'_, Arc<Hub>>,
    paths: Vec<String>,
    to: Option<String>,
) -> Result<Vec<Message>, String> {
    let hub = hub.inner().clone();
    if paths.is_empty() {
        return Err("没有要发送的文件".into());
    }
    let (sess, peer) = require_target(&hub, to.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || client::send_paths(&hub, &peer, &sess, paths))
        .await
        .map_err(|e| format!("发送任务被中断: {e}"))?
}

/// 从按时间排好的历史里切出一页 `[start, end)`。
/// `cursor` 是已展示的最老一条的下标（往前翻页的起点），None 表示从最新一条开始往前切。
/// 游标失效（气泡被删了）时也当成 None，宁可重给最新一页，也别回一堆空把界面卡住。
fn history_range(len: usize, cursor: Option<usize>, page: usize) -> (usize, usize) {
    let end = cursor.unwrap_or(len).min(len);
    (end.saturating_sub(page), end)
}

/// 拉历史。参数名故意用单个单词（不用 before_id）：Tauri 会把 Rust 的 snake_case
/// 参数映射成 JS 的 camelCase，少一层歧义少一个坑。
/// `before` 是已展示的最早一条的 id，不传就是「最新一页」。
/// `session` 是按对话框筛选（会话 ID）：不传 = 全部历史，传空串 = 「未标记」。
#[tauri::command]
pub fn msg_history(
    hub: State<'_, Arc<Hub>>,
    limit: Option<usize>,
    before: Option<String>,
    session: Option<String>,
) -> Vec<Message> {
    let all = hub.store.read_messages(usize::MAX);
    let page = limit.unwrap_or(HISTORY_PAGE).clamp(1, HISTORY_LIMIT);
    page_messages(all, session, before, page)
}

/// 先按对话框筛、再定位游标切页。
/// 反过来做（先切页再筛）会让每页凑不满，游标也会跳到别的框的历史上去。
/// `session`：None = 全部历史（收藏/全局列表用），Some("") = 「未标记」。
/// 老消息没有 sid，按 `Message::sid_of` 归到那台的基础对话，所以传设备 ID 也能拿到它们。
/// 游标用 id 而不是「已看条数」：中间来了新消息、或重复拉到同一条时都不会串页。
fn page_messages(
    all: Vec<Message>,
    session: Option<String>,
    before: Option<String>,
    page: usize,
) -> Vec<Message> {
    let list: Vec<Message> = match session {
        Some(s) => all.into_iter().filter(|m| m.sid_of() == s).collect(),
        None => all,
    };
    let cursor = before
        .as_deref()
        .and_then(|id| list.iter().position(|m| m.id == id));
    let (start, end) = history_range(list.len(), cursor, page);
    list[start..end].to_vec()
}

/// 会话列表：每个对话框的会话 ID、所属对端、显示名、未读数、最后一条摘要，
/// 加上所属那台的在线态与地址
#[tauri::command]
pub fn sessions(hub: State<'_, Arc<Hub>>) -> Value {
    hub.sessions_json()
}

/// 确保某台的基础对话在列表里（幂等：重复调用只会把它建出来，不会多出第二个框）
#[tauri::command]
pub fn session_create(hub: State<'_, Arc<Hub>>, peer: String, name: Option<String>) -> Value {
    hub.upsert_session(&peer, name.as_deref().unwrap_or(""));
    hub.sessions_json()
}

/// 在同一台设备上再开一个对话框并切过去。每调一次就多一个框（这是这轮新加的口径：
/// 会话 ID 不再等于设备 ID，所以同一台能有好几个各自独立的对话框）。
/// `name` 由发起方给（前端按「设备名 · 月-日」），不传则退回话题编号
#[tauri::command]
pub fn session_new(
    hub: State<'_, Arc<Hub>>,
    peer: String,
    name: Option<String>,
) -> Result<Value, String> {
    hub.new_session(&peer, name.as_deref().unwrap_or(""))?;
    Ok(hub.sessions_json())
}

/// 改会话显示名：只改本机这一份，不会同步给对端
#[tauri::command]
pub fn session_rename(hub: State<'_, Arc<Hub>>, id: String, name: String) -> Result<Value, String> {
    hub.rename_session(&id, &name)?;
    Ok(hub.sessions_json())
}

/// 切会话：设焦点 + 清未读，一次做完（前端不需要再单独调一次「标已读」）
#[tauri::command]
pub fn session_focus(hub: State<'_, Arc<Hub>>, id: String) -> Value {
    hub.focus_session(&id);
    hub.sessions_json()
}

/// 删会话：只删这一个对话框与它的读指针，历史与收件箱文件都不动。
/// 同一台的其它对话框不受影响
#[tauri::command]
pub fn session_delete(hub: State<'_, Arc<Hub>>, id: String) -> Result<Value, String> {
    hub.remove_session(&id)?;
    Ok(hub.sessions_json())
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

/// 「下载 / 另存为」：收到的东西本来就落在本机收件箱，这里只是把它复制到用户选的位置。
/// 单文件走保存对话框，目录走选目录 + 递归复制（跟微信的「另存为…」一致）。
/// 返回 None 表示用户取消了，不当作错误。
#[tauri::command]
pub async fn save_path_as(app: tauri::AppHandle, src: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let from = PathBuf::from(&src);
    let meta = std::fs::symlink_metadata(&from).map_err(|e| format!("读不到 {src}: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("符号链接不提供另存为".into());
    }
    let name = from
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("{src} 没有文件名"))?;

    let target = if meta.is_dir() {
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
        app.dialog()
            .file()
            .set_title(format!("把文件夹「{name}」复制到哪个目录"))
            .pick_folder(move |dir| {
                let _ = tx.send(dir);
            });
        let parent = rx
            .await
            .map_err(|e| format!("目录对话框异常: {e}"))?
            .and_then(|f| f.into_path().ok());
        match parent {
            // 原地另存为（选了自己）直接当作取消，不制造 xxx(1)
            Some(p) if p == from.parent().unwrap_or(&p) => return Ok(None),
            Some(p) => p.join(&name),
            None => return Ok(None),
        }
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
        app.dialog()
            .file()
            .set_title("另存为")
            .set_file_name(&name)
            .save_file(move |path| {
                let _ = tx.send(path);
            });
        match rx
            .await
            .map_err(|e| format!("保存对话框异常: {e}"))?
            .and_then(|f| f.into_path().ok())
        {
            // 存回原路径等于没动，不浪费一次整文件读写
            Some(p) if p == from => return Ok(None),
            Some(p) => p,
            None => return Ok(None),
        }
    };

    let out = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        if from.is_dir() {
            copy_tree(&from, &target)?;
        } else {
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p).map_err(|e| format!("创建 {} 失败: {e}", p.display()))?;
            }
            std::fs::copy(&from, &target)
                .map_err(|e| format!("复制到 {} 失败: {e}", target.display()))?;
        }
        Ok(target)
    })
    .await
    .map_err(|e| format!("复制任务被中断: {e}"))??;
    Ok(Some(out.to_string_lossy().to_string()))
}

/// 递归复制目录。拒符号链接，否则可能把目标目录外的文件也拖进来。
fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("创建 {} 失败: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("读 {} 失败: {e}", from.display()))? {
        let entry = entry.map_err(|e| format!("遍历 {} 失败: {e}", from.display()))?;
        let src = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| format!("取 {} 类型失败: {e}", src.display()))?;
        let dst = to.join(entry.file_name());
        if ft.is_symlink() {
            eprintln!("[net] 跳过符号链接: {}", src.display());
        } else if ft.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn 消息(id: &str, peer: &str, dir: &str, ts: i64) -> Message {
        Message {
            id: id.into(),
            dir: dir.into(),
            kind: "text".into(),
            text: Some(id.into()),
            name: None,
            size: None,
            path: None,
            state: "sent".into(),
            ts,
            peer: peer.into(),
            // 上一版的消息：没有会话 ID，按 sid_of 归到那台的基础对话
            sid: String::new(),
        }
    }

    /// 属于某个新话题框的消息（带了会话 ID）
    fn 话题消息(id: &str, peer: &str, sid: &str, dir: &str, ts: i64) -> Message {
        Message {
            sid: sid.into(),
            ..消息(id, peer, dir, ts)
        }
    }

    fn 对端(id: &str, name: &str) -> Peer {
        Peer {
            id: id.into(),
            name: name.into(),
            alias: String::new(),
            host: "127.0.0.1".into(),
            port: DEFAULT_PORT,
            online: true,
            last_seen: 0,
        }
    }

    /// 候选设备（还没通过 /ping 校验的那份）
    fn 候选(id: &str) -> Discovered {
        Discovered {
            id: id.into(),
            name: id.into(),
            host: "127.0.0.1".into(),
            port: DEFAULT_PORT,
            seen: 0,
        }
    }

    #[test]
    fn 心跳不会替用户把解绑过的设备绑回来() {
        let 全部 = vec![候选("a"), 候选("b"), 候选("c")];
        let 已绑 = vec!["a".to_string()];
        let 解绑过 = vec!["b".to_string()];
        let got: Vec<String> = auto_bind_targets(&全部, &已绑, &解绑过)
            .into_iter()
            .map(|d| d.id)
            .collect();
        // a 已经绑了不必再绑；b 是用户明确解绑过的，ping 得通也不能擅自绑回来
        assert_eq!(got, vec!["c"], "只有没绑过又没被解绑的才轮到自动登记");
        // 名单空着时行为与从前一致（新设备照常自动登记），不能把这条能力改没了
        let fresh: Vec<String> = auto_bind_targets(&全部, &[], &[])
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(fresh, vec!["a", "b", "c"]);
    }

    #[test]
    fn 备注名盖过对方报的设备名() {
        let mut p = 对端("peer1", "Mac");
        assert_eq!(p.display_name(), "Mac", "没备注时就是对方报的名");
        p.alias = "办公室那台".into();
        assert_eq!(p.display_name(), "办公室那台");
        // 会话行：自己没存过名字的基础对话跟着显示名走
        let mut map = HashMap::new();
        map.insert(p.id.clone(), p.clone());
        let row = session_row("peer1", "peer1", "", 0, true, &HashMap::new(), &map);
        assert_eq!(row["name"], "办公室那台", "备注改了会话栏不能还叫设备名");
        // 但用户手工改过名的框不能跟着动（存过的那份优先）
        let row = session_row("uuid9", "peer1", "打印问题", 0, true, &HashMap::new(), &map);
        assert_eq!(row["name"], "打印问题");
    }

    #[test]
    fn 改备注名只带上还叫旧名的框() {
        let mut ss = vec![
            Session { id: "peer1".into(), peer: "peer1".into(), name: "Mac".into(), created: 0, read: 0 },
            Session { id: "u2".into(), peer: "peer1".into(), name: "Mac · 10-25".into(), created: 0, read: 0 },
            Session { id: "u3".into(), peer: "peer1".into(), name: "报销单".into(), created: 0, read: 0 },
            // 别的那台的同名框不能被拖着一起改
            Session { id: "peer2".into(), peer: "other".into(), name: "Mac".into(), created: 0, read: 0 },
        ];
        assert!(rename_by_display(&mut ss, "peer1", "Mac", "办公室那台"));
        assert_eq!(ss[0].name, "办公室那台", "基础对话跟着备注名走");
        assert_eq!(ss[1].name, "Mac · 10-25", "按日期起的名不是设备名，不动");
        assert_eq!(ss[2].name, "报销单", "用户自己改的名不动");
        assert_eq!(ss[3].name, "Mac", "另一台的同名框不动");
        // 同一台已经有两个框叫新名：加编号，不能改出两个一模一样的
        assert!(rename_by_display(&mut ss, "peer1", "办公室那台", "报销单"));
        assert_eq!(ss[0].name, "报销单 (2)");
        // 旧名新名一样（备注没变）就什么都不做
        assert!(!rename_by_display(&mut ss, "peer1", "报销单 (2)", "报销单 (2)"));
        assert!(!rename_by_display(&mut ss, "nobody", "Mac", "X"), "这台根本没框");
    }

    #[test]
    fn 不传游标拿的是最新一页() {
        assert_eq!(history_range(26, None, 10), (16, 26));
        // 总数不到一页就全给，别回个空列表
        assert_eq!(history_range(3, None, 10), (0, 3));
        assert_eq!(history_range(0, None, 10), (0, 0));
    }

    #[test]
    fn 有游标就从游标往前切() {
        assert_eq!(history_range(26, Some(16), 10), (6, 16));
        // 已经翻到最老一条，再翻就是空页（前端据此收起「加载更早」）
        assert_eq!(history_range(26, Some(0), 10), (0, 0));
    }

    #[test]
    fn 游标越界当失效处理() {
        // 历史被清短了：越界的游标不能拿去切片，否则会 panic
        assert_eq!(history_range(5, Some(99), 10), (0, 5));
    }

    #[test]
    fn 筛会话在先每页才凑得满() {
        let 历史 = || {
            vec![
                消息("a1", "a", "in", 1),
                消息("b1", "b", "out", 2),
                消息("a2", "a", "in", 3),
                消息("b2", "b", "in", 4),
                消息("a3", "a", "in", 5),
            ]
        };
        // 先筛后切：一页两条都是 a 的。先切后筛的话这里只会拿到一条
        let got = page_messages(历史(), Some("a".into()), None, 2);
        assert_eq!(
            got.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["a2", "a3"]
        );
        // 游标是在筛后的列表里定位的
        let got = page_messages(历史(), Some("a".into()), Some("a2".into()), 2);
        assert_eq!(got.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["a1"]);
        // 不传会话就是全部历史（收藏视图的旧调用不能因为加了参数就少东西）
        assert_eq!(page_messages(历史(), None, None, 10).len(), 5);
    }

    #[test]
    fn 同一台的两个框各翻各的页() {
        // 基础对话（没 sid）与新话题（带 sid）同住一台设备 a，筛错一个字符就会串到对方那里
        let 历史 = || {
            vec![
                消息("基1", "a", "in", 1),
                话题消息("话1", "a", "u1", "in", 2),
                消息("基2", "a", "in", 3),
                话题消息("话2", "a", "u1", "out", 4),
            ]
        };
        let 基 = page_messages(历史(), Some("a".into()), None, 10);
        assert_eq!(基.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["基1", "基2"]);
        let 话 = page_messages(历史(), Some("u1".into()), None, 2);
        assert_eq!(话.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["话1", "话2"]);
        // 游标只在当前框的历史里定位：拿着话题框的游标去筛基础对话，
        // 它根本定位不到（只能当成失效游标重给最新一页），绝不会翻回话题框的旧页
        let 串 = page_messages(历史(), Some("a".into()), Some("话1".into()), 2);
        assert_eq!(串.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["基1", "基2"]);
        fn 读(ms: &[Message]) -> Vec<&str> {
            ms.iter().map(|m| m.sid_of()).collect()
        }
        assert_eq!(读(&基), vec!["a", "a"], "没 sid 的老消息归基础对话");
        assert_eq!(读(&话), vec!["u1", "u1"]);
    }

    #[test]
    fn 未标记会话拿的是空对端的历史() {
        let 历史 = || {
            vec![
                消息("a1", "a", "in", 1),
                消息("x1", "", "in", 2),
                消息("x2", "", "out", 3),
            ]
        };
        let got = page_messages(历史(), Some(String::new()), None, 10);
        assert_eq!(got.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["x1", "x2"]);
    }

    #[test]
    fn 未读只数对方发来且在读指针之后的() {
        let msgs = vec![
            消息("旧", "a", "in", 50),
            消息("新", "a", "in", 150),
            消息("自己发的", "a", "out", 200),
            消息("更新的", "a", "in", 250),
            消息("另一台", "b", "in", 300),
        ];
        let reads: HashMap<&str, i64> = [("a", 100i64)].into_iter().collect();
        let st = session_stats(&msgs, &reads);
        assert_eq!(st["a"].unread, 2, "已读过的那条不能算未读，自己发的也不能算");
        assert_eq!(st["a"].last, 250);
        assert_eq!(st["a"].summary, "更新的");
        // 读指针表里没有的会话（刚从历史里露出来的）当作一条都没读过
        assert_eq!(st["b"].unread, 1);
    }

    #[test]
    fn 未标记会话不在线也不挂未读() {
        let msgs = vec![消息("x", "", "in", 9)];
        let reads: HashMap<&str, i64> = HashMap::new();
        let stats = session_stats(&msgs, &reads);
        let peers: HashMap<String, Peer> = HashMap::new();
        let row = session_row("", "", "", 0, true, &stats, &peers);
        assert_eq!(row["name"], "未标记");
        assert_eq!(row["online"], false);
        assert_eq!(row["bound"], false, "没有地址就不能发，前端据此置灰");
        assert_eq!(row["unread"], 0, "查看用的虚拟会话不能挂常驻未读");
        assert_eq!(row["last"], 9, "但历史照旧得能排进去");
    }

    #[test]
    fn 只从历史露出来的行不挂未读() {
        // 删会话只删会话与读指针，历史一条不动；可这个框会从历史里被补回列表，
        // 此时没有读指针可依，当成「全没读过」就会让删一次多出几十个未读
        let msgs = vec![消息("一", "c", "in", 1), 消息("二", "c", "in", 2)];
        let stats = session_stats(&msgs, &HashMap::new());
        let peers = 映射(&[对端("c", "丙")]);
        assert_eq!(session_row("c", "c", "", 0, false, &stats, &peers)["unread"], 0);
        // 同样的数据在会话表里（正常新建的会话）就要报未读
        let reads: HashMap<&str, i64> = [("c", 0i64)].into_iter().collect();
        let 有指针 = session_stats(&msgs, &reads);
        assert_eq!(session_row("c", "c", "", 0, true, &有指针, &peers)["unread"], 2);
    }

    #[test]
    fn 同一台的几个框各自算未读但共用在线态() {
        let msgs = vec![
            消息("基1", "a", "in", 1),
            话题消息("话1", "a", "u1", "in", 2),
            话题消息("话2", "a", "u1", "in", 3),
        ];
        // 基础对话已经读到当下，新话题还没看过：两个框的未读必须是分开的
        let reads: HashMap<&str, i64> = [("a", 9i64), ("u1", 0i64)].into_iter().collect();
        let stats = session_stats(&msgs, &reads);
        let peers = 映射(&[对端("a", "甲")]);
        let 基 = session_row("a", "a", "甲", 0, true, &stats, &peers);
        let 话 = session_row("u1", "a", "甲 · 话题 2", 0, true, &stats, &peers);
        assert_eq!(基["unread"], 0, "基础对话读过了就不该挂未读");
        assert_eq!(话["unread"], 2, "新话题里的两条都没读过");
        // 能不能发只看所属那台：两个框的在线态与地址必须一样
        for 行 in [&基, &话] {
            assert_eq!(行["online"], true);
            assert_eq!(行["bound"], true);
            assert_eq!(行["host"], "127.0.0.1");
        }
        assert_eq!(基["id"], "a");
        assert_eq!(话["id"], "u1", "前端靠 id 认会话，id 与 peer 不再相同");
    }

    #[test]
    fn 落点判据与冒用退回() {
        let f = SessionsFile {
            sessions: vec![
                Session { id: "a".into(), peer: "a".into(), name: "甲".into(), created: 1, read: 0 },
                Session { id: "u1".into(), peer: "a".into(), name: "甲 · 话题 2".into(), created: 1, read: 0 },
            ],
            active: "a".into(),
            ..SessionsFile::default()
        };
        // 上一版根本没发 X-Session：落在这台的基础对话
        assert_eq!(resolve_incoming("a", "", &f), "a");
        assert_eq!(resolve_incoming("a", "a", &f), "a", "带的就是自己设备 ID 也算基础对话");
        // 本机已经认识这个框、且它确实属于 a → 就用它，两边同一个框
        assert_eq!(resolve_incoming("a", "u1", &f), "u1");
        // 对方报了一个本机没有的会话 ID：认下来（它先在自己那边开了话题）
        assert_eq!(resolve_incoming("a", "u9", &f), "u9");
        // 拿别人的会话 ID 往 a 的框里塞消息：退回到 a 的基础对话
        assert_eq!(resolve_incoming("b", "u1", &f), "b");
        // 认不出谁发的（未标记）不新建会话，也不弄丢那几条历史
        assert_eq!(resolve_incoming("", "u1", &f), "");
    }

    #[test]
    fn 同一台撞名会加序号() {
        // 前端按「设备名 · 月-日」起名，同一天再开一个必然重名
        let taken = ["甲机 · 10-25", "甲机"];
        assert_eq!(unique_name(&taken, "甲机 · 10-26"), "甲机 · 10-26", "不撞名就不动它");
        assert_eq!(unique_name(&taken, "甲机 · 10-25"), "甲机 · 10-25 (2)");
        // 三个框都开在今天：(2) 也被占了就往上找
        let taken3 = ["甲机 · 10-25", "甲机 · 10-25 (2)"];
        assert_eq!(unique_name(&taken3, "甲机 · 10-25"), "甲机 · 10-25 (3)");
        // 只比同一台：乙机那行叫同一个名字不该把甲机的新框推成 (2)
        let others = ["乙机 · 10-25"];
        assert_eq!(unique_name(&others, "甲机 · 10-25"), "甲机 · 10-25");
    }

    #[test]
    fn 话题编号从第二个框起() {
        assert_eq!(topic_name("甲机", 1), "甲机", "基础对话不配编号");
        assert_eq!(topic_name("甲机", 2), "甲机 · 话题 2");
        assert_eq!(topic_name("甲机", 7), "甲机 · 话题 7");
        // 那台还没登记过：露一截设备 ID 也比两个框都叫「甲机」分得清
        assert_eq!(topic_name(&session_name("a", "a", "", None), 2), "设备 a · 话题 2");
    }

    #[test]
    fn 名字拿不到时露出编号片段() {
        let peers: HashMap<String, Peer> =
            [("abcd1234efgh".to_string(), 对端("abcd1234efgh", "楼上的机器"))]
                .into_iter()
                .collect();
        let stats = session_stats(&[], &HashMap::new());
        // 登记过对端、且会话表里没存过名字 → 用它的设备名
        assert_eq!(
            session_row("abcd1234efgh", "abcd1234efgh", "", 0, true, &stats, &peers)["name"],
            "楼上的机器"
        );
        // 只从旧历史里露出来的设备没有名字可用，露一截 ID 也比「未知设备」分得清
        assert_eq!(
            session_row("zz11223344", "zz11223344", "", 0, false, &stats, &peers)["name"],
            "设备 zz112233"
        );
        // 会话表里存过名字就以它为准：重命名与对端上报都要能跟上
        assert_eq!(session_row("zz11223344", "zz11223344", "小李", 0, true, &stats, &peers)["name"], "小李");
        // 存的名字优先于设备名：用户把框改成「工作」后，对方改名不该把它打回去
        assert_eq!(
            session_row("abcd1234efgh", "abcd1234efgh", "工作", 0, true, &stats, &peers)["name"],
            "工作"
        );
        // 只知道会话 ID、连所属那台都认不出（手改过会话文件）：至少得有个不重复的名字
        assert_eq!(session_row("u1deadbeef00", "", "", 0, false, &stats, &peers)["name"], "会话 u1deadbe");
    }

    fn 映射(peers: &[Peer]) -> HashMap<String, Peer> {
        peers.iter().map(|p| (p.id.clone(), p.clone())).collect()
    }

    #[test]
    fn 首次启动按对端与历史各建一个基础对话() {
        let peers = 映射(&[对端("a", "甲"), 对端("b", "乙")]);
        // 历史里还有一台已经解绑的设备，和一台 peer 为空的旧消息
        let history = vec!["a".to_string(), "b".to_string(), "c".to_string(), String::new()];
        let mut f = SessionsFile::default();
        assert!(migrate_sessions(&mut f, &peers, &history));
        // 已登记的两台在前（按 id 排序），历史里露出的那台补在后头；空 peer 不建会话
        let ids: Vec<&str> = f.sessions.iter().map(|s| s.peer.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        // 迁移出来的都是基础对话：id = 设备 ID，老历史里没 sid 的那些才能归到它
        for s in &f.sessions {
            assert_eq!(s.id, s.peer, "迁移不另造 ID");
        }
        assert_eq!(f.active, "a", "旧的单台绑定就是当前会话");
        assert_eq!(f.sessions[0].name, "甲");
        // 老历史本来就算已经看过，不然第一次进来会冒出一堆莫名未读
        for s in &f.sessions {
            assert!(s.read >= s.created, "读指针推到当下");
        }
    }

    #[test]
    fn 会话表已有内容就不再迁移() {
        // 迁移只能发生一次：第二次进来会话表已经有东西了，把用户的未读推回当下会抹掉它
        let peers = 映射(&[对端("a", "甲")]);
        let mut f = SessionsFile {
            sessions: vec![Session {
                id: "a".into(),
                peer: "a".into(),
                name: "甲机".into(),
                created: 1,
                read: 7,
            }],
            active: String::new(),
            ..SessionsFile::default()
        };
        let before = f.clone();
        assert!(!migrate_sessions(&mut f, &peers, &["a".into(), "b".into()]));
        assert_eq!(f.sessions[0].read, before.sessions[0].read);
        assert_eq!(f.active, "");
    }

    #[test]
    fn 历史里没人知道的框要露出来但删过的不补() {
        let msgs = vec![
            消息("一", "a", "in", 1),
            话题消息("二", "b", "ub", "in", 2),
            消息("三", "", "in", 3),
        ];
        let stats = session_stats(&msgs, &HashMap::new());
        let mut f = SessionsFile {
            sessions: vec![Session { id: "a".into(), peer: "a".into(), name: "甲".into(), created: 1, read: 0 }],
            active: "a".into(),
            hidden: vec!["ub".into()],
        };
        // ub 被用户删过会话：历史还在也不该再冒出一行；空串（未标记）本来就不入
        // 会话表，靠这里露出来
        let mut got: Vec<&str> = orphan_sessions(&stats, &f);
        got.sort_unstable();
        assert_eq!(got, vec![""]);
        // 去掉 hidden 里的 ub，它就回来了（会话文件被手改过的场景）
        f.hidden.clear();
        let mut again: Vec<&str> = orphan_sessions(&stats, &f);
        again.sort_unstable();
        assert_eq!(again, vec!["", "ub"]);
        // 补出来的那一行得知道它属于哪台（前端据此判在线与能不能回）
        assert_eq!(stats["ub"].peer, "b");
    }

    #[test]
    fn 没有任何对端也没有历史就不动文件() {
        let mut f = SessionsFile::default();
        // 全新安装：一台都还没见过，不该凭空造会话出来（前端会看到一个空列表）
        assert!(!migrate_sessions(&mut f, &映射(&[]), &[]));
        // 只有空 peer 的旧消息也不建（进「未标记」虚拟会话看）
        assert!(!migrate_sessions(&mut f, &映射(&[]), &[String::new()]));
        assert!(f.sessions.is_empty());
    }
}
