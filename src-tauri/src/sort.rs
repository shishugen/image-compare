//! 图片归类：扫目录 → 按规则预演 → 移动 / 复制进子文件夹。
//!
//! 三段式，中间那段（`preview_sort`）必须**纯计算、零副作用**：用户先在界面上
//! 看清「哪张图会去哪」，点执行才真动文件。预览与执行共用同一份计划结构
//! （`SortPlanEntry`），执行时照计划里的 `src`/`dest_dir`/`final_name` 逐条落地，
//! 不存在「预览是一套、执行是另一套」的可能。
//!
//! 口径全部对齐现有实现，不另起炉灶：
//! - 什么算图片 → `lib.rs` 的 `IMAGE_EXTS` / `is_image_ext`（与浏览侧栏同一份）
//! - 一次最多扫多少 → `lib.rs` 的 `FOLDER_MAX_ITEMS`（不另设上限，两处表现一致好排查）
//! - 重名怎么办 → `net::server::unique_dest` 的 " (1)" " (2)" …（与收件箱/粘贴落盘同手感）
//! - 文件夹名能不能建 → `net::server::sanitize_component`（与批量目录名同规则）
//! - 移动后查看历史 → `history::rename_paths`（旧路径那条原地换新，不置顶不重排）

use crate::history;
use crate::lib_cmds;
use crate::net::server::{sanitize_component, unique_dest};
use crate::store::{self, Store};
use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::State;

/// 一次最多扫多少张：与浏览侧栏同一个闸门，上千张的目录不指望一口气铺完
const SORT_MAX_ITEMS: usize = lib_cmds::FOLDER_MAX_ITEMS;
/// 规则条数上限。够写一套「按年月 + 按格式 + 关键词」的方案了，再多界面也摆不下
const MAX_RULES: usize = 64;
/// 一次最多执行多少条。跟扫描上限一个数，预览多少就能执行多少
const MAX_PLAN_ENTRIES: usize = lib_cmds::FOLDER_MAX_ITEMS;

/* --------------------------------------------------------------------------
 * 数据结构：字段一律 snake_case 对外（全项目口径，见 lib.rs 的 ImagePayload 注释）
 * ------------------------------------------------------------------------ */

/// 扫描到的一张图。`mtime_ms` 用 i64：规则里的日期要按本地时区拆年月
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SortItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// 一条规则 = 两个条件（格式 AND 名称）+ 目标子文件夹名 + 本条的动作。
///
/// 按年月日的条件已拆（用户反馈：归类就认「格式 + 名称关键词」，日期列摆在
/// 规则行里只会把最常见的用法搅浑）；文件夹模板里的 `{yyyy}` `{MM}` 仍然可用，
/// 真要按年月分就在目标名上用模板。
///
/// 条件之间是 AND：`exts`/`name_glob` 里**填了的都要满足**，没填的当通配。
/// 命不上任何规则的图走 `fallthrough` 兜底文件夹。
///
/// **一张图可以命中多条规则**（如「07-细节.png」既进细节夹、又按关键词进别的夹），
/// 每条命中各生成一条计划；「动作」就决定这张图在这个落点是移走还是留底复制：
/// - `move`：移动到此夹。一张图只能被移走一次 —— 若它命中的多条 move 规则排到后面，
///   或本次整体选了「复制」，会自动降级成 copy。
/// - `copy`：复制到本条的文件夹，源文件留着（由别的规则或原处负责）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SortRule {
    /// 扩展名白名单（不含点，大小写都不判）；空 = 不限格式
    #[serde(default)]
    pub exts: Vec<String>,
    /// 文件名匹配：不含 `*` 按「包含」判，含 `*` 按通配判；大小写不敏感；空 = 不限
    #[serde(default)]
    pub name_glob: String,
    /// 目标子文件夹名，支持 `{yyyy}` `{MM}` `{格式}` 模板。留空时若 `name_glob` 是不含 `*`
    /// 的纯词，就用该词当文件夹名（「含红色」→ 红色夹）；两者都空 / 关键词含通配 = 原地不动
    #[serde(default)]
    pub folder: String,
    /// 本条命中的图怎么落：
    /// - `move`（默认）：移进本条的文件夹（自建或手填的）。
    /// - `copy`：在本条的文件夹留一份，源留着。
    /// - `spread`（复制到每个夹）：本条**不单独立夹**，命中的图（如「细节」「尺寸」）
    ///   各复制一份进本次会创建的**每一个文件夹**。
    /// 自定义反序列化收不进就回 move，老方案缺字段同样回 move
    #[serde(default)]
    pub action: String,
}

/// 预览算出的一条落点，也是执行的输入。
///
/// 执行只认 `action` 是 `move`/`copy` 的条目，`skip`/`hold` 原样带过不碰文件；
/// 界面上的「排除」就是把 action 改成 `hold`，重新预览会把它冲回计划值。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SortPlanEntry {
    pub src: String,
    /// 命中的规则下标；`None` = 兜底文件夹
    pub rule_index: Option<usize>,
    /// 已拼好的规则名（界面上好解释「为什么去这儿」，兜底那条是「其他」）
    pub rule_label: String,
    pub dest_dir: String,
    pub final_name: String,
    /// move / copy / skip（已在目标位置，重复执行幂等就靠它）/ hold（不参与）
    pub action: String,
}

/// 存进 prefs.json 的一套方案。`rules` 存 JSON 原文：规则的形态还在长
/// （EXIF、分辨率都还没接），结构体字段一动就得惦记老配置的迁移；这里是
/// **前端渲染 + Rust 反序列化**两份用途，用 `Value` 存原文最省事，
/// 预览时 `serde_json::from_value` 成 `SortRule`，反不出来就是方案坏了，报错给用户
///
/// Rust 侧不直接构造它（方案由前端写、prefs 层当不透明 JSON 整份存），所以标
/// dead_code：它存在的意义是把 sort_plans 那坨 JSON 的**契约形状**写在一处可读的地方，
/// 与 Preferences.sort_plans 的注释对读
#[allow(dead_code)]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SortPlan {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub rules: Vec<Value>,
    /// 目标根目录。空 = 用源目录（在前端自己的输入框里留空即可，不写死到方案里）
    #[serde(default)]
    pub target_root: String,
}

/* --------------------------------------------------------------------------
 * 一、扫描
 * ------------------------------------------------------------------------ */

/// 要拦的「一眼就是整个盘 / 整个系统」的目标。只比字符串太糙（大小写、尾斜杠、
/// 盘符写法），所以先归一成小写去尾斜杠再查
const BANNED_ROOTS: [&str; 6] = [
    "/", "/system", "/library", "/applications", "/windows", "/program files",
];

fn normalize_root(p: &str) -> String {
    p.trim().trim_end_matches(['/', '\\']).to_lowercase()
}

/// 危险路径判定：相对路径、空串、根目录与系统级目录一律拒。
///
/// 归类是批量改名移动，落点选错一下能洗掉半个用户目录，所以这里必须硬拒而
/// 不是「提示一下让用户自己小心」。窗口盘符根（`D:` / `D:\`）同样拒。
fn dangerous_root(raw: &str) -> bool {
    let p = Path::new(raw.trim());
    if raw.trim().is_empty() || !p.is_absolute() {
        return true;
    }
    let norm = normalize_root(raw);
    if norm.is_empty() {
        return true; // `D:\` 归一之后只剩盘符，也当根看
    }
    // 命中禁列本身，或挂在它下面一层都拒（/System/Volumes 这种也不能当落点）
    if BANNED_ROOTS.iter().any(|b| norm == *b || norm.starts_with(&format!("{b}/"))) {
        return true;
    }
    // 组件里出现 `..` 一律拒：它能让落点跑出用户预期的那棵树
    p.components()
        .any(|c| matches!(c, Component::ParentDir))
}

