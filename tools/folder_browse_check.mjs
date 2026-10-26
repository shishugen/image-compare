#!/usr/bin/env node
/**
 * 对比视图「浏览整个文件夹 + A/B 严格交替」的纯逻辑自检：拿真实的 js/view-compare.js 源码，
 * 配一套最小 DOM / Tauri 桩跑。
 *
 * 为什么这么测：这一轮的风险全在三条判断上 —— 列表该有谁、下一次浏览该落哪个窗、
 * 小图该解哪几张。三条都不需要真界面，也不需要真磁盘：桩后端逐条对齐 Rust 口径
 * （list_folder_images 只回本层的图片且不递归子目录、2000 条截断，read_image 回
 * {path,name,size,data_url}，排序留给前端的 localeCompare numeric）。
 *
 * 不盖到的：真样式与真布局（侧栏为什么必须是 stage 的兄弟）、真解码（Image 是桩，
 * 所有图都是 600×400）、并发上限 STRIP_INFLIGHT_MAX（要真时序才能验，这里只验
 * 「窗口外不读盘」这条比它更强的口径）。
 *
 * 运行：node tools/folder_browse_check.mjs
 */
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------- DOM 桩 ------------------------------- */
/** 桩里不解析 HTML：innerHTML 只存字符串。用例只依赖 createElement 出来的真节点（行、小图位），
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
    scrollIntoViewCalls: 0,
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
  el.scrollIntoView = () => {
    el.scrollIntoViewCalls++;
  };
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.hasPointerCapture = () => false;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight, width: el.clientWidth, height: el.clientHeight });
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
// index.html 里侧栏与那句提示都是带着 hidden 出厂的，桩得照这个初始态起
byId("filmstrip").hidden = true;
byId("fs-tip").hidden = true;
byId("chk-sync").checked = true; // 同步模式默认开着：新载入的窗沿用参照窗的 scale/x/y，这就是「对齐」

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

/** 可控的 IntersectionObserver：记下 root 与 observe 过的行，用例自己 fire */
const ioInstances = [];
globalThis.IntersectionObserver = class {
  constructor(cb, opts) {
    this.cb = cb;
    this.opts = opts || {};
    this.targets = [];
    ioInstances.push(this);
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
  fire(entries) {
    this.cb(entries, this);
  }
};

/* ------------------------ 桩后端（逐条对齐 Rust） ------------------------ */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg", "tif", "tiff"]; // 与 lib.rs 的 IMAGE_EXTS 同一份
const FOLDER_MAX_ITEMS = 2000; // 与 lib.rs 的 FOLDER_MAX_ITEMS 同一口径
const STRIP_NAME_MAX = 16; // 与 view-compare.js 的 STRIP_NAME_MAX 同一份

const ALPHA = "/tmp/shot/ALPHA";
const BETA = "/tmp/shot/BETA";
const GAMMA = "/tmp/shot/GAMMA";
const LONG = "/tmp/shot/LONG";
const HUGE = "/tmp/shot/HUGE";
const img = (name, size) => ({ name, size });
const sub = (name, kids) => ({ name, dir: true, kids });

/* 侧栏那个顺序就是 localeCompare("zh-Hans-CN", {numeric:true, sensitivity:"base"}) 的实测结果：
   big.png 排在 IMG_* 前（字母 b < i），但 IMG_2 在 IMG_10 前、IMG_10 在 IMG_100 前（自然序）。
   下面的用例按下标写，改名字就要重跑一遍排序 */
// [0]big.png(过大) [1]IMG_2 [2]IMG_10 [3]IMG_100 [4]scan.tif
// GAMMA: [0]g1 [1]g2 [2]g3_big(过大) [3]g4 [4]g5 [5]gone
const world = {
  fs: {
    [ALPHA]: {
      entries: [
        img("IMG_2.png", 1024),
        img("IMG_10.png", 2048),
        img("IMG_100.png", 4096),
        img("big.png", 5 * 1024 * 1024), // 过 4MB 闸门，不自动解小图
        img("scan.tif", 800), // tif 三份表都要认：侧栏列得出来、read_image 也认
        img("notes.txt", 100), // 非图片
        sub("raw", [img("IMG_1.png", 512)]), // 子目录：能读但绝不能进列表
      ],
    },
    [BETA]: { entries: [img("beta_1.png", 700), img("beta_10.png", 900), img("beta_2.png", 800)] },
    [GAMMA]: {
      entries: [
        img("g1.png", 1000),
        img("g2.png", 2000),
        img("g3_big.png", 6 * 1024 * 1024), // 卡在正中间，左右邻居都是小图
        img("g4.png", 3000),
        img("g5.png", 4000),
        img("gone.png", 500), // 会被标成「被移走」，验读失败那条
      ],
    },
    // 只有当前这一张的目录
    ["/tmp/shot/ONLY"]: { entries: [img("only.png", 300)] },
    // 真实世界里的长名样本（用户截图上那几条）：区分点全在尾部
    [LONG]: {
      entries: [
        img("Generate_Amazon_background_image_2K_20261025150443.jpg", 2_900_000),
        img("image.png_2K_20261025174057.jpg", 2_300_000),
        img("WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg", 36_000),
        img("WeChat7ba95aa572f04b68197747eaee78a9ba.jpg", 289_000),
        img("f6fd84b2-b8c0-418e-ab62-441064623d64.jpeg", 121_000),
        img("IMG_2.png", 1024), // 短名：不该被动
      ],
    },
    [HUGE]: { entries: Array.from({ length: 2001 }, (_, i) => img(`p${i}.png`, 100)) },
  },
  missing: new Set(), // 被移走/改名的文件：read_image 要报错
  leakBad: false, // 桩故意漏一条非图片进来，验前端那份 IMAGE_EXT 兜得住
  pick: [], // pick_images 的应答
  reads: new Map(), // path -> 读了几回
};

const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};
const isImageExt = (name) => IMAGE_EXTS.includes(extOf(name));

