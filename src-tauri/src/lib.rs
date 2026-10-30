use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

mod clip;
mod favorites;
mod history;
mod http;
mod lib_cmds;
mod net;
mod pair;
mod prefs;
mod sort;
mod store;

// 「什么算图片」的口径搬到 lib_cmds.rs：sort.rs 也要用同一份，两个模块各自
// import 一个叶子模块，比一个模块去拿另一个模块的私有 const 干净
use lib_cmds::{is_image_ext, IMAGE_EXTS};

/// 图片文件选择，最多返回 4 个路径，按选择顺序依次填入图窗。
/// 必须走 Rust：WKWebView 的 input[type=file] 递出的 File 是 0 字节（只能拿到名字/类型），
/// 而 Rust 侧 std::fs::read 实测可正常读取用户选中的文件。
#[tauri::command]
async fn pick_images(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<tauri_plugin_dialog::FilePath>>>();
    app.dialog()
        .file()
        .set_title("选择要对比的图片（可多选，最多四张）")
        .add_filter("图片", IMAGE_EXTS)
        .pick_files(move |files| {
            let _ = tx.send(files);
        });

    let files = rx.await.map_err(|e| format!("对话框通道异常: {}", e))?;
    let paths: Vec<String> = files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .take(4)
        .collect();
    Ok(paths)
}

/// 把主窗钉在所有应用之上（对比时一边看本机的图、一边看别处发来的东西）。
///
/// 为什么走 Rust 而不让前端直调 `getCurrentWindow().setAlwaysOnTop()`：那条得往
/// capabilities 里补一条 `core:window:allow-set-always-on-top`（实测 `core:window:default`
/// 那 28 条**全是只读 getter**，一个动作都不带），漏掉的表现是按钮亮着而窗没置顶；
/// 而这个项目里前端本来就只调自己的命令，注册成命令既不加权限，node 桩里也才断得到。
///
/// 不持久化：每次启动都是普通窗。置顶是挡人的状态，「上次忘了关」如果跨重启还在，
/// 比当场关掉难查得多 —— 没人会想到去设置里找一枚按钮是不是亮着。
///
/// 返回值就是落地后的状态：前端照它设按钮高亮，不自己先翻再指望命令一定成功。
#[tauri::command]
fn set_always_on_top(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口已经不在了".to_string())?;
    w.set_always_on_top(on).map_err(|e| e.to_string())?;
    Ok(on)
}

/// 读图片字节（拖拽进窗口的原生路径与对话框选中的路径都走这里），返回 base64 data URL + 元信息
#[tauri::command]
async fn read_image(path: String) -> Result<ImagePayload, String> {
    let buf = PathBuf::from(&path);
    if !buf.is_file() {
        return Err(format!("文件不存在或不是普通文件: {}", path));
    }
    let bytes = std::fs::read(&buf)
        .map_err(|e| format!("读文件被拒（{}）: {}", path, e))?;
    // 80MB 兜底，避免误选超大文件把内存打满
    const MAX_BYTES: usize = 80 * 1024 * 1024;
    if bytes.len() > MAX_BYTES {
        return Err("图片过大（超过 80MB）".into());
    }
    let name = buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let mime = mime_of(buf.extension().and_then(|e| e.to_str()))
        // 收件箱里的名字可能被截断过、也可能本来就没扩展名，这时候只能看文件头
        .or_else(|| sniff_mime(&bytes))
        .unwrap_or("application/octet-stream");
    Ok(ImagePayload {
        path,
        name,
        size: bytes.len() as u64,
        data_url: format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)),
    })
}

/// 浏览侧栏里的一项。字段保持 snake_case（与 ImagePayload 同一个口径，
/// 加过 rename_all 之后前端读不到字段那件事踩过一次）
#[derive(Debug, serde::Serialize)]
struct FolderImageItem {
    path: String,
    name: String,
    size: u64,
}

#[derive(Debug, serde::Serialize)]
struct FolderImages {
    dir: String,
    items: Vec<FolderImageItem>,
    /// 本层图片比 FOLDER_MAX_ITEMS 还多：前端在列表底部提示「只列出前 N 张」
    truncated: bool,
}

/// 列出「这张图所在目录」里的全部图片，给对比视图的浏览侧栏用。
/// 只看一层、不递归子目录。
#[tauri::command]
async fn list_folder_images(path: String) -> Result<FolderImages, String> {
    folder_images(&PathBuf::from(&path))
}