/// 列出待归类的图片。过滤口径与浏览侧栏一致：只本层或按需递归、只要图片、
/// 不要符号链接与 0 字节；递归时**跳过已经建在目标根里面的目录**（自我卷入）。
///
/// 返回的是「所有候选文件」，不在这里判规则 —— 判规则是 `preview_sort` 的事，
/// 改一条规则不该重新扫一遍盘。
pub fn scan_items(src: &str, recursive: bool, target_root: Option<&str>) -> Result<(Vec<SortItem>, bool), String> {
    let root = Path::new(src.trim());
    if src.trim().is_empty() || !root.is_absolute() {
        return Err(format!("源目录必须是绝对路径: {src}"));
    }
    if !root.is_dir() {
        return Err(format!("源目录不存在或不是目录: {}", root.display()));
    }
    // 目标根在源里时，那棵子树整个不参与扫描：不然第二次预览会把
    // 上一轮已经归好类的文件再归一遍类
    let inside = target_root
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(PathBuf::from)
        .filter(|t| t.starts_with(root));
    let mut out: Vec<SortItem> = Vec::new();
    let mut truncated = false;
    if recursive {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if truncated {
                break; // 已经到上限，不再展开剩下的子目录
            }
            if let Some(inner) = &inside {
                if dir.starts_with(inner) {
                    continue;
                }
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(err) => {
                    // 单个子目录读不开（权限、断线的外置盘）不该让整次扫描失败
                    eprintln!("[sort] 跳过读不了的目录 {}: {err}", dir.display());
                    continue;
                }
            };
            for entry in entries.flatten() {
                let p = entry.path();
                // 子目录入栈接着走；非图片、符号链接（file_type 不跟随）都跳过
                if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    stack.push(p);
                    continue;
                }
                if !lib_cmds::is_image_ext(&p) {
                    continue;
                }
                if out.len() >= SORT_MAX_ITEMS {
                    truncated = true;
                    break;
                }
                if let Some(it) = one_item(&p) {
                    out.push(it);
                }
            }
        }
    } else {
        let entries =
            std::fs::read_dir(root).map_err(|e| format!("读目录失败（{}）: {e}", root.display()))?;
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() || !lib_cmds::is_image_ext(&p) {
                continue;
            }
            if out.len() >= SORT_MAX_ITEMS {
                truncated = true;
                break;
            }
            if let Some(it) = one_item(&p) {
                out.push(it);
            }
        }
    }
    if truncated {
        eprintln!("[sort] 图片比 {SORT_MAX_ITEMS} 张还多，只处理扫到的这些");
    }
    Ok((out, truncated))
}

/// 一个文件 → 一条候选。0 字节与拿不到元信息的直接丢（预览里也不该出现）
fn one_item(p: &Path) -> Option<SortItem> {
    let meta = std::fs::symlink_metadata(p).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(SortItem {
        path: p.to_string_lossy().to_string(),
        name: p.file_name()?.to_string_lossy().to_string(),
        size: meta.len(),
        mtime_ms: mtime,
    })
}

/* --------------------------------------------------------------------------
 * 二、规则匹配
 * ------------------------------------------------------------------------ */

/// `*` 通配匹配（不含 `?`，界面上也不给，免得跟正则混）。大小写已在上游统一小写。
///
/// 自己写而不引 glob 库：这里只需要「整名匹配」，一条 split + 顺序消费就够，
/// 引库反而多一处依赖要跟着升
fn glob_match(pat: &str, name: &str) -> bool {
    let parts: Vec<&str> = pat.split('*').collect();
    if parts.len() == 1 {
        return name.contains(pat); // 没写 `*` 当「包含」判，界面上更好猜
    }
    let mut rest = name;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        match i {
            // 首段必须从头开始
            0 => {
                if !rest.starts_with(part) {
                    return false;
                }
                rest = &rest[part.len()..];
            }
            // 尾段必须到尾结束
            _ if i == parts.len() - 1 => {
                if !rest.ends_with(part) {
                    return false;
                }
                rest = &rest[..rest.len() - part.len()];
            }
            // 中间段按顺序找
            _ => {
                let idx = match rest.find(part) {
                    Some(k) => k,
                    None => return false,
                };
                rest = &rest[idx + part.len()..];
            }
        }
    }
    true
}

/// 修改日期拆成本地的 (年, 月, 日)。0 / 拿不到的时刻归成 (0,0,0)
///（只剩文件夹模板 `{yyyy}` `{MM}` 在用；规则条件里的日期已拆）
fn local_ymd(ms: i64) -> (i32, u32, u32) {
    if ms <= 0 {
        return (0, 0, 0);
    }
    match Local.timestamp_millis_opt(ms).single() {
        Some(dt) => (dt.year(), dt.month(), dt.day()),
        None => (0, 0, 0),
    }
}

/// 本条规则的扩展名口径：直接用 `lib_cmds::ext_of_name`（`jpe` 归一成 `jpg`），
/// 与扫描/预览两处共一份，不在此重写

/// 一条规则是否命中这张图：填了的条件（格式/名称）都要满足（AND），空的当通配
fn rule_matches(rule: &SortRule, item: &SortItem) -> bool {
    let ext = lib_cmds::ext_of_name(&item.name);
    if ext.is_empty() {
        return false; // 扫出来的都该有扩展名，真出现没后缀的就不归类了
    }
    if !rule.exts.is_empty() {
        let hit = rule
            .exts
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            // 界面上勾 png/jpg 时给的可能是 "png"，也可能带点，都认
            .any(|e| {
                let e = if e == "jpe" { "jpg".to_string() } else { e };
                e == ext
            });
        if !hit {
            return false;
        }
    }
    let pat = rule.name_glob.trim();
    if !pat.is_empty() {
        let low = pat.to_lowercase();
        if low.contains('*') {
            if !glob_match(&low, &item.name.to_lowercase()) {
                return false;
            }
        } else if !item.name.to_lowercase().contains(&low) {
            return false;
        }
    }
    true
}

