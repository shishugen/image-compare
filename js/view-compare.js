/* ==========================================================================
 * 视图一：图片对比
 * 图窗各自维护 { scale, x, y } 视图状态；布局有三种：单图（a）、两图并排（a/b）、
 * 四图 2×2（a/b/c/d）；同步模式下任一视图操作都会把同一份状态复制给其它所有可见视图。
 * 布局/同步/滚轮行为都能存盘（prefs.json，走 Rust 的 get_prefs/set_prefs），
 * 工具栏那几个控件与「设置」抽屉读同一份状态，任一处改动同步另一处。
 *
 * 从 main.js 原样搬来，只改了三处：
 *   1) 通信与状态栏改用 api.js（多视图共用一个状态栏）
 *   2) 原生拖拽要先按当前视图分流，非对比视图不能进图窗命中
 *   3) 快捷键必须只在对比视图、且焦点不在输入框时才生效
 * ========================================================================== */

import {
  copyPathAsFile,
  currentView,
  el,
  errText,
  IMAGE_EXT,
  invoke,
  isTauriRuntime,
  onViewChange,
  registerDropHandler,
  registerOpenHandler,
  routeDrop,
  routeDropHover,
  setStatus,
  toast,
} from "./api.js";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const PAN_STEP = 40;

const ui = {
  stage: el("stage"),
  splitter: el("splitter"),
  zoomSlider: el("zoom-slider"),
  zoomLabel: el("zoom-label"),
  syncChk: el("chk-sync"),
  stZoom: el("st-zoom"),
  stPos: el("st-pos"),
  stInfo: {
    a: el("st-info-a"),
    b: el("st-info-b"),
    c: el("st-info-c"),
    d: el("st-info-d"),
  },
  // 工具栏只常驻 1/2 两档；四图 2×2 从设置抽屉里选（快捷键 4 仍可用），
  // 所以这里没有 4：取态靠 refreshLayoutUI 把两枚都置灰，下拉依旧显示 4
  layoutBtns: {
    1: el("btn-layout-1"),
    2: el("btn-layout-2"),
  },
  picker: el("file-picker"),
  // 文件夹浏览侧栏
  strip: el("filmstrip"),
  stripDir: el("fs-dir"),
  stripCount: el("fs-count"),
  stripTip: el("fs-tip"),
  stripList: el("fs-list"),
  btnStrip: el("btn-strip"),
  btnStripClose: el("btn-strip-close"),
  // 设置抽屉：布局与同步在这里只是上面那几个控件的镜像，滚轮行为则只剩这里一个入口
  settings: el("cmp-settings"),
  btnSettings: el("btn-cmp-settings"),
  btnSetClose: el("btn-set-close"),
  setLayout: el("sel-set-layout"),
  setSync: el("chk-set-sync"),
  setWheel: el("sel-set-wheel"),
};

/* --------------------------------------------------------------------------
 * Pane：一个图窗（视口 + 图片层 + 视图状态）
 * ------------------------------------------------------------------------ */
class Pane {
  constructor(key) {
    this.key = key;
    this.root = el("pane-" + key);
    this.viewport = this.root.querySelector(".viewport");
    this.layer = this.root.querySelector(".layer");
    this.img = this.root.querySelector(".canvas");
    this.tagName = this.root.querySelector(".tag-name");

    // 视图状态：scale 为倍率，x/y 为图片左上角相对视口左上角的位移（CSS 像素）
    this.st = { scale: 1, x: 0, y: 0 };
    this.natural = { w: 0, h: 0 };
    this.meta = null; // { name, size, path }
    this.loaded = false;
  }

  get size() {
    return { w: this.viewport.clientWidth, h: this.viewport.clientHeight };
  }

  apply() {
    const { scale, x, y } = this.st;
    this.layer.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    // 高倍放大时按最近邻显示，方便逐像素比对
    this.img.style.imageRendering = scale >= 2 ? "pixelated" : "auto";
  }

  /** 载入图片并适应窗口；path 是本机原路径，没有它就不能「作为文件复制」 */
  async setImage({ dataUrl, name, size, natural, path }) {
    this.img.src = dataUrl;
    this.natural = natural;
    this.img.style.width = natural.w + "px";
    this.img.style.height = natural.h + "px";
    this.meta = { name, size, path };
    this.loaded = true;
    this.root.classList.add("has-image");
    this.tagName.textContent = name || this.key.toUpperCase();
    this.tagName.title = name || "";
    // 同步模式下已有其它图载入：直接沿用它的视图，各窗立刻看到同一区域
    const ref = referencePane(this);
    if (isSync() && ref) {
      this.st = { ...ref.st };
      this.apply();
      refreshZoom();
    } else {
      this.fit(false);
    }
    refreshStatus();
  }

  clear() {
    this.img.removeAttribute("src");
    this.loaded = false;
    this.meta = null;
    this.natural = { w: 0, h: 0 };
    this.st = { scale: 1, x: 0, y: 0 };
    this.root.classList.remove("has-image");
    this.apply();
    refreshStatus();
  }

  /** 适应本窗（broadcast=false 时不通知另一个窗） */
  fit(broadcast = true) {
    if (!this.loaded) return;
    const { w: vw, h: vh } = this.size;
    if (!vw || !vh) return; // 视图被隐藏时尺寸为 0，此时不能重算，否则图会缩成 0
    const fit = Math.min(vw / this.natural.w, vh / this.natural.h);
    const scale = clamp(fit, MIN_SCALE, MAX_SCALE);
    this.st = {
      scale,
      x: Math.round((vw - this.natural.w * scale) / 2),
      y: Math.round((vh - this.natural.h * scale) / 2),
    };
    this.apply();
    if (broadcast && isSync()) syncFrom(this);
    refreshZoom();
  }

  /** 原始像素 */
  actualSize(broadcast = true) {
    if (!this.loaded) return;
    const { w: vw, h: vh } = this.size;
    this.st = {
      scale: 1,
      x: Math.round((vw - this.natural.w) / 2),
      y: Math.round((vh - this.natural.h) / 2),
    };
    this.apply();
    if (broadcast && isSync()) syncFrom(this);
    refreshZoom();
  }

  /** 以视口内某点为锚缩放（pos 为相对视口左上角的坐标） */
  zoomAt(factor, pos) {
    if (!this.loaded) return;
    applyZoom(this.st, factor, pos);
    this.apply();
  }

  /** 设定绝对倍率，以视口中心为锚 */
  setScale(scale) {
    if (!this.loaded) return;
    const { w: vw, h: vh } = this.size;
    applyZoom(this.st, scale / this.st.scale, { x: vw / 2, y: vh / 2 });
    this.apply();
  }

  panBy(dx, dy) {
    if (!this.loaded) return;
    this.st.x += dx;
    this.st.y += dy;
    this.apply();
  }
}

