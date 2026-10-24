/* ==========================================================================
 * 前后端通信与跨视图共享设施
 *
 * 约定：前端不碰网络。局域网收发全部在 Rust 侧（页面 origin 是 ipc://localhost，
 * 直接 fetch http://192.168.x.x 会被混合内容策略与 CSP 双拦），这里只做
 * invoke 发命令 + listen 收事件的包装，以及三个视图共用的状态栏/提示/拖拽路由。
 * ========================================================================== */

export const isTauriRuntime = typeof window.__TAURI__ !== "undefined";

export const el = (id) => document.getElementById(id);

/** 发命令：非 Tauri 环境（纯浏览器里打开 js/index.html 调试）直接抛错，让调用方兜底 */
export async function invoke(cmd, args) {
  if (!isTauriRuntime) throw new Error(`非 Tauri 环境，无法调用 ${cmd}`);
  return window.__TAURI__.core.invoke(cmd, args || {});
}

/** 收事件：handler 内部异常不能让监听器断掉，所以统一吞掉并打日志 */
export function listen(event, handler) {
  if (!isTauriRuntime) return Promise.resolve(() => {});
  return window.__TAURI__.event
    .listen(event, (ev) => {
      try {
        handler(ev.payload, ev);
      } catch (err) {
        console.error(`[event:${event}] 处理失败:`, err);
      }
    })
    .catch((err) => {
      console.warn(`[event:${event}] 监听失败:`, err);
      return () => {};
    });
}

/* --------------------------------------------------------------------------
 * 视图切换：body[data-view] 决定哪个视图可见，也决定拖拽落到哪里
 * ------------------------------------------------------------------------ */
export const VIEWS = ["compare", "transfer", "fav"];
const viewListeners = [];
const dropHandlers = {}; // 视图名 -> (paths) => void
const openHandlers = {}; // 视图名 -> (paths) => void，供别的视图请求「在对比里打开」

export function currentView() {
  return document.body.dataset.view || "compare";
}

export function setView(name) {
  if (!VIEWS.includes(name)) {
    console.warn("[view] 未知视图:", name);
    return;
  }
  if (name === currentView()) return;
  document.body.dataset.view = name;
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("is-active", btn.dataset.goto === name);
  }
  for (const fn of viewListeners) {
    try {
      fn(name);
    } catch (err) {
      console.error("[view] 切换回调失败:", err);
    }
  }
}

export function onViewChange(fn) {
  viewListeners.push(fn);
}

/** 拖进窗口的文件按当前视图分流：对比视图进图窗，其它视图交给该视图自己的处理 */
export function routeDrop(paths, paneKey) {
  const fn = dropHandlers[currentView()];
  if (!fn) return false;
  fn(paths, paneKey);
  return true;
}

export function registerDropHandler(viewName, fn) {
  dropHandlers[viewName] = fn;
}

/** 跨视图「用图片对比打开这组文件」 */
export function openInCompare(paths) {
  const fn = openHandlers.compare;
  if (!fn) {
    toast("对比视图还没准备好，稍后再试");
    return;
  }
  setView("compare");
  fn(paths);
}

export function registerOpenHandler(viewName, fn) {
  openHandlers[viewName] = fn;
}

/* --------------------------------------------------------------------------
 * 状态栏与提示
 * ------------------------------------------------------------------------ */

/** 常驻提示位：三个视图都看得见，异常兜底也写这里 */
export function setStatus(text) {
  const node = el("st-msg");
  if (node) node.textContent = text || "";
}

let toastTimer = null;

/** 轻量提示，2.6 秒后自动回到空闲文案；错误文案保持更久 */
export function toast(text, kind) {
  setStatus((kind === "error" ? "✗ " : "✓ ") + text);
  const node = el("st-msg");
  if (node) node.classList.toggle("is-error", kind === "error");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    setStatus("");
    if (node) node.classList.remove("is-error");
  }, kind === "error" ? 6000 : 2600);
}

/* --------------------------------------------------------------------------
 * 跨视图复用的小能力：复制、发送、错误文案
 * ------------------------------------------------------------------------ */

/** Rust 侧的 Err(String) 到前端就是字符串，Exception 才有 message，两种都要兜 */
export function errText(err) {
  return typeof err === "string" ? err : err?.message || String(err);
}

/**
 * 复制到系统剪贴板，依次退让：
 *   navigator.clipboard（要安全上下文，WKWebView 常直接拒）
 *   → execCommand('copy')（对隐藏 textarea 选中后复制，多数 WebView 可用）
 *   → Rust arboard（前两条都不行才能保底，对应验收标准里的兜底）
 */
export async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
    return true;
  } catch (err) {
    console.warn("[clip] navigator.clipboard 不可用，改用 execCommand:", err);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    console.warn("[clip] execCommand 失败:", err);
  }
  ta.remove();
  if (ok) {
    toast("已复制到剪贴板（兜底路径）");
    return true;
  }
  try {
    await invoke("copy_text", { text });
    toast("已复制到剪贴板（Rust 兜底）");
    return true;
  } catch (err) {
    console.error("[clip] copy_text 也失败:", err);
    toast(errText(err) || "复制失败，请手动选择文字", "error");
    return false;
  }
}

/** 把文字交给传输通道；不要求用户先切到传输视图 */
export async function sendTextToPeer(text) {
  if (!text || !text.trim()) {
    toast("这条内容是空的", "error");
    return false;
  }
  try {
    await invoke("send_text", { text });
    toast("已发送到对端");
    return true;
  } catch (err) {
    toast(errText(err), "error");
    return false;
  }
}

/** 把文件/文件夹交给传输通道（文件夹由 Rust 侧递归逐文件发送） */
export async function sendPathsToPeer(paths) {
  if (!paths || !paths.length) return false;
  try {
    await invoke("send_paths", { paths });
    toast(`已发送 ${paths.length} 项到对端`);
    return true;
  } catch (err) {
    toast(errText(err), "error");
    return false;
  }
}

/* --------------------------------------------------------------------------
 * 格式化
 * ------------------------------------------------------------------------ */
export function fmtSize(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

/** 2026-02-11 14:03（跨平台，不用 locale 依赖） */
export function fmtTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? hm : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 输入框里粘贴/输入的路径可能带引号或前导空格 */
export function cleanPath(p) {
  return String(p || "").trim().replace(/^"|"$/g, "");
}
