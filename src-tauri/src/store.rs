//! 本地存储与通用工具：设备身份、对端绑定、消息历史、收藏树、查看历史。
//!
//! 全部落在 `app_data_dir` 下，不跨设备同步（设计已确认）。
//! 字段命名一律 snake_case，与前端读法保持一致 —— 不加任何 serde rename_all，
//! 这是之前 `data_url` / `dataUrl` 撞车导致静默 undefined 的教训。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub const MAX_BODY_BYTES: u64 = 1024 * 1024; // /msg 上限 1MB
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024; // /file 上限 8GB
pub const SIG_WINDOW_MS: i64 = 300 * 1000; // 时间窗 ±300 秒

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex_lower(&h.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 边写边算 sha256，用于接收文件时一次遍历同时完成落盘与校验。
pub struct HashWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    written: u64,
}

impl<W: Write> HashWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            written: 0,
        }
    }
    pub fn written(&self) -> u64 {
        self.written
    }
    pub fn finish(self) -> (String, u64) {
        (hex_lower(&self.hasher.finalize()), self.written)
    }
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// 原子写：先写同目录临时文件再 rename，避免中途崩溃留下半截 JSON。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} 没有父目录", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "data".into()),
        now_ms()
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件 {} 失败: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("重命名 {} -> {} 失败: {e}", tmp.display(), path.display()))
}

/// 校验并拼接对端送来的相对路径。只允许 Normal 组件，
/// 绝对路径、盘符、`..`、`.` 一律拒绝（防目录穿越）。
pub fn safe_rel_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let normalized = rel.replace('\\', "/");
    if normalized.is_empty() {
        return Err("相对路径为空".into());
    }
    let mut out = base.to_path_buf();
    let mut parts = 0usize;
    for c in Path::new(&normalized).components() {
        match c {
            Component::Normal(name) => {
                out.push(name);
                parts += 1;
            }
            other => return Err(format!("相对路径含非法组件 {:?}: {}", other, rel)),
        }
    }
    if parts == 0 || out == base {
        return Err(format!("相对路径解析后为空: {}", rel));
    }
    Ok(out)
}

/// HTTP 头值只允许 ASCII（tiny_http 的 Header.value 就是 AsciiString），
/// 而中文文件名必须能传，所以 X-Name / X-Rel-Path 统一 base64。
/// 两端都是本应用自己写，所以不需要兼容裸文本形式：解不开就是坏了。
pub fn hdr_encode(s: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(s.as_bytes())
}

pub fn hdr_decode(s: &str) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.decode(s).ok().map(|v| String::from_utf8_lossy(&v).to_string())
}

/* --------------------------------------------------------------------------
 * 设备与对端
 * ------------------------------------------------------------------------ */

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub secret: String,
    pub name: String,
    /// 配对口令，两台填一样才互认
    #[serde(default)]
    pub passphrase: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Peer {
    pub id: String,
    /// 对方自己上报的设备名，每次 /ping 都会带回来
    pub name: String,
    /// 本机给它起的备注名（跟微信那个「设置备注和标签」一个意思）。空串表示没有备注，
    /// 于是界面退回用 `name`。只存本机、绝不上线：对端那份名字归它自己维护。
    /// 加了 `#[serde(default)]`，老 peers.json 少这个字段照样读
    #[serde(default)]
    pub alias: String,
    pub host: String,
    pub port: u16,
    /// 最近一次 /ping 是否成功
    pub online: bool,
    pub last_seen: i64,
}

impl Peer {
    /// 界面上到底叫哪个：有备注就一律用备注，没备注才用对方报的名。
    /// 会话默认名、会话栏、候选列表、顶栏都得走这一条，否则同一台会出现两个名字
    pub fn display_name(&self) -> String {
        let a = self.alias.trim();
        if !a.is_empty() {
            return a.to_string();
        }
        let n = self.name.trim();
        if !n.is_empty() {
            return n.to_string();
        }
        format!("设备 {}", &self.id.chars().take(8).collect::<String>())
    }
}

/// peers.json 的整体结构。以前磁盘上只有 `peers` 一个数组，读的时候靠一个私有
/// 临时结构兜住；现在要多存一份「解绑名单」，就提成公开的了
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct PeersFile {
    pub peers: Vec<Peer>,
    /// 用户主动解绑过的设备 ID：mDNS 还会把它们发现、心跳还会 ping 通它们，
    /// 没有这份名单的话「解绑」只撑一秒 —— 下一拍心跳就自动把同一台又登记回来
    #[serde(default)]
    pub ignored: Vec<String>,
}

/// 一个对话框。
///
/// `id` 是会话主键，前端与线上（`X-Session` 头）都只认它：
/// - 一台对端的**基础对话**直接用对端设备 ID 当 id。老历史里那些没有 `sid` 的消息
///   因此天然归到它名下，不需要改写 messages.jsonl（见 `Message::sid_of`）
/// - 同一台后来再开的对话用另造的 UUID，由发起方生成、随消息带过去，两边落在同一个框
///
/// 所以「同一台可以有多个框，但同一个框在两边是同一个」由 id 的传递保证。
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    /// 会话 ID：基础对话 = 对端设备 ID，新话题 = UUID。空串只出现在「未标记」那一行
    #[serde(default)]
    pub id: String,
    /// 所属对端设备 ID；空串是「未标记」虚拟会话（老历史里 peer 缺失的那些）
    pub peer: String,
    /// 会话显示名：建的时候定下，之后各改各的（用户可以重命名，对端改名不再覆盖它）
    pub name: String,
    pub created: i64,
    /// 本机读到哪了：未读数 = 该会话里比它新的入向消息条数
    pub read: i64,
    /// 置顶：列表里永远排在最前（微信那套）。只认本机，不同步给对端
    #[serde(default)]
    pub pinned: bool,
}

/// sessions.json 的整体结构
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct SessionsFile {
    pub sessions: Vec<Session>,
    /// 当前在聊的那个对话框的会话 ID。只是界面焦点，**不是**发送目标（目标由命令参数给）
    pub active: String,
    /// 被删过会话、但历史里还留着消息的会话 ID：列表不再把它们从历史里补回来，
    /// 否则「删除」点了等于没点。对方在那个框里再发一条过来就自动出这个名单（历史本来就还在）
    #[serde(default)]
    pub hidden: Vec<String>,
}

impl SessionsFile {
    /// 把上一版「会话 = 设备 ID」留下的文件补出现在的主键：那一版没有 id 字段，
    /// 而它的会话正好就是一台的基础对话，所以 id 直接用 peer。
    /// `active` 与 `hidden` 里存的是设备 ID，而基础对话的 id 恰好等于它 —— 不用跟着改。
    /// 幂等，读文件时每次都过一遍（也顺手挡住手改进来的空 id 行：那种行会把所有会话混成一个）
    pub fn normalize(&mut self) {
        for s in &mut self.sessions {
            if s.id.is_empty() {
                s.id = s.peer.clone();
            }
        }
        // 「未标记」从来不入会话表（它没有读指针也不能发），空 id 的行只能丢
        self.sessions.retain(|s| !s.id.is_empty());
    }
}

/// 请求签名：sha256(口令|设备ID|时间戳|摘要)。
/// 摘要对 /file 取文件 sha256，其余取请求体 sha256。
/// 两端都是自研实现，这里防的是局域网误连，不追求标准 HMAC 语义。
pub fn sign(passphrase: &str, device_id: &str, ts: i64, digest: &str) -> String {
    sha256_hex(format!("{passphrase}|{device_id}|{ts}|{digest}").as_bytes())
}

pub fn verify_sig(passphrase: &str, device_id: &str, ts: i64, digest: &str, sig: &str) -> bool {
    if ts.abs_diff(now_ms()) as i64 > SIG_WINDOW_MS {
        return false;
    }
    // 定长摘要比对，避免提前返回带来的时序差异
    constant_eq(sign(passphrase, device_id, ts, digest).as_bytes(), sig.as_bytes())
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/* --------------------------------------------------------------------------
 * 消息与收藏
 * ------------------------------------------------------------------------ */

#[derive(Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    /// "in" | "out"
    pub dir: String,
    /// "text" | "file" | "folder" | "system"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// "queued" | "sending" | "sent" | "failed"
    pub state: String,
    pub ts: i64,
    /// 对端设备 ID：这条消息是谁发的（取自签过名的 X-Device，伪造不了）
    #[serde(default)]
    pub peer: String,
    /// 归属的会话 ID。空 = 这台的基础对话（等价于 sid == peer）；
    /// 上一版根本没有这个字段，所以老历史只能按 `peer` 归到基础对话，不做猜测式改写
    #[serde(default)]
    pub sid: String,
    /// 这条待发消息**连续**补发失败了几次（`state == "queued"` 才有意义）。
    /// 计数必须落盘：只在内存里记的话，重启一次计数就归零，
    /// 那个一直发不出去的大文件夹会永远重试下去。
    #[serde(default)]
    pub retry: u32,
    /// 最后一次失败的原因，气泡悬停时原样给用户看
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 发送方把这条撤回了（只有发出去一分钟内的能撤）。两边都只当它是一句
    /// 「撤回了一条消息」，正文不再显示。走的还是「同 ID 再追一行」那套追加式做法，
    /// 所以老文件里没这个字段就是没撤回过
    #[serde(default)]
    pub recalled: bool,
    /// 本机把这一条删了：读取时直接过滤掉，所以界面上再也看不见，
    /// 而**对端那份完全不动**（这也是它和「撤回」的区别）
    #[serde(default)]
    pub hidden: bool,
    /// 引用回复：这条消息引用了另一条（发送那一刻的快照，见 `Quote`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<Quote>,
}

/// 引用回复挂在气泡顶部的那张小卡片。存的是**被引那一刻的快照**（摘录 / 显示名 /
/// 类型与文件名）而不是只存个 id：原文可能后来被撤回、被本机删掉、甚至还在
/// 没铺出来的历史页里，快照让卡片渲染永远不用二次查盘。
/// 老对端/老文件没这个字段：serde 默认忽略未知字段、缺失字段兜底成 None，
/// 引用在老对端上会降级成普通文字（不报错），所以不需要协议版本号闸门
#[derive(Clone, Serialize, Deserialize)]
pub struct Quote {
    /// 被引那条的 id：点卡片滚过去定位用它
    pub id: String,
    /// 被引人的显示名（发送当时算好的，不是 id：改名后老卡片不该跟着变）
    #[serde(default)]
    pub from: String,
    /// 原文摘录（超 120 字符发送时就截断加省略号；引文件时存的是文件名）
    #[serde(default)]
    pub text: String,
    /// 被引消息的类型：text / file / folder
    #[serde(default)]
    pub kind: String,
    /// 被引文件的文件名（kind != file/folder 时没有）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// 新增字段全靠这里兜底：构造点写 `..Default::default()`，
/// 不用再回去改十几处 `Message { .. }`
impl Default for Message {
    fn default() -> Self {
        Self {
            id: String::new(),
            dir: "out".into(),
            kind: "text".into(),
            text: None,
            name: None,
            size: None,
            path: None,
            state: "sent".into(),
            ts: 0,
            peer: String::new(),
            sid: String::new(),
            retry: 0,
            reason: None,
            recalled: false,
            hidden: false,
            quote: None,
        }
    }
}

impl Message {
    /// 这条消息落在哪个对话框。老消息没有 sid，那类就归到发送方那台的基础对话
    /// （基础对话的 id 恰好是设备 ID，所以不需要往 messages.jsonl 里补字段）
    pub fn sid_of(&self) -> &str {
        if self.sid.is_empty() {
            &self.peer
        } else {
            &self.sid
        }
    }

