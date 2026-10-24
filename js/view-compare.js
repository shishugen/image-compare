/* ==========================================================================
 * 视图一：图片对比
 * 图窗各自维护 { scale, x, y } 视图状态；布局有两图并排（a/b）和四图 2×2（a/b/c/d）两种；
 * 同步模式下任一视图操作都会把同一份状态复制给其它所有可见视图。
 *
 * 从 main.js 原样搬来，只改了三处：
 *   1) 通信与状态栏改用 api.js（多视图共用一个状态栏）
 *   2) 原生拖拽要先按当前视图分流，非对比视图不能进图窗命中
 *   3) 快捷键必须只在对比视图、且焦点不在输入框时才生效
 * ========================================================================== */

import {
  currentView,
  el,
  invoke,
  isTauriRuntime,
  onViewChange,
  registerDropHandler,
  registerOpenHandler,
  routeDrop,
  setStatus,
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
  wheelSel: el("sel-wheel"),
  stZoom: el("st-zoom"),
  stPos: el("st-pos"),
  stInfo: {
    a: el("st-info-a"),
    b: el("st-info-b"),
    c: el("st-info-c"),
    d: el("st-info-d"),
  },
  layout2: el("btn-layout-2"),
  layout4: el("btn-layout-4"),
  picker: el("file-picker"),
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
    this.meta = null; // { name, size }
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

  /** 载入图片并适应窗口 */
  async setImage({ dataUrl, name, size, natural }) {
    this.img.src = dataUrl;
    this.natural = natural;
    this.img.style.width = natural.w + "px";
    this.img.style.height = natural.h + "px";
    this.meta = { name, size };
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

let gridMode = false; // false = 两图并排(a/b)，true = 四图 2×2(a/b/c/d)

/** 当前布局下可见的窗，顺序 a→b→c→d（网格下即行优先） */
function visiblePanes() {
  return gridMode ? PANE_KEYS.map((k) => panes[k]) : [panes.a, panes.b];
}

/** 除自己以外的所有可见窗：同步广播、找空位填充都靠它 */
const peersOf = (pane) => visiblePanes().filter((p) => p !== pane);

/** 同步参照窗：优先当前活动窗，其次任意一个已载入的可见窗 */
function referencePane(self) {
  const pool = peersOf(self);
  return pool.find((p) => p === activePane && p.loaded) || pool.find((p) => p.loaded) || null;
}

/** 切换布局：先抹掉分隔条留下的 inline flex，再切 body class，最后重排可见窗 */
function setGridMode(on) {
  if (on === gridMode) return;
  gridMode = on;
  for (const p of Object.values(panes)) p.root.style.flex = "";
  document.body.classList.toggle("grid-mode", on);
  ui.layout2.classList.toggle("is-active", !on);
  ui.layout4.classList.toggle("is-active", on);
  // 窗格尺寸变了，已载入的图重新适应，否则网格下会错位溢出
  for (const p of visiblePanes()) if (p.loaded) p.fit(false);
  // 活动窗可能被切到隐藏位（如四图选了 C 再切回两图），换到一个可见窗
  if (!visiblePanes().includes(activePane)) {
    activePane = visiblePanes().find((p) => p.loaded) || panes.a;
  }
  if (isSync()) {
    const ref = visiblePanes().find((p) => p.loaded);
    if (ref) syncFrom(ref);
  }
  refreshZoom();
  refreshStatus();
  console.log("[layout] 切换到", on ? "四图 2×2" : "两图并排");
}

/* --------------------------------------------------------------------------
 * 全局控制状态
 * ------------------------------------------------------------------------ */
let activePane = panes.a; // 工具栏操作的目标窗（独立模式下生效）
const isSync = () => ui.syncChk.checked;

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
  const used = new Set();
  try {
    let idx = 0;
    if (targetKey && panes[targetKey]) {
      await assign(panes[targetKey], list[idx++]);
      used.add(targetKey);
    }
    for (; idx < list.length; idx++) {
      let pane = visible.find((p) => !used.has(p.key) && !p.loaded);
      if (!pane) pane = visible.find((p) => !used.has(p.key)); // 没有空窗就按序覆盖
      if (!pane) break;
      used.add(pane.key);
      await assign(pane, list[idx]);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("[load] 载入图片失败:", err);
    ui.stPos.textContent = "载入失败: " + msg;
    setStatus("载入失败: " + msg);
    console.log("[load] 当前环境 isTauriRuntime=", isTauriRuntime);
  }
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

ui.picker.addEventListener("change", () => {
  const files = Array.from(ui.picker.files || []);
  if (files.length) fillPanes(files, ui.picker.dataset.target || null);
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
      const shouldPan = !pinch && ui.wheelSel.value === "pan";

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

  // 空窗单击即弹文件选择；拖拽过（位移 > 6px）不算单击
  vp.addEventListener("click", (ev) => {
    if (pane.loaded) return;
    if (!lastDown) return;
    const moved = Math.abs(ev.clientX - lastDown.x) + Math.abs(ev.clientY - lastDown.y);
    if (moved > 6) return;
    activePane = pane;
    openImages(pane.key);
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
            gridMode ? "4图" : "2图",
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
  if (!col || !gridMode) return col;

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
registerOpenHandler("compare", (paths) => fillPanes(paths));
// 当前视图是「对比」时，拖进来的文件按落点窗进图窗
registerDropHandler("compare", (paths, paneKey) => fillPanes(paths, paneKey || null));

/* --------------------------------------------------------------------------
 * 工具栏
 * ------------------------------------------------------------------------ */
el("btn-open-a").addEventListener("click", () => openImages("a"));
el("btn-open-b").addEventListener("click", () => openImages("b"));
el("btn-open-c").addEventListener("click", () => openImages("c"));
el("btn-open-d").addEventListener("click", () => openImages("d"));
el("btn-open-pair").addEventListener("click", () => openImages(null));

el("btn-layout-2").addEventListener("click", () => setGridMode(false));
el("btn-layout-4").addEventListener("click", () => setGridMode(true));

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

ui.syncChk.addEventListener("change", () => {
  if (isSync()) {
    // 以当前活动窗为准，立刻对齐两窗
    if (activePane.loaded) syncFrom(activePane);
    ui.syncChk.title = "已开启：所有可见窗缩放平移保持一致";
  }
});

el("btn-clear").addEventListener("click", () => {
  // 清空一切：隐藏窗里的图不跟着布局切换留尾，免得下次切回来“莫名多出图”
  for (const p of Object.values(panes)) p.clear();
  refreshZoom();
});

document.querySelectorAll(".tag-close").forEach((btn) => {
  btn.addEventListener("click", () => panes[btn.dataset.close].clear());
});

/* ------------------------------- 分隔条拖动 ------------------------------- */
(() => {
  let dragging = false;
  ui.splitter.addEventListener("pointerdown", (ev) => {
    if (gridMode) return; // 四图网格下等分两列，不允许拖
    dragging = true;
    ui.splitter.setPointerCapture(ev.pointerId);
    ui.splitter.classList.add("active");
  });
  ui.splitter.addEventListener("pointermove", (ev) => {
    if (!dragging || gridMode) return;
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
      setGridMode(false);
      break;
    case "4":
      ev.preventDefault();
      setGridMode(true);
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
    case "arrowleft":
    case "arrowright":
    case "arrowup":
    case "arrowdown": {
      ev.preventDefault();
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
