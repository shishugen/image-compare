/* ==========================================================================
 * 系统剪贴板：粘贴进来 + 「作为文件复制」出去
 *
 * 为什么必须写在 Rust：WKWebView 递出来的 File 是 0 字节（lib.rs 里 pick_images
 * 的注释记着这条踩坑），paste 事件同样只能拿到名字与类型、拿不到内容。
 * 所以剪贴板只能在 Rust 侧读，好处是拿到的是**真实路径**：
 *   - Finder / 资源管理器里复制的文件、文件夹 → 直接就是原路径，不用复制一份
 *   - 截图、微信里复制的图片 → 剪贴板里只有位图数据，落盘成文件再当文件用
 *
 * 复制出去一次挂两味（跟微信自己的复制粘贴对齐）：文件 URL + 图片位图。
 * 粘进微信聊天框 / Word / 邮件正文拿到的是**图片本身**，粘进 Finder 仍是那个文件。
 * 位图那味只在「单项且解得出位图」时才有，非图片文件自动退化成纯文件形式。
 * ========================================================================== */

use std::path::PathBuf;

/// 单项粘贴落盘的字节上限。剪贴板位图走的是内存，正常截图远不到这个数；
/// 设上限是为了防住「复制了几百 MB 的 TIFF 全景图」这类把内存打满的情况。
const MAX_PASTE_BYTES: usize = 512 * 1024 * 1024;

/// 把剪贴板里的内容换成可用的文件路径。图片会先落到 pastebox/，返回的就是那些新文件。
/// 前端拿到路径后走的是**和拖拽完全一样**的下游路由，本模块不关心当前是哪个视图。
#[tauri::command]
pub async fn paste_paths(store: tauri::State<'_, std::sync::Arc<crate::store::Store>>) -> Result<Vec<String>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || paste_paths_inner(&store))
        .await
        .map_err(|e| format!("剪贴板任务被中断: {e}"))?
}

/// 把若干本机路径写进剪贴板。单个图片会额外带一份 PNG 位图，粘出去就是图；
/// 其余情况等价于在 Finder 里 ⌘C 这几个文件
#[tauri::command]
pub async fn copy_as_file(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有可复制的文件".into());
    }
    for p in &paths {
        if !PathBuf::from(p).exists() {
            return Err(format!("文件已不存在，无法复制: {p}"));
        }
    }
    tauri::async_runtime::spawn_blocking(move || copy_as_file_inner(paths))
        .await
        .map_err(|e| format!("剪贴板任务被中断: {e}"))?
}

/* --------------------------------------------------------------------------
 * 两个平台共用：把字节写成 pastebox 里的一个文件
 * ------------------------------------------------------------------------ */

/// 最近一次落盘的位图（内容 sha256 -> 文件路径）。只记一份，进程内有效。
static LAST_PASTE: std::sync::Mutex<Option<(String, PathBuf)>> = std::sync::Mutex::new(None);

/// 名字沿用收件箱那套清洗（含「截断也要保住扩展名」），重名自动加 “ (1)”。
/// 但**同一份剪贴板内容反复粘**（连着点几个空窗、又粘到另一个视图）不再造副本，
/// 直接复用上一次那个文件 —— 不然四次点击会生四份一模一样的图，看上去像“粘不上”。
fn save_bytes(store: &crate::store::Store, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("剪贴板里的内容是空的".into());
    }
    if bytes.len() > MAX_PASTE_BYTES {
        return Err(format!(
            "粘贴的内容过大（{:.0} MB），请改用拖拽或「选文件」",
            bytes.len() as f64 / 1024.0 / 1024.0
        ));
    }
    let hex = crate::store::sha256_hex(bytes);
    if let Ok(guard) = LAST_PASTE.lock() {
        if let Some((last_hex, last_path)) = guard.as_ref() {
            if *last_hex == hex && last_path.exists() {
                return Ok(last_path.clone());
            }
        }
    }
    let dir = store.pastebox_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建粘贴暂存目录失败: {e}"))?;
    let clean = crate::net::server::sanitize_component(name);
    let dest = crate::net::server::unique_dest(&dir, &clean);
    std::fs::write(&dest, bytes).map_err(|e| format!("写入 {} 失败: {e}", dest.display()))?;
    if let Ok(mut guard) = LAST_PASTE.lock() {
        *guard = Some((hex, dest.clone()));
    }
    Ok(dest)
}

