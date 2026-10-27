#!/usr/bin/env node
/**
 * 对比视图「系统设置 + 三档布局 + 单图浏览」的纯逻辑自检：拿真实的 js/view-compare.js 源码，
 * 配一套最小 DOM / Tauri 桩跑。
 *
 * 为什么这么测：这一轮的风险全在四件事上 —— 布局由布尔变成三态后「哪些窗可见」的唯一口径、
 * 三个入口（工具栏按钮 / 设置抽屉 / 快捷键）必须指向同一份状态、改动能存盘且下次启动真能恢复、
 * 单图布局下浏览列表该只换那一张而不是继续 A/B 交替。四条都不需要真界面。
 *
 * 桩后端把 prefs 当成一块真磁盘来模拟：可以没这个文件（首启动）、可以整份被改坏（手改）。
 * get_prefs 严格照 Rust 的 load_prefs（缺字段补默认 + normalize 清脏值、绝不报错），
 * set_prefs 严格照 Rust 的 set_prefs（未传字段保留磁盘原值、非法值明确报错而不是静默改掉、
 * 写盘本身总是覆盖成功 —— 坏文件就是靠下一次保存修好的）。
 *
 * 不盖到的：真渲染（.only-multi/.only-grid 的 display 到底有没有生效，只能靠下面那节「合约」
 * 静态核对 CSS/HTML 写法，不是真布局）、真解码（Image 是桩，所有图都当 600×400）。
 * 「下次启动恢复」这一条是靠「桩的 get_prefs 与 Rust 的 load_prefs 同语义」间接证的：
 * 模块只 import 一次（再 import 一遍会把所有监听器注册两次），所以验的是存进去的内容 +
 * 读出来后的应用路径，不是真的重启一次。
 *
 * 运行：node tools/prefs_layout_check.mjs
 */
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------- DOM 桩 ------------------------------- */
/** 桩里不解析 HTML：innerHTML 只存字符串。用例只依赖 createElement 出来的真节点（侧栏行），
 *  被测代码里靠 innerHTML 的那几处本来就有 null 守卫 */
function mkEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attributes: {},
    classSet: new Set(),
    listeners: [],
    hidden: false,
    disabled: false,
    checked: false,
    value: "",
    title: "",
    text: "",
    html: "",
    clientWidth: 0,
    clientHeight: 0,
  };
  el.classList = {
    add: (...c) => c.forEach((x) => el.classSet.add(x)),
    remove: (...c) => c.forEach((x) => el.classSet.delete(x)),
    contains: (c) => el.classSet.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !el.classSet.has(c) : !!on;
      if (want) el.classSet.add(c);
      else el.classSet.delete(c);
      return want;
    },
  };
  Object.defineProperty(el, "className", {
    get: () => [...el.classSet].join(" "),
    set: (v) => {
      el.classSet.clear();
      String(v || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => el.classSet.add(c));
    },
  });
  Object.defineProperty(el, "textContent", {
    get: () => el.text + el.children.map((c) => c.textContent).join(""),
    set: (v) => {
      el.text = String(v);
      el.children.length = 0;
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get: () => el.html,
    set: (v) => {
      el.html = String(v);
      el.children.length = 0;
    },
  });
  el.addEventListener = (type, fn) => el.listeners.push([type, fn]);
  el.appendChild = (node) => {
    node.parentNode = el;
    el.children.push(node);
    return node;
  };
  el.removeChild = (node) => {
    const i = el.children.indexOf(node);
    if (i >= 0) el.children.splice(i, 1);
    node.parentNode = null;
    return node;
  };
  el.remove = () => el.parentNode && el.parentNode.removeChild(el);
  el.setAttribute = (k, v) => {
    el.attributes[k] = String(v);
  };
  el.removeAttribute = (k) => {
    delete el.attributes[k];
    if (k === "src") el.src = "";
  };
  el.contains = (node) => {
    let p = node && node.parentNode;
    while (p) {
      if (p === el) return true;
      p = p.parentNode;
    }
    return false;
  };
  // 只支持「.类名 / 标签名」这两种形式：被测代码里 closest 只用来找 .switch 那层 label
  el.closest = (sel) => {
    const byClass = sel.startsWith(".") ? sel.slice(1) : null;
    let p = el;
    while (p) {
      const ok = byClass ? p.classSet && p.classSet.has(byClass) : p.tagName === sel.toUpperCase();
      if (ok) return p;
      p = p.parentNode;
    }
    return null;
  };
  const walk = (fn) => {
    for (const c of el.children) {
      if (fn(c)) continue;
      c.walk ? c.walk(fn) : walkInto(c, fn);
    }
  };
  el.walk = walk;
  el.querySelectorAll = (sel) => {
    const out = [];
    const hit = (n) => {
      const ok = sel.startsWith(".") ? n.classSet.has(sel.slice(1)) : n.tagName === sel.toUpperCase();
      if (ok) out.push(n);
      return false; // 一直往下走：桩里不做「嵌套不重复」那套
    };
    for (const c of el.children) {
      if (hit(c)) continue;
      c.walk(hit);
    }
    return out;
  };
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.dispatchEvent = (ev) => {
    for (const [t, fn] of el.listeners) if (t === ev.type) fn(ev);
    return true;
  };
  el.click = () => el.dispatchEvent({ type: "click", target: el, preventDefault() {} });
  el.focus = () => {};
  el.blur = () => {};
  el.select = () => {};
  el.scrollIntoView = () => {};
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.hasPointerCapture = () => false;
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: el.clientWidth,
    bottom: el.clientHeight,
    width: el.clientWidth,
    height: el.clientHeight,
  });
  return el;
}
function walkInto(node, fn) {
  for (const c of node.children) {
    if (fn(c)) continue;
    walkInto(c, fn);
  }
}

const els = new Map();
const byId = (id) => {
  if (!els.has(id)) els.set(id, mkEl("div"));
  return els.get(id);
};
const body = mkEl("body");
body.dataset.view = "compare"; // 快捷键与拖拽路由都按当前视图分流，这里固定在对比视图
body.classSet.add("layout-2"); // 跟 index.html 的出厂 class 同一档

globalThis.document = {
  body,
  getElementById: byId,
  createElement: mkEl,
  querySelectorAll: () => [],
  execCommand: () => false,
  addEventListener: () => {},
};

/** 图窗是真实结构里唯一需要先长好子元素的一组：Pane 构造时就要 querySelector 到四个部件 */
function seedPane(key) {
  const root = byId("pane-" + key);
  const viewport = mkEl("div");
  viewport.classSet.add("viewport");
  viewport.clientWidth = 800;
  viewport.clientHeight = 600;
  const layer = mkEl("div");
  layer.classSet.add("layer");
  const canvas = mkEl("img");
  canvas.classSet.add("canvas");
  const tag = mkEl("span");
  tag.classSet.add("tag-name");
  root.appendChild(viewport);
  root.appendChild(layer);
  layer.appendChild(canvas);
  root.appendChild(tag);
  return root;
}
for (const k of ["a", "b", "c", "d"]) seedPane(k);
// 分隔条的拖动比例靠 stage 的真实宽度算，桩里不给尺寸会一判到 rect.width=0 就跳出
byId("stage").clientWidth = 1600;
byId("stage").clientHeight = 900;
// index.html 里侧栏与那句提示都是带着 hidden 出厂的，桩得照这个初始态起
byId("filmstrip").hidden = true;
byId("fs-tip").hidden = true;

/** 同步开关的真结构：一枚 input 藏在 label.switch 里（refreshLayoutUI 靠 closest 找那层） */
function seedSwitch(id, wrapped) {
  const label = mkEl("label");
  label.classSet.add("switch");
  const chk = byId(id);
  chk.tagName = "INPUT";
  chk.checked = true; // 出厂态：同步开着
  label.appendChild(chk);
  if (wrapped) {
    // 抽屉里那枚外面还套一层 .field 的 label：closest(".switch") 得穿过去
    const outer = mkEl("label");
    outer.classSet.add("field");
    outer.appendChild(label);
  }
}
seedSwitch("chk-sync", false);
seedSwitch("chk-set-sync", true);
byId("sel-set-wheel").value = "zoom"; // 工具栏那枚滚轮下拉已拆，抽屉里这个就是唯一入口与真值来源

const winListeners = [];
globalThis.window = {
  addEventListener: (type, fn) => winListeners.push([type, fn]),
  devicePixelRatio: 2,
  innerWidth: 1600,
  innerHeight: 900,
};

/* 真解码换成药片尺寸：所有图都当 600×400，用例只关心 src 里那个路径是谁 */
class FakeImage {
  set src(v) {
    this._src = v;
    setTimeout(() => {
      this.naturalWidth = 600;
      this.naturalHeight = 400;
      if (this.onload) this.onload();
      else if (this.onerror) this.onerror(new Error("没挂 onload"));
    }, 0);
  }
  get src() {
    return this._src || "";
  }
}
globalThis.Image = FakeImage;

globalThis.FileReader = class {
  readAsDataURL(file) {
    setTimeout(() => {
      this.result = file.__dataUrl || "data:image/png;base64," + Buffer.from(file.name).toString("base64");
      if (this.onload) this.onload();
    }, 0);
  }
};

globalThis.IntersectionObserver = class {
  constructor(cb, opts) {
    this.cb = cb;
    this.opts = opts || {};
    this.targets = [];
  }
  observe(t) {
    this.targets.push(t);
  }
  unobserve(t) {
    const i = this.targets.indexOf(t);
    if (i >= 0) this.targets.splice(i, 1);
  }
  disconnect() {
    this.targets.length = 0;
  }
};

/* -------------------- 桩后端：一块可以缺文件、可以损坏的 prefs -------------------- */
const DEFAULTS = { layout: "2", sync: true, wheel: "zoom" }; // 与 store.rs 的 Preferences::default 一份口径
const LAYOUTS = ["1", "2", "4"];
const prefsFile = { exists: false, bad: false, data: {} };
const calls = { get: 0, set: 0, cmd: [] };

function getPrefsStub() {
  calls.get++;
  // 没文件、整份被改坏：Rust 侧都是 unwrap_or_default，回出厂态且不报错
  if (!prefsFile.exists || prefsFile.bad) return { ...DEFAULTS };
  const p = { ...DEFAULTS, ...prefsFile.data };
  // 与 Preferences::normalize 同口径：前端不认的布局/滚轮值退回默认
  if (!LAYOUTS.includes(p.layout)) p.layout = DEFAULTS.layout;
  if (p.wheel !== "zoom" && p.wheel !== "pan") p.wheel = DEFAULTS.wheel;
  return p;
}

function putPrefsStub(patch) {
  // 与 Rust 的 set_prefs 同口径：未传字段保留磁盘原值；非法值明确拒绝，绝不静默改掉
  // （点了没反应还不出错，是最难归因的一种失败）。写盘本身总是覆盖 —— 坏文件就是这样修好的
  const p = { ...DEFAULTS, ...prefsFile.data, ...patch };
  if (!LAYOUTS.includes(p.layout)) throw new Error(`未知布局: ${JSON.stringify(p.layout)}`);
  if (p.wheel !== "zoom" && p.wheel !== "pan") throw new Error(`未知滚轮行为: ${JSON.stringify(p.wheel)}`);
  calls.set++;
  prefsFile.bad = false;
  prefsFile.exists = true;
  prefsFile.data = p;
  return p;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg", "tif", "tiff"]; // 与 lib.rs 同一份
const ALPHA = "/tmp/shot/ALPHA";
// 侧栏那个顺序就是 localeCompare("zh-Hans-CN", {numeric:true}) 的实测结果：IMG_2 < IMG_10 < IMG_100
const world = {
  fs: [
    { name: "IMG_2.png", size: 1024 },
    { name: "IMG_10.png", size: 2048 },
    { name: "IMG_100.png", size: 4096 },
  ],
  pick: [],
};
const A0 = `${ALPHA}/IMG_2.png`;
const A1 = `${ALPHA}/IMG_10.png`;
const A2 = `${ALPHA}/IMG_100.png`;
const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};
const isImageExt = (name) => IMAGE_EXTS.includes(extOf(name));
const enc = (p) => "data:image/png;base64," + Buffer.from(p).toString("base64");

// 窗口置顶的桩态：把「窗到底置顶了没」也存一份，断言才能查「按钮亮的是命令回来的值」
// 而不是「点之前的取反」；stubPinThrows 一置就照实报错，验失败那一面。
let stubWinPinned = false;
let stubPinThrows = false;

async function invokeStub(cmd, args) {
  // 右键菜单要验「点哪一项就走哪条命令、带的是哪张图」，所以每条都留一份
  calls.cmd.push({ cmd, args: args || {} });
  switch (cmd) {
    case "get_prefs":
      return getPrefsStub();
    case "set_prefs":
      return putPrefsStub(args || {});
    case "pick_images":
      return world.pick.filter((p) => isImageExt(p.split("/").pop()));
    case "list_folder_images":
      // 与 Rust 的 folder_images 同口径：只回本层的图片、不排序
      return {
        dir: ALPHA,
        items: world.fs.filter((e) => isImageExt(e.name)).map((e) => ({ path: `${ALPHA}/${e.name}`, name: e.name, size: e.size })),
        truncated: false,
      };
    case "read_image": {
      const st = world.fs.find((e) => e.name === args.path.split("/").pop());
      if (!st) throw new Error(`读文件失败（${args.path}）: No such file or directory`);
      return { path: args.path, name: st.name, size: st.size, data_url: enc(args.path) };
    }
    case "take_pending_paths":
      return [];
    // 右键菜单的「另存为」：桩里直接回一个落点，验的是「点了就走这条路、提示里带上落点」
    case "save_path_as":
      return "/tmp/另存为/" + String(args.src || "").split("/").pop();
    // 置顶：与 Rust 同构 —— 先改窗状态再把落地后的值回给前端（报错时什么都不改）
    case "set_always_on_top": {
      if (stubPinThrows) throw new Error("主窗口已经不在了（桩里造的）");
      stubWinPinned = !!args?.on;
      return stubWinPinned;
    }
    // 侧栏现在默认列「最近看过」：这三条得能应，不然 invoke 就抛「命令不存在」。
    // 这里固定回一份空历史：本文件验的是布局/同步/分隔条，不是历史源那条路（那在
    // tools/folder_browse_check.mjs 第 18 节），下面进门就先切到目录源
    case "get_history":
      return { items: [] };
    case "record_view":
      return { items: [] };
    case "clear_history":
      return null;
    default:
      return null;
  }
}

window.__TAURI__ = {
  core: { invoke: invokeStub },
  event: {
    listen: () => Promise.resolve(() => {}),
  },
  window: {
    getCurrentWindow: () => ({
      onDragDropEvent: (cb) => {
        window.__dragDrop = cb;
        return Promise.resolve();
      },
    }),
  },
};

/* ------------------------------ 加载被测模块 ------------------------------ */
// 复制到临时目录按 ESM 加载：import 说明符写的是 ./api.js，原样拷过去最忠实
const tmp = join(os.tmpdir(), `prefs-layout-check-${crypto.randomBytes(6).toString("hex")}`);
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
for (const f of ["api.js", "view-compare.js", "tile.js"]) copyFileSync(join(here, "..", "js", f), join(tmp, f));
const api = await import(join(tmp, "api.js"));
await import(join(tmp, "view-compare.js"));
// 田字查看的落点算法：直接 import 真实现来数几何（它不碰 DOM，不需要桩）
const { tilePlacements } = await import(join(tmp, "tile.js"));

/* ------------------------------- 小工具 ------------------------------- */
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) await flush();
}
/** 窗里现在挂的是哪个路径：src 里那个 base64 就是桩写进去的路径 */
const srcOf = (k) => {
  const raw = byId("pane-" + k).querySelector(".canvas").src || "";
  if (!raw.startsWith("data:")) return "";
  return Buffer.from(raw.split(",")[1], "base64").toString("utf8");
};
const shot = () => ({ a: srcOf("a"), b: srcOf("b"), c: srcOf("c"), d: srcOf("d") });
function changedPanes(before) {
  const now = shot();
  return ["a", "b", "c", "d"].filter((k) => now[k] !== before[k]);
}
const bodyLayout = () => [...body.classSet].filter((c) => c.startsWith("layout-")).sort().join(",");
const rows = () => byId("fs-list").children.filter((c) => c.classSet.has("fs-row"));
const statusText = () => byId("st-msg").text;
const disk = () => prefsFile.data;
/** 禁用状态光靠 input.disabled 在界面上看不出来（真 input 是藏起来的），所以查外层 label */
function switchDisabled(id = "chk-sync") {
  const label = byId(id).closest(".switch");
  return !!(label && label.classSet.has("is-disabled"));
}
function click(node) {
  node.dispatchEvent({ type: "click", target: node, preventDefault() {}, stopPropagation() {} });
}
/** 下拉与复选框改动要显式发 change：桩不会像真浏览器那样替用户发 */
function change(node) {
  node.dispatchEvent({ type: "change", target: node, preventDefault() {} });
}
function key(k, mod = {}) {
  const ev = {
    type: "keydown",
    key: k,
    metaKey: !!mod.meta,
    ctrlKey: !!mod.ctrl,
    shiftKey: !!mod.shift,
    altKey: !!mod.alt,
    target: body,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  for (const [t, fn] of winListeners) if (t === "keydown") fn(ev);
  return ev;
}
/**
 * 指定落窗的那条路：「打开 A/B/C/D」四个入口已拆，现在只能单击那个空窗 ——
 * 桩后端不回剪贴板内容（paste_paths 走 default 回 null），所以单击会退到文件选择框，
 * 落点就是点的那一格（openImages(pane.key)），与真机行为一致。
 */
async function openTo(paneKey, path) {
  world.pick = [path];
  const vp = byId("pane-" + paneKey).querySelector(".viewport");
  vp.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 1, clientX: 20, clientY: 20 });
  vp.dispatchEvent({ type: "click", clientX: 20, clientY: 20, target: vp, preventDefault() {}, stopPropagation() {} });
  vp.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 20, clientY: 20 });
  await settle();
}
/** 四图那档现在只剩两个入口：设置抽屉的下拉与快捷键 4（工具栏按钮已撤） */
async function setLayoutViaSettings(to) {
  byId("sel-set-layout").value = to;
  change(byId("sel-set-layout"));
  await settle(2);
}
/** 一次完整的拖动分隔条：返回拖完之后 A 窗留下的 inline flex（空串 = 没拖成） */
async function dragSplitter() {
  const s = byId("splitter");
  s.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 400, clientY: 100 });
  s.dispatchEvent({ type: "pointermove", pointerId: 1, clientX: 600, clientY: 100 });
  s.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 600, clientY: 100 });
  await settle(2);
  return byId("pane-a").style.flex || "";
}