/** 缩放算法：保持锚点处的图像内容不动 */
function applyZoom(st, factor, anchor) {
  const target = clamp(st.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = target / st.scale;
  st.x = anchor.x - (anchor.x - st.x) * k;
  st.y = anchor.y - (anchor.y - st.y) * k;
  st.scale = target;
}

const PANE_KEYS = ["a", "b", "c", "d"];
const panes = {};
for (const key of PANE_KEYS) panes[key] = new Pane(key);

/* 三档布局。LAYOUT_KEYS 是「哪些窗可见」的唯一口径（顺序 a→b→c→d，网格下行优先），
   可见性与 CSS 的 body.layout-N 类同源：改一处必须两处一起改 */
const LAYOUTS = ["1", "2", "4"];
const LAYOUT_KEYS = { 1: ["a"], 2: ["a", "b"], 4: ["a", "b", "c", "d"] };
const LAYOUT_NAMES = { 1: "单图浏览", 2: "两图并排", 4: "四图 2×2" };
let layout = "2"; // 启动时被 applyPrefs 覆盖成磁盘上那一份

/** 当前布局下可见的窗 */
function visiblePanes() {
  return LAYOUT_KEYS[layout].map((k) => panes[k]);
}

/** 除自己以外的所有可见窗：同步广播、找空位填充都靠它 */
const peersOf = (pane) => visiblePanes().filter((p) => p !== pane);

/** 同步参照窗：优先当前活动窗，其次任意一个已载入的可见窗 */
function referencePane(self) {
  const pool = peersOf(self);
  return pool.find((p) => p === activePane && p.loaded) || pool.find((p) => p.loaded) || null;
}

/**
 * 切换布局：先抹掉分隔条留下的 inline flex，再换 body 上的类（显隐全在 CSS 里），最后重排可见窗。
 * @returns {boolean} 真的换了档才回 true（调用方拿它决定要不要存盘），
 *                    重复点当前档与非法值都回 false 且不写盘
 */
function setLayout(to) {
  if (!LAYOUTS.includes(to)) {
    console.warn("[layout] 未知布局:", to, "只认", LAYOUTS.join("/"));
    // 取态拉回真实那一档：不回正的话入口控件会停在一个界面根本没进入的档位上
    refreshLayoutUI();
    return false;
  }
  if (to === layout) return false;
  layout = to;
  for (const p of Object.values(panes)) p.root.style.flex = "";
  for (const k of LAYOUTS) document.body.classList.toggle("layout-" + k, k === to);
  refreshLayoutUI();
  // 窗格尺寸变了，已载入的图重新适应，否则网格下会错位溢出
  for (const p of visiblePanes()) if (p.loaded) p.fit(false);
  // 活动窗可能被切到隐藏位（如四图选了 C 再切回两图），换一个可见窗
  if (!visiblePanes().includes(activePane)) {
    activePane = visiblePanes().find((p) => p.loaded) || panes.a;
  }
  setPicked(activePane); // 选中态也得跟着换，否则 panePicked 会停在刚被切到隐藏的窗上
  if (isSync()) {
    const ref = visiblePanes().find((p) => p.loaded);
    if (ref) syncFrom(ref);
  }
  refreshZoom();
  refreshStatus();
  console.log("[layout] 切换到", LAYOUT_NAMES[to]);
  return true;
}

/** 布局在三个入口（工具栏那两枚 / 抽屉下拉 / 快捷键）上的取态一起刷新 */
function refreshLayoutUI() {
  for (const k of LAYOUTS) ui.layoutBtns[k]?.classList.toggle("is-active", k === layout);
  if (ui.setLayout) ui.setLayout.value = layout;
  // 只剩一个窗时「同步」没有作用，两个入口一起灰掉（状态不丢，切回多窗又生效）
  // 这枚开关是真 input 藏在 label 里，光靠 :disabled 看不出区别，所以另给一个类
  const single = layout === "1";
  for (const chk of [ui.syncChk, ui.setSync]) {
    if (!chk) continue;
    chk.disabled = single;
    const label = chk.closest ? chk.closest(".switch") : null;
    if (label) {
      label.classList.toggle("is-disabled", single);
      label.title = single ? "只剩一个窗，同步没有作用（切回 2/4 图可用）" : "开启后所有可见窗的缩放平移保持一致";
    }
  }
}

/* --------------------------------------------------------------------------
 * 全局控制状态
 * ------------------------------------------------------------------------ */
let activePane = panes.a; // 工具栏操作的目标窗（独立模式下生效）
// 用户明确点过哪个窗格：⌘V 就该进这个。和 activePane 分开记 ——
// assign() 也会改 activePane，光靠它分不清“用户选的”还是“刚被自动铺上的”
let panePicked = null;
const isSync = () => ui.syncChk.checked;
/** 滚轮行为的真值就存在设置抽屉那个下拉上（工具栏那枚 `#sel-wheel` 已按用户要求拆掉）；
 *  抽屉是 HTML 常驻的，理论上不会为空，但滚轮监听比它先跑也不能报错 */
const wheelMode = () => ui.setWheel?.value || "zoom";

/* --------------------------------------------------------------------------
 * 偏好的读与存：一次读（启动时）、每次存（任何一个控件改动时）
 *
 * 非 Tauri 环境（直接在浏览器里打开 js/index.html 调试）两条命令都会挂，
 * 这里一律当成「存不上」处理：界面照常可用，只是下次启动回到出厂态。
 * ------------------------------------------------------------------------ */
let prefsLoaded = false; // 存盘前的读时基准，不能让启动默认值把用户存的盖掉

function currentPrefs() {
  return { layout, sync: isSync(), wheel: wheelMode() };
}

/** 把界面上的三个当前值写进 prefs.json。失败只说一声，不拦任何操作 */
async function savePrefs(patch) {
  if (!isTauriRuntime) return;
  try {
    await invoke("set_prefs", patch || currentPrefs());
  } catch (err) {
    console.error("[prefs] 存盘失败:", err);
    setStatus("设置没能存盘: " + errText(err));
  }
}

/** 启动时读一次，把存着的布局/同步/滚轮行为落到界面上 */
async function loadPrefs() {
  if (!isTauriRuntime) return;
  let p;
  try {
    p = await invoke("get_prefs");
  } catch (err) {
    // 没有这个文件本身就是首启动，不必把出厂态说成一次故障
    console.log("[prefs] 读不到已存设置，用出厂态：%s", errText(err));
    return;
  }
  prefsLoaded = true;
  applyPrefs({
    layout: String(p?.layout ?? "2"),
    sync: p?.sync !== false,
    wheel: p?.wheel === "pan" ? "pan" : "zoom",
  });
}

/**
 * 应用一份偏好到界面。每一步都先比当前值：相等就不动，
 * 否则一次启动会多出几次「看起来改了但其实没改」的存盘与重排。
 * 程序化改 checked/value 不会触发 change 事件，所以这里不会自己转回去。
 */
function applyPrefs(p) {
  if (LAYOUTS.includes(p.layout) && p.layout !== layout) setLayout(p.layout);
  else refreshLayoutUI(); // 布局没变也要把下拉与按钮取态对上一次（读到脏值时就是这个分支）
  if (ui.syncChk && ui.syncChk.checked !== p.sync) {
    ui.syncChk.checked = p.sync;
    syncChkChanged(); // 走跟用户点同一个入口：开了就立刻对齐，不让两窗停在两个区域
  }
  if (ui.setSync) ui.setSync.checked = p.sync;
  if (ui.setWheel) ui.setWheel.value = p.wheel;
}

/** 把来源窗的状态复制给其它所有可见窗（同步模式） */
function syncFrom(src) {
  if (!isSync()) return;
  for (const dst of peersOf(src)) {
    if (!dst.loaded) continue;
    dst.st = { ...src.st };
    dst.apply();
  }
  refreshZoom();
}

function refreshZoom() {
  const pct = Math.round((activePane ? activePane.st.scale : 1) * 100);
  ui.zoomLabel.textContent = pct + "%";
  ui.stZoom.textContent = pct + "%";
  ui.zoomSlider.value = String(clamp(pct, 25, 800));
}

function refreshStatus() {
  for (const key of PANE_KEYS) {
    const p = panes[key];
    const slot = ui.stInfo[key];
    if (!slot) continue;
    if (!p.loaded) {
      slot.textContent = `${key.toUpperCase()}: 未载入`;
      slot.title = "";
      continue;
    }
    const mb = (p.meta.size / 1024 / 1024).toFixed(2);
    slot.textContent = `${key.toUpperCase()}: ${p.meta.name} · ${p.natural.w}×${p.natural.h} · ${mb}MB`;
    slot.title = p.meta.name || "";
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* --------------------------------------------------------------------------
 * 图片载入：Tauri 走 Rust 命令，浏览器环境退回 File API
 * ------------------------------------------------------------------------ */
function measureNatural(dataUrl) {
  return new Promise((resolve, reject) => {
    // 先查入参：上一版就是因为 dataUrl 为 undefined 时 probe.src 加载失败，
    // 报出「解码失败」的假线索，把字段名不匹配的问题带偏了一轮
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      reject(
        new Error(
          "图片数据无效：期望 data: URL，实际 " +
            (dataUrl === undefined ? "undefined" : typeof dataUrl + " " + String(dataUrl).slice(0, 24))
        )
      );
      return;
    }
    const probe = new Image();
    probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => {
      console.error("[decode] 失败，URL 前缀:", dataUrl.slice(0, 32), "长度:", dataUrl.length);
      reject(
        new Error("图片解码失败（前缀 " + dataUrl.slice(0, 12) + "…、" + dataUrl.length + " 字符）")
      );
    };
    probe.src = dataUrl;
  });
}

/** File -> data URL：不用 blob:，因为 tauri:// 自定义协议下创建的 blob URL 无法被 img 加载 */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取文件失败: " + (reader.error?.message || "未知")));
    reader.readAsDataURL(file);
  });
}