/** 目录里所有真存在的文件（含子目录），用来判「能不能读」，与能不能进列表是两回事 */
function knownFiles(dir) {
  const node = world.fs[dir];
  if (!node) return new Set();
  const out = new Set();
  const walk = (entries) => {
    for (const e of entries) {
      if (e.dir) walk(e.kids || []);
      else out.add(`${dir}/${e.name}`);
    }
  };
  for (const e of node.entries) {
    if (e.dir) for (const k of e.kids || []) out.add(`${dir}/${e.name}/${k.name}`);
    else out.add(`${dir}/${e.name}`);
  }
  return out;
}
function statOf(path) {
  for (const [dir, node] of Object.entries(world.fs)) {
    if (!path.startsWith(dir + "/")) continue;
    const rel = path.slice(dir.length + 1).split("/");
    let entries = node.entries;
    let name = rel[rel.length - 1];
    for (let i = 0; i < rel.length - 1; i++) {
      const hit = entries.find((e) => e.dir && e.name === rel[i]);
      if (!hit) return null;
      entries = hit.kids || [];
    }
    const e = entries.find((x) => !x.dir && x.name === name);
    return e ? { size: e.size, name } : null;
  }
  return null;
}

/** 与 Rust 的 folder_images 同口径：取 parent、只收本层普通文件、只认图片扩展名、封顶 2000、不排序 */
function listFolder(path) {
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  const node = world.fs[dir];
  if (!node) throw new Error(`读目录失败（${dir}）: No such file or directory`);
  const items = [];
  let truncated = false;
  for (const e of node.entries) {
    if (e.dir) continue; // 不递归子目录
    if (!isImageExt(e.name) && !(world.leakBad && e.name === "notes.txt")) continue;
    if (items.length >= FOLDER_MAX_ITEMS) {
      truncated = true;
      break;
    }
    items.push({ path: `${dir}/${e.name}`, name: e.name, size: e.size });
  }
  return { dir, items, truncated };
}

const enc = (p) => "data:image/png;base64," + Buffer.from(p).toString("base64");

const calls = [];
async function invokeStub(cmd, args) {
  calls.push([cmd, args || {}]);
  switch (cmd) {
    case "pick_images":
      // 真 dialog 只把图片过滤后的路径交给前端
      return world.pick.filter((p) => isImageExt(p.split("/").pop()));
    case "list_folder_images":
      return listFolder(args.path);
    case "read_image": {
      const st = statOf(args.path);
      if (!st || world.missing.has(args.path)) {
        throw new Error(`读文件失败（${args.path}）: No such file or directory`);
      }
      world.reads.set(args.path, (world.reads.get(args.path) || 0) + 1);
      return { path: args.path, name: st.name, size: st.size, data_url: enc(args.path) };
    }
    case "take_pending_paths":
      return [];
    default:
      return null;
  }
}