let failed = 0;
let passed = 0;
function check(name, ok, extra = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

await settle();

/* 侧栏默认源已换成「最近看过」，而这里 1~9 节靠的是「载入一张本地图就列出它所在目录」：
   进门先点一下「当前文件夹」，后面那些列表断言才照旧按目录源跑 */
check("默认那枚是「最近看过」（切之前它是亮的）", byId("btn-src-history").classSet.has("is-active") && !byId("btn-src-dir").classSet.has("is-active"));
click(byId("btn-src-dir"));
await settle();
check("切到目录源后那枚 tab 亮、头部不再说「最近看过」", byId("btn-src-dir").classSet.has("is-active") && byId("fs-dir").text !== "最近看过", byId("fs-dir").text);

/* ===================== 1) 首启动：没这份文件就是出厂态 ===================== */
check("没有 prefs.json 时按出厂态两图并排", bodyLayout() === "layout-2", bodyLayout());
check("首启动不会自己写一份设置回去", calls.set === 0, `set_prefs=${calls.set}`);

/* ===================== 2) 三个入口改的是同一份状态 ===================== */
click(byId("btn-layout-1"));
await settle(2);
check("点「1 图」切到单图布局", bodyLayout() === "layout-1", bodyLayout());
check("三态互斥：body 上只剩一个布局类", bodyLayout() === "layout-1");
check("工具栏按钮取态跟上", byId("btn-layout-1").classSet.has("is-active") && !byId("btn-layout-2").classSet.has("is-active"));
check("抽屉里的下拉同步跟上", byId("sel-set-layout").value === "1", byId("sel-set-layout").value);
check("改布局存盘了，其它项没被顺手动过", disk().layout === "1" && disk().sync === true && disk().wheel === "zoom");

click(byId("btn-layout-1"));
await settle(2);
check("再点当前那一档不重复切、不重复写盘", bodyLayout() === "layout-1" && calls.set === 1, `set_prefs=${calls.set}`);

byId("sel-set-layout").value = "4";
change(byId("sel-set-layout"));
await settle(2);
check("从抽屉改下拉也能切到四图", bodyLayout() === "layout-4", bodyLayout());
check("抽屉那条路同样存了盘", disk().layout === "4");
check("四图下工具栏两枚都不亮（那档没有按钮），下拉却跟着显示 4",
  !byId("btn-layout-1").classSet.has("is-active") && !byId("btn-layout-2").classSet.has("is-active") && byId("sel-set-layout").value === "4");

key("3");
await settle(2);
check("快捷键 3 切到单图（键 1 已给 1:1，不能占）", bodyLayout() === "layout-1" && disk().layout === "1");
key("2");
await settle(2);
check("快捷键 2 回到两图并排", bodyLayout() === "layout-2" && disk().layout === "2");
key("4");
await settle(2);
check("快捷键 4 切到四图 2×2", bodyLayout() === "layout-4" && disk().layout === "4");
check("下拉取态跟着快捷键走", byId("sel-set-layout").value === "4");

const setBeforeBad = calls.set;
const diskBeforeBad = disk().layout;
byId("sel-set-layout").value = "3"; // 桩里手改出一个真下拉不可能出现的值
change(byId("sel-set-layout"));
await settle(4);
check("前端不认的布局不会切到一个没有 CSS 的档位", bodyLayout() === "layout-4", bodyLayout());
check("非法值在进后端之前就被拦下，不多写一次盘", calls.set === setBeforeBad, `set_prefs=${calls.set}`);
check("被拦下后下拉取态回正到真实那一档", byId("sel-set-layout").value === "4", byId("sel-set-layout").value);
check("磁盘上永远不会留下前端不认的布局", disk().layout === diskBeforeBad && LAYOUTS.includes(disk().layout), disk().layout);

/* ============ 3) 同步：两个入口互跟；滚轮：只剩抽屉一个入口 ============ */
byId("chk-sync").checked = false;
change(byId("chk-sync"));
await settle(2);
check("工具栏关同步，抽屉那枚跟上", byId("chk-set-sync").checked === false);
check("关同步只写 sync，布局不动", disk().sync === false && disk().layout === "4");

byId("chk-set-sync").checked = true;
change(byId("chk-set-sync"));
await settle(2);
check("抽屉开同步，工具栏那枚跟上", byId("chk-sync").checked === true && disk().sync === true);

/* 滚轮只剩抽屉这一个入口：存盘值直接来自它，等于证明 wheelMode() 读的就是这枚下拉 */
byId("sel-set-wheel").value = "pan";
change(byId("sel-set-wheel"));
await settle(2);
check("抽屉换滚轮行为直接落盘", disk().wheel === "pan", disk().wheel);
check("换滚轮行为没把布局与同步一起改掉", disk().layout === "4" && disk().sync === true);
byId("sel-set-wheel").value = "zoom";
change(byId("sel-set-wheel"));
await settle(2);
check("换回缩放也照常落盘（不再有另一个控件要回写）", disk().wheel === "zoom", disk().wheel);

/* 把磁盘上这份改坏：读侧回出厂态，写侧下一次整体覆盖就修好 */
prefsFile.bad = true;
prefsFile.data = { layout: "2", sync: true, wheel: "zoom" };
check("prefs.json 坏掉时读回出厂态而不是报错", getPrefsStub().layout === "2");
click(byId("btn-layout-1"));
await settle(2);
check("坏文件被下一次保存整体覆盖", !prefsFile.bad && disk().layout === "1");

/* ============ 4) 恢复已存的设置：走启动时同一条「读出来再应用」的路 ============ */
putPrefsStub({ layout: "4", sync: false, wheel: "pan" });
{
  const p = getPrefsStub(); // 与 loadPrefs 一样：从磁盘读一份
  // 布局的入口只剩抽屉下拉与快捷键（工具栏没有 4 图那枚），这里走下拉那条
  if (LAYOUTS.includes(p.layout) && bodyLayout() !== "layout-" + p.layout) await setLayoutViaSettings(p.layout);
  if (byId("chk-sync").checked !== p.sync) {
    byId("chk-sync").checked = p.sync;
    change(byId("chk-sync"));
  }
  if (byId("sel-set-wheel").value !== p.wheel) {
    byId("sel-set-wheel").value = p.wheel;
    change(byId("sel-set-wheel"));
  }
  await settle(2);
}
check("重放后布局是存的那一档", bodyLayout() === "layout-4", bodyLayout());
check("重放后同步是存的那个值", byId("chk-sync").checked === false && byId("chk-set-sync").checked === false);
check("重放后滚轮行为是存的那个值", byId("sel-set-wheel").value === "pan" && disk().wheel === "pan");

/* ===================== 5) 单图布局下只剩 A 窗 ===================== */
click(byId("btn-layout-1"));
await settle(2);
click(byId("btn-clear"));
await settle(2);
check("单图下只把「单击 A 空窗」当目标窗（B/C/D 的窗体显隐由 CSS 的准入类控制，见第 9 节）", bodyLayout() === "layout-1");
await openTo("a", A2);
check("单击空窗在单图下照常工作", srcOf("a") === A2, srcOf("a"));
await openTo("b", A0);
check("（防御）落点指向不可见窗时不塞隐藏窗，图进可见的 A", srcOf("b") === "" && srcOf("a") === A0, srcOf("a"));
await openTo("c", A1);
check("（防御）指向 C 同样落到 A 窗", srcOf("c") === "" && srcOf("a") === A1, srcOf("a"));

check("单图布局下同步开关禁用（两个入口都 disable）", byId("chk-sync").disabled === true && byId("chk-set-sync").disabled === true);
check("禁用靠外层 label 的类看得出来", switchDisabled("chk-sync") && switchDisabled("chk-set-sync"));
check("禁用文案说明了为什么", (byId("chk-sync").closest(".switch").title || "").includes("只剩一个窗"), byId("chk-sync").closest(".switch").title);

/* 单图下超容量的多张来源：只留第一张，其余丢弃而不是塞隐藏窗 */
world.pick = [A0, A1, A2];
key("o", { meta: true });
await settle(4);
check("单图下 ⌘O 选三张只铺进 A 窗", srcOf("a") === A0 && srcOf("b") === "" && srcOf("c") === "", srcOf("a"));

/* ===================== 6) 单图下浏览列表：点一行只换那一张 ===================== */
click(byId("btn-clear"));
await settle(2);
await openTo("a", A2); // 打开最后一张，侧栏应该列出这个目录
check("目录源下：载入本地图后侧栏自动列出这个目录", rows().length === 3 && byId("filmstrip").hidden === false, `行数=${rows().length}`);
check(
  "列表按自然序排（IMG_2 < IMG_10 < IMG_100）",
  rows().map((r) => r.dataset.path).join(",") === [A0, A1, A2].join(","),
  rows().map((r) => r.dataset.path).join(",")
);

let before = shot();
click(rows()[0]);
await settle();
check("单图下点列表只换那一张", srcOf("a") === A0 && changedPanes(before).join("") === "a", changedPanes(before).join(","));
check("当前项跟上了", rows().findIndex((r) => r.classSet.has("is-current")) === 0);
check("单图下的状态条不写「另一窗留着上一张」", statusText().includes("1/3") && !statusText().includes("窗留着"), statusText());

before = shot();
click(rows()[2]);
await settle();
check("连点到第三张仍然只动 A 窗", srcOf("a") === A2 && changedPanes(before).join("") === "a", srcOf("a"));

key("]");
await settle();
check("单图下按 ] 越界只说一句，不动窗", srcOf("a") === A2 && statusText().includes("最后一张"), statusText());
before = shot();
key("[");
await settle();
check("单图下按 [ 翻到上一张，仍只动 A 窗", srcOf("a") === A1 && changedPanes(before).join("") === "a", srcOf("a"));

/* ===================== 7) 切回两图：A/B 交替规则照旧 ===================== */
click(byId("btn-layout-2"));
await settle(2);
check("切回两图后 B 窗还是空的（单图期间没被写过）", srcOf("b") === "");
before = shot();
click(rows()[0]);
await settle();
check("两图下浏览落 B 窗（当前项在 A 的对面）", changedPanes(before).join("") === "b", changedPanes(before).join(","));
check("两图下的状态条写明另一窗留着上一张", statusText().includes("窗留着上一张"), statusText());
before = shot();
click(rows()[2]);
await settle();
check("再点一次交替回 A 窗", changedPanes(before).join("") === "a", changedPanes(before).join(","));
check("浏览始终只轮转 A/B，C/D 不参与", srcOf("c") === "" && srcOf("d") === "");

/* 单图期间 B 窗根本没被浏览写过，切回四图也一样只有 A/B 有图 */
await setLayoutViaSettings("4");
check("切到四图后已有图都还在（布局切换不清图）", srcOf("a") !== "" && srcOf("b") !== "");

/* ===================== 8) 分隔条只在两图布局能拖 ===================== */
click(byId("btn-layout-1"));
await settle(2);
check("单图下拖分隔条不产生 inline flex", (await dragSplitter()) === "", byId("pane-a").style.flex);
await setLayoutViaSettings("4");
check("四图下拖分隔条不产生 inline flex", (await dragSplitter()) === "");
click(byId("btn-layout-2"));
await settle(2);
check("两图下拖分隔条能改两窗比例", (await dragSplitter()).startsWith("0 0 "), byId("pane-a").style.flex);
click(byId("btn-layout-1"));
await settle(2);
check("切布局时抹掉分隔条留下的 inline flex", byId("pane-a").style.flex === "", byId("pane-a").style.flex);

/* ===================== 8.5) 设置抽屉的开合：入口高亮必须跟着抽屉 ===================== */
const isOpen = () => byId("cmp-settings").classSet.has("is-open");
const isBtnActive = () => byId("btn-cmp-settings").classSet.has("is-active");
click(byId("btn-cmp-settings"));
check("点入口开抽屉，按钮同时高亮", isOpen() && isBtnActive());
click(byId("btn-set-close"));
check("点抽屉里的「收起」：抽屉关上、高亮一起灭", !isOpen() && !isBtnActive());
click(byId("btn-cmp-settings"));
key("escape");
check("Esc 收抽屉走同一个入口（高亮一起灭）", !isOpen() && !isBtnActive());

/* ===================== 8.6) 窗口置顶：高亮只认命令回来的值，而且一个字不写盘 ===================== */
const pinBtn = () => byId("btn-topmost");
const pinCalls = () => calls.cmd.filter((c) => c.cmd === "set_always_on_top");
const setPrefsCount = () => calls.cmd.filter((c) => c.cmd === "set_prefs").length;
const pinOn = () => pinBtn().classSet.has("is-active");
check(
  "出厂不亮：窗是普通窗，按钮也是（一启动就亮着等于骗人）",
  !pinOn() && !stubWinPinned
);
const setPrefs0 = setPrefsCount();
click(pinBtn());
await settle(2);
check(
  "点一下：走 set_always_on_top 且参数 on:true（只调一次）",
  pinCalls().length === 1 && pinCalls()[0].args.on === true,
  JSON.stringify(pinCalls())
);
check("桩里的窗真置顶了，按钮才亮", stubWinPinned && pinOn());
click(pinBtn());
await settle(2);
check(
  "再点取消：on:false、窗灭了、按钮也跟着灭（两个方向都查）",
  pinCalls().length === 2 && pinCalls()[1].args.on === false && !stubWinPinned && !pinOn()
);
// 失败那一面：Rust 那边拿不到窗时，按钮绝不能先亮起来
stubPinThrows = true;
click(pinBtn());
await settle(2);
check(
  "命令报错时按钮不亮：不做乐观翻转（亮着而窗没置顶是最难查的不一致）",
  !stubWinPinned && !pinOn()
);
check(
  "报错要说在状态栏里（置顶没生效 + 原因），不能只进 console",
  /置顶没生效/.test(statusText()),
  statusText()
);
stubPinThrows = false;
click(pinBtn());
await settle(2);
check("恢复后还能再开（报错那次没把状态锁住）", stubWinPinned && pinOn());
click(pinBtn());
await settle(2);
check(
  "置顶这一路不写 prefs.json：整个来回 set_prefs 一次也没调过（重启回普通窗是存心的）",
  setPrefsCount() === setPrefs0,
  `多写了 ${setPrefsCount() - setPrefs0} 次`
);

/* ===================== 9) CSS / HTML 合约：三态显隐写得对不对 ===================== */
const css = readFileSync(join(here, "..", "js", "style.css"), "utf8");
const html = readFileSync(join(here, "..", "js", "index.html"), "utf8");
const cmpJs = readFileSync(join(here, "..", "js", "view-compare.js"), "utf8");
check("两个准入类默认都不显示", /\.only-grid,\s*\.only-multi \{\s*display: none;/.test(css));
check(
  "stage 里 B 窗在 2/4 两档都要在（只在两图就是 4 图下少一个窗）",
  /body\.layout-2 \.stage \.only-multi,\s*body\.layout-4 \.stage \.only-multi \{/.test(css) &&
    !css.includes("body.layout-1 .stage .only-multi")
);
check("stage 里 C/D 只在四图出现", css.includes("body.layout-4 .stage .only-grid") && !css.includes("body.layout-2 .stage .only-grid"));
/* 「哪些窗可见」有两份口径：JS 的 LAYOUT_KEYS（浏览交替、fit、⌘C 都看它）与
   CSS 的准入类（实际画不画看它）。对不上的表现是「图载进了 B 窗但屏幕上看不见」，
   而两边各测各的都不会红。这里把两份都从真文件读回来逐档逐窗核一遍 */
check(
  "LAYOUT_KEYS 的每一档可见窗与 CSS 准入类的显示档 一一对应",
  (() => {
    // 每个窗的准入类（空数组 = 三档共用，永远可见）
    const admit = {};
    for (const m of html.matchAll(/class="pane([^"]*)"[^>]*id="pane-([a-d])"/g)) admit[m[2]] = m[1].trim().split(/\s+/).filter(Boolean);
    if (Object.keys(admit).length !== 4) return false;
    // 某个准入类在哪些档下 display: flex（按逗号拆选择器组，共享一个声明块的两条算两条）
    const shownBy = (cls) => {
      const out = new Set();
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!/display:\s*flex/.test(m[2])) continue;
        for (const sel of m[1].split(",")) {
          const mm = /body\.layout-(\d) \.stage \.([a-z-]+)$/.exec(sel.trim());
          if (mm && mm[2] === cls) out.add(mm[1]);
        }
      }
      return out;
    };
    const multi = shownBy("only-multi");
    const grid = shownBy("only-grid");
    const mK = /const LAYOUT_KEYS = \{([^}]*)\};/.exec(cmpJs);
    if (!mK) return false;
    const js = {};
    for (const m of mK[1].matchAll(/(\d): \[([^\]]*)\]/g)) js[m[1]] = [...m[2].matchAll(/"([a-d])"/g)].map((x) => x[1]);
    for (const L of ["1", "2", "4"]) {
      if (!js[L]) return false;
      for (const k of ["a", "b", "c", "d"]) {
        const a = admit[k];
        const cssVisible = !a.length ? true : a.includes("only-multi") ? multi.has(L) : grid.has(L);
        if (cssVisible !== js[L].includes(k)) {
          console.log(`  对不上：layout-${L} 窗 ${k}（CSS ${cssVisible ? "显" : "藏"} / JS ${js[L].includes(k) ? "可见" : "不可见"}）`);
          return false;
        }
      }
    }
    return true;
  })()
);
check("四个窗各自带一行底部信息，id 与 JS 里的 stInfo 对得上", ["a", "b", "c", "d"].every((k) => html.includes(`<div class="pane-foot" id="st-info-${k}">`)));
check(
  "信息行确实住在窗体内部（在窗的 </section> 之前），才能跟着窗宽与窗显隐走",
  ["a", "b", "c", "d"].every((k) =>
    new RegExp(`<section class="pane[^"]*" id="pane-${k}"[\\s\\S]*?<div class="pane-foot" id="st-info-${k}">[\\s\\S]*?</section>`).test(html)
  )
);
check("窗体是竖向排列（画面在上、信息行在下）", /\.pane \{[^}]*flex-direction: column;/.test(css));
check("状态栏里不再放任何一个窗的文件信息（准入类只剩窗体自己用）", !css.includes(".statusbar .only-") && !html.includes("st-file"));
check("工具栏已经不再放分窗入口，也不放 4 图按钮（只从设置里选）", ["a", "b", "c", "d"].every((k) => !html.includes(`id="btn-open-${k}"`)) && !html.includes('id="btn-layout-4"'));
check("工具栏上也没有滚轮下拉了（只剩抽屉那一个入口）", !html.includes('id="sel-wheel"') && html.includes('id="sel-set-wheel"'));
check("但「打开对比」（⌘O）与浏览列表还在", html.includes('id="btn-open-pair"') && html.includes('id="btn-strip"'));
check("只有四图用网格，单图与两图都是横向 flex", css.includes("body.layout-4 .stage {") && !css.includes("body.layout-1 .stage {") && !css.includes("body.layout-2 .stage {"));
check("非两图布局收起分隔条", /body:not\(\.layout-2\) \.splitter \{\s*display: none;/.test(css));
check("单图下禁用同步开关有可见样式", /\.switch\.is-disabled \{[^}]*pointer-events: none;/.test(css));
check("选中的窗格不再描那一圈蓝框（.is-picked 只当 DOM 标记，不给样式）", !/\.viewport\.is-picked\s*\{/.test(css));
check("列表里的键盘选中行也不再描框（is-sel 同上，只挂类）", !/\.fs-row\.is-sel\s*\{/.test(css));
check(
  "侧栏整体也不画焦点框（tabindex=0 + 程序化 focus()，光删规则会冒出 UA 默认环，得显式 outline: none）",
  !css.includes(".filmstrip:focus-visible") && /\.filmstrip \{[^}]*outline: none;/.test(css)
);
check("旧的布尔态类已经全部拆掉", !css.includes("grid-mode") && !html.includes("grid-mode"));
check(
  "侧栏有 min-width: 0（flex item 默认 auto + .fs-name 的 nowrap，不补这句 190px 会被最长那条名字撑爆）",
  /\.filmstrip \{[^}]*min-width: 0;/.test(css)
);
check(
  "名称列降到 12px，让 shortName() 的上限真放得下（留在 13px 会被末尾省略号再补一刀，砍掉扩展名）",
  /\.fs-name \{[^}]*font-size: 12px;/.test(css)
);
check("HTML 里 B 窗带 only-multi 准入（2/4 两档才出现，哪一档显示由上面那条与 LAYOUT_KEYS 核）", html.includes('class="pane only-multi" id="pane-b"'));
check("HTML 里 C/D 的窗都带 only-grid", html.includes('class="pane only-grid" id="pane-c"') && html.includes('class="pane only-grid" id="pane-d"'));
check("body 出厂就带 layout-2，首帧不会闪一下", html.includes('<body data-view="compare" class="layout-2">'));
check("抽屉里三个控件的 id 与 JS 读的一致", ["sel-set-layout", "chk-set-sync", "sel-set-wheel"].every((id) => html.includes(`id="${id}"`)));
check("设置入口与抽屉本体都在", html.includes('id="btn-cmp-settings"') && html.includes('class="drawer" id="cmp-settings"'));
check("抽屉住在 relative 宿主里（.cmp-body，同传输视图的 .panel-body）", /\.cmp-body \{[^}]*position: relative;/.test(css));
check("抽屉有 Esc/收起之外的关闭入口", html.includes('data-close-drawer="cmp-settings"') && html.includes('id="btn-set-close"'));

/* 传输视图那个配对抽屉也得按这里对：session_route_check 的 DOM 桩会按 id 自动造元素，
   HTML 里拆了这两个控件那边照样全绿 —— 这类「拆了 DOM 没拆 JS 引用」只能靠静态合约兜 */
const xferJs = readFileSync(join(here, "..", "js", "view-transfer.js"), "utf8");
// 抽屉 toggle 与切页两个函数体。磁盘那几样只该在切页时读，toggle 里只重置「本次读过没有」
const drawerToggleBody = (() => {
  const at = xferJs.indexOf('ui.btnSettings.addEventListener("click"');
  const end = xferJs.indexOf("\n});", at);
  return at >= 0 && end > at ? xferJs.slice(at, end) : "";
})();
const applyPageBody = (() => {
  const at = xferJs.indexOf("function applySettingsPage");
  const end = xferJs.indexOf("\n}", at);
  return at >= 0 && end > at ? xferJs.slice(at, end) : "";
})();
check(
  "配对设置抽屉里有备注名那一栏（输入框 + 保存按钮）",
  html.includes('id="inp-peer-alias"') && html.includes('id="btn-peer-alias"')
);
check(
  "JS 读的 id 与 HTML 对得上，且真去调了 set_peer_alias",
  xferJs.includes('el("inp-peer-alias")') && xferJs.includes('el("btn-peer-alias")') && xferJs.includes('invoke("set_peer_alias"')
);
check("解绑的提示说清了不会再自动连回来", html.includes("不会再自动连回来"));

/* 配对设置抽屉拆成了两页（配对 / 设置）。谁在哪一页、默认露哪页，
   全是「按 id 自动造元素」的桩根本看不见的拆分布局 —— 只能拿静态合约钉住 */
const pairPage = (() => {
  const a = html.indexOf('id="xfer-page-pair"');
  const b = html.indexOf('id="xfer-page-prefs"');
  return a >= 0 && b > a ? html.slice(a, b) : "";
})();
const prefsPage = (() => {
  const a = html.indexOf('id="xfer-page-prefs"');
  const b = html.indexOf("</aside>", a);
  return a >= 0 && b > a ? html.slice(a, b) : "";
})();
check(
  "两页容器、两枚页签、会跟着页走的标题都在 HTML 里",
  ["xfer-page-pair", "xfer-page-prefs", "xfer-tab-pair", "xfer-tab-prefs", "xfer-settings-title"].every((id) => html.includes(`id="${id}"`))
);
check(
  "默认露出的是「配对」那一页：设置那一页的开标签上写着 hidden",
  (() => {
    const at = html.indexOf('id="xfer-page-prefs"');
    if (at < 0) return false;
    const openTag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
    return openTag.includes("hidden") && !/<div[^>]*id="xfer-page-pair"[^>]*hidden/.test(html);
  })()
);
check(
  "页签文案与抽屉初始标题对得上：默认那页就是标题写着的那个",
  /id="xfer-tab-pair"[^>]*>配对<\/button>/.test(html) &&
    /id="xfer-tab-prefs"[^>]*>设置<\/button>/.test(html) &&
    /id="xfer-settings-title">配对<\/b>/.test(html)
);
check(
  "配对那一页不含本机偏好，设置那一页不含对端动作（各归各的，不重不漏）",
  ["inbox-dir-value", "storage-rows", "inp-heartbeat", "chk-notify-sound"].every((id) => prefsPage.includes(`id="${id}"`) && !pairPage.includes(`id="${id}"`)) &&
    ["inp-passphrase", "xfer-candidates", "inp-manual-addr", "inp-peer-alias", "btn-unbind"].every((id) => pairPage.includes(`id="${id}"`) && !prefsPage.includes(`id="${id}"`))
);
check(
  "切页只改 hidden，不重建那一页（重建会把刚填一半的口令与正在跑的臂一起弄没）",
  !/ui\.page(Pair|Prefs)\.(innerHTML|textContent|className)/.test(xferJs) && /ui\.pagePair\.hidden = /.test(xferJs)
);
check(
  "两枚页签各自绑自己的点击：桩里没有 closest，靠冒泡委托的那套在这儿是哑的",
  /ui\.tabPair\?\.addEventListener\("click"/.test(xferJs) && /ui\.tabPrefs\?\.addEventListener\("click"/.test(xferJs)
);
check(
  "磁盘那三样只挂在「设置」那一页露出时；抽屉 toggle 里只重置「本次读过没有」",
  applyPageBody.includes("refreshRecvPrefs();") &&
    applyPageBody.includes("refreshStorage();") &&
    !drawerToggleBody.includes("refreshRecvPrefs();") &&
    !drawerToggleBody.includes("refreshStorage();") &&
    drawerToggleBody.includes("prefsPageLoaded = false")
);
check(
  "页签与页容器的类名 HTML、CSS 两边都在（只有一边就是看不见的哑炮）",
  /class="set-tabs"/.test(html) && /class="set-tab is-on"/.test(html) && /class="set-page"/.test(html) &&
    /\.set-tabs \{/.test(css) && /\.set-tab \{/.test(css) && /\.set-tab\.is-on \{/.test(css) && /\.set-page \{/.test(css)
);
check(
  "纵向节奏从 .drawer-body 那层搬到了页上（多包一层不能把间距弄没）",
  /\.set-page \{[^}]*flex-direction: column;[^}]*gap: 10px;/.test(css)
);

/* 离线排队那一套：JS 只负责挂类名与文案，样式全在 CSS 里。这种拆分布在
   session_route_check 那种「按 id 自动造元素」的桩里根本测不出来（改了 JS 没改 CSS
   也是全绿），只能拿静态合约钉住 */
check(
  "待发气泡的类名 JS 与 CSS 两边都在（只有一边就是看不见的哑炮）",
  xferJs.includes('toggle("is-queued"') && /\.msg\.is-queued\b/.test(css)
);
check(
  "待发那一颗是空心圆点（::before 描边 + 圆角），不是凭空一个颜色",
  /\.msg\.is-queued \.msg-meta::before \{[\s\S]*?border-radius: 50%;/.test(css)
);
check(
  "发送按钮的 title 不再写「离线时不可发送」，改说排队与补发",
  !html.includes("离线时不可发送") && /离线也会先排队，它上线后自动补发/.test(html)
);
check("输入框的 placeholder 也告知离线能发、会排队", /离线也能发，会排队/.test(html));

/* 待发送区：选好/拖进来的东西先摆着，点发送才真发。这几条只能静态守：
   - DOM 拆了待发送区，真机上什么都不会显示，而按 id 造元素的桩照样全绿
   - 若谁把 drop 接回 send_paths，「松手即发」就悄悄回来了（那个改动不会红任何行为断言） */
check(
  "待发送区在 HTML 里且默认藏起来，位置在输入框那一行之前",
  (() => {
    const at = html.indexOf('id="xfer-attach"');
    const compose = html.indexOf('class="compose"');
    if (at < 0 || compose <= at) return false;
    // hidden 写在同一开标签上：从 id 往后取到「>」为止
    const openTag = html.slice(at, html.indexOf(">", at) + 1);
    return openTag.includes("hidden");
  })() && xferJs.includes('el("xfer-attach")') && xferJs.includes('el("xfer-attach-row")')
);
check(
  "拖进来 / 对比视图投递都只入待发送区，不再直接 send_paths（顶栏选文件那两个按钮已撤）",
  !/routeDrop\([^)]*sendPaths/.test(xferJs) &&
    /registerDropHandler\("transfer", \(paths\) => addAttach\(paths\)\)/.test(xferJs) &&
    /addAttach\(\[pending\.path\], \{ allowNoSession: true \}\)/.test(xferJs) &&
    !/pick_send_files/.test(xferJs)
);
check(
  "发送按钮与 Enter 都走 sendComposer（附件先出、文字随后），不再是两条独立入口",
  /addEventListener\("click", sendComposer\)/.test(xferJs) &&
    /ev\.key === "Enter"[\s\S]{0,120}?sendComposer\(\)/.test(xferJs)
);
check(
  "只有发成功的那部分才从输入区拿掉（失败留着，免得重选）",
  /if \(sentPaths\) clearAttach\(\);/.test(xferJs) && /if \(sentText\) \{/.test(xferJs)
);
check(
  "待发送区不认会话：切到哪个框就发给哪个（不再有「属于某某、先切回去发」那道锁）",
  !/state\.attachSid/.test(xferJs) && /`点发送就发给「\$\{sessName\(state\.cur\)\}」`/.test(xferJs)
);
check(
  "名字与大小问 Rust（stat_paths），且命令没回数组时能退回只认路径",
  xferJs.includes('invoke("stat_paths"') && /if \(!Array\.isArray\(metas\)\)/.test(xferJs)
);
check(
  "Rust 侧 stat_paths 已注册，且查不到的路径不丢（missing 标记交给界面标红）",
  (() => {
    // 上面那对 libRs / netMod 是在后面那段才读的，这里自己读一份，不靠声明顺序
    const libSrc = readFileSync(join(here, "..", "src-tauri", "src", "lib.rs"), "utf8");
    const netSrc = readFileSync(join(here, "..", "src-tauri", "src", "net", "mod.rs"), "utf8");
    return (
      libSrc.includes("net::stat_paths") &&
      /pub async fn stat_paths/.test(netSrc) &&
      /missing: true/.test(netSrc) &&
      /pub missing: bool/.test(netSrc)
    );
  })()
);
check(
  "待发送区有样式（两个 chip 形态 + × + 路径不在了的标红），不是裸 DOM",
  /\.compose-attach \{/.test(css) && /\.attach-chip\.is-image \{/.test(css) && /\.attach-x \{/.test(css) && /\.attach-chip\.is-missing \{/.test(css)
);
check(
  "禁不禁只看这台加没加过（不再拿 sess.online 拦发送）",
  /const canSend = !!sess && sess\.bound;/.test(xferJs)
);

/* 放大层的缩放：锚点公式与 CSS 的 transform-origin / 控件布局是一根绳上的，
   拆了 CSS 那一边，session_route_check 拿的是自己盖的假盒，不会红 */
check(
  "缩放控件条五个控件的 id 两边对得上",
  ["lightbox-in", "lightbox-out", "lightbox-fit", "lightbox-one", "lightbox-zoom"].every(
    (id) => html.includes(`id="${id}"`) && xferJs.includes(`el("${id}")`)
  )
);
check(
  "控件条绝对定位（参加 flex 布局会把居中的图顶上去，而这种偏位靠行为自检根本看不出来）",
  /\.lb-tools \{[^}]*position: absolute;/.test(css)
);
/* 图一带上 transform 就自成层叠上下文，绘制顺序改按 DOM 先后算，而控件条与关闭按钮都排在图
   之前——不显式压一层就是「放大后的图把按键盖住」（真机撞到的，假 DOM 不做绘制，只兜得住静态合约） */
check(
  "控件条、关闭按钮、说明行都显式压了 z-index",
  /\.lb-tools \{[^}]*z-index: 2;/.test(css) && /\.lb-close \{[^}]*z-index: 2;/.test(css) && /\.lb-cap \{[^}]*z-index: 2;/.test(css)
);
check(
  "控件条排在图之前（HTML 里的先后就是带 transform 时的叠放序），所以背底不能透",
  html.indexOf('id="lightbox-tools"') < html.indexOf('id="lightbox-img"') && /\.lb-tools \{[^}]*background: rgba\(/.test(css)
);
check(
  "图的原点定在左上角：锚点公式就是按它推的，改成 center 整套全歪",
  /\.lightbox img \{[\s\S]*?transform-origin: 0 0;/.test(css)
);
check(
  "拖拽的两个光标态类名 JS 与 CSS 两边都在（只有一边就是看不见的哑炮）",
  xferJs.includes('"is-zoomable"') &&
    xferJs.includes('"is-dragging"') &&
    /\.lightbox\.is-zoomable img \{/.test(css) &&
    /\.lightbox\.is-dragging img \{/.test(css)
);
check(
  "放大层的倍率上下限与对比视图同一套（25%~800%，100% = 原始像素）",
  xferJs.includes("const LB_MIN = 0.25;") &&
    xferJs.includes("const LB_MAX = 8;") &&
    /const MIN_SCALE = 0\.25;/.test(cmpJs) &&
    /const MAX_SCALE = 8;/.test(cmpJs) &&
    html.includes('min="25" max="800"')
);
check("缩略图的悬停说了能缩放（不提示没人知道可以滚）", /点击放大（滚轮缩放、拖拽平移）/.test(xferJs));

/* 田字平铺：假 DOM 不做布局也不画背图，这一堆只能靠静态合约兜 */
check(
  "「田」按钮与平铺画布两个 id 两边都对得上",
  ["lightbox-tile", "lightbox-tile-stage"].every((id) => html.includes(`id="${id}"`) && xferJs.includes(`el("${id}")`))
);
/* 写第一版时「田」按钮与画布都叫 lightbox-tile：真浏览器里 getElementById 只拿第一个，
   于是按钮点不到、画布拿不到；而桩里 byId 是按名字各自造元素，行为自检全绿 */
check(
  "index.html 里 id 全局唯一（重名时 getElementById 只拿第一个，桩里照不出来）",
  (() => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
    if (dup.length) console.log("  重名 id:", dup.join(", "));
    return ids.length > 0 && dup.length === 0;
  })()
);
check(
  "平铺靠 CSS 的 repeat 铺、尺寸与位置由 JS 写（四个 img 拼会被画出亚像素假缝）",
  /\.lightbox\.is-tiled \.lb-tile \{[\s\S]*?background-repeat: repeat;/.test(css) &&
    xferJs.includes("style.backgroundSize =") &&
    xferJs.includes("style.backgroundPosition =") &&
    !xferJs.includes("style.backgroundRepeat =")
);
check("平铺画布默认不显示，只在 is-tiled 下铺满整层", /\.lb-tile \{\s*display: none;/.test(css) && /\.lightbox\.is-tiled \.lb-tile \{[\s\S]*?inset: 0;/.test(css));
check(
  "画布压在控件之下（z-index 1，按钮条/关闭/说明行都是 2），不然又是盖住按键",
  /\.lightbox\.is-tiled \.lb-tile \{[^}]*z-index: 1;/.test(css)
);
check(
  "平铺时那张图是 visibility 藏盒不是 display 删盒（lbMeasure 还要拿它重量）",
  /\.lightbox\.is-tiled img \{[\s\S]*?visibility: hidden;/.test(css) &&
    !/\.lightbox\.is-tiled img \{[^}]*display: none;/.test(css)
);

/* -------------------- 侧栏行拖到图窗：桩看不到的那几层 -------------------- */
check(
  "index.html 里有那枚跟手的牌，JS 与 CSS 都指向同一个 id",
  html.includes('id="strip-ghost"') && cmpJs.includes('el("strip-ghost")') && css.includes(".strip-ghost {")
);
check(
  "牌必须 pointer-events: none：它盖在指针底下，不屏蔽鼠标事件就会把自己当成落点，永远命中不到窗",
  /\.strip-ghost \{[^}]*pointer-events: none;/.test(css)
);
check(
  "[hidden] 仍是 display:none !important（牌自己写着 display:flex，靠这条才压得住）",
  /\[hidden\] \{\s*display: none !important;/.test(css)
);
check(
  "拖拽期间整页禁选（不然按住行横向拖会开始选文字），且 JS 真的在拖起来时挂这个类",
  /body\.is-strip-drag \{[^}]*user-select: none;/.test(css) &&
    cmpJs.includes('classList.add("is-strip-drag")')
);
// 扫之前先剥注释：否则注释里写的 min-width / overflow 字样会被当成“已防护”而假通过
const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");
check(
  "每个 flex:0 0 <N>px 的定宽列都防住了「内容把列撑破」：块里要么写 min-width:0，要么自身带 overflow，要么写了显式 width（拿 headless Chrome 实测过：会话栏那 214px 被一条长文件名撑到 367px，里面那行 ellipsis 全程没生效）",
  (() => {
    // 白名单：窄条与图位，量过不会撑（.splitter 6px 把手与 .nav 48px 图标条里没有长文本）
    const ALLOW = [".splitter", ".nav"];
    const bad = [];
    for (const m of cssBare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, " ");
      const body = m[2];
      if (!/flex:\s*0\s+0\s+\d+px/.test(body)) continue;
      if (
        /min-width:\s*0/.test(body) ||
        /overflow(-x)?:\s*(auto|hidden|scroll)/.test(body) ||
        /(^|[^-])width:\s*\d+px/.test(body) ||
        ALLOW.some((a) => sel.includes(a))
      )
        continue;
      bad.push(sel);
    }
    if (bad.length) console.log("    未防护的定宽列:", bad.join(" | "));
    return bad.length === 0;
  })()
);
check(
  "会话栏那 214px 确实带了 min-width:0（上面那个 bug 的直接回归位；只需加在容器这一层，加在 .session-rows 上是冗余）",
  /\.session-list \{[^}]*flex: 0 0 214px;[^}]*min-width: 0;/.test(cssBare)
);
check(
  "「改名/删除」不再吃行里的宽度：绝对定位浮在右下角，行自己带 position:relative 当基准（漏了基准它会相对整个列表定位，所有行的按钮堆到列表右下角）",
  /\.session-row \{[^}]*position: relative;/.test(cssBare) &&
    /\.s-acts \{[^}]*position: absolute;/.test(cssBare) &&
    !/\.s-acts \{[^}]*flex: 0 0 auto;/.test(cssBare)
);
check(
  "操作按钮平时 visibility:hidden：只写 opacity:0 的话一个看不见的按钮照样能接走一次点击，hover 才放回 visible",
  /\.s-acts \{[^}]*visibility: hidden;/.test(cssBare) &&
    /\.session-row:hover \.s-acts \{[^}]*visibility: visible;/.test(cssBare)
);
check(
  "第二行预览自己带 min-width:0 + ellipsis：.s-sub 改成 flex 容器后，裁切只能靠它（时间还得留在行内）",
  /\.s-prev \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/.test(cssBare)
);
check(
  "置顶行底色深一档，但不能盖掉正在聊的那个框：选择器里排除了 .is-active，悬停也还要看得出来",
  /\.session-row\.is-pinned:not\(\.is-active\) \{[^}]*background:/.test(cssBare) &&
    /\.session-row\.is-pinned:not\(\.is-active\):hover \{[^}]*background: var\(--bg\);/.test(cssBare)
);
check(
  "行→窗这段走指针事件，不碰 HTML5 的 draggable/dataTransfer（dragDropEnabled 开着，那条通道只认从 Finder 递进来的路径）",
  (() => {
    const from = cmpJs.indexOf("const stripDrag = {");
    const to = cmpJs.indexOf('window.addEventListener("mouseup"');
    if (from < 0 || to <= from) return false;
    return cmpJs.includes('row.addEventListener("mousedown"') && !/draggable|dataTransfer/.test(cmpJs.slice(from, to));
  })()
);
check(
  "落点只遍历当前档的可见窗（paneAtPoint 用 visiblePanes，不是 PANE_KEYS）",
  /function paneAtPoint[\s\S]{0,400}?visiblePanes\(\)/.test(cmpJs) &&
    !/function paneAtPoint[\s\S]{0,400}?PANE_KEYS/.test(cmpJs)
);

/* --------------------------- 图片右键菜单（中文那套） ---------------------------
 * 五项全是已有命令，唯一的新东西是「指哪张图」与「会不会漏给原生菜单」。所以验三件事：
 * 图窗与侧栏两处都能弹、各个动作各走各的命令且带对路径、任何一次点击或 Esc 都收得回去。
 * 原生那套是 WebKit 自己弹的（Open Image / Copy Subject / Look Up…），样式改不了，
 * 只能在 contextmenu 上拦下来 —— 所以「拦没拦」就看 preventDefault 这一条。
 */
// 先清空所有窗：「没图的那一窗」这条要的是一窗真没有 meta 的状态
click(byId("btn-clear"));
await settle();
const menuNode = byId("img-menu");
// 桩不解析 HTML：菜单在 index.html 里是带着 hidden 出厂的，这里得照初始态起；
// 菜单项也得手工挂进去 —— 「点菜单里不关、点菜单外才关」要靠 contains 判
menuNode.hidden = true;
for (const id of ["ctx-save", "ctx-copy-img", "ctx-copy-path", "ctx-send", "ctx-reveal"]) {
  menuNode.appendChild(byId(id));
}
// 菜单尺寸在桩里量不出来（getBoundingClientRect 只回 clientWidth/clientHeight），
// 给它一份 172×160（真机上 .ctx-menu 的 min-width 就是这个数），贴边翻页才验得动
menuNode.clientWidth = 172;
menuNode.clientHeight = 160;
function ctxMenuOn(node, x, y) {
  const ev = {
    type: "contextmenu",
    clientX: x,
    clientY: y,
    target: node,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {},
  };
  node.dispatchEvent(ev);
  return ev;
}
const lastCmd = () => calls.cmd[calls.cmd.length - 1] || { cmd: "", args: {} };
/** window 上的 pointerdown（外壳关菜单那条路）：桩里要手动把监听器跑一遍 */
function pointerDownOn(node) {
  const ev = { type: "pointerdown", target: node, button: 0, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} };
  for (const [t, fn] of winListeners) if (t === "pointerdown") fn(ev);
}
check(
  "没载图的窗右键：不弹自己的菜单、也不拦原生菜单（这几项都用不上，拦了等于点了没反应）",
  (() => {
    const ev = ctxMenuOn(byId("pane-a").querySelector(".viewport"), 400, 300);
    return !ev.prevented && menuNode.hidden;
  })()
);

await openTo("a", A0); // 窗里先有一张图，meta.path 才有值
click(byId("btn-src-dir")); // 侧栏切回目录源：下面要拿真行去右键
await settle();
// 后面一律按「这一窗实际载的是哪张」比，不写死 A0：前面那段用例可能把它换成别的了
const pathA = srcOf("a");
const row0 = rows()[0];
const rowPath = row0 && row0.dataset.path;

check(
  "侧栏行右键：菜单开在鼠标处、原生菜单被拦掉",
  (() => {
    const ev = ctxMenuOn(row0, 300, 200);
    return (
      !!rowPath &&
      ev.prevented &&
      !menuNode.hidden &&
      menuNode.style.left === "300px" &&
      menuNode.style.top === "200px"
    );
  })(),
  rowPath
);
check(
  "点菜单以外的地方只收菜单；点菜单里那不关（先关后 click 的话，真机上 click 就丢了）",
  (() => {
    pointerDownOn(menuNode.children[0]); // 菜单里的那颗：不许收
    const kept = !menuNode.hidden;
    pointerDownOn(byId("stage")); // 外面：收
    return kept && menuNode.hidden;
  })()
);
await settle();
check(
  "「复制文件路径」走 copy_text，带的是右键那一行的路径",
  (() => {
    ctxMenuOn(row0, 320, 220);
    click(byId("ctx-copy-path"));
    return true;
  })()
);
await settle();
check(
  "复制完菜单自己收起，命令与路径都对",
  menuNode.hidden && lastCmd().cmd === "copy_text" && lastCmd().args.text === rowPath,
  `${lastCmd().cmd} ${lastCmd().args.text}`
);
check(
  "「复制图片」走 copy_as_file，带的是图窗里那张图（与传输视图同一个命令，粘到微信就是图）",
  (() => {
    ctxMenuOn(byId("pane-a").querySelector(".viewport"), 260, 180);
    click(byId("ctx-copy-img"));
    return true;
  })()
);
await settle();
check(
  "复制图片的参数就是 A 窗的 path",
  lastCmd().cmd === "copy_as_file" && lastCmd().args.paths.length === 1 && lastCmd().args.paths[0] === pathA,
  JSON.stringify(lastCmd().args)
);
check(
  "贴着窗口右下角右键：菜单翻到鼠标左上方，不留半截在屏外",
  (() => {
    ctxMenuOn(byId("pane-a").querySelector(".viewport"), 1550, 880);
    // 1550 + 172 + 8 > 1600 → 往左翻到 1550-172；880 + 160 + 8 > 900 → 往上翻到 880-160
    return menuNode.style.left === "1378px" && menuNode.style.top === "720px";
  })(),
  `${menuNode.style.left}/${menuNode.style.top}`
);
check("Esc 收菜单，且不再往下传（不然同一个 Esc 还会把侧栏也收了）", (() => {
  const ev = key("Escape");
  return ev.prevented && menuNode.hidden;
})());
check(
  "「另存为」走 save_path_as，提示里带上真落点（返回 null 是用户取消，不该报错）",
  (() => {
    ctxMenuOn(byId("pane-a").querySelector(".viewport"), 200, 160);
    click(byId("ctx-save"));
    return true;
  })()
);
await settle();
check(
  "另存为的参数是 src（不是 path），提示里有 /tmp/另存为/",
  lastCmd().cmd === "save_path_as" && lastCmd().args.src === pathA && statusText().includes("/tmp/另存为/"),
  `${JSON.stringify(lastCmd().args)} → ${statusText()}`
);
check(
  "「在文件夹中显示」走 reveal_in_folder，参数名是 path",
  (() => {
    ctxMenuOn(byId("pane-a").querySelector(".viewport"), 200, 160);
    click(byId("ctx-reveal"));
    return true;
  })()
);
await settle();
check("reveal_in_folder 的参数确实是 path", lastCmd().cmd === "reveal_in_folder" && lastCmd().args.path === pathA);
check(
  "「发送到聊天」把这张图交给传输视图（先放进待发送区，发给谁由那边选）",
  (() => {
    ctxMenuOn(byId("pane-a").querySelector(".viewport"), 200, 160);
    click(byId("ctx-send"));
    return true;
  })()
);
await settle();
const handed = api.takePendingSend();
check(
  "发送到聊天：视图切到 transfer，投递的正是 A 窗那张图（还没发出去），菜单也收了",
  body.dataset.view === "transfer" && handed?.path === pathA && menuNode.hidden,
  `${body.dataset.view} ${JSON.stringify(handed)}`
);
// 后面的用例都在对比视图里跑：切回来，顺带过一遍「切走即取消」那条路
api.setPendingSend("/tmp/残留.png", "残留.png");
api.setView("compare");
await settle();
check(
  "切走聊天视图就当取消：没选会话就离开，残留的投递不会留到下一次",
  api.takePendingSend() === null && body.dataset.view === "compare"
);

/* --------- 侧栏缩略图走 asset 协议：这三处不同时改，只会在真机上白屏，桩照不出来 --------- */
const confPath = join(here, "..", "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const apiJs = readFileSync(join(here, "..", "js", "api.js"), "utf8");
const sec = conf?.app?.security || {};
const csp = typeof sec.csp === "string" ? sec.csp : "";
const imgSrc = (csp.match(/img-src([^;]*)/)?.[1] || "").trim();
check(
  "CSP 的 img-src 收得下 asset 地址（只改 js 不改这里，缩略图会整片空白，而且只在真机出现）",
  imgSrc.includes("asset:") && imgSrc.includes("http://asset.localhost"),
  imgSrc
);
const assetProto = sec.assetProtocol || {};
const scope = Array.isArray(assetProto.scope) ? assetProto.scope : [];
check(
  "assetProtocol 开了并且 scope 不为空（只开协议不给范围，WebView 照样取不到文件）",
  assetProto.enable === true && scope.length > 0,
  `enable=${assetProto.enable} scope=${scope.length} 条`
);
check(
  "scope 盖住了用户目录与外接盘（$HOME/** 和 /Volumes/**，移动硬盘上挑图是常见用法）",
  scope.some((g) => g.startsWith("$HOME")) && scope.includes("/Volumes/**"),
  scope.join(",")
);
/* 盘符不能靠枚举：F:/G:/网络盘都会漏，而 glob::Pattern 只把当前平台的分隔符当路径段，
   `/**` 在 mac 上实测（glob-0.3.4）匹配不到带盘符的路径 —— 所以用一条 `**` 兜住所有盘 */
check(
  "scope 里有一条 `**` 兜住所有盘符/网络盘，且不靠枚举盘符字母（写 `C:/**` 这种永远在补漏）",
  scope.includes("**") && !scope.some((g) => /^[A-Za-z]:/.test(String(g))),
  scope.filter((g) => /^[A-Za-z]:/.test(String(g))).join(",") || "无盘符枚举"
);
/* glob::Pattern 只把「当前平台的分隔符」当路径段：mac/Linux 上反斜杠不是分隔符，所以
   C:\Users\** 这种写法 schema 能过、cargo build 也能过，一到启动就 panic（真机撞过） */
check(
  "scope 里每条 glob 都过得了 glob::Pattern：不含反斜杠，且 ** 必须独占一个 / 段（写错是启动 panic，不是图不出来）",
  scope.length > 0 &&
    scope.every((g) => !String(g).includes("\\") && !/\*{3,}/.test(g) &&
      String(g).split("/").every((seg) => !seg.includes("**") || seg === "**")),
  scope.filter((g) => String(g).includes("\\") || /\*{3,}/.test(g) ||
    String(g).split("/").some((seg) => seg.includes("**") && seg !== "**")).join(",") || "全部合法"
);
check(
  "assetSrc() 两个注入点都认（__TAURI__.core 与 __TAURI_INTERNALS__），拿不到就回 null 而不是抛",
  (() => {
    const from = apiJs.indexOf("export function assetSrc");
    if (from < 0) return false;
    const body = apiJs.slice(from, apiJs.indexOf("\n}", from));
    return (
      body.includes("__TAURI__") &&
      body.includes("__TAURI_INTERNALS__") &&
      body.includes('typeof fn !== "function"') &&
      /catch[\s\S]*?return null;/.test(body)
    );
  })(),
  apiJs.includes("export function assetSrc") ? "函数体已核" : "函数都没了"
);
check(
  "ensureThumb 不再拿 ±1 窗口拦路：IO 说滚进视口就挂，只剩体积闸门（拦在那一层就是只有三行有图）",
  (() => {
    const from = cmpJs.indexOf("async function ensureThumb");
    const to = cmpJs.indexOf("function requestNearThumbs");
    if (from < 0 || to <= from) return false;
    const body = cmpJs.slice(from, to);
    return !body.includes("inDecodeWindow(") && body.includes("STRIP_AUTO_MAX");
  })(),
  "ensureThumb 里不该再出现 inDecodeWindow"
);
check(
  "ensureThumb 里 asset 分支仍排在 LRU 之前（取地址走 assetFor，它才看黑名单脸色）",
  (() => {
    const body = cmpJs.slice(cmpJs.indexOf("async function ensureThumb"), cmpJs.indexOf("function requestNearThumbs"));
    const a = body.indexOf("assetFor(");
    const b = body.indexOf("thumbCache.get(");
    return a >= 0 && a < b && body.indexOf("assetSrc(") < 0;
  })(),
  "assetFor 必须排在 thumbCache.get 之前"
);
check(
  "并发满了排队而不是丢掉，换目录清队列（直接丢会让超出的那几行永远空着）",
  cmpJs.includes("const thumbQueue = [];") &&
    /thumbInflight >= STRIP_INFLIGHT_MAX\)\s*\{[\s\S]{0,200}?thumbQueue\.push\(i\)/.test(cmpJs) &&
    /thumbQueue\.shift\(\)/.test(cmpJs) &&
    /thumbQueue\.length = 0;/.test(cmpJs)
);
check(
  "滚动兜底：可见范围按几何算、scroll 上有节流补挂（IO 漏发也不至于一直空着）",
  cmpJs.includes("function visibleRowRange()") &&
    cmpJs.includes("getBoundingClientRect") &&
    /function requestNearThumbs[\s\S]{0,600}?visibleRowRange\(\)/.test(cmpJs) &&
    /addEventListener\("scroll"[\s\S]{0,200}?requestNearThumbs/.test(cmpJs)
);
check(
  "侧栏收着（容器高 0）时不能把整目录都算成可见：那会一次性读几百张",
  /box\.bottom > box\.top/.test(cmpJs)
);
check(
  "退路没被拆：read_image 与三道闸门常量都还在（纯浏览器调试与转地址失败时走它）",
  cmpJs.includes('invoke("read_image"') &&
    cmpJs.includes("STRIP_DECODE_WINDOW") &&
    cmpJs.includes("STRIP_AUTO_MAX") &&
    cmpJs.includes("STRIP_LRU_MAX") &&
    // 一屏十几行都挂图，缓存至少要装得下一屏：8 张那个旧值会让滚回来的行重新读盘
    Number((cmpJs.match(/const STRIP_LRU_MAX = (\d+);/) || [])[1]) >= 20
);
/* asset 地址拿得到、但文件取不到（scope 未覆盖 / Windows 上 canonicalize 后的路径与 glob 对不上）
   时 assetSrc() 不会回 null，单靠「回 null 才退路」会留一列破图 */
check(
  "asset 图必须挂 onerror 退回 read_image，且坏路径只黑名单自己（一张坏图不牵连整列）",
  cmpJs.includes('addEventListener("error", onErr)') &&
    cmpJs.includes("const assetBad = new Set();") &&
    /function assetFor\([\s\S]{0,120}?assetBad\.has\(path\)[\s\S]{0,60}?assetSrc\(/.test(cmpJs) &&
    /function thumbAssetFailed[\s\S]{0,500}?assetBad\.add\(path\)[\s\S]{0,200}?dropThumb\(row\);[\s\S]{0,120}?ensureThumb\(i, false\);/.test(cmpJs) &&
    !cmpJs.includes("assetDead")
);
check(
  "LRU 淘汰只清缓存、不摘屏上的图（一屏超过上限时前面几行会被自己挤成空格）",
  (() => {
    const from = cmpJs.indexOf("function rememberThumb");
    const to = cmpJs.indexOf("async function ensureThumb");
    if (from < 0 || to <= from) return false;
    const body = cmpJs.slice(from, to);
    return !body.includes("dropThumb(") && /while \(thumbCache\.size > STRIP_LRU_MAX\)/.test(body);
  })(),
  "rememberThumb 里不该再出现 dropThumb"
);


/* ------------------------------ 未读角标（三处显示） ------------------------------
   角标这套拆在四个文件里：CSS 给形、HTML 给节点、Rust 给图标上那颗、JS 给按钮上那个。
   假 DOM 不做布局也不画 Dock，少了哪一半都是「绿着坏」：
   - CSS 拆了 position:relative → 角标挂到整条导航栏的角上，桩里看不出来
   - 拆了 .nav-badge[hidden] → 以后谁加一句 display 就再也藏不住
   - Rust 少了 run_on_main_thread → 只在真机上踩未定义行为（tao 用的是 unchecked 标记）
   - 留一处裸 emit("sessions-changed") → 那一处不会刷角标，窗口开着时数字会冻住 */
const netMod = readFileSync(join(here, "..", "src-tauri", "src", "net", "mod.rs"), "utf8");
const badgeRs = readFileSync(join(here, "..", "src-tauri", "src", "net", "badge.rs"), "utf8");
const libRs = readFileSync(join(here, "..", "src-tauri", "src", "lib.rs"), "utf8");
check(
  "「传输」按钮是定位祖先（少了这句角标会挂到 .nav 上，跑到整条导航栏的角里）",
  /\.nav-btn \{[^}]*position: relative;/.test(css)
);
check(
  "角标是绝对定位胶囊且不抢点击（贴在按钮角落里，吃了 hover 就把按钮点不动了）",
  /\.nav-badge \{[^}]*position: absolute;[\s\S]*?top: -2px;[\s\S]*?right: -2px;[\s\S]*?pointer-events: none;/.test(css)
);
check(
  ".nav-badge[hidden] 显式 display:none（全局那条 !important 能赢，但角标该不该藏要在它自己这一段看得见，与 .chat-pick[hidden] 同一套写法）",
  /\.nav-badge\[hidden\] \{\s*display: none;/.test(css)
);
check(
  "角标节点就长在 data-goto=\"transfer\" 那个按钮里（拿下一个 </button> 切块，不是拿它当后缀匹配），JS 读的 id 也对得上",
  (() => {
    const from = html.indexOf('data-goto="transfer"');
    const to = html.indexOf("</button>", from);
    return from >= 0 && to > from && html.slice(from, to).includes('class="nav-badge" id="nav-badge-xfer" hidden');
  })() && xferJs.includes('el("nav-badge-xfer")')
);
/* 写第一版时把 renderNavBadge 挂在 applySessions 里：本地累加未读那条路（bumpRail）
   不走 applySessions，于是会话行涨了一个、按钮上的数不动 —— 两边必须共用同一次渲染 */
check(
  "按钮上那个数与会话栏那些行共用同一次渲染（挂在 renderSessionRail 里，不是只挂在 applySessions）",
  /function renderSessionRail\(\) \{[\s\S]{0,200}?renderNavBadge\(state\.sessionList\);/.test(xferJs) &&
    !/function applySessions\([\s\S]{0,600}?renderNavBadge\(/.test(xferJs)
);
check(
  "封顶两边同一个数：Rust 的 BADGE_CAP = 99，前端照旧写 > 99 ? \"99+\"",
  /pub const BADGE_CAP: i64 = 99;/.test(badgeRs) && /total > 99 \? "99\+"/.test(xferJs)
);
check(
  "角标调用包在 run_on_main_thread 里（badge/overlay 不自己跳主线程，而 tao 用的是 unchecked 标记）",
  /run_on_main_thread\(\s*move\s*\|\|\s*badge::apply_badge\(&badge_app, total\)\)/.test(netMod)
);
check(
  "sessions-changed 只有一个出口：emit_sessions() 以外一处裸 emit 都不许留（裸 emit 那一处不会刷角标）",
  (() => {
    const hits = netMod.match(/emit\(\s*"sessions-changed"/g) || [];
    const from = netMod.indexOf("pub fn emit_sessions");
    const to = netMod.indexOf("pub fn sessions_json");
    return hits.length === 1 && from >= 0 && to > from && netMod.slice(from, to).includes('emit("sessions-changed"');
  })(),
  `裸 emit 共 ${(netMod.match(/emit\(\s*"sessions-changed"/g) || []).length} 处`
);
check(
  "推给前端与算角标用的是同一份 payload（分两次算就会在两个线程读到两个版本的历史）",
  /pub fn emit_sessions[\s\S]{0,400}?let payload = self\.sessions_json\(\);[\s\S]{0,120}?self\.emit\("sessions-changed", payload\.clone\(\)\);[\s\S]{0,160}?badge::badge_total\(&payload\)/.test(netMod)
);
check(
  "overlay_dot 带 #[cfg(target_os = \"windows\")]（不门控就是 mac 上一个 dead_code 告警，本仓要求 0 warning）",
  /#\[cfg\(target_os = "windows"\)\]\s*fn overlay_dot\(\) -> tauri::image::Image/.test(badgeRs) &&
    /#\[cfg\(target_os = "windows"\)\]\s*let r = w\.set_overlay_icon\(/.test(badgeRs)
);
check(
  "mac 走的是能写 \"99+\" 的 set_badge_label，且 0/负数回 None、超档走 format!（set_badge_count 内部就是 to_string，拿它显不了 99+）",
  /#\[cfg\(target_os = "macos"\)\]\s*let r = w\.set_badge_label\(label\);/.test(badgeRs) &&
    /pub fn badge_label\(total: i64\) -> Option<String> \{[\s\S]{0,160}?t if t <= 0 => None,[\s\S]{0,120}?Some\(format!\("\{BADGE_CAP\}\+"\)\)/.test(badgeRs)
);
check(
  "启动先把冷历史那份未读推一次（在 manage(hub) 之前），再给关窗那一下清零（mac 上关窗不退进程，不清就冻在旧数字）",
  /hub\.emit_sessions\(\);[\s\S]{0,80}?app\.manage\(hub\);/.test(libRs) &&
    /WindowEvent::CloseRequested\s*\{\s*\.\.\s*\}[\s\S]{0,300}?badge::apply_badge\(app_handle, 0\)/.test(libRs)
);

/* ------------------------------ 本机接收（提示音 + 收件目录） ------------------------------
   这一套也拆在五个文件里：HTML/CSS 给形、prefs.json 给值、sound.rs 给声、server.rs 给时机。
   假 DOM 不会发也听不见声音，路径校验只在真机上才会踩，所以全靠下面的静态合约前移 */
const storeRs = readFileSync(join(here, "..", "src-tauri", "src", "store.rs"), "utf8");
const prefsRs = readFileSync(join(here, "..", "src-tauri", "src", "prefs.rs"), "utf8");
const soundRs = readFileSync(join(here, "..", "src-tauri", "src", "net", "sound.rs"), "utf8");
const serverRs = readFileSync(join(here, "..", "src-tauri", "src", "net", "server.rs"), "utf8");
const cargoToml = readFileSync(join(here, "..", "src-tauri", "Cargo.toml"), "utf8");
const winCheckLib = existsSync(join(here, "win-check", "src", "lib.rs"))
  ? readFileSync(join(here, "win-check", "src", "lib.rs"), "utf8")
  : "";
check(
  "抽屉里七个新节点齐（开关、文案、试听、路径、选择/恢复/打开），且 checkbox 初始就是 checked（出厂态要能与 Rust 的 default_notify 对上，不然「读到空」与「读到默认」行为不一样）",
  ['chk-notify-sound', 'sw-notify-text', 'btn-notify-audition', 'inbox-dir-value', 'btn-inbox-choose', 'btn-inbox-reset', 'btn-inbox-reveal'].every((id) => html.includes(`id="${id}"`)) &&
    /<input id="chk-notify-sound" type="checkbox" checked \/>/.test(html)
);
check(
  "收件目录那块用了 word-break：绝对路径很长又不带空格，不拆行会把抽屉撑出横向滚动条",
  /\.inbox-dir \{[^}]*word-break: break-all;/.test(css) && html.includes('class="inbox-dir" id="inbox-dir-value"')
);
check(
  "Preferences 两项都带 serde default：上一版 prefs.json 里根本没这两个字段，缺字段不能变成静默或空路径",
  /#\[serde\(default = "default_notify"\)\]\s*pub notify: bool,/.test(storeRs) &&
    /#\[serde\(default\)\]\s*pub inbox: String,/.test(storeRs)
);
check(
  "default_notify 真的回 true，而且 Default impl 用的就是它（不是写个 true 字面量，两处就会分叉）",
  /fn default_notify\(\) -> bool \{\s*true\s*\}/.test(storeRs) &&
    /notify: default_notify\(\),/.test(storeRs)
);
check(
  "normalize 会把相对路径的 inbox 清掉（相对路径会被当成相对于进程当前目录去建，从 Finder 与从 cargo 启动不是一个地方）",
  /if !self\.inbox\.is_empty\(\) && !Path::new\(&self\.inbox\)\.is_absolute\(\) \{\s*self\.inbox\.clear\(\);/.test(storeRs)
);
check(
  "inbox_dir() 从 prefs 取，空串回落 <数据目录>/inbox（两处反了就是「改了没用」或「默认也没了」）",
  /pub fn inbox_dir\(&self\) -> PathBuf \{[\s\S]{0,200}?let d = self\.load_prefs\(\)\.inbox;[\s\S]{0,120}?self\.dir\.join\("inbox"\)/.test(storeRs)
);
/* 参数名一律单词是 prefs.rs 自己立下的约束（多一个字母都不会报错，只会安静地不生效） */
check(
  "set_prefs 的参数名是单词 notify / inbox，前端传的键也是这两个（写成 inboxDir / notifySound 就永远对不上）",
  /notify: Option<bool>,\s*inbox: Option<String>,/.test(prefsRs) &&
    /saveRecvPrefs\(\{ notify: on \}\)/.test(xferJs) &&
    /saveRecvPrefs\(\s*\{ inbox: picked \}/.test(xferJs) &&
    /saveRecvPrefs\(\{ inbox: "" \}/.test(xferJs) &&
    !/invoke\("set_prefs"[\s\S]{0,80}?(inboxDir|notifySound)/.test(xferJs)
);
check(
  "目录校验在 Rust 侧而且是硬闸门：绝对路径 + create_dir_all + is_dir，调用处用 ? 带出（验不过就不改磁盘旧值）",
  /fn check_inbox\(v: &str\) -> Result<String, String> \{[\s\S]{0,700}?p\.is_absolute\(\)[\s\S]{0,120}?create_dir_all\(p\)[\s\S]{0,200}?meta\.is_dir\(\)/.test(prefsRs) &&
    /p\.inbox = check_inbox\(&i\)\?;/.test(prefsRs)
);
check(
  "启动建目录不再硬写 dir.join(\"inbox\")，而是问 store 要（不跟着改的话，换了目录收得到消息但目录建在老地方）",
  /create_dir_all\(store\.inbox_dir\(\)\)/.test(netMod) && !/create_dir_all\(dir\.join\("inbox"\)\)/.test(netMod)
);
check(
  "抽屉里收件摆放给了三档，value 就是 Rust 认的那三个词（day / month / flat），多的少的都会安静不生效",
  /<select id="inp-inbox-layout" class="select">[\s\S]{0,400}?<option value="day">[\s\S]{0,200}?<option value="month">[\s\S]{0,200}?<option value="flat">/.test(
    html,
  )
);
check(
  "收件落脚点按 layout 拼日期子目录（day → %Y-%m-%d，month → %Y-%m），而且是本地时间（用 UTC 会把晚上收的东西挪到明天那个文件夹）",
  /pub fn inbox_delivery_dir\(&self\) -> PathBuf \{[\s\S]{0,900}?"month" => Some\("%Y-%m"\),[\s\S]{0,120}?"day" => Some\("%Y-%m-%d"\),/.test(
    storeRs,
  ) && /chrono::Local::now\(\)\.format/.test(storeRs)
);
check(
  "收完摊平用的是 inbox_delivery_dir()，不是 inbox_dir()（写回根目录的话日期子目录就白分了，文件还堆在根上）；日期目录建不出来时退回根目录，不能因为缺一层子目录把整批退回工位",
  /let (?:mut )?target = hub\.store\.inbox_delivery_dir\(\);/.test(serverRs) &&
    /flatten_batch\(&target, &root, &name\)/.test(serverRs) &&
    /target = hub\.store\.inbox_dir\(\);/.test(serverRs) &&
    !/flatten_batch\(&hub\.store\.inbox_dir\(\)/.test(serverRs)
);
check(
  "老 prefs.json 缺 inbox_layout 时 normalize 补成按天，手改坏的值也回按天（静默退化成不分目录、界面还显示按天，比没得选更难查）",
  /pub const INBOX_LAYOUTS: \[&str; 3\] = \["day", "month", "flat"\];/.test(storeRs) &&
    /if !INBOX_LAYOUTS\.contains\(&self\.inbox_layout\.as_str\(\)\) \{\s*self\.inbox_layout = INBOX_LAYOUT_DEFAULT\.into\(\);/.test(
      storeRs,
    )
);
check(
  "摆放方式在 Rust 白名单里硬拦、前端按 Tauri 默认传 inboxLayout，存不下就把下拉退回原值（停在一个没生效的选项上最难找东西）",
  /inbox_layout: Option<String>,/.test(prefsRs) &&
    /if !INBOX_LAYOUTS\.contains\(&l\.as_str\(\)\) \{\s*return Err/.test(prefsRs) &&
    /saveRecvPrefs\(\s*\{ inboxLayout: next \}/.test(xferJs) &&
    /if \(ok\) paintInboxLayout\(next\);\s*else paintInboxLayout\(prev\);/.test(xferJs)
);
check(
  "inbox_dir 命令把 layout 一起带回来，抽屉打开时先回填下拉再刷路径（顺序反了样本路径会停在旧规则上）",
  /"layout": prefs\.inbox_layout,/.test(netMod) &&
    /if \(d && d\.layout\) paintInboxLayout\(String\(d\.layout\)\);\s*if \(d && d\.path\) paintInboxDir/.test(
      xferJs,
    )
);

/* ---------------------------- 在线探测：心跳节拍 ----------------------------
   这一项跳不过假 DOM：真正吃它的只有心跳那个后台线程，而它不在页面里。不盖到的那些
   （改完下一拍就生效、白名单外的脏值不致于把线程变成空转）由 store.rs 的
   「心跳节拍往返与白名单外的值退回出厂档」单测盖；这里只钉四个文件之间的接线 */
const clientRs = readFileSync(join(here, "..", "src-tauri", "src", "net", "client.rs"), "utf8");
check(
  "心跳节拍的白名单只有一份：store.rs 定义 + normalize 退出厂 + set_prefs 硬拒（交给 normalize 静默改，下拉会停在一个没生效的档位上）",
  /pub const HEARTBEAT_OPTIONS: \[u64; 4\] = \[1000, 2000, 5000, 10000\];/.test(storeRs) &&
    /if !HEARTBEAT_OPTIONS\.contains\(&self\.heartbeat_ms\) \{\s*self\.heartbeat_ms = HEARTBEAT_DEFAULT;/.test(storeRs) &&
    /if !HEARTBEAT_OPTIONS\.contains\(&h\) \{\s*return Err/.test(prefsRs)
);
check(
  "心跳线程真的每拍从磁盘重读节拍（不重启就生效），且那份写死的常量已经拆掉：两处 sleep 都用 beat，口令为空那条早退分支不能除外",
  /let beat = hub\.store\.load_prefs\(\)\.heartbeat_ms;/.test(clientRs) &&
    !/const HEARTBEAT_MS/.test(clientRs) &&
    (clientRs.match(/Duration::from_millis\(beat\)/g) || []).length === 2 &&
    !/Duration::from_millis\(HEARTBEAT_MS\)/.test(clientRs)
);
check(
  "下拉那四档与 Rust 白名单同口径（多一档就会存一个被硬拒的值），读的键是 heartbeat_ms、传的键是 heartbeatMs：两边写反一个就永远对不上",
  ["1000", "2000", "5000", "10000"].every((v) => html.includes(`<option value="${v}">`)) &&
    html.includes('id="inp-heartbeat"') &&
    /const HEARTBEAT_NAME = \{\s*1000: "1 秒",\s*2000: "2 秒",\s*5000: "5 秒",\s*10000: "10 秒",\s*\};/.test(xferJs) &&
    /typeof p\.heartbeat_ms === "number"\) paintHeartbeat\(p\.heartbeat_ms\)/.test(xferJs) &&
    /saveRecvPrefs\(\s*\{ heartbeatMs: next \}/.test(xferJs) &&
    !/invoke\("set_prefs"[\s\S]{0,80}?heartbeat_ms/.test(xferJs)
);
check(
  "存不上就把下拉退回原那一档，且提示里算得出「判离线要几秒」（3 拍那个口径只在 Rust 里，前端得跟着 OFFLINE_THRESHOLD 同名常量走）",
  /if \(ok\) paintHeartbeat\(next\);\s*else paintHeartbeat\(prev\);/.test(xferJs) &&
    /const OFFLINE_BEATS = 3;/.test(xferJs) &&
    /const OFFLINE_THRESHOLD: u32 = 3;/.test(clientRs) &&
    /next \* OFFLINE_BEATS/.test(xferJs)
);
check(
  "抽屉里那条「新收到的文件落在 …」是本地日期拼出来的真路径（day/month 两档与 Rust 同一口径），不是写死的示例；路径长了能折行，不能把抽屉撑宽",
  /function localDateStamp\(layout\) \{[\s\S]{0,400}?if \(layout === "month"\) return ym;[\s\S]{0,200}?if \(layout === "day"\) return/.test(
    xferJs,
  ) &&
    html.includes('id="inbox-layout-sample"') &&
    /\.hint code \{[^}]*word-break: break-all;/.test(css)
);
check(
  "sound.rs 三个平台分支齐：mac 走 afplay、Windows 走 MessageBeep、其余空实现（少一条要么是没声，要么是 dead_code 告警）",
  /#\[cfg\(target_os = "macos"\)\]\s*\{[\s\S]{0,600}?Command::new\("afplay"\)/.test(soundRs) &&
    /#\[cfg\(target_os = "windows"\)\]\s*\{[\s\S]{0,900}?MessageBeep\(/.test(soundRs) &&
    /#\[cfg\(not\(any\(target_os = "macos", target_os = "windows"\)\)\)\]/.test(soundRs)
);
check(
  "该不该响只有两个否决（开关 + 同一条 id），且同一条重发确实不叠声（重发与离线补录会把同 id 再投一遍）",
  /pub fn should_play\(enabled: bool, last_id: &str, id: &str\) -> bool \{\s*enabled && !id\.is_empty\(\) && id != last_id\s*\}/.test(soundRs) &&
    /last_notify: Mutex<String>/.test(netMod) &&
    /sound::should_play\(enabled, &last, id\)/.test(netMod)
);
check(
  "MessageBeep 只给已有的 windows 依赖加 feature，不引新 crate；Debug 与 WindowsAndMessaging 两个都在（函数归在 Diagnostics::Debug 页、参数类型 MB_ICONASTERISK 还在 WindowsAndMessaging）",
  /"Win32_UI_WindowsAndMessaging",/.test(cargoToml) &&
    /"Win32_System_Diagnostics_Debug",/.test(cargoToml) &&
    !/\nrodio|\ncoreaudio|\nopenal/.test(cargoToml)
);
/* Windows 那一半只在 CI 的 windows job 里编译：mac 全绿、整个 run 因为这条挂掉时，
   Release 里只会剩一个资产。import 路径与返回值形态都是「运行期看不出来、编译器才说」的东西，
   所以这里用壳工程真正编一遍 + 下面三条合约把结论钉住 */
check(
  "sound.rs 从 System::Diagnostics::Debug 引 MessageBeep，且没有从 WindowsAndMessaging 引它（CI 那次的 E0432 就是这么来的）",
  /use windows::Win32::System::Diagnostics::Debug::MessageBeep;/.test(soundRs) &&
    /use windows::Win32::UI::WindowsAndMessaging::MB_ICONASTERISK;/.test(soundRs) &&
    !/WindowsAndMessaging::MessageBeep/.test(soundRs)
);
check(
  "MessageBeep 的返值按 Result<()> 收（if let Err），不是当 BOOL 手调 .as_bool()（0.62 改了签名，按旧写法根本编译不过）",
  /if let Err\(e\) = unsafe \{ MessageBeep\(MB_ICONASTERISK\) \}/.test(soundRs) &&
    !/MessageBeep\([^)]*\)\.as_bool\(\)/.test(soundRs)
);
check(
  "MAC_SOUNDS 带 macos 门控（windows / linux 分支都不读它，不门控就是一个 never used 告警，本仓要求 0 warning）",
  /#\[cfg\(target_os = "macos"\)\]\s*const MAC_SOUNDS: \[&str; 3\]/.test(soundRs)
);
check(
  "tools/win-check 壳工程在场，include 的正是那两个只有 windows 才编译的文件，且它的 windows 特性列表也带上 Debug（壳少给特性会把好代码报成找不到符号）",
  existsSync(join(here, "win-check", "Cargo.toml")) &&
    // 用字符串包含而不是正则：path 里满是 / 与 .，正则转义很容易漏一个把正则字面量直接关掉
    ['#[path = "../../../src-tauri/src/net/sound.rs"]', "mod sound;",
      '#[path = "../../../src-tauri/src/net/badge.rs"]', "mod badge;"].every((s) => winCheckLib.includes(s)) &&
    /"Win32_System_Diagnostics_Debug",/.test(readFileSync(join(here, "win-check", "Cargo.toml"), "utf8"))
);
check(
  "两处落库各调一次 notify_arrived：文字一条、文件整批一条（少一处就是收文件不出声；一个文件夹也就响一声）",
  (serverRs.match(/hub\.notify_arrived\(&/g) || []).length === 2 &&
    /hub\.emit\("msg-in"[\s\S]{0,120}?hub\.notify_arrived\(&id\);/.test(serverRs) &&
    /hub\.emit\("xfer-done"[\s\S]{0,160}?hub\.notify_arrived\(&fid\);/.test(serverRs),
  `共 ${(serverRs.match(/hub\.notify_arrived\(&/g) || []).length} 处`
);
check(
  "两个新命令都进了 generate_handler，试听不带开关判断（它无视 notify 直接播，否则确认不了机器有没有声）",
  /net::inbox_dir,/.test(libRs) && /net::play_notify_sound,/.test(libRs) &&
    /#\[tauri::command\]\npub fn play_notify_sound\(\) \{\s*eprintln!\("\[sound\] 试听"\);\s*sound::play\("audition"\);/.test(netMod)
);
check(
  "选收件目录复用 pick_folder（只多一个 title 参数），而且前端真的传了那句标题；取消时直接 return 不写盘",
  /pub async fn pick_folder\(app: AppHandle, title: Option<String>\)/.test(netMod) &&
    /set_title\(title\.unwrap_or_else\(\|\| "选择要发送的文件夹"\.into\(\)\)\)/.test(netMod) &&
    /invoke\("pick_folder", \{ title: "选择收件目录" \}\)/.test(xferJs) &&
    /if \(!picked\) return;/.test(xferJs)
);
check(
  "这两项只在「设置」那一页露出时读（进启动路径就会多一份 get_prefs + inbox_dir 往返，也会拿到一份可能旧的）",
  applyPageBody.includes("refreshRecvPrefs();") &&
    !drawerToggleBody.includes("refreshRecvPrefs();") &&
    /async function refreshRecvPrefs\(\) \{[\s\S]{0,200}?invoke\("get_prefs"\)/.test(xferJs)
);

/* ---------------------------- 图标管线那三步 ---------------------------- */
// 为什么这几条要钉住：换图标时踩到「npm run icon 本身就是坏的」——tauri icon 不带参数
// 会去找 ./app-icon.png，直接报 no such file。这类「一执行就错」的东西最该前移成静态合约。
const pkgJson = readFileSync(join(here, "..", "package.json"), "utf8");
const makeIconPy = readFileSync(join(here, "..", "tools", "make_icon.py"), "utf8");
const gitignore = readFileSync(join(here, "..", ".gitignore"), "utf8");
check(
  "npm run icon 必须把源图路径写死（tauri icon 不带参数会去找 ./app-icon.png，直接失败）",
  pkgJson.includes('"icon": "tauri icon assets/app-icon-source.png"')
);
check(
  "make_icon.py 是产源图的唯一入口，写的就是 assets/app-icon-source.png（手贴 PNG 会被下一次跑脚本覆盖）",
  makeIconPy.includes('OUT = Path(__file__).resolve().parent.parent / "assets" / "app-icon-source.png"') &&
    existsSync(join(here, "..", "assets", "app-icon-source.png"))
);
check(
  "tauri icon 每次都会多生成 ios/android 两套（本项目没移动目标），这两个目录得在 .gitignore 里",
  /^src-tauri\/icons\/ios$/m.test(gitignore) && /^src-tauri\/icons\/android$/m.test(gitignore)
);

/* ------------------------- 查看历史（侧栏默认源） ------------------------- */
/* 为什么这一堆要钉住静态源码：历史那份数据走的是「读不到就当没发生过」的路子，
   真机上不报错、只表现为「侧栏白着」或「记不住」，逻辑自检（folder_browse）那边
   用的是桩后端，咬不到 Rust 侧的闸门与「别塞进 prefs.json」这个决定。 */
const historyRs = readFileSync(join(here, "..", "src-tauri", "src", "history.rs"), "utf8");
check(
  "三条历史命令都进了 generate_handler，mod history 也在（漏一条就是 invoke 到「命令不存在」，而那只在点 tab / 清空时才炸）",
  /mod history;/.test(libRs) &&
    /history::get_history,/.test(libRs) &&
    /history::record_view,/.test(libRs) &&
    /history::clear_history,/.test(libRs) &&
    (historyRs.match(/#\[tauri::command\]/g) || []).length === 3
);
check(
  "history.json 只经 atomic_write 落盘；读那一路把「文件缺失」与「解析失败」都回成空列表而不是 Err（第一次启动本就没这个文件，回 Err 侧栏就永远白着）",
  /fn save_history\(&self, h: &HistoryFile\) -> Result<\(\), String> \{\s*atomic_write\(\s*&self\.file\("history\.json"\)/.test(storeRs) &&
    /fn load_history\(&self\) -> HistoryFile \{[\s\S]{0,240}?\.unwrap_or_default\(\);\s*h\.normalize\(\);/.test(storeRs) &&
    !/fs::write\(\s*&self\.file\("history\.json"\)/.test(storeRs)
);
check(
  "上限只有一处定义：Rust 用 HISTORY_MAX 常量截断（写死数字的两处一分叉，头部那句「最多留 N 条」就成了假话），前端那份显式对齐它",
  /pub const HISTORY_MAX: usize = 100;/.test(storeRs) &&
    /kept\.truncate\(HISTORY_MAX\);/.test(storeRs) &&
    !/kept\.truncate\(100\)/.test(storeRs) &&
    /const HISTORY_MAX = 100;/.test(cmpJs) &&
    /最多留 \$\{HISTORY_MAX\} 条/.test(cmpJs)
);
check(
  "绝对路径的闸门在 Rust 那侧：空与相对都硬拒（前端只发一条路径，闸门放前端就等于没放）",
  /fn record\(store: &Store, path: &str\) -> Result<HistoryFile, String> \{[\s\S]{0,400}?if path\.is_empty\(\) \{[\s\S]{0,240}?!Path::new\(path\)\.is_absolute\(\)/.test(historyRs)
);
const setPrefsSig = prefsRs.slice(
  prefsRs.indexOf("pub fn set_prefs("),
  prefsRs.indexOf(") -> Result<Value, String>", prefsRs.indexOf("pub fn set_prefs(")) + 20
);
check(
  "源选择不进 prefs.json：set_prefs 的参数表里只有 layout/sync/wheel/notify/inbox，没有任何 history/source 字样（钉住「侧栏开合与源都是单次会话自己的事」这条既有口径）",
  setPrefsSig.includes("layout: Option<String>") &&
    setPrefsSig.includes("inbox: Option<String>") &&
    !/history|source|strip/i.test(setPrefsSig) &&
    !/invoke\("set_prefs"[\s\S]{0,120}?(history|stripSource|source)/.test(cmpJs)
);
check(
  "两个源 tab 的 id 在 HTML 与 CSS 里都在，CSS 还留着 is-active 那一态（只有 HTML 没样式的话，点亮与不点亮看着一样，用户分不出当前源）",
  ["btn-src-history", "btn-src-dir"].every((id) => html.includes(`id="${id}"`)) &&
    /\.fs-src \{/.test(css) &&
    /\.fs-src\.is-active \{/.test(css)
);
check(
  "清空那枚按钮在对比视图的设置抽屉里（不是工具栏、也不是传输抽屉），且那句说明写清「不动图片文件本身」",
  (() => {
    const from = html.indexOf('id="cmp-settings"');
    const to = html.indexOf("</aside>", from);
    const seg = from >= 0 && to > from ? html.slice(from, to) : "";
    return seg.includes('id="btn-history-clear"') && seg.includes("不动图片文件本身");
  })()
);
check(
  "历史渲染直接吃写盘的返回值：对比视图里只有一处 get_history 的 invoke（冷启动那次），写完再读一遍会多一次往返且两份顺序可能不一致",
  /noteViewSeen\(path\)\.then\(\(list\) => \{[\s\S]{0,400}?applyHistory\(list, \{ fromView: true \}\)/.test(cmpJs) &&
    (cmpJs.match(/invoke\("get_history"\)/g) || []).length === 1
);
check(
  "记一次查看不 await：一次图片载入不该卡在磁盘写上（失败只 setStatus 说一声，侧栏继续用本地那份）",
  !/await\s+(noteViewSeen|invoke\("record_view")/.test(cmpJs) &&
    /function recordView\(path,[\s\S]{0,600}?noteViewSeen\(path\)\.then/.test(cmpJs) &&
    /function noteLoaded\([\s\S]{0,700}?recordView\(path\);/.test(cmpJs) &&
    /export function noteViewSeen\([\s\S]{0,700}?setStatus\("记录查看失败: "/.test(apiJs)
);
check(
  "record_view 只从 api.js 发这一个口子：各视图自己写一份就会有三套截断/去重口径（同一张在两个视图里被记成两条）",
  (apiJs.match(/invoke\("record_view"/g) || []).length === 1 &&
    !/invoke\("record_view"/.test(cmpJs) &&
    !/invoke\("record_view"/.test(xferJs) &&
    /export function noteViewSeen\(path\)/.test(apiJs)
);
check(
  "侧栏逐张浏览走的是「不重排」那一路：browseTo 真读到图之后必须显式传 reorder:false（漏了它历史源下每按一次方向键列表就跳一次、下一张也跟着变），且不重排时也要把最新那份存进 browse.history",
  /async function browseTo\([\s\S]{0,3000}?recordView\(item\.path, \{ reorder: false \}\)/.test(cmpJs) &&
    /function recordView\(path, \{ reorder = true \} = \{\}\)/.test(cmpJs) &&
    /else browse\.history = /.test(cmpJs)
);
check(
  "传输视图点缩略图放大也记一次查看（放大就是真看过），而且不在这个视图里碰侧栏渲染（它压根看不见侧栏）",
  /function openLightbox\([\s\S]{0,600}?noteViewSeen\(lightboxPath\)/.test(xferJs) &&
    !/applyHistory/.test(xferJs) &&
    xferJs.includes("noteViewSeen,")
);
check(
  "切源与历史渲染都不清 thumbCache：清它的那一处只在 ensureFolderList 里（换目录才该丢；来回切一次源把小图全丢了是白费重读盘）",
  (cmpJs.match(/thumbCache\.clear\(\)/g) || []).length === 1 &&
    (() => {
      const from = cmpJs.indexOf("async function ensureFolderList");
      return cmpJs.slice(from, cmpJs.indexOf("\n}", from)).includes("thumbCache.clear()");
    })()
);
check(
  "文案按源分流：空列表那句两个版本都在，历史源下头部写「最近看过」而不是目录名（历史源下说「目录」是假话）",
  cmpJs.includes('"还没有查看历史（先打开一张本机的图）"') &&
    cmpJs.includes('"还没有可浏览的文件夹（先打开一张本机的图）"') &&
    /if \(browse\.source === "history"\) \{\s*ui\.stripDir\.textContent = "最近看过";/.test(cmpJs)
);
check(
  "侧栏那一句 aria-label 与工具栏文案都不再假定列表就是文件夹（「当前图片所在文件夹」是历史源下的假话）",
    !html.includes("当前图片所在文件夹") &&
    html.includes('aria-label="图片列表"') &&
    /id="btn-strip"[^>]*>列表<\/button>/.test(html)
);

/* -------------------------------------------------------------------------- */
/* ==========================================================================
 * 田字查看：把一张图原样铺成 2×2（四份一样的），验十字那两条接缝
 *
 * 几何用真函数数（覆盖计数那组：四份落点必须把 2w×2h 盖满、每像素恰好一次），画法用静态
 * 合约钉住「四份进同一张 canvas、每份画的是整张图」—— 桩里没有 2D 上下文，画不出来。
 * 真渲染下的等价性另用 headless Chrome 探针证过：617×411（奇数）走「canvas → PNG →
 * <img> → 4 份 drawImage」，四个象限各自与原图逐像素零差异；对照组（把图切成 1/4 再铺）
 * 是几千个像素的差异 —— 对照组能红，说明那个探针不是恒真的。
 * ========================================================================== */
/** 画布上每个像素恰好被覆盖一次才算对：少了就是一条真缝，多了是把同一处画了两遍 */
function onceCovered(boxes, w, h) {
  const cnt = new Uint8Array(w * h);
  for (const b of boxes) {
    if (b.w <= 0 || b.h <= 0) return "有零宽/零高的块";
    for (let y = b.y; y < b.y + b.h; y++) {
      if (y < 0 || y >= h) return `越出画面 y=${y}`;
      for (let x = b.x; x < b.x + b.w; x++) {
        if (x < 0 || x >= w) return `越出画面 x=${x}`;
        const i = y * w + x;
        if (cnt[i]++) return `重叠在 (${x},${y})`;
      }
    }
  }
  for (let i = 0; i < cnt.length; i++) if (cnt[i] !== 1) return `漏了 (${i % w},${(i / w) | 0})`;
  return "";
}

const TV_SIZES = [[600, 400], [617, 411], [1, 1], [2, 2], [3, 3], [17, 400], [1, 400], [999, 777]];
const tvBad = [];
for (const [w, h] of TV_SIZES) {
  const spots = tilePlacements(w, h);
  if (spots.length !== 4) {
    tvBad.push(`${w}×${h} 不是 4 份`);
    continue;
  }
  // 每份都按原尺寸落在自己的象限：四份合起来正好把 2w×2h 盖满，十字处边贴边、不重不漏
  const err = onceCovered(spots.map((p) => ({ x: p.dx, y: p.dy, w, h })), w * 2, h * 2);
  if (err) tvBad.push(`${w}×${h} ${err}`);
  const want = [[0, 0], [w, 0], [0, h], [w, h]];
  spots.forEach((p, i) => {
    if (p.dx !== want[i][0] || p.dy !== want[i][1]) {
      tvBad.push(`${w}×${h} 第 ${i + 1} 份落在 (${p.dx},${p.dy})，应是 (${want[i][0]},${want[i][1]})`);
    }
  });
}
check(
  "铺 4 份正好填满 2w×2h：每份落在自己的象限（左上/右上/左下/右下）、按原尺寸、互不重叠，十字处边贴边",
  tvBad.length === 0,
  tvBad.join(" | ")
);
check(
  "边长不足 1 像素时返回空数组而不是瞎画：drawImage 的源宽高传 0 是浏览器差异区（有的当空操作、有的抛错）",
  tilePlacements(0, 0).length === 0 &&
    tilePlacements(undefined, 400).length === 0 &&
    tilePlacements(-5, 10).length === 0 &&
    tilePlacements(1, 1).length === 4
);
check(
  "四份画的是**整张图**（源矩形 0,0,w,h）、画布是 2w×2h：切成四块再拼回等于原图本身，屏上什么变化都没有，也就无从看接缝 —— 这正是第一版做反的地方",
  /g\.drawImage\(pane\.img, 0, 0, w, h, p\.dx, p\.dy, w, h\)/.test(cmpJs) &&
    /c\.width = w \* 2;/.test(cmpJs) &&
    /c\.height = h \* 2;/.test(cmpJs)
);

const tvHtml = (() => {
  const a = html.indexOf('id="cmp-tileview"');
  const b = html.indexOf("<!-- 聊天缩略图点开的放大层", a);
  return a < 0 || b < 0 ? "" : html.slice(a, b);
})();
check(
  "覆盖层里只有一张 canvas，没有 4 个 <img> 摆 2×2：非整数倍缩放下浏览器会在格子间画亚像素亮缝（第 29 条），拿会造假缝的画法去验缝必然出错",
  tvHtml !== "" && tvHtml.includes('id="tv-canvas"') && !/<img\b/.test(tvHtml),
  tvHtml ? tvHtml.slice(0, 100) : "没找到 #cmp-tileview"
);

const setImgBody = cmpJs.slice(cmpJs.indexOf("async setImage("), cmpJs.indexOf("  clear() {"));
const clearBody = cmpJs.slice(cmpJs.indexOf("  clear() {"), cmpJs.indexOf("/** 适应本窗"));
check(
  "「田字」按钮出厂是灰的（没图就没得切），载入与清空各刷新一次 —— 漏掉载入那次它就永远灰着，这功能等于没接上",
  /id="btn-tile"[^>]*disabled/.test(html) &&
    setImgBody.includes("tvRefreshBtn()") &&
    clearBody.includes("tvRefreshBtn()"),
  `setImage=${setImgBody.includes("tvRefreshBtn()")} clear=${clearBody.includes("tvRefreshBtn()")}`
);

check(
  "缩放与图窗共用 applyZoom + 同一档 25%~800%：两处口径分家的话，同一个滚轮手势在两边放大的幅度不一样",
  /function tvZoom\(factor, anchor\) \{[\s\S]{0,220}?applyZoom\(tv\.st, factor/.test(cmpJs) &&
    /function tvFit\(\) \{[\s\S]{0,300}?clamp\(Math\.min\(vw \/ tv\.w, vh \/ tv\.h\), MIN_SCALE, MAX_SCALE\)/.test(cmpJs)
);

const tvKeyAt = cmpJs.indexOf("  if (tv.open) {");
const metaOAt = cmpJs.indexOf('if (meta && key === "o")');
check(
  "田字查看开着时它先接键再 return：不拦的话底下那套 1/2/4 会同时生效，按一个 1 两层一起动",
  tvKeyAt > 0 && metaOAt > tvKeyAt && cmpJs.slice(tvKeyAt, metaOAt).includes("return;")
);

check(
  "覆盖层是固定满屏 + 裁掉溢出（放大后不能把窗口撑出滚动条），画布用左上原点 transform（与 .layer 同口径）",
  /\.tileview \{[^}]*position: fixed;[^}]*inset: 0;[^}]*overflow: hidden;/.test(cssBare) &&
    /\.tv-canvas \{[^}]*transform-origin: 0 0;/.test(cssBare)
);

check(
  "关掉就把画布尺寸归零：拼好的那份位图是几十 MB，关掉还留着是白占内存",
  /function tvClose\(\)[\s\S]{0,600}?tvCanvas\.width = 0;/.test(cmpJs)
);

/* ------------------- 图片右键菜单：文案与层叠顺序（静态钉住） -------------------
 * 行为那十几条已经用桩跑过；这里钉的是「文案不能悄悄退回英文」「不能被别的浮层压下去」。
 * 原生菜单的语言是 WebKit 按 app 本地化选的，改不了，所以只能拦住后自己画 ——
 * 一旦下面任一条断了，用户看到的就又是截图里那套英文。
 */
const ctxRule = (cls) => {
  const i = css.indexOf(`.${cls} {`);
  return i < 0 ? "" : css.slice(i, css.indexOf("}", i) + 1);
};
const zOf = (cls) => {
  const m = /z-index:\s*(\d+)/.exec(ctxRule(cls));
  return m ? Number(m[1]) : -1;
};
check(
  "菜单五项，全是中文，没有照抄 WebView 那套（Open Image / Copy Subject / Look Up）",
  ["ctx-save", "ctx-copy-img", "ctx-copy-path", "ctx-send", "ctx-reveal"].every((id) => html.includes(`id="${id}"`)) &&
        /id="ctx-send"[^>]*>发送到聊天</.test(html) &&
    /id="ctx-save"[^>]*>另存为…</.test(html) &&
    /id="ctx-copy-img"[^>]*>复制图片</.test(html) &&
    /id="ctx-copy-path"[^>]*>复制文件路径</.test(html) &&
    /id="ctx-reveal"[^>]*>在文件夹中显示</.test(html) &&
    // 只看菜单本体（html）：js 与 html 注释里都写明了原生那套叫什么，那不是文案
    !/Open Image|Copy Image|Copy Subject|Look Up|Inspect Element/.test(html.replace(/<!--[\s\S]*?-->/g, ""))
);
check(
  "「发送到聊天」先登记投递再去切视图（顺序反了就是切过去没东西可发）",
  /act === "send"[\s\S]{0,200}?setPendingSend\(path, name\)[\s\S]{0,80}?setView\("transfer"\)/.test(cmpJs)
);
check(
  "菜单压在抽屉(500)与放大层(900)之上：菜单 950（低了就会被 lightbox 盖住，右键等于没反应）",
  zOf("ctx-menu") === 950 && zOf("lightbox") === 900
);
check(
  "两处入口各自绑一遍：图窗 viewport（img 与上层的画布都冒泡到这里）与侧栏每一行",
  /this\.viewport\.addEventListener\("contextmenu"/.test(cmpJs) &&
    /row\.addEventListener\("contextmenu"/.test(cmpJs)
);
check(
  "没有 document 级 contextmenu 拦截：输入框里的右键粘贴还得是系统那套",
  !/document\.addEventListener\(\s*["']contextmenu/.test(cmpJs)
);
check(
  "点外面关闭走 window 的 pointerdown + contains 判归属（用 click 的话按住拖出去再松手会漏；不判 contains 会把菜单里自己的点击也当成外面）",
  /window\.addEventListener\("pointerdown"[\s\S]{0,300}?imgMenu\.contains/.test(cmpJs)
);

/* ------------------------- 撤回与本机删除（静态合约） -------------------------
   这一整块只能静态钉：时间窗要真等一分钟、对端要真两台机器，桩里既跑不到也等不起。
   而最容易坏恰恰是「两边各写一份」的那几处 —— 常量、文案、路由、命令注册，
   改一处漏另一处不会报错，只会让用户看到一句对不上的提示或「撤回失败」 */
const recallWinRust = /pub const RECALL_WINDOW_MS: i64 = ([\d_]+);/.exec(storeRs);
const recallWinJs = /const RECALL_MS = (\d+);/.exec(xferJs);
check(
  "「一分钟」这个数两边相等：Rust 的 RECALL_WINDOW_MS 与前端的 RECALL_MS（前端那个只管入口露不露，真判据在 recall_check）",
  !!recallWinRust &&
    !!recallWinJs &&
    Number(recallWinRust[1].replace(/_/g, "")) === Number(recallWinJs[1]) &&
    /if now - m\.ts >= RECALL_WINDOW_MS/.test(storeRs)
);
check(
  "recall_check 三条否决齐：不是自己发的、已经撤过、过了窗口（少一条就会出现「撤过的还能再撤一次」，或对方发来的也能被本机撤走）",
  /pub fn recall_check\(m: &Message, now: i64\) -> Result<\(\), String> \{/.test(storeRs) &&
    /if m\.dir != "out"/.test(storeRs) &&
    /if m\.recalled \{/.test(storeRs) &&
    /Err\("超过 1 分钟就不能撤回了"/.test(storeRs)
);
check(
  "撤回与本机删除都只是「同 id 再追一行」：patch_flags 在场、read_messages 出口把 hidden 挡掉、待发队列同时避开两个标记",
  /pub fn patch_flags\(\s*&self,\s*id: &str,\s*patch: impl FnOnce\(&mut Message\)/.test(storeRs) &&
    /\.filter\(\|m\| !m\.hidden\)/.test(storeRs) &&
    /m\.state == "queued" && !m\.recalled && !m\.hidden/.test(storeRs)
);
check(
  "两个命令都进了 generate_handler（少注册一个，前端 invoke 只拿到「command not found」，而桩里那套是全绿的）",
  /net::msg_recall,/.test(libRs) &&
    /net::msg_delete,/.test(libRs) &&
    /pub async fn msg_recall\(/.test(netMod) &&
    /pub fn msg_delete\(/.test(netMod) &&
    /invoke\("msg_recall"/.test(xferJs) &&
    /invoke\("msg_delete"/.test(xferJs)
);
const recallFnRs = (/pub fn recall\([\s\S]*?\n\}/.exec(clientRs) || [""])[0];
check(
  "/recall 两端都有且方向对：client.rs 发这个路由，server.rs 认这个路由（只改一边就是「点了撤回对方那头毫无反应」）",
  clientRs.includes('"/recall"') && serverRs.includes('("POST", "/recall")')
);
check(
  "撤回请求只带签名头、不带 X-Session（带了会话头对端会顺手把「那个框」在本机建出来，撤回不该有这种副作用），且把 404 翻成人话",
  recallFnRs.includes("signed_headers") &&
    !recallFnRs.includes("session_headers") &&
    /resp\.status == 404/.test(recallFnRs)
);
check(
  "对端那侧只让发送者本人撤：handle_recall 既判它必须是收下来的那一条，也拿签名里的设备 ID 比 peer（不比的话任何一台都能撤别人的那一条）",
  /fn handle_recall\(/.test(serverRs) &&
    /if m\.dir != "in"/.test(serverRs) &&
    /if m\.peer != from\.dev_id/.test(serverRs) &&
    /if m\.hidden\s*\{\s*return Ok\(\(\)\);/.test(serverRs)
);
check(
  "状态落库不会把刚撤的那条冲回来：四处状态写入全过 with_flags，with_flags 先读盘上的标记，投成功后还认 recalled 补一刀",
  (clientRs.match(/super::with_flags\(&hub\.store, msg/g) || []).length === 3 &&
    /let done = with_flags\(store, msg/.test(netMod) &&
    /let \(recalled, hidden\) = store\.flags_of\(&msg\.id\);/.test(netMod) &&
    /if done\.recalled \{/.test(clientRs)
);
check(
  "会话栏那句短文案两边一份：Rust 的 RECALL_SUMMARY 与前端 RECALL_SUMMARY 字符串相等，且摘要与未读两条口径都认 recalled",
  (/pub\(crate\) const RECALL_SUMMARY: &str = "([^"]+)";/.exec(netMod)?.[1] || "") ===
    (/const RECALL_SUMMARY = "([^"]+)";/.exec(xferJs)?.[1] || "") &&
    /if m\.recalled \{\s*RECALL_SUMMARY/.test(netMod) &&
    /if m\.dir == "in" && !m\.recalled && m\.ts > /.test(netMod) &&
    /if \(m\.recalled\) return RECALL_SUMMARY;/.test(xferJs)
);
/* 聊天气泡的右键菜单：撤回与本机删除都搬进这一份中文菜单了。
   为什么要有这条静态合约：这一处「翻译成中文」完全活在页面 + 样式 + 菜单接线里，
   任何一环丢了 node 自检都还是绿的 —— 漏一项 / 漏一条 [hidden] 规则 / 干脆没拦右键 */
const msgMenuBlock = (() => {
  const i = html.indexOf('id="chat-msg-menu"');
  return i < 0 ? "" : html.slice(i, i + 1100);
})();
check(
  "气泡右键菜单是一份中文的：撤回与删除都搬进来了，且没有一条 WebView 原生菜单那套英文项",
  msgMenuBlock.length > 0 &&
    ["复制正文", "引用回复", "转发到别的会话", "复制图片", "另存为…", "复制文件路径", "在文件夹中显示", "在对比中打开", "撤回这一条", "删除（只删本机）"].every(
      (t) => msgMenuBlock.includes(t)
    ) &&
    !/Look Up|Translate|Search with|Copy Link|Share…|Speech|Inspect Element|Open Image|Download Image|Copy Subject/.test(
      msgMenuBlock
    ),
  msgMenuBlock.slice(0, 60)
);
check(
  "整条气泡都拦右键：监听挂在 .msg 外层 wrap 上（不再是「只有图片气泡拦」、「悬停才露一排按钮」那两套旧做法）",
  /wrap\.addEventListener\("contextmenu", \(ev\) => openMsgMenu\(ev, rec\)\)/.test(xferJs) &&
    !/bubble\.addEventListener\("contextmenu"/.test(xferJs) &&
    !/stream\.addEventListener\("contextmenu"/.test(xferJs) &&
    !xferJs.includes('className = "msg-acts"') &&
    !cssBare.includes(".msg-acts") &&
    !/\.msg \{[^}]*position: relative;/.test(css)
);
check(
  "每一项按「这一条是什么」动态显隐：撤回走 recallable、删除永远在；关掉菜单时把「再点一次删除」回写回原文案",
  /show\(ui\.msgRecall, recallable\(rec, t\.m\)\)/.test(xferJs) &&
    /show\(ui\.msgDel, true\)/.test(xferJs) &&
    /ui\.msgDel\.textContent = MSG_DEL_LABEL/.test(xferJs) &&
    /const MSG_DEL_LABEL = "([^"]+)";/.test(xferJs)
);
check(
  "菜单里的删除要两下：没臂上不真调后端，臂上 4 秒没人点自己退回原文案（右键手一下不该就没了一条消息）",
  /if \(!msgMenu\.armed\) \{[\s\S]{0,320}?msgArmTimer = setTimeout\([\s\S]{0,240}?\}, 4000\);\s*return;\s*\}/.test(
    xferJs
  ) &&
    /closeMsgMenu\(\);\s*deleteMessage\(rec\)/.test(xferJs)
);
check(
  "菜单项显隐靠 hidden 属性，样式里必须有 .ctx-menu > [hidden]：.ctx-item 是 display:block，光给属性挡不住",
  /\.ctx-menu > \[hidden\] \{[^}]*display: none;/.test(css) &&
    /const show = \(node, on\) => \{\s*if \(node\) node\.hidden = !on;/.test(xferJs)
);
check(
  "撤回之后的提示样式还在（菜单搬走之后不能顺手把这一条也删了）",
  /\.msg\.is-recalled \.bubble \{/.test(css) && /\.msg-recalled \{/.test(css)
);

/* 放大层的右键菜单（中文五项）：最后一处还弹系统英文菜单的地方。行为那几条活在
   session_route_check 的 20e；这里钉的是「菜单本体在不在、拦的是不是整层、收菜单
   与关层不能互咬」——全是接线上的事，断一环自检未必响 */
const lbMenuBlock = (() => {
  const i = html.indexOf('id="lightbox-menu"');
  return i < 0 ? "" : html.slice(i, i + 600);
})();
check(
  "放大层菜单五项都在且全中文：复制图片 / 另存为… / 复制文件路径 / 在文件夹中显示 / 在对比中打开",
  lbMenuBlock.length > 0 &&
    ["lbm-copy-img", "lbm-save", "lbm-copy-path", "lbm-reveal", "lbm-compare"].every(
      (id) => lbMenuBlock.includes(`id="${id}"`)
    ) &&
    ["复制图片", "另存为…", "复制文件路径", "在文件夹中显示", "在对比中打开"].every((t) => lbMenuBlock.includes(t)) &&
    !/Copy Image|Save Image|Copy Subject|Look Up|Inspect Element|Save As/.test(lbMenuBlock),
  lbMenuBlock.slice(0, 60)
);
check(
  "拦的是整层：contextmenu 挂在 ui.lightbox 上；没本机路径时 openLbMenu 自己不拦（剪贴板纯位图那回，系统的「拷贝图像」是唯一有用的项）",
  /ui\.lightbox\.addEventListener\("contextmenu", openLbMenu\)/.test(xferJs) &&
    /function openLbMenu\(ev\) \{\s*if \(!ui\.lbMenu \|\| !lightboxPath\) return;/.test(xferJs) &&
    !/lightboxImg\.addEventListener\("contextmenu"/.test(xferJs)
);
check(
  "五项全走已有命令，不新开后端：复制走 copyPathAsFile、另存为走 save_path_as、路径走 copyText、显示走 reveal_in_folder",
  /if \(act === "copy-img"\) \{\s*await copyPathAsFile\(\[p\]\);/.test(xferJs) &&
    /await invoke\("save_path_as", \{ src: p \}\)/.test(xferJs) &&
    /await copyText\(p\)/.test(xferJs) &&
    /await invoke\("reveal_in_folder", \{ path: p \}\)/.test(xferJs)
);
check(
  "「在对比中打开」先关层再切视图：overlay 带着走会把黑幕盖在对比视图上",
  /} else if \(act === "compare"\) \{[\s\S]{0,120}?closeLightbox\(\);\s*openInCompare\(\[p\]\);/.test(xferJs)
);
check(
  "收菜单不吃层：点外面那一下只收菜单（lbKeepLayerOnce 只吃一次），背景那一击不再被当成「关层」；关层时菜单不能留在屏上指着空气",
  /if \(fromOutside\) lbKeepLayerOnce = true;/.test(xferJs) &&
    /if \(lbKeepLayerOnce\) \{\s*lbKeepLayerOnce = false;\s*return;\s*\}/.test(xferJs) &&
    /closeLbMenu\(true\)/.test(xferJs) &&
    /lightboxPath = null;\s*\/\/[^\n]+\n\s*closeLbMenu\(\);/.test(xferJs)
);
check(
  "滚轮/改窗口大小/失焦/Esc 一次收齐菜单与浮层（closeAllMenus 管 chat+msg+lb+fwd+find 五家，不能搬走一项就漏了哪份）",
  /const closeAllMenus = \(\) => \{[\s\S]{0,180}?closeChatMenu\(\);[\s\S]{0,40}?closeMsgMenu\(\);[\s\S]{0,40}?closeLbMenu\(\);[\s\S]{0,40}?closeFwdPick\(\);[\s\S]{0,40}?closeFind\(\);/.test(xferJs) &&
    !/closeBothMenus/.test(xferJs) &&
    /window\.addEventListener\("wheel", closeAllMenus/.test(xferJs) &&
    /ev\.key === "Escape"\) closeAllMenus\(\)/.test(xferJs)
);

/* 引用回复的静态合约：这一项横跨 Rust 两端与前端三层，最容易坏的恰恰是
   「两端各写一份」的字段对齐 —— 改一处漏另一处不会报错，只会让引用默默丢掉 */
check(
  "Quote 结构体与 Message.quote 字段在 Rust 侧存在，且全部 serde(default) 兜底（老文件/老对端反序列化不能报错）",
  /pub struct Quote \{[\s\S]{0,700}?\}/.test(storeRs) &&
    /pub quote: Option<Quote>/.test(storeRs) &&
    /#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\n    pub quote: Option<Quote>,/.test(storeRs) &&
    /quote: None,/.test(storeRs)
);
check(
  "quote 一路对齐：命令参数 → client 落库与 wire → server 原样落库，三段都在（缺一段就是前端传了后端丢）",
  /quote: Option<store::Quote>/.test(netMod) &&
    /payload\["quote"\] = serde_json::to_value\(q\)/.test(clientRs) &&
    /quote,\n        \.\.Default::default\(\)/.test(clientRs) &&
    /quote: parsed\.quote/.test(serverRs) &&
    /#\[serde\(default\)\]\n        quote: Option<store::Quote>,/.test(serverRs)
);
check(
  "前端引用三件套的 DOM 与样式都落了地：预览条三个 id、卡片与条的样式、闪一下的 keyframes",
  ["xfer-quote", "xfer-quote-text", "xfer-quote-x"].every((id) => html.includes(`id="${id}"`)) &&
    ["xfer-quote", "xfer-quote-text", "xfer-quote-x"].every((id) => xferJs.includes(`el("${id}")`)) &&
    /\.quote-card \{/.test(css) &&
    /\.quote-bar \{/.test(css) &&
    /@keyframes msg-flash/.test(css) &&
    /\.msg\.is-flash \.bubble \{/.test(css)
);

/* 转发的静态合约：零新后端命令是这一项的设计核心 —— 坏的点不在后端，在
   「分流别接反、浮层别把当前会话列进去、z-index 别把菜单压在浮层下面」 */
const fwdBlock = (() => {
  const i = html.indexOf('id="xfer-fwd-pick"');
  return i < 0 ? "" : html.slice(i, i + 400);
})();
check(
  "转发浮层的 DOM 与接线都在：菜单项 id、浮层三个 id、el() 引用、显隐判据（撤过的不给；有正文或有本机路径才给）、点项先于路径闸门分流",
  fwdBlock.length > 0 &&
    html.includes('id="cb-forward"') &&
    ["xfer-fwd-pick", "xfer-fwd-list", "xfer-fwd-cancel"].every((id) => html.includes(`id="${id}"`)) &&
    ["xfer-fwd-pick", "xfer-fwd-list", "xfer-fwd-cancel"].every((id) => xferJs.includes(`el("${id}")`)) &&
    /show\(ui\.msgForward, !t\.m\.recalled && \(\(t\.isText && !!\(t\.m\.text \|\| ""\)\.trim\(\)\) \|\| t\.hasFile\)\)/.test(xferJs) &&
    /if \(act === "forward"\) \{\s*openFwdPick\(t\);\s*return;/.test(xferJs)
);
check(
  "分流不接反、零新后端命令：有路径的文件走 send_paths（paths 就是本机那一份），其余走 send_text 且不把原 quote 带上（转发是全新 id 的新消息）",
  /if \(t\.hasFile && t\.path\) \s*\{[\s\S]{0,120}?invoke\("send_paths", \{ paths: \[t\.path\], to: s\.id \}\);/.test(xferJs) &&
    /invoke\("send_text", \{ text: String\(t\.m\.text \|\| ""\), to: s\.id \}\)/.test(xferJs)
);
check(
  "浮层列的是别的会话：排除这一条所在的那个框（转发给自己没有意义），别的新后端命令都不调",
  /for \(const s of state\.sessionList\) \{\s*if \(s\.id === state\.cur\) continue;/.test(xferJs)
);
check(
  "浮层夹层：z-index 940 在 lightbox 900 与 ctx-menu 950 之间（菜单压不过浮层、浮层盖得过放大层），hidden 属性得配 display:none（fixed 块不吃默认 [hidden]）；点外面与 Esc 都收得掉",
  /\.fwd-pick \{[\s\S]{0,400}?z-index: 940;/.test(css) &&
    /\.fwd-pick\[hidden\] \{[^}]*display: none;/.test(css) &&
    /ui\.fwdPick && !ui\.fwdPick\.hidden && !\(t && ui\.fwdPick\.contains && ui\.fwdPick\.contains\(t\)\)/.test(xferJs) &&
    /if \(ui\.fwdCancel\) ui\.fwdCancel\.addEventListener\("click", closeFwdPick\)/.test(xferJs)
);

/* 清空聊天记录的静态合约：前端一次调用、后端一次整体重写 —— 最容易坏的是
   「少注册命令」（invoke 直接 command not found）与「把保框删成删框」 */
const chatMenuHtml = (() => {
  const i = html.indexOf('id="chat-menu"');
  return i < 0 ? "" : html.slice(i, i + 500);
})();
check(
  "会话菜单四项都在且全中文：置顶 / 重命名 / 清空 / 删除（清空不能只在前端行为测试里活，HTML 本体坏了菜单直接缺项）",
  ["ctx-chat-pin", "ctx-chat-rename", "ctx-chat-sep", "ctx-chat-clear", "ctx-chat-del"].every(
    (id) => chatMenuHtml.includes(`id="${id}"`)
  ) &&
    ["置顶该聊天", "重命名", "清空聊天记录", "删除聊天"].every((t) => chatMenuHtml.includes(t)),
  chatMenuHtml.slice(0, 60)
);
check(
  "session_clear 三段都在：store 的 clear_session（写 hidden）→ 命令层 → generate_handler 注册（漏注册只会在真运行时炸，node 桩里永远是绿的）",
  /pub fn clear_session\(&self, sid: &str\)/.test(storeRs) &&
    /m\.sid_of\(\) == sid && !m\.hidden/.test(storeRs) &&
    /m\.hidden = true;/.test(storeRs) &&
    /pub fn session_clear\(hub: State<'_, Arc<Hub>>, id: String\)/.test(netMod) &&
    /hub\.store\.clear_session\(&id\)/.test(netMod) &&
    /net::session_clear,/.test(libRs)
);
check(
  "两步确认与「保框」：第一下只臂上不真调；清了只重铺当前流 —— 不能走 removeOne 那条删框的路（streams.delete 会把会话表里的框一起抹掉的错觉就是这么来的），也不调 session_delete",
  /if \(!railMenu\.clearArmed\) \{[\s\S]{0,320}?railClearTimer = setTimeout\([\s\S]{0,240}?\}, 4000\);\s*return;\s*\}/.test(xferJs) &&
    /closeChatMenu\(\);\s*clearSession\(s\);/.test(xferJs) &&
    /async function clearSession\(s\) \{[\s\S]{0,700}?invoke\("session_clear", \{ id: s\.id \}\)/.test(xferJs) &&
    !/function clearSession[\s\S]{0,700}?streams\.delete/.test(xferJs) &&
    !/function clearSession[\s\S]{0,700}?session_delete/.test(xferJs)
);
check(
  "两枚臂互不干涉：删除与清空各自一份 armed，收菜单时一起退回（臂上清空后去点删除不能被误当成第二次确认）",
  /const railMenu = \{ row: null, s: null, armed: false, clearArmed: false \};/.test(xferJs) &&
    /function closeChatMenu\(\) \{[\s\S]{0,300}?railMenu\.armed = false;\s*railMenu\.clearArmed = false;[\s\S]{0,200}?ui\.chatDel\.textContent = "删除聊天";\s*if \(ui\.chatClear\) ui\.chatClear\.textContent = CHAT_CLEAR_LABEL;/.test(xferJs)
);

/* 全局搜索的静态合约：一枚新命令 + 一枚新浮层。最容易坏的恰是两处看不见摸不着的：
   「命令没注册」（node 桩里永远是绿的，真运行时才炸）与「⌘F 又改回抢会话内那条框」
   （两套并存的口径就这么被悄悄合并掉） */
const findHtml = (() => {
  const i = html.indexOf('id="xfer-find"');
  return i < 0 ? "" : html.slice(i, i + 700);
})();
check(
  "浮层的 DOM 与接线都在：顶栏按钮 + 浮层四个 id + 五档 chip，HTML 与 el() 一一对得上（缺 id 就是静悄悄少一个入口）",
  findHtml.length > 0 &&
    ["xfer-find", "xfer-find-x", "xfer-find-q", "xfer-find-chips", "xfer-find-list", "btn-xfer-find"].every(
      (id) => html.includes(`id="${id}"`)
    ) &&
    ["xfer-find", "xfer-find-x", "xfer-find-q", "xfer-find-chips", "xfer-find-list", "btn-xfer-find"].every(
      (id) => xferJs.includes(`el("${id}")`)
    ) &&
    ["全部", "文字", "图片", "文件", "文件夹"].every((t) => findHtml.includes(t)) &&
    ["all", "text", "image", "file", "folder"].every((k) => findHtml.includes(`data-kind="${k}"`)),
  findHtml.slice(0, 40)
);
check(
  "search_messages 三段：命令层走 read_messages 全量（hidden 那道闸门就在出口）→ 反着读一遍后 ts 降序封顶 200 → generate_handler 注册",
  /pub fn search_messages\(hub: State<'_, Arc<Hub>>, query: String, kind: Option<String>\)/.test(netMod) &&
    /hub\.store\.read_messages\(usize::MAX\)\.into_iter\(\)\.rev\(\)/.test(netMod) &&
    /const SEARCH_LIMIT: usize = 200;/.test(netMod) &&
    /hits\.truncate\(SEARCH_LIMIT\)/.test(netMod) &&
    /net::search_messages,/.test(libRs)
);
check(
  "匹配面是三段拼起来的（正文 + 文件名 + 引用摘录）且折小写再比；摘要在折小写的串上定位、回原串取窗（摘录得保留用户原本的大小写）",
  /let raw = format!\(\s*"\{\}\\n\{\}\\n\{\}"/.test(netMod) &&
    /m\.quote\.as_ref\(\)\.map\(\|q\| q\.text\.clone\(\)\)/.test(netMod) &&
    /if !hay\.contains\(&q\) \{\s*continue;/.test(netMod) &&
    /fn search_snippet\(raw: &str, hay: &str, q: &str\) -> String/.test(netMod) &&
    /const SEARCH_WINDOW: usize = 24;/.test(netMod)
);
check(
  "大小写与空词只有 search_rows 那一份口径：折小写与「整串空白 = 什么都没填」都在那一段里，命令层不许再特判一遍（两处各判一次就会改一个漏一个）",
  (() => {
    const 折小写 = netMod.match(/query\.trim\(\)\.to_lowercase\(\)/g) || [];
    return (
      /fn search_rows\([\s\S]{0,200}?query: &str,[\s\S]{0,400}?let q = query\.trim\(\)\.to_lowercase\(\);\s*if q\.is_empty\(\) \{\s*return Vec::new\(\);/.test(netMod) &&
      折小写.length === 1 &&
      /search_rows\(\s*hub\.store\.read_messages\(usize::MAX\)\.into_iter\(\)\.rev\(\),\s*&query,/.test(netMod)
    );
  })(),
  `query.trim().to_lowercase() 共 ${(netMod.match(/query\.trim\(\)\.to_lowercase\(\)/g) || []).length} 处`
);
check(
  "取窗两头都得钳在原串长度内（定位不到时也算了 SEARCH_WINDOW*2：短句会让下面的切片直接 panic）",
  /\(i \+ qs\.len\(\) \+ SEARCH_WINDOW\)\.min\(cs\.len\(\)\)/.test(netMod) &&
    /None => \(0, \(SEARCH_WINDOW \* 2\)\.min\(cs\.len\(\)\)\),/.test(netMod)
);
check(
  "⌘F 改道开浮层：会话内那条框不再被抢（两套并存、语义不变），顶栏按钮与⌘F 开同一扇门，点外面也收",
  /=== "f"\) \{\s*ev\.preventDefault\(\);\s*openFind\(\);/.test(xferJs) &&
    !/ui\.search\.focus\(\)/.test(xferJs) &&
    /if \(ui\.findBtn\) ui\.findBtn\.addEventListener\("click", openFind\)/.test(xferJs) &&
    /ui\.findPick && !ui\.findPick\.hidden && !\(t && ui\.findPick\.contains && ui\.findPick\.contains\(t\)\)/.test(xferJs) &&
    html.includes("⌘F 搜全部会话")
);
check(
  "浮层夹层：z-index 960 得高于 ctx-menu 950（搜索层要盖过气泡菜单），fixed 块得显式 display:none；结果行四段样式都在",
  /\.find-pick \{[\s\S]{0,400}?z-index: 960;/.test(css) &&
    /\.ctx-menu \{[\s\S]{0,300}?z-index: 950;/.test(css) &&
    /\.find-pick\[hidden\] \{[^}]*display: none;/.test(css) &&
    [".find-row {", ".find-sess {", ".find-time {", ".find-snip {", ".find-empty {"].every((s) => css.includes(s))
);
check(
  "逐字符轻防抖 250ms 只挂在 input 上、Enter 不等；重画前改了词的那一份得丢弃；旧词还在就重新给结果",
  /findTimer = setTimeout\(runFind, 250\)/.test(xferJs) &&
    /ev\.key === "Enter"\) \{\s*clearTimeout\(findTimer\);\s*runFind\(\);/.test(xferJs) &&
    /if \(String\(ui\.findQ\?\.value \|\| ""\)\.trim\(\) !== q\) return;/.test(xferJs) &&
    /if \(ui\.findQ\.value\) runFind\(\);/.test(xferJs)
);
check(
  "点一条的三步：先收浮层再切会话，没铺出来就逐页补（封顶 60 页沿用拉齐口径），补不到得说人话而不是静悄悄",
  /async function gotoHit\(h\) \{\s*closeFind\(\);/.test(xferJs) &&
    /await openSession\(h\.sid\);/.test(xferJs) &&
    /while \(!s\.bubbles\.has\(h\.id\) && s\.hasMore && guard\+\+ < 60\) await loadOlder\(\);/.test(xferJs) &&
    /toast\("原文还没加载出来"\)/.test(xferJs)
);

/* 存储一节的静态合约：递归走目录树的那几个数字与「删文件」这个入口都新写一份，
   最容易坏的是「只写了命令忘了注册」与「把保留口径改反」（前者报错在后端，后者直接吞文件） */
const storageHtml = (() => {
  const i = html.indexOf('id="storage-rows"');
  return i < 0 ? "" : html.slice(i, i + 700);
})();
check(
  "存储一节的 DOM、接线与样式都在：四行容器 + 刷新/打开收件目录两颗 + 三档下拉与清理那枚（HTML 与 el() 一一对得上）",
  storageHtml.length > 0 &&
    ["storage-rows", "btn-storage-refresh", "btn-storage-reveal", "inp-inbox-clean", "btn-inbox-clean"].every(
      (id) => html.includes(`id="${id}"`)
    ) &&
    ["storage-rows", "btn-storage-refresh", "btn-storage-reveal", "inp-inbox-clean", "btn-inbox-clean"].every(
      (id) => xferJs.includes(`el("${id}")`)
    ) &&
    ['value="3"', 'value="6"', 'value="12"'].every((v) => storageHtml.includes(v)) &&
    /\.storage-rows \{/.test(css) &&
    /\.storage-row \{[\s\S]{0,200}?justify-content: space-between;/.test(css) &&
    /\.storage-row b \{[\s\S]{0,120}?font-variant-numeric: tabular-nums;/.test(css),
  storageHtml.slice(0, 40)
);
check(
  "storage_stats 与 inbox_cleanup 都在三段上：store 算账 → 命令层 → generate_handler 注册（少注册只会在真运行时报 command not found）",
  /pub fn storage_stats\(&self\) -> StorageStats/.test(storeRs) &&
    /pub fn inbox_cleanup\(&self, before_ts: i64\) -> Result<\(u64, u64\), String>/.test(storeRs) &&
    /pub fn storage_stats\(hub: State<'_, Arc<Hub>>\) -> store::StorageStats/.test(netMod) &&
    /pub fn inbox_cleanup\(hub: State<'_, Arc<Hub>>, before_ts: i64\) -> Result<Value, String>/.test(netMod) &&
    /net::storage_stats,/.test(libRs) &&
    /net::inbox_cleanup,/.test(libRs)
);
check(
  "统计一律走 symlink_metadata（logical size）：不跟随符号链接、也不把 iCloud 占位文件唤下来；递归只在一个地方写",
  /fn walk_sizes\(root: &Path\) -> \(u64, u64\)/.test(storeRs) &&
    /fs::symlink_metadata\(&p\)/.test(storeRs) &&
    !/fs::metadata\(&p\)/.test(storeRs)
);
check(
  "清理的保留口径：先看时间闸门、再看有没有被任何还看得见的消息引用；目录那一级靠 dir_has_kept 整层保住（改反就是默默吞掉用户还在用的文件）",
  /let kept: HashSet<PathBuf> = self\s*\.read_messages\(usize::MAX\)/.test(storeRs) &&
    /if mtime >= before_ts \{\s*continue;/.test(storeRs) &&
    /if kept\.contains\(&p\) \|\| \(is_dir && dir_has_kept\(&p, &kept\)\) \{\s*continue;/.test(storeRs) &&
    /fn dir_has_kept\(root: &Path, kept: &HashSet<PathBuf>\) -> bool/.test(storeRs)
);
check(
  "清理那枚沿用两步确认：第一下只臂上文案、四秒自己退回；第二下才读当下那一档换算成时间戳调命令（臂上之后换档位得算新的）",
  /if \(!cleanArmed\) \{[\s\S]{0,200}?cleanTimer = setTimeout\(disarmClean, 4000\);\s*return;\s*\}/.test(xferJs) &&
    /disarmClean\(\);\s*const months = Number\(ui\.inboxCleanSel\?\.value\) \|\| 3;[\s\S]{0,160}?invoke\("inbox_cleanup", \{ beforeTs \}\)/.test(xferJs)
);
check(
  "删完的数字两处都会重画：命令层 emit 一次 storage-changed，前端既听那一句也自己再拉一次（没开抽屉时下次打开得是新数）",
  /hub\.emit\(\s*"storage-changed",/.test(netMod) &&
    /listen\("storage-changed", \(payload\) => \{\s*if \(payload && payload\.stats\) renderStorage\(payload\.stats\);/.test(xferJs) &&
    /const n = Number\(res\?\.deleted_count\) \|\| 0;[\s\S]{0,300}?await refreshStorage\(\);/.test(xferJs)
);
check(
  "那几个数字不进任何轮询：只在「设置」那一页露出、点刷新、清理之后重读（递归走一遍目录树不便宜）",
  applyPageBody.includes("refreshStorage();") &&
    !drawerToggleBody.includes("refreshStorage();") &&
    !/setInterval\([\s\S]{0,120}?refreshStorage/.test(xferJs) &&
    /if \(ui\.btnStorageRefresh\) ui\.btnStorageRefresh\.addEventListener\("click", refreshStorage\)/.test(xferJs)
);

/* ================= 窗口置顶那几处「只在真运行时爆」的合约 ================= */
// 挑这几条的理由：置顶不读盘、不写盘、没任何中间产物，验证不了只能靠合约前移。
const capJson = JSON.parse(
  readFileSync(join(here, "..", "src-tauri", "capabilities", "default.json"), "utf8")
);
const handlerBlock = (libRs.match(/generate_handler!\[([\s\S]*?)\]/) || [, ""])[1];
check(
  "置顶三段都在：命令层 fn set_always_on_top → generate_handler 注册 → 前端 invoke（漏注册只会在真运行时炸「command not found」，桩里全绿）",
  /fn set_always_on_top\(app: tauri::AppHandle, on: bool\)/.test(libRs) &&
    handlerBlock.includes("set_always_on_top,") &&
    cmpJs.includes('invoke("set_always_on_top"')
);
// 前端直调窗 API 与那条 ACL 权限必须同生同死：只有两种合法组合。
// 单判「现在没直调」会把后来改用直调那一步默放，到真机上才看出按钮亮着窗没动。
const jsDirectPin = /setAlwaysOnTop\(/.test(cmpJs);
const aclPin = capJson.permissions.includes("core:window:allow-set-always-on-top");
check(
  "置顶只有两种组合：走自己的命令（不需权限，现状），或前端直调且 capabilities 补上 core:window:allow-set-always-on-top",
  jsDirectPin === aclPin,
  `直调=${jsDirectPin} 权限=${aclPin}`
);
check(
  "置顶按钮 id 全局只出现一次、JS 那头取到了它，而且出厂不带 is-active（HTML 里就亮着 = 一启动就骗人）",
  (html.match(/id="btn-topmost"/g) || []).length === 1 &&
    cmpJs.includes('el("btn-topmost")') &&
    !/id="btn-topmost"[^>]*is-active/.test(html)
);
check(
  "高亮走全站那套 is-active（.btn-toggle.is-active 在 style.css 里），不另发明 is-on",
  /ui\.btnTopmost\?\.classList\.toggle\("is-active", pinned\)/.test(cmpJs) &&
    css.includes(".btn-toggle.is-active")
);
// 存盘与启动应用必须同时存在：只写盘不改窗，就是「磁盘说置顶、窗是普通窗」那套不一致
const persistedPin = /pub (pin|topmost|always_on_top)\s*:\s*bool/.test(storeRs + prefsRs);
const pinCallSites = (libRs.match(/\.set_always_on_top\(/g) || []).length;
check(
  "置顶要么根本不存盘（现状：每次启动普通窗），要么存了就得有两处应用点（命令层 + 启动读盘）",
  !persistedPin || pinCallSites >= 2,
  `存盘=${persistedPin} 应用点=${pinCallSites}`
);

console.log(`\n合计 PASS=${passed} FAIL=${failed}`);
process.exit(failed ? 1 : 0);