async function loadPathIntoPane(pane, path) {
  const payload = await invoke("read_image", { path });
  // 两种命名都接，避免 Rust 侧 serde 重命名再造成静默 undefined
  const dataUrl = payload?.data_url ?? payload?.dataUrl;
  if (!dataUrl) {
    throw new Error(
      "后端未返回图片数据，实际字段: [" + Object.keys(payload || {}).join(", ") + "]"
    );
  }
  const natural = await measureNatural(dataUrl);
  await pane.setImage({
    dataUrl,
    name: payload.name,
    size: payload.size,
    natural,
    // 后端回的路径才是读过盘的那个，回不上就用人传进去的
    path: payload.path || path,
  });
}

async function loadFileIntoPane(pane, file) {
  // WKWebView 递出的 File 可能是 0 字节（只带名字/类型），先显式拦截，避免报成“解码失败”
  if (!file.size) {
    throw new Error(
      "WebView 只拿到了 0 字节的文件对象（" + file.name + "），请改用拖拽或「打开对比」"
    );
  }
  const dataUrl = await readFileAsDataURL(file);
  const natural = await measureNatural(dataUrl);
  await pane.setImage({ dataUrl, name: file.name, size: file.size, natural });
}

/** 按顺序把若干来源填入可见窗：指定目标窗则先填它，其余按序找空窗（都满则覆盖） */
async function fillPanes(sources, targetKey) {
  const visible = visiblePanes();
  const list = sources.slice(0, visible.length); // 超出当前布局容容量的部分丢弃
  // 指定了一个当前布局下根本看不见的窗（分窗入口拆掉后这条路基本走不到了，留着当防御：
  // 宁可当没指定，也绝不能默默塞一个看不见的窗进去）
  let target = targetKey && panes[targetKey];
  if (target && !visible.includes(target)) {
    console.log("[load] %s 窗在%s布局下不可见，改填可见窗", targetKey, LAYOUT_NAMES[layout]);
    target = null;
  }
  const used = new Set();
  let lastPane = null; // 最后一个填成功的窗，给浏览侧栏当轮转起点
  let lastSrc = null;
  try {
    let idx = 0;
    if (target) {
      lastSrc = list[idx];
      await assign(target, lastSrc);
      lastPane = target;
      used.add(targetKey);
      idx++;
    }
    for (; idx < list.length; idx++) {
      let pane = visible.find((p) => !used.has(p.key) && !p.loaded);
      if (!pane) pane = visible.find((p) => !used.has(p.key)); // 没有空窗就按序覆盖
      if (!pane) break;
      used.add(pane.key);
      lastSrc = list[idx];
      await assign(pane, lastSrc);
      lastPane = pane;
    }
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("[load] 载入图片失败:", err);
    ui.stPos.textContent = "载入失败: " + msg;
    setStatus("载入失败: " + msg);
    console.log("[load] 当前环境 isTauriRuntime=", isTauriRuntime);
  }
  // 五个载入入口都汇到这里，所以浏览列表也只在这一处接线
  if (lastPane) noteLoaded(lastPane, lastSrc);
}

function assign(pane, src) {
  activePane = pane;
  return typeof src === "string" ? loadPathIntoPane(pane, src) : loadFileIntoPane(pane, src);
}

/* ---------------------------------- 打开 --------------------------------- */
let openInFlight = false; // 单击+双击连发时，避免一次弹出两个文件面板

// Tauri 下走 Rust 文件对话框：选中的文件由 Rust 读字节后回 data URL。
// 不用 <input type=file>：WKWebView 递出的 File 是 0 字节，读不出内容
async function openImages(targetKey) {
  if (openInFlight) return;
  openInFlight = true;
  try {
    if (isTauriRuntime) {
      const paths = await invoke("pick_images");
      if (paths && paths.length) {
        await fillPanes(paths, targetKey);
      } else {
        console.log("[open] 用户取消选择或未取得路径");
      }
      return;
    }
    ui.picker.value = "";
    ui.picker.dataset.target = targetKey || "";
    ui.picker.click();
  } finally {
    openInFlight = false;
  }
}

// 图窗只收图片：剪贴板里是 zip/pdf 之类时不该硬塞进去报「载入失败」，
// 而是退回让用户自己选文件，所以这里不用 routeDrop 而是自己筛一遍扩展名
// （IMAGE_EXT 从 api.js 导，三个视图共用一份口径）

/**
 * 把剪贴板里的图片直接装进指定图窗（单击空窗的第一选择）。
 * 读剪贴板只能在后端做（WKWebView 的 paste 事件拿不到内容，见 clip.rs），
 * 返回的是路径，下游与拖拽完全一样。
 * @returns {Promise<boolean>} 粘到了就 true；剪贴板里没图片就 false 且不弹任何提示
 */
async function pasteIntoPane(pane) {
  let paths;
  try {
    paths = await invoke("paste_paths");
  } catch (err) {
    console.log("[open] 剪贴板里没有可粘的内容（%s），改用文件选择", errText(err));
    return false;
  }
  const images = (paths || []).filter((p) => IMAGE_EXT.test(p));
  if (!images.length) {
    console.log("[open] 剪贴板里没有图片（共 %d 项），改用文件选择", paths?.length || 0);
    return false;
  }
  // 重复粘同一份内容时后端会复用同一个文件，不再多落一份
  await fillPanes(images, pane.key);
  return true;
}

ui.picker.addEventListener("change", () => {
  const files = Array.from(ui.picker.files || []);
  if (files.length) fillPanes(files, ui.picker.dataset.target || null);
});

/* --------------------------------------------------------------------------
 * 文件夹浏览侧栏：列出「当前这张图所在目录」的全部图片，点一行就看那张。
 * 两种落窗口径，按布局分流：
 *   2/4 图 —— 严格交替，上一次落在 A 这次就去 B，另一个窗始终留着前后那一张做对照；
 *            四图布局下 C/D 不参与轮转。
 *   1 图 —— 只看一张：只有 A 窗可见，点一行就是换掉那一张，不留对照位。
 *           这个模式下 B/C/D 都藏起来，想回到对照就按 2 或 4（列表与当前项都在）。
 *
 * 小图的内存口径（为什么不是一片真缩略图）：项目刻意不带 image 依赖
 * （Cargo.toml 里连 arboard 都关了默认特性就是为了不拖进整套图片解码），
 * Rust 侧出不了真缩略图；而 read_image 回的是整图 base64（上限 80MB），
 * 一个目录几百张绝不可能一次全读。所以只给「当前项 ±STRIP_DECODE_WINDOW」
 * 和滚进视口的行申请，超过 STRIP_AUTO_MAX 的不自动解，并且拿 LRU 卡总量。
 * ------------------------------------------------------------------------ */
const STRIP_DECODE_WINDOW = 1; // 当前项前后各解几张（1 → 最多 3 张在解码）
const STRIP_LRU_MAX = 8; // 内存里最多留几张整图 data URL
const STRIP_AUTO_MAX = 4 * 1024 * 1024; // 体积闸门：与传输视图的 PREVIEW_AUTO_MAX 同口径
const STRIP_INFLIGHT_MAX = 3; // 同时发出去的 read_image 封顶
const STRIP_DIR_MAX = 2000; // 与 Rust 的 FOLDER_MAX_ITEMS 对齐，后端截断时说明一声
const STRIP_NAME_MAX = 16; // 侧栏名称列的显示上限：190px 侧栏里名称列只剩 ~102px，12px 字号下正好放得下 16 字符

const browse = {
  dir: "", // 列表是哪个目录（同目录不重发 IPC）
  items: [], // [{ path, name, size }]，已按自然序排好
  idx: -1, // 正在看的是第几项
  sel: -1, // 侧栏键盘选中行：↑↓ 一动就把那一张显示出来（与点行完全同一条路）
  slot: null, // 上一次浏览落在哪个窗（a/b），下一次去对面
  open: false, // 侧栏显不显示
  userClosed: false, // 用户自己收过一回就别再自动弹出来抢地方
  inflight: false, // 连点时别两个请求抢着写同一个窗
  wanted: null, // 连按方向键时上一次还没读完：只记最后想要那一张，读完这趟再补一次
  truncated: false, // 后端把目录截断了
  bad: new Set(), // 读失败的路径：行标灰但不隐藏
};

/** path -> 整图 data URL。拿 Map 的插入顺序当 LRU：命中就重新插到末尾 */
const thumbCache = new Map();
let thumbInflight = 0;
let stripRows = []; // 与 browse.items 一一对应，只在列表换了时重建
let stripFocused = false;

