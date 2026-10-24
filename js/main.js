/* ==========================================================================
 * 入口：只做「装配」
 *
 * 三个视图各自成模块，靠 api.js 里的视图状态与拖拽路由互相解耦：
 * 对比视图注册 compare 的落点处理，传输/收藏视图注册自己的处理，
 * 原生拖拽进来时由当前 data-view 决定交给谁，不会再出现「拖文件进收藏结果变了图」。
 * 这里额外负责导航、⌘1/⌘2/⌘3、平台文案与全局异常兜底。
 * ========================================================================== */

import { VIEWS, currentView, el, setView, setStatus } from "./api.js";

// 顺序即注册顺序：视图模块在导入时就完成事件绑定，此时 DOM 已就绪（script 在 body 末尾）
import "./view-compare.js";
import "./view-transfer.js";
import "./view-favorites.js";

/* --------------------------------------------------------------------------
 * 左侧导航
 * ------------------------------------------------------------------------ */
function syncNav() {
  const cur = currentView();
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("is-active", btn.dataset.goto === cur);
  }
}

for (const btn of document.querySelectorAll(".nav-btn")) {
  btn.addEventListener("click", () => setView(btn.dataset.goto));
}

// 切视图的快捷键用 capture 抢在对比视图之前；那边遇到 meta 键本来也直接 return
window.addEventListener(
  "keydown",
  (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
    const idx = ["1", "2", "3"].indexOf(ev.key);
    if (idx < 0) return;
    ev.preventDefault();
    setView(VIEWS[idx]);
  },
  { capture: true }
);

/* --------------------------------------------------------------------------
 * 平台适配：Windows / Linux 下把界面里的 macOS 快捷提示 ⌘ 换成 Ctrl
 * ------------------------------------------------------------------------ */
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
if (!isMac) {
  for (const node of document.querySelectorAll("[title]")) {
    if (node.title.includes("⌘")) node.title = node.title.replace(/⌘/g, "Ctrl+");
  }
  console.log("[env] 非 macOS 平台，快捷提示已改写为 Ctrl:", navigator.platform || navigator.userAgent);
}

/* --------------------------------------------------------------------------
 * 异常兜底：把报错写进状态栏，不用开 DevTools 也能看到
 * （界面不对劲时先看在状态栏留没留话，这是本项目调试界面问题的固定入口）
 * ------------------------------------------------------------------------ */
window.addEventListener("error", (ev) => {
  setStatus("JS 错误: " + (ev.message || "加载失败"));
  console.error("[app] error", ev.error || ev.message);
});
window.addEventListener("unhandledrejection", (ev) => {
  setStatus("异步错误: " + (ev.reason?.message || ev.reason));
  console.error("[app] unhandledrejection", ev.reason);
});

if (!el("stage")) console.warn("[app] 缺少 #stage，对比视图可能无法布局");
syncNav();
console.log("[app] 入口装配完成，当前视图:", currentView());