    /// 这条已经落到对端了吗？只有 sent 才算：撤回得真去通知对方，
    /// 而还没送达的那条（queued/sending/failed）本机把它撤掉就够了 ——
    /// 对方根本没见过它，队列里出队即可，发出去的只是一次注定失败的请求
    pub fn delivered(&self) -> bool {
        self.state == "sent"
    }
}

/// 能撤回的时间窗：发出去超过这个时限就不再给撤回入口。
/// 只在这一份里写数，命令与界面提示都读它（改这里，两处的文案都得跟着改）
pub const RECALL_WINDOW_MS: i64 = 60_000;

/// 这条能不能撤回，判据只写这一份（撤回命令与单测都走它）。
/// 界面把入口按时间收起来只是手感，真正的拦必须在这里：
/// 气泡可能开了几分钟没重画，前端那个入口还在，点了就归这里说了算。
/// Err 里的文案直接给用户看，所以每一条都说清「为什么不行」
pub fn recall_check(m: &Message, now: i64) -> Result<(), String> {
    if m.dir != "out" {
        return Err("只能撤回自己发出去的消息".into());
    }
    if m.recalled {
        return Err("这条已经撤回了".into());
    }
    // ts 是本机落库那一刻的 now_ms，不掺对端时钟，直接相减就是用户等了多久
    if now - m.ts >= RECALL_WINDOW_MS {
        return Err("超过 1 分钟就不能撤回了".into());
    }
    Ok(())
}

/// JSONL 去重：同一个 id 以最后写的那一行为准，但**保持首次出现的顺序** ——
/// 前端按这个顺序铺气泡，改状态不能让一条消息跳到列表末尾。
/// 坏行只跳过这一行，不让整份历史读不出来。
fn dedup_lines(txt: &str) -> Vec<Message> {
    let mut order: Vec<String> = Vec::new();
    let mut latest: std::collections::HashMap<String, Message> = std::collections::HashMap::new();
    for line in txt.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(msg) = serde_json::from_str::<Message>(line) else {
            continue;
        };
        if !latest.contains_key(&msg.id) {
            order.push(msg.id.clone());
        }
        latest.insert(msg.id.clone(), msg);
    }
    order
        .into_iter()
        .filter_map(|id| latest.remove(&id))
        .collect()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FavNode {
    pub id: String,
    pub parent: Option<String>,
    /// "cat" 分类节点 | "fav" 收藏条目
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub created: i64,
    pub updated: i64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct FavFile {
    pub nodes: Vec<FavNode>,
}

/// 节点自身所在层级（顶层为 1）。id 不存在时返回 0，便于调用方判错。
pub fn fav_depth(nodes: &[FavNode], id: &str) -> usize {
    let cur = match nodes.iter().find(|n| n.id == id) {
        Some(n) => (1usize, n.parent.clone()),
        None => return 0,
    };
    let (mut depth, mut parent) = cur;
    while let Some(p) = parent {
        depth += 1;
        if depth > 8 {
            break; // 数据被手改出环时的保险
        }
        parent = nodes.iter().find(|n| n.id == p).and_then(|n| n.parent.clone());
    }
    depth
}

/* --------------------------------------------------------------------------
 * 界面偏好（prefs.json）
 * ------------------------------------------------------------------------ */

/// 用户选的默认值：布局与 1:1 这些是工具栏上的即时开关，每次改动顺手落盘，
/// 下次启动就是它 —— 所以这里只有几项，不做会话快照。
///
/// 后两项属于传输视图的「本机接收」，存在同一份 prefs.json 里：读写通路
/// （`set_prefs` 的局部更新 + normalize + 原子写）是现成的，为两个字段再开
/// 第三份配置文件与第三套 CRUD 不值得。代价是两个抽屉共享一份数据，
/// 靠「只传自己关心的字段」互不覆盖。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preferences {
    /// 布局："1" 单图浏览 / "2" 两图并排 / "4" 四图 2×2
    #[serde(default)]
    pub layout: String,
    /// 缩放平移是否同步
    #[serde(default = "default_sync")]
    pub sync: bool,
    /// 滚轮行为："zoom" | "pan"
    #[serde(default = "default_wheel")]
    pub wheel: String,
    /// 收到对端消息时是否响一声
    #[serde(default = "default_notify")]
    pub notify: bool,
    /// 收件目录，空串 = 用 `<数据目录>/inbox`。存绝对路径原文（不 canonicalize，
    /// 免得把一个合法的软链目录换成它指向的地方，用户看到的路径就变了）
    #[serde(default)]
    pub inbox: String,
    /// 收件目录内部怎么摆："day" 一天一个文件夹（2026-10-27）/ "month" 一个月一个
    /// （2026-10）/ "flat" 全铺在根上。老 prefs.json 没这一项，读时由 normalize 补成
    /// `INBOX_LAYOUT_DEFAULT`——所以升级上来就是按天分，不需要用户再点一次
    #[serde(default)]
    pub inbox_layout: String,
    /// 在线探测的心跳节拍（毫秒）。同样只允许 `HEARTBEAT_OPTIONS` 里那几档，
    /// 老 prefs.json 没这一项时补 `HEARTBEAT_DEFAULT`（= 改这功能之前的写死值）
    #[serde(default = "default_heartbeat")]
    pub heartbeat_ms: u64,
    /// 图片归类的方案列表（`sort::SortPlan` 的 JSON 原文）。存成 `Value` 而非强类型：
    /// 这一层只管「整份读出/写回」，不解释规则结构，规则形态还在长（EXIF、分辨率
    /// 都还没接）——存原文就不会因为 SortRule 加字段而让老配置读不出来。
    /// 老 prefs.json 没这一项时 `#[serde(default)]` 补成空表，不报错
    #[serde(default)]
    pub sort_plans: Vec<serde_json::Value>,
}

fn default_sync() -> bool {
    true
}

fn default_wheel() -> String {
    "zoom".into()
}

fn default_notify() -> bool {
    true
}

/// 收件箱内部的摆放方式（prefs.json 的 `inbox_layout`）
pub const INBOX_LAYOUTS: [&str; 3] = ["day", "month", "flat"];
/// 出厂：一天一个文件夹。按天分的层次最浅、找“昨天那批”最快；量大的时候
/// 还能在界面上切成按月，不必因为出厂值不好用就去翻 prefs.json
pub const INBOX_LAYOUT_DEFAULT: &str = "day";

/// 心跳节拍的白名单（毫秒）。做成离散四档而不是任意数字：一个手滑填进去的
/// 10 毫秒会把局域网变成 ping 洪水，而“离线 = 连续 3 拍失败”这个口径也会
/// 跟着变成 30 毫秒的抖动误判——白名单让前端根本拿不出这种值
pub const HEARTBEAT_OPTIONS: [u64; 4] = [1000, 2000, 5000, 10000];
/// 出厂节拍，与这功能可配之前写死的那个值一致：升级上来行为不变
pub const HEARTBEAT_DEFAULT: u64 = 1000;

fn default_heartbeat() -> u64 {
    HEARTBEAT_DEFAULT
}

impl Default for Preferences {
    /// 出厂态就是前端 HTML 里写死的那一份（两图 + 同步开 + 滚轮缩放 + 响一声 +
    /// 默认收件目录），两边不一致会让「读到空」与「读到默认」表现出差别，没必要
    fn default() -> Self {
        Self {
            layout: "2".into(),
            sync: true,
            wheel: default_wheel(),
            notify: default_notify(),
            inbox: String::new(),
            inbox_layout: INBOX_LAYOUT_DEFAULT.into(),
            heartbeat_ms: HEARTBEAT_DEFAULT,
            sort_plans: Vec::new(),
        }
    }
}

impl Preferences {
    /// 脏值一律退回默认，跟 `SessionsFile::normalize` 一个路子：
    /// 手改坏的 prefs.json 不能让界面进入一个前端不认的布局（那种布局没有 CSS，
    /// 表现是「四个窗都不显示」，比退回两图难查得多）
    pub fn normalize(&mut self) {
        if !matches!(self.layout.as_str(), "1" | "2" | "4") {
            self.layout = Preferences::default().layout;
        }
        if self.wheel != "zoom" && self.wheel != "pan" {
            self.wheel = default_wheel();
        }
        // 相对路径必须丢掉：它会被当成相对于**进程当前目录**去建，而那个目录
        // 从 Finder 双击启动和从 cargo 启动完全不是一个地方，落盘点位变得不可预期。
        // 这里只能静默回默认（读取路径上没有可报错的出口），拦下脏值靠 set_prefs
        if !self.inbox.is_empty() && !Path::new(&self.inbox).is_absolute() {
            self.inbox.clear();
        }
        // 空串（老版本写的 prefs.json）与手改坏的都补回出厂口径：留一个前端
        // 不认的值会让落盘规则静默退化成「不分目录」，而界面还显示着「按天」
        if !INBOX_LAYOUTS.contains(&self.inbox_layout.as_str()) {
            self.inbox_layout = INBOX_LAYOUT_DEFAULT.into();
        }
        // 节拍同理：白名单外的值（手改成 0 会把这个线程变成空转烤 CPU）退回出厂档。
        // 设在这儿的值是「读到的」口径，set_prefs 那边还有一份显式拒绝
        if !HEARTBEAT_OPTIONS.contains(&self.heartbeat_ms) {
            self.heartbeat_ms = HEARTBEAT_DEFAULT;
        }
    }
}

/* --------------------------------------------------------------------------
 * 查看历史（history.json）
 * ------------------------------------------------------------------------ */

/// 历史最多留多少条。侧栏是一次全渲染的（行很轻，小图靠观察名单只解可见那十几张），
/// 这个上限是防膨胀与防「翻不到头」，不是性能阈值。
pub const HISTORY_MAX: usize = 100;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryItem {
    /// 图片的绝对路径原文（不 canonicalize，跟 `Preferences::inbox` 同一个口径：
    /// 把一个合法的软链换成它指向的地方，用户看到的路径就变了）
    pub path: String,
    /// 最后一次查看的时刻（毫秒）。同一张只留一条，重复查看只刷新它并置顶
    pub seen: i64,
}

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct HistoryFile {
    pub items: Vec<HistoryItem>,
}

impl HistoryFile {
    /// 读时清脏，跟 `Preferences::normalize` 一个路子：手改坏的历史不能让侧栏
    /// 出现一排点不动的空行，也不能因为一条脏数据把整份列表丢掉。
    /// - 丢弃空 path 与非绝对路径（相对路径会相对于进程当前目录，不可预期）
    /// - 按 path 去重，留 `seen` 更大的那条
    /// - 按 seen 降序（新的在前）并截断到 `HISTORY_MAX`
    /// - `seen <= 0` 补当前时间（手改成 0 也不致于排到最末尾去）
    pub fn normalize(&mut self) {
        // 100 条量级下不引 HashMap：双层循环最坏一万次比较，比多一个 import 与分配更便宜
        let mut kept: Vec<HistoryItem> = Vec::with_capacity(self.items.len());
        for it in self.items.drain(..) {
            if it.path.is_empty() || !Path::new(&it.path).is_absolute() {
                continue;
            }
            let seen = if it.seen > 0 { it.seen } else { now_ms() };
            match kept.iter_mut().find(|k| k.path == it.path) {
                Some(k) => {
                    if seen > k.seen {
                        k.seen = seen;
                    }
                }
                None => kept.push(HistoryItem { path: it.path, seen }),
            }
        }
        // 同一毫秒内记了两张时按路径定序：否则上游顺序稍有差别就会让
        // 行号每次读出来都跳，看起来像随机重排
        kept.sort_by(|a, b| b.seen.cmp(&a.seen).then_with(|| a.path.cmp(&b.path)));
        kept.truncate(HISTORY_MAX);
        self.items = kept;
    }