function splitPath(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return { dir: i > 0 ? s.slice(0, i) : "", base: i >= 0 ? s.slice(i + 1) : s };
}
const dirOf = (p) => splitPath(p).dir;
const baseOf = (p) => splitPath(p).base;

/** 侧栏里的文件名从中间裁，不留整串：这类图（UUID、微信哈希、带时间戳的生成图）
 *  开头往往一个样，区分点全在尾部，而纯 CSS 的末尾省略号恰好把时间戳和扩展名一起吃掉。
 *  上限是按侧栏实际宽度算的（见 STRIP_NAME_MAX），不是拍脑袋：超出的部分在界面上根本放不下。
 *  完整名一直在 row.title（整条路径）里，悬停能看全；万一某个字体下 16 字符还是宽了一点，
 *  CSS 的 text-overflow 是最后一道保险 */
function shortName(name) {
  const s = String(name || "");
  if (s.length <= STRIP_NAME_MAX) return s;
  const dot = s.lastIndexOf(".");
  // 只认末尾那段像扩展名的（点后最长 8 字符）；点后拖着一长串的（“foo.很长很长的尾”）就当没扩展名，整串裁
  const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : "";
  const stem = ext ? s.slice(0, s.length - ext.length) : s;
  const keep = STRIP_NAME_MAX - ext.length - 1; // 1 位留给省略号
  if (keep < 6) return s.slice(0, STRIP_NAME_MAX - 1) + "…"; // 扩展名长到没什么可留：整串裁
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return stem.slice(0, head) + "…" + (tail > 0 ? stem.slice(stem.length - tail) : "") + ext;
}

function formatBytes(n) {
  if (!n) return ""; // 后端拿不到体积时宁可不写，也别编个 0KB 给人看
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return Math.max(1, Math.round(n / 1024)) + "KB";
}

/** 严格交替：上次落在 a/b 哪个这次就去对面。还没浏览过去「活动窗的对面」，
 *  刚手动打开的那张不能被第一次浏览顺手顶掉。
 *  单图布局只剩 A 一个窗，没有对面可去 —— 点列表就是换掉那一张 */
function nextBrowseSlot() {
  if (layout === "1") return "a";
  if (browse.slot === "a") return "b";
  if (browse.slot === "b") return "a";
  const cur = activePane && (activePane.key === "a" || activePane.key === "b") ? activePane.key : "a";
  return cur === "a" ? "b" : "a";
}

const otherKey = (k) => (k === "a" ? "b" : "a");

/**
 * 填完图窗之后的接线处：browse.slot 记成「刚放进去那个窗」，下一次浏览就去对面
 * —— 这样第一次浏览绝不会把刚打开的那张顶掉。
 * 五个载入入口（⌘O、单击空窗、拖文件进窗、⌘V、外部打开）都走 fillPanes，
 * 所以只在这一处接线。
 */
function noteLoaded(pane, src) {
  if (!pane) return;
  if (pane.key === "a" || pane.key === "b") browse.slot = pane.key;
  const path = typeof src === "string" ? src : pane.meta?.path || "";
  ensureFolderList(path);
}

/** 列这张图所在目录的图片。拿不到本机路径的来源（浏览器兜底、File 对象）退回提示 */
async function ensureFolderList(path) {
  if (!isTauriRuntime || !path) {
    browse.items = [];
    browse.dir = "";
    browse.idx = -1;
    browse.sel = -1;
    applyStripVisibility("这个来源没有本机路径，列不出文件夹");
    return;
  }
  const dir = dirOf(path);
  if (!dir) {
    applyStripVisibility("这个路径看不出所在目录");
    return;
  }
  if (dir === browse.dir && browse.items.length) {
    // 同一个目录只把当前项对齐，不重发 IPC
    const i = browse.items.findIndex((it) => it.path === path);
    browse.idx = i;
    browse.sel = i;
    applyStripVisibility();
    markStrip();
    requestNearThumbs();
    return;
  }
  let payload;
  try {
    payload = await invoke("list_folder_images", { path });
  } catch (err) {
    const msg = errText(err);
    console.error("[browse] 列目录失败:", err);
    setStatus("列目录失败: " + msg);
    browse.items = [];
    browse.dir = "";
    applyStripVisibility(msg); // 原因原文写进侧栏，不改成「暂无图片」这种猜话
    return;
  }
  // 后端已经按扩展名筛过，这里再挡一层：前端这份 IMAGE_EXT 是三个视图共用的口径
  const items = (payload?.items || []).filter((it) => it && IMAGE_EXT.test(it.path || ""));
  // 自然序在前端做：localeCompare 的 numeric 天然得到 IMG_2 < IMG_10
  items.sort((a, b) =>
    String(a.name || baseOf(a.path)).localeCompare(String(b.name || baseOf(b.path)), "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base",
    })
  );
  browse.dir = payload?.dir || dir;
  browse.items = items;
  browse.truncated = !!payload?.truncated;
  browse.bad = new Set();
  thumbCache.clear();
  const i = items.findIndex((it) => it.path === path);
  browse.idx = i;
  browse.sel = i;
  if (!browse.userClosed) browse.open = true; // 有列表了就自动露出来
  applyStripVisibility();
  renderStrip();
}

function applyStripVisibility(tip) {
  if (ui.strip) ui.strip.hidden = !browse.open;
  if (ui.btnStrip) {
    ui.btnStrip.disabled = !browse.items.length;
    ui.btnStrip.classList.toggle("is-active", browse.open && browse.items.length > 0);
    ui.btnStrip.title = browse.items.length
      ? "浏览这张图所在文件夹的全部图片（⌘⇧B 开关）"
      : "先打开一张本机的图，就会列出它所在的文件夹";
  }
  if (ui.stripDir) {
    ui.stripDir.textContent = browse.dir ? baseOf(browse.dir) : "";
    ui.stripDir.title = browse.dir || "";
  }
  if (ui.stripCount) ui.stripCount.textContent = browse.items.length ? `${browse.items.length} 张` : "";
  if (ui.stripTip) {
    ui.stripTip.textContent = tip || "";
    ui.stripTip.hidden = !tip;
  }
}

function toggleStrip(byUser) {
  if (!browse.items.length) {
    setStatus("还没有可浏览的文件夹（先打开一张本机的图）");
    return;
  }
  browse.open = !browse.open;
  if (byUser) browse.userClosed = !browse.open;
  applyStripVisibility();
}

function focusStrip() {
  if (ui.strip && typeof ui.strip.focus === "function") {
    try {
      ui.strip.focus({ preventScroll: true });
    } catch {
      ui.strip.focus();
    }
  }
}

/** 重建行只在目录换了时走；切换当前项只改 class，否则小图会被拆掉重解 */
function renderStrip() {
  buildStrip();
  markStrip();
  requestNearThumbs();
}

function buildStrip() {
  stripRows = [];
  const list = ui.stripList;
  if (!list) return;
  // 旧行先从观察名单里摘干净：换目录时旧节点已被拆掉，但 IO 还强引用着它们，
  // 一个目录接一个目录地翻就会越积越多
  if (stripIO) stripIO.disconnect();
  list.textContent = "";
  for (let i = 0; i < browse.items.length; i++) {
    const it = browse.items[i];
    const row = document.createElement("div");
    row.className = "fs-row";
    row.setAttribute("role", "option");
    row.dataset.index = String(i);
    row.dataset.path = it.path;
    row.title = it.path;
    const no = document.createElement("span");
    no.className = "fs-no";
    no.textContent = String(i + 1);
    const thumb = document.createElement("div");
    thumb.className = "fs-thumb";
    const main = document.createElement("div");
    main.className = "fs-main";
    const name = document.createElement("span");
    name.className = "fs-name";
    name.textContent = shortName(it.name || baseOf(it.path));
    const size = document.createElement("span");
    size.className = "fs-size";
    size.textContent = formatBytes(it.size);
    main.appendChild(name);
    main.appendChild(size);
    row.appendChild(no);
    row.appendChild(thumb);
    row.appendChild(main);
    row.addEventListener("click", () => {
      // 点完把焦点给侧栏：接着按 ↑↓ 就能连着翻，不用回工具栏找按钮
      focusStrip();
      browseTo(i);
    });
    list.appendChild(row);
    stripRows.push(row);
    if (stripIO) stripIO.observe(row);
  }
  if (browse.truncated) {
    const p = document.createElement("p");
    p.className = "fs-tip";
    p.textContent = `目录过大，只列出前 ${STRIP_DIR_MAX} 张`;
    list.appendChild(p);
  }
}