/// 渲染目标文件夹名：`{yyyy}` `{MM}` `{格式}`。未知的花括号原样留着（用户手打的
/// 文案不该被静默吞掉），渲染完过一遍 `sanitize_component` 防穿越与非法字符
fn render_folder(tpl: &str, item: &SortItem) -> String {
    // 空模板直接回空（= 原地不动）：sanitize_component("") 会给 "_"，
    // 不短路就会悄悄建出一个 `_` 目录，把「留空不动」的语义吹掉
    let tpl = tpl.trim();
    if tpl.is_empty() {
        return String::new();
    }
    let ymd = local_ymd(item.mtime_ms);
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(k) = rest.find('{') {
        let (head, tail) = rest.split_at(k);
        out.push_str(head);
        match tail.strip_prefix('{') {
            Some(t) if t.contains('}') => {
                let var = &t[..t.find('}').unwrap()];
                match var.trim() {
                    "yyyy" => out.push_str(&if ymd.0 > 0 { ymd.0.to_string() } else { "未知".into() }),
                    "MM" => out.push_str(&if ymd.1 > 0 { format!("{:02}", ymd.1) } else { "未知".into() }),
                    "格式" => out.push_str(&{
                        let e = lib_cmds::ext_of_name(&item.name);
                        if e.is_empty() { "未知".into() } else { e.to_uppercase() }
                    }),
                    // 认不出的变量原样写出，界面上一眼能看见「{xxx} 没生效」
                    other => {
                        out.push('{');
                        out.push_str(other);
                        out.push('}');
                    }
                }
                rest = &t[t.find('}').unwrap() + 1..];
            }
            // 后半截没有 `}`：剩下的原样抄出去就收工
            _ => {
                out.push_str(tail);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    sanitize_component(&out)
}

/* --------------------------------------------------------------------------
 * 三、预览（纯计算）
 * ------------------------------------------------------------------------ */

/// 把前端传来的 JSON 规则反成结构体。反不出来就给明确的错，而不是
/// 悄悄按空规则跑一趟（那种表现是「方案存坏了但预览还能动」）
fn as_rules(rules: &[Value]) -> Result<Vec<SortRule>, String> {
    if rules.len() > MAX_RULES {
        return Err(format!("规则最多 {MAX_RULES} 条"));
    }
    rules
        .iter()
        .enumerate()
        .map(|(i, v)| {
            serde_json::from_value::<SortRule>(v.clone())
                .map_err(|e| format!("第 {} 条规则读不懂: {e}", i + 1))
        })
        .collect()
}

/// 规则动作归一：只有明确的 copy / spread 才特殊，其余（含缺字段的老方案）都当 move
fn rule_action(r: &SortRule) -> &'static str {
    match r.action.trim() {
        "copy" => "copy",
        "spread" => "spread",
        _ => "move",
    }
}

/// 规则把这张图送去哪个子夹：目标留空时，关键词是不含 `*` 的纯词就用它当夹名
fn rule_folder(r: &SortRule, item: &SortItem) -> String {
    let mut folder = render_folder(&r.folder, item);
    if folder.is_empty() {
        let kw = r.name_glob.trim();
        if !kw.is_empty() && !kw.contains('*') {
            folder = render_folder(kw, item);
        }
    }
    folder
}

/// 预览结果。`summary` 是给状态栏的一行话，前端不用自己再拼一遍口径
#[derive(Debug, Serialize)]
pub struct SortPreview {
    pub target_root: String,
    pub entries: Vec<SortPlanEntry>,
    pub summary: Value,
    pub warnings: Vec<String>,
}

/// 按规则算出每张图的落点。**没有任何副作用**：不建目录、不动文件。
///
/// 一张图会对照**全部**规则，命中的每条各生成一条落点（「07-细节.png」同时命中
/// 「细节→复制」和「png→移动」时，两个夹里都会出现它）。每条落点的 action 取自
/// 规则自己的动作：move 只能发生一次，同一张图排到后面的 move 自动降成 copy。
///
/// 计划里已经带上 `dest_dir`/`final_name`，执行只是照单落地；重名在同一次计划里
/// 就顺带避开（`used` 集合），落盘时再对磁盘上的实际文件避一次，两处都不覆盖。
pub fn build_preview(
    items: &[SortItem],
    rules: &[Value],
    src: &str,
    target_root: &str,
    fallthrough: &str,
) -> Result<SortPreview, String> {
    let src_dir = PathBuf::from(src.trim());
    if src.trim().is_empty() || !src_dir.is_absolute() {
        return Err(format!("源目录必须是绝对路径: {src}"));
    }
    // 目标根留空 = 在源目录里建子文件夹（最常见的用法）
    let root = {
        let t = target_root.trim();
        if t.is_empty() {
            src_dir.clone()
        } else {
            if dangerous_root(t) {
                return Err(format!("目标根目录太危险，已拒绝: {t}"));
            }
            PathBuf::from(t)
        }
    };
    if dangerous_root(&src_dir.to_string_lossy()) {
        return Err(format!("源目录太危险，已拒绝: {}", src_dir.display()));
    }
    let rules = as_rules(rules)?;
    // 兜底文件夹：留空 = **不兜底**，未命中的图原地不动（hold）。前端可以预填「其他」
    // 作为默认方案，但那是前端的选择，不在 Rust 里把空串当「其他」处理
    let fall = fallthrough.trim();
    let fall_name = if fall.is_empty() {
        String::new()
    } else {
        let s = sanitize_component(fall);
        // 原始名是纯非法字符（sanitize 后全下划线）也当没填，不建一个 `_` 目录
        if s.chars().all(|c| c == '_') {
            String::new()
        } else {
            s
        }
    };

    // 先算「会创建哪些文件夹」：move / copy（有目标）规则命中的落点。复制到每个夹
    // （spread）要把图各放一份进这些夹，所以得先知道它们。
    let mut folder_set: Vec<String> = Vec::new();
    {
        let mut seen = std::collections::HashSet::new();
        let mut any_unmatched = false;
        for item in items {
            let mut hit_any = false;
            for r in &rules {
                if !rule_matches(r, item) {
                    continue;
                }
                hit_any = true;
                if rule_action(r) == "spread" {
                    continue;
                }
                let folder = rule_folder(r, item);
                if folder.is_empty() {
                    continue;
                }
                let dest = root.join(&folder).to_string_lossy().to_string();
                if seen.insert(dest.clone()) {
                    folder_set.push(dest);
                }
            }
            if !hit_any {
                any_unmatched = true;
            }
        }
        // 兜底夹也是会建的文件夹，「复制到每个夹」也要进去一份
        if any_unmatched && !fall_name.is_empty() {
            let dest = root.join(&fall_name).to_string_lossy().to_string();
            if seen.insert(dest.clone()) {
                folder_set.push(dest);
            }
        }
    }

    let mut entries: Vec<SortPlanEntry> = Vec::with_capacity(items.len());
    let mut used: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    // 同一张图在同一个夹只排一条：多个关键词同时命中（如「尺寸」和「07」都命中
    // 07-尺寸.jpg）、或本夹规则与「复制到每个夹」落到同一夹时，不该再复制出 (1) 副本
    let mut planned_dest: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    let (mut to_move, mut to_copy, mut already) = (0usize, 0usize, 0usize);
    let warnings: Vec<String> = Vec::new();

    for item in items {
        // 命中全部规则而不是首条：一张图分进多个夹正是这套用法的本意
        let hits: Vec<usize> = rules
            .iter()
            .enumerate()
            .filter(|(_, r)| rule_matches(r, item))
            .map(|(i, _)| i)
            .collect();
        // 按动作拆开：move/copy 是本夹规则，spread 是「复制到每个夹」
        let own: Vec<usize> = hits
            .iter()
            .copied()
            .filter(|&k| rule_action(&rules[k]) != "spread")
            .collect();
        let spreads: Vec<usize> = hits
            .iter()
            .copied()
            .filter(|&k| rule_action(&rules[k]) == "spread")
            .collect();

        // 1) 本夹规则：move 收进本夹 / copy 在本夹留底。一张图只能被移走一次
        let mut moved_off = false;
        if !own.is_empty() {
            for k in &own {
                let folder = rule_folder(&rules[*k], item);
                let label = if folder.is_empty() {
                    format!("规则 {}（不动）", *k + 1)
                } else {
                    format!("规则 {}", *k + 1)
                };
                if folder.is_empty() {
                    entries.push(SortPlanEntry {
                        src: item.path.clone(),
                        rule_index: Some(*k),
                        rule_label: label,
                        dest_dir: String::new(),
                        final_name: String::new(),
                        action: "hold".into(),
                    });
                    continue;
                }
                let action = if rule_action(&rules[*k]) == "copy" || moved_off {
                    "copy"
                } else {
                    "move"
                };
                let dest_dir = root.join(&folder);
                // 同一张图同一个夹只留第一条（重复规则不再多算一条）
                if !planned_dest.insert((
                    item.path.clone(),
                    dest_dir.to_string_lossy().to_string(),
                )) {
                    continue;
                }
                let exact = dest_dir.join(&item.name);
                // 已经在计划落点上：重复执行幂等就靠这条判成 skip
                if Path::new(&item.path) == &exact {
                    already += 1;
                    entries.push(SortPlanEntry {
                        src: item.path.clone(),
                        rule_index: Some(*k),
                        rule_label: label,
                        dest_dir: dest_dir.to_string_lossy().to_string(),
                        final_name: item.name.clone(),
                        action: "skip".into(),
                    });
                    continue;
                }
                let final_path = pick_name(&dest_dir, &item.name, &mut used);
                if action == "move" {
                    to_move += 1;
                    moved_off = true;
                } else {
                    to_copy += 1;
                }
                entries.push(SortPlanEntry {
                    src: item.path.clone(),
                    rule_index: Some(*k),
                    rule_label: label,
                    dest_dir: dest_dir.to_string_lossy().to_string(),
                    final_name: final_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| item.name.clone()),
                    action: action.into(),
                });
            }
        } else if spreads.is_empty() {
            // 一条都没命中：兜底夹（move）/ 原地不动
            if fall_name.is_empty() {
                entries.push(SortPlanEntry {
                    src: item.path.clone(),
                    rule_index: None,
                    rule_label: String::new(),
                    dest_dir: String::new(),
                    final_name: String::new(),
                    action: "hold".into(),
                });
            } else {
                let dest_dir = root.join(&fall_name);
                let exact = dest_dir.join(&item.name);
                if Path::new(&item.path) == &exact {
                    already += 1;
                    entries.push(SortPlanEntry {
                        src: item.path.clone(),
                        rule_index: None,
                        rule_label: "兜底".to_string(),
                        dest_dir: dest_dir.to_string_lossy().to_string(),
                        final_name: item.name.clone(),
                        action: "skip".into(),
                    });
                } else {
                    let final_path = pick_name(&dest_dir, &item.name, &mut used);
                    to_move += 1;
                    entries.push(SortPlanEntry {
                        src: item.path.clone(),
                        rule_index: None,
                        rule_label: "兜底".to_string(),
                        dest_dir: dest_dir.to_string_lossy().to_string(),
                        final_name: final_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| item.name.clone()),
                        action: "move".into(),
                    });
                }
            }
        }

        // 2) 复制到每个夹：把这张图各复制一份进每一个会创建的文件夹（不单独立夹）
        for k in &spreads {
            let label = format!("规则 {}（复制到每个夹）", *k + 1);
            for dest in &folder_set {
                // 同一张图在同一个夹只复制一份：多个关键词都命中时不再出 (1) 副本，
                // 已经由本夹规则排过的落点也不再重复复制
                if !planned_dest.insert((item.path.clone(), dest.clone())) {
                    continue;
                }
                let dest_dir = Path::new(dest.as_str());
                let exact = dest_dir.join(&item.name);
                // 目标夹里已有同名文件：当已复制过，跳过（不再生成 (1) 副本）
                if exact.exists() {
                    already += 1;
                    entries.push(SortPlanEntry {
                        src: item.path.clone(),
                        rule_index: Some(*k),
                        rule_label: label.clone(),
                        dest_dir: dest.clone(),
                        final_name: item.name.clone(),
                        action: "skip".into(),
                    });
                    continue;
                }
                let final_path = pick_name(dest_dir, &item.name, &mut used);
                to_copy += 1;
                entries.push(SortPlanEntry {
                    src: item.path.clone(),
                    rule_index: Some(*k),
                    rule_label: label.clone(),
                    dest_dir: dest.clone(),
                    final_name: final_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| item.name.clone()),
                    action: "copy".into(),
                });
            }
        }
    }

    let hold = entries.iter().filter(|e| e.action == "hold").count();
    let folders = entries
        .iter()
        .filter(|e| e.action == "move" || e.action == "copy")
        .map(|e| e.dest_dir.clone())
        .collect::<std::collections::HashSet<_>>()
        .len();
    // `json!` 里值写成 `变量`而不是内联代码块：宏会把内层的 `{ }` 当嵌套对象解析
    let summary = serde_json::json!({
        "total": entries.len(),
        "move": to_move,
        "copy": to_copy,
        "actions": to_move + to_copy,
        "skip": already,
        "hold": hold,
        "folders": folders,
    });
    Ok(SortPreview {
        target_root: root.to_string_lossy().to_string(),
        entries,
        summary,
        warnings,
    })
}