/// 真正的活儿拆成同步函数：命令要是 async 的（Tauri 里不阻塞主线程），
/// 但单测没有 tokio runtime，直接调这个函数就能验
fn folder_images(file: &std::path::Path) -> Result<FolderImages, String> {
    let dir = file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("{} 看不出所在目录", file.display()))?;
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("读目录失败（{}）: {}", dir.display(), e))?;
    // 排序不在这里做：JS 的 localeCompare(…, { numeric: true }) 天然拿到
    // IMG_2 < IMG_10 的自然序，Rust 手写数字感知排序只会多一堆代码
    let mut items: Vec<FolderImageItem> = Vec::new();
    let mut truncated = false;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() || !is_image_ext(&p) {
            continue; // 子目录与非图片都不进列表
        }
        if items.len() >= lib_cmds::FOLDER_MAX_ITEMS {
            truncated = true;
            break;
        }
        items.push(FolderImageItem {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: p.to_string_lossy().to_string(),
            size: p.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
    Ok(FolderImages {
        dir: dir.to_string_lossy().to_string(),
        items,
        truncated,
    })
}

fn mime_of(ext: Option<&str>) -> Option<&'static str> {
    match ext.map(|e| e.to_ascii_lowercase()) {
        Some(x) if x == "png" => Some("image/png"),
        Some(x) if x == "jpg" || x == "jpeg" => Some("image/jpeg"),
        Some(x) if x == "webp" => Some("image/webp"),
        Some(x) if x == "gif" => Some("image/gif"),
        Some(x) if x == "bmp" => Some("image/bmp"),
        Some(x) if x == "avif" => Some("image/avif"),
        Some(x) if x == "svg" => Some("image/svg+xml"),
        Some(x) if x == "tif" || x == "tiff" => Some("image/tiff"),
        _ => None,
    }
}

/// 靠魔数认图片：聊天缩略图走 data URL，mime 猜错就整张画不出来，
/// 所以扩展名缺失/被截断时必须有这一步兜底
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.get(..4) == Some(b"\x89PNG") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.get(..4) == Some(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    if bytes.get(4..8) == Some(b"ftyp")
        && matches!(bytes.get(8..12), Some(b"avif") | Some(b"avis"))
    {
        return Some("image/avif");
    }
    // svg 是文本，只看开头一小段，避免为一个矢量图扫全文
    let head = &bytes[..bytes.len().min(512)];
    if head.starts_with(b"<svg") || (head.starts_with(b"<?xml") && head.windows(4).any(|w| w == b"<svg")) {
        return Some("image/svg+xml");
    }
    None
}

/// 写入系统剪贴板。前端已依次试过 navigator.clipboard 与 execCommand，
/// 两者都被 WebView 拦下时退到这里（不引入 clipboard 插件，也就不新增 capability 权限）
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut board = arboard::Clipboard::new().map_err(|e| format!("打开系统剪贴板失败: {e}"))?;
    board
        .set_text(text)
        .map_err(|e| format!("写入剪贴板失败: {e}"))
}

// 不加 rename_all：保持 snake_case，与前端 payload.data_url 的读法一致
// （之前用 camelCase 序列化出 dataUrl，前端读 data_url 拿到 undefined，表现为「图片解码失败」）
#[derive(serde::Serialize)]
struct ImagePayload {
    path: String,
    name: String,
    size: u64,
    data_url: String,
}

/// 等待前端来取的“系统打开”路径队列。
/// 冷启动时 Opened 事件往往早于 webview 就绪，那时 emit 出去没人接会丢，
/// 所以入队 + 广播两条都走：错过广播的前端启动后主动取队列。
#[derive(Default)]
struct PendingOpens(Mutex<Vec<String>>);

/// 前端初始化后取走队列（取完即清空，不会重复加载）
#[tauri::command]
fn take_pending_paths(state: tauri::State<'_, PendingOpens>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("PendingOpens 锁中毒"))
}

fn push_opens(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app
        .state::<PendingOpens>()
        .0
        .lock()
        .expect("PendingOpens 锁中毒")
        .extend(paths.iter().cloned());
    let _ = app.emit("open-paths", paths);
}

