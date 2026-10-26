//! 本地存储与通用工具：设备身份、对端绑定、消息历史、收藏树。
//!
//! 全部落在 `app_data_dir` 下，不跨设备同步（设计已确认）。
//! 字段命名一律 snake_case，与前端读法保持一致 —— 不加任何 serde rename_all，
//! 这是之前 `data_url` / `dataUrl` 撞车导致静默 undefined 的教训。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

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
    }
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
    pub fn read_messages(&self, limit: usize) -> Vec<Message> {
        let txt = match fs::read_to_string(self.file("messages.jsonl")) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        let mut merged = dedup_lines(&txt);
        if merged.len() > limit {
            merged = merged.split_off(merged.len() - limit);
        }
        merged
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
            .filter(|m| m.dir == "out" && m.state == "queued")
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
}