const tauriEvents = [];
window.__TAURI__ = {
  core: { invoke: invokeStub },
  event: {
    listen: (name, handler) => {
      tauriEvents.push([name, handler]);
      return Promise.resolve(() => {});
    },
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
const tmp = join(os.tmpdir(), `folder-browse-check-${crypto.randomBytes(6).toString("hex")}`);
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
for (const f of ["api.js", "view-compare.js"]) copyFileSync(join(here, "..", "js", f), join(tmp, f));
await import(join(tmp, "view-compare.js"));

/* ------------------------------- 小工具 ------------------------------- */
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) await flush();
}
const strip = () => byId("filmstrip");
const stripList = () => byId("fs-list");
const rows = () => stripList().children.filter((c) => c.classSet.has("fs-row"));
const rowPaths = () => rows().map((r) => r.dataset.path);
const rowNames = () => rowPaths().map((p) => p.split("/").pop());
/** 行上真正显示出来的那段文字（.fs-name），与 rowNames()（完整名）是一对 */
const rowShown = () => rows().map((r) => r.children.find((c) => c.classSet.has("fs-main"))?.children.find((c) => c.classSet.has("fs-name"))?.text ?? "");
const currentIndex = () => rows().findIndex((r) => r.classSet.has("is-current"));
const selIndex = () => rows().findIndex((r) => r.classSet.has("is-sel"));
const badIndex = () => rows().findIndex((r) => r.classSet.has("is-bad"));
const thumbOf = (i) => {
  const r = rows()[i];
  return r ? r.querySelector(".fs-thumb") : null;
};
const hasThumb = (i) => !!thumbOf(i)?.querySelector("img");
const pendingOf = (i) => {
  const t = thumbOf(i);
  const s = t && t.children.find((c) => c.classSet.has("fs-thumb-pending"));
  return s ? s.text : "";
};
/** 窗里现在挂的是哪个路径：src 里那个 base64 就是桩写进去的路径 */
const srcOf = (k) => {
  const raw = byId("pane-" + k).querySelector(".canvas").src || "";
  if (!raw.startsWith("data:")) return "";
  return Buffer.from(raw.split(",")[1], "base64").toString("utf8");
};
const shot = () => ({ a: srcOf("a"), b: srcOf("b"), c: srcOf("c"), d: srcOf("d") });
const transformOf = (k) => byId("pane-" + k).querySelector(".layer").style.transform || "";
/** 这一次浏览写进了哪个窗（只有一个 src 变了） */
function changedPanes(before) {
  const now = shot();
  return ["a", "b", "c", "d"].filter((k) => now[k] !== before[k]);
}
const statusText = () => byId("st-msg").text;
function click(node) {
  node.dispatchEvent({ type: "click", target: node, preventDefault() {}, stopPropagation() {} });
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
/** 走 ⌘O 这条路：Rust 弹面板回路径 → fillPanes（不指定目标窗就是空窗优先） */
async function openViaCmdO(paths) {
  world.pick = paths;
  key("o", { meta: true });
  await settle();
}
/** 走文件选择兜底那条路（浏览器环境下 File 没有本机路径） */
async function pickFiles(files) {
  byId("file-picker").files = files;
  byId("file-picker").dispatchEvent({ type: "change", target: byId("file-picker") });
  await settle();
}
/**
 * 走「单击那个空窗」这条路：「打开 A/B/C/D」四个入口已拆，指定落窗现在只能这么进 ——
 * 桩后端不回剪贴板内容（paste_paths 走 default 回 null），所以单击会退到文件选择框，
 * 落点就是点的那一格（openImages(pane.key)）。
 */
async function clickEmptyPane(paneKey) {
  const vp = byId("pane-" + paneKey).querySelector(".viewport");
  vp.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 1, clientX: 20, clientY: 20 });
  vp.dispatchEvent({ type: "click", clientX: 20, clientY: 20, target: vp, preventDefault() {}, stopPropagation() {} });
  vp.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 20, clientY: 20 });
  await settle();
}
const mark = () => calls.length;

let failed = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}

await settle();