    /// 记一次查看：已有同路径就拎到最前并刷新 `seen`，没有就插到最前，最后截断。
    /// 与 `normalize` 共用「新的在前」这一份口径，不在调用方各写一遍。
    ///
    /// 前提是 `items` 已经「新的在前」（截断砍的是末尾）—— 所有调用方拿到的列表
    /// 都出自 `Store::load_history`，那份已经 normalize 过，这里不再重排一次。
    pub fn record(&mut self, path: &str, seen: i64) {
        if let Some(i) = self.items.iter().position(|it| it.path == path) {
            self.items.remove(i);
        }
        // 同一毫秒里连记两条时（一次粘贴进来好几张、自动化跑一轮），normalize 会
        // 把并列的那两条按路径重排，看上去像随机换位。顶到队首时刻 +1 保证
        // 「后看的在前」在毫秒粒度内也成立
        let floor = self.items.first().map(|it| it.seen).unwrap_or(0);
        let seen = if seen > floor { seen } else { floor + 1 };
        self.items.insert(0, HistoryItem { path: path.to_string(), seen });
        self.items.truncate(HISTORY_MAX);
    }

    /// 原地把一批「旧路径 → 新路径」换掉，只改 path 不动 seen（不置顶、不重排）。
    ///
    /// 图片归类把文件移动后，查看历史里那些旧路径就会指空。这里把它们就地换成新路径：
    /// 换完仍按新路径去重（如果同一张既在历史里、新路径也已在历史里，留 seen 大的那条并
    /// 保持原来的位置顺序，避免历史里多出重复行）。归类不改变「看过」这个事实，
    /// 所以不该因为移动就把它顶到最前 —— 那是「又看了一次」才有的待遇。
    pub fn rename_paths(&mut self, pairs: &[(String, String)]) {
        if pairs.is_empty() {
            return;
        }
        for it in self.items.iter_mut() {
            if let Some((_, to)) = pairs.iter().find(|(from, _)| *from == it.path) {
                it.path = to.clone();
            }
        }
        // 换完可能与已有的新路径重复（那张图本来就在历史里、又被移到了那个位置）：
        // 按 path 去重，留 seen 大的那条，位置保持既有顺序（第一个出现处）
        let mut seen_map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for it in &self.items {
            let e = seen_map.entry(it.path.clone()).or_insert(0);
            if it.seen > *e {
                *e = it.seen;
            }
        }
        let mut done: std::collections::HashSet<String> = std::collections::HashSet::new();
        self.items.retain(|it| {
            if done.contains(&it.path) {
                false
            } else {
                done.insert(it.path.clone());
                true
            }
        });
        // 去重后回填可能的更大 seen（同名两条留大值那条的时刻）
        for it in self.items.iter_mut() {
            if let Some(s) = seen_map.get(&it.path) {
                it.seen = (*s).max(it.seen);
            }
        }
    }
}

/* --------------------------------------------------------------------------
 * 存储统计的公共脚手架
 *
 * 递归统计一律用 symlink_metadata（logical size）：既不跟随符号链接（收件目录
 * 被人软链到另一块盘时不会把那一盘的东西也算进来），也不会把 iCloud / OneDrive
 * 的占位文件唤下来 —— 为了报一个数字而触发一次真下载，比数字不准严重得多
 * ------------------------------------------------------------------------ */

/// 一处目录递归下去的（总字节, 文件个数）。目录不存在就是 (0, 0)
fn walk_sizes(root: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            let md = match fs::symlink_metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                stack.push(p);
            } else {
                bytes += md.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// 这个目录里（递归）是不是藏着一个还被聊天记录指着的路径
fn dir_has_kept(root: &Path, kept: &HashSet<PathBuf>) -> bool {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if kept.contains(&p) {
                return true;
            }
            if p.is_dir() {
                stack.push(p);
            }
        }
    }
    false
}

/// 设置抽屉「存储」一节那几个数字。键名就是前端读的那些（下划线，
/// 与 `get_prefs` 同一口径：只有调用参数才走 Tauri 的 camelCase）
#[derive(Debug, Clone, Serialize)]
pub struct StorageStats {
    pub inbox_bytes: u64,
    pub inbox_count: u64,
    pub pastebox_bytes: u64,
    pub data_bytes: u64,
    pub messages_bytes: u64,
    pub messages_count: usize,
}

/* --------------------------------------------------------------------------
 * Store：所有本地读写走这里
 * ------------------------------------------------------------------------ */

pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// 收到东西落在哪。每次落盘会多读一遍 prefs.json（不到 1KB，比同一次的
    /// sha256 便宜几个数量级），换来「改了目录立刻生效」——不加缓存，
    /// 缓存要么动 `Store` 的无状态形态，要么让设置看起来没生效。
    pub fn inbox_dir(&self) -> PathBuf {
        let d = self.load_prefs().inbox;
        if d.is_empty() {
            self.dir.join("inbox")
        } else {
            PathBuf::from(d)
        }
    }

    /// 这一批新收到的具体落在哪一级：`inbox_dir()` 是根，这里再按 `inbox_layout`
    /// 拼上日期子目录（flat 时两者是同一个地方）。
    ///
    /// 用**本地**日期而不是 UTC：用户本地晚上 8 点收的文件却出现在“明天”那个
    /// 文件夹里，比不分目录还难解释。跨零点那一瞬间落进哪一天都不算错，因此
    /// 这里取的是收完那一刻（而不是开传那一刻）的时间。
    pub fn inbox_delivery_dir(&self) -> PathBuf {
        let p = self.load_prefs();
        let root = if p.inbox.is_empty() {
            self.dir.join("inbox")
        } else {
            PathBuf::from(&p.inbox)
        };
        let stamp = match p.inbox_layout.as_str() {
            "month" => Some("%Y-%m"),
            "day" => Some("%Y-%m-%d"),
            _ => None,
        };
        match stamp {
            Some(f) => root.join(chrono::Local::now().format(f).to_string()),
            None => root,
        }
    }

    /// 粘贴进来的图片/位图落在这里（它们本来没有“原文件”，必须造一个）。
    /// 和 inbox 一样只增不删：聊天记录里的 path 指着它，自动清掉会让
    /// 历史气泡的预览、另存为、复制同时失效。
    pub fn pastebox_dir(&self) -> PathBuf {
        self.dir.join("pastebox")
    }

    /* ---- device ---- */

    pub fn load_or_create_device(&self) -> Result<Device, String> {
        let path = self.file("device.json");
        if let Ok(txt) = fs::read_to_string(&path) {
            if let Ok(d) = serde_json::from_str::<Device>(&txt) {
                return Ok(d);
            }
        }
        let name = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "未命名设备".into());
        let d = Device {
            id: uuid::Uuid::new_v4().simple().to_string(),
            secret: uuid::Uuid::new_v4().simple().to_string()
                + &uuid::Uuid::new_v4().simple().to_string(),
            name,
            passphrase: String::new(),
        };
        self.save_device(&d)?;
        Ok(d)
    }

    pub fn save_device(&self, d: &Device) -> Result<(), String> {
        atomic_write(
            &self.file("device.json"),
            serde_json::to_vec_pretty(d)
                .map_err(|e| format!("序列化设备信息失败: {e}"))?
                .as_slice(),
        )
    }

    /* ---- peers：同时存多台，外加一份解绑名单 ---- */

    pub fn load_peers(&self) -> PeersFile {
        let Ok(txt) = fs::read_to_string(self.file("peers.json")) else {
            return PeersFile::default();
        };
        // 老版本只写一个元素，读进来就是一长度的 Vec，无需任何迁移；
        // 老版本也没有 ignored 字段，靠 #[serde(default)] 兜住
        serde_json::from_str::<PeersFile>(&txt).unwrap_or_default()
    }

    /// 整体回写。所有增删改都走这一条，免得出现「写了新的抹了旧的」
    pub fn save_peers(&self, f: &PeersFile) -> Result<(), String> {
        atomic_write(
            &self.file("peers.json"),
            serde_json::to_vec_pretty(f)
                .map_err(|e| format!("序列化对端失败: {e}"))?
                .as_slice(),
        )
    }

    /* ---- sessions：一个对端一个聊天框 ---- */

    /// 没这份文件就回空结构（首启动与旧版本都是这个状态，迁移在 Hub::new 里做）
    pub fn load_sessions(&self) -> SessionsFile {
        let mut f = fs::read_to_string(self.file("sessions.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<SessionsFile>(&t).ok())
            .unwrap_or_default();
        f.normalize();
        f
    }

    pub fn save_sessions(&self, f: &SessionsFile) -> Result<(), String> {
        atomic_write(
            &self.file("sessions.json"),
            serde_json::to_vec_pretty(f)
                .map_err(|e| format!("序列化会话失败: {e}"))?
                .as_slice(),
        )
    }

    /* ---- messages：JSONL 追加，整读进内存 ---- */

    pub fn append_message(&self, msg: &Message) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
        use std::io::BufWriter;
        let path = self.file("messages.jsonl");
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("打开 {} 失败: {e}", path.display()))?;
        let mut w = BufWriter::new(file);
        let line = serde_json::to_string(msg).map_err(|e| format!("序列化消息失败: {e}"))?;
        writeln!(w, "{line}").map_err(|e| format!("追加消息失败: {e}"))?;
        w.flush().map_err(|e| format!("刷新消息失败: {e}"))?;
        Ok(())
    }

    /// JSONL 是追加式的：同一条消息的状态变更会再写一行，读取时以最后一条为准，
    /// 但保持首次出现的顺序（前端按时间铺气泡，不能因为更新状态就跳到列表末尾）。
    /// 本机删掉的那些（`hidden`）在这里就筛掉：历史分页、会话摘要、未读数
    /// 全走这一条出口，所以「删了」在哪个界面都是一样彻底（文件里那一行仍留着）
    pub fn read_messages(&self, limit: usize) -> Vec<Message> {
        let txt = match fs::read_to_string(self.file("messages.jsonl")) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        let mut merged: Vec<Message> = dedup_lines(&txt)
            .into_iter()
            .filter(|m| !m.hidden)
            .collect();
        if merged.len() > limit {
            merged = merged.split_off(merged.len() - limit);
        }
        merged
    }

    /// 这一条最新的那一行，**不做任何可见性过滤**。
    /// 与 read_messages 分开是因为用途不同：这里要的是「盘上现在写的是什么」，
    /// 连被本机删掉的那条也得能拿到，否则改状态时会把 `hidden` 当成 false 写回去
    pub fn raw_message(&self, id: &str) -> Option<Message> {
        let txt = fs::read_to_string(self.file("messages.jsonl")).ok()?;
        // 倒着找：最新那一行总在文件靠后的位置，先把 id 做廉价子串筛再反序列化
        for line in txt.lines().rev() {
            if !line.contains(id) {
                continue;
            }
            if let Ok(m) = serde_json::from_str::<Message>(line) {
                if m.id == id {
                    return Some(m);
                }
            }
        }
        None
    }

    /// 这一条最新的两个可见性标记（没有这条就是都没标上）。
    /// 状态写入（sent/failed/queued）拿的是**投递开始前**的快照做 clone，这期间用户
    /// 可能撤了或删了它 —— 不保住这两个字段，一次成功的投递就会把「已撤回」冲掉，
    /// 撤走的消息会在两边同时复活
    pub fn flags_of(&self, id: &str) -> (bool, bool) {
        self.raw_message(id)
            .map(|m| (m.recalled, m.hidden))
            .unwrap_or((false, false))
    }

    /// 同 ID 追一行，只改传进来的那部分（其余字段从盘上最新那一行原样带过去）。
    /// 撤回与本机删除都走这里：它们不改投递状态，也就不该碰状态那几个字段
    pub fn patch_flags(
        &self,
        id: &str,
        patch: impl FnOnce(&mut Message),
    ) -> Result<Message, String> {
        let mut done = self.raw_message(id).ok_or("找不到这条消息，可能已经被删掉了")?;
        patch(&mut done);
        self.append_message(&done)?;
        Ok(done)
    }

    /// 清空一个对话框的聊天记录：把这一格里还没 hidden 的消息逐条补写 hidden=true。
    /// 与「删会话」（remove_session：框从列表里没了、消息一条不动）是两回事：
    /// 这里框还在、设备还在、对端那份与收件箱里的文件都不动，只是这一台不再显示。
    /// 口径与逐条删除一致（同走 hidden），只是入口一次点一批。
    ///
    /// 一次全量读、一次整体重写：逐条 patch_flags 要为每一条都重读一遍整个文件，
    /// 几百条历史就是几百遍全量读，IO 放大得离谱。重写落在去重后的最新状态上（与内存里
    /// 本来就看得到的那份完全一致，只多了 hidden 标记），读侧仍按「同 id 最后
    /// 一行赢」，语义不变。返回标成隐藏的那几条，调用方据此推事件。
    pub fn clear_session(&self, sid: &str) -> Result<Vec<Message>, String> {
        let path = self.file("messages.jsonl");
        let txt = fs::read_to_string(&path).unwrap_or_default();
        let mut merged = dedup_lines(&txt);
        let mut cleared: Vec<Message> = Vec::new();
        for m in merged.iter_mut() {
            if m.sid_of() == sid && !m.hidden {
                m.hidden = true;
                cleared.push(m.clone());
            }
        }
        if cleared.is_empty() {
            return Ok(cleared);
        }
        // 与 append 同样的序列化：每行一条，行尾换行
        let mut buf = String::new();
        for m in &merged {
            let line = serde_json::to_string(m).map_err(|e| format!("序列化消息失败: {e}"))?;
            buf.push_str(&line);
            buf.push('\n');
        }
        atomic_write(&path, buf.as_bytes())?;
        Ok(cleared)
    }

    /* ---- 存储：占用统计与收件目录清理 ---- */

    /// 各处的占用。只在设置抽屉打开与点「刷新」时算一次：递归走一遍目录树
    /// 不便宜，绝不能放进任何轮询里。目录不存在就是 0，不顺手建目录（统计不该有副作用）
    pub fn storage_stats(&self) -> StorageStats {
        let (inbox_bytes, inbox_count) = walk_sizes(&self.inbox_dir());
        let (pastebox_bytes, _) = walk_sizes(&self.pastebox_dir());
        let (data_bytes, _) = walk_sizes(&self.dir);
        let messages_bytes = fs::symlink_metadata(self.file("messages.jsonl"))
            .map(|m| m.len())
            .unwrap_or(0);
        // 条数走 read_messages 那道闸门：界面上报的得是用户看得到的那些
        let messages_count = self.read_messages(usize::MAX).len();
        StorageStats {
            inbox_bytes,
            inbox_count,
            pastebox_bytes,
            data_bytes,
            messages_bytes,
            messages_count,
        }
    }

    /// 清收件目录里那些「改于 `before_ts` 之前、而且没被任何还看得见的消息引用」的
    /// 东西。返回（删掉的个数, 释放的字节），个数按文件计（删一个日期子目录就算
    /// 删了 N 个文件）。
    ///
    /// 被引用的一个都不删 —— 与「撤回不删文件」同一口径：宁可留着占地方，
    /// 也不能让哪条历史气泡的预览、另存为忽然失效。对端那份、聊天记录本身、
    /// 粘贴暂存区（`pastebox`）都不在这一步的范围内
    pub fn inbox_cleanup(&self, before_ts: i64) -> Result<(u64, u64), String> {
        let root = self.inbox_dir();
        if !root.is_dir() {
            return Ok((0, 0));
        }
        // 聊天记录里还指着的哪些绝对路径（read_messages 已挡 hidden：
        // 本机删过的那条在界面上已经没入口，它指的文件因此可以清）
        let kept: HashSet<PathBuf> = self
            .read_messages(usize::MAX)
            .into_iter()
            .filter_map(|m| m.path)
            .map(PathBuf::from)
            .collect();
        let rd = fs::read_dir(&root).map_err(|e| format!("读收件目录失败: {e}"))?;
        let mut deleted = 0u64;
        let mut freed = 0u64;
        for e in rd.flatten() {
            let p = e.path();
            let md = match fs::symlink_metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if mtime >= before_ts {
                continue;
            }
            let is_dir = md.is_dir();
            // 日期/月份那一级的子目录：里面但凡有一条还被引着，整个目录就原样留着
            if kept.contains(&p) || (is_dir && dir_has_kept(&p, &kept)) {
                continue;
            }
            let (bytes, files) = if is_dir {
                walk_sizes(&p)
            } else {
                (md.len(), 1)
            };
            let rm = if is_dir {
                fs::remove_dir_all(&p)
            } else {
                fs::remove_file(&p)
            };
            rm.map_err(|err| format!("删除 {} 失败: {err}", p.display()))?;
            deleted += files;
            freed += bytes;
        }
        Ok((deleted, freed))
    }

    /// 待发（离线排队）的、本机发出去的消息，按首次出现的顺序
    /// （补发扫描与「pending」计数都读它）。
    /// 判「最新状态」必须按**全部**行去重：一条补发成功的消息是先写 `queued`
    /// 再追加同 id 的 `sent`，只挑含 queued 的行去重的话，`sent` 那行会被漏掉，
    /// 这条早就发出去的消息就会一直赖在队列里反复重投。
    /// 所以这里只做一次廉价的子串预筛：整个文件一行 `"queued"` 都没有（队列空，
    /// 也就是绝大多数时候）就直接返空，免得每秒一次的扫描把整份历史反序列化一遍。
    pub fn pending_messages(&self) -> Vec<Message> {
        let txt = match fs::read_to_string(self.file("messages.jsonl")) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        if !txt.contains("\"queued\"") {
            return Vec::new();
        }
        dedup_lines(&txt)
            .into_iter()
            // 撤回与本机删除的那两条都得算出队：一条已经撤走的待发消息
            // 不该在对方上线时又被补发出去，那等于把用户撤掉的东西又送回去
            .filter(|m| m.dir == "out" && m.state == "queued" && !m.recalled && !m.hidden)
            .collect()
    }

    /// 修历史坏数据：早期版本把收件箱消息的 `path` 按名字长度硬截过（还会削掉 `.jpg`），
    /// 那种记录现在指向一个不存在的路径，前端只会反复报「缩略图读取失败」，
    /// 而文件其实就躺在同一个目录里、名字更长。
    ///
    /// 只认这一种窄情形：名字够长（>=100 字符，短名字前缀撞车概率高，
    /// 比如 `a.txt` 与 `a.txt (1)`）+ 同目录下**恰好只有一个**文件以它为前缀。
    /// 找回就补写一条修正记录（JSONL 后写覆盖前写，见 read_messages），其余原样留着。
    pub fn repair_inbox_paths(&self) -> usize {
        let mut fixed = 0;
        for m in self.read_messages(usize::MAX) {
            if m.dir != "in" || m.kind != "file" {
                continue;
            }
            let Some(p) = m.path.as_deref() else { continue };
            let path = Path::new(p);
            if path.exists() {
                continue;
            }
            let Some(bad_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if bad_name.chars().count() < 100 {
                continue;
            }
            let Some(parent) = path.parent() else { continue };
            let Ok(entries) = fs::read_dir(parent) else {
                continue;
            };
            let hits: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|e| {
                    let Some(n) = e.file_name().and_then(|s| s.to_str()) else {
                        return false;
                    };
                    n.chars().count() > bad_name.chars().count()
                        && n.starts_with(bad_name)
                        && e.is_file()
                })
                .collect();
            if hits.len() != 1 {
                continue;
            }
            let real = &hits[0];
            let patched = Message {
                path: Some(real.to_string_lossy().to_string()),
                name: real
                    .file_name()
                    .map(|s| Some(s.to_string_lossy().to_string()))
                    .unwrap_or_else(|| m.name.clone()),
                ..m.clone()
            };
            match self.append_message(&patched) {
                Ok(()) => {
                    eprintln!("[store] 找回被截断的收件箱路径：{} -> {}", p, real.display());
                    fixed += 1;
                }
                Err(e) => eprintln!("[store] 修正后的路径写回失败: {e}"),
            }
        }
        fixed
    }

    /* ---- favorites ---- */

    pub fn load_favs(&self) -> FavFile {
        fs::read_to_string(self.file("favorites.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<FavFile>(&t).ok())
            .unwrap_or_default()
    }

    pub fn save_favs(&self, f: &FavFile) -> Result<(), String> {
        atomic_write(
            &self.file("favorites.json"),
            serde_json::to_vec_pretty(f)
                .map_err(|e| format!("序列化收藏失败: {e}"))?
                .as_slice(),
        )
    }

    /* ---- prefs：界面偏好，一项一次改动整体回写 ---- */

    /// 没这份文件（首启动、老版本）就回出厂态；解析失败同样回出厂态，
    /// 不是 Err —— 偏好读不出来不值得把界面初始化挂掉
    pub fn load_prefs(&self) -> Preferences {
        let mut p = fs::read_to_string(self.file("prefs.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Preferences>(&t).ok())
            .unwrap_or_default();
        p.normalize();
        p
    }

    pub fn save_prefs(&self, p: &Preferences) -> Result<(), String> {
        atomic_write(
            &self.file("prefs.json"),
            serde_json::to_vec_pretty(p)
                .map_err(|e| format!("序列化偏好失败: {e}"))?
                .as_slice(),
        )
    }

    /* ---- history：看过的图片，只存路径与时刻 ---- */

    /// 没这份文件（首启动）或整份被改坏就回空列表，不是 Err —— 历史读不出来
    /// 不值得把侧栏初始化挂掉。脏值在这一步统一清掉，下一次保存就是干净份
    pub fn load_history(&self) -> HistoryFile {
        let mut h = fs::read_to_string(self.file("history.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<HistoryFile>(&t).ok())
            .unwrap_or_default();
        h.normalize();
        h
    }

    pub fn save_history(&self, h: &HistoryFile) -> Result<(), String> {
        atomic_write(
            &self.file("history.json"),
            serde_json::to_vec_pretty(h)
                .map_err(|e| format!("序列化查看历史失败: {e}"))?
                .as_slice(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立目录：这几个测试会并行跑，共用一个目录会互相盖掉文件
    fn 临时存储(名字: &str) -> Store {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Store::new(std::env::temp_dir().join(format!("imgcmp-{名字}-{}-{n}", std::process::id())))
    }

    fn 台(id: &str) -> Peer {
        Peer {
            id: id.into(),
            name: id.into(),
            alias: String::new(),
            host: "127.0.0.1".into(),
            port: 45789,
            online: false,
            last_seen: 0,
        }
    }

    #[test]
    fn 多台对端写进去都能读回来() {
        let s = 临时存储("peers");
        assert!(s.load_peers().peers.is_empty(), "没有文件时回空列表");
        s.save_peers(&PeersFile {
            peers: vec![台("a"), 台("b"), 台("c")],
            ignored: vec![],
        })
        .unwrap();
        assert_eq!(s.load_peers().peers.len(), 3, "磁盘格式本来就是数组，三台都得存住");
        // 解绑一台是整体回写，不能只写剩下的那一个还弄丢其它
        let kept: Vec<Peer> = s.load_peers().peers.into_iter().filter(|p| p.id != "b").collect();
        s.save_peers(&PeersFile { peers: kept, ignored: vec!["b".into()] }).unwrap();
        let f = s.load_peers();
        let ids: Vec<String> = f.peers.into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["a", "c"]);
        assert_eq!(f.ignored, vec!["b"], "解绑名单得跟着活下来，否则重启后又被自动登记回来");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 备注名与解绑名单活得过重启() {
        let s = 临时存储("peers_alias");
        let mut 甲 = 台("aaa111");
        甲.name = "Mac".into();
        甲.alias = "办公室那台".into();
        s.save_peers(&PeersFile { peers: vec![甲], ignored: vec!["zzz".into()] })
            .unwrap();
        let f = s.load_peers();
        assert_eq!(f.peers[0].alias, "办公室那台", "备注名是用户打的字，不能一重启就没了");
        assert_eq!(f.peers[0].display_name(), "办公室那台", "有备注时显示名就是备注");
        assert_eq!(f.ignored, vec!["zzz"]);
        // 没备注的那台（以及备注只填了空格的）退回对方报的名；再空就露一截设备 ID
        let mut 乙 = 台("bbb222");
        乙.name = "Windows-PC".into();
        assert_eq!(乙.display_name(), "Windows-PC");
        乙.alias = "   ".into();
        assert_eq!(乙.display_name(), "Windows-PC", "只填了空白的备注等于没填");
        乙.name = String::new();
        assert_eq!(乙.display_name(), "设备 bbb222", "两个都没才露设备 ID，别出现空名字");
        // 老文件没有 alias 字段：必须照样读得出来，不能整个列表变空
        std::fs::write(
            s.file("peers.json"),
            r#"{"peers":[{"id":"old1","name":"旧机","host":"127.0.0.1","port":45789,"online":true,"last_seen":1}]}"#,
        )
        .unwrap();
        let f = s.load_peers();
        assert_eq!(f.peers.len(), 1, "老版本写的 peers.json 不能因为多个字段就全丢");
        assert_eq!(f.peers[0].alias, "", "缺字段就是没备注");
        assert!(f.ignored.is_empty(), "缺 ignored 就是没人被解绑过");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 会话表没文件时回空结构且可以往返() {
        let s = 临时存储("sessions");
        let f = s.load_sessions();
        assert!(f.sessions.is_empty() && f.active.is_empty() && f.hidden.is_empty(), "首启动就是这个状态");
        s.save_sessions(&SessionsFile {
            sessions: vec![Session {
                id: "a".into(),
                peer: "a".into(),
                name: "甲机".into(),
                created: 1,
                read: 2,
                pinned: true,
            }],
            active: "a".into(),
            hidden: vec!["gone".into()],
        })
        .unwrap();
        let back = s.load_sessions();
        assert_eq!(back.active, "a");
        assert_eq!(back.sessions[0].id, "a", "会话主键得存住，不然重启后多个框会并成一个");
        assert_eq!(back.sessions[0].name, "甲机");
        assert_eq!(back.sessions[0].read, 2, "读指针丢了就等于未读记录丢了");
        assert!(back.sessions[0].pinned, "置顶得存在盘上，重启不能又掉回下面");
        assert_eq!(back.hidden, vec!["gone".to_string()], "删过的会话得记住，不然重启就补回来");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 旧版会话文件没id时按对端补上基础对话() {
        let s = 临时存储("sessions-normalize");
        std::fs::create_dir_all(&s.dir).unwrap();
        // 上一版的 sessions.json：一行只有 peer，没有 id；active/hidden 存的是设备 ID
        std::fs::write(
            s.file("sessions.json"),
            br#"{ "sessions": [ { "peer": "a", "name": "jia", "created": 1, "read": 9 } ],
                 "active": "a", "hidden": ["b"] }"#,
        )
        .unwrap();
        let f = s.load_sessions();
        assert_eq!(f.sessions[0].id, "a", "基础对话的 id 就是设备 ID，老历史才能归到它");
        assert!(!f.sessions[0].pinned, "老文件没有 pinned 字段，读进来应当是没置顶");
        assert_eq!(f.active, "a", "焦点不用改：它本来指向的就是这个 id");
        assert_eq!(f.hidden, vec!["b".to_string()]);
        // 手改成空 id 的行会把所有会话混成一个，读进来就该丢掉
        std::fs::write(
            s.file("sessions.json"),
            br#"{ "sessions": [ { "id": "", "peer": "", "name": "", "created": 0, "read": 0 } ],
                 "active": "", "hidden": [] }"#,
        )
        .unwrap();
        assert!(s.load_sessions().sessions.is_empty(), "未标记不入会话表");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 没sid的老消息归到那台的基础对话() {
        let 条 = |sid: &str, peer: &str| Message {
            id: "m".into(),
            dir: "in".into(),
            kind: "text".into(),
            text: Some("x".into()),
            name: None,
            size: None,
            path: None,
            state: "sent".into(),
            ts: 1,
            peer: peer.into(),
            sid: sid.into(),
            ..Default::default()
        };
        assert_eq!(条("", "a").sid_of(), "a", "上一版没有这个字段，只能归基础对话");
        assert_eq!(条("u1", "a").sid_of(), "u1", "新话题按带的会话 ID 算");
        assert_eq!(条("", "").sid_of(), "", "未标记还是未标记");
        // sid 是后加的字段：不含它的旧 JSONL 行必须能解开来
        let 老行 = r#"{"id":"m","dir":"in","kind":"text","text":"x","state":"sent","ts":1,"peer":"a"}"#;
        let m: Message = serde_json::from_str(老行).unwrap();
        assert_eq!(m.sid_of(), "a", "缺字段不能报错，否则整份历史读不出来");
    }

    #[test]
    fn 界面偏好往返与脏值退回默认() {
        let s = 临时存储("prefs");
        assert_eq!(
            s.load_prefs(),
            Preferences::default(),
            "没有 prefs.json（首启动与老版本）就是出厂态"
        );

        s.save_prefs(&Preferences {
            layout: "1".into(),
            sync: false,
            wheel: "pan".into(),
            ..Preferences::default()
        })
        .unwrap();
        let back = s.load_prefs();
        assert_eq!(back.layout, "1", "单图布局得活过重启，否则用户每次进来都要重选");
        assert!(!back.sync);
        assert_eq!(back.wheel, "pan");

        // 手写的缺字段 JSON：只补缺的那几项，不能把已填的抹掉
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.file("prefs.json"), r#"{ "layout": "4" }"#).unwrap();
        let p = s.load_prefs();
        assert_eq!(p.layout, "4");
        assert!(p.sync, "缺 sync 字段应该按出厂态给开");
        assert_eq!(p.wheel, "zoom");
        // 上一版 prefs.json 里根本没有这两项：缺字段就当出厂态（响一声 + 默认收件目录）
        assert!(p.notify, "缺 notify 字段不能变成静默");
        assert!(p.inbox.is_empty(), "缺 inbox 字段就是默认收件目录");
        assert_eq!(p.heartbeat_ms, HEARTBEAT_DEFAULT, "缺 heartbeat_ms 就是原来的写死节拍");

        // 前端不认的布局与滚轮值：存进去就该被清掉（没有 CSS 的布局会让四个窗都不显示）
        for bad_layout in ["3", "", "8", "两图"] {
            std::fs::write(s.file("prefs.json"), format!(r#"{{ "layout": "{bad_layout}" }}"#)).unwrap();
            assert_eq!(s.load_prefs().layout, "2", "非法布局 {bad_layout:?} 必须退回两图");
        }
        std::fs::write(s.file("prefs.json"), r#"{ "wheel": "scroll" }"#).unwrap();
        assert_eq!(s.load_prefs().wheel, "zoom");

        // 整份被改坏也不能报错，回出厂态（偏好读不出来不值得挂掉界面初始化）
        std::fs::write(s.file("prefs.json"), "不是 JSON").unwrap();
        assert_eq!(s.load_prefs(), Preferences::default());
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 归类方案字段缺时为空且能往返不炸老配置() {
        let s = 临时存储("sort-plans");
        std::fs::create_dir_all(&s.dir).unwrap();
        // 上一版 prefs.json 里根本没有 sort_plans：缺字段就是空表，不报错
        std::fs::write(s.file("prefs.json"), r#"{ "layout": "2" }"#).unwrap();
        assert!(s.load_prefs().sort_plans.is_empty(), "缺 sort_plans 字段必须回空表");

        // 存一套方案（不透明 JSON 原文）后能原样读回
        let 方案 = vec![serde_json::json!({
            "id": "p1", "name": "按年月", "rules": [{"exts": ["png"], "folder": "{yyyy}-{MM}"}], "target_root": ""
        })];
        s.save_prefs(&Preferences {
            sort_plans: 方案.clone(),
            ..Preferences::default()
        })
        .unwrap();
        let back = s.load_prefs().sort_plans;
        assert_eq!(back.len(), 1, "方案要活过重启");
        assert_eq!(back[0]["name"], "按年月");
        // 缺这一项也不能把别的字段带坏（整份仍能正常解）
        assert_eq!(s.load_prefs().layout, "2");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 心跳节拍往返与白名单外的值退回出厂档() {
        let s = 临时存储("heartbeat");
        std::fs::create_dir_all(&s.dir).unwrap();
        // 选了一档就活过重启：节拍是心跳线程每拍从磁盘读的，读回来就是生效的那一档
        for &ok in &HEARTBEAT_OPTIONS {
            s.save_prefs(&Preferences {
                heartbeat_ms: ok,
                ..Preferences::default()
            })
            .unwrap();
            assert_eq!(s.load_prefs().heartbeat_ms, ok, "{ok} 是白名单里的档位，不该被改回去");
        }
        // 白名单外的一律退回出厂档：0 会让这个线程空转烤 CPU，负数与非数字根本解不开
        for bad in ["0", "10", "999", "1500", "\"5000\""] {
            std::fs::write(s.file("prefs.json"), format!(r#"{{ "heartbeat_ms": {bad} }}"#)).unwrap();
            assert_eq!(s.load_prefs().heartbeat_ms, HEARTBEAT_DEFAULT, "脏值 {bad} 必须退回出厂档");
        }
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 收件目录按prefs生效脏值退回默认() {
        let s = 临时存储("inbox-dir");
        std::fs::create_dir_all(&s.dir).unwrap();
        assert_eq!(
            s.inbox_dir(),
            s.dir.join("inbox"),
            "没改过就是数据目录下的 inbox"
        );

        let other = std::env::temp_dir().join(format!("imgcmp-other-{}", std::process::id()));
        s.save_prefs(&Preferences {
            inbox: other.to_string_lossy().to_string(),
            ..Preferences::default()
        })
        .unwrap();
        assert_eq!(s.inbox_dir(), other, "改过之后必须原样生效，不拿默认目录顶");

        // 相对路径不能当目录用：它会被当成相对于进程当前目录去建，
        // 那个位置从 Finder 启动和从 cargo 启动完全不是一个地方
        s.save_prefs(&Preferences {
            inbox: "recv/今日".into(),
            ..Preferences::default()
        })
        .unwrap();
        assert_eq!(
            s.inbox_dir(),
            s.dir.join("inbox"),
            "手改出来的相对路径要退回默认目录"
        );
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 收件目录按天按月分子目录() {
        let s = 临时存储("inbox-layout");
        std::fs::create_dir_all(&s.dir).unwrap();
        let root = s.dir.join("inbox");
        let 今天 = chrono::Local::now().format("%Y-%m-%d").to_string();
        let 本月 = chrono::Local::now().format("%Y-%m").to_string();

        // 出厂就是按天分；老 prefs.json 没有这一项，升级上来也该立刻生效
        assert_eq!(s.inbox_delivery_dir(), root.join(&今天));
        std::fs::write(s.file("prefs.json"), r#"{ "layout": "2" }"#).unwrap();
        assert_eq!(
            s.inbox_delivery_dir(),
            root.join(&今天),
            "老版本写的 prefs.json 缺 inbox_layout，读时得补成按天"
        );

        s.save_prefs(&Preferences {
            inbox_layout: "month".into(),
            ..Preferences::default()
        })
        .unwrap();
        assert_eq!(s.inbox_delivery_dir(), root.join(&本月));

        s.save_prefs(&Preferences {
            inbox_layout: "flat".into(),
            ..Preferences::default()
        })
        .unwrap();
        assert_eq!(s.inbox_delivery_dir(), root, "不分目录时落点就是根");

        // 手改坏的值退回按天：静默换成「全铺在根上」会让界面上的选项与磁盘不符
        for bad in ["", "year", "week", "天"] {
            std::fs::write(
                s.file("prefs.json"),
                format!(r#"{{ "inbox_layout": "{bad}" }}"#),
            )
            .unwrap();
            assert_eq!(s.load_prefs().inbox_layout, "day", "脏值 {bad:?} 退回按天");
        }

        // 自定义根目录也照样往日期子目录里放
        let other = std::env::temp_dir().join(format!("imgcmp-layout-{}", std::process::id()));
        s.save_prefs(&Preferences {
            inbox: other.to_string_lossy().to_string(),
            inbox_layout: "day".into(),
            ..Preferences::default()
        })
        .unwrap();
        assert_eq!(s.inbox_delivery_dir(), other.join(&今天));
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 查看历史没文件时回空列表且能往返() {
        let s = 临时存储("hist-roundtrip");
        assert!(
            s.load_history().items.is_empty(),
            "首启动没这份文件，读出来应是空列表而不是报错"
        );
        std::fs::create_dir_all(&s.dir).unwrap();

        s.save_history(&HistoryFile {
            items: vec![
                HistoryItem { path: "/a/1.jpg".into(), seen: 200 },
                HistoryItem { path: "/a/2.jpg".into(), seen: 100 },
            ],
        })
        .unwrap();
        let back = s.load_history();
        assert_eq!(back.items.len(), 2);
        assert_eq!(back.items[0].path, "/a/1.jpg", "新的在前");
        assert_eq!(back.items[1].path, "/a/2.jpg");

        // 整份被改坏：回空列表，不报错 —— 历史读不出来不值得把侧栏初始化挂掉
        std::fs::write(s.file("history.json"), "{ 这不是 JSON").unwrap();
        assert!(s.load_history().items.is_empty());
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 查看历史清脏值去重并封顶到上限() {
        // 用当前时刻做基准：`seen <= 0` 补的是 now_ms()，写死小整数会被它盖过去，
        // 排序断言就变成了测「补的时刻比谁都大」而不是测降序
        let 现在 = now_ms();
        let mut h = HistoryFile {
            items: vec![
                HistoryItem { path: "".into(), seen: 现在 + 9000 },           // 空路径
                HistoryItem { path: "recv/今日.png".into(), seen: 现在 + 8000 }, // 相对路径
                HistoryItem { path: "/a/x.jpg".into(), seen: 现在 + 1000 },
                HistoryItem { path: "/a/x.jpg".into(), seen: 现在 + 5000 }, // 重复：留 seen 大的
                HistoryItem { path: "/a/y.jpg".into(), seen: 0 },   // 脏时刻，要补当前
            ],
        };
        h.normalize();
        assert_eq!(h.items.len(), 2, "空路径与相对路径都被丢弃，重复的只留一条");
        assert_eq!(h.items[0].path, "/a/x.jpg", "去重后按 seen 降序");
        assert_eq!(h.items[0].seen, 现在 + 5000, "同一条重复时留更大的那个时刻");
        assert_eq!(h.items[1].path, "/a/y.jpg");
        assert!(h.items[1].seen >= 现在, "seen<=0 要补一个当前时间，不能留在 0");

        // 截断：塞 HISTORY_MAX + 50 条，留下的必须是最靠前的那 100 个。
        // seen 从 1 起：等于 0 的那条会被补成当前时间，反倒排到最前去
        let mut many = HistoryFile { items: Vec::new() };
        for i in 0..(HISTORY_MAX + 50) {
            many.items.push(HistoryItem { path: format!("/a/{i:04}.jpg"), seen: i as i64 + 1 });
        }
        many.normalize();
        assert_eq!(many.items.len(), HISTORY_MAX);
        assert_eq!(many.items[0].path, format!("/a/{:04}.jpg", HISTORY_MAX + 49), "新的在前");
        assert_eq!(many.items[HISTORY_MAX - 1].path, "/a/0050.jpg", "被砍的是最旧那 50 条");
    }

    #[test]
    fn 记一次查看是置顶不是追加() {
        let mut h = HistoryFile {
            items: vec![
                HistoryItem { path: "/a/1.jpg".into(), seen: 300 },
                HistoryItem { path: "/a/2.jpg".into(), seen: 200 },
                HistoryItem { path: "/a/3.jpg".into(), seen: 100 },
            ],
        };
        // 看已有的那张：只置顶刷新，列表长度不变
        h.record("/a/3.jpg", 400);
        assert_eq!(h.items.len(), 3, "同一张只留一条");
        assert_eq!(h.items[0].path, "/a/3.jpg");
        assert_eq!(h.items[0].seen, 400);
        assert_eq!(h.items[1].path, "/a/1.jpg", "被顶下去的两条保持原有相对顺序");

        // 新的一张：插到最前
        h.record("/a/9.jpg", 500);
        assert_eq!(h.items[0].path, "/a/9.jpg");
        assert_eq!(h.items.len(), 4);

        // 同一毫秒里连着记（seen 撞车）：后记的那条仍在前面，重读也不被按路径重排
        let mut same = HistoryFile {
            items: vec![HistoryItem { path: "/a/keep.jpg".into(), seen: 500 }],
        };
        same.record("/a/later.jpg", 500);
        same.normalize();
        assert_eq!(same.items[0].path, "/a/later.jpg", "并列时刻要顶到更大，不能靠路径定序取胜");
        assert_eq!(same.items[1].path, "/a/keep.jpg");

        // 满员后再记一条：最旧那条掉出去。这里必须按「新的在前」建满员列表 ——
        // record 只置顶不重排，排序是 load 时 normalize 的活（命令拿到的列表都来自 load_history）
        let mut full = HistoryFile { items: Vec::new() };
        for i in 0..HISTORY_MAX {
            full.items.push(HistoryItem {
                path: format!("/a/{i:04}.jpg"),
                seen: HISTORY_MAX as i64 - i as i64,
            });
        }
        full.record("/a/new.jpg", HISTORY_MAX as i64 + 1);
        assert_eq!(full.items.len(), HISTORY_MAX, "封顶不因新记录而突破");
        assert_eq!(full.items[0].path, "/a/new.jpg");
        assert_eq!(full.items[1].path, "/a/0000.jpg", "原有顺序整体后移一位");
        assert!(
            !full.items.iter().any(|it| it.path == "/a/0099.jpg"),
            "被挤掉的是末尾那条（最旧的）"
        );
    }

    #[test]
    fn 非法相对路径必须被拒() {
        let base = Path::new("/tmp/inbox");
        assert!(safe_rel_join(base, "../etc/passwd").is_err());
        assert!(safe_rel_join(base, "/etc/passwd").is_err());
        assert!(safe_rel_join(base, "a/../../b").is_err());
        assert!(safe_rel_join(base, "").is_err());
        assert!(safe_rel_join(base, "./a").is_err());
        #[cfg(windows)]
        assert!(safe_rel_join(base, "C:\\Windows\\a").is_err());
    }

    #[test]
    fn 合法相对路径逐项保留结构() {
        let base = Path::new("/tmp/inbox");
        let p = safe_rel_join(base, "照片/2026/春节/a.png").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/inbox/照片/2026/春节/a.png"));
        // 反斜杠（Windows 侧送来）也要能解析
        let q = safe_rel_join(base, "dir\\sub\\f.txt").unwrap();
        assert_eq!(q, PathBuf::from("/tmp/inbox/dir/sub/f.txt"));
    }

    #[test]
    fn 头部编码可以往返中文路径() {
        let raw = "照片/2026/春节/名片.png";
        let enc = hdr_encode(raw);
        assert!(enc.chars().all(|c| c.is_ascii()), "头值必须纯 ASCII");
        assert_eq!(hdr_decode(&enc).as_deref(), Some(raw));
        // 不是合法 base64 时要能判出来，不能当成路径写盘
        assert!(hdr_decode("不是 base64").is_none());
    }

    #[test]
    fn 签名可往返且口令不同则不匹配() {
        let ts = now_ms();
        let s = sign("口令A", "dev1", ts, "deadbeef");
        assert!(verify_sig("口令A", "dev1", ts, "deadbeef", &s));
        assert!(!verify_sig("口令B", "dev1", ts, "deadbeef", &s));
        assert!(!verify_sig("口令A", "dev2", ts, "deadbeef", &s));
        // 超时间窗
        assert!(!verify_sig("口令A", "dev1", ts - 10 * 60 * 1000, "deadbeef", &s));
    }

    #[test]
    fn 收藏深度按父链计算() {
        let nodes = vec![
            FavNode {
                id: "1".into(),
                parent: None,
                kind: "cat".into(),
                title: "一级".into(),
                body: String::new(),
                created: 0,
                updated: 0,
            },
            FavNode {
                id: "2".into(),
                parent: Some("1".into()),
                kind: "cat".into(),
                title: "二级".into(),
                body: String::new(),
                created: 0,
                updated: 0,
            },
            FavNode {
                id: "3".into(),
                parent: Some("2".into()),
                kind: "cat".into(),
                title: "三级".into(),
                body: String::new(),
                created: 0,
                updated: 0,
            },
        ];
        assert_eq!(fav_depth(&nodes, "1"), 1);
        assert_eq!(fav_depth(&nodes, "3"), 3);
    }

    #[test]
    fn 哈希写入器与一次性哈希结果一致() {
        let mut w = HashWriter::new(Vec::new());
        w.write_all(b"ab").unwrap();
        w.write_all(b"cd").unwrap();
        let (hex, n) = w.finish();
        assert_eq!(n, 4);
        assert_eq!(hex, sha256_hex(b"abcd"));
    }

    #[test]
    fn 被截断的收件箱路径能找回() {
        let dir = std::env::temp_dir().join(format!("imgcmp-repair-{}", now_ms()));
        let inbox = dir.join("inbox");
        fs::create_dir_all(&inbox).unwrap();
        let s = Store::new(dir.clone());

        // 长名字：早期版本截出来的前缀 + 盘上真正的文件
        let head = "x".repeat(120);
        let real_name = format!("{head}_完整尾缀.jpg");
        fs::write(inbox.join(&real_name), b"hi").unwrap();
        // 短名字：前缀也能撞上，但旧版本不会截这么短，宁可不修也不能认错
        fs::write(inbox.join("短文件.txt (1)"), b"hi").unwrap();

        let base = Message {
            id: "m1".into(),
            dir: "in".into(),
            kind: "file".into(),
            text: None,
            name: Some(head.clone()),
            size: Some(2),
            path: Some(inbox.join(&head).to_string_lossy().to_string()),
            state: "sent".into(),
            ts: 1,
            peer: String::new(),
            ..Default::default()
        };
        s.append_message(&base).unwrap();
        s.append_message(&Message {
            id: "m2".into(),
            name: Some("短文件.txt".into()),
            path: Some(inbox.join("短文件.txt").to_string_lossy().to_string()),
            ..base.clone()
        })
        .unwrap();

        assert_eq!(s.repair_inbox_paths(), 1, "只应修掉那条长名字的");
        let msgs = s.read_messages(10);
        assert_eq!(msgs.len(), 2);
        assert_eq!(
            msgs[0].path.as_deref().unwrap(),
            inbox.join(&real_name).to_string_lossy(),
            "长名字那条应指向盘上的真身"
        );
        assert_eq!(msgs[0].name.as_deref().unwrap(), real_name);
        assert_eq!(
            msgs[1].path.as_deref().unwrap(),
            inbox.join("短文件.txt").to_string_lossy(),
            "短名字那条必须原样留着"
        );

        // 幂等：路径已存在就不会再写，历史不会被重复修正堆长
        assert_eq!(s.repair_inbox_paths(), 0);
        assert_eq!(s.read_messages(10).len(), 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 消息读取按id去重并保持首现顺序() {
        let dir = std::env::temp_dir().join(format!("imgcmp-msg-{}", now_ms()));
        let s = Store::new(dir.clone());
        let base = Message {
            id: "m1".into(),
            dir: "out".into(),
            kind: "text".into(),
            text: Some("甲".into()),
            name: None,
            size: None,
            path: None,
            state: "sending".into(),
            ts: 1,
            peer: String::new(),
            ..Default::default()
        };
        s.append_message(&base).unwrap();
        s.append_message(&Message {
            id: "m2".into(),
            ..base.clone()
        })
        .unwrap();
        // 状态更新：同 id 再追加一条
        s.append_message(&Message {
            state: "sent".into(),
            ..base.clone()
        })
        .unwrap();
        let msgs = s.read_messages(100);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[0].state, "sent");
        assert_eq!(msgs[1].id, "m2");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 待发队列跳重启还在且不抢历史的位置() {
        let dir = std::env::temp_dir().join(format!("imgcmp-pending-{}", now_ms()));
        let s = Store::new(dir.clone());
        let base = Message {
            id: "m1".into(),
            dir: "out".into(),
            kind: "text".into(),
            text: Some("甲".into()),
            state: "queued".into(),
            ts: 1,
            peer: "a".into(),
            sid: "a".into(),
            ..Default::default()
        };
        s.append_message(&base).unwrap();
        // 用户又写了一条（当场就送达了）
        s.append_message(&Message {
            id: "m2".into(),
            state: "sent".into(),
            ts: 2,
            ..base.clone()
        })
        .unwrap();
        // 补发成功之前：这条待发必须能被队列读到，重启也不丢
        let mid = Store::new(dir.clone());
        let queued: Vec<String> = mid
            .pending_messages()
            .iter()
            .map(|m| m.id.clone())
            .collect();
        assert_eq!(queued, vec!["m1"], "重开进程后待发队列不能凭空变空");

        // 补发成功：同 id 再追一行 —— 首现位置不能动，否则那条气泡会跳到列表末尾
        s.append_message(&Message {
            state: "sent".into(),
            retry: 0,
            reason: None,
            ..base.clone()
        })
        .unwrap();

        let back = Store::new(dir.clone());
        assert!(
            back.pending_messages().is_empty(),
            "投出去的那条不该还挂在队列里"
        );
        let msgs = back.read_messages(100);
        assert_eq!(
            msgs.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2"],
            "状态更新不能让消息换位置"
        );
        assert_eq!(msgs[0].state, "sent");
        assert_eq!(msgs[0].retry, 0, "送达后计数与原因都得清掉");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 撤回与本机删除只追一行不改投递状态() {
        let dir = std::env::temp_dir().join(format!("imgcmp-recall-{}", now_ms()));
        let s = Store::new(dir.clone());
        let base = Message {
            id: "m1".into(),
            dir: "out".into(),
            kind: "text".into(),
            text: Some("甲".into()),
            state: "sent".into(),
            ts: now_ms(),
            peer: "a".into(),
            sid: "a".into(),
            ..Default::default()
        };
        s.append_message(&base).unwrap();

        // 老文件没有这两个字段：读出来就是没撤过、没删过
        assert!(!s.raw_message("m1").unwrap().recalled);
        assert!(!s.raw_message("m1").unwrap().hidden);

        let after = s.patch_flags("m1", |m| m.recalled = true).unwrap();
        assert_eq!(after.state, "sent", "撤回不能顺手改投递状态");
        assert_eq!(after.text.as_deref(), Some("甲"), "正文字段得原样带过去");
        assert!(after.recalled);
        // 行号只多了一条：同 ID 追加，不是改写
        let txt = fs::read_to_string(s.file("messages.jsonl")).unwrap();
        assert_eq!(txt.lines().count(), 2);

        // 已撤回的待发消息必须出队：否则对方上线时会被补发出去，
        // 等于把用户撤掉的东西又送回去
        s.append_message(&Message {
            id: "m2".into(),
            state: "queued".into(),
            ..base.clone()
        })
        .unwrap();
        s.patch_flags("m2", |m| m.recalled = true).unwrap();
        assert_eq!(
            s.pending_messages()
                .iter()
                .map(|m| m.id.clone())
                .collect::<Vec<_>>(),
            Vec::<String>::new(),
            "撤回后的那条不该还挂在队列里"
        );

        // 本机删除：读取口径里彻底看不见，而盘上那一行还在（对端那份更不会被碰）
        s.patch_flags("m1", |m| m.hidden = true).unwrap();
        assert!(s.read_messages(100).iter().all(|m| m.id != "m1"));
        assert!(s.raw_message("m1").is_some(), "只是不显示，历史文件不删行");
        // hidden 的那条改状态时也得保住标记，不能被当成 false 写回去
        assert_eq!(s.flags_of("m1"), (true, true));
        assert_eq!(s.flags_of("没有这条"), (false, false));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 撤回判据只认一分钟内自己发出去的那几条() {
        let 现在 = 1_700_000_000_000;
        let 我发的 = Message {
            dir: "out".into(),
            ts: 现在 - 1000,
            ..Default::default()
        };
        assert!(recall_check(&我发的, 现在).is_ok(), "刚发出去的该给撤回入口");

        // 刚好满一分钟：窗口是开区间，这一条已经没有入口了
        assert!(recall_check(
            &Message {
                ts: 现在 - RECALL_WINDOW_MS,
                ..我发的.clone()
            },
            现在
        )
        .is_err());
        assert!(recall_check(&Message { dir: "in".into(), ..我发的.clone() }, 现在).is_err());
        assert!(
            recall_check(&Message { recalled: true, ..我发的.clone() }, 现在).is_err(),
            "撤过的不能算第二次成功"
        );
        // 提示文案里那个数字必须跟着常量走，不然改了窗口界面上还在说一分钟
        assert_eq!(RECALL_WINDOW_MS, 60_000);
    }

    /* ---- 引用 / 清空 / 存储：这批都只碰盘上那几个新字段与新命令 ---- */

    /// 一条最普通的文字消息（存储那几个用例只关心它在不在读取口径里）
    fn 文字条(id: &str) -> Message {
        Message {
            id: id.into(),
            dir: "out".into(),
            kind: "text".into(),
            text: Some("一句".into()),
            state: "sent".into(),
            ts: 1,
            peer: "a".into(),
            sid: "a".into(),
            ..Default::default()
        }
    }

    /// 一条收到的文件消息：`path` 指向收件目录里那一份
    fn 文件条(id: &str, path: String) -> Message {
        Message {
            id: id.into(),
            dir: "in".into(),
            kind: "file".into(),
            name: Some(
                Path::new(&path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
            ),
            size: Some(5),
            path: Some(path),
            state: "sent".into(),
            ts: 1,
            peer: "a".into(),
            sid: "a".into(),
            ..Default::default()
        }
    }

    /// 把文件的修改时间按下到指定时刻：清理的「够老」判据只看 mtime，
    /// 用例不能靠睡三个月来造一份旧文件
    fn 按下改动时间(p: &Path, ms: u64) {
        let f = fs::OpenOptions::new().write(true).open(p).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms))
            .unwrap();
    }

    #[test]
    fn 引用卡片跟着消息落盘且没引用时不占字段() {
        let s = 临时存储("quote-roundtrip");
        let 那格 = |id: &str, q: Option<Quote>| Message {
            id: id.into(),
            quote: q,
            ..文字条(id)
        };
        s.append_message(&那格("甲1", Some(Quote {
            id: "原文".into(),
            from: "办公室那台".into(),
            text: "周五一起打印".into(),
            kind: "text".into(),
            name: None,
        })))
        .unwrap();
        s.append_message(&那格("甲2", None)).unwrap();

        let 读回 = s.read_messages(100);
        assert_eq!(
            读回.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["甲1", "甲2"],
            "两条都得读回来：同一个 id 写两次就会互相盖掉"
        );
        let 卡片 = 读回[0].quote.as_ref().expect("引用卡片必须原样读回来");
        assert_eq!(
            (
                卡片.id.as_str(),
                卡片.from.as_str(),
                卡片.text.as_str(),
                卡片.kind.as_str(),
                卡片.name.as_deref()
            ),
            ("原文", "办公室那台", "周五一起打印", "text", None),
            "存的是被引那一刻的快照：之后改名、撤回都不该动它"
        );
        assert_eq!(读回[0].text.as_deref(), Some("一句"), "引用不能顶掉正文");
        assert!(读回[1].quote.is_none());
        // 没引用的那些行不许多出这个键：同一份文件老版本也在读，形状不能变
        let 全文 = fs::read_to_string(s.file("messages.jsonl")).unwrap();
        assert_eq!(
            全文.lines().filter(|l| l.contains("甲2") && l.contains("\"quote\"")).count(),
            0,
            "skip_serializing_if 失效就会给每一条都塞一张空卡片"
        );
        assert_eq!(
            全文.lines().filter(|l| l.contains("甲1") && l.contains("\"quote\"")).count(),
            1,
            "带卡片的那一条确实落了盘"
        );
        let _ = fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 老行缺引用与看不懂的字段都读得开() {
        let s = 临时存储("quote-legacy");
        fs::create_dir_all(&s.dir).unwrap();
        // 三行一起写：上一版的老行、未来版本多了不认识字段的行、写到一半断掉的坏行。
        // 「不认识就当整份读不出来」这一种才会毁掉用户全部历史，所以这一条最要紧
        fs::write(
            s.file("messages.jsonl"),
            concat!(
                "{\"id\":\"老1\",\"dir\":\"in\",\"kind\":\"text\",\"text\":\"以前写的\",\"state\":\"sent\",\"ts\":1,\"peer\":\"a\"}\n",
                "{\"id\":\"新1\",\"dir\":\"in\",\"kind\":\"text\",\"text\":\"x\",\"state\":\"sent\",\"ts\":2,\"peer\":\"a\",\"quote\":{\"id\":\"老1\"},\"将来的字段\":7}\n",
                "{\"id\":\"坏\n",
            ),
        )
        .unwrap();
        let 全部 = s.read_messages(100);
        assert_eq!(
            全部.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["老1", "新1"],
            "坏的那一行丢掉，前后都得照常读出来"
        );
        assert!(全部[0].quote.is_none(), "老行没这个字段就是没引用");
        let 卡片 = 全部[1].quote.as_ref().unwrap();
        assert_eq!((卡片.id.as_str(), 卡片.text.as_str()), ("老1", ""), "卡片只写了 id：其它字段兜底成空而不是整行作废");
        assert!(卡片.name.is_none());
        let _ = fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 清空聊天只把那一格标成不显示() {
        let s = 临时存储("clear-visible");
        for m in [
            文字条("甲1"),
            文字条("甲2"),
            // 已经逐条删过的：本来就看不见，不该再算进这次清空
            Message {
                id: "甲3".into(),
                hidden: true,
                ..文字条("甲3")
            },
            // 另一格与未标记那一筐：一个字都不碰
            Message {
                id: "乙1".into(),
                peer: "b".into(),
                sid: "b".into(),
                ..文字条("乙1")
            },
            Message {
                id: "没标1".into(),
                peer: String::new(),
                sid: String::new(),
                ..文字条("没标1")
            },
        ] {
            s.append_message(&m).unwrap();
        }

        let 标了 = s.clear_session("a").unwrap();
        assert_eq!(
            标了.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["甲1", "甲2"],
            "只标这一格里还看得见的，别把另一格与未标记一起带走"
        );
        assert_eq!(
            s.read_messages(100)
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["乙1", "没标1"],
            "界面上这一格空了，而别的格一条不少"
        );
        assert!(s.raw_message("甲1").unwrap().hidden, "只是不显示：盘上那一行还在");
        assert_eq!(s.flags_of("甲3"), (false, true), "本来就删过的那条不能被重复标一遍");

        let 行数 = fs::read_to_string(s.file("messages.jsonl")).unwrap().lines().count();
        assert!(s.clear_session("a").unwrap().is_empty(), "再清一次已经没有可标的");
        assert_eq!(
            fs::read_to_string(s.file("messages.jsonl")).unwrap().lines().count(),
            行数,
            "没东西可标时不该把文件重写一遍（只追加、不重写的口径）"
        );
        assert!(s.clear_session("没有这一格").unwrap().is_empty(), "不存在的格子不是错误");
        // 未标记那一筐的 sid 就是空串，照旧给单独清
        assert_eq!(s.clear_session("").unwrap().len(), 1);
        assert_eq!(
            s.read_messages(100)
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["乙1"],
            "乙机那格到最后还看得见"
        );
        let _ = fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 清空聊天保住会话行也保住收进来的文件() {
        let s = 临时存储("clear-keeps-box");
        s.save_sessions(&SessionsFile {
            sessions: vec![Session {
                id: "a".into(),
                peer: "a".into(),
                name: "甲机".into(),
                created: 1,
                read: 2,
                pinned: true,
            }],
            active: "a".into(),
            hidden: vec![],
        })
        .unwrap();
        let 文件 = s.inbox_dir().join("收进来的.png");
        fs::create_dir_all(文件.parent().unwrap()).unwrap();
        fs::write(&文件, "12345").unwrap();
        s.append_message(&文件条("甲1", 文件.to_string_lossy().to_string()))
            .unwrap();
        // 撤回过的那条也住在这格里：清空把它一并标掉
        s.append_message(&Message {
            id: "甲2".into(),
            recalled: true,
            ..文字条("甲2")
        })
        .unwrap();

        assert_eq!(s.clear_session("a").unwrap().len(), 2, "撤回过的那条也该被标上");
        assert!(fs::metadata(&文件).is_ok(), "清空只动显示，收件文件必须还在（对端那份更不会被碰）");
        let 表 = s.load_sessions();
        assert_eq!(表.sessions[0].id, "a", "框还在：清空不是删会话");
        assert_eq!(表.sessions[0].name, "甲机", "用户给这格起的名字不动");
        assert_eq!(表.active, "a", "焦点也不动：清完还停在这格");
        assert!(表.sessions[0].pinned, "置顶状态更没理由被清掉");
        assert!(s.read_messages(100).is_empty());
        assert!(s.raw_message("甲1").is_some() && s.raw_message("甲2").is_some(), "历史行一条没丢");
        let _ = fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 存储统计算得出收件粘贴暂存与聊天历史() {
        let s = 临时存储("stats");
        let 天 = s.inbox_dir().join("2026-05-01");
        fs::create_dir_all(&天).unwrap();
        fs::write(天.join("一张.png"), "12345").unwrap();
        fs::write(天.join("二张.png"), "123").unwrap();
        fs::write(s.inbox_dir().join("散装.png"), "1").unwrap();
        fs::create_dir_all(s.pastebox_dir()).unwrap();
        fs::write(s.pastebox_dir().join("剪贴板.png"), "1234567").unwrap();
        s.append_message(&文字条("m1")).unwrap();
        s.append_message(&文字条("m2")).unwrap();
        s.patch_flags("m2", |m| m.hidden = true).unwrap();

        let 数 = s.storage_stats();
        assert_eq!(
            (数.inbox_bytes, 数.inbox_count),
            (5 + 3 + 1, 3),
            "递归到底：日期子目录里那两张也要算进来，个数按文件不按目录"
        );
        assert_eq!(数.pastebox_bytes, 7);
        assert_eq!(数.messages_count, 1, "条数只算界面上看得见的（hidden 那道闸门在 read_messages 出口）");
        assert!(数.messages_bytes > 0, "聊天记录那个文件本身的大小");
        assert!(
            数.data_bytes >= 数.inbox_bytes + 数.pastebox_bytes + 数.messages_bytes,
            "数据目录是整棵树，不会比几个分项还小"
        );
        let _ = fs::remove_dir_all(&s.dir);
    }

    #[cfg(unix)]
    #[test]
    fn 统计算的是逻辑大小不跟着软链去把文件唤下来() {
        let s = 临时存储("stats-symlink");
        fs::create_dir_all(s.inbox_dir()).unwrap();
        // 收件目录外放一个大文件，目录里只留一个指向它的软链：
        // 跟着链接算就会把同一坨计两遍，而 iCloud 占位文件更会被顺手唤下来一次
        let 大 = s.dir.join("外面那张.bin");
        fs::write(&大, vec![7u8; 4096]).unwrap();
        std::os::unix::fs::symlink(&大, s.inbox_dir().join("链过去.bin")).unwrap();

        let 数 = s.storage_stats();
        assert!(
            数.inbox_bytes < 4096,
            "不能跟着软链去算目标那一份的大小：{}",
            数.inbox_bytes
        );
        assert_eq!(数.inbox_count, 1, "软链自己也是一个条目，个数要算上它");
        let _ = fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 收件清理不动被聊天记录引着的那一层() {
        let s = 临时存储("clean-kept");
        let 有天 = s.inbox_dir().join("2020-01-01");
        let 别的天 = s.inbox_dir().join("2020-02-02");
        fs::create_dir_all(&有天).unwrap();
        fs::create_dir_all(&别的天).unwrap();
        let 引着 = 有天.join("合同扫描.png");
        let 同层 = 有天.join("顺手收的.png");
        let 删过 = 别的天.join("界面上已经删了.png");
        let 散装 = s.inbox_dir().join("散了一张.png");
        for p in [&引着, &同层, &删过, &散装] {
            fs::write(p, "12345").unwrap();
        }
        s.append_message(&文件条("甲1", 引着.to_string_lossy().to_string()))
            .unwrap();
        s.append_message(&文件条("乙1", 删过.to_string_lossy().to_string()))
            .unwrap();
        // 本机删过的那条在界面上已经没有入口，它指的文件因此可以清 —— 只有还看得见的才算被引着
        s.patch_flags("乙1", |m| m.hidden = true).unwrap();

        // 时间闸门放到很久以后：这几张都算「够老」，于是只看有没有被引着
        let (个数, 字节) = s.inbox_cleanup(now_ms() + 86_400_000 * 365 * 20).unwrap();
        assert_eq!((个数, 字节), (2, 10), "散的那一张 + 整个 2020-02-02 目录里那一张");
        assert!(
            fs::metadata(&引着).is_ok() && fs::metadata(&同层).is_ok(),
            "同一天的目录里但凡有一张还引着，整个目录就原样留着（用户自己也是按天翻这个目录的）"
        );
        assert!(fs::metadata(&删过).is_err(), "只被本机删掉的记录指着 = 界面上没入口，可以清");
        assert!(fs::metadata(&散装).is_err());
        assert_eq!(s.read_messages(100).len(), 1, "聊天记录本身一条不动");
        assert_eq!(
            s.storage_stats().inbox_count,
            2,
            "同层那张 + 还引着的那张：数字当场就能重画"
        );
        let _ = fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 收件清理只删够老的且不碰粘贴暂存也没目录时回零() {
        let s = 临时存储("clean-time");
        // 收件目录还没建过：统计与清理都该安静回零，不许顺手把目录建出来
        assert_eq!(s.inbox_cleanup(now_ms()).unwrap(), (0, 0));
        assert!(!s.inbox_dir().exists(), "清理不该有副作用：把目录建出来会让「收件目录在哪」那行字忽然变了");
        let 数 = s.storage_stats();
        assert_eq!((数.inbox_bytes, 数.inbox_count, 数.pastebox_bytes), (0, 0, 0));

        let 旧 = s.inbox_dir().join("旧的一张.png");
        let 新 = s.inbox_dir().join("新的一张.png");
        let 暂存 = s.pastebox_dir().join("剪贴板.png");
        fs::create_dir_all(s.inbox_dir()).unwrap();
        fs::create_dir_all(s.pastebox_dir()).unwrap();
        for p in [&旧, &新, &暂存] {
            fs::write(p, "12345").unwrap();
        }
        // 2020 年元旦改的时间，按「清三个月前」的档位它才够老
        按下改动时间(&旧, 1_577_836_800_000);

        let (个数, 字节) = s.inbox_cleanup(now_ms() - 86_400_000 * 90).unwrap();
        assert_eq!((个数, 字节), (1, 5), "只有那一张够老的被删：{个数}/{字节}");
        assert!(fs::metadata(&新).is_ok(), "刚收进来的不能碰：用户可能就是想找它");
        assert!(
            fs::metadata(&暂存).is_ok(),
            "粘贴暂存不在这一步的范围里（那些图本来没有原文件，历史气泡还指着它们）"
        );
        let _ = fs::remove_dir_all(&s.dir);
    }
}
