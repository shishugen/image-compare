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
    pub name: String,
    pub host: String,
    pub port: u16,
    /// 最近一次 /ping 是否成功
    pub online: bool,
    pub last_seen: i64,
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
    /// "sending" | "sent" | "failed"
    pub state: String,
    pub ts: i64,
    /// 对端设备 ID，用于将来扩到多台
    #[serde(default)]
    pub peer: String,
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

    pub fn inbox_dir(&self) -> PathBuf {
        self.dir.join("inbox")
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

    /* ---- peers：只绑定一台，数组留作扩展与迁移余地 ---- */

    pub fn load_peers(&self) -> Option<Peer> {
        let txt = fs::read_to_string(self.file("peers.json")).ok()?;
        #[derive(Deserialize)]
        struct PeersFile {
            peers: Vec<Peer>,
        }
        serde_json::from_str::<PeersFile>(&txt)
            .ok()
            .and_then(|f| f.peers.into_iter().next())
    }

    pub fn save_peer(&self, peer: &Peer) -> Result<(), String> {
        #[derive(Serialize)]
        struct PeersFile<'a> {
            peers: Vec<&'a Peer>,
        }
        let body = PeersFile {
            peers: vec![peer],
        };
        atomic_write(
            &self.file("peers.json"),
            serde_json::to_vec_pretty(&body)
                .map_err(|e| format!("序列化对端失败: {e}"))?
                .as_slice(),
        )
    }

    pub fn clear_peer(&self) -> Result<(), String> {
        let path = self.file("peers.json");
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("删除 {} 失败: {e}", path.display()))?;
        }
        Ok(())
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
        let mut order: Vec<String> = Vec::new();
        let mut latest: std::collections::HashMap<String, Message> = std::collections::HashMap::new();
        for line in txt.lines().filter(|l| !l.trim().is_empty()) {
            // 手改坏了一行也只跳过这一行，不让整份历史读不出来
            let Ok(msg) = serde_json::from_str::<Message>(line) else {
                continue;
            };
            if !latest.contains_key(&msg.id) {
                order.push(msg.id.clone());
            }
            latest.insert(msg.id.clone(), msg);
        }
        let mut merged: Vec<Message> = order
            .into_iter()
            .filter_map(|id| latest.remove(&id))
            .collect();
        if merged.len() > limit {
            merged = merged.split_off(merged.len() - limit);
        }
        merged
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