/* ===================== 1) 没有本机路径的来源不该建列表 ===================== */
let since = mark();
await pickFiles([{ name: "截图.png", size: 0 }]);
check(
  "0 字节的 File 报体积错而不是解码失败",
  statusText().startsWith("载入失败") && statusText().includes("0 字节"),
  statusText()
);
check("这种来源不会去列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 0);
check("侧栏还藏着", strip().hidden === true);

await pickFiles([{ name: "剪贴板图.png", size: 2048 }]);
check("有体积的 File 能进空着的 A 窗", srcOf("a") === "剪贴板图.png", srcOf("a"));
check(
  "File 来源没有本机路径：侧栏藏起来并说明原因",
  strip().hidden === true && byId("fs-tip").text === "这个来源没有本机路径，列不出文件夹",
  byId("fs-tip").text
);
check("没有列表时「浏览列表」按钮禁用", byId("btn-strip").disabled === true);
check("这种来源一路都没去列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 0);

/* ===================== 2) 载入一张本地图就列出它所在目录 ===================== */
click(byId("btn-clear")); // 把 File 那张清掉，后面都从两个空窗开始
await settle();
since = mark();
await openViaCmdO([`${ALPHA}/IMG_10.png`]);
const alphaList = [
  `${ALPHA}/big.png`,
  `${ALPHA}/IMG_2.png`,
  `${ALPHA}/IMG_10.png`,
  `${ALPHA}/IMG_100.png`,
  `${ALPHA}/scan.tif`,
];
check("列目录用的参数就是这张图的路径", calls.slice(since).some(([c, a]) => c === "list_folder_images" && a.path === `${ALPHA}/IMG_10.png`));
check("列表只含本层的图片", rowPaths().join(",") === alphaList.join(","), rowNames().join(","));
check("非图片与子目录都不在列表里", !rowPaths().some((p) => p.includes("notes.txt") || p.includes("raw/")));
check("自然序：IMG_2 排在 IMG_10 前、IMG_10 排在 IMG_100 前", rowNames().indexOf("IMG_2.png") < rowNames().indexOf("IMG_10.png") && rowNames().indexOf("IMG_10.png") < rowNames().indexOf("IMG_100.png"));
check("tif 也认（三份表必须一致）", rowNames().includes("scan.tif"));
check("有列表就自动露出来", strip().hidden === false);
check("头部写着目录名与张数", byId("fs-dir").text === "ALPHA" && byId("fs-count").text === "5 张", `${byId("fs-dir").text}/${byId("fs-count").text}`);
check("按钮解除禁用并高亮", byId("btn-strip").disabled === false && byId("btn-strip").classSet.has("is-active"));
check("当前项高亮在 IMG_10 那行", rowNames()[currentIndex()] === "IMG_10.png", String(currentIndex()));
check("列表建起来时把当前项滚进可见", rows()[currentIndex()].scrollIntoViewCalls > 0);

since = mark();
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
check("同目录再载入一张不重发 IPC", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 0);
check("同目录载入会把当前项对齐", rowNames()[currentIndex()] === "IMG_2.png", rowNames()[currentIndex()]);
check("B 窗接住了这张（A 已有图，空窗优先）", srcOf("b") === `${ALPHA}/IMG_2.png`, srcOf("b"));

/* ===================== 3) 落窗严格交替，另一个窗留着对照 ===================== */
click(byId("btn-clear"));
await settle();
check("清空只清高亮、列表保留", rows().length === 5 && currentIndex() === -1, String(currentIndex()));
world.pick = [`${ALPHA}/IMG_10.png`];
await clickEmptyPane("a"); // 单击空窗这条路：指定的落窗就是 A
check("手动「单击 A 空窗」落在 A 窗而不是被顶掉", srcOf("a") === `${ALPHA}/IMG_10.png` && srcOf("b") === "", srcOf("a"));
const slots = [];
for (const i of [0, 1, 2, 3]) {
  const before = shot();
  click(rows()[i]);
  await settle();
  slots.push(changedPanes(before).join(""));
}
check("连点四项走出 b→a→b→a：第一次浏览落 B，不顶掉刚打开那张", slots.join(",") === "b,a,b,a", slots.join(","));
check("另一窗始终留着上一张", srcOf("a") === `${ALPHA}/IMG_100.png` && srcOf("b") === `${ALPHA}/IMG_10.png`, `${srcOf("a")} | ${srcOf("b")}`);
check("状态栏说明落在哪个窗", /第 \d\/5 张→[AB] 窗，[AB] 窗留着上一张/.test(statusText()), statusText());
check(
  "同步模式下前后两张停在同一区域",
  transformOf("a") === transformOf("b") && transformOf("a") !== "",
  `${transformOf("a")} vs ${transformOf("b")}`
);

/* ===================== 4) 四图布局：浏览只动 A/B，C/D 不参与 ===================== */
key("4");
await settle();
check("切到四图后 C/D 是空的", srcOf("c") === "" && srcOf("d") === "" && byId("st-info-c").text.includes("未载入"));
const beforeGrid = shot();
key("]");
await settle();
check("四图布局下浏览仍然只写 A/B 之一", changedPanes(beforeGrid).length === 1 && changedPanes(beforeGrid).every((k) => k === "a" || k === "b"), changedPanes(beforeGrid).join(","));
check("C/D 的图没被浏览动过", srcOf("c") === "" && srcOf("d") === "");
key("2");
await settle();

/* ===================== 5) [ ] 与 ⌘←/⌘→ 等价，到首尾不循环 ===================== */
click(byId("btn-clear"));
await settle();
await openViaCmdO([`${ALPHA}/IMG_10.png`]); // 清空后从 A 起
check("清空后重新打开落在 A", srcOf("a") === `${ALPHA}/IMG_10.png` && srcOf("b") === "");
key("]");
await settle();
const at = currentIndex();
check("] 翻到下一张并落进对面窗", at === rowNames().indexOf("IMG_100.png") && srcOf("b") === `${ALPHA}/IMG_100.png`, `${at}/${srcOf("b")}`);
check("[ 也被吃掉", key("[").prevented === true);
await settle();
check("[ 翻回上一张", currentIndex() === at - 1 && srcOf("a") === `${ALPHA}/IMG_10.png`, String(currentIndex()));
check("⌘→ 也被吃掉", key("ArrowRight", { meta: true }).prevented === true);
await settle();
check("⌘→ 与 ] 等价", currentIndex() === at, String(currentIndex()));
check("⌘← 也被吃掉", key("ArrowLeft", { meta: true }).prevented === true);
await settle();
check("⌘← 与 [ 等价", currentIndex() === at - 1, String(currentIndex()));

for (let i = 0; i < 6; i++) {
  key("[");
  await settle();
}
check("顶到第一张后 [ 不循环", currentIndex() === 0, String(currentIndex()));
check("顶到第一张时有明确提示", statusText().includes("已经是第一张"), statusText());
const frozen = shot();
const readsBefore = [...world.reads.values()].reduce((a, b) => a + b, 0);
key("[");
await settle();
check("越界那一趟没动任何窗", shot().a === frozen.a && shot().b === frozen.b);
check("越界那一趟也没多读一张盘", [...world.reads.values()].reduce((a, b) => a + b, 0) === readsBefore, `${readsBefore} -> ${[...world.reads.values()].reduce((a, b) => a + b, 0)}`);
for (let i = 0; i < 6; i++) {
  key("]");
  await settle();
}
check("顶到最后一张后 ] 不循环", currentIndex() === rows().length - 1, String(currentIndex()));
check("顶到最后一张时有明确提示", statusText().includes("已经是最后一张"), statusText());

/* ===================== 6) 方向键继续只做平移 ===================== */
strip().dispatchEvent({ type: "blur" });
await settle();
const panBefore = [transformOf("a"), transformOf("b")];
const idxBefore = currentIndex();
key("ArrowRight");
await settle();
check("→ 平移了画面", transformOf("a") !== panBefore[0] || transformOf("b") !== panBefore[1], `${panBefore[0]} → ${transformOf("a")}`);
check("→ 没有去浏览", currentIndex() === idxBefore, `${currentIndex()} vs ${idxBefore}`);

/* ===================== 7) 侧栏聚焦时 ↑↓/Home/End：选中那一行就把那一张显示出来 ===================== */
const readCount = () => [...world.reads.values()].reduce((a, b) => a + b, 0);
strip().dispatchEvent({ type: "focus" });
await settle();
check("拿到焦点就把选中行对齐到当前项", selIndex() === currentIndex(), `${selIndex()} vs ${currentIndex()}`);
const idx7 = currentIndex(); // 顶在最后一张（scan.tif）
const beforeUp = shot();
const readsUp = readCount();
key("ArrowUp");
await settle();
const hitUp = changedPanes(beforeUp);
check(
  "↑ 把选中行移上去的同时就把那一张显示出来",
  // 落窗是 A/B 交替的，那张可能已经在对面窗里（于是 src 根本没变），
  // 所以要看的是「正在看的那一行确实有个窗里放着它」
  hitUp.length <= 1 && (srcOf("a") === rowPaths()[3] || srcOf("b") === rowPaths()[3]),
  `${hitUp.join(",")} idx=${currentIndex()}`
);
check("↑ 之后选中行与正在看的那行一致", selIndex() === currentIndex() && currentIndex() === idx7 - 1, `${selIndex()}/${currentIndex()}`);
check("↑ 这一次只多读一张盘", readCount() === readsUp + 1, `${readsUp} -> ${readCount()}`);
key("ArrowDown");
await settle();
check(
  "↓ 退回去也照样跟着显示（退到那张已经显示在另一个窗上，所以不重读）",
  selIndex() === idx7 && currentIndex() === idx7 && srcOf("a") === beforeUp.a && srcOf("b") === beforeUp.b,
  `${selIndex()}/${currentIndex()}`
);
key("Home");
await settle();
check(
  "Home 直接到第一行并把那张显示出来",
  selIndex() === 0 && currentIndex() === 0 && rowPaths()[0] === `${ALPHA}/big.png`,
  String(currentIndex())
);
key("End");
await settle();
check("End 直接到最后一行并把那张显示出来", selIndex() === rows().length - 1 && currentIndex() === rows().length - 1, String(currentIndex()));

/* 顶到头再按：只说一声，不能重读盘也不能把同一张塞进对面窗 */
const frozenEnd = shot();
const readsEnd = readCount();
key("ArrowDown");
await settle();
check(
  "顶到最后一行再按 ↓ 只提示、不动任何窗",
  shot().a === frozenEnd.a && shot().b === frozenEnd.b && statusText().includes("已经是列表最后一张"),
  statusText()
);
key("End");
await settle();
key("Enter"); // 已经在看这一行：Enter 留着当显式确认，走 browseTo 的短路
await settle();
check(
  "到头再按 / End / Enter 都不多读一张盘",
  readCount() === readsEnd && selIndex() === rows().length - 1,
  `${readsEnd} -> ${readCount()}`
);
key("ArrowUp");
await settle();
check("↑ 仍然跟着显示", currentIndex() === rows().length - 2 && selIndex() === currentIndex(), String(currentIndex()));
const beforeSpace = shot();
key(" "); // 这一行已经显示着，空格也一样短路
await settle();
check(
  "空格与 Enter 走同一条路（都在显示那一行时什么都不换）",
  shot().a === beforeSpace.a && shot().b === beforeSpace.b,
  `${srcOf("a")} | ${srcOf("b")}`
);

/* 连按：上一张还没读完就再按一次 —— 只追最后想要的那一张，中间不停下来看 */
const beforeHold = shot();
const readsHold = readCount();
key("ArrowUp");
key("ArrowUp"); // 第一次还没读完
await settle(8);
check(
  "连按两次 ↑ 最终停在最后那一次的目标",
  currentIndex() === rows().length - 4 && selIndex() === currentIndex(),
  `${currentIndex()} vs ${rows().length - 4}`
);
check("两次都真读了盘（合并的是显示，不是丢请求）", readCount() === readsHold + 2, `${readsHold} -> ${readCount()}`);
check("连按最终只动了该动的窗", changedPanes(beforeHold).length >= 1, changedPanes(beforeHold).join(","));

/* ===================== 8) 小图的内存闸门：只解当前项 ±1 ===================== */
since = mark();
await openViaCmdO([`${GAMMA}/g3_big.png`]); // 换目录 → 行全部重建，小图从零开始
check("换目录只重发一次列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 1);
check("新目录的行重建了", rowNames().join(",") === "g1.png,g2.png,g3_big.png,g4.png,g5.png,gone.png", rowNames().join(","));
check("当前项 ±1 自动出小图", hasThumb(1) && hasThumb(3), `${hasThumb(1)},${hasThumb(3)}`);
check("窗口外的行不读盘（几百张的目录才敢列）", !hasThumb(0) && !hasThumb(4) && !hasThumb(5) && pendingOf(4) === "");
check("过 4MB 的不自动解，只给「大」字占位", pendingOf(2) === "大" && !hasThumb(2), pendingOf(2));

const rd2 = world.reads.get(`${GAMMA}/g2.png`) || 0;
click(rows()[1]); // 点行：这一张才真读一次 IPC
await settle();
check(
  "点行只多读一回（大图那份顺手给侧栏复用）",
  (world.reads.get(`${GAMMA}/g2.png`) || 0) === rd2 + 1,
  `${rd2} -> ${world.reads.get(`${GAMMA}/g2.png`)}`
);

const io = ioInstances[0];
check("侧栏用了 IntersectionObserver 且 root 就是行容器", !!io && io.opts.root === stripList());
check("观察名单里只有当前这批行（换目录会 disconnect 旧行）", io && io.targets.length === rows().length, `${io ? io.targets.length : -1} vs ${rows().length}`);
io.fire([{ target: rows()[3], isIntersecting: false }]);
check("滚出视口就把位图摘掉", thumbOf(3) && thumbOf(3).children.length === 0);
const rd4 = world.reads.get(`${GAMMA}/g4.png`) || 0;
click(rows()[2]); // 回到中间那张：窗口里的 g4 该从 LRU 里画出来
await settle();
check("摘掉位图再滚回来不重读盘（LRU 命中）", (world.reads.get(`${GAMMA}/g4.png`) || 0) === rd4 && hasThumb(3), `${rd4} -> ${world.reads.get(`${GAMMA}/g4.png`)}`);
io.fire([{ target: rows()[4], isIntersecting: true }]);
await settle();
check("窗口外的行就算滚进视口也不自动解", !hasThumb(4) && pendingOf(4) === "");

/* ===================== 9) 读失败：不动对照位、只把行标灰 ===================== */
const before9 = shot();
const idx9 = currentIndex();
world.missing.add(`${GAMMA}/gone.png`);
click(rows()[5]);
await settle();
check("读失败时状态栏给原因", statusText().startsWith("载入失败"), statusText());
check("读失败不动任何窗（对照位不被悄悄换掉）", shot().a === before9.a && shot().b === before9.b);
check("读失败不推进游标", currentIndex() === idx9, `${currentIndex()} vs ${idx9}`);
check("失败那行标灰", badIndex() === 5, String(badIndex()));
check("失败那行不解小图", !hasThumb(5) && pendingOf(5) === "");
const before9b = shot();
click(rows()[3]);
await settle();
check("失败之后的浏览仍按交替落窗（那次失败没偷走 slot）", changedPanes(before9b).join(",") === "b", changedPanes(before9b).join(","));
world.missing.delete(`${GAMMA}/gone.png`);

/* ===================== 10) 换目录就刷新列表；只有一张也照常列 ===================== */
since = mark();
await openViaCmdO([`${BETA}/beta_10.png`]);
check("换目录会重发一次列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 1);
check("列表换成那个目录的图并按自然序排", rowNames().join(",") === "beta_1.png,beta_2.png,beta_10.png", rowNames().join(","));
check("头部目录名跟着换", byId("fs-dir").text === "BETA" && byId("fs-dir").title === BETA);
check("旧目录的小图不留在行上", rows().every((r) => !r.querySelector(".fs-thumb img")));
check("换了目录就把上一次的失败记录清空", badIndex() === -1, String(badIndex()));
click(rows()[0]);
await settle();
check("点新目录里的行照样走交替（beta_10 还在 A）", currentIndex() === 0 && srcOf("b") === `${BETA}/beta_1.png` && srcOf("a") === `${BETA}/beta_10.png`, `${currentIndex()}/${srcOf("b")}`);

await openViaCmdO(["/tmp/shot/ONLY/only.png"]);
check("目录里就这一张也照常列出", rows().length === 1 && rowNames().join(",") === "only.png", String(rows().length));
check("只有一张时 ] 不越界", key("]").prevented === true);
await settle();
check("游标停在第一张、也就是最后一张", currentIndex() === 0 && statusText().includes("已经是最后一张"), statusText());

/* ===================== 11) 后端截断要说明一声，前端那份筛图是兜底 ===================== */
await openViaCmdO([`${HUGE}/p0.png`]);
check("目录过大只列 2000 张", rows().length === FOLDER_MAX_ITEMS, String(rows().length));
check("截断时在列表底部说明一声", stripList().children.some((c) => c.classSet.has("fs-tip") && c.text.includes(`目录过大，只列出前 ${FOLDER_MAX_ITEMS} 张`)));

world.leakBad = true;
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
check("后端漏进来的非图片会被前端再筛一道", !rowNames().includes("notes.txt"), rowNames().join(","));
world.leakBad = false;

/* ===================== 12) ⌘⇧B 与「×」：用户收过就不再自动弹 ===================== */
strip().dispatchEvent({ type: "blur" });
await openViaCmdO([`${HUGE}/p5.png`]);
check("有列表时默认是露出来的", strip().hidden === false);
const evB = key("b", { meta: true });
check("单纯的 ⌘B 不抢（留给系统）", evB.prevented === false && strip().hidden === false);
key("B", { meta: true, shift: true });
await settle();
check("⌘⇧B 收起侧栏", strip().hidden === true);
key("B", { meta: true, shift: true });
check("⌘⇧B 再按展开", strip().hidden === false);
click(byId("btn-strip-close"));
check("「×」也能收", strip().hidden === true);
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
check("用户自己收过就不再自动弹出来抢地方", strip().hidden === true);
click(byId("btn-strip"));
check("按钮能把侧栏开回来", strip().hidden === false);

const escOpen = strip().hidden;
key("Escape");
await settle();
check("焦点不在侧栏时 Esc 不收侧栏（放大层优先）", strip().hidden === escOpen);
strip().dispatchEvent({ type: "focus" });
key("Escape");
check("焦点在侧栏时 Esc 收侧栏", strip().hidden === true);

/* ===================== 13) 长名字从中间裁：保住开头、尾部与扩展名 ===================== */
await openViaCmdO([`${LONG}/WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg`]);
const shownOf = (name) => rowShown()[rowNames().indexOf(name)];
check("短名一字不动", shownOf("IMG_2.png") === "IMG_2.png", shownOf("IMG_2.png"));
check(
  "行上显示的名字都不超过上限",
  rowShown().every((t) => t.length <= STRIP_NAME_MAX),
  rowShown().map((t) => t.length).join(",")
);
check(
  "那五条长名全部裁了（带省略号），只有短的那条没动",
  rowShown().filter((t) => t.includes("…")).length === 5 && !shownOf("IMG_2.png").includes("…")
);
check(
  "裁完的具体样子（中间一个省略号，开头与扩展名都在）",
  shownOf("Generate_Amazon_background_image_2K_20261025150443.jpg") === "Genera…50443.jpg" &&
    shownOf("f6fd84b2-b8c0-418e-ab62-441064623d64.jpeg") === "f6fd8…23d64.jpeg",
  `${shownOf("Generate_Amazon_background_image_2K_20261025150443.jpg")} / ${shownOf("f6fd84b2-b8c0-418e-ab62-441064623d64.jpeg")}`
);
check(
  "扩展名没被裁掉（末尾那段还在）",
  ["Generate_Amazon_background_image_2K_20261025150443.jpg", "image.png_2K_20261025174057.jpg", "WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg"].every((n) => shownOf(n).endsWith(".jpg")) &&
    shownOf("f6fd84b2-b8c0-418e-ab62-441064623d64.jpeg").endsWith(".jpeg")
);
check(
  "“image.png_2K_xxx.jpg” 这种点在中段的也能认出末尾扩展名",
  shownOf("image.png_2K_20261025174057.jpg") === "image.…74057.jpg",
  shownOf("image.png_2K_20261025174057.jpg")
);
// 这条改动存在的全部理由：两条微信图开头一样、长度一样，末尾省略号会把它们裁成同一个样子
check(
  "同前缀的两条长名裁完仍不相等（尾部区分点保住了）",
  shownOf("WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg") !== shownOf("WeChat7ba95aa572f04b68197747eaee78a9ba.jpg") &&
    shownOf("WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg").startsWith("WeChat") &&
    shownOf("WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg").includes("85d09"),
  `${shownOf("WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg")} / ${shownOf("WeChat7ba95aa572f04b68197747eaee78a9ba.jpg")}`
);
check(
  "裁的只是显示：title 与 dataset.path 还是完整路径，悬停能看全",
  rows().every((r) => r.title === r.dataset.path) && rowPaths().includes(`${LONG}/WeChat4dfa9b61996222cdb06be62a8a5b85d09.jpg`)
);

/* ===================== 14) ⌘C 复制出去：同一条路径不能出现两次 ===================== */
const lastCopy = () => {
  const hit = [...calls].reverse().find(([c]) => c === "copy_as_file");
  return hit ? hit[1].paths : null;
};
byId("chk-sync").checked = true; // 同步开着：⌘C 的口径是「所有已载入的可见窗」
click(byId("btn-clear"));
await settle();
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
await openViaCmdO([`${ALPHA}/IMG_2.png`]); // 同一张再载入一次，落到空着的 B 窗
check(
  "同一张确实能同时摆在两个窗里（下面两条用例的前提）",
  srcOf("a") === `${ALPHA}/IMG_2.png` && srcOf("b") === `${ALPHA}/IMG_2.png`,
  `${srcOf("a")} / ${srcOf("b")}`
);
key("c", { meta: true });
await settle();
check(
  "两个窗是同一张时只复制一条路径（不重复就会粘出两张一样的图）",
  JSON.stringify(lastCopy()) === JSON.stringify([`${ALPHA}/IMG_2.png`]),
  JSON.stringify(lastCopy())
);
click(byId("btn-clear"));
await settle();
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
await openViaCmdO([`${ALPHA}/IMG_10.png`]);
key("c", { meta: true });
await settle();
check(
  "两张不同的图时照旧把两个窗都带上（去重不能把不同的也去掉）",
  JSON.stringify(lastCopy()) === JSON.stringify([`${ALPHA}/IMG_2.png`, `${ALPHA}/IMG_10.png`]),
  JSON.stringify(lastCopy())
);
byId("chk-sync").checked = false;
key("c", { meta: true });
await settle();
check("关掉同步就只带活动窗那一张", lastCopy()?.length === 1, JSON.stringify(lastCopy()));

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