/// 已在运行时再次拉起本应用（Windows 双击关联文件最常见）时，
/// 第二个实例把命令行参数交给第一个实例后自行退出。
/// 没有这个插件时，Windows 上每次双击都会开一个新窗口，而且旧窗口不会拿到文件。
/// 注意：dev 构建与已安装的 release 包共用同一个 app identifier，
/// 先退掉已运行的实例再跑 `tauri dev`，否则 dev 进程会直接交接并退出。
fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    // argv 第一个元素是 executable 路径，从第二个开始才是参数
    let paths: Vec<String> = argv
        .into_iter()
        .skip(1)
        .filter(|a| PathBuf::from(a).is_file())
        .collect();
    push_opens(app, paths);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 官方要求 single-instance 放在第一个注册的插件
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            on_second_instance(app, argv);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpens::default())
        .setup(|app| {
            // 调试构建自动打开 DevTools，便于看前端 console
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
            // Windows / Linux 下双击关联文件是靠命令行参数传进来的，只有 macOS 走 Opened 事件
            let from_args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| PathBuf::from(a).is_file())
                .collect();
            push_opens(&app.handle().clone(), from_args);

            // 局域网收发 + 收藏：状态放 Arc 里，后台线程与命令共享同一份
            let store = net::prepare_store(&app.handle().clone())?;
            // 早期版本把收件箱消息的路径截断过，前端每次展开都会报“缩略图读取失败”，
            // 所以在前端首次读消息之前先顺手把真身找回（只在路径对不上时动手，平时无感）
            let repaired = store.repair_inbox_paths();
            if repaired > 0 {
                eprintln!("[store] 启动时修好了 {repaired} 条失效的收件箱路径");
            }
            let hub = net::start(&app.handle().clone(), store.clone())?;
            app.manage(store);
            // 冷启动先设一次角标：历史里本来就有未读的话，不该等到下一条新消息才亮
            hub.emit_sessions();
            app.manage(hub);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_images,
            read_image,
            list_folder_images,
            take_pending_paths,
            copy_text,
            set_always_on_top,
            clip::paste_paths,
            clip::copy_as_file,
            net::net_status,
            net::send_text,
            net::send_paths,
            net::msg_history,
            net::msg_recall,
            net::msg_delete,
            net::sessions,
            net::search_messages,
            net::session_create,
            net::session_new,
            net::session_rename,
            net::session_focus,
            net::session_delete,
            net::session_pin,
            net::session_clear,
            net::reveal_in_folder,
            net::inbox_dir,
            net::storage_stats,
            net::inbox_cleanup,
            net::play_notify_sound,
            net::save_path_as,
            net::pick_folder,
            net::pick_send_files,
            net::stat_paths,
            pair::list_peers,
            pair::set_pair_config,
            pair::bind_peer_addr,
            pair::unbind_peer,
            pair::set_peer_alias,
            pair::reprobe_peer,
            favorites::fav_list,
            favorites::fav_upsert,
            favorites::fav_delete,
            favorites::fav_move,
            history::get_history,
            history::record_view,
            history::clear_history,
            sort::scan_sort_dir,
            sort::preview_sort,
            sort::apply_sort,
            sort::undo_sort,
            prefs::get_prefs,
            prefs::set_prefs
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // 关窗即清零角标。macOS 上关掉最后一个窗进程也不退（tao 没实现
        // applicationShouldTerminateAfterLastWindowClosed，按 AppKit 默认不退），
        // 此时窗已销毁、set_badge_* 拿不到窗，角标就会冻在最后那个数字上 ——
        // 一个点不开又不会自己消失的红数字比没有更误导人。
        // 这个回调本身就在主线程上跑，所以直接调 apply_badge，不再包 run_on_main_thread。
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } = &event
        {
            if label == "main" {
                net::badge::apply_badge(app_handle, 0);
            }
        }
        // macOS：Finder 的“打开方式”、双击默认应用、拖到 Dock 图标都汇到这里
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            push_opens(app_handle, paths);
        }
        // 退出前把后台线程收下来，否则心跳会在最后一个窗口销毁后继续探测
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let Some(hub) = app_handle.try_state::<std::sync::Arc<net::Hub>>() {
                hub.stop.store(true, Ordering::Relaxed);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (&app_handle, &event); // 非 macOS 无 Opened 变体，避免未使用告警
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // cargo 的用例是并行跑的，光靠 process::id 会撞同一个临时目录
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "imgcmp-{tag}-{nanos}-{}",
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).expect("建临时目录");
        p
    }

    #[test]
    fn 目录浏览只回本层的图片() {
        let root = temp_dir("folder");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).expect("建子目录");
        for name in ["a.png", "b.TXT", "c.TIFF", "d"] {
            std::fs::write(root.join(name), b"x").expect("建测试文件");
        }
        std::fs::write(sub.join("e.jpg"), b"x").expect("建子目录里的图");

        let got = folder_images(&root.join("a.png")).expect("列目录");
        let mut names: Vec<String> = got.items.iter().map(|i| i.name.clone()).collect();
        names.sort();
        assert_eq!(names, ["a.png", "c.TIFF"], "只留图片、且只留本层：{names:?}");
        assert_eq!(got.dir, root.to_string_lossy().to_string());
        assert!(!got.truncated);
        assert!(got.items.iter().all(|i| i.size == 1), "size 要给前端当大小闸门用");
        // 扩展名判定不看大小写（c.TIFF 进了列表就是这条的反证）
        assert!(is_image_ext(std::path::Path::new("x.TIFF")));
        assert!(!is_image_ext(std::path::Path::new("x.txt")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 看不出所在目录时报错而不是铺空列表() {
        // 没有父目录的相对路径（"a.png"）parent 是 Some("")，不滤掉就会拿空串去 read_dir
        let err = folder_images(std::path::Path::new("a.png")).unwrap_err();
        assert!(err.contains("看不出所在目录"), "实际错误：{err}");
    }
}
