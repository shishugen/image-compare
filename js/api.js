/* ==========================================================================
 * 前后端通信与跨视图共享设施
 *
 * 约定：前端不碰网络。局域网收发全部在 Rust 侧（页面 origin 是 ipc://localhost，
 * 直接 fetch http://192.168.x.x 会被混合内容策略与 CSP 双拦），这里只做
 * invoke 发命令 + listen 收事件的包装，以及三个视图共用的状态栏/提示/拖拽路由。
 * ========================================================================== */

export const isTauriRuntime = typeof window.__TAURI__ !== "undefined";

export const el = (id) => document.getElementById(id);

/**
 * 算“图片”的扩展名。三个视图都用这一份：之前各自写了一份，
 * 三份正则还不一样（transfer 有 svg、compare 有 tiff、favorites 两个都没），
 * 同一张图在三个视图里会被归到不同类。这里是并集。
 */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg|tiff?)$/i;

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
const hoverHandlers = {}; // 视图名 -> (phase) => void，拖拽悬停阶段 enter/over/leave/drop
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

/** 拖拽悬停同样按视图分流：传输/收藏视图要靠遮罩提示「松开即发送」 */
export function routeDropHover(phase) {
  const fn = hoverHandlers[currentView()];
  if (!fn) return false;
  try {
    fn(phase);
  } catch (err) {
    console.error("[view] 悬停回调失败:", err);
  }
  return true;
}

export function registerDropHoverHandler(viewName, fn) {
  hoverHandlers[viewName] = fn;
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

/** 把文字交给传输通道：不带 to 参数，后端发给当前会话（不要求先切到传输视图） */
export async function sendTextToPeer(text) {
  if (!text || !text.trim()) {
    toast("这条内容是空的", "error");
    return false;
  }
  try {
    await invoke("send_text", { text });
    toast("已发到当前会话");
    return true;
  } catch (err) {
    toast(errText(err), "error");
    return false;
  }
}

/** 把文件/文件夹交给传输通道（同上，发给当前会话；文件夹由 Rust 侧递归逐文件发送） */
export async function sendPathsToPeer(paths) {
  if (!paths || !paths.length) return false;
  try {
    await invoke("send_paths", { paths });
    toast(`已发送 ${paths.length} 项到当前会话`);
    return true;
  } catch (err) {
    toast(errText(err), "error");
    return false;
  }
}

/**
 * 把本机文件/文件夹写进系统剪贴板，行为跟微信自己的复制一致：
 * 剪贴板里同时有「文件」和「图片位图」两味 —— 粘进微信聊天框 / Word / 邮件正文
 * 就是图片本身，粘进 Finder / 邮件附件区仍是那个文件。
 * 位图那味由后端判：只单项且解得出位图才挂，非图片自动退化成纯文件。
 * 参数可以是单个路径也可以是路径数组（对比视图一次把两张图都带上，那就是纯文件形式）。
 */
export async function copyPathAsFile(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) {
    toast("这条记录还没有本机路径，复制不了", "error");
    return false;
  }
  try {
    await invoke("copy_as_file", { paths: list });
    toast(
      list.length > 1
        ? `已复制 ${list.length} 项文件，可直接粘`
        : "已复制，粘进微信 / Word 就是图片，粘进 Finder 是文件"
    );
    return true;
  } catch (err) {
    toast(errText(err), "error");
    return false;
  }
}

/* --------------------------------------------------------------------------
 * 粘贴：和拖拽共用一条下游，只是来源换成系统剪贴板
 *
 * 为什么不在这里读 clipboardData：WKWebView 递出来的 File 是 0 字节（本文件顶部
 * 与 lib.rs 的注释都记着这条踩坑），paste 事件同样只有名字和类型。所以真正的读取
 * 在 Rust 侧 clip.rs：剪贴板里是文件就给原路径，是位图（截图）就落到 pastebox/
 * 当成文件。拿到路径后交给 routeDrop，三个视图各自的落点逻辑一行都不用改。
 * ------------------------------------------------------------------------ */