/// 在同一次计划里避开已占用的落点名：先看磁盘上有没有，再看这一批里有没有别条占了
fn pick_name(dir: &Path, name: &str, used: &mut std::collections::HashSet<PathBuf>) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() && !used.contains(&first) {
        used.insert(first.clone());
        return first;
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..1000u32 {
        let cand = dir.join(format!("{stem} ({i}){ext}"));
        if !cand.exists() && !used.contains(&cand) {
            used.insert(cand.clone());
            return cand;
        }
    }
    let cand = dir.join(format!("{stem} ({}){ext}", store::now_ms()));
    used.insert(cand.clone());
    cand
}

/* --------------------------------------------------------------------------
 * 四、执行
 * ------------------------------------------------------------------------ */

/// 一条可回滚的落盘操作：move 记「原路径 → 新路径」，copy 记新副本路径（from 只作参考）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortUndoOp {
    /// move | copy
    pub kind: String,
    pub from: String,
    pub to: String,
}

/// 执行结果。失败的条目单列，不把整批失败掉 —— 归到一半因为某张图被占用而
/// 全退回，比如实报「49 成 1 败」糟得多
#[derive(Debug, Serialize)]
pub struct SortApplyResult {
    pub moved: usize,
    pub copied: usize,
    pub skipped: usize,
    pub failed: usize,
    /// `[{src, error}]`，前端原样铺进状态栏 / 结果区
    pub errors: Vec<Value>,
    /// 本次真正落盘的操作（撤销上一步用）；按执行顺序存，撤销时倒着来
    pub undo: Vec<SortUndoOp>,
}

/// 真正落地。`action` 只有 `move`/`copy` 会动文件，其余计数带过。
///
/// 每条落点的动作来自规则自己（一张图可有多条落点：首条 move 真的移走，
/// 同源的后续 copy 条从新位置补复制）。整体选了 `copy` 档时，所有 move 条目
/// 降级成 copy —— 那一档的承诺就是「源一个都不动」。
///
/// 移动用 rename，跨卷（比如从内置盘挪到外接盘）会失败，那时退成「复制 + 删源」，
/// 表现与移动一致；复制失败就直接记错，不偷偷删源文件。
/// 每条落盘前都验一遍 `dest_dir` 确实挂在本次的目标根下 —— 计划是前端传回来的，
/// 手改过的 `dest_dir` 不能让它写到别的盘去。
pub fn apply_plan(
    store: &Store,
    entries: &[SortPlanEntry],
    mode: &str,
    target_root: &str,
) -> Result<SortApplyResult, String> {
    if entries.len() > MAX_PLAN_ENTRIES {
        return Err(format!("一次最多执行 {MAX_PLAN_ENTRIES} 条"));
    }
    let root = PathBuf::from(target_root.trim());
    if target_root.trim().is_empty() || !root.is_absolute() || dangerous_root(target_root) {
        return Err(format!("目标根目录必须是安全的绝对路径: {target_root}"));
    }
    let wants_move = match mode {
        "move" => true,
        "copy" => false,
        other => return Err(format!("未知的执行方式: {other}")),
    };
    let mut r = SortApplyResult {
        moved: 0,
        copied: 0,
        skipped: 0,
        failed: 0,
        errors: Vec::new(),
        undo: Vec::new(),
    };
    // 移动过的 (旧路径, 新路径)，最后一次性修查看历史
    let mut relocations: Vec<(String, String)> = Vec::new();
    let mut used: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    // 本次真的被移走过的源：同源后续的 copy 条要靠它去新位置补复制，
    // 而不是对着已经空了的旧路径报「源文件不在」
    let mut moved_away: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for e in entries {
        // 整体选了「复制」档：move 条目全部按 copy 落地，源一个不动
        let action = if e.action == "move" && !wants_move { "copy" } else { e.action.as_str() };
        match action {
            "move" | "copy" => {}
            "skip" => {
                r.skipped += 1;
                continue;
            }
            _ => {
                r.skipped += 1;
                continue;
            }
        }
        // 没有落点的 move/copy 是坏条目（多半是界面把一张「未命中」的行误恢复成了移动）：
        // 它本来就没有要去的夹，记跳过而不是让整批失败。先于源存在性判，
        // 因为同批前面的条目可能已经把这张源搬走了
        if e.dest_dir.trim().is_empty() {
            eprintln!("[sort] 跳过没有落点的条目: {}", e.src);
            r.skipped += 1;
            continue;
        }
        // copy 条目遇上游已移走的源：改从新位置复制（那张图已经被这条计划搬走了）
        let real_src = if action == "copy" && !Path::new(&e.src).is_file() {
            match moved_away.get(&e.src) {
                Some(newer) => PathBuf::from(newer),
                None => {
                    r.failed += 1;
                    r.errors.push(serde_json::json!({ "src": e.src, "error": "源文件已经不在" }));
                    continue;
                }
            }
        } else {
            PathBuf::from(&e.src)
        };
        let src = real_src.as_path();
        if !src.is_file() {
            r.failed += 1;
            r.errors.push(serde_json::json!({ "src": e.src, "error": "源文件已经不在" }));
            continue;
        }
        let dir = Path::new(&e.dest_dir);
        if !dir.starts_with(&root) {
            r.failed += 1;
            r.errors.push(serde_json::json!({
                "src": e.src, "error": format!("落点不在目标根目录里: {}", e.dest_dir)
            }));
            continue;
        }
        if e.final_name.contains('/') || e.final_name.contains('\\') || e.final_name.is_empty() {
            r.failed += 1;
            r.errors.push(serde_json::json!({
                "src": e.src, "error": format!("非法文件名: {}", e.final_name)
            }));
            continue;
        }
        if let Err(err) = std::fs::create_dir_all(dir) {
            r.failed += 1;
            r.errors.push(serde_json::json!({ "src": e.src, "error": format!("建目录失败: {err}") }));
            continue;
        }
        // 落盘时再避一次：预览算的名字可能已经被界外的人占了（同步盘、别的窗口）
        let wanted = dir.join(&e.final_name);
        let dest = if (wanted.exists() || used.contains(&wanted)) && src != wanted {
            unique_dest(dir, &e.final_name)
        } else {
            wanted
        };
        used.insert(dest.clone());

        if src == dest {
            r.skipped += 1;
            continue;
        }
        // 已在正确位置（same path 判过了）之外，还要防「移动到自己的目录里」这种空操作
        let do_move = action == "move";
        let done: Result<(), String> = if do_move {
            match std::fs::rename(src, &dest) {
                Ok(()) => Ok(()),
                // 跨卷 rename 的 error kind 各平台不一样（mac/Linux 是 Uncategorized），
                // 判不准不如一律退成复制+删源：结果一样，只是慢一点
                Err(_) => std::fs::copy(src, &dest)
                    .and_then(|_| std::fs::remove_file(src))
                    .map_err(|err| format!("移动失败（退成复制也失败）: {err}")),
            }
        } else {
            std::fs::copy(src, &dest).map(|_| ()).map_err(|err| format!("复制失败: {err}"))
        };
        match done {
            Ok(()) => {
                if do_move {
                    r.moved += 1;
                    let 旧 = e.src.clone();
                    let 新 = dest.to_string_lossy().to_string();
                    moved_away.insert(旧.clone(), 新.clone());
                    relocations.push((旧.clone(), 新.clone()));
                    r.undo.push(SortUndoOp { kind: "move".into(), from: 旧, to: 新 });
                } else {
                    r.copied += 1;
                    r.undo.push(SortUndoOp {
                        kind: "copy".into(),
                        from: e.src.clone(),
                        to: dest.to_string_lossy().to_string(),
                    });
                }
            }
            Err(err) => {
                r.failed += 1;
                r.errors
                    .push(serde_json::json!({ "src": e.src, "error": err }));
            }
        }
    }
    // 移动后旧路径就空了：查看历史里那几条原地换成新路径，只换位置不改时刻
    if !relocations.is_empty() {
        if let Err(err) = history::rename_paths(store, &relocations) {
            eprintln!("[sort] 查看历史路径修正失败（文件已经归好类了）: {err}");
        }
    }
    Ok(r)
}

