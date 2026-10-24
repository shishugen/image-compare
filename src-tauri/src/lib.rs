use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

mod clip;
mod favorites;
mod http;
mod net;
mod pair;
mod store;

/// 图片文件选择，最多返回 4 个路径，按选择顺序依次填入图窗。
/// 必须走 Rust：WKWebView 的 input[type=file] 递出的 File 是 0 字节（只能拿到名字/类型），
/// 而 Rust 侧 std::fs::read 实测可正常读取用户选中的文件。
#[tauri::command]
async fn pick_images(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<tauri_plugin_dialog::FilePath>>>();
    app.dialog()
        .file()
        .set_title("选择要对比的图片（可多选，最多四张）")
        .add_filter("图片", &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"])
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

fn mime_of(ext: Option<&str>) -> Option<&'static str> {
    match ext.map(|e| e.to_ascii_lowercase()) {
        Some(x) if x == "png" => Some("image/png"),
        Some(x) if x == "jpg" || x == "jpeg" => Some("image/jpeg"),
        Some(x) if x == "webp" => Some("image/webp"),
        Some(x) if x == "gif" => Some("image/gif"),
        Some(x) if x == "bmp" => Some("image/bmp"),
        Some(x) if x == "avif" => Some("image/avif"),
        Some(x) if x == "svg" => Some("image/svg+xml"),
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
            app.manage(hub);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_images,
            read_image,
            take_pending_paths,
            copy_text,
            clip::paste_paths,
            clip::copy_as_file,
            net::net_status,
            net::send_text,
            net::send_paths,
            net::msg_history,
            net::reveal_in_folder,
            net::save_path_as,
            net::pick_folder,
            net::pick_send_files,
            pair::list_peers,
            pair::set_pair_config,
            pair::bind_peer_addr,
            pair::unbind_peer,
            pair::reprobe_peer,
            favorites::fav_list,
            favorites::fav_upsert,
            favorites::fav_delete,
            favorites::fav_move
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
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
