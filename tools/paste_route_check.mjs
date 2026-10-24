/**
 * 粘贴分流的纯逻辑自检：拿真实的 js/api.js 源码，配一套最小 DOM / Tauri 桩跑。
 *
 * 为什么这么测：剪贴板本身只能在 Rust 侧读（clip.rs 那边走真机探针），
 * 前端这一层的价值全在「什么时候该抢、抢来交给谁」这几条判断上，
 * 而这些判断不需要真界面，需要真界面的是下游三个视图各自的落点。
 *
 * 运行：node tools/paste_route_check.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------- DOM 桩 -------------------------------- */
const docListeners = [];
const winListeners = [];
const els = {}; // id -> 假元素
const body = { dataset: { view: "compare" } };

globalThis.document = {
  body,
  querySelectorAll: () => [],
  getElementById: (id) => els[id] || null,
  createElement: () => ({ style: {}, classList: { toggle() {} }, remove() {}, select() {} }),
  execCommand: () => false,
  addEventListener: (type, fn) => docListeners.push([type, fn]),
};
globalThis.window = {
  addEventListener: (type, fn) => winListeners.push([type, fn]),
  __TAURI__: { core: { invoke: async () => null }, event: { listen: async () => () => {} } },
};

/** invoke 的假应答：按 scenario 决定成功、报错还是空 */
let scenario = null;
const invokes = [];
window.__TAURI__.core.invoke = async (cmd, args) => {
  invokes.push([cmd, args]);
  if (cmd !== "paste_paths") return null;
  if (scenario.throw) throw new Error(scenario.throw);
  return scenario.paths;
};

/** api.js 是 .js 且本项目 package.json 不是 ESM，用 data: 源直接按模块加载 */
const src = readFileSync(join(here, "..", "js", "api.js"), "utf8");
const api = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

/* ------------------------------ 事件小工具 ----------------------------- */
function makeEvent(type, target, clipboard) {
  let prevented = false;
  return {
    type,
    target,
    prevented: () => prevented,
    preventDefault: () => {
      prevented = true;
    },
    clipboardData: clipboard || null,
    ...(type === "keydown" ? { key: "v", metaKey: true, ctrlKey: false, shiftKey: false } : {}),
  };
}

/** 依次跑注册的监听器，等内部 promise 落地 */
async function fire(listeners, ev) {
  for (const [type, fn] of listeners) {
    if (type === ev.type) fn(ev);
  }
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** 过一个去重窗口再开下一个场景，否则上一个场景的 lastPasteAt 会把这次吞掉 */
const gap = () => new Promise((r) => setTimeout(r, 560));

const editable = (tag) => ({ tagName: tag, isContentEditable: false });
const plainText = { types: ["text/plain"], getData: () => "一段文字" };
const fileFlavor = { types: ["Files", "text/uri-list"], getData: () => "file:///tmp/a.png" };

let failed = 0;
const assert = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

api.installPasteListener();
assert("paste 与 keydown 两条入口都装上了", docListeners.length === 1 && winListeners.length === 1);

const dropped = [];
api.registerDropHandler("compare", (paths) => dropped.push(["compare", paths]));
api.registerDropHandler("transfer", (paths) => dropped.push(["transfer", paths]));
api.registerPasteTextHandler("fav", (text) => dropped.push(["fav-text", text]));

/* 1) 输入框里粘纯文字：完全不碰 Rust，浏览器自己完成 */
await gap();
invokes.length = 0;
dropped.length = 0;
await fire(docListeners, makeEvent("paste", editable("TEXTAREA"), plainText));
assert("输入框里粘纯文字不抢原生粘贴", invokes.length === 0 && dropped.length === 0);

/* 2) 输入框里粘文件/图片：要抢过来走文件这条路（微信式粘截图） */
await gap();
invokes.length = 0;
dropped.length = 0;
scenario = { paths: ["/tmp/a.png"] };
const ev2 = makeEvent("paste", editable("TEXTAREA"), fileFlavor);
await fire(docListeners, ev2);
assert("输入框里粘文件仍走剪贴板这条路", invokes.length === 1 && invokes[0][0] === "paste_paths");
assert("抢过来时把原生粘贴挡掉", ev2.prevented());
assert("路径交给当前视图（compare）", dropped.length === 1 && dropped[0][0] === "compare" && dropped[0][1][0] === "/tmp/a.png");

/* 3) 焦点不在输入框：粘到哪个视图就交给哪个视图 */
await gap();
api.setView("transfer");
invokes.length = 0;
dropped.length = 0;
scenario = { paths: ["/tmp/a.png", "/tmp/b.png"] };
await fire(docListeners, makeEvent("paste", body, fileFlavor));
assert("传输视图粘两项都交给传输视图", dropped.length === 1 && dropped[0][0] === "transfer" && dropped[0][1].length === 2);

/* 4) keydown 兜底：没有可编辑焦点时也会读一次，且不会和 paste 重复 */
await gap();
api.setView("compare");
invokes.length = 0;
dropped.length = 0;
scenario = { paths: ["/tmp/c.png"] };
await fire(winListeners, makeEvent("keydown", body));
const afterKey = invokes.length;
await fire(docListeners, makeEvent("paste", body, fileFlavor)); // 紧随其后的 paste 应被去重
assert("keydown 兜底读到一次且 paste 不重复", afterKey === 1 && invokes.length === 1 && dropped.length === 1);

/* 5) 焦点在输入框时 keydown 兜底必须让路（否则打字都发不出粘贴以外的事） */
await gap();
invokes.length = 0;
await fire(winListeners, makeEvent("keydown", editable("INPUT")));
assert("输入框里的 Ctrl/⌘V 不被兜底抢走", invokes.length === 0);

/* 6) 剪贴板里只是文字：交给该视图的文字处理者 */
await gap();
api.setView("fav");
invokes.length = 0;
dropped.length = 0;
scenario = { throw: "剪贴板里没有文件或图片" };
await fire(docListeners, makeEvent("paste", body, plainText));
assert("纯文字交给视图的文字落点", dropped.length === 1 && dropped[0][0] === "fav-text" && dropped[0][1] === "一段文字");

/* 7) 没有文件也没有文字处理者：只报错，不静默 */
await gap();
api.setView("compare");
dropped.length = 0;
els["st-msg"] = { textContent: "", classList: { toggle() {} } };
scenario = { throw: "剪贴板里没有文件或图片" };
await fire(docListeners, makeEvent("paste", body, plainText));
assert("接不住的情况写进状态栏", /剪贴板/.test(els["st-msg"].textContent) && dropped.length === 0);

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
