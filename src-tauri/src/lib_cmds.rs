//! 跨模块共用的「图片判定」小口径。
//!
//! 这些原先住在 lib.rs 的命令堆里，`sort.rs` 要复用同一份扩展名表与扫描上限 ——
//! 一个模块 import 另一个模块的私有 const 是拿不到的（`mod sort;` 在 lib.rs 里，
//! 但 const 得先有个公开的宿主）。与其在两处各写一份「什么算图片」（本项目已经
//! 因为三份 IMAGE_EXT 不一致踩过一次：同一张图在三个视图归到不同类），
//! 不如单独放一个叶子模块，谁都要它就 import 谁。
//!
//! 加新格式只改这一处：对话框过滤、目录浏览、mime 判定、归类扫描都跟着走。

/// 图片扩展名表：对话框过滤、目录浏览、mime 判定、归类扫描四处共用这一份。
/// 加新格式必须一次改齐（漏一处的表现是「侧栏列得出来、read_image 却回
/// application/octet-stream」，前端只报「解码失败」，排查成本极高）
pub const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg", "tif", "tiff",
];

/// 浏览列表里一个目录最多列多少张（一个目录上千张图时不指望把列表铺完）。
/// 归类扫描沿用同一个数：两处不一致的话，「侧栏看得见但归类漏了」极难排查
pub const FOLDER_MAX_ITEMS: usize = 2000;

pub fn is_image_ext(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            // 先看是不是原样就在表里，只在大小写不一致时才去 lower（多数路径不用分配）
            if IMAGE_EXTS.contains(&e) {
                return true;
            }
            let lower = e.to_ascii_lowercase();
            IMAGE_EXTS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

/// `jpe` 这种少见写法归一成 `jpg`，其余原样小写。规则判格式与模板 `{格式}` 共用
pub fn ext_of_name(name: &str) -> String {
    let raw = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if raw == "jpe" {
        "jpg".into()
    } else {
        raw
    }
}