function markStrip() {
  for (let i = 0; i < stripRows.length; i++) {
    const row = stripRows[i];
    const it = browse.items[i];
    if (!row || !it) continue;
    row.classList.toggle("is-current", i === browse.idx);
    // is-sel 只挂类不描边（style.css 里那个框已拆）：↑↓ 之后它与 is-current 就在同一行
    row.classList.toggle("is-sel", i === browse.sel);
    row.classList.toggle("is-bad", browse.bad.has(it.path));
  }
  const target = browse.sel >= 0 ? browse.sel : browse.idx;
  const row = stripRows[target];
  if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
}

/** 该行在不在「当前项附近」这个自动窗口里（窗口外一律不主动读盘）。
 *  体积闸门不在这里判：过大的要给「大」字占位，见 ensureThumb */
function inDecodeWindow(i) {
  return browse.idx >= 0 && !!browse.items[i] && Math.abs(i - browse.idx) <= STRIP_DECODE_WINDOW;
}

function paintThumb(row, dataUrl) {
  const box = row && row.querySelector ? row.querySelector(".fs-thumb") : null;
  if (!box) return;
  box.textContent = "";
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = dataUrl;
  box.appendChild(img);
}

function setThumbPlaceholder(row, text) {
  const box = row && row.querySelector ? row.querySelector(".fs-thumb") : null;
  if (!box || box.querySelector("img")) return;
  box.textContent = "";
  const span = document.createElement("span");
  span.className = "fs-thumb-pending";
  span.textContent = text;
  box.appendChild(span);
}

/** 滚出视口就把位图摘掉（data URL 还在 LRU 里，滚回来不用重读盘） */
function dropThumb(row) {
  const box = row && row.querySelector ? row.querySelector(".fs-thumb") : null;
  const img = box && box.querySelector ? box.querySelector("img") : null;
  if (img) {
    img.removeAttribute("src");
    box.textContent = "";
  }
}

function rememberThumb(path, dataUrl) {
  if (!path || !dataUrl) return;
  thumbCache.delete(path);
  thumbCache.set(path, dataUrl);
  while (thumbCache.size > STRIP_LRU_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === path) break;
    thumbCache.delete(oldest);
    const row = stripRows.find((r) => r.dataset.path === oldest);
    if (row) dropThumb(row);
  }
}

/** force=true 是用户主动点行/载入大图后补的，不受窗口与体积闸门限制 */
async function ensureThumb(i, force) {
  const row = stripRows[i];
  const it = browse.items[i];
  if (!row || !it || browse.bad.has(it.path)) return;
  const box = row.querySelector(".fs-thumb");
  if (!box || box.querySelector("img")) return;
  const cached = thumbCache.get(it.path);
  // 已经读过盘的就直接画：这一趟不花任何解码代价，跟在不不在窗口里无关
  if (cached) {
    paintThumb(row, cached);
    return;
  }
  if (!force && !inDecodeWindow(i)) return;
  if (!force) {
    // 大图不自动解：整图 base64 太吃内存，给个「大」字占位，点行才真读一次
    if (Number(it.size) > STRIP_AUTO_MAX) {
      setThumbPlaceholder(row, "大");
      return;
    }
  }
  if (thumbInflight >= STRIP_INFLIGHT_MAX) return;
  thumbInflight++;
  setThumbPlaceholder(row, "…");
  try {
    const payload = await invoke("read_image", { path: it.path });
    const dataUrl = payload?.data_url ?? payload?.dataUrl;
    if (dataUrl) {
      rememberThumb(it.path, dataUrl);
      paintThumb(row, dataUrl);
    }
  } catch (err) {
    console.warn("[browse] 侧栏小图读失败:", it.path, errText(err));
    browse.bad.add(it.path);
    setThumbPlaceholder(row, "×");
    markStrip();
  } finally {
    thumbInflight--;
  }
}

/** 没得 IntersectionObserver（或自检桩里没这个 API）时，靠这个窗口兼一下 */
function requestNearThumbs() {
  if (stripIO) {
    // IO 只管滚进滚出，当前项附近的这几张无论如何先保证
    for (let i = browse.idx - STRIP_DECODE_WINDOW; i <= browse.idx + STRIP_DECODE_WINDOW; i++) {
      if (i >= 0) ensureThumb(i, false);
    }
    return;
  }
  for (let i = 0; i < browse.items.length; i++) {
    if (inDecodeWindow(i)) ensureThumb(i, false);
    else {
      const row = stripRows[i];
      if (row && !thumbCache.get(browse.items[i].path)) dropThumb(row);
    }
  }
}

const stripIO =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            const i = Number(en.target?.dataset?.index);
            if (!Number.isFinite(i)) continue;
            if (en.isIntersecting) ensureThumb(i, false);
            else dropThumb(en.target);
          }
        },
        { root: ui.stripList, rootMargin: "80px" }
      )
    : null;

/** 浏览到列表里第 index 张：2/4 图下落窗严格交替，单图下永远换 A；失败不推进游标 */
async function browseTo(index) {
  if (!browse.items.length) {
    setStatus("这个目录里没有图片");
    return;
  }
  if (index < 0 || index >= browse.items.length) {
    setStatus(index < 0 ? "已经是第一张（共 " + browse.items.length + " 张）" : "已经是最后一张（共 " + browse.items.length + " 张）");
    return;
  }
  const item = browse.items[index];
  // 已经在看这一张：不重读盘也不换窗。两图下重跑一次的副作用是把同一张塞进对面窗，
  // 看着像「莫名多出图」（选中行能停在它上面，↑↓ 到头再按、Enter 确认都会走这里）。
  // 靠可见窗里实际的 path 判定，不只看游标：中途 ⌘O 手动换过图的话游标还是旧的，
  // 那时必须重新读一次；落在隐藏窗里也算没在看（那个窗现在根本看不见）
  if (index === browse.idx && visiblePanes().some((p) => p.meta?.path === item.path)) {
    browse.sel = index;
    markStrip();
    return;
  }
  // 连按方向键时上一张还没读完：记住最后想要的那一张，等这趟结束只补最后一次，
  // 而不是把中间每一张都停下来看一回；也不能就这么把选中行丢在一张没显示的图上
  if (browse.inflight) {
    browse.wanted = index;
    return;
  }
  const key = nextBrowseSlot();
  const pane = panes[key];
  browse.sel = index;
  browse.inflight = true;
  try {
    await assign(pane, item.path);
  } catch (err) {
    // 失败（文件被移走/改名）不推 slot：对照位不能被一次失败的浏览悄悄换掉
    const msg = err?.message || String(err);
    console.error("[browse] 浏览失败:", err);
    ui.stPos.textContent = "载入失败: " + msg;
    setStatus("载入失败: " + msg);
    browse.bad.add(item.path);
    browse.wanted = null; // 这次没看成，排队的那个也作废：不然下一次会莫名跳到陈旧的一行
    markStrip();
    return;
  } finally {
    browse.inflight = false;
  }
  browse.slot = key;
  browse.idx = index;
  // 大图刚读过盘，那份 data URL 直接给侧栏复用，省一次 read_image
  rememberThumb(item.path, typeof pane.img?.src === "string" && pane.img.src.startsWith("data:") ? pane.img.src : "");
  setPicked(pane);
  markStrip();
  requestNearThumbs();
  setStatus(
    layout === "1"
      ? `第 ${index + 1}/${browse.items.length} 张`
      : `第 ${index + 1}/${browse.items.length} 张→${key.toUpperCase()} 窗，${otherKey(key).toUpperCase()} 窗留着上一张`
  );
  // 这趟期间又被按过去的：直接追到最新那一张，中间那些不停下来看
  if (browse.wanted !== null && browse.wanted !== index) {
    const w = browse.wanted;
    browse.wanted = null;
    await browseTo(w);
  } else {
    browse.wanted = null;
  }
}

function stepBrowse(delta) {
  if (!browse.items.length) {
    setStatus("还没有可浏览的文件夹（先打开一张本机的图）");
    return;
  }
  if (browse.idx < 0) {
    browseTo(0);
    return;
  }
  browseTo(browse.idx + delta);
}

/**
 * 侧栏 ↑↓：选中行一动，右边显示的那一张就跟着换成对应行（走与点行完全同一条 browseTo）。
 * 到头时只提示不再走 browseTo —— 那会把同一张再往对面窗塞一次。全局方向键仍归平移。
 */