fn path_to_string(p: &PathBuf) -> String {
    p.to_string_lossy().to_string()
}

/// file:// URL → 本机路径。自己写而不用系统 API，是为了能真接单测（中文、空格、
/// 非法转义这些分岔在剪贴板里每天都碰到）。
/// 只处理普通本地路径：带 host 的 smb/网络盘、非 file 的 scheme 一律返回 None。
fn decode_file_url(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix("file://")?;
    // file://localhost/Users/... 这种写法偶尔会出现
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // % 后必须跟两个十六进制位，否则当作普通字符（不把整段否定掉）
            let hi = bytes.get(i + 1).and_then(|c| char::from(*c).to_digit(16));
            let lo = bytes.get(i + 2).and_then(|c| char::from(*c).to_digit(16));
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                }
                _ => {
                    out.push(b'%');
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let path = String::from_utf8(out).ok()?;
    if path.is_empty() || path == "/" {
        return None;
    }
    Some(path)
}

/* --------------------------------------------------------------------------
 * macOS
 * ------------------------------------------------------------------------ */

#[cfg(target_os = "macos")]
mod platform {
    use super::{decode_file_url, path_to_string, save_bytes};
    use crate::store::Store;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSArray, NSData, NSString};
    use std::path::PathBuf;

    /// NSPasteboard 的类型名本来就是普通 UTI 字符串，直接自己构造，
    /// 省得去引 app-kit 的 extern 常量（那要额外开一堆 feature）
    fn ty(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    /// 拿共享剪贴板。generalPasteboard 返回的是单例（+0），所以用 retain 而不是
    /// retain_autoreleased；下面那些返回 +0 的读取方法才走 autoreleased
    unsafe fn pasteboard() -> Option<Retained<AnyObject>> {
        let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        Retained::retain(pb)
    }

    /// 调用一个返回 +0/autoreleased 对象的方法并安全接管
    unsafe fn owned(ptr: *mut AnyObject) -> Option<Retained<AnyObject>> {
        Retained::retain_autoreleased(ptr)
    }

    /// 某个类型在本机剪贴板上的数据；没有该类型时系统返回 nil
    unsafe fn data_for_type(pb: &AnyObject, name: &str) -> Option<Retained<NSData>> {
        let key = ty(name);
        let ptr: *mut NSData = msg_send![pb, dataForType: &*key];
        Retained::retain_autoreleased(ptr)
    }

    /// TIFF/PNG 等压缩位图 → PNG。走系统的 NSBitmapImageRep，Rust 侧一个解码器都不引
    /// （Cargo.toml 里特意关掉了 arboard 的图片特性，就是为了不把 image 整套拖进来）。
    /// 转换失败返回 None，调用方按原类型落盘。
    unsafe fn convert_to_png(data: &NSData) -> Option<Vec<u8>> {
        let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: data];
        let rep = owned(rep)?;
        // NSPNGFileType == 4；properties 传 nil 用默认值
        let png: *mut NSData = msg_send![
            &*rep,
            representationUsingType: 4usize,
            properties: std::ptr::null::<AnyObject>()
        ];
        let png = Retained::retain_autoreleased(png)?;
        let bytes = png.to_vec();
        if bytes.is_empty() {
            return None;
        }
        Some(bytes)
    }

    /// 从一个 pasteboard item 里抠出 file URL 的文本。
    /// 先试 stringForType:；但有些来源只把 public.file-url 当**数据**给
    /// （stringForType: 直接返回 nil），旧写法在那种情况下会误判成「剪贴板里没有文件」，
    /// 退回去存那张文件图标位图 —— 所以再按 UTF-8 解一次 data。
    unsafe fn file_url_text(item: &AnyObject, key: &NSString) -> Option<String> {
        let s: *mut NSString = msg_send![item, stringForType: key];
        if let Some(text) = Retained::retain_autoreleased(s) {
            let t = text.to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
        let p: *mut NSData = msg_send![item, dataForType: key];
        let data = Retained::retain_autoreleased(p)?;
        String::from_utf8(data.to_vec()).ok()
    }

    /// 把「按文件 ID 寻址」的 file URL（`file:///.file/id=6571367.105483633`）转成普通路径。
    /// Finder 在 iCloud 同步盘 / 「优化 Mac 存储」下就写这种 URL，直接取 path 会得到
    /// `/.file/id=…` 这个根本不存在的路径，于是被误判成「剪贴板里没有文件」。
    /// NSURL 的 filePathURL 就是专门做这个转换的（它返回的已是解好码的文件系统路径）。
    unsafe fn resolve_id_url(text: &str) -> Option<String> {
        let s = NSString::from_str(text);
        let url: *mut AnyObject = msg_send![class!(NSURL), URLWithString: &*s];
        let url = Retained::retain_autoreleased(url)?;
        let path_url: *mut AnyObject = msg_send![&*url, filePathURL];
        let path_url = Retained::retain_autoreleased(path_url)?;
        let p: *mut NSString = msg_send![&*path_url, path];
        let p = Retained::retain_autoreleased(p)?;
        let out = p.to_string();
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    /// file:// URL 文本 → 存在的本机路径（解不开或文件已不在就跳过这一条）
    fn push_path(out: &mut Vec<PathBuf>, text: &str) {
        // ID URL 转完就是现成的文件系统路径，不能再走一遍百分号解码
        if text.contains("/.file/id=") {
            if let Some(p) = unsafe { resolve_id_url(text) } {
                let path = PathBuf::from(p);
                if path.exists() {
                    out.push(path);
                }
            }
            return;
        }
        if let Some(p) = decode_file_url(text) {
            let path = PathBuf::from(p);
            if path.exists() {
                out.push(path);
            }
        }
    }

    /// 最后一道兜底：`NSFilenamesPboardType`。它确实是废弃了的类型，
    /// 但 Finder 至今仍然会写一份，而且内容就是**已解码的 POSIX 路径列表**，
    /// 在 ID URL 都解不动的情况下仍能拿到真路径（整个 plist 就是一个字符串数组）。
    unsafe fn nsfilenames_paths(pb: &AnyObject) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Some(data) = data_for_type(pb, "NSFilenamesPboardType") else {
            return out;
        };
        // propertyListWithData:options:format:error: —— format 与 error 都不关心，给空指针
        let list: *mut AnyObject = msg_send![class!(NSPropertyListSerialization),
            propertyListWithData: &*data, options: 0usize,
            format: std::ptr::null_mut::<std::ffi::c_void>(),
            error: std::ptr::null_mut::<std::ffi::c_void>()];
        let Some(list) = Retained::retain_autoreleased(list) else {
            return out;
        };
        let n: usize = msg_send![&*list, count];
        for i in 0..n {
            let s: *mut NSString = msg_send![&*list, objectAtIndex: i];
            let Some(s) = Retained::retain_autoreleased(s) else { continue };
            let path = PathBuf::from(s.to_string());
            if path.exists() {
                out.push(path);
            }
        }
        out
    }

    /// 读剪贴板里的文件/文件夹路径。
    /// 逐个 pasteboardItem 取 public.file-url（一个 item 一个文件，多选也拿得全）；
    /// 一条都没拿到时先兜一次 pasteboard 级的 public.file-url（单文件复制时
    /// 有些应用只往这一层写），再兜一次 NSFilenamesPboardType（Finder 的 ID URL 情形靠它）。
    unsafe fn file_url_paths(pb: &AnyObject) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let key = ty("public.file-url");
        let items: *mut NSArray<AnyObject> = msg_send![pb, pasteboardItems];
        if let Some(items) = Retained::retain_autoreleased(items) {
            for item in items.iter() {
                if let Some(text) = file_url_text(&item, &key) {
                    push_path(&mut out, &text);
                }
            }
        }
        if out.is_empty() {
            if let Some(d) = data_for_type(pb, "public.file-url") {
                if let Ok(text) = String::from_utf8(d.to_vec()) {
                    push_path(&mut out, &text);
                }
            }
        }
        if out.is_empty() {
            out.extend(nsfilenames_paths(pb));
        }
        out
    }

    pub fn paste_paths(store: &Store) -> Result<Vec<String>, String> {
        unsafe {
            let pb = pasteboard().ok_or("系统剪贴板不可用")?;

            // 1) 文件/文件夹优先：能拿到原路径就一份都不复制
            let files = file_url_paths(&pb);
            if !files.is_empty() {
                return Ok(files.iter().map(path_to_string).collect());
            }

            // 2) 图片：PNG 直接用；只有 TIFF（⌘⇧4 截图进剪贴板就是这个）时转成 PNG
            if let Some(png) = data_for_type(&pb, "public.png") {
                let bytes = png.to_vec();
                let name = paste_image_name("png");
                return Ok(vec![path_to_string(&save_bytes(store, &name, &bytes)?)]);
            }
            if let Some(tiff) = data_for_type(&pb, "public.tiff") {
                if let Some(png) = convert_to_png(&tiff) {
                    let name = paste_image_name("png");
                    return Ok(vec![path_to_string(&save_bytes(store, &name, &png)?)]);
                }
                // 转不动就原样存 TIFF：macOS 的 WKWebView 能画它，
                // 至多是发到 Windows 那边缩略图显示不出来，总比整件事失败好
                let bytes = tiff.to_vec();
                let name = paste_image_name("tiff");
                return Ok(vec![path_to_string(&save_bytes(store, &name, &bytes)?)]);
            }

            Err("剪贴板里没有文件或图片".into())
        }
    }

    /// 截图没有名字，给一个带时间戳的可读名；重复粘贴靠 unique_dest 加序号，不会撞
    fn paste_image_name(ext: &str) -> String {
        format!("剪贴板图片-{}.{}", crate::store::now_ms(), ext)
    }

    /// 给单个图片造一个只带 public.png 的剪贴板项目。
    /// 解码依旧走系统的 NSBitmapImageRep（Rust 侧不引图片解码库），解不出就返回 None，
    /// 调用方按「只有文件」处理。超过 40MB 的直接跳过：那种图转一次 PNG 的内存代价不值。
    unsafe fn png_item(path: &str) -> Option<Retained<AnyObject>> {
        const MAX_CLIP_IMAGE_BYTES: u64 = 40 * 1024 * 1024;
        let bytes = std::fs::read(path).ok()?;
        if bytes.len() as u64 > MAX_CLIP_IMAGE_BYTES {
            return None;
        }
        let data = NSData::from_vec(bytes);
        let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: &*data];
        let rep = owned(rep)?;
        // NSBitmapImageFileType 里 PNG == 4（TIFF/BMP/GIF/JPEG/PNG/JP2 依次 0~5）
        let png: *mut NSData = msg_send![
            &*rep,
            representationUsingType: 4usize,
            properties: std::ptr::null::<AnyObject>()
        ];
        let png = Retained::retain_autoreleased(png)?;
        if png.length() == 0 {
            return None;
        }
        let raw: *mut AnyObject = msg_send![class!(NSPasteboardItem), alloc];
        let raw: *mut AnyObject = msg_send![raw, init];
        let item = Retained::retain(raw)?;
        let key = ty("public.png");
        let ok: bool = msg_send![&*item, setData: &*png, forType: &*key];
        if !ok {
            return None;
        }
        Some(item)
    }

    /// 用 NSURL 写进剪贴板：writeObjects 会让系统自己处理多文件与书签，
    /// 粘到 Finder / 微信时就是「复制了这几个文件」；
    /// 单项且是图片时，再多挂一个只带 public.png 的 item，两味并存
    pub fn copy_as_file(paths: Vec<String>) -> Result<(), String> {
        unsafe {
            let pb = pasteboard().ok_or("系统剪贴板不可用")?;
            let mut urls: Vec<Retained<AnyObject>> = Vec::with_capacity(paths.len());
            for p in &paths {
                let s = NSString::from_str(p);
                let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*s];
                // fileURLWithPath 是工厂方法，返回的是 autoreleased 对象
                match owned(url) {
                    Some(o) => urls.push(o),
                    None => return Err(format!("路径转 URL 失败: {p}")),
                }
            }
            // writeObjects 会把多个对象的类型取并集，同类型冲突时后写的赢 ——
            // 这里 NSURL 只出 public.file-url、item 只出 public.png，不冲突
            if paths.len() == 1 {
                if let Some(item) = png_item(&paths[0]) {
                    urls.push(item);
                }
            }
            let arr = NSArray::from_retained_slice(&urls);
            // clearContents 返回可写入的项目数，0 说明剪贴板被别的应用锁着
            let n: isize = msg_send![&*pb, clearContents];
            if n == 0 {
                return Err("剪贴板被其它应用占用，写入失败（重试一次通常就好）".into());
            }
            let ok: bool = msg_send![&*pb, writeObjects: &*arr];
            if !ok {
                return Err("写入剪贴板失败".into());
            }
            Ok(())
        }
    }
}

