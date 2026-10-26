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
// 拖行时手里那枚牌：index.html 里它带 hidden 出厂，底下是 img + .sg-name 两个孩子
(() => {
  const g = byId("strip-ghost");
  g.hidden = true;
  const img = mkEl("img");
  const name = mkEl("span");
  name.classSet.add("sg-name");
  g.appendChild(img);
  g.appendChild(name);
})();
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
const SPACE = "/tmp/shot/有 空格&符号"; // 验 asset 地址里的路径转义
// DELTA / EPS 是第 16 节专用的「干净目录」：前面任何用例都没碰过它们，LRU 里必然没有这几张。
// 少了这一层，「asset 模式下一次 IPC 也不发」和「退路模式下窗口外不读」都会被缓存命中蒙过去，
// 断言看着绿、其实什么都没验。
const DELTA = "/tmp/shot/DELTA";
const EPS = "/tmp/shot/EPS";
const ZETA = "/tmp/shot/ZETA"; // 第 17 节专用：asset 能转地址但取不到文件
// 只给「一屏十几行全挂上」那条用：12 张、每张都要真读，把并发上限之外的那些逼进队列
const QUEUE = "/tmp/shot/QUEUE";
const img = (name, size) => ({ name, size });
const sub = (name, kids) => ({ name, dir: true, kids });

/* 侧栏那个顺序就是 localeCompare("zh-Hans-CN", {numeric:true, sensitivity:"base"}) 的实测结果：
   big.png 排在 IMG_* 前（字母 b < i），但 IMG_2 在 IMG_10 前、IMG_10 在 IMG_100 前（自然序）。
   下面的用例按下标写，改名字就要重跑一遍排序 */
// [0]big.png(过大) [1]IMG_2 [2]IMG_10 [3]IMG_100 [4]scan.tif
// GAMMA: [0]g1 [1]g2 [2]g3_big(过大) [3]g4 [4]g5 [5]gone
const world = {
  // asset 协议可不可用，用例自己开关：关掉时桩回空串，assetSrc() 就当「转不出地址」退回 read_image
  assetOn: false,
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
    [SPACE]: { entries: [img("第一 张.png", 900), img("second x.jpg", 1200)] },
    // [0]a1 [1]a2 [2]a3_big(6MB) [3]a4 [4]a5 —— 自然序与 GAMMA 那组同形，下标照抄
    [DELTA]: {
      entries: [
        img("a1.png", 1000),
        img("a2.png", 2000),
        img("a3_big.png", 6 * 1024 * 1024),
        img("a4.png", 3000),
        img("a5.png", 4000),
      ],
    },
    // 同上形状，专给退路那两条断言用（这里必须一次缓存都没有）
    [EPS]: {
      entries: [
        img("e1.png", 1000),
        img("e2.png", 2000),
        img("e3_big.png", 6 * 1024 * 1024),
        img("e4.png", 3000),
        img("e5.png", 4000),
      ],
    },
    // [0]z1 [1]z2 [2]z3 [3]z4 [4]z5 —— 全小图，第 17 节拿它们验「asset 取不到文件」的自愈
    [ZETA]: {
      entries: [
        img("z1.png", 1000),
        img("z2.png", 2000),
        img("z3.png", 3000),
        img("z4.png", 4000),
        img("z5.png", 5000),
      ],
    },
    [QUEUE]: {
      entries: Array.from({ length: 12 }, (_, i) => img(`q${i + 1}.png`, 1000 + i)),
    },
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
  history: [], // 桩后端那份查看历史（绝对路径，新的在前）
  historyErr: false, // 打开后 record_view 就报错，验「记录失败不影响载入与浏览」
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

/* --------- 查看历史：桩后端照 Rust 的口径记（去重置顶 + 截断到 100） --------- */
const HISTORY_MAX = 100; // 与 Rust / 前端的 HISTORY_MAX 对齐
/** seen 给成「每隔一分钟看了一张」：这样行上那格相对时间是可断言的（第一条刚刚、第二条 1 分钟前） */
const seenOf = (i) => Date.now() - i * 60_000;
const historyFile = () => ({ items: world.history.map((p, i) => ({ path: p, seen: seenOf(i) })) });
function recordHistory(path) {
  if (!path || !path.startsWith("/")) throw new Error("记录查看失败：不是绝对路径");
  if (world.historyErr) throw new Error("history.json 写入失败（桩）");
  const i = world.history.indexOf(path);
  if (i >= 0) world.history.splice(i, 1);
  world.history.unshift(path);
  world.history.length = Math.min(world.history.length, HISTORY_MAX);
  return historyFile();
}

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
    case "get_history":
      return historyFile();
    case "record_view":
      return recordHistory(args.path);
    case "clear_history":
      if (world.historyErr) throw new Error("history.json 写入失败（桩）");
      world.history.length = 0;
      return null;
    default:
      return null;
  }
}

const tauriEvents = [];
window.__TAURI__ = {
  core: {
    invoke: invokeStub,
    // 真实实现就是拼这个串（mac：asset://localhost/<encodeURIComponent(路径)>），
    // 而且挂在 __TAURI__.core 与 __TAURI_INTERNALS__ 两处，这里只桩前者，
    // assetSrc() 的两处取值都有合约盯着
    convertFileSrc: (p) => (world.assetOn ? `asset://localhost/${encodeURIComponent(p)}` : ""),
  },
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
for (const f of ["api.js", "view-compare.js", "tile.js"]) copyFileSync(join(here, "..", "js", f), join(tmp, f));
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

/* ---------------- 行 → 窗拖拽要用到的三件：真实矩形 + 窗口事件 + 牌 ---------------- */
/** 桩里四个窗的画布矩形全压在原点，命中判定分不出格：这里按布局给它们盖屏幕位置。
 *  只改 getBoundingClientRect，clientWidth/Height 不动（适应档尺寸靠它，别扯到算法上） */
function setPaneRect(k, left, top, w, h) {
  const vp = byId("pane-" + k).querySelector(".viewport");
  vp.getBoundingClientRect = () => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
    width: w,
    height: h,
  });
}
/** 往 window 上派一个鼠标事件（拖拽的三个监听都挂在 window 上） */
function fireWin(type, ev = {}) {
  const e = {
    type,
    clientX: 0,
    clientY: 0,
    button: 0,
    buttons: 1, // 鼠标上移动 = 左键还按着
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {},
    ...ev,
  };
  for (const [t, fn] of winListeners) if (t === type) fn(e);
  return e;
}
/** 在行的第 sx/sy 像素上按下左键 */
function rowDown(row, sx, sy) {
  row.dispatchEvent({ type: "mousedown", button: 0, buttons: 1, clientX: sx, clientY: sy, preventDefault() {} });
}
const ghost = () => byId("strip-ghost");
/** 一次真实的点行：按下 → 不动 → 松手 → click（拖拽之后只有这条路才能再点动，
 *  因为起过拖的那一下会把紧跟着的 click 吐掉） */