const pasteTextHandlers = {}; // 视图名 -> (text) => void
let lastPasteAt = 0; // keydown 与 paste 两条入口的去重时间戳

export function registerPasteTextHandler(viewName, fn) {
  pasteTextHandlers[viewName] = fn;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditable(node) {
  if (!node || !node.tagName) return false;
  return EDITABLE_TAGS.has(node.tagName) || node.isContentEditable === true;
}

/** 剪贴板里带文件/图片时，就算焦点在输入框也要走文件这条路（像微信里粘截图） */
function hasBinaryFlavor(ev) {
  const types = ev?.clipboardData?.types;
  if (!types || !types.length) return false;
  return Array.from(types).some(
    (t) => t === "Files" || t === "text/uri-list" || /png|tiff|bmp|jpeg|gif|image/i.test(t)
  );
}

async function runPaste(text) {
  let paths;
  try {
    paths = await invoke("paste_paths");
  } catch (err) {
    // 剪贴板里是纯文字：当前视图接了就走它的说法，否则老实地告诉用户
    const t = (text || "").trim();
    const fn = pasteTextHandlers[currentView()];
    if (t && fn) {
      fn(t);
      return;
    }
    toast(errText(err), "error");
    return;
  }
  if (!paths || !paths.length) {
    toast("剪贴板里没有文件或图片", "error");
    return;
  }
  if (!routeDrop(paths)) toast("当前视图不接收文件，请切到对比或传输视图", "error");
}

function handlePasteEvent(ev) {
  // 输入框里粘纯文字交给浏览器自己，抢过来只会把用户习惯打断
  if (isEditable(ev.target) && !hasBinaryFlavor(ev)) return;
  if (Date.now() - lastPasteAt < 500) return;
  lastPasteAt = Date.now();
  let text = "";
  try {
    text = ev.clipboardData?.getData("text/plain") || "";
  } catch (err) {
    console.warn("[paste] 读文字失败:", err);
  }
  ev.preventDefault();
  runPaste(text).catch((err) => console.error("[paste] 失败:", err));
}

/**
 * 装一次就好（main.js 入口处调）。
 * keydown 是兜底：焦点不在任何可编辑元素上时 WebKit 不一定把 paste 派发到页面，
 * 但按键一定能到；两条入口靠 lastPasteAt 去重，不会粘两遍。
 */
export function installPasteListener() {
  document.addEventListener("paste", (ev) => handlePasteEvent(ev), true);
  window.addEventListener("keydown", (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || (ev.key || "").toLowerCase() !== "v") return;
    if (isEditable(ev.target)) return;
    if (Date.now() - lastPasteAt < 500) return;
    lastPasteAt = Date.now();
    runPaste("").catch((err) => console.error("[paste] 失败:", err));
  });
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

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/**
 * 把时间归到「哪一个自然日」。用年月日三元组比对而不是把时间戳相减：
 * 夏令时那两天一天不是 24 小时，拿 86400000 当一天会让「昨天」算错
 */
function dayKey(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * 相邻两条消息之间要不要插一条日期分隔线。返回 null 表示同一天，不用插。
 * `prevTs` 是流里它前面那一条的时间；传 null/undefined 表示前面还没有过消息
 * （首屏第一条、或刚往前补了一页），那时候也得出线，不然整段都没日期可看。
 * 措辞三档：今天只到月日、昨天只写「昨天」、更早带年份 —— 跟微信一致。
 */
export function fmtDayDivider(ts, prevTs) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  if (prevTs !== null && prevTs !== undefined && dayKey(prevTs) === dayKey(ts)) return null;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const now = new Date();
  if (dayKey(ts) === dayKey(now.getTime())) return `${md} ${WEEKDAYS[d.getDay()]}`;
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  y.setDate(y.getDate() - 1);
  if (dayKey(ts) === dayKey(y.getTime())) return "昨天";
  return `${d.getFullYear()}年${md} ${WEEKDAYS[d.getDay()]}`;
}

/** 输入框里粘贴/输入的路径可能带引号或前导空格 */
export function cleanPath(p) {
  return String(p || "").trim().replace(/^"|"$/g, "");
}