/* --------------------------------------------------------------------------
 * Windows
 * ------------------------------------------------------------------------ */

#[cfg(target_os = "windows")]
mod platform {
    use super::{path_to_string, save_bytes};
    use crate::store::Store;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    // 下面的调用全部成对约束在同一线程：OpenClipboard 与 CloseClipboard 必须同线程，
    // 所以整个函数在同一个 spawn_blocking 任务里做完，CloseGuard 负责任何提前返回都关掉
    struct CloseGuard;
    impl Drop for CloseGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    use windows::Win32::Foundation::{GlobalFree, HGLOBAL, HANDLE};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows::Win32::System::Ole::{CF_DIB, CF_HDROP, CLIPBOARD_FORMAT};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// 剪贴板这几个接口的 format 参数是裸 u32，CF_* 常量却是 CLIPBOARD_FORMAT(u16)，
    /// 在这里统一换算，免得每处都写一遍 .0 as u32
    fn fmt_of(f: CLIPBOARD_FORMAT) -> u32 {
        f.0 as u32
    }

    /// 把某个格式的数据整体拷出来。锁着的内存归剪贴板所有，返回前必须复制走
    unsafe fn clip_bytes(format: u32) -> Option<Vec<u8>> {
        if IsClipboardFormatAvailable(format).is_err() {
            return None;
        }
        let handle: HANDLE = GetClipboardData(format).ok()?;
        if handle.is_invalid() {
            return None;
        }
        let mem = HGLOBAL(handle.0);
        let ptr = GlobalLock(mem) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let out = std::slice::from_raw_parts(ptr, GlobalSize(mem)).to_vec();
        let _ = GlobalUnlock(mem);
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    pub fn paste_paths(store: &Store) -> Result<Vec<String>, String> {
        unsafe {
            OpenClipboard(None).map_err(|e| format!("打开剪贴板失败: {e}"))?;
            let _guard = CloseGuard;

            // 1) 资源管理器里复制的文件/文件夹：CF_HDROP，拿到就是原路径
            let mut out = Vec::new();
            if let Ok(handle) = GetClipboardData(fmt_of(CF_HDROP)) {
                let hdrop = HDROP(handle.0);
                // 不传缓冲区问总数，传缓冲区取第 i 条
                let count = DragQueryFileW(hdrop, u32::MAX, None) as usize;
                for i in 0..count as u32 {
                    let mut buf = vec![0u16; 4096];
                    let n = DragQueryFileW(hdrop, i, Some(&mut buf)) as usize;
                    if n == 0 {
                        continue;
                    }
                    buf.truncate(n);
                    let path = PathBuf::from(OsString::from_wide(&buf));
                    if path.exists() {
                        out.push(path_to_string(&path));
                    }
                }
            }
            if !out.is_empty() {
                return Ok(out);
            }

            // 2) 位图：CF_DIB 就是 BITMAPINFOHEADER + 像素，拼上文件头存成 BMP，
            //    本应用能显示（mime_of 认 bmp）、对端也收得到完整文件
            if let Some(dib) = clip_bytes(fmt_of(CF_DIB)) {
                if dib.len() < 16 {
                    return Err("剪贴板里的位图数据不完整".into());
                }
                // BITMAPFILEHEADER：'B''M' + 总长 + 保留 + 像素偏移
                let total = (14 + dib.len()) as u32;
                let header_len = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]) as usize;
                let mut bytes: Vec<u8> = Vec::with_capacity(14 + dib.len());
                bytes.extend_from_slice(b"BM");
                bytes.extend_from_slice(&total.to_le_bytes());
                bytes.extend_from_slice(&[0u8; 4]);
                bytes.extend_from_slice(&((14 + header_len + dib_pixel_extra(&dib, header_len)) as u32).to_le_bytes());
                bytes.extend_from_slice(&dib);
                let name = format!("剪贴板图片-{}.bmp", crate::store::now_ms());
                return Ok(vec![path_to_string(&save_bytes(store, &name, &bytes)?)]);
            }

            Err("剪贴板里没有文件或图片".into())
        }
    }

    /// BI_BITFIELDS(3) 时紧跟头部的 12 字节掩码属于头部区域，像素偏移必须把它算进去，
    /// 否则解出来的图会整体错位成雪花
    fn dib_pixel_extra(dib: &[u8], header_len: usize) -> usize {
        if header_len < 40 {
            return 0;
        }
        let compression = u32::from_le_bytes([dib[12], dib[13], dib[14], dib[15]]);
        if compression == 3 {
            12
        } else {
            0
        }
    }

    pub fn copy_as_file(paths: Vec<String>) -> Result<(), String> {
        unsafe {
            // DROPFILES: pFiles(=头长 20) + pt(8) + fNC(4) + fWide(4)，
            // 从 pFiles 那个偏移开始是 UTF-16 路径列表，最后多一个空项收尾
            let mut wide: Vec<u16> = Vec::new();
            for p in &paths {
                wide.extend(p.encode_utf16());
                wide.push(0);
            }
            wide.push(0);
            let body = 20 + wide.len() * 2;
            // 先开剪贴板再分配，中途任何失败都不会留下没人回收的内存
            OpenClipboard(None).map_err(|e| format!("打开剪贴板失败: {e}"))?;
            let _guard = CloseGuard;
            let mem = GlobalAlloc(GMEM_MOVEABLE, body)
                .map_err(|e| format!("分配剪贴板内存失败: {e}"))?;
            let base = GlobalLock(mem) as *mut u8;
            if base.is_null() {
                let _ = GlobalFree(Some(mem));
                return Err("锁定剪贴板内存失败".into());
            }
            std::ptr::write_unaligned(base as *mut u32, 20); // pFiles
            std::ptr::write_unaligned(base.add(4) as *mut u32, 0); // pt.x
            std::ptr::write_unaligned(base.add(8) as *mut u32, 0); // pt.y
            std::ptr::write_unaligned(base.add(12) as *mut u32, 0); // fNC
            std::ptr::write_unaligned(base.add(16) as *mut u32, 1); // fWide：下面是宽字符
            std::slice::from_raw_parts_mut(base.add(20) as *mut u16, wide.len())
                .copy_from_slice(&wide);
            let _ = GlobalUnlock(mem);

            EmptyClipboard().map_err(|e| format!("清空剪贴板失败: {e}"))?;
            // 成功后所有权归剪贴板，不能再 GlobalFree；只有失败才回收
            if SetClipboardData(fmt_of(CF_HDROP), Some(HANDLE(mem.0))).is_err() {
                let _ = GlobalFree(Some(mem));
                return Err("写入剪贴板失败".into());
            }
            Ok(())
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use crate::store::Store;

    pub fn paste_paths(_store: &Store) -> Result<Vec<String>, String> {
        Err("当前平台还没有接入系统剪贴板".into())
    }

    pub fn copy_as_file(_paths: Vec<String>) -> Result<(), String> {
        Err("当前平台还没有接入系统剪贴板".into())
    }
}

fn paste_paths_inner(store: &crate::store::Store) -> Result<Vec<String>, String> {
    platform::paste_paths(store)
}

fn copy_as_file_inner(paths: Vec<String>) -> Result<(), String> {
    platform::copy_as_file(paths)
}

/* --------------------------------------------------------------------------
 * 测试：只测平台无关的那部分（URL 解码、落盘命名），剪贴板本身留给真机自检
 * ------------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    /// 每个用例一个独立临时目录，避免并行测试互相踩（与 server.rs 同一套做法）
    fn tmp_store(tag: &str) -> Store {
        let d = std::env::temp_dir().join(format!("imgcmp-clip-{tag}-{}", uuid::Uuid::new_v4()));
        Store::new(d)
    }

    /// save_bytes 带一个进程内的「同一份内容不重复落盘」缓存，并行用例之间会互相干扰，
    /// 所以直接调它的用例全部先抢这把锁。取锁失败（上一个用例 panic 污染了它）也要继续跑。
    static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn save_guard() -> std::sync::MutexGuard<'static, ()> {
        SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn file_url_解出普通路径与中文空格() {
        assert_eq!(
            decode_file_url("file:///Users/x/a.png").as_deref(),
            Some("/Users/x/a.png")
        );
        assert_eq!(
            decode_file_url("file:///Users/x/%E8%AE%B2%E4%B9%89%E6%9C%AC.docx").as_deref(),
            Some("/Users/x/讲义本.docx")
        );
        assert_eq!(
            decode_file_url("file:///Users/My%20Docs/%E7%85%A7%E7%89%87%201.jpg").as_deref(),
            Some("/Users/My Docs/照片 1.jpg")
        );
        // 带 localhost 的写法与首尾空白
        assert_eq!(
            decode_file_url("  file://localhost/Users/x/a.png ").as_deref(),
            Some("/Users/x/a.png")
        );
    }

    #[test]
    fn 非本地路径与坏转义一律拒绝而不是猜一个() {
        // 网络盘 / 其它 scheme / 根目录本身
        assert_eq!(decode_file_url("smb://host/share/a.png"), None);
        assert_eq!(decode_file_url("http://x/a.png"), None);
        assert_eq!(decode_file_url("file:///"), None);
        // 坏的 UTF-8 字节序列不能拼出半个路径
        assert_eq!(decode_file_url("file:///a%2F%F0%FF.png".replace("%2F", "/").as_str()), None);
    }

    #[test]
    fn 粘贴落盘会清洗名字并且不覆盖已有文件() {
        let _g = save_guard();
        let store = tmp_store("save");
        let dir = store.pastebox_dir();
        let a = save_bytes(&store, "../../etc/passwd.txt", b"123").expect("首次落盘");
        assert_eq!(a.parent(), Some(dir.as_path()));
        // 分隔符换成 _ 之后开头的点也被 trim_matches('.') 吃了，这是收件箱那边已有的行为，
        // 这里把它写死是为了确认改动不会默默放出一条能穿越的路径
        assert_eq!(a.file_name().unwrap().to_string_lossy(), "_.._etc_passwd.txt");

        // 同名再来一次要加序号，而不是把第一份吃掉
        let b = save_bytes(&store, "../../etc/passwd.txt", b"456").expect("二次落盘");
        assert_ne!(a, b);
        assert!(b.file_name().unwrap().to_string_lossy().ends_with("(1).txt"));
        assert_eq!(std::fs::read(&a).unwrap(), b"123");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 空内容与超长名字都有明确说法() {
        let _g = save_guard();
        let store = tmp_store("edge");
        assert!(save_bytes(&store, "空.png", b"").is_err());
        // 和收件箱同一条规矩：截到上限也得把扩展名留在尾巴上
        let long = format!("{}.png", "图".repeat(200));
        let p = save_bytes(&store, &long, b"x").expect("长名落盘");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.chars().count() <= 120, "实际长度 {}", name.chars().count());
        assert!(name.ends_with(".png"), "扩展名被削掉了: {name}");
        let _ = std::fs::remove_dir_all(store.pastebox_dir());
    }

    #[test]
    fn 同一份剪贴板内容反复粘只落一个文件() {
        let _g = save_guard();
        let store = tmp_store("dedup");
        let a = save_bytes(&store, "同一张.png", b"bitmap-A").expect("首次落盘");
        let b = save_bytes(&store, "同一张.png", b"bitmap-A").expect("二次粘同一个");
        assert_eq!(a, b, "内容一模一样却造了新副本");
        assert_eq!(
            std::fs::read_dir(store.pastebox_dir()).unwrap().count(),
            1,
            "pastebox 里应该只有一份"
        );
        // 换一份内容就必须是新文件，不能把旧的那个盖掉
        let c = save_bytes(&store, "同一张.png", b"bitmap-B").expect("换了内容");
        assert_ne!(a, c);
        assert_eq!(std::fs::read(&a).unwrap(), b"bitmap-A");
        assert_eq!(std::fs::read(&c).unwrap(), b"bitmap-B");
        let _ = std::fs::remove_dir_all(store.pastebox_dir());
    }
}

/// 真机探针：把「读剪贴板 / 写剪贴板」在命令行里跑通，不依赖界面。
/// 用法（配合 osascript 往剪贴板里放东西）：
///   cargo test --lib -- --ignored clip::real_clipboard
#[cfg(all(test, target_os = "macos"))]
mod real_clipboard {
    use crate::store::Store;

    /// 只读探针：不写回剪贴板，所以不会弄脏用户当前复制的东西。
    /// 怀疑“读到的是旧内容”或“风味的选不对”时跑这个，落盘目录会打印出来供 file/sips 验。用法：
    ///   cargo test --lib -- --ignored clip::只读剪贴板探针 --nocapture
    #[test]
    #[ignore = "会读用户真实剪贴板并落一个文件到临时目录"]
    fn 只读剪贴板探针() {
        let dir = std::env::temp_dir().join(format!("imgcmp-clip-ro-{}", uuid::Uuid::new_v4()));
        let store = Store::new(dir.clone());
        match super::platform::paste_paths(&store) {
            Ok(paths) => {
                for p in &paths {
                    let meta = std::fs::metadata(p).ok();
                    println!("[ro] 读到 {} ({:?} 字节)", p, meta.map(|m| m.len()));
                }
                println!("[ro] 落盘目录没删，自己看完删：{}", dir.display());
                return;
            }
            Err(e) => println!("[ro] 读取失败: {e}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "会读写用户真实剪贴板，只在手动自检时跑"]
    fn 真机剪贴板探针() {
        let dir = std::env::temp_dir().join(format!("imgcmp-clip-probe-{}", uuid::Uuid::new_v4()));
        let store = Store::new(dir.clone());
        match super::platform::paste_paths(&store) {
            Ok(paths) => println!("[probe] 读到 {} 项: {:#?}", paths.len(), paths),
            Err(e) => println!("[probe] 读取失败: {e}"),
        }
        // 反向：把一张真 PNG 写进剪贴板，再用 osascript 读回来看到底挂上了哪几味
        if let Some(first) = paths_probe_file() {
            super::platform::copy_as_file(vec![first.clone()]).expect("写入剪贴板");
            println!("[probe] 已把 {first} 写入剪贴板（文件 URL + 图片位图）");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 探针用的小文件：必须是**能解出位图**的完整 PNG，
    /// 只写几个魔数字节的话 NSBitmapImageRep 会解失败，位图那味就永远测不到
    fn paths_probe_file() -> Option<String> {
        const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, PNG_1X1).ok()?;
        let d = std::env::temp_dir().join("imgcmp-clip-probe-file.png");
        std::fs::write(&d, bytes).ok()?;
        Some(d.to_string_lossy().to_string())
    }
}