function clickRow(i, sx = 30, sy = 30) {
  const r = rows()[i];
  rowDown(r, sx, sy);
  fireWin("mouseup", { clientX: sx, clientY: sy });
  click(r);
}
const ghostImg = () => ghost().querySelector("img");
/** 某行小图真正挂上去的地址（paintThumb 写的是 img.src 属性，不是 setAttribute） */
const thumbSrc = (i) => thumbOf(i)?.querySelector("img")?.src || "";
const thumbImg = (i) => thumbOf(i)?.querySelector("img") || null;
/** 这趟一共走了多少次 read_image（asset 那条路应该是 0） */
const totalReads = () => [...world.reads.values()].reduce((a, b) => a + b, 0);
/** 假布局：容器 240 高、每行 40，行 rect 按索引排（scrollTop 可动）。
 *  「可见即挂」除了 IO 还有一条纯几何的兜底，不给真 rect 就没东西可算 */
function fakeLayout(scrollTop = 0, rowH = 40, viewH = 240) {
  const list = stripList();
  list.clientHeight = viewH;
  list.clientWidth = 190;
  list.scrollTop = scrollTop;
  list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 190, bottom: viewH, width: 190, height: viewH });
  rows().forEach((row, i) => {
    const top = i * rowH - scrollTop;
    row.getBoundingClientRect = () => ({ left: 0, top, right: 190, bottom: top + rowH, width: 190, height: rowH });
  });
}
/** 滚一下并等节流（80ms）走完 —— 不发 IO，单看几何那一道路能不能把行补上 */
async function scrollStrip(top) {
  fakeLayout(top);
  stripList().dispatchEvent({ type: "scroll" });
  await new Promise((r) => setTimeout(r, 120));
  await settle();
}
const ghostName = () => ghost().querySelector(".sg-name").text;

/** 行上第二格（.fs-size）真正显示的那段字：目录源是体积，历史源是相对时间 */
const rowMeta = () =>
  rows().map(
    (r) => r.children.find((c) => c.classSet.has("fs-main"))?.children.find((c) => c.classSet.has("fs-size"))?.text ?? ""
  );
const srcTab = (src) => byId(src === "dir" ? "btn-src-dir" : "btn-src-history");
/** 点头部那枚 tab 切源（setStripSource 是异步的：切到目录源要重发一次列目录） */
async function useSource(src) {
  click(srcTab(src));
  await settle(20);
}
const historyCalls = () => calls.filter(([c]) => c === "record_view" || c === "get_history" || c === "clear_history");
const folderCalls = () => calls.filter(([c]) => c === "list_folder_images");

let failed = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}

await settle();

/* ===================== 0) 默认源就是「最近看过」 ===================== */
check(
  "默认源是「最近看过」：头部那枚 tab 亮着",
  srcTab("history").classSet.has("is-active") && !srcTab("dir").classSet.has("is-active")
);
check(
  "冷启动只发一次 get_history 填默认源",
  calls.filter(([c]) => c === "get_history").length === 1,
  String(calls.filter(([c]) => c === "get_history").length)
);
check("首启动历史是空的：侧栏不弹出来抢地方", strip().hidden === true && rows().length === 0);
check("两个源都还没内容时按钮禁用", byId("btn-strip").disabled === true);
check("历史源下头部那一行说「最近看过」而不是目录名", byId("fs-dir").text === "最近看过", byId("fs-dir").text);

/* 1~17 节验的是「目录源」的既有行为（README 第八节那些判据一字不差）：
   进门先点一下「当前文件夹」切过去，后面的用例就都按目录源跑 */
await useSource("dir");
check("切到目录源不会自己把侧栏弹出来", strip().hidden === true);
check("切源不发 get_history（本地那份够用）", calls.filter(([c]) => c === "get_history").length === 1);

