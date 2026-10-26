//! 壳工程：只为在 mac 上给 badge.rs 与 sound.rs 的 Windows 分支做一次真实的类型检查。
//! 正式工程的 build.rs（tauri-build → winres）交叉到 windows 时必须要资源编译器，
//! 本机没有，所以这里用同样的依赖版本把那两个文件原样 include 进来，避开 build.rs。
//!
//! 这两处的 windows 分支都只在 CI 的 windows job 里才会被编译：mac 的 job 全绿、
//! 而整个 run 因为 windows 那半挂掉时，Release 里只会剩一个资产 —— 这个壳就是为了让
//! 这种错误在本机就暴露出来。
#![allow(dead_code)]

#[path = "../../../src-tauri/src/net/sound.rs"]
mod sound;

#[path = "../../../src-tauri/src/net/badge.rs"]
mod badge;