/// 撤销结果
#[derive(Debug, Serialize)]
pub struct SortUndoResult {
    /// move 条目移回原位的张数
    pub restored: usize,
    /// copy 条目删掉的副本数
    pub removed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub errors: Vec<Value>,
}

/// 撤销上一次执行：按 undo 记录倒着来 —— 复制出来的副本删掉，移走的移回原路径。
///
/// 安全边界与执行一致：`to` 必须在目标根下（防止改过的记录去删别的盘），
/// `from` 必须是安全的绝对路径；原位置已被占就换个不冲突的名字，绝不覆盖。
pub fn undo_plan(
    store: &Store,
    ops: &[SortUndoOp],
    target_root: &str,
) -> Result<SortUndoResult, String> {
    if ops.len() > MAX_PLAN_ENTRIES {
        return Err(format!("一次最多撤销 {MAX_PLAN_ENTRIES} 条"));
    }
    let root = PathBuf::from(target_root.trim());
    if target_root.trim().is_empty() || !root.is_absolute() || dangerous_root(target_root) {
        return Err(format!("目标根目录必须是安全的绝对路径: {target_root}"));
    }
    let mut r = SortUndoResult {
        restored: 0,
        removed: 0,
        skipped: 0,
        failed: 0,
        errors: Vec::new(),
    };
    let mut relocations: Vec<(String, String)> = Vec::new();
    // 撤销后可能空掉的目夹：只删空目录（非空删不掉，不会误伤文件）
    let mut touched_dirs: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    // 倒着撤：后落盘的先回滚，避免同一张图的多条落点互相踩
    for op in ops.iter().rev() {
        let to = PathBuf::from(&op.to);
        if !to.starts_with(&root) {
            r.failed += 1;
            r.errors.push(serde_json::json!({
                "src": op.to, "error": "超出目标根目录，拒绝撤销"
            }));
            continue;
        }
        if let Some(parent) = to.parent() {
            touched_dirs.insert(parent.to_path_buf());
        }
        match op.kind.as_str() {
            "copy" => {
                if !to.is_file() {
                    r.skipped += 1;
                    continue;
                }
                match std::fs::remove_file(&to) {
                    Ok(()) => r.removed += 1,
                    Err(err) => {
                        r.failed += 1;
                        r.errors
                            .push(serde_json::json!({ "src": op.to, "error": format!("删副本失败: {err}") }));
                    }
                }
            }
            "move" => {
                let from = PathBuf::from(&op.from);
                if op.from.trim().is_empty() || !from.is_absolute() || dangerous_root(&op.from) {
                    r.failed += 1;
                    r.errors
                        .push(serde_json::json!({ "src": op.to, "error": "原路径不合法，拒绝撤销" }));
                    continue;
                }
                if !to.is_file() {
                    r.skipped += 1;
                    continue;
                }
                if let Some(parent) = from.parent() {
                    if let Err(err) = std::fs::create_dir_all(parent) {
                        r.failed += 1;
                        r.errors.push(serde_json::json!({
                            "src": op.to, "error": format!("建原目录失败: {err}")
                        }));
                        continue;
                    }
                }
                // 原位置被后放的文件占了：换个不冲突的名字移回去，不覆盖
                let dest = if from.exists() {
                    let dir = from.parent().unwrap_or(Path::new("/"));
                    let name = from
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("restored");
                    unique_dest(dir, name)
                } else {
                    from.clone()
                };
                let done = match std::fs::rename(&to, &dest) {
                    Ok(()) => Ok(()),
                    Err(_) => std::fs::copy(&to, &dest)
                        .and_then(|_| std::fs::remove_file(&to))
                        .map_err(|err| format!("移回失败: {err}")),
                };
                match done {
                    Ok(()) => {
                        r.restored += 1;
                        relocations.push((op.to.clone(), dest.to_string_lossy().to_string()));
                    }
                    Err(err) => {
                        r.failed += 1;
                        r.errors.push(serde_json::json!({ "src": op.to, "error": err }));
                    }
                }
            }
            _ => r.skipped += 1,
        }
    }
    // 移回原位后，查看历史里的新路径也换回旧路径
    if !relocations.is_empty() {
        if let Err(err) = history::rename_paths(store, &relocations) {
            eprintln!("[sort] 撤销后历史路径修正失败（文件已经移回了）: {err}");
        }
    }
    // 收拾本次腾空的夹（上一步新建的那几个）：只删空的，非空目录不动
    for dir in touched_dirs {
        if dir != root && dir.starts_with(&root) {
            let _ = std::fs::remove_dir(&dir);
        }
    }
    Ok(r)
}

/* --------------------------------------------------------------------------
 * 五、命令
 * ------------------------------------------------------------------------ */

#[derive(Serialize)]
pub struct ScanOut {
    pub dir: String,
    pub items: Vec<SortItem>,
    pub truncated: bool,
}

/// 扫源目录。`truncated` 与浏览侧栏同口径：超上限时前端得说「只处理前 N 张」
#[tauri::command]
pub async fn scan_sort_dir(
    dir: String,
    recursive: Option<bool>,
    target_root: Option<String>,
) -> Result<ScanOut, String> {
    let root = PathBuf::from(dir.trim());
    let (items, truncated) = scan_items(&dir, recursive.unwrap_or(false), target_root.as_deref())?;
    Ok(ScanOut {
        dir: root.to_string_lossy().to_string(),
        items,
        truncated,
    })
}

/// 预览入参。`items` 由前端原样带回落盘后的结果，避免改一次规则就重扫一遍盘
#[derive(Deserialize)]
pub struct PreviewInput {
    pub src: String,
    #[serde(default)]
    pub target_root: String,
    #[serde(default)]
    pub rules: Vec<Value>,
    #[serde(default)]
    pub fallthrough: String,
    #[serde(default)]
    pub items: Vec<SortItem>,
}

#[tauri::command]
pub async fn preview_sort(input: PreviewInput) -> Result<SortPreview, String> {
    build_preview(
        &input.items,
        &input.rules,
        &input.src,
        &input.target_root,
        &input.fallthrough,
    )
}

/// 执行入参：`entries` 是预览回来那份，前端可能已经改过 action（排除 / 改判）
#[derive(Deserialize)]
pub struct ApplyInput {
    pub entries: Vec<SortPlanEntry>,
    /// move | copy
    pub mode: String,
    pub target_root: String,
}

#[derive(Serialize)]
pub struct ApplyOut {
    pub result: SortApplyResult,
    /// 顺手回一份新的查看历史，前端不用为了刷新侧栏再发一次 get_history
    pub history: crate::store::HistoryFile,
}

#[tauri::command]
pub async fn apply_sort(
    store: State<'_, Arc<Store>>,
    input: ApplyInput,
) -> Result<ApplyOut, String> {
    // 执行前再验一次 mode：命令是唯一动文件的地方，不能只靠前端按钮禁用
    if input.mode != "move" && input.mode != "copy" {
        return Err(format!("未知的执行方式: {:?}", input.mode));
    }
    let result = apply_plan(store.inner(), &input.entries, &input.mode, &input.target_root)?;
    Ok(ApplyOut {
        result,
        history: store.load_history(),
    })
}

/// 撤销入参：`ops` 就是 apply_sort 返回的 `result.undo`
#[derive(Deserialize)]
pub struct UndoInput {
    pub ops: Vec<SortUndoOp>,
    pub target_root: String,
}

#[derive(Serialize)]
pub struct UndoOut {
    pub result: SortUndoResult,
    pub history: crate::store::HistoryFile,
}

#[tauri::command]
pub async fn undo_sort(
    store: State<'_, Arc<Store>>,
    input: UndoInput,
) -> Result<UndoOut, String> {
    let result = undo_plan(store.inner(), &input.ops, &input.target_root)?;
    Ok(UndoOut {
        result,
        history: store.load_history(),
    })
}


