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
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
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
const calls = { get: 0, set: 0 };

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

async function invokeStub(cmd, args) {
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
for (const f of ["api.js", "view-compare.js"]) copyFileSync(join(here, "..", "js", f), join(tmp, f));
await import(join(tmp, "view-compare.js"));

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
check("载入本地图后侧栏自动列出这个目录", rows().length === 3 && byId("filmstrip").hidden === false, `行数=${rows().length}`);
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

/* ===================== 9) CSS / HTML 合约：三态显隐写得对不对 ===================== */
const css = readFileSync(join(here, "..", "js", "style.css"), "utf8");
const html = readFileSync(join(here, "..", "js", "index.html"), "utf8");
check("两个准入类默认都不显示", /\.only-grid,\s*\.only-multi \{\s*display: none;/.test(css));
check("stage 里 B 窗只在两图出现", css.includes("body.layout-2 .stage .only-multi") && !css.includes("body.layout-1 .stage .only-multi"));
check("stage 里 C/D 只在四图出现", css.includes("body.layout-4 .stage .only-grid") && !css.includes("body.layout-2 .stage .only-grid"));
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
check("HTML 里 B 窗只随两图出现", html.includes('class="pane only-multi" id="pane-b"'));
check("HTML 里 C/D 的窗都带 only-grid", html.includes('class="pane only-grid" id="pane-c"') && html.includes('class="pane only-grid" id="pane-d"'));
check("body 出厂就带 layout-2，首帧不会闪一下", html.includes('<body data-view="compare" class="layout-2">'));
check("抽屉里三个控件的 id 与 JS 读的一致", ["sel-set-layout", "chk-set-sync", "sel-set-wheel"].every((id) => html.includes(`id="${id}"`)));
check("设置入口与抽屉本体都在", html.includes('id="btn-cmp-settings"') && html.includes('class="drawer" id="cmp-settings"'));
check("抽屉住在 relative 宿主里（.cmp-body，同传输视图的 .panel-body）", /\.cmp-body \{[^}]*position: relative;/.test(css));
check("抽屉有 Esc/收起之外的关闭入口", html.includes('data-close-drawer="cmp-settings"') && html.includes('id="btn-set-close"'));

/* 传输视图那个配对抽屉也得按这里对：session_route_check 的 DOM 桩会按 id 自动造元素，
   HTML 里拆了这两个控件那边照样全绿 —— 这类「拆了 DOM 没拆 JS 引用」只能靠静态合约兜 */
const xferJs = readFileSync(join(here, "..", "js", "view-transfer.js"), "utf8");
check(
  "配对设置抽屉里有备注名那一栏（输入框 + 保存按钮）",
  html.includes('id="inp-peer-alias"') && html.includes('id="btn-peer-alias"')
);
check(
  "JS 读的 id 与 HTML 对得上，且真去调了 set_peer_alias",
  xferJs.includes('el("inp-peer-alias")') && xferJs.includes('el("btn-peer-alias")') && xferJs.includes('invoke("set_peer_alias"')
);
check("解绑的提示说清了不会再自动连回来", html.includes("不会再自动连回来"));

/* -------------------------------------------------------------------------- */
console.log(`\n合计 PASS=${passed} FAIL=${failed}`);
process.exit(failed ? 1 : 0);
