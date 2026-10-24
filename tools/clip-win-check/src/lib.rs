//! 壳工程：只为在 mac 上给 clip.rs 的 Windows 分支做一次真实的类型检查。
//! 正式工程的 build.rs（tauri-build → winres）在交叉到 windows 时必须要资源编译器，
//! 本机没有，所以这里用同样的依赖版本把 clip.rs 原样 include 进来，避开 build.rs。
#![allow(dead_code)]

use std::path::{Path, PathBuf};

pub mod store {
    use std::path::PathBuf;

    pub struct Store {
        pub dir: PathBuf,
    }

    impl Store {
        pub fn new(dir: PathBuf) -> Self {
            Self { dir }
        }
        pub fn pastebox_dir(&self) -> PathBuf {
            self.dir.join("pastebox")
        }
    }

    pub fn now_ms() -> i64 {
        0
    }

    /// 桩：只要类型对得上就行，壳工程不跑逻辑（正式实现走 sha2 crate）
    pub fn sha256_hex(_bytes: &[u8]) -> String {
        String::new()
    }
}

pub mod net {
    pub mod server {
        use super::super::*;

        pub(crate) fn unique_dest(_dir: &Path, name: &str) -> PathBuf {
            PathBuf::from(name)
        }

        pub(crate) fn sanitize_component(s: &str) -> String {
            s.to_string()
        }
    }
}

#[path = "../../../src-tauri/src/clip.rs"]
mod clip;