/* --------------------------------------------------------------------------
 * 单测：命令层不测（要 tokio runtime），只测它们各自调用的同步纯函数
 * ------------------------------------------------------------------------ */
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn 临时目录(标签: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "imgcmp-sort-{标签}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("建临时目录");
        p
    }

    /// 建一张有内容的图（0 字节会被 one_item 丢），并把 mtime 钉到指定时刻
    fn 建图(p: &Path, mtime_ms: Option<i64>) {
        std::fs::write(p, b"\x89PNG fake bytes").expect("建图");
        if let Some(ms) = mtime_ms {
            let f = std::fs::OpenOptions::new().write(true).open(p).unwrap();
            f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(ms as u64))
                .unwrap();
        }
    }

    fn item(path: &str, name: &str, mtime_ms: i64) -> SortItem {
        SortItem {
            path: path.into(),
            name: name.into(),
            size: 10,
            mtime_ms,
        }
    }

    // 2026-03-15 12:00 本地（用来验日期规则与模板，用 Local 反推毫秒保证与实现同时区）
    fn 某时刻(y: i32, m: u32, d: u32) -> i64 {
        Local
            .with_ymd_and_hms(y, m, d, 12, 0, 0)
            .single()
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0)
    }

    /* ---- glob / 匹配 ---- */

    #[test]
    fn 通配与包含两种名称匹配() {
        assert!(glob_match("img_*.png", "IMG_10.PNG".to_lowercase().as_str()));
        assert!(!glob_match("img_*.png", "photo.png"));
        // 不含 * 当包含判
        assert!(glob_match("截图", "微信截图 2026.png".to_lowercase().as_str()));
        assert!(!glob_match("截图", "photo.png"));
        // 中间段
        assert!(glob_match("a*c", "abc"));
        assert!(glob_match("a*c", "aXXc"));
        assert!(!glob_match("a*c", "axx"));
    }

    #[test]
    fn 规则两个条件全满足才算命中() {
        let t = 某时刻(2026, 3, 15);
        let it = item("/s/a.png", "a.png", t);
        // 只按格式
        let r_ext: SortRule = serde_json::from_value(serde_json::json!({ "exts": ["png"], "folder": "图" })).unwrap();
        assert!(rule_matches(&r_ext, &it));
        let r_wrong_ext: SortRule =
            serde_json::from_value(serde_json::json!({ "exts": ["jpg"], "folder": "图" })).unwrap();
        assert!(!rule_matches(&r_wrong_ext, &it));
        // AND：格式对但关键词错 —— 不命中
        let r_and: SortRule = serde_json::from_value(serde_json::json!({
            "exts": ["png"], "name_glob": "红色", "folder": "图"
        }))
        .unwrap();
        assert!(!rule_matches(&r_and, &it), "填了的条件都要满足，名称不符即整体不命中");
        // 两个条件都对
        let r_ok: SortRule = serde_json::from_value(serde_json::json!({
            "exts": ["png"], "name_glob": "a", "folder": "图"
        }))
        .unwrap();
        assert!(rule_matches(&r_ok, &it));
        // 关键词命中不区分大小写
        let up = item("/s/A.PNG", "A.PNG", t);
        let r_low: SortRule =
            serde_json::from_value(serde_json::json!({ "name_glob": "a.", "folder": "图" })).unwrap();
        assert!(rule_matches(&r_low, &up));
        // 全空的规则命中一切（用户拿它当「所有图都进某夹」的总开关）
        let r_all: SortRule = serde_json::from_value(serde_json::json!({ "folder": "图" })).unwrap();
        assert!(rule_matches(&r_all, &it));
    }

    /* ---- 模板渲染 ---- */

    #[test]
    fn 文件夹名模板认三种变量并防穿越() {
        let t = 某时刻(2026, 3, 15);
        let it = item("/s/a.JPG", "a.JPG", t);
        assert_eq!(render_folder("{yyyy}-{MM}", &it), "2026-03");
        assert_eq!(render_folder("{格式}", &it), "JPG");
        // 未知变量原样留着，界面一眼能看出没生效
        assert_eq!(render_folder("{xx}", &it), "{xx}");
        // 路径分隔与冒号被 sanitize_component 削成单段名，拼到目标根下也跑不出去
        let evil = render_folder("../../etc/{yyyy}", &it);
        assert!(
            !evil.contains('/') && !evil.contains('\\'),
            "文件夹名不能带分隔符（否则就穿越了）：{evil}"
        );
        assert_eq!(
            Path::new(&evil).components().count(),
            1,
            "归一后必须是一个单段目录名：{evil}"
        );
    }

    /* ---- 危险路径 ---- */

    #[test]
    fn 危险的落点根被硬拒() {
        assert!(dangerous_root(""));
        assert!(dangerous_root("recv/今日")); // 相对
        assert!(dangerous_root("/")); // 归一后为空也算根
        assert!(dangerous_root("/System/Volumes")); // 命中系统目录前缀
        assert!(dangerous_root("/Users/x/Pictures/../../..")); // 带 ..
        assert!(!dangerous_root("/Users/x/Pictures"));
        assert!(!dangerous_root("/tmp/imgcmp-sort-x"));
    }

    /* ---- 预览（纯计算，不动盘）---- */

    #[test]
    fn 预览首条命中即归类未命中走兜底() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![
            item("/s/a.png", "a.png", t),
            item("/s/b.jpg", "b.jpg", t),
        ];
        let rules = vec![
            serde_json::json!({ "exts": ["png"], "folder": "png夹" }),
        ];
        let pv = build_preview(&items, &rules, "/s", "", "其他").unwrap();
        // target_root 留空 = 源目录本身
        assert_eq!(pv.target_root, "/s");
        let a = pv.entries.iter().find(|e| e.src == "/s/a.png").unwrap();
        assert_eq!(a.action, "move");
        assert_eq!(a.dest_dir, "/s/png夹");
        assert_eq!(a.final_name, "a.png");
        let b = pv.entries.iter().find(|e| e.src == "/s/b.jpg").unwrap();
        assert_eq!(b.dest_dir, "/s/其他", "没命中任何规则走兜底夹");
        assert_eq!(pv.summary["actions"], 2);
    }

    #[test]
    fn 已在目标位置的预览判成跳过而非再移() {
        let t = 某时刻(2026, 3, 15);
        // 文件已经在 png夹/a.png，规则也把它送去 png夹
        let items = vec![item("/s/png夹/a.png", "a.png", t)];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "png夹" })];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        assert_eq!(pv.entries[0].action, "skip", "重复执行幂等靠这条");
        assert_eq!(pv.summary["skip"], 1);
        assert_eq!(pv.summary["actions"], 0);
    }

    #[test]
    fn 兜底文件夹留空时未命中的原地不动() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![item("/s/b.jpg", "b.jpg", t)];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "png夹" })];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        assert_eq!(pv.entries[0].action, "hold", "既不命中也没兜底 = 不参与");
    }

    #[test]
    fn 预览拒绝危险的源与目标根() {
        let items = vec![item("/a.png", "a.png", 1)];
        // 目标根写成一个系统目录
        let e = build_preview(&items, &[], "/", "/System", "").unwrap_err();
        assert!(e.contains("危险"), "实际：{e}");
    }

    #[test]
    fn 一次计划内重名自动加后缀不互相覆盖() {
        let t = 某时刻(2026, 3, 15);
        // 两张同名不同目录的图都被送去同一个夹，落盘名要错开
        let items = vec![
            item("/s/x/a.png", "a.png", t),
            item("/s/y/a.png", "a.png", t),
        ];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "夹" })];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        let names: Vec<&str> = pv.entries.iter().map(|e| e.final_name.as_str()).collect();
        assert!(
            names.contains(&"a.png") && (names.contains(&"a (1).png")),
            "两条落点名要不同：{names:?}"
        );
    }

    #[test]
    fn 一张图命中多条规则各落点都出现且只移走一次() {
        let t = 某时刻(2026, 3, 15);
        // 用户要的就是这套：01-红色.png 既进「红色」（移走），又命中关键词进「细节」（复制）
        let items = vec![item("/s/01-红色.png", "01-红色.png", t)];
        let rules = vec![
            // 第 1 条：关键词红色 → 移动（缺 action 字段，老口径也是 move）
            serde_json::json!({ "name_glob": "红色", "folder": "红色" }),
            // 第 2 条：关键词 01 → 复制到「编号」
            serde_json::json!({ "name_glob": "01", "folder": "编号", "action": "copy" }),
            // 第 3 条：又一条 move —— 同一张图只能移走一次，这条必须降成 copy
            serde_json::json!({ "exts": ["png"], "folder": "全部png" }),
        ];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        let mine: Vec<&SortPlanEntry> = pv.entries.iter().filter(|e| e.src == "/s/01-红色.png").collect();
        assert_eq!(mine.len(), 3, "命中几条就该有几条落点");
        assert_eq!(mine[0].action, "move");
        assert_eq!(mine[0].dest_dir, "/s/红色");
        assert_eq!(mine[1].action, "copy", "规则写了 copy 就按 copy");
        assert_eq!(mine[1].dest_dir, "/s/编号");
        assert_eq!(mine[2].action, "copy", "已被前一条 move 移走，后续 move 自动降级");
        assert_eq!(pv.summary["move"], 1);
        assert_eq!(pv.summary["copy"], 2);
    }

    #[test]
    fn 目标留空时用关键词当文件夹名() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![
            item("/s/01-红色.png", "01-红色.png", t),
            item("/s/02-蓝色.png", "02-蓝色.png", t),
        ];
        // 两条规则都不填目标，只填关键词：应各自建出「红色」「蓝色」夹
        let rules = vec![
            serde_json::json!({ "name_glob": "红色" }),
            serde_json::json!({ "name_glob": "蓝色" }),
        ];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        let red = pv.entries.iter().find(|e| e.src == "/s/01-红色.png").unwrap();
        assert_eq!(red.action, "move");
        assert_eq!(red.dest_dir, "/s/红色", "留空目标应按关键词建夹");
        let blue = pv.entries.iter().find(|e| e.src == "/s/02-蓝色.png").unwrap();
        assert_eq!(blue.dest_dir, "/s/蓝色");
    }

    #[test]
    fn 目标与关键词都留空则不动() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![item("/s/a.png", "a.png", t)];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "" })];
        let pv = build_preview(&items, &rules, "/s", "", "其他").unwrap();
        // 既没目标也没关键词 = 命中了也原地不动，不能被兜底夹捡走（兜底只管未命中的）
        assert_eq!(pv.entries[0].action, "hold");
    }

    #[test]
    fn 目标留空且关键词带通配则不动() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![item("/s/IMG_001.png", "IMG_001.png", t)];
        // 通配关键词没法当文件夹名，目标又留空 —— 不动
        let rules = vec![serde_json::json!({ "name_glob": "IMG_*", "folder": "" })];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        assert_eq!(pv.entries[0].action, "hold");
    }

    #[test]
    fn 复制到每个夹的图进每个颜色夹且不自建夹() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![
            item("/s/01-粉色.png", "01-粉色.png", t),
            item("/s/02-灰色.png", "02-灰色.png", t),
            item("/s/05-细节.png", "05-细节.png", t),
        ];
        let rules = vec![
            serde_json::json!({ "name_glob": "粉色" }),
            serde_json::json!({ "name_glob": "灰色" }),
            // 细节不单独立夹，而是复制到本次会建的每个夹里
            serde_json::json!({ "name_glob": "细节", "action": "spread" }),
        ];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        assert_eq!(pv.summary["folders"], 2, "只建粉色/灰色两个夹");
        let detail: Vec<&SortPlanEntry> = pv
            .entries
            .iter()
            .filter(|e| e.src == "/s/05-细节.png")
            .collect();
        assert_eq!(detail.len(), 2, "细节要复制进每个夹");
        let dests: Vec<&str> = detail.iter().map(|e| e.dest_dir.as_str()).collect();
        assert!(
            dests.contains(&"/s/粉色") && dests.contains(&"/s/灰色"),
            "落点：{dests:?}"
        );
        assert!(detail.iter().all(|e| e.action == "copy"));
        assert!(
            !pv.entries.iter().any(|e| e.dest_dir == "/s/细节"),
            "细节不能自建夹"
        );
    }

    #[test]
    fn 多个复制关键词命中同一张图只复制一份() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![
            item("/s/01-粉色.png", "01-粉色.png", t),
            item("/s/07-尺寸.png", "07-尺寸.png", t),
        ];
        let rules = vec![
            serde_json::json!({ "name_glob": "粉色" }),
            // 尺寸与 07 都命中 07-尺寸.png：不该因此复制出 (1) 副本
            serde_json::json!({ "name_glob": "尺寸", "action": "spread" }),
            serde_json::json!({ "name_glob": "07", "action": "spread" }),
        ];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        let rows: Vec<&SortPlanEntry> = pv
            .entries
            .iter()
            .filter(|e| e.src == "/s/07-尺寸.png")
            .collect();
        assert_eq!(rows.len(), 1, "同一张图同一个夹只排一份：{rows:#?}");
        assert_eq!(rows[0].action, "copy");
        assert_eq!(rows[0].final_name, "07-尺寸.png", "不该出现 (1) 副本");
    }

    #[test]
    fn 本夹规则与复制到每个夹落到同一夹只留一条() {
        let t = 某时刻(2026, 3, 15);
        let items = vec![item("/s/07-尺寸.png", "07-尺寸.png", t)];
        let rules = vec![
            serde_json::json!({ "name_glob": "尺寸" }),
            serde_json::json!({ "name_glob": "尺寸", "action": "spread" }),
        ];
        let pv = build_preview(&items, &rules, "/s", "", "").unwrap();
        let dests: Vec<&str> = pv.entries.iter().map(|e| e.dest_dir.as_str()).collect();
        assert_eq!(
            dests,
            ["/s/尺寸"],
            "同一夹只能一条（移动进去就够了，不再复制）：{dests:?}"
        );
    }

    #[test]
    fn 复制到每个夹目标已有同名文件就跳过() {
        let base = 临时目录("spreadskip");
        let src = base.join("src");
        std::fs::create_dir_all(src.join("粉色")).unwrap();
        建图(&src.join("粉色").join("05-细节.png"), None);
        建图(&src.join("01-粉色.png"), None);
        let srcs = src.to_string_lossy().to_string();
        let items = vec![
            item(&format!("{srcs}/01-粉色.png"), "01-粉色.png", 1),
            item(&format!("{srcs}/05-细节.png"), "05-细节.png", 1),
        ];
        let rules = vec![
            serde_json::json!({ "name_glob": "粉色" }),
            serde_json::json!({ "name_glob": "细节", "action": "spread" }),
        ];
        let pv = build_preview(&items, &rules, &srcs, "", "").unwrap();
        let detail: Vec<&SortPlanEntry> = pv
            .entries
            .iter()
            .filter(|e| e.src.ends_with("05-细节.png"))
            .collect();
        assert_eq!(detail.len(), 1);
        assert_eq!(detail[0].action, "skip", "目标夹已有同名就跳过，不再生成 (1) 副本");
        assert_eq!(pv.summary["copy"], 0);
    }

    /* ---- 扫描 ---- */

    #[test]
    fn 扫描只收本层图片并跳过目标子树() {
        let base = 临时目录("scan");
        let src = base.join("src");
        std::fs::create_dir_all(src.join("内层")).unwrap();
        建图(&src.join("a.png"), None);
        建图(&src.join("b.TIFF"), None);
        std::fs::write(src.join("c.txt"), b"x").unwrap(); // 非图片
        std::fs::create_dir_all(src.join("已归类")).unwrap();
        建图(&src.join("已归类/d.jpg"), None); // 在目标根里，递归时要被跳过

        // 本层
        let (items, trunc) = scan_items(src.to_str().unwrap(), false, None).unwrap();
        let mut names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
        names.sort();
        assert_eq!(names, ["a.png", "b.TIFF"], "只留本层图片（大小写无关）");
        assert!(!trunc);

        // 递归 + 目标根在 src/已归类，那一子树整个不参与
        let (items2, _) = scan_items(
            src.to_str().unwrap(),
            true,
            Some(src.join("已归类").to_str().unwrap()),
        )
        .unwrap();
        assert!(
            items2.iter().all(|i| !i.path.contains("已归类")),
            "已经归类过的那棵子树不该再被扫进来"
        );
        assert!(items2.iter().any(|i| i.name == "d.jpg") == false);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 扫描拒绝相对源目录() {
        assert!(scan_items("src", false, None).is_err());
    }

    /* ---- 执行（真动文件）---- */

    #[test]
    fn 移动后源不在了目标在了且查看历史就地换新() {
        let base = 临时目录("apply-move");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let store = Store::new(data.clone());

        let one = src.join("a.png");
        建图(&one, Some(某时刻(2026, 3, 15)));
        // 预先把旧路径记进查看历史
        let 旧 = one.to_string_lossy().to_string();
        let mut h = store.load_history();
        h.record(&旧, 12345);
        store.save_history(&h).unwrap();

        let items = vec![item(&旧, "a.png", 某时刻(2026, 3, 15))];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "夹" })];
        let pv = build_preview(&items, &rules, src.to_str().unwrap(), "", "").unwrap();

        let r = apply_plan(
            &store,
            &pv.entries,
            "move",
            src.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(r.moved, 1);
        assert_eq!(r.failed, 0, "移动不该失败：{:#?}", r.errors);
        assert!(!one.exists(), "移动后源文件应不在了");
        assert!(src.join("夹").join("a.png").is_file(), "目标里应有这张");

        // 查看历史：旧路径没了、换新路径且时刻仍是 12345（不置顶不改时刻）
        let h2 = store.load_history();
        assert!(h2.items.iter().all(|i| i.path != 旧), "旧路径应被换掉");
        let 新 = h2.items.iter().find(|i| i.path == src.join("夹").join("a.png").to_string_lossy());
        assert!(新.is_some(), "历史里要能按新路径找到：{:#?}", h2.items);
        assert_eq!(新.unwrap().seen, 12345, "移动不改看过时刻");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 复制模式保留源文件且不动历史() {
        let base = 临时目录("apply-copy");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let store = Store::new(base.join("data"));
        std::fs::create_dir_all(store.dir.join("x")).unwrap();

        let one = src.join("a.png");
        建图(&one, Some(某时刻(2026, 3, 15)));
        let 旧 = one.to_string_lossy().to_string();
        let items = vec![item(&旧, "a.png", 某时刻(2026, 3, 15))];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "夹" })];
        let pv = build_preview(&items, &rules, src.to_str().unwrap(), "", "").unwrap();

        let r = apply_plan(&store, &pv.entries, "copy", src.to_str().unwrap()).unwrap();
        assert_eq!(r.copied, 1);
        assert!(one.exists(), "复制模式源必须还在");
        assert!(src.join("夹").join("a.png").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 同图多落点执行后源移走一次其余都是副本() {
        let base = 临时目录("apply-multi");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let store = Store::new(base.join("data"));

        let one = src.join("07-细节.png");
        建图(&one, Some(某时刻(2026, 3, 15)));
        let 旧 = one.to_string_lossy().to_string();
        let items = vec![item(&旧, "07-细节.png", 某时刻(2026, 3, 15))];
        let rules = vec![
            // 细节 → 复制（源留着）；png → 移动（真的移走）
            serde_json::json!({ "name_glob": "细节", "folder": "细节", "action": "copy" }),
            serde_json::json!({ "exts": ["png"], "folder": "全部png" }),
        ];
        let pv = build_preview(&items, &rules, src.to_str().unwrap(), "", "").unwrap();
        // 预览口径：先命中的是 copy，后一条才是 move —— 执行要能避开「copy 条遇上游移走」的坑
        let r = apply_plan(&store, &pv.entries, "move", src.to_str().unwrap()).unwrap();
        assert_eq!(r.failed, 0, "混合落点不该失败：{:#?}", r.errors);
        assert_eq!(r.moved, 1);
        assert_eq!(r.copied, 1);
        assert!(!one.exists(), "被 move 条移走后源不在");
        assert!(src.join("细节").join("07-细节.png").is_file(), "copy 条要在新位置留一份");
        assert!(src.join("全部png").join("07-细节.png").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 撤销复制删副本且撤销移动移回原处() {
        let base = 临时目录("undo");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let store = Store::new(base.join("data"));

        // copy：撤销后副本删掉、源还在
        let a = src.join("a.png");
        建图(&a, None);
        let items = vec![item(&a.to_string_lossy(), "a.png", 1)];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "复" })];
        let pv = build_preview(&items, &rules, src.to_str().unwrap(), "", "").unwrap();
        let r = apply_plan(&store, &pv.entries, "copy", src.to_str().unwrap()).unwrap();
        assert_eq!(r.undo.len(), 1);
        let copy_dest = r.undo[0].to.clone();
        assert!(Path::new(&copy_dest).is_file());
        let u = undo_plan(&store, &r.undo, src.to_str().unwrap()).unwrap();
        assert_eq!(u.removed, 1);
        assert!(!Path::new(&copy_dest).exists(), "副本应被删掉");
        assert!(a.is_file(), "源应还在");

        // move：撤销后移回原处
        let b = src.join("b.png");
        建图(&b, None);
        let items = vec![item(&b.to_string_lossy(), "b.png", 1)];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "移" })];
        let pv = build_preview(&items, &rules, src.to_str().unwrap(), "", "").unwrap();
        let r = apply_plan(&store, &pv.entries, "move", src.to_str().unwrap()).unwrap();
        assert_eq!(r.moved, 1);
        let moved_to = r.undo[0].to.clone();
        assert!(!b.exists() && Path::new(&moved_to).is_file());
        let u = undo_plan(&store, &r.undo, src.to_str().unwrap()).unwrap();
        assert_eq!(u.restored, 1);
        assert!(b.is_file(), "应移回原处");
        assert!(!Path::new(&moved_to).exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 撤销移动时原位置被占就换名不覆盖() {
        let base = 临时目录("undo-conflict");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let store = Store::new(base.join("data"));

        let a = src.join("a.png");
        建图(&a, None);
        let items = vec![item(&a.to_string_lossy(), "a.png", 1)];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "夹" })];
        let pv = build_preview(&items, &rules, src.to_str().unwrap(), "", "").unwrap();
        let r = apply_plan(&store, &pv.entries, "move", src.to_str().unwrap()).unwrap();
        assert_eq!(r.moved, 1);

        // 原位置又被新建了一张 a.png：撤回应另起名字，绝不覆盖
        std::fs::write(&a, b"new file occupies the old path").unwrap();
        let u = undo_plan(&store, &r.undo, src.to_str().unwrap()).unwrap();
        assert_eq!(u.failed, 0, "{:#?}", u.errors);
        assert_eq!(u.restored, 1);
        assert_eq!(
            std::fs::read(&a).unwrap(),
            b"new file occupies the old path",
            "原位置的文件不能被覆盖"
        );
        let pngs = std::fs::read_dir(&src)
            .unwrap()
            .filter(|e| {
                let p = e.as_ref().unwrap().path();
                p.extension().map(|x| x == "png").unwrap_or(false)
            })
            .count();
        assert!(pngs >= 2, "移回的那张应换个名字存在，实际只有 {pngs} 张");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 空落点的条目记跳过而其余照常建夹移动() {
        let base = 临时目录("apply-emptydest");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let store = Store::new(base.join("data"));

        let one = src.join("a.png");
        建图(&one, Some(某时刻(2026, 3, 15)));
        let 旧 = one.to_string_lossy().to_string();
        // 一条真实落点 + 一条空落点的坏条（旧 bug：未命中的行被点成 move）
        let entries = vec![
            SortPlanEntry {
                src: 旧.clone(),
                rule_index: Some(0),
                rule_label: "规则 1".into(),
                dest_dir: src.join("红色").to_string_lossy().to_string(),
                final_name: "a.png".into(),
                action: "move".into(),
            },
            SortPlanEntry {
                src: 旧.clone(),
                rule_index: None,
                rule_label: String::new(),
                dest_dir: String::new(),
                final_name: String::new(),
                action: "move".into(),
            },
        ];
        let r = apply_plan(&store, &entries, "move", src.to_str().unwrap()).unwrap();
        // 空落点不该把整批搞失败：它记跳过，另一条照常把文件夹建出来并移进去
        assert_eq!(r.failed, 0, "空落点不应算失败：{:#?}", r.errors);
        assert_eq!(r.moved, 1);
        assert_eq!(r.skipped, 1);
        assert!(src.join("红色").join("a.png").is_file(), "目标文件夹要真建出来并放进文件");
        assert!(!one.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 执行拒绝未知方式与越界落点() {
        let base = 临时目录("apply-guard");
        let store = Store::new(base.join("data"));
        // mode 非法
        assert!(apply_plan(&store, &[], "delete", base.to_str().unwrap()).is_err());
        // 目标根危险
        assert!(apply_plan(&store, &[], "move", "/").is_err());

        // 落点跑出目标根：dest_dir 不在 root 下要记为失败而不是写出去
        let 越界 = SortPlanEntry {
            src: base.join("x.png").to_string_lossy().to_string(),
            rule_index: Some(0),
            rule_label: "规则 1".into(),
            dest_dir: base.join("outside").to_string_lossy().to_string(),
            final_name: "x.png".into(),
            action: "move".into(),
        };
        // 根设成 base 的一个子目录，dest_dir 却在根之外
        let root = base.join("inside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join("x.png"), b"data").unwrap();
        let r = apply_plan(&store, std::slice::from_ref(&越界), "move", root.to_str().unwrap()).unwrap();
        assert_eq!(r.failed, 1, "落点不在目标根里的必须失败：{:#?}", r.errors);
        assert!(base.join("x.png").exists(), "越界条目被拦下，源文件不该被动");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 执行时落点名被占用则退回加后缀不覆盖() {
        let base = 临时目录("apply-collide");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let store = Store::new(base.join("data"));

        let one = src.join("a.png");
        建图(&one, Some(某时刻(2026, 3, 15)));
        // 目标夹里预先放一张同名图（模拟磁盘上已有）
        std::fs::create_dir_all(src.join("夹")).unwrap();
        建图(&src.join("夹").join("a.png"), None);

        let 旧 = one.to_string_lossy().to_string();
        let items = vec![item(&旧, "a.png", 某时刻(2026, 3, 15))];
        let rules = vec![serde_json::json!({ "exts": ["png"], "folder": "夹" })];
        let pv = build_preview(&items, &rules, src.to_str().unwrap(), "", "").unwrap();
        let r = apply_plan(&store, &pv.entries, "move", src.to_str().unwrap()).unwrap();
        assert_eq!(r.moved, 1);
        // 已存在的那张没被覆盖，新来的落到了 "a (1).png"
        assert!(src.join("夹").join("a (1).png").is_file(), "冲突时应加后缀：{:#?}", r.errors);
        let _ = std::fs::remove_dir_all(&base);
    }
}
