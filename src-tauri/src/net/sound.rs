//! 收到对端消息时的那一声「叮」。
//!
//! 必须在 Rust 侧播，不能交给前端 `new Audio()`：
//! ① WKWebView 的 `mediaTypesRequiringUserActionForPlayback` 默认要求用户手势才播音视频，
//!    而 wry（0.57.1 `src/wkwebview/mod.rs`）只设了 `allowsInlineMediaPlayback`，没放开这一项 ——
//!    消息是后端 push 进来的，那一刻手上没有手势，播不播得看运气；
//! ② 窗口关掉之后前端根本不在场（macOS 上进程还活着），跟未读角标同一个道理。
//!
//! 两处都不引新依赖：mac 起一个 `afplay` 子进程（与 `reveal_in_folder` 里 `open` / `explorer`
//! 同一套打法），Windows 用系统提示音 `MessageBeep`。

/// mac 上的候选音效，按优先级排。精简过的系统可能没有 Tink，所以留两级兜底
const MAC_SOUNDS: [&str; 3] = [
    "/System/Library/Sounds/Tink.aiff",
    "/System/Library/Sounds/Ping.aiff",
    "/System/Library/Sounds/Glass.aiff",
];

/// 取第一个存在的候选。`exists` 做成参数是为了能拿临时目录单测（真实音效路径没法在 CI 里造）
pub fn first_existing<'a>(cands: &'a [&'a str], exists: &impl Fn(&str) -> bool) -> Option<&'a str> {
    cands.iter().copied().find(|p| exists(p))
}

/// 这一条该不该响。
///
/// 只有两个否决项：开关关了，以及这条与上一条是同一个 `msg_id`。后者不是多余的谨慎 ——
/// 发送端 retry 与离线补录会把同一条消息再投一遍，`append_message` 不去重（JSONL 后写覆盖
/// 前写，前端看着只有一条），但声音会实打实地叠起来。
pub fn should_play(enabled: bool, last_id: &str, id: &str) -> bool {
    enabled && !id.is_empty() && id != last_id
}

/// 播一声。`id` 只为了把「哪一条没放出声」对上号（日志里能接到那条消息上）。
/// 放不出声只打日志，绝不往上传输主链路抛错。
pub fn play(id: &str) {
    #[cfg(target_os = "macos")]
    {
        match first_existing(&MAC_SOUNDS, &|p| std::path::Path::new(p).exists()) {
            // afplay 在自己的进程里播完才退出，spawn 不等待，不会拖住落库那一步
            Some(sound) => {
                if let Err(e) = std::process::Command::new("afplay").arg(sound).spawn() {
                    eprintln!("[sound] 起 afplay 失败（{id}）: {e}");
                }
            }
            None => eprintln!("[sound] 没有可用的系统音效（{id}）"),
        }
    }
    #[cfg(target_os = "windows")]
    {
        // MB_ICONASTERISK = 「星号」事件音，跟着用户的系统提示音设置走，
        // 比我们自己塞一个 wav 更不容易出现「别人机器上怎么没声」。
        // ⚠️ 这两行在本机（macOS）编译不到，参数类型与返回值形态只能到 Windows 上实测
        use windows::Win32::UI::WindowsAndMessaging::{MessageBeep, MB_ICONASTERISK};
        // 返回值是 BOOL，且这条不影响任何后续动作：系统禁了提示音也不能当成传输失败
        if !unsafe { MessageBeep(MB_ICONASTERISK.0) }.as_bool() {
            eprintln!("[sound] MessageBeep 没响（{id}，系统提示音被关了？）");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = id;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn 音效候选按顺序取第一个存在的() {
        // 真实音效路径没法在 CI 里造，用临时目录里的文件名顶上同一套候选顺序
        let dir = std::env::temp_dir().join(format!("imgcmp-sound-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ping = dir.join("Ping.aiff");
        let glass = dir.join("Glass.aiff");
        std::fs::write(&glass, b"x").unwrap();
        let cands = [
            dir.join("Tink.aiff").to_string_lossy().to_string(),
            ping.to_string_lossy().to_string(),
            glass.to_string_lossy().to_string(),
        ];
        let refs: Vec<&str> = cands.iter().map(|s| s.as_str()).collect();
        let exists = |p: &str| Path::new(p).exists();
        // Tink 与 Ping 都不在，只能退到第三个
        assert_eq!(first_existing(&refs, &exists), Some(cands[2].as_str()));
        std::fs::write(&ping, b"x").unwrap();
        // 补上 Ping 之后就该是 Ping —— 前面的没被跳过，后面的也不会被抢先
        assert_eq!(first_existing(&refs, &exists), Some(cands[1].as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 一个候选都没有就当没有() {
        assert_eq!(first_existing(&[], &|_| true), None);
        assert_eq!(first_existing(&["/nope/a.aiff"], &|_| false), None);
    }

    #[test]
    fn 该不该响的三种否决() {
        assert!(should_play(true, "", "m1"), "第一条（没记过）要响");
        assert!(!should_play(false, "", "m1"), "开关关了不响");
        assert!(!should_play(true, "m1", "m1"), "同一条重发不重响");
        assert!(should_play(true, "m1", "m2"), "换了另一条照响");
        assert!(!should_play(true, "m1", ""), "空 id 不响，免得把没带上游的东西当成新消息");
    }
}