function moveSel(delta) {
  if (!browse.items.length) return;
  const from = browse.sel >= 0 ? browse.sel : browse.idx >= 0 ? browse.idx : 0;
  const to = clamp(from + delta, 0, browse.items.length - 1);
  if (to === from && browse.sel >= 0) {
    setStatus(delta < 0 ? `已经是列表第一张（共 ${browse.items.length} 张）` : `已经是列表最后一张（共 ${browse.items.length} 张）`);
    return;
  }
  browse.sel = to;
  markStrip();
  browseTo(to);
}

/** Home/End 与 ↑↓ 同一个口径：选中哪行就显示哪行 */
function jumpSel(toFirst) {
  if (!browse.items.length) return;
  const to = toFirst ? 0 : browse.items.length - 1;
  if (to === browse.sel) return; // 已经在这一行了，不重读也不翻窗
  browse.sel = to;
  markStrip();
  browseTo(to);
}

if (ui.strip) {
  ui.strip.addEventListener("focus", () => {
    stripFocused = true;
    if (browse.sel < 0) browse.sel = browse.idx >= 0 ? browse.idx : 0;
    markStrip();
  });
  ui.strip.addEventListener("blur", () => {
    stripFocused = false;
  });
}
if (ui.btnStrip) ui.btnStrip.addEventListener("click", () => toggleStrip(true));
if (ui.btnStripClose) ui.btnStripClose.addEventListener("click", () => {
  browse.open = false;
  browse.userClosed = true;
  applyStripVisibility();
});

/* --------------------------------------------------------------------------
 * 视图交互：滚轮缩放 / 拖拽平移 / 坐标读数
 * ------------------------------------------------------------------------ */
function localPos(pane, ev) {
  const r = pane.viewport.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

for (const pane of Object.values(panes)) {
  const vp = pane.viewport;

  // 滚轮：默认缩放，可切换为平移；触控板捏合（ctrlKey）恒为缩放
  vp.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      activePane = pane;
      const anchor = localPos(pane, ev);
      const pinch = ev.ctrlKey; // 触控板捏合手势
      const shouldPan = !pinch && wheelMode() === "pan";

      if (shouldPan) {
        const dx = -ev.deltaX;
        const dy = -ev.deltaY;
        pane.panBy(dx, dy);
        if (isSync()) syncFrom(pane);
      } else {
        const factor = Math.exp(-ev.deltaY * 0.0018);
        pane.zoomAt(factor, anchor);
        if (isSync()) syncFrom(pane);
      }
      refreshZoom();
    },
    { passive: false }
  );

  // 拖拽平移
  let drag = null;
  let lastDown = null; // 用于区分“单击选图”与“拖拽平移”
  vp.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    activePane = pane;
    drag = { x: ev.clientX, y: ev.clientY };
    lastDown = { x: ev.clientX, y: ev.clientY };
    vp.setPointerCapture(ev.pointerId);
    vp.classList.add("dragging");
  });

  vp.addEventListener("pointermove", (ev) => {
    // 状态栏像素读数：鼠标位置换算到图片原始像素坐标
    if (pane.loaded) {
      const p = localPos(pane, ev);
      const ix = Math.floor((p.x - pane.st.x) / pane.st.scale);
      const iy = Math.floor((p.y - pane.st.y) / pane.st.scale);
      const inside = ix >= 0 && iy >= 0 && ix < pane.natural.w && iy < pane.natural.h;
      ui.stPos.textContent = `${pane.key.toUpperCase()} · ${inside ? ix + ", " + iy : "—"}`;
    }

    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag = { x: ev.clientX, y: ev.clientY };
    pane.panBy(dx, dy);
    if (isSync()) syncFrom(pane);
  });

  const endDrag = (ev) => {
    if (!drag) return;
    drag = null;
    vp.classList.remove("dragging");
    if (ev && ev.pointerId !== undefined && vp.hasPointerCapture(ev.pointerId)) {
      vp.releasePointerCapture(ev.pointerId);
    }
  };
  vp.addEventListener("pointerup", endDrag);
  vp.addEventListener("pointercancel", endDrag);
  vp.addEventListener("pointerleave", () => (ui.stPos.textContent = "—"));

  // 空窗单击 = 直接把剪贴板里的图粘进来；剪贴板没接住才退回文件选择框。
  // 拖拽过（位移 > 6px）不算单击
  vp.addEventListener("click", (ev) => {
    if (!lastDown) return;
    const moved = Math.abs(ev.clientX - lastDown.x) + Math.abs(ev.clientY - lastDown.y);
    if (moved > 6) return;
    activePane = pane;
    setPicked(pane);
    // 已有图的窗格：单击只做「选中」，换图交给 ⌘V（之前这里直接 return，
    // 连选中都不记，于是一次 ⌘V 又铺到第一个空窗去了）
    if (pane.loaded) return;
    pasteIntoPane(pane).then((ok) => {
      if (!ok) openImages(pane.key);
    });
  });

  // 双击 = 适应窗口 / 100% 互切（空窗由上面的单击接管，此处不再处理）
  vp.addEventListener("dblclick", () => {
    activePane = pane;
    if (!pane.loaded) return;
    pane.st.scale >= 1 ? pane.fit() : pane.setScale(1);
    if (isSync()) syncFrom(pane);
    refreshZoom();
  });

  // 浏览器（非 Tauri）下的 HTML5 拖拽兜底
  vp.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    pane.root.classList.add("drag-over");
  });
  vp.addEventListener("dragleave", () => pane.root.classList.remove("drag-over"));
  vp.addEventListener("drop", async (ev) => {
    if (isTauriRuntime) return; // Tauri 下由原生拖拽事件接管
    ev.preventDefault();
    pane.root.classList.remove("drag-over");
    const file = Array.from(ev.dataTransfer?.files || [])[0];
    if (file) await fillPanes([file], pane.key);
  });
}

/* --------------------------------------------------------------------------
 * Tauri 原生文件拖拽（整窗投递，按落点坐标决定进哪个窗）
 * ------------------------------------------------------------------------ */
let lastDragTarget = null; // enter/over 期间缓存的落点窗，drop 不带坐标时用它

if (isTauriRuntime) {
  window.__TAURI__.window
    .getCurrentWindow()
    .onDragDropEvent((event) => {
      const p = event.payload;
      // 先按视图分流：传输/收藏视图下绝不能进图窗命中，否则拖文件会莫名变成载入对比
      if (currentView() !== "compare") {
        // 悬停阶段也要分流出去，那边的视图要靠遮罩提示「松开即发送」
        routeDropHover(p.type);
        if (p.type === "drop" && p.paths?.length) {
          routeDrop(p.paths);
        }
        return;
      }
      if (p.type === "enter" || p.type === "over") {
        // 新一轮拖拽（enter）先清空上一轮的缓存，避免串台
        if (p.type === "enter") lastDragTarget = null;
        const pane = paneAt(p.position);
        if (pane) lastDragTarget = pane;
        Object.values(panes).forEach((x) => x.root.classList.toggle("drag-over", x === pane));
      } else if (p.type === "leave") {
        lastDragTarget = null;
        Object.values(panes).forEach((x) => x.root.classList.remove("drag-over"));
      } else if (p.type === "drop") {
        Object.values(panes).forEach((x) => x.root.classList.remove("drag-over"));
        if (p.paths?.length) {
          const target = paneAt(p.position) || lastDragTarget;
          console.log(
            "[dragdrop] drop 坐标:",
            JSON.stringify(p.position),
            "dpr:",
            window.devicePixelRatio,
            "innerW:",
            window.innerWidth,
            "模式:",
            LAYOUT_NAMES[layout],
            "A 右边界:",
            Math.round(panes.a.viewport.getBoundingClientRect().right),
            "→ 落点窗:",
            target ? target.key : "未命中（自动分配）"
          );
          routeDrop(p.paths, target ? target.key : null);
        }
      }
    })
    .catch((err) => console.warn("[dragdrop] 监听失败:", err));
}

/** 落点判定目标窗：两图模式只看横向（规避标题栏纵向偏差），四图模式还要分上下行 */
const COLUMN_OF = { a: 0, b: 1, c: 0, d: 1 }; // 2×2 网格的列归属