/* ===================== 1) 没有本机路径的来源不该建列表 ===================== */
let since = mark();
await pickFiles([{ name: "截图.png", size: 0 }]);
check(
  "0 字节的 File 报体积错而不是解码失败",
  statusText().startsWith("载入失败") && statusText().includes("0 字节"),
  statusText()
);
check("目录源下这种来源不会去列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 0);
check("侧栏还藏着", strip().hidden === true);

await pickFiles([{ name: "剪贴板图.png", size: 2048 }]);
check("有体积的 File 能进空着的 A 窗", srcOf("a") === "剪贴板图.png", srcOf("a"));
check(
  "目录源下：File 来源没有本机路径：侧栏藏起来并说明原因",
  strip().hidden === true && byId("fs-tip").text === "这个来源没有本机路径，列不出文件夹",
  byId("fs-tip").text
);
check("目录源下没有列表时「列表」按钮禁用", byId("btn-strip").disabled === true);
check("目录源下这种来源一路都没去列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 0);

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
check("目录源下：列目录用的参数就是这张图的路径", calls.slice(since).some(([c, a]) => c === "list_folder_images" && a.path === `${ALPHA}/IMG_10.png`));
check("列表只含本层的图片", rowPaths().join(",") === alphaList.join(","), rowNames().join(","));
check("非图片与子目录都不在列表里", !rowPaths().some((p) => p.includes("notes.txt") || p.includes("raw/")));
check("自然序：IMG_2 排在 IMG_10 前、IMG_10 排在 IMG_100 前", rowNames().indexOf("IMG_2.png") < rowNames().indexOf("IMG_10.png") && rowNames().indexOf("IMG_10.png") < rowNames().indexOf("IMG_100.png"));
check("tif 也认（三份表必须一致）", rowNames().includes("scan.tif"));
check("有列表就自动露出来", strip().hidden === false);
check("目录源下头部写着目录名与张数", byId("fs-dir").text === "ALPHA" && byId("fs-count").text === "5 张", `${byId("fs-dir").text}/${byId("fs-count").text}`);
check("按钮解除禁用并高亮", byId("btn-strip").disabled === false && byId("btn-strip").classSet.has("is-active"));
check("当前项高亮在 IMG_10 那行", rowNames()[currentIndex()] === "IMG_10.png", String(currentIndex()));
check("列表建起来时把当前项滚进可见", rows()[currentIndex()].scrollIntoViewCalls > 0);

since = mark();
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
check("目录源下同目录再载入一张不重发 IPC", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 0);
check("目录源下同目录载入会把当前项对齐", rowNames()[currentIndex()] === "IMG_2.png", rowNames()[currentIndex()]);
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

/* ===================== 4) 四图布局：浏览按 A→B→C→D→A 轮，四张同时在屏上 ===================== */
key("4");
await settle();
check("切到四图后 C/D 是空的（切布局不搬图）", srcOf("c") === "" && srcOf("d") === "" && byId("st-info-c").text.includes("未载入"));
click(byId("btn-clear"));
await settle();
const gslots = [];
for (const i of [0, 1, 2, 3, 4]) {
  const before = shot();
  click(rows()[i]);
  await settle();
  gslots.push(changedPanes(before).join(""));
}
check(
  "连点五项走出 a→b→c→d→a：与两图那套是同一条规则，只是序列长了",
  gslots.join(",") === "a,b,c,d,a",
  gslots.join(",")
);
check(
  "四张同时在屏上：每个窗都有一份，不只看 A/B",
  ["a", "b", "c", "d"].every((k) => srcOf(k) !== "") && new Set(["a", "b", "c", "d"].map(srcOf)).size === 4,
  ["a", "b", "c", "d"].map((k) => srcOf(k).split("/").pop()).join(",")
);
check(
  "状态行说清了其余三格留着前面几张",
  /第 \d\/5 张→A 窗，B 窗\/C 窗\/D 窗留着前面几张/.test(statusText()),
  statusText()
);
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

/* ===================== 8) 小图：可见即挂（不再只解当前项 ±1） ===================== */
since = mark();
await openViaCmdO([`${GAMMA}/g3_big.png`]); // 换目录 → 行全部重建，小图从零开始
check("目录源下换目录只重发一次列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 1);
check("目录源下新目录的行重建了", rowNames().join(",") === "g1.png,g2.png,g3_big.png,g4.png,g5.png,gone.png", rowNames().join(","));
// IO 说这六行都在视口里：该挂几行就挂几行 —— 老口径只挂当前项 ±1，其余行一直空着
ioInstances[0].fire(rows().map((r) => ({ target: r, isIntersecting: true })));
await settle();
check(
  "一屏里的行都挂上小图（不再只解当前项 ±1）",
  [0, 1, 3, 4, 5].every((i) => hasThumb(i)),
  [0, 1, 2, 3, 4, 5].map((i) => (hasThumb(i) ? 1 : 0)).join("")
);
check(
  "并发上限之外的行排队补上，且每张只读一次盘（直接丢掉就会永远空着）",
  [0, 1, 3, 4, 5].every((i) => (world.reads.get(rowPaths()[i]) || 0) === 1),
  [0, 1, 3, 4, 5].map((i) => world.reads.get(rowPaths()[i]) || 0).join(",")
);
check("过 4MB 的不自动解，只给「大」字占位", pendingOf(2) === "大" && !hasThumb(2), pendingOf(2));
check("退路里挂的是 data URL（整图 base64）", thumbSrc(0).startsWith("data:"), thumbSrc(0).slice(0, 22));

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
// 当前项是 2，rows[4] 在 ±1 窗口之外：老口径在这儿空着，现在 IO 说可见就该挂
io.fire([{ target: rows()[4], isIntersecting: false }]);
check("滚出视口先摘掉第 5 行", !hasThumb(4));
const rd5 = world.reads.get(`${GAMMA}/g5.png`) || 0;
io.fire([{ target: rows()[4], isIntersecting: true }]);
await settle();
check(
  "IO 说可见就挂回来，不再被 ±1 窗口挡回去",
  hasThumb(4) && (world.reads.get(`${GAMMA}/g5.png`) || 0) === rd5,
  `${rd5} -> ${world.reads.get(`${GAMMA}/g5.png`)}`
);

/* —— 一屏十几行：并发 3 之外的那些必须排队补上（用户那屏就是十几行） —— */
await openViaCmdO([`${QUEUE}/q6.png`]);
await settle();
check("十二行的目录都列出来了", rows().length === 12, String(rows().length));
ioInstances[0].fire(rows().map((r) => ({ target: r, isIntersecting: true })));
await settle(60);
check(
  "十二行全部挂上：并发 3 之外的行排队补上，不是直接丢掉",
  rows().every((_, i) => hasThumb(i)),
  rows().map((_, i) => (hasThumb(i) ? 1 : 0)).join("")
);
// 回到第 9 段要的那个目录（上面换了一圈，状态重新取）
await openViaCmdO([`${GAMMA}/g3_big.png`]);
await settle();

/* ===================== 9) 读失败：不动对照位、只把行标灰 ===================== */
const before9 = shot();
const idx9 = currentIndex();
world.missing.add(`${GAMMA}/gone.png`);
const rdGone = world.reads.get(`${GAMMA}/gone.png`) || 0;
click(rows()[5]);
await settle();
check("读失败时状态栏给原因", statusText().startsWith("载入失败"), statusText());
check("读失败不动任何窗（对照位不被悄悄换掉）", shot().a === before9.a && shot().b === before9.b);
check("读失败不推进游标", currentIndex() === idx9, `${currentIndex()} vs ${idx9}`);
check("失败那行标灰", badIndex() === 5, String(badIndex()));
// 标灰之后再“滚进视口”也不重来：bad 那一层把请求拦住（可见即挂之后这一条更要紧）
io.fire([{ target: rows()[5], isIntersecting: false }]);
io.fire([{ target: rows()[5], isIntersecting: true }]);
await settle();
check(
  "失败那行标灰后不再解小图：bad 把请求拦住，一次也不多读",
  (world.reads.get(`${GAMMA}/gone.png`) || 0) === rdGone,
  `${rdGone} -> ${world.reads.get(`${GAMMA}/gone.png`)}`
);
const before9b = shot();
click(rows()[3]);
await settle();
check("失败之后的浏览仍按交替落窗（那次失败没偷走 slot）", changedPanes(before9b).join(",") === "b", changedPanes(before9b).join(","));
world.missing.delete(`${GAMMA}/gone.png`);

/* ===================== 10) 换目录就刷新列表；只有一张也照常列 ===================== */
since = mark();
await openViaCmdO([`${BETA}/beta_10.png`]);
check("目录源下换目录会重发一次列目录", calls.slice(since).filter(([c]) => c === "list_folder_images").length === 1);
check("目录源下列表换成那个目录的图并按自然序排", rowNames().join(",") === "beta_1.png,beta_2.png,beta_10.png", rowNames().join(","));
check("目录源下头部目录名跟着换", byId("fs-dir").text === "BETA" && byId("fs-dir").title === BETA);
check("目录源下旧目录的小图不留在行上", rows().every((r) => !r.querySelector(".fs-thumb img")));
check("目录源下换了目录就把上一次的失败记录清空", badIndex() === -1, String(badIndex()));
click(rows()[0]);
await settle();
check("目录源下点新目录里的行照样走交替（beta_10 还在 A）", currentIndex() === 0 && srcOf("b") === `${BETA}/beta_1.png` && srcOf("a") === `${BETA}/beta_10.png`, `${currentIndex()}/${srcOf("b")}`);

await openViaCmdO(["/tmp/shot/ONLY/only.png"]);
check("目录源下目录里就这一张也照常列出", rows().length === 1 && rowNames().join(",") === "only.png", String(rows().length));
check("只有一张时 ] 不越界", key("]").prevented === true);
await settle();
check("游标停在第一张、也就是最后一张", currentIndex() === 0 && statusText().includes("已经是最后一张"), statusText());

/* ===================== 11) 后端截断要说明一声，前端那份筛图是兜底 ===================== */
await openViaCmdO([`${HUGE}/p0.png`]);
check("目录源下目录过大只列 2000 张", rows().length === FOLDER_MAX_ITEMS, String(rows().length));
check("目录源下截断时在列表底部说明一声", stripList().children.some((c) => c.classSet.has("fs-tip") && c.text.includes(`目录过大，只列出前 ${FOLDER_MAX_ITEMS} 张`)));

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

/* ===================== 15) 把侧栏那一行拖到指定的那个窗 ===================== */
key("2");
click(byId("btn-clear"));
await settle();
await openViaCmdO([`${ALPHA}/IMG_2.png`]); // A = IMG_2，同时把 ALPHA 列表建起来
await settle();
// 桩里四个窗全压在原点，命中判定分不出格：按屏幕实际位置盖一遍（按下点 30,30 在两格之外）
setPaneRect("a", 400, 100, 500, 400);
setPaneRect("b", 900, 100, 500, 400);
setPaneRect("c", 400, 500, 500, 400);
setPaneRect("d", 900, 500, 500, 400);
check(
  "ALPHA 列表已就位（下面都按这一份下标写）",
  rowNames().join(",") === "big.png,IMG_2.png,IMG_10.png,IMG_100.png,scan.tif",
  rowNames().join(",")
);

/* —— 按下没超过阈值：那还是一次普通点行 —— */
let dBefore = shot();
rowDown(rows()[2], 30, 30);
fireWin("mousemove", { clientX: 33, clientY: 32, buttons: 1 }); // 只走 3.6px
fireWin("mouseup", { clientX: 33, clientY: 32 });
click(rows()[2]);
await settle();
check(
  "移动没超过 4px 就仍是一次点行：照旧走轮转落窗",
  changedPanes(dBefore).join(",") === "b" && srcOf("b") === `${ALPHA}/IMG_10.png`,
  `${changedPanes(dBefore).join(",")} | ${srcOf("b")}`
);
check("没超阈值全程不亮牌也不加禁选类", ghost().hidden === true && !body.classSet.has("is-strip-drag"));

/* —— 越过阈值：牌亮起来、跟手、按可见窗描边 —— */
rowDown(rows()[3], 30, 30);
fireWin("mousemove", { clientX: 30, clientY: 45, buttons: 1 }); // 15px > 4
check(
  "超阈值就认定是拖：牌亮出来、跟到指针处、整页禁选",
  ghost().hidden === false &&
    ghost().style.left === "30px" &&
    ghost().style.top === "45px" &&
    body.classSet.has("is-strip-drag"),
  JSON.stringify(ghost().style)
);
check(
  "牌上写的是那一行的文件名，图只在与缓存一致时挂（不留空 img）",
  ghostName() === "IMG_100.png" && (ghostImg().attributes.src ? !ghostImg().hidden : ghostImg().hidden === true),
  `${ghostName()} | hidden:${ghostImg().hidden}`
);
fireWin("mousemove", { clientX: 1100, clientY: 200, buttons: 1 }); // 进 B 窗
check(
  "指针进 B 窗：只有 B 描边（drag-over 与从 Finder 拖文件进来同一套）",
  byId("pane-b").classSet.has("drag-over") && !byId("pane-a").classSet.has("drag-over")
);
dBefore = shot();
fireWin("mouseup", { clientX: 1100, clientY: 200 });
await settle();
check(
  "松手落进 B：非空窗也被直接换掉，A 不动",
  changedPanes(dBefore).join(",") === "b" && srcOf("b") === `${ALPHA}/IMG_100.png`,
  `${changedPanes(dBefore).join(",")} | ${srcOf("b")}`
);
check(
  "收场干净：牌隐、禁选摘、描边清、img 不留残 src",
  ghost().hidden === true &&
    !body.classSet.has("is-strip-drag") &&
    !byId("pane-b").classSet.has("drag-over") &&
    !ghostImg().attributes.src
);
dBefore = shot();
click(rows()[0]); // 拖完浏览器可能补一个 click：那一下不该翻页
await settle(); // 不给这一句的话，真偷走了浏览也照样照不出（负向验证时踩过）
check(
  "真起过拖之后补来的 click 不吃浏览",
  changedPanes(dBefore).length === 0 && srcOf("a") === `${ALPHA}/IMG_2.png`,
  changedPanes(dBefore).join(",")
);
dBefore = shot();
clickRow(0); // 重新按下就复位：下一次点行照常
await settle();
check(
  "吐一次就复位：接着按下再点同一行照常浏览（轮转起点已被拖拽改到了 B）",
  changedPanes(dBefore).join(",") === "a" && srcOf("a") === `${ALPHA}/big.png`,
  `${changedPanes(dBefore).join(",")} | ${srcOf("a")}`
);

/* —— 落点只看当前档的可见窗 —— */
rowDown(rows()[2], 30, 30);
fireWin("mousemove", { clientX: 600, clientY: 600, buttons: 1 }); // 两图下 C 的矩形里
check(
  "两图下指针压在 C 的矩形里也不描边（paneAtPoint 只遍历可见窗）",
  ["a", "b", "c", "d"].every((k) => !byId("pane-" + k).classSet.has("drag-over"))
);
dBefore = shot();
fireWin("mouseup", { clientX: 600, clientY: 600 });
await settle();
check("松在没有可见窗的地方：什么都没发生", changedPanes(dBefore).length === 0, changedPanes(dBefore).join(","));

/* —— 半途 Esc 作废 —— */
// 上面几段把侧栏收过就不再自动弹，这里先开回来：不然「Esc 有没有去收侧栏」根本观察不到
click(byId("btn-strip"));
await settle();
dBefore = shot();
rowDown(rows()[4], 30, 30);
fireWin("mousemove", { clientX: 30, clientY: 60, buttons: 1 });
const esc = key("Escape");
await settle();
check(
  "拖到一半按 Esc：这趟作废，牌隐、禁选摘",
  ghost().hidden === true && !body.classSet.has("is-strip-drag")
);
check("Esc 被拖拽吃掉，没继续往下走去收侧栏", esc.prevented === true && strip().hidden === false, `prevented:${esc.prevented} hidden:${strip().hidden}`);
fireWin("mouseup", { clientX: 30, clientY: 60 });
click(rows()[4]);
await settle();
check("Esc 作废后补来的 click 同样不吃浏览", changedPanes(dBefore).length === 0, changedPanes(dBefore).join(","));

/* —— 四图下拖 C/D，以及“拖一次就是把轮转起点挪到哪” —— */
key("4");
await settle();
rowDown(rows()[1], 30, 30);
fireWin("mousemove", { clientX: 30, clientY: 60, buttons: 1 });
fireWin("mousemove", { clientX: 600, clientY: 600, buttons: 1 });
check("四图下指针进 C 窗：C 描边", byId("pane-c").classSet.has("drag-over") && !byId("pane-a").classSet.has("drag-over"));
dBefore = shot();
fireWin("mouseup", { clientX: 600, clientY: 600 });
await settle();
check("空着的 C 窗收下这一张", srcOf("c") === `${ALPHA}/IMG_2.png` && changedPanes(dBefore).join(",") === "c", srcOf("c"));
rowDown(rows()[4], 30, 30);
fireWin("mousemove", { clientX: 30, clientY: 60, buttons: 1 });
fireWin("mousemove", { clientX: 700, clientY: 700, buttons: 1 }); // 还在 C 那一格
dBefore = shot();
fireWin("mouseup", { clientX: 700, clientY: 700 });
await settle();
check(
  "再拖一张到同一个窗：原有的直接被替掉，不弹确认",
  srcOf("c") === `${ALPHA}/scan.tif` && changedPanes(dBefore).join(",") === "c",
  srcOf("c")
);
dBefore = shot();
clickRow(0);
await settle();
check(
  "拖拽也把轮转起点记成了落点窗：下一次浏览走它的下一格（C→D）",
  changedPanes(dBefore).join(",") === "d" && srcOf("d") === `${ALPHA}/big.png`,
  `${changedPanes(dBefore).join(",")} | ${srcOf("d")}`
);

/* ===================== 16) asset 协议开着：视口内的行全都挂图，一个字节不走 IPC ===================== */
world.assetOn = true;
key("2");
click(byId("btn-clear"));
await settle();
await openViaCmdO([`${DELTA}/a2.png`]); // DELTA: [0]a1 [1]a2 [2]a3_big(6MB) [3]a4 [4]a5（LRU 里一张都没有）
await settle();
check("DELTA 列表已就位", rowNames().length === 5, rowNames().join(","));
const rd16 = totalReads();
io.fire(rows().map((r) => ({ target: r, isIntersecting: true }))); // 整列都算滚进视口
await settle();
check(
  "视口内的行全都挂上了图（不再只有当前项 ±1）",
  rows().every((_, i) => hasThumb(i)),
  rows().map((_, i) => (hasThumb(i) ? "1" : "0")).join("")
);
check(
  "挂的是本地文件的 asset 地址，不是整图 data URL",
  thumbSrc(3).startsWith("asset://localhost/"),
  thumbSrc(3)
);
// 光比较总数不够咬得住：开目录时「当前项 ±1」那几张在退路下本来就会读，那几回发生在 rd16 之前。
// 所以这里另外盯 a1 —— 它落在老窗口里，退路下必然被读一回，asset 模式下必须是零次。
// （2026-10-26 变异测试：只比总数的话，把 asset 早退删掉这条照样绿。）
check(
  "一个字节也没走 IPC：整列挂图期间 read_image 一次没多发",
  totalReads() === rd16 && !world.reads.get(`${DELTA}/a1.png`),
  `${rd16} -> ${totalReads()} | a1 读了 ${world.reads.get(`${DELTA}/a1.png`) || 0} 回`
);
check(
  "4MB 闸门不参与：6MB 那张也直接挂上，不给「大」字占位",
  hasThumb(2) && thumbSrc(2).includes(encodeURIComponent("a3_big.png")) && pendingOf(2) === "",
  `${thumbSrc(2)} | 占位:${pendingOf(2)}`
);
io.fire([{ target: rows()[3], isIntersecting: false }]);
check("滚出视口照样摘图（省内存那一道留着，只是不再需要 LRU）", !hasThumb(3));

/* —— 路径里带空格与非 ASCII：得原样转义进地址 —— */
await openViaCmdO([`${SPACE}/第一 张.png`]);
await settle();
io.fire(rows().map((r) => ({ target: r, isIntersecting: true })));
await settle();
const iHan = rows().findIndex((r) => r.dataset.path === `${SPACE}/第一 张.png`);
const iLat = rows().findIndex((r) => r.dataset.path === `${SPACE}/second x.jpg`);
check(
  "中文与空格都能解回原路径（转义不能把地址串打断）",
  thumbSrc(iHan) === `asset://localhost/${encodeURIComponent(`${SPACE}/第一 张.png`)}` &&
    decodeURIComponent(thumbSrc(iLat).split("asset://localhost/")[1]) === `${SPACE}/second x.jpg`,
  thumbSrc(iLat)
);
// 拖那一行起拖（指针仍在两格矩形之外，不会真载入）：牌上该直接挂上 asset 地址
rowDown(rows()[iHan], 30, 30);
fireWin("mousemove", { clientX: 30, clientY: 60, buttons: 1 });
check(
  "牌上的图也不依赖 LRU 里有没有那份缓存：asset 地址直接挂",
  ghostImg().attributes.src === `asset://localhost/${encodeURIComponent(`${SPACE}/第一 张.png`)}` &&
    ghostImg().hidden === false,
  JSON.stringify(ghostImg().attributes)
);
fireWin("mouseup", { clientX: 30, clientY: 60 });
await settle();

/* —— 转不出地址时，退路也是「一屏几行挂几行」（纯浏览器调试与 convertFileSrc 缺失时走它） —— */
world.assetOn = false;
click(byId("btn-clear"));
await settle();
await openViaCmdO([`${EPS}/e2.png`]); // EPS 同样是干净目录：这几行是真没读过盘，不是缓存命中
await settle();
// IO 一次都不 fire：只发一次 scroll，单看几何那一道能不能把屏上的行补齐
await scrollStrip(0);
check(
  "IO 一次都没 fire，只靠滚动兜底：一屏里的行也全挂上",
  [0, 1, 3, 4].every((i) => hasThumb(i)),
  [0, 1, 2, 3, 4].map((i) => (hasThumb(i) ? 1 : 0)).join("")
);
check("退路里过 4MB 的仍只给「大」字", pendingOf(2) === "大", pendingOf(2));
check("退路里挂的是 data URL（整图 base64）而不是 asset 地址", thumbSrc(1).startsWith("data:"), thumbSrc(1).slice(0, 24));

/* ============ 17) asset 转得出地址但取不到文件（403）：按路径退回 read_image，只认一次 ============ */
world.assetOn = true; // 转地址照样成功，只是文件拿不到 —— 这里手动打 error 事件模拟
key("2");
click(byId("btn-clear"));
await settle();
await openViaCmdO([`${ZETA}/z2.png`]); // ZETA: [0]z1 [1]z2 [2]z3 [3]z4 [4]z5（全小图，LRU 里一张都没有）
await settle();
io.fire(rows().map((r) => ({ target: r, isIntersecting: true })));
await settle();
check(
  "起手确认整列挂的是 asset 地址（下面只把其中一张打成 403）",
  rows().every((_, i) => thumbSrc(i).startsWith("asset://localhost/")),
  rows().map((_, i) => (thumbSrc(i).startsWith("asset://") ? "1" : "0")).join("")
);
const rd17 = totalReads();
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => warns.push(a.map(String).join(" "));
thumbImg(0)?.dispatchEvent({ type: "error", target: thumbImg(0) });
await settle();
console.warn = realWarn;
check(
  "取不到文件的那一行改由 read_image 画出 data URL（不是留个破图）",
  thumbSrc(0).startsWith("data:"),
  thumbSrc(0).slice(0, 22)
);
check("这一行确实回去读了一回盘", totalReads() === rd17 + 1, `${rd17} -> ${totalReads()}`);
check("退路信号只打一次日志", warns.length === 1, `${warns.length} 条`);

// 已经挂上 asset 的其他行会各自报 error：窗口外那一张不能留在破图上
const rd17b = totalReads();
const warns2 = [];
console.warn = (...a) => warns2.push(a.map(String).join(" "));
thumbImg(4)?.dispatchEvent({ type: "error", target: thumbImg(4) });
await settle();
console.warn = realWarn;
check(
  "第二张坏图同样被治好：这一行也拿到 data URL（不再因为窗口外就空着）",
  thumbSrc(4).startsWith("data:") && hasThumb(4),
  `src:${thumbSrc(4).slice(0, 22)} 占位:${pendingOf(4)}`
);
check("坏路径按路径记：第二个路径照样打一条日志", warns2.length === 1, `${warns2.length} 条`);
check("自愈那一行只多读一次盘", totalReads() === rd17b + 1, `${rd17b} -> ${totalReads()}`);

// 坏路径只黑名单自己，别的行照旧走 asset
io.fire([{ target: rows()[2], isIntersecting: false }]);
io.fire([{ target: rows()[2], isIntersecting: true }]);
await settle();
check(
  "坏的两个路径只黑名单自己：同目录里 z3 照旧挂 asset 地址",
  thumbSrc(2).startsWith("asset://localhost/"),
  thumbSrc(2).slice(0, 34)
);
// 牌也不受牵连（z2 是好的路径，asset 地址照挂）
rowDown(rows()[1], 30, 30);
fireWin("mousemove", { clientX: 30, clientY: 60, buttons: 1 });
check(
  "牌上照旧挂 asset 地址：坏的是别的行，跟这一张无关",
  String(ghostImg().attributes.src || "").startsWith("asset://localhost/"),
  JSON.stringify(ghostImg().attributes)
);
fireWin("mouseup", { clientX: 30, clientY: 60 });
await settle();
// 上面那趟拖拽还欠一次「紧跟的 click 要吐掉」（语义在第 15 节验过了）：
// 这里空点一下把它吐干净，别让它漏到第 18 节去吃掉点失效行的那一下
click(rows()[1]);
await settle();

/* ===================== 18) 历史源（默认那一路）的完整行为 ===================== */
world.assetOn = false; // 17 节把它开着；这一节要回到 read_image 那条路，「文件被移走」才真能失败
key("2");
click(byId("btn-clear"));
await settle();
const fc18 = folderCalls().length;
const shot18a = shot();
await useSource("history");
check(
  "切到历史源用本地那份列表，不重发 get_history",
  calls.filter(([c]) => c === "get_history").length === 1 && rows().length > 0,
  `${calls.filter(([c]) => c === "get_history").length} 次 get_history / ${rows().length} 行`
);
check("切到历史源不重发列目录", folderCalls().length === fc18);
// 这里盯的是图窗不是小图：切源后 renderStrip 会按老口径给当前项 ±1 解两张小图，那是应当的
check("切到历史源不动图窗：一张也没进也没出", changedPanes(shot18a).length === 0, changedPanes(shot18a).join(","));

// 上面十几节攒来的记录先清干净，这一段的所有权归历史源
click(byId("btn-history-clear"));
await settle(20);
check("清空走一次 clear_history", calls.filter(([c]) => c === "clear_history").length === 1);
check("清空后行全没了", rows().length === 0);
check("清空后那句提示说的是谁干的，不是「暂无图片」", byId("fs-tip").text.includes("查看历史已清空"), byId("fs-tip").text);
check("两个源都空了：按钮重新禁用", byId("btn-strip").disabled === true);

/* —— 记一次查看 = 一行；重复查看只置顶 —— */
since = mark();
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
check("打开一张就发一次 record_view", calls.slice(since).filter(([c]) => c === "record_view").length === 1);
check("渲染用的就是 record_view 的返回值：不额外发 get_history", calls.slice(since).filter(([c]) => c === "get_history").length === 0);
check("历史源下这一行就是那张图", rowPaths().join(",") === `${ALPHA}/IMG_2.png`, rowPaths().join(","));
check("行上第二格是相对时间不是体积", rowMeta()[0] === "刚刚", rowMeta()[0]);
check("历史源下有列表就自动露出来", strip().hidden === false);
check("历史源下不列目录", folderCalls().length === fc18);
check("历史源下头部那一行写「最近看过」", byId("fs-dir").text === "最近看过" && byId("fs-count").text === "1 张", `${byId("fs-dir").text}/${byId("fs-count").text}`);

await openViaCmdO([`${ALPHA}/IMG_10.png`]);
check("新看的那张顶在最前", rowPaths().join(",") === `${ALPHA}/IMG_10.png,${ALPHA}/IMG_2.png`, rowPaths().join(","));
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
check("同一张再看一次不多出一行，只置顶", rowPaths().join(",") === `${ALPHA}/IMG_2.png,${ALPHA}/IMG_10.png`, rowPaths().join(","));
check("重复查看把时间刷成「刚刚」，旧的那条成了 1 分钟前", rowMeta().join("|") === "刚刚|1 分钟前", rowMeta().join("|"));

/* —— 逐张浏览也是「真看过」：一个入口不走 fillPanes，得自己记，一张都不许漏 —— */
await openViaCmdO([`${ALPHA}/IMG_100.png`]); // 历史源放到 3 行，够翻一张也够早退一次
since = mark();
const rowsHist0 = rowPaths().join(",");
key("]");
await settle();
check("历史源里翻到下一张：发了一次 record_view", calls.slice(since).filter(([c]) => c === "record_view").length === 1, String(calls.slice(since).filter(([c]) => c === "record_view").length));
check(
  "历史源里浏览不重排侧栏：行顺序一字不变（每按一次方向键就把当前行顶到第一行，翻图时列表会跳、下一张也跟着变）",
  rowPaths().join(",") === rowsHist0,
  `${rowsHist0} -> ${rowPaths().join(",")}`
);
check("不重排不等于没跟上：当前项跟着走到了第 2 行", currentIndex() === 1, String(currentIndex()));
since = mark();
click(rows()[1]); // 就是正看着的那一张
await settle();
check("点在正看着的那一行：早退那条路不重读盘也不多写一次盘", calls.slice(since).filter(([c]) => c === "record_view").length === 0, String(calls.slice(since).filter(([c]) => c === "record_view").length));

await useSource("dir");
const alpha5 = rowPaths().slice(); // 目录源那 5 张的绝对路径
check("目录源里确实列的是 5 张（不是历史）", alpha5.length === 5 && byId("fs-count").text === "5 张", byId("fs-count").text);
const seenBefore = new Set(world.history);
const needIn = alpha5.filter((p) => !seenBefore.has(p));
const rowsDir0 = rowPaths().join(",");
since = mark();
for (let i = 0; i < alpha5.length; i++) {
  click(rows()[i]); // 挨个点一遍：这就是「把整个文件夹看了一遍」
  await settle();
}
check(
  `这趟浏览把 ${needIn.length} 张从没见过的补进了历史：一张不漏`,
  needIn.length > 0 && needIn.every((p) => world.history.includes(p)),
  alpha5.filter((p) => !world.history.includes(p)).join(",") || `${needIn.length} 张全在`
);
check("目录源里逐张浏览行的就是这一份目录列表，一点没被历史带跳", rowPaths().join(",") === rowsDir0, rowPaths().join(","));
check(
  "5 行挨个点一遍就发 5 次 record_view（已在历史里的那几张也要发：重看一次得把它的 seen 刷成刚刚）",
  calls.slice(since).filter(([c]) => c === "record_view").length === alpha5.length,
  `${calls.slice(since).filter(([c]) => c === "record_view").length} vs ${alpha5.length}`
);
await useSource("history");
check(
  "切回历史源看到的就是最新顺序：最后浏览那张顶在最前（那趟只落盘没重排，但盘上记到了）",
  rowPaths()[0] === alpha5[alpha5.length - 1],
  rowPaths().join(",")
);
check("切回来不重发 get_history：本地那份一直在跟着写盘更新", calls.filter(([c]) => c === "get_history").length === 1);

/* —— 切源：只换喂给行的那份列表，不动图窗也不清小图缓存 —— */
const shot18 = shot();
const fc18b = folderCalls().length;
await useSource("dir");
check("切到目录源不动图窗", changedPanes(shot18).length === 0, changedPanes(shot18).join(","));
check("切到目录源拿当前那张去列一次目录", folderCalls().length === fc18b + 1 && rowNames().includes("big.png"), rowNames().join(","));
check("目录源下头部又写目录名", byId("fs-dir").text === "ALPHA" && byId("fs-count").text === "5 张", `${byId("fs-dir").text}/${byId("fs-count").text}`);
check("切到目录源不动侧栏的开合（还开着）", strip().hidden === false, `hidden:${strip().hidden}`);
await useSource("history");
// 两个方向都得查：只在前一半查的话，「切源顺手把 open 写掉」会被 ensureFolderList 的自动弹开抹平（变异测试踩过）
check("切回历史源同样不收起侧栏", strip().hidden === false, `hidden:${strip().hidden}`);
const firstPath18 = rowPaths()[0];
const rd18first = world.reads.get(firstPath18) || 0;
io.fire(rows().map((r) => ({ target: r, isIntersecting: true })));
await settle();
check("切回历史源不重发列目录", folderCalls().length === fc18b + 1);
check(
  "切源不清 thumbCache：同一张不回盘重读",
  (world.reads.get(firstPath18) || 0) === rd18first && hasThumb(0),
  `${rd18first} -> ${world.reads.get(firstPath18)}`
);
check("切回历史源不重发 get_history（本地那份够用）", calls.filter(([c]) => c === "get_history").length === 1);

/* —— 失效行：标灰、不动落窗不推游标，但绝不从历史里被抹掉 —— */
await openViaCmdO([`${ALPHA}/IMG_100.png`]);
world.missing.add(`${ALPHA}/IMG_100.png`); // 看完就被移走 / 改名
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
const shot18d = shot();
click(rows()[1]); // 就是那张已被移走的
await settle();
check("点失效那一行：标灰", badIndex() === 1, String(badIndex()));
check("点失效那一行不动落窗", changedPanes(shot18d).length === 0, changedPanes(shot18d).join(","));
check("点失效那一行不推进游标：当前项还在最前", currentIndex() === 0, String(currentIndex()));
check("读失败不会把那一行从历史里自动删掉（外置盘没挂载不算没看过）", world.history.includes(`${ALPHA}/IMG_100.png`));
world.missing.delete(`${ALPHA}/IMG_100.png`);

/* —— 100 条上限：第 101 张进来后最旧那条消失 —— */
world.history.length = 0;
for (let i = 0; i < HISTORY_MAX; i++) world.history.push(`${ALPHA}/seed_${String(i).padStart(3, "0")}.png`);
await openViaCmdO([`${ALPHA}/IMG_10.png`]);
check("只留最新 100 条", rows().length === HISTORY_MAX, String(rows().length));
check("新那张顶在最前", rowPaths()[0] === `${ALPHA}/IMG_10.png`, rowPaths()[0]);
check("被挤掉的是最旧那一条", !rowPaths().includes(`${ALPHA}/seed_099.png`) && rowPaths().includes(`${ALPHA}/seed_000.png`));
check("张数说的也封顶了", byId("fs-count").text === `${HISTORY_MAX} 张`, byId("fs-count").text);

/* —— 文案必须按源分流：历史源下提「目录」就是假话 —— */
click(byId("btn-history-clear"));
await settle(20);
key("]");
await settle();
check("空历史里翻下一张：说的是查看历史，不提目录", statusText().includes("查看历史") && !statusText().includes("目录"), statusText());
click(byId("btn-strip"));
await settle();
check("空历史里点「列表」也说的是查看历史", statusText().includes("还没有查看历史") && !statusText().includes("目录"), statusText());
check("「列表」按钮那句 title 也说得出两个源（不能只说一个）", byId("btn-strip").title.includes("最近看过"), byId("btn-strip").title);

/* —— 记录失败不能拖累载入与浏览 —— */
world.historyErr = true;
const shot18e = shot();
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
check("record_view 报错：图照样进窗，当前项不对也不报错", srcOf("a") === `${ALPHA}/IMG_2.png` || srcOf("b") === `${ALPHA}/IMG_2.png`, JSON.stringify(shot18e));
check("记录失败只说一声", statusText().includes("记录查看失败"), statusText());
// 报错期间历史根本写不进去（桩在 push 之前就抛），所以先恢复写盘攒两行，再回到失败态翻一张：
// 验的是「浏览那一路走的也是同一个口子，它失败时同样不能拖住翻图」
world.historyErr = false;
await openViaCmdO([`${ALPHA}/IMG_10.png`]);
await openViaCmdO([`${ALPHA}/IMG_2.png`]);
world.historyErr = true;
since = mark();
key("]");
await settle();
check(
  "记录失败时侧栏照常翻到下一张：行还在、当前项跟着走",
  rows().length === 2 && currentIndex() === 1 && calls.slice(since).filter(([c]) => c === "record_view").length === 1,
  `rows:${rows().length}/idx:${currentIndex()}/${calls.slice(since).filter(([c]) => c === "record_view").length} 次`,
);
check("浏览那一路记录失败也只是说一声，不抛出", statusText().includes("记录查看失败"), statusText());
world.historyErr = false;

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
