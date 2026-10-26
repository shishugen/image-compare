//! 用户偏好的读写命令：布局（1/2/4 图）、同步开关、滚轮行为，
//! 以及传输视图的「本机接收」（提示音开关、收件目录）。
//!
//! 只有两条命令，因为这份数据很小：前端启动时读一次，之后每次改动整体回写
//! （`Store::save_prefs` 是原子写，崩了也不会留半截）。每一项都可选：只改布局时
//! 不会顺手把同步状态重置掉，传输那边改收件目录也不会冲掉对比视图的布局。

use crate::store::Store;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_prefs(store: State<'_, Arc<Store>>) -> Value {
    serde_json::to_value(store.load_prefs()).expect("Preferences 一定能序列化")
}

/// 收件目录的落地校验：空串回默认，非空必须是绝对路径且真能建出来。
///
/// 这一步必须在 Rust 做：落盘点位是「收到文件」这件事的地基，存下一个
/// 建不出来的目录，表现是对方一直传失败，比「设置没生效」难查十倍。
fn check_inbox(v: &str) -> Result<String, String> {
    if v.trim().is_empty() {
        return Ok(String::new());
    }
    let p = Path::new(v.trim());
    if !p.is_absolute() {
        return Err(format!("收件目录必须是绝对路径: {v}"));
    }
    std::fs::create_dir_all(p).map_err(|e| format!("创建 {} 失败: {e}", p.display()))?;
    let meta =
        std::fs::metadata(p).map_err(|e| format!("读不到 {} 的目录信息: {e}", p.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} 不是一个目录", p.display()));
    }
    Ok(p.to_string_lossy().to_string())
}

/// 局部更新：传进来的字段覆盖，没传的保持磁盘上的原值。
///
/// 参数名都是单词（`layout`/`sync`/`wheel`/`notify`/`inbox`），不涉及 serde 的 camelCase 陷阱；
/// 值必须在 Rust 侧就验一遍 —— 前端拿不到一个它不认的布局，否则切到一个
/// 没有 CSS 的布局会让四个窗都不显示，比「设置没生效」难查得多。
#[tauri::command]
pub fn set_prefs(
    store: State<'_, Arc<Store>>,
    layout: Option<String>,
    sync: Option<bool>,
    wheel: Option<String>,
    notify: Option<bool>,
    inbox: Option<String>,
) -> Result<Value, String> {
    let mut p = store.load_prefs();
    if let Some(l) = layout {
        p.layout = l;
    }
    if let Some(s) = sync {
        p.sync = s;
    }
    if let Some(w) = wheel {
        p.wheel = w;
    }
    if let Some(n) = notify {
        p.notify = n;
    }
    // 验不过就直接 Err 返回，磁盘上的旧值原封不动：半途改坏收件目录
    // 比拒绝这次修改危险得多
    if let Some(i) = inbox {
        p.inbox = check_inbox(&i)?;
    }
    // normalize 会静默把脏值改回默认，这里先显式拦住：设置点了没反应还不出错，
    // 是最难归因的一种失败
    if !matches!(p.layout.as_str(), "1" | "2" | "4") {
        return Err(format!("未知布局: {:?}", p.layout));
    }
    if p.wheel != "zoom" && p.wheel != "pan" {
        return Err(format!("未知滚轮行为: {:?}", p.wheel));
    }
    store.save_prefs(&p)?;
    Ok(serde_json::to_value(&p).expect("Preferences 一定能序列化"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 收件目录校验的几种结果() {
        // 空串 = 回默认，不是错误（「恢复默认」就是靠它）
        assert_eq!(check_inbox("").unwrap(), "");
        assert_eq!(check_inbox("   ").unwrap(), "");
        // 相对路径直接拒：它会相对进程当前目录去建，从 Finder 与从 cargo 启动不是一个地方
        assert!(check_inbox("recv/今日").is_err());

        let dir = std::env::temp_dir().join(format!("imgcmp-check-inbox-{}", std::process::id()));
        let got = check_inbox(&dir.to_string_lossy()).unwrap();
        assert_eq!(Path::new(&got), dir.as_path(), "合法路径原样收下");
        assert!(dir.is_dir(), "校验时就该把目录建出来，别等第一个文件扑空");
        // 已存在的是一个普通文件：建不出来也当不了落点
        let file = dir.join("不是目录.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(check_inbox(&file.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