function paneAt(position) {
  const raw = position?.x;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const dpr = window.devicePixelRatio || 1;
  const rects = visiblePanes().map((p) => ({ p, r: p.viewport.getBoundingClientRect() }));
  const hit = (x) => rects.find(({ r }) => x >= r.left && x <= r.right)?.p || null;

  const asLogical = hit(raw); // 口径已是 CSS 像素
  const asPhysical = hit(raw / dpr); // 口径是物理像素
  // 同解则直接采纳；分歧时 raw 超出窗口宽度必为物理像素，否则按逻辑像素
  const col =
    asLogical === asPhysical ? asLogical : raw > window.innerWidth ? asPhysical : asLogical;
  if (!col || layout !== "4") return col;

  // 网格模式：先限定到同一列（hit 按 a→b→c→d 取到的是该列首行窗），再按纵行分上下
  const colPanes = rects.filter(({ p }) => COLUMN_OF[p.key] === COLUMN_OF[col.key]);
  const rawY = position?.y;
  if (typeof rawY === "number" && Number.isFinite(rawY)) {
    for (const y of [rawY, rawY / dpr]) {
      const rowHit = colPanes.find(({ r }) => y >= r.top && y <= r.bottom);
      if (rowHit) return rowHit.p;
    }
  }
  // 纵行口径对不上时，退化成“填该列空着的那个窗”
  return colPanes.find(({ p }) => !p.loaded)?.p || col;
}

/* --------------------------------------------------------------------------
 * 系统「打开方式」/ 双击默认应用送来的文件
 * 冷启动时 Rust 收到 Opened 可能早于本脚本就绪，广播会丢，
 * 所以走事件 + 启动取队列双通道，再用短窗口时间去重，避免同一个文件被填两次
 * ------------------------------------------------------------------------ */
const handledOpens = new Map(); // path -> 时间戳

function handleExternalPaths(paths) {
  const now = Date.now();
  const fresh = (paths || []).filter((p) => {
    const last = handledOpens.get(p);
    if (last !== undefined && now - last < 1500) return false;
    handledOpens.set(p, now);
    return true;
  });
  if (!fresh.length) return;
  console.log("[open] 外部打开:", fresh);
  fillPanes(fresh); // 不指定目标窗：按空窗优先分配
}

if (isTauriRuntime) {
  window.__TAURI__.event
    .listen("open-paths", (ev) => handleExternalPaths(ev.payload))
    .catch((err) => console.warn("[open] 监听 open-paths 失败:", err));
  invoke("take_pending_paths")
    .then(handleExternalPaths)
    .catch((err) => console.warn("[open] 取待打开队列失败:", err));
}

// 别的视图（收到的图片、收藏里的路径）请求在对比里打开
registerOpenHandler("compare", (paths) => fillPanes(paths, pasteTargetKey()));
// 当前视图是「对比」时，拖进来的文件按落点窗进图窗；
// 没有落点（全局 ⌘V 走的就是这条）时认当前活动窗格，而不是永远从 A 开始铺
registerDropHandler("compare", (paths, paneKey) =>
  fillPanes(paths, paneKey || pasteTargetKey())
);

/**
 * 全局粘贴（⌘V）该进哪个窗格：用户点过的那个。
 * 点过了就**照进**，哪怕它已经有图（把那张换掉就是用户点的意图）；
 * 没点过、或点的那个已被布局切走时，退回“活动窗格空着就给它，否则找第一个空窗”。
 */
function pasteTargetKey() {
  if (panePicked && visiblePanes().includes(panePicked)) return panePicked.key;
  return activePane && !activePane.loaded ? activePane.key : null;
}

/**
 * 记下选中的窗格（下一次 ⌘V 的落点）。类名照旧挂到 DOM 上供 devtools 查，
 * 但 style.css 里不再给它描边 —— 用户要求拆掉那一圈蓝框。
 */
function setPicked(pane) {
  panePicked = pane;
  for (const key of PANE_KEYS) panes[key].viewport.classList.toggle("is-picked", panes[key] === pane);
}

/* --------------------------------------------------------------------------
 * 工具栏
 *
 * 「打开 A/B/C/D」四个入口已拆（用户要求）：要往指定窗里放图就单击那个空窗（先试粘剪贴板、
 * 没图才弹选文件，落点就是点的那格）、拖文件进窗，或者 ⌘V；一次多张走「打开对比」。
 * ------------------------------------------------------------------------ */
el("btn-open-pair").addEventListener("click", () => openImages(null));

// 工具栏那两枚、抽屉里那个下拉（三档都在）、快捷键都是 setLayout 的入口，存盘也只在这三处发。
// 只看 setLayout 的返回值：重复点当前档、非法值都没真的改过界面，不该多写一次盘
for (const k of LAYOUTS) {
  const btn = ui.layoutBtns[k];
  if (btn) btn.addEventListener("click", () => {
    if (setLayout(k)) savePrefs({ layout });
  });
}

el("btn-fit").addEventListener("click", () => {
  const visible = visiblePanes();
  for (const p of visible) p.fit(false);
  // 多窗都载入且开启同步时共用一个倍率（取最小者），保证每张图都完整可见
  const loaded = visible.filter((p) => p.loaded);
  if (isSync() && loaded.length > 1) {
    const shared = Math.min(...loaded.map((p) => p.st.scale));
    for (const p of loaded) {
      const { w: vw, h: vh } = p.size;
      const k = shared / p.st.scale;
      p.st.x = (p.st.x - vw / 2) * k + vw / 2;
      p.st.y = (p.st.y - vh / 2) * k + vh / 2;
      p.st.scale = shared;
      p.apply();
    }
  }
  refreshZoom();
});

el("btn-actual").addEventListener("click", () => {
  const targets = isSync() ? visiblePanes() : [activePane];
  targets.forEach((p) => p.loaded && p.actualSize(false));
  refreshZoom();
});

el("btn-zoom-in").addEventListener("click", () => zoomStep(1.25));
el("btn-zoom-out").addEventListener("click", () => zoomStep(0.8));

function zoomStep(factor) {
  const targets = isSync() ? visiblePanes() : [activePane];
  const center = (p) => ({ x: p.size.w / 2, y: p.size.h / 2 });
  targets.forEach((p) => {
    if (!p.loaded) return;
    p.zoomAt(factor, center(p));
  });
  refreshZoom();
}

ui.zoomSlider.addEventListener("input", () => {
  const scale = clamp(Number(ui.zoomSlider.value) / 100, MIN_SCALE, MAX_SCALE);
  const targets = isSync() ? visiblePanes() : [activePane];
  targets.forEach((p) => p.loaded && p.setScale(scale));
  refreshZoom();
});

/** 同步开关的共用动作：开了就以活动窗为准立刻对齐，不让两窗停在两个区域 */
function syncChkChanged() {
  if (isSync()) {
    if (activePane.loaded) syncFrom(activePane);
    ui.syncChk.title = "已开启：所有可见窗缩放平移保持一致";
  } else {
    ui.syncChk.title = "已关闭：各窗缩放平移互不影响";
  }
}

ui.syncChk.addEventListener("change", () => {
  // 两个入口指的是同一个开关：工具栏这里一改，抽屉里那枚也得跟上
  if (ui.setSync) ui.setSync.checked = ui.syncChk.checked;
  syncChkChanged();
  savePrefs({ sync: isSync() });
});

/* ----------------------------- 设置抽屉 ----------------------------- */
/** 开合抽屉的唯一入口：入口按钮的高亮必须跟着抽屉走，否则收起来之后还亮着 */
function setSettingsOpen(open) {
  if (!ui.settings) return;
  ui.settings.classList.toggle("is-open", open);
  ui.btnSettings?.classList.toggle("is-active", open);
}

if (ui.btnSettings && ui.settings) {
  ui.btnSettings.addEventListener("click", () => {
    setSettingsOpen(!ui.settings.classList.contains("is-open"));
  });
}

// 抽屉里那个「收起」的关抽屉动作由 view-transfer.js 的通用 [data-close-drawer] 监听顺手做了，
// 但这里不能只依赖它 —— 自检环境里没有 view-transfer，而且高亮得跟抽屉同一个入口收
if (ui.btnSetClose) ui.btnSetClose.addEventListener("click", () => setSettingsOpen(false));

if (ui.setLayout) {
  ui.setLayout.addEventListener("change", () => {
    if (setLayout(ui.setLayout.value)) savePrefs({ layout });
  });
}

