//! 界面偏好的读写命令：布局（1/2/4 图）、同步开关、滚轮行为。
//!
//! 只有两条命令，因为这份数据很小、只有对比视图在用：前端启动时读一次，
//! 之后每次改动整体回写（`Store::save_prefs` 是原子写，崩了也不会留半截）。
//! 每一项都可选：只改布局时不会顺手把同步状态重置掉。

use crate::store::Store;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_prefs(store: State<'_, Arc<Store>>) -> Value {
    serde_json::to_value(store.load_prefs()).expect("Preferences 一定能序列化")
}

/// 局部更新：传进来的字段覆盖，没传的保持磁盘上的原值。
///
/// 参数名都是单词（`layout`/`sync`/`wheel`），不涉及 serde 的 camelCase 陷阱；
/// 值必须在 Rust 侧就验一遍 —— 前端拿不到一个它不认的布局，否则切到一个
/// 没有 CSS 的布局会让四个窗都不显示，比「设置没生效」难查得多。
#[tauri::command]
pub fn set_prefs(
    store: State<'_, Arc<Store>>,
    layout: Option<String>,
    sync: Option<bool>,
    wheel: Option<String>,
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
