//! Dock / 任务栏上的未读角标。
//!
//! 未读数一共有三个显示位置：会话栏每行那个（前端早就有了）、「传输」导航按钮上的一个、
//! 以及图标上的这个。只有最后一个必须实现在 Rust 里 —— 前端驱动的版本在窗口关掉之后就
//! 没人算了（macOS 上关最后一个窗进程不退），角标会冻在最后那个数字上，比不出角标更误导人。
//!
//! 口径与 `Hub::sessions_json()` 完全同源：这个模块只把那份 payload 里的 `unread` 加起来，
//! 绝不自己再数一遍历史。「未标记」与补漏行在后端就被置成 0，这里自动继承。

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// 封顶，与侧栏会话行那套写法（`js/view-transfer.js` 里的 `s.unread > 99 ? "99+"`）保持一致
pub const BADGE_CAP: i64 = 99;

/// 会话列表里所有行的未读之和。
///
/// 载荷形态不对（没有 sessions、不是数组、行里缺 unread）一律当 0 —— 角标宁可不出，
/// 也不能把消息主链路带崩，这是收在 `emit_sessions()` 里的唯一理由之外的另一半职责。
pub fn badge_total(payload: &Value) -> i64 {
    payload
        .get("sessions")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.get("unread").and_then(Value::as_i64))
                .sum()
        })
        .unwrap_or_default()
}

/// 角标该显示什么：`None` = 清除；1..=99 = 数字；超过 99 = `99+`。
///
/// 单独拆出来是因为 macOS 的 `set_badge_label` 能显示 "99+"，而 Windows 的覆盖图标
/// 只能表达「有没有」——两边都调这一个函数，封顶规则就不会长成两套。
pub fn badge_label(total: i64) -> Option<String> {
    match total {
        t if t <= 0 => None,
        t if t <= BADGE_CAP => Some(t.to_string()),
        _ => Some(format!("{BADGE_CAP}+")),
    }
}

/// 把角标设成 total。
///
/// ⚠️ **只准在主线程调**。tauri 的 `set_badge_label` / `set_overlay_icon` 不会自己跳主线程，
/// 而底下 tao 的实现是 `MainThreadMarker::new_unchecked()`（unchecked，跳了就是未定义行为）。
/// 所以后台线程一律走 `Hub::emit_sessions()`，由它包好 `run_on_main_thread`；
/// 只有 `app.run(...)` 的事件回调里可以直接调（那个回调本身就在主线程上跑）。
pub fn apply_badge(app: &AppHandle, total: i64) {
    // 窗口已经没了（macOS 上关窗不退进程）就什么都不做：角标在关窗那一刻已被清零，
    // 此时没有窗口也就没有能点开的位置，宁可不出数字
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let label = badge_label(total);
    // 角标长在系统画的图标上，窗口关掉后就再也看不到它——留一句日志，出问题
    // 时不用盯着 Dock 猜「是没数字还是根本没算」
    eprintln!("[badge] 未读 {total} → 角标 {}", label.as_deref().unwrap_or("（无）"));
    #[cfg(target_os = "macos")]
    let r = w.set_badge_label(label);
    // Windows 任务栏只能贴一张覆盖图标、显示不了数字，所以 label 在这里只当「有没有」用
    #[cfg(target_os = "windows")]
    let r = w.set_overlay_icon(label.map(|_| overlay_dot()));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = w.set_badge_count(if label.is_some() { Some(total) } else { None });
    if let Err(e) = r {
        eprintln!("[badge] 设角标失败: {e}");
    }
}

/// Windows 的覆盖图标：现算一张 32×32 的红点带白描边。
///
/// 不引入 image crate、也不往仓库里塞第二个图标文件 —— `Image::new_owned` 收的就是
/// 行主序的 RGBA 裸字节。⚠️ 这条在本机（macOS）无法验证，只能到 Windows 上实测。
#[cfg(target_os = "windows")]
fn overlay_dot() -> tauri::image::Image<'static> {
    const S: u32 = 32;
    // 圆心取 15.5，正好落在像素中间，四边对称
    const C: f32 = (S as f32 - 1.0) / 2.0;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    for y in 0..S {
        for x in 0..S {
            let d = ((x as f32 - C).powi(2) + (y as f32 - C).powi(2)).sqrt();
            let px = ((y * S + x) * 4) as usize;
            if d <= 11.0 {
                rgba[px..px + 4].copy_from_slice(&[255, 77, 79, 255]);
            } else if d <= 13.0 {
                rgba[px..px + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
            // 圆外保持 alpha = 0，任务栏上才不会被看出一个方块底
        }
    }
    tauri::image::Image::new_owned(rgba, S, S)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 角标总数按行累加() {
        let payload = json!({
            "sessions": [
                { "id": "a", "unread": 2 },
                { "id": "b", "unread": 0 },
                { "id": "c", "unread": 7 }
            ],
            "active": "a"
        });
        assert_eq!(badge_total(&payload), 9);
    }

    #[test]
    fn 载荷形态不对一律当零() {
        // 没有 sessions / sessions 不是数组 / 行里没 unread / unread 不是数字
        assert_eq!(badge_total(&json!({})), 0);
        assert_eq!(badge_total(&json!({ "sessions": "x" })), 0);
        assert_eq!(badge_total(&json!({ "sessions": [{ "id": "a" }] })), 0);
        assert_eq!(badge_total(&json!({ "sessions": [{ "unread": "3" }] })), 0);
        assert_eq!(badge_total(&Value::Null), 0);
    }

    #[test]
    fn 角标文案的三个边界() {
        assert_eq!(badge_label(0), None);
        // 负数只可能来自被改坏的计数，同样按「清除」处理，不显示 -1
        assert_eq!(badge_label(-3), None);
        assert_eq!(badge_label(1), Some("1".into()));
        assert_eq!(badge_label(BADGE_CAP), Some("99".into()));
        assert_eq!(badge_label(BADGE_CAP + 1), Some("99+".into()));
    }
}