if (ui.setSync) {
  ui.setSync.addEventListener("change", () => {
    ui.syncChk.checked = ui.setSync.checked; // 同一个开关，只是另一个入口
    syncChkChanged();
    savePrefs({ sync: isSync() });
  });
}

// 滚轮行为现在只剩抽屉这一个入口（工具栏那枚拆了），所以不再需要往另一个控件回写镜像
if (ui.setWheel) {
  ui.setWheel.addEventListener("change", () => {
    savePrefs({ wheel: wheelMode() });
  });
}

el("btn-clear").addEventListener("click", () => {
  // 清空一切：隐藏窗里的图不跟着布局切换留尾，免得下次切回来“莫名多出图”
  for (const p of Object.values(panes)) p.clear();
  refreshZoom();
  // 列表保留（还是那个目录），但当前项没了：下一次浏览从 A 起（slot 写 b 就是这个意思）
  browse.idx = -1;
  browse.sel = -1;
  browse.slot = "b";
  markStrip();
});

document.querySelectorAll(".tag-close").forEach((btn) => {
  btn.addEventListener("click", () => panes[btn.dataset.close].clear());
});

/* ------------------------------- 分隔条拖动 ------------------------------- */
(() => {
  let dragging = false;
  ui.splitter.addEventListener("pointerdown", (ev) => {
    if (layout !== "2") return; // 四图网格下等分两列、单图下只剩一个窗，都不允许拖
    dragging = true;
    ui.splitter.setPointerCapture(ev.pointerId);
    ui.splitter.classList.add("active");
  });
  ui.splitter.addEventListener("pointermove", (ev) => {
    if (!dragging || layout !== "2") return;
    const rect = ui.stage.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = clamp((ev.clientX - rect.left) / rect.width, 0.15, 0.85);
    panes.a.root.style.flex = `0 0 ${ratio * 100}%`;
    panes.b.root.style.flex = `0 0 ${(1 - ratio) * 100 - 0.6}%`;
  });
  const stop = (ev) => {
    if (!dragging) return;
    dragging = false;
    ui.splitter.classList.remove("active");
    if (ev && ev.pointerId !== undefined) ui.splitter.releasePointerCapture(ev.pointerId);
  };
  ui.splitter.addEventListener("pointerup", stop);
  ui.splitter.addEventListener("pointercancel", stop);
})();

/* --------------------------------------------------------------------------
 * 快捷键：只在对比视图生效，且焦点在输入框（含收藏/传输的文本域）时全部让行
 * ------------------------------------------------------------------------ */
const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** ⌘C 该带上哪几张：同步模式把所有已载入的窗一起拿，否则只拿当前活动窗 */
function copyTargets() {
  const pool = isSync()
    ? visiblePanes().filter((p) => p.loaded)
    : [activePane].filter((p) => p.loaded);
  // 同一个文件可以摆在两个窗里（把同一张拖进两格、或 ⌘O 连着选两次），不去重就会
  // 把同一条路径复制两份，粘出去就是两张一模一样的图
  return [...new Set(pool.map((p) => p.meta?.path).filter(Boolean))];
}

window.addEventListener("keydown", (ev) => {
  if (currentView() !== "compare") return;
  const t = ev.target;
  if (t && (EDITABLE.has(t.tagName) || t.isContentEditable)) return;

  const meta = ev.metaKey || ev.ctrlKey;
  const key = ev.key.toLowerCase();

  if (meta && key === "o") {
    ev.preventDefault();
    openImages(null);
    return;
  }
  if (meta && key === "c") {
    const paths = copyTargets();
    if (!paths.length) {
      toast("当前图没有本机路径，没法作为文件复制", "error");
      return;
    }
    ev.preventDefault();
    copyPathAsFile(paths);
    return;
  }
  if (meta && key === "b") {
    // 侧栏开关（⌘⇧B）。不抢单纯的 ⌘B，那是系统/其它应用的习惯键
    if (!ev.shiftKey) return;
    ev.preventDefault();
    toggleStrip(true);
    return;
  }
  if (meta && (key === "arrowleft" || key === "arrowright")) {
    // ⌘←/⌘→ 是 [ ] 的别名：翻上一张/下一张
    ev.preventDefault();
    stepBrowse(key === "arrowleft" ? -1 : 1);
    return;
  }
  if (key === "escape" && ui.settings && ui.settings.classList.contains("is-open")) {
    // 设置抽屉是覆盖层，比侧栏高一层：开着时 Esc 先收它（侧栏自己的「×」不走这里）
    ev.preventDefault();
    setSettingsOpen(false);
    return;
  }
  if (key === "escape" && stripFocused) {
    // 焦点在侧栏时 Esc 先收侧栏（对比视图里没有比这更上层的覆盖层）
    ev.preventDefault();
    browse.open = false;
    browse.userClosed = true;
    applyStripVisibility();
    return;
  }
  if (meta) return; // 交给系统快捷键（如 ⌘W / ⌘F）

  const targets = isSync() ? visiblePanes() : [activePane];
  switch (key) {
    case "0":
    case "f":
      ev.preventDefault();
      el("btn-fit").click();
      break;
    case "1":
      ev.preventDefault();
      el("btn-actual").click();
      break;
    case "2":
      ev.preventDefault();
      if (setLayout("2")) savePrefs({ layout });
      break;
    case "3":
      // 单图布局占用键 3：1 已经被「原始像素 1:1」占了
      ev.preventDefault();
      if (setLayout("1")) savePrefs({ layout });
      break;
    case "4":
      ev.preventDefault();
      if (setLayout("4")) savePrefs({ layout });
      break;
    case "+":
    case "=":
      ev.preventDefault();
      zoomStep(1.25);
      break;
    case "-":
      ev.preventDefault();
      zoomStep(0.8);
      break;
    case "[":
      ev.preventDefault();
      stepBrowse(-1);
      break;
    case "]":
      ev.preventDefault();
      stepBrowse(1);
      break;
    case "home":
      if (stripFocused) {
        ev.preventDefault();
        jumpSel(true);
      }
      break;
    case "end":
      if (stripFocused) {
        ev.preventDefault();
        jumpSel(false);
      }
      break;
    case "enter":
    case " ":
    case "spacebar":
      // ↑↓ 已经把那一行显示出来了，Enter/空格 留着当显式确认：
      // 已经在看这一行时 browseTo 会短路，既不重读盘也不把同一张塞给对面窗
      if (stripFocused) {
        ev.preventDefault();
        if (browse.sel >= 0) browseTo(browse.sel);
      }
      break;
    case "arrowleft":
    case "arrowright":
    case "arrowup":
    case "arrowdown": {
      ev.preventDefault();
      // 侧栏拿到焦点时上下键归「选上一行/下一行」，并把那一张直接显示出来
      if (stripFocused && (key === "arrowup" || key === "arrowdown")) {
        moveSel(key === "arrowup" ? -1 : 1);
        return;
      }
      const dx = key === "arrowleft" ? -PAN_STEP : key === "arrowright" ? PAN_STEP : 0;
      const dy = key === "arrowup" ? -PAN_STEP : key === "arrowdown" ? PAN_STEP : 0;
      targets.forEach((p) => p.loaded && p.panBy(dx, dy));
      break;
    }
    default:
      break;
  }
});

/* ------------------------------- 初始化 -------------------------------- */
window.addEventListener("resize", () => refreshZoom());
for (const p of Object.values(panes)) p.apply();
refreshZoom();
refreshStatus();
// 布局/同步/滚轮行为从 prefs.json 恢复（非 Tauri 环境直接返回，用出厂态）。
// 异步：首帧先按 HTML 写死的 layout-2 排布，读到存的那一档再切过去
loadPrefs();

// 切回对比视图时重新量一次：视图隐藏期间 clientWidth 是 0，不能在那时候 fit
onViewChange((name) => {
  if (name !== "compare") return;
  for (const p of visiblePanes()) if (p.loaded) p.fit(false);
  refreshZoom();
});

// 启动自检：用一个 1x1 PNG 的 data URL 验证解码链路，把环境问题与文件问题分开
measureNatural(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
  .then(() => console.log("[selftest] data URL 解码 OK"))
  .catch((e) => {
    console.error("[selftest] data URL 解码失败:", e);
    ui.stPos.textContent = "自检失败(data URL 都无法解码，属 CSP/环境问题): " + e.message;
    setStatus("自检失败: " + e.message);
  });

console.log("[imgcompare] 对比视图初始化完成，Tauri 环境:", isTauriRuntime);
