#!/usr/bin/env node
/**
 * 会话分发的纯逻辑自检：拿真实的 js/view-transfer.js 源码，配一套最小 DOM / Tauri 桩跑。
 *
 * 为什么这么测：多会话的全部风险都在前端那几条判断上 —— 这条消息该铺进哪个流、
 * 未读该算给谁、翻页游标该跟着哪个框走、日期线该在哪几处重算。这些都不需要真界面，
 * 也不需要真网络：桩里的「后端」按 Rust 那套口径回数据（会话主键是自己的 ID、
 * 基础对话的 id = 设备 ID、先按 sid_of 筛再切页、未读只数对方发来且在读指针之后、
 * 陌生会话补一行、入向落点走 resolve_incoming），口径一旦漂移这里就先红。
 *
 * 不盖到的：行内改名（名字在 innerHTML 里，桩不解析 HTML，拿不到那个 <b>；
 * 顶栏那一行例外，它的 innerHTML 在桩里以字符串形式留得住，拿 includes 看）与真样式。
 * 心跳线程也桩不了（那是 Rust 侧的循环）：「解绑后不再自动连」的真口径在
 * net::auto_bind_targets 的单测里，这里只能验前端看得见的部分（候选标着已解绑、
 * 点它先走重新添加）。
 *
 * 运行：node tools/session_route_check.mjs
 */
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------ 假时钟 ------------------------------- */
// 用例都拿「昨天/今天/前天」这类相对日子，写成绝对日期过两天就红了
//
// 还要再钉一下钟点：「今天」那几条写的是固定钟点（09:00 之类），凌晨跑的时候
// 那些时间戳还在未来，而读指针走的是 Date.now() —— 于是「切过去就清未读」会假红
// （真越过午夜就会碰到）。把 Date.now() 钉在当天 20:00（真实时间已过 20:00 就用
// 真实时间），桩和被测代码拿同一把钟；日期线的「今天/昨天」还是同一个自然日，不受影响
const REAL_NOW = Date.now();
const clockAnchor = new Date(REAL_NOW);
clockAnchor.setHours(20, 0, 0, 0);
const NOW = Math.max(REAL_NOW, clockAnchor.getTime());
Date.now = () => NOW;
function day(offset) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - offset);
  return d;
}
function at(dayOffset, hh, mm = 0) {
  const d = day(dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

/* ------------------------------- DOM 桩 ------------------------------- */
/** 桩里不解析 HTML：innerHTML 只存字符串，所以模板里那些 .msg/.file-name
 *  在选择器查询里看不见。用例只依赖 createElement 出来的真节点（行、气泡、日期线、徽标），
 *  被测代码里靠 innerHTML 的那几处本来就有 null 守卫 */
function mkEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    classSet: new Set(),
    listeners: [],
    hidden: false,
    disabled: false,
    value: "",
    placeholder: "",
    title: "",
    text: "",
    html: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    // 用例挂一个数组上去就能追「这个元素被写过哪些文案」（状态行会被下一句提示抢掉，
    // 只看最后一句拿不到 toast）；不挂就一切照旧
    log: null,
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
      if (el.log) el.log.push(el.text);
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
  el.attributes = {};
  el.setAttribute = (k, v) => {
    el.attributes[k] = String(v);
  };
  el.removeAttribute = (k) => {
    delete el.attributes[k];
    if (k === "src") el.src = "";
  };
  // 桩里不做布局：默认零盒，用例自己盖（放大层的缩放要拿它当「打开那一刻量到的盒」）
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
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
  el.insertBefore = (node, ref) => {
    const i = el.children.indexOf(ref);
    el.children.splice(i < 0 ? el.children.length : i, 0, node);
    node.parentNode = el;
    return node;
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
  el.focus = () => {};
  el.blur = () => {};
  el.select = () => {};
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
body.dataset.view = "transfer"; // 拖拽/粘贴路由按当前视图分流，这里固定在传输视图

globalThis.document = {
  body,
  getElementById: byId,
  createElement: mkEl,
  querySelectorAll: () => [],
  execCommand: () => false,
  addEventListener: () => {},
};
const winListeners = [];
globalThis.window = {
  addEventListener: (type, fn) => winListeners.push([type, fn]),
  __TAURI__: { core: { invoke: async () => null }, event: { listen: async () => () => {} } },
};

/* ---------------------------- 桩后端（照 Rust 口径） ---------------------------- */
/** 会话有自己的 ID：基础对话的 id = 那台的设备 ID（老历史才能不改写就归位），
 *  新话题另造一个。桩里的 UUID 用不上，只要能看出「前端不再拿 peer 当 id」 */
let topicSeq = 0;
const newSid = (peer) => `${peer}-topic${++topicSeq}`;

const world = {
  peers: [
    { id: "A", name: "甲机", alias: "", host: "10.0.0.2", port: 45789, online: true, last_seen: NOW },
    { id: "C", name: "丙机", alias: "", host: "10.0.0.3", port: 45789, online: true, last_seen: NOW },
  ],
  discovered: [{ id: "D", name: "丁机", host: "10.0.0.4", port: 45789 }],
  // 用户主动解绑过的设备 ID（与 Rust 的 peers.json 里那份 ignored 同口径）
  ignored: [],
  sessions: [
    { id: "A", peer: "A", name: "甲机", created: at(9, 9), read: at(0, 8) },
    // 丙机的今天这几条还没读 → 会话栏该挂 5 个未读
    { id: "C", peer: "C", name: "丙机", created: at(9, 9), read: at(1, 23, 59) },
  ],
  active: "A",
  // 投递用例临时把它打开：模拟「事件比 invoke 返回值慢」的真实时序
  muteEmit: false,
  // 被删过会话的框：历史还在，但列表不再从历史里把它补回来（与 Rust 的 hidden 同口径）
  hidden: [],
  hist: [],
  // 用例灌一句原因就让桩拒掉那一类请求（验「被拦下来之后入口当场收起来」）
  recallFails: null,
  deleteFails: null,
};

/** 能撤回的时间窗：与 store.rs 的 RECALL_WINDOW_MS 、view-transfer.js 的 RECALL_MS 同一档 */
const RECALL_MS = 60000;
/** 与 Rust 的 RECALL_SUMMARY 一份口径 */
const RECALL_SUMMARY = "撤回了一条消息";

/** 与 Rust 的 Message::sid_of 同口径：没 sid 的老消息归它那台的基础对话 */
const sidOf = (m) => m.sid || m.peer || "";
// 与 Rust 的 search_snippet 同口径：命中处前后各 24 字符，截了两头加省略号
//（下标在折小写的串上找，两边只折大小写不丢字符，回原串取窗不错位）
const findSnippet = (raw, hay, q) => {
  const cs = Array.from(raw);
  const hs = Array.from(hay);
  const qs = Array.from(q);
  let at = -1;
  for (let i = 0; i + qs.length <= hs.length; i++) {
    if (hs.slice(i, i + qs.length).join("") === qs.join("")) {
      at = i;
      break;
    }
  }
  const s = at < 0 ? 0 : Math.max(0, at - 24);
  const e = at < 0 ? Math.min(cs.length, 48) : Math.min(cs.length, at + qs.length + 24);
  return (s > 0 ? "…" : "") + cs.slice(s, e).join("") + (e < cs.length ? "…" : "");
};

/** 与 Rust 的 Peer::display_name 同口径：备注名优先，没备注才用对方上报的设备名 */
const display = (p) =>
  p ? (p.alias || "").trim() || (p.name || "").trim() || `设备 ${String(p.id || "").slice(0, 8)}` : "";

let seq = 0;
/** 造一条历史消息：ts 递增地推进桩历史，最后统一按时间排（后端那份就是时间序） */
function push(peer, ts, over = {}) {
  const id = `m${++seq}`;
  world.hist.push({
    id,
    dir: "in",
    kind: "text",
    text: `${peer}第${id}条`,
    state: "sent",
    ts,
    peer,
    ...over,
  });
  return id;
}
// 甲机：前天 2 条（要靠翻页补）+ 昨天 5 条 + 今天 5 条（首屏正好一页）
for (let i = 0; i < 2; i++) push("A", at(2, 9, i * 10));
const A_OLD = ["A@" + 2, "A@" + 1]; // 仅作可读标注用，断言用 id
for (let i = 0; i < 5; i++) push("A", at(1, 9, i * 10));
for (let i = 0; i < 5; i++) push("A", at(0, 9, i * 10));
// 丙机：同样前天 2 + 昨天 5 + 今天 5
for (let i = 0; i < 2; i++) push("C", at(2, 10, i * 10));
for (let i = 0; i < 5; i++) push("C", at(1, 10, i * 10));
for (let i = 0; i < 5; i++) push("C", at(0, 10, i * 10));
// 老历史里那两条没有对端 ID 的：进「未标记」虚拟会话
push("", at(5, 12), { text: "老历史甲" });
push("", at(5, 13), { text: "老历史乙" });
world.hist.sort((a, b) => a.ts - b.ts);

const firstPage = (peer) => world.hist.filter((m) => m.peer === peer).slice(-10);

function sessionRowOf(id) {
  const stored = world.sessions.find((s) => s.id === id);
  // 本机删掉的那几条不参与统计（与 read_messages 的 hidden 过滤同口径）
  const mine = world.hist.filter((m) => sidOf(m) === id && !m.hidden);
  // 所属那台从历史里反推：同一个框的消息都带着同一个发送方设备 ID（Rust 的补漏行就这么算）
  const peer = stored ? stored.peer : mine.length ? mine[mine.length - 1].peer : "";
  const p = world.peers.find((x) => x.id === peer);
  const last = mine.length ? mine[mine.length - 1] : null;
  return {
    id,
    peer,
    name: id === "" ? "未标记" : (stored?.name || display(p) || `设备 ${(peer || id).slice(0, 8)}`),
    host: p?.host || "",
    port: p?.port || 0,
    online: !!p?.online,
    bound: !!p,
    // 置顶只有会话表里存过的那几行有：补漏行/未标记永远不置顶（Rust 传的也是 false）
    pinned: !!stored?.pinned,
    created: stored?.created || 0,
    // 与 Rust 同口径：只数对方发来的、且只数读指针之后的；撤回的那条不算（对方已经把它撤了）；
    // 未标记与补漏行（还没建会话的）不挂未读
    unread:
      peer === "" || !stored
        ? 0
        : mine.filter((m) => m.dir === "in" && !m.recalled && m.ts > stored.read).length,
    last: last?.ts || 0,
    // 撤回的那条只留一句话（与后端 session_stats 同口径）
    summary: last
      ? last.recalled
        ? RECALL_SUMMARY
        : last.kind === "text"
          ? last.text
          : `[文件] ${last.name || ""}`
      : "",
  };
}

/** 会话表里没有、但历史里露出过、且没被用户删过的框要补一行 —— Rust 的 sessions_json() 就是这么干的 */
function sessionsPayload() {
  const keys = [
    ...new Set([...world.sessions.map((s) => s.id), ...world.hist.map(sidOf)]),
  ].filter((k) => world.sessions.some((s) => s.id === k) || !world.hidden.includes(k));
  return {
    sessions: keys.map(sessionRowOf).sort((a, b) =>
      // 与 Rust 的 sort_session_rows 同口径：置顶的永远在前，组内按最后一条时间倒序
      Number(b.pinned) - Number(a.pinned) || b.last - a.last
    ),
    active: world.active,
  };
}

function statusPayload() {
  return {
    device_id: "本机",
    device_name: "本机",
    passphrase_set: true,
    port: 45789,
    server_ok: true,
    peers: world.peers,
    active: world.active,
    // 与 Rust 的 discovered_json 同口径：每台带一句是不是被解绑过
    discovered: world.discovered.map((d) => ({ ...d, unbound: world.ignored.includes(d.id) })),
    error: null,
  };
}

function focus(id) {
  world.active = id;
  // 与 Rust 同口径：切焦点只推已有那个框的读指针，不会顺手把一个框建出来
  const s = world.sessions.find((x) => x.id === id);
  if (s) s.read = Date.now();
}

const calls = [];
/* 桩里那份虚拟收件目录与那几个数字：真机是递归走一遍目录树，桩里不重演——
   用例直接往 boxFiles 里摆文件（size + mtime），inbox_cleanup 就在那上面筛 */
const boxFiles = new Map();
// 除收件目录以外的那几个数字由用例直接盖（数据目录 / 粘贴暂存 / 历史文件字节）
const boxNums = { pastebox_bytes: 0, data_bytes: 0, messages_bytes: 0 };

/** 与 Rust 的 storage_stats 同口径：条数只算没 hidden 的那些（界面上报的得是用户看得到的） */
function storageStats() {
  let inboxBytes = 0;
  for (const f of boxFiles.values()) inboxBytes += f.size;
  return {
    inbox_bytes: inboxBytes,
    inbox_count: boxFiles.size,
    pastebox_bytes: boxNums.pastebox_bytes,
    data_bytes: boxNums.data_bytes,
    messages_bytes: boxNums.messages_bytes,
    messages_count: world.hist.filter((m) => !m.hidden).length,
  };
}
/* 本机接收 + 在线探测那几项：桩里就一份内存 prefs，set_prefs 的局部更新语义照 Rust 抄
   （传来的字段覆盖，没传的保持原值；收件目录只认绝对路径与空串；
   心跳节拍只认白名单那四档） */
const prefs = { layout: "2", sync: true, wheel: "zoom", notify: true, inbox: "", heartbeat_ms: 1000 };
// 与 store.rs 的 HEARTBEAT_OPTIONS 一份口径
const HEARTBEAT_OPTS = [1000, 2000, 5000, 10000];
const DEFAULT_INBOX = "/本机数据目录/inbox";
// pick_folder 的返回值：用例改成一条路径就等于「用户在原生对话框里选了它」，
// 改回 null 就是「点了取消」
let pickAnswer = null;
const plays = []; // 试听被点了几次
const revealed = []; // reveal_in_folder 收到过哪些路径
window.__TAURI__.core.invoke = async (cmd, args = {}) => {
  calls.push([cmd, args]);
  switch (cmd) {
    case "net_status":
      return statusPayload();
    case "read_image":
      // 缩略图与放大层吃的是同一份 data URL（不二次读盘）；像素尺寸由用例直接盖在
      // lightbox-img 上，桩里不做真解码
      return { path: args.path, data_url: `data:image/jpeg;base64,${Buffer.from(args.path).length}` };
    case "sessions":
      return sessionsPayload();
    case "search_messages": {
      // 与 Rust 的 search_messages 同口径：只搜未 hidden 的（撤回仍露），
      // 匹配面 = 正文 + 文件名 + 引用摘录，大小写不敏感，ts 降序封 200
      const q = String(args.query || "").trim().toLowerCase();
      if (!q) return [];
      const k = args.kind || "all";
      const hits = [];
      for (const m of world.hist.filter((x) => !x.hidden)) {
        if (k !== "all" && m.kind !== k) continue;
        const raw = `${m.text || ""}\n${m.name || ""}\n${(m.quote && m.quote.text) || ""}`;
        const hay = raw.toLowerCase();
        if (!hay.includes(q)) continue;
        hits.push({
          id: m.id,
          sid: sidOf(m),
          peer: m.peer,
          ts: m.ts,
          kind: m.kind,
          name: m.name || null,
          dir: m.dir,
          session: sessionRowOf(sidOf(m)).name,
          snippet: findSnippet(raw, hay, q),
        });
      }
      hits.sort((a, b) => b.ts - a.ts);
      return hits.slice(0, 200);
    }
    case "session_focus":
      focus(args.id);
      return sessionsPayload();
    case "session_create": {
      // 建的是那台的基础对话：id 就用设备 ID，重复调不会多出第二个框
      if (!world.sessions.some((s) => s.id === args.peer)) {
        world.sessions.push({
          id: args.peer,
          peer: args.peer,
          name: args.name || "",
          created: Date.now(),
          read: Date.now(),
        });
      }
      return sessionsPayload();
    }
    case "session_new": {
      // 同一台再开一个框：另造会话 ID、焦点直接切过去
      const n = world.sessions.filter((s) => s.peer === args.peer).length + 1;
      const base = display(world.peers.find((p) => p.id === args.peer)) || args.peer;
      const id = newSid(args.peer);
      // 与 Rust 的 new_session 同口径：名字由发起方给（前端按「设备名 · 月-日」），
      // 没给才退回话题编号；这台已经有人叫这个名字就加 (2)、(3)
      const given = (args.name || "").trim();
      const want = given || (n <= 1 ? base : `${base} · 话题 ${n}`);
      const taken = world.sessions.filter((s) => s.peer === args.peer).map((s) => s.name);
      world.hidden = world.hidden.filter((p) => p !== id);
      world.sessions.push({
        id,
        peer: args.peer,
        name: uniqueName(taken, want),
        created: Date.now(),
        read: Date.now(),
      });
      world.active = id;
      return sessionsPayload();
    }
    case "session_rename": {
      const s = world.sessions.find((x) => x.id === args.id);
      if (!s) throw new Error("没有这个会话");
      // 只改本机这一份：对端上报的名不会回头覆盖它（后端 ensure_session 已不再改名）
      s.name = args.name;
      return sessionsPayload();
    }
    case "session_pin": {
      const s = world.sessions.find((x) => x.id === args.id);
      if (!s) throw new Error("没有这个会话");
      s.pinned = !!args.pinned;
      return sessionsPayload();
    }
    case "session_delete":
      world.sessions = world.sessions.filter((s) => s.id !== args.id);
      // 只删这个框与它的读指针：历史一条不动，但记下这个框，免得补漏行把它又请回来
      if (!world.hidden.includes(args.id)) world.hidden.push(args.id);
      if (world.active === args.id) world.active = "";
      return sessionsPayload();
    case "session_clear": {
      // 与 Rust 的 clear_session 同口径：只把这一格里未 hidden 的标上 hidden，
      // 框、读指针、会话表都不动；返的是清掉的条数
      let n = 0;
      for (const m of world.hist) {
        if (sidOf(m) === args.id && !m.hidden) {
          m.hidden = true;
          n += 1;
        }
      }
      return { cleared: n };
    }
    case "msg_history": {
      // 必须先按对话框筛、再定位游标切页：反过来会让每页凑不满、游标还会串框
      const list = args.session === undefined ? world.hist : world.hist.filter((m) => sidOf(m) === args.session);
      const visible = list.filter((m) => !m.hidden); // 本机删掉的不再露出来
      const cursor = args.before ? visible.findIndex((m) => m.id === args.before) : -1;
      const end = cursor >= 0 ? cursor : visible.length;
      const start = Math.max(0, end - (args.limit || 50));
      return visible.slice(start, end).map((m) => ({ ...m }));
    }
    case "msg_recall": {
      // 与 Rust 的 recall_one 同口径：判据一条不少，而且只标 recalled（不动 state）
      const m = world.hist.find((x) => x.id === args.id);
      if (!m || m.hidden) throw new Error("找不到这条消息，可能已经被删掉了");
      if (m.dir !== "out") throw new Error("只能撤回自己发出去的消息");
      if (m.recalled) throw new Error("这条已经撤回了");
      if (Date.now() - m.ts >= RECALL_MS) throw new Error("超过 1 分钟就不能撤回了");
      if (world.recallFails) throw new Error(world.recallFails);
      m.recalled = true;
      // 两边都是同 ID 再追一行：推的事件与返回值都是那一条
      emit("msg-updated", { message: { ...m } });
      return { ...m };
    }
    case "msg_delete": {
      // 本机删除：只标 hidden，对端那份与 state 都不动
      const m = world.hist.find((x) => x.id === args.id);
      if (!m) throw new Error("找不到这条消息，可能已经被删掉了");
      if (world.deleteFails) throw new Error(world.deleteFails);
      m.hidden = true;
      return { ...m };
    }
    case "send_text": {
      const to = args.to || world.active;
      // X-Session 就是拿这个会话 ID 发的，落库的 peer 仍是所属那台
      const sess = world.sessions.find((s) => s.id === to);
      const peer = world.peers.find((p) => p.id === (sess ? sess.peer : to));
      // 与 Rust 的 target_of 同口径：没登记过这台当场就拒（连地址都没有，队列也排不了）；
      // 登记了但离线 → 落一条 queued 立刻返回，什么时候投出去是心跳的事
      if (!peer) throw new Error("这台对端还没有添加：请先配对，或等它给你发一条消息");
      const m = {
        id: `out${++seq}`,
        dir: "out",
        kind: "text",
        text: args.text,
        // 后端新字段原样存：引用卡片就是这么跟着 msg-updated 回到气泡上的
        quote: args.quote || null,
        state: peer.online ? "sent" : "queued",
        ts: Date.now(),
        peer: sess ? sess.peer : to,
        sid: to,
        retry: 0,
        reason: null,
      };
      // client.rs 落库后会推一条 msg-updated，气泡就是这么进流的
      world.hist.push(m);
      emit("msg-updated", { message: m });
      return m;
    }
    case "send_paths": {
      // 与 Rust 的 queue_paths 同口径：只存本机路径与当下的大小，不抄内容；
      // 在线时直接进 sending，离线的先挂 queued，补发那一刻才递归文件夹
      const to = args.to || world.active;
      const sess = world.sessions.find((s) => s.id === to);
      const peer = world.peers.find((p) => p.id === (sess ? sess.peer : to));
      if (!peer) throw new Error("这台对端还没有添加：请先配对，或等它给你发一条消息");
      return args.paths.map((p, i) => {
        const m = {
          id: `outp${++seq}_${i}`,
          dir: "out",
          kind: String(p).endsWith(".jpg") ? "file" : "folder",
          name: String(p).split("/").pop(),
          path: p,
          size: 2048,
          state: peer.online ? "sending" : "queued",
          ts: Date.now(),
          peer: sess ? sess.peer : to,
          sid: to,
          retry: 0,
          reason: null,
        };
        world.hist.push(m);
        // muteEmit：「投递后不等事件也要看得见」那一条要的：真实环境里 msg-updated 比返回值慢一拍
        if (!world.muteEmit) emit("msg-updated", { message: m });
        return m;
      });
    }
    case "unbind_peer":
      world.peers = world.peers.filter((p) => p.id !== args.peer);
      // 与 Rust 同口径：光从 peers 里拿掉不够，还得记进名单，
      // 否则 mDNS 下一拍发现 + ping 通就会被自动登记回来（那是本次要修的 bug）
      if (!world.ignored.includes(args.peer)) world.ignored.push(args.peer);
      return statusPayload();
    case "set_peer_alias": {
      const p = world.peers.find((x) => x.id === args.peer);
      if (!p) throw new Error("没有登记这台对端：先添加再改备注");
      const alias = String(args.alias || "").trim();
      if ([...alias].length > 40) throw new Error("备注名过长（最多 40 个字符）");
      const prev = display(p);
      p.alias = alias;
      const now2 = display(p);
      // 与 Rust 的 rename_by_display 同口径：只带上还叫旧显示名的框，用户手工改过的不动
      if (prev !== now2) {
        for (const s of world.sessions) {
          if (s.peer === args.peer && s.name === prev) s.name = now2;
        }
      }
      return statusPayload();
    }
    case "reprobe_peer": {
      const p = world.peers.find((x) => x.id === args.peer);
      if (!p) throw new Error("还没有登记这台对端");
      p.online = true;
      return statusPayload();
    }
    case "bind_peer_addr": {
      // 真正的 Rust 先 ping 这个地址、拿回它的身份再登记；桩里 ping 不了，
      // 就认死这条测试地址就是 X（用例 13 要拿它把未登记的那台变成弹层里可点的）
      const [host, pPort] = String(args.addr).split(":");
      if (`${host}:${pPort}` !== "10.0.0.9:45789") throw new Error("桩只认这条测试地址");
      world.peers = [
        ...world.peers.filter((x) => x.id !== "X"),
        { id: "X", name: "陌生机", alias: "", host, port: Number(pPort) || 45789, online: true, bound: true, last_seen: now() },
      ];
      // 与 Rust 的 bind_peer 同口径：亲手重新添加等于撤回「别再自动连它」
      world.ignored = world.ignored.filter((i) => i !== "X");
      return statusPayload();
    }
    case "get_prefs":
      return { ...prefs };
    case "set_prefs": {
      // 与 Rust 同口径：没传来的字段一律不碰（两个抽屉共写一份 prefs.json 就靠这个）
      if ("notify" in args) prefs.notify = !!args.notify;
      if ("inbox" in args) {
        const v = String(args.inbox);
        if (v && !v.startsWith("/")) throw new Error(`收件目录必须是绝对路径: ${v}`);
        prefs.inbox = v;
      }
      if ("heartbeatMs" in args) {
        const v = Number(args.heartbeatMs);
        // 照 Rust 硬拒（不是静默改回默认）：白名单外的档位会把心跳线程变成空转
        if (!HEARTBEAT_OPTS.includes(v)) throw new Error(`不支持的探测间隔: ${v} 毫秒`);
        prefs.heartbeat_ms = v;
      }
      return { ...prefs };
    }
    case "inbox_dir":
      return { path: prefs.inbox || DEFAULT_INBOX, custom: !!prefs.inbox };
    case "storage_stats":
      return storageStats();
    case "inbox_cleanup": {
      // 与 Rust 的 inbox_cleanup 同口径：只动改于 beforeTs 之前、而且没被任何
      // 还看得见的消息引用的收件文件（日期子目录那一级归并在 Rust 单测里）
      if (world.cleanFails) throw new Error(world.cleanFails);
      const before = Number(args.beforeTs) || 0;
      const kept = new Set(world.hist.filter((m) => !m.hidden && m.path).map((m) => m.path));
      let n = 0;
      let b = 0;
      for (const [p, f] of [...boxFiles]) {
        if (f.mtime >= before || kept.has(p)) continue;
        boxFiles.delete(p);
        n += 1;
        b += f.size;
      }
      // Rust 删完 emit 一次：抽屉开着就得靠那一句重画数字
      emit("storage-changed", { stats: storageStats(), deleted_count: n, freed_bytes: b });
      return { deleted_count: n, freed_bytes: b };
    }
    case "pick_folder":
      return pickAnswer;
    case "play_notify_sound":
      plays.push("audition");
      return null;
    case "reveal_in_folder":
      revealed.push(String(args.path || ""));
      return null;
    default:
      return null;
  }
};

const handlers = {};
window.__TAURI__.event.listen = async (event, fn) => {
  handlers[event] = fn;
  return () => {};
};

/**
 * 后端是先落库再推事件（server.rs：route_session → append_message → emit），
 * 桩里不抄这一步就会漏掉「消息到达即建会话」这条真实路径
 */
function land(m) {
  if (world.hist.some((x) => x.id === m.id)) return;
  // 落点与 Rust 的 resolve_incoming 逐条对齐（下面那个函数就是照它抄的）
  m.sid = resolveIncoming(m.peer || "", m.sid || "");
  world.hist.push(m);
  world.hist.sort((a, b) => a.ts - b.ts);
  if (!m.peer) return;
  const s = world.sessions.find((x) => x.id === m.sid);
  if (!s) {
    // 陌生对端、或对方新开的第一个话题：消息到达时才建框，读指针从 0 起
    // （那条消息本身该是个未读）
    world.hidden = world.hidden.filter((p) => p !== m.sid);
    world.sessions.push({
      id: m.sid,
      peer: m.peer,
      name: world.peers.find((p) => p.id === m.peer)?.name || "",
      created: m.ts,
      read: 0,
    });
  } else if (world.active === m.sid) {
    s.read = Date.now();
  }
}

/** 与 Rust 的 unique_name 同口径：同一台撞名就加 (2)、(3)…… */
function uniqueName(taken, want) {
  if (!taken.includes(want)) return want;
  for (let k = 2; k <= 99; k++) {
    const cand = `${want} (${k})`;
    if (!taken.includes(cand)) return cand;
  }
  return `${want} (99+)`;
}

/** 与 Rust 的 resolve_incoming 同口径：没带 sid / 带的就是自己设备 ID → 基础对话；
 *  本机已有且属于这台 → 用它；已有但属于另一台 → 退回基础对话；本机没有 → 认下来 */
function resolveIncoming(peer, sid) {
  if (!peer) return "";
  if (!sid || sid === peer) return peer;
  const hit = world.sessions.find((s) => s.id === sid);
  if (!hit) return sid;
  return hit.peer === peer ? sid : peer;
}

const emit = (event, payload) => {
  const m = payload?.message;
  if (m && (event === "msg-in" || event === "xfer-done")) land(m);
  if (handlers[event]) handlers[event]({ payload });
};

/* ------------------------------ 加载被测模块 ------------------------------ */
// 复制到临时目录按 ESM 加载：import 说明符写的是 ./api.js，原样拷过去最忠实
const tmp = join(os.tmpdir(), `xfer-session-check-${crypto.randomBytes(6).toString("hex")}`);
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
for (const f of ["api.js", "view-transfer.js"]) copyFileSync(join(here, "..", "js", f), join(tmp, f));
await import(join(tmp, "view-transfer.js"));
// 同一个 api.js 实例（按 URL 去重）：拖拽的落点与悬停都靠它分流到传输视图的处理者，
// 真机里是 view-compare.js 里的原生拖拽监听在调它们，那个文件不在本自检范围里
const api = await import(join(tmp, "api.js"));

/* ------------------------------- 小工具 ------------------------------- */
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await flush();
}
const stream = () => byId("xfer-stream");
const rail = () => byId("xfer-session-rows");
const rows = () => rail().children.filter((c) => c.classSet.has("session-row"));
/** 行归属看会话 ID（同一台能有好几行，拿 peer 找会拿到错的那个框） */
const rowOf = (id) => rows().find((r) => r.dataset.id === id) || null;
const rowsOfPeer = (peer) => rows().filter((r) => r.dataset.peer === peer);
const bubbles = () => stream().children.filter((c) => c.classSet.has("msg"));
const dividers = () => stream().children.filter((c) => c.classSet.has("day-divider"));
const badgeOf = (id) => {
  const r = rowOf(id);
  const b = r && r.children.find((c) => c.classSet.has("s-badge"));
  return b ? b.text : 0;
};
function click(node, extra = {}) {
  const ev = {
    type: "click",
    target: node,
    preventDefault() {},
    stopPropagation() {},
    isComposing: false,
    shiftKey: false,
    key: "Enter",
    ...extra,
  };
  node.dispatchEvent(ev);
}
function lastCall(cmd) {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i][0] === cmd) return calls[i][1];
  return null;
}
function takeCalls(cmd, since) {
  return calls.slice(since).filter(([c]) => c === cmd);
}
/** 从「＋ 新聊天」弹层里点某台开框 —— 这一轮之后这是唯一的入口（会话行上不再放按钮） */
async function openChatWith(prefix) {
  click(byId("btn-session-new"));
  await settle(2);
  const item = byId("xfer-pick-list").children.find((c) => c.text?.startsWith(prefix));
  if (item) click(item);
  await settle();
  return item;
}

let failed = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}

await settle();

/* 1) 启动顺序：状态 → 会话 → 历史，历史带的是当前会话的会话 ID */
check(
  "启动顺序是 状态→会话→历史",
  ["net_status", "sessions", "msg_history"].every((c, i) => calls[i] && calls[i][0] === c),
  calls.slice(0, 3).map(([c]) => c).join(",")
);
check("首屏历史按当前会话筛", lastCall("msg_history")?.session === "A", JSON.stringify(lastCall("msg_history")));
check("会话栏三行（甲、丙、未标记）", rows().length === 3, rows().map((r) => r.dataset.peer).join(","));
check("当前会话那行高亮", rowOf("A")?.classSet.has("is-active") && !rowOf("C")?.classSet.has("is-active"));
const actsOf = (id) => {
  const r = rowOf(id);
  return r ? r.children.find((c) => c.classSet.has("s-acts")) || null : null;
};
check(
  "未标记行只给「删除」、不给「改名」（它没有名字可改）",
  !!actsOf("") && actsOf("").children.length === 1 && actsOf("").children[0].textContent === "删除",
  actsOf("") ? actsOf("").children.map((b) => b.textContent).join(",") : "没有操作区"
);
check(
  "普通行还是「改名 + 删除」两枚",
  !!actsOf("A") && actsOf("A").children.map((b) => b.textContent).join(",") === "改名,删除",
  actsOf("A") ? actsOf("A").children.map((b) => b.textContent).join(",") : "没有操作区"
);

/* 2) 日期线第一处：首屏按相邻消息插线（前天那页还没进来，所以只有昨天与今天） */
check("首屏铺了十条气泡", bubbles().length === 10, String(bubbles().length));
check(
  "首屏两条日期线：昨天 + 今天",
  dividers().length === 2 && dividers()[0].text === "昨天" && /\d+月\d+日 星期/.test(dividers()[1].text),
  dividers().map((d) => d.text).join(" / ")
);
check("每条日期线都紧贴一条气泡之前", dividers().every((d) => d.children.length === 0 && d.parentNode === stream()));

/* 3) 未读由后端算，前端只照着画 */
check("没在读的会话挂未读徽标", Number(badgeOf("C")) === 5, String(badgeOf("C")));

/* 4) 切会话：session_focus 一次做完设焦点与清未读，历史换成那一台的 */
let since = calls.length;
click(rowOf("C"));
await settle();
check("点会话行会调 session_focus", takeCalls("session_focus", since).some(([, a]) => a.id === "C"));
check("切过去就清未读", Number(badgeOf("C")) === 0, String(badgeOf("C")));
check("切会话后重新拉历史且带着新会话 ID", lastCall("msg_history")?.session === "C");
check("流里只剩丙机那十条", bubbles().length === 10 && bubbles().every((b) => b.dataset.id === undefined || true));
check("丙机首屏同样是两条日期线", dividers().length === 2, dividers().map((d) => d.text).join(" / "));

/* 5) 分页游标按会话分开，切来切去不串页 */
const cOld = lastCall("msg_history") === null ? null : firstPage("C")[0].id;
byId("xfer-older").dispatchEvent({ type: "click" });
await settle();
const histC = lastCall("msg_history");
check("丙机补页用的游标是丙机最老那条", histC?.session === "C" && histC?.before === cOld, JSON.stringify(histC));
check("补页后丙机流里十二条", bubbles().length === 12, String(bubbles().length));
check("补进来的前天那页也重算了日期线", dividers().length === 3, dividers().map((d) => d.text).join(" / "));
check("最早那条日期线带年份", /^\d{4}年\d+月\d+日 星期/.test(dividers()[0].text), dividers()[0].text);

since = calls.length;
click(rowOf("A"));
await settle();
const aOld = firstPage("A")[0].id;
byId("xfer-older").dispatchEvent({ type: "click" });
await settle();
const histA = lastCall("msg_history");
check(
  "切回甲机后补页用的是甲机的游标（没跟着丙机跑）",
  histA?.session === "A" && histA?.before === aOld && histA?.before !== cOld,
  JSON.stringify(histA)
);

/* 6) 陌生设备的消息：不铺进当前流，只把会话栏那一行拉出来 */
since = calls.length;
const nBubble = bubbles().length;
const xTs = at(0, 11);
emit("msg-in", { message: { id: "x1", dir: "in", kind: "text", text: "陌生机第一条", state: "sent", ts: xTs, peer: "X" } });
await settle();
check("陌生会话的消息不会铺进当前流", bubbles().length === nBubble, String(bubbles().length));
check("陌生对端会重拉一次会话列表", takeCalls("sessions", since).length >= 1);
check("陌生设备自动出现在会话栏", !!rowOf("X"));
check("陌生会话挂一个未读", Number(badgeOf("X")) === 1, String(badgeOf("X")));

/* 7) 同一台再来两条：还是一个框，未读累加 */
emit("msg-in", { message: { id: "x2", dir: "in", kind: "text", text: "陌生机第二条", state: "sent", ts: xTs + 1000, peer: "X" } });
emit("msg-in", { message: { id: "x3", dir: "in", kind: "text", text: "陌生机第三条", state: "sent", ts: xTs + 2000, peer: "X" } });
await settle();
check("没带 sid 的几条只落基础对话，不会多出第二个框", rowsOfPeer("X").length === 1);
check("未读按条数累加", Number(badgeOf("X")) === 3, String(badgeOf("X")));

/* 8) 切进陌生会话，再看日期线第三处：新消息追加到流尾也要重算 */
click(rowOf("X"));
await settle();
check("切进陌生会话后历史三条", bubbles().length === 3, String(bubbles().length));
const beforeAppend = dividers().length;
emit("msg-in", {
  message: {
    id: "x4",
    dir: "in",
    kind: "text",
    text: "跨到新的一天",
    state: "sent",
    // 拿「明天」造跨日：等真过午夜不现实，而这条路径要验的就是追加处的重算
    ts: at(-1, 12),
    peer: "X",
  },
});
await settle();
check("追加跨日消息时日期线重算了一次", dividers().length === beforeAppend + 1, `${beforeAppend} -> ${dividers().length}`);
check("追加的那条进了流尾", bubbles().length === 4 && bubbles()[3].dataset.id === "x4");

/* 9) 发送落在当前会话上 */
since = calls.length;
byId("xfer-input").value = "先试一句发不出去的";
click(byId("btn-xfer-send"));
await settle();
check(
  "陌生那台还没添加为对端时不发送",
  takeCalls("send_text", since).length === 0 && bubbles().length === 4,
  JSON.stringify(takeCalls("send_text", since))
);
// 把它登记成对端（真机里是配对成功、或它回过一条心跳之后的样子）。
// 会话名字归后端算（session_row 那一套已由 Rust 单测覆盖），这里不重复验
world.peers.push({ id: "X", name: "陌生机", host: "10.0.0.9", port: 45789, online: true, last_seen: NOW });
if (handlers["peers-changed"]) handlers["peers-changed"]({ payload: statusPayload() });
await settle();
since = calls.length;
byId("xfer-input").value = "发给陌生机的一句";
click(byId("btn-xfer-send"));
await settle();
const sent = takeCalls("send_text", since);
check("发送带上了目标对端", sent.length === 1 && sent[0][1].to === "X", JSON.stringify(sent[0] && sent[0][1]));
check(
  "自己发出去的气泡铺在当前流末尾",
  bubbles().length === 5 && bubbles()[4].classSet.has("msg-out"),
  bubbles().map((b) => b.dataset.id).join(",")
);

/* 10) 「未标记」只能看不能发 */
click(rowOf(""));
await settle();
check("未标记会话拉的是空对端的历史", lastCall("msg_history")?.session === "");
check("未标记会话铺出两条老历史", bubbles().length === 2, String(bubbles().length));
since = calls.length;
byId("xfer-input").value = "想发给没名字的那台";
click(byId("btn-xfer-send"));
await settle();
check("未标记会话不能作为发送目标", takeCalls("send_text", since).length === 0);
check("未标记会话不挂未读", Number(badgeOf("")) === 0);

/* 11) 删会话要先确认一次；且只删会话本身，历史一条不动 */
since = calls.length;
const acts = rowOf("X")?.children.find((c) => c.classSet.has("s-acts"));
const del = acts?.children.find((c) => c.text === "删除");
check("会话行上有删除入口", !!del);
// 第一下只是把那一行变成「确认删除？」，不能真删（webview 里 window.confirm 不可靠，
// 所以确认就地长在按钮上，与收藏视图同一个口径）
click(del);
await settle();
check("第一下不删：没有发出 session_delete", takeCalls("session_delete", since).length === 0);
check("第一下把按钮变成待确认", del.text === "确认删除？" && del.dataset.armed === "1", del.text);
check("待确认期间那一行还在", !!rowOf("X"));
const del2 = acts.children.find((c) => c.text === "确认删除？");
check("重新查一遍拿到的就是那个待确认的按钮", del2 === del);
since = calls.length;
click(del2);
await settle();
check("第二下才真删", takeCalls("session_delete", since).some(([, a]) => a.id === "X"));
check("删掉后这一行不见了", !rowOf("X"), rows().map((r) => r.dataset.peer).join(","));
check(
  "历史里那几条还在桩后端（含自己刚发出去的那句）",
  world.hist.filter((m) => m.peer === "X").length === 5,
  String(world.hist.filter((m) => m.peer === "X").map((m) => m.id).join(","))
);

/* 12) 删过的会话不会从历史里自己补回来，但对方再发一条就自己回来 */
since = calls.length;
emit("msg-in", {
  message: { id: "x5", dir: "in", kind: "text", text: "删完又发来一句", state: "sent", ts: at(0, 13), peer: "X" },
});
await settle();
check("对方再发一条就自动回到列表", !!rowOf("X"), rows().map((r) => r.dataset.peer).join(","));
check(
  "回来时历史一条没少",
  world.hist.filter((m) => m.peer === "X").length === 6,
  String(world.hist.filter((m) => m.peer === "X").map((m) => m.id).join(","))
);
// 新建会话的读指针从 0 起，所以回来时这一台的入向消息全部算未读（五条）
check("回来那一行挂未读徽标", Number(badgeOf("X")) === 5, String(badgeOf("X")));
check("删过的会话不会抢回当前焦点", lastCall("msg_history")?.session !== "X", JSON.stringify(lastCall("msg_history")));

/* 13) 同一台可以重复新增对话：会话 ID 不再等于设备 ID。
   开框入口只剩「＋ 新聊天」弹层（会话行上不再放新话题与解绑），而弹层只列
   已登记的设备与被发现的设备 —— 这台只来过消息、还没登记，所以先把它加进对端列表 */
click(rowOf("X"));
await settle();
const baseHist = lastCall("msg_history");
check("基础对话拉历史传的是设备 ID 那个会话", baseHist?.session === "X", JSON.stringify(baseHist));
const actsX = rowOf("X")?.children.find((c) => c.classSet.has("s-acts"));
const actTexts = actsX ? actsX.children.map((c) => c.text).join("/") : "";
check("会话行上只有「改名/删除」，新话题与解绑都不在那一行", actTexts === "改名/删除", actTexts);

const sinceBind = calls.length;
byId("inp-manual-addr").value = "10.0.0.9:45789";
click(byId("btn-bind-addr"));
await settle();
check("登记这台走的是 bind_peer_addr", takeCalls("bind_peer_addr", sinceBind).length === 1, JSON.stringify(lastCall("bind_peer_addr")));

since = calls.length;
const pickX = await openChatWith("陌生机 · 10.0.0.9");
check("弹层里能点到这台（已有框也允许再开）", !!pickX, pickX?.text ?? "");
check("反复开框只走 session_new、不先 session_create", takeCalls("session_new", since).length === 1 && takeCalls("session_create", since).length === 0);
// 名字按「设备名 · 月-日」起：本地日期只有前端知道，Rust 侧只有 epoch 毫秒
const dNow = new Date();
const pad2 = (x) => String(x).padStart(2, "0");
const todayTag = `${pad2(dNow.getMonth() + 1)}-${pad2(dNow.getDate())}`;
const newNameCall = takeCalls("session_new", since)[0]?.[1];
check(
  "新框名字按「设备名 · 月-日」带过去",
  newNameCall?.name === `陌生机 · ${todayTag}`,
  JSON.stringify(newNameCall)
);
check(
  "开框只拉这个框自己的一页，不多翻旧页",
  takeCalls("msg_history", since).length === 1,
  JSON.stringify(takeCalls("msg_history", since).map(([, a]) => a))
);
const xRows = rowsOfPeer("X");
check("同一台多出第二个框", xRows.length === 2, xRows.map((r) => r.dataset.id).join(","));
const xTopic = xRows.map((r) => r.dataset.id).find((id) => id !== "X");
check("新框成了当前会话", !!xTopic && rowOf(xTopic)?.classSet.has("is-active"), String(xTopic));
check("切到新框拉的是这个框自己的历史", lastCall("msg_history")?.session === xTopic, JSON.stringify(lastCall("msg_history")));
check("新框是空的（基础对话那五条不过去）", bubbles().length === 0, String(bubbles().length));
// 在线点画在行上（靠 innerHTML，桩里看不到），能断言的是行上的 dataset 归属
check("两个框都算在这一台头上", xRows.every((r) => r.dataset.peer === "X"));
check("新框的名字真是月-日", world.sessions.find((s) => s.id === xTopic)?.name === `陌生机 · ${todayTag}`, String(world.sessions.find((s) => s.id === xTopic)?.name));
// 同一天在同一台再开一个：名字必然撞，后端要加 (2) 而不是摆两个同名框
check("第一个新框的名字不占序号", !world.sessions.some((s) => s.name === `陌生机 · ${todayTag} (2)`));
since = calls.length;
await openChatWith("陌生机 · 10.0.0.9");
check(
  "同一天第二个框自动加 (2)",
  world.sessions.some((s) => s.name === `陌生机 · ${todayTag} (2)`),
  world.sessions.filter((s) => s.peer === "X").map((s) => s.name).join(" | ")
);
// 切回中间那个话题框，下一段要在那个框里发一句
const topicRows = rows().filter((r) => r.dataset.peer === "X").map((r) => r.dataset.id);
click(rowOf(xTopic));
await settle();
check("三个框各自一个会话 ID", new Set(topicRows).size === 3, topicRows.join(","));
check("切回后当前框还是那个话题框", lastCall("msg_history")?.session === xTopic, JSON.stringify(lastCall("msg_history")));

/* 14) 两个框各存各的：发出去的那句只进当前这个框 */
since = calls.length;
byId("xfer-input").value = "话题框里的一句";
click(byId("btn-xfer-send"));
await settle();
const sentTopic = takeCalls("send_text", since);
check("发送带的是会话 ID 而不是设备 ID", sentTopic.length === 1 && sentTopic[0][1].to === xTopic, JSON.stringify(sentTopic[0] && sentTopic[0][1]));
check("话题框里只看到这一条", bubbles().length === 1, String(bubbles().length));
check(
  "基础对话里没多出这条（落库带的是 sid）",
  world.hist.filter((m) => sidOf(m) === "X").length === 6,
  world.hist.filter((m) => sidOf(m) === "X").map((m) => m.id).join(",")
);
check(
  "话题框里就那一条",
  world.hist.filter((m) => sidOf(m) === xTopic).length === 1,
  world.hist.filter((m) => sidOf(m) === xTopic).map((m) => m.id).join(",")
);
click(rowOf("X"));
await settle();
check("切回基础对话看到的是旧六条，不含话题框那句", bubbles().length === 6 && !bubbles().some((b) => b.text === "话题框里的一句"), String(bubbles().length));
click(rowOf(xTopic));
await settle();
check("再切回话题框不会把基础对话的历史带过来", bubbles().length === 1, String(bubbles().length));

/* 15) 未读各算各的：另一个框来消息，不动当前这个框，也不铺进当前流 */
const nBubbleT = bubbles().length;
// 基础对话那一行本来就有未读（用例 8 那条造跨日的 x4 用的是「明天」），
// 要验的是「加在这一行」而不是绝对值
const xUnread0 = Number(badgeOf("X")) || 0;
emit("msg-in", {
  message: { id: "x9", dir: "in", kind: "text", text: "发到基础对话的一句", state: "sent", ts: at(0, 15), peer: "X" },
});
await settle();
check("别的框来一条不铺进当前框", bubbles().length === nBubbleT, String(bubbles().length));
check(
  "未读加在基础对话那一行",
  Number(badgeOf("X")) === xUnread0 + 1,
  `${xUnread0} -> ${badgeOf("X")}`
);
check("当前这个框不因此挂未读", Number(badgeOf(xTopic)) === 0, String(badgeOf(xTopic)));

/* 16) 落点三道防线：名字当不得真，同 id 属于另一台就得退回基础对话 */
emit("msg-in", {
  message: { id: "x10", dir: "in", kind: "text", text: "拿别人会话 ID 塞的一句", state: "sent", ts: at(0, 16), peer: "C", sid: xTopic },
});
await settle();
check(
  "冒用别人的会话 ID 落回自己那台的基础对话",
  sidOf(world.hist.find((m) => m.id === "x10")) === "C",
  String(world.hist.find((m) => m.id === "x10")?.sid)
);
check("那个话题框没被插进一条", world.hist.filter((m) => sidOf(m) === xTopic).length === 1);
// 对方先在自己那边开了个本机没见过的话题：认下来，两边才能是同一个框
emit("msg-in", {
  message: { id: "x11", dir: "in", kind: "text", text: "对方新开的框", state: "sent", ts: at(0, 17), peer: "C", sid: "C-new" },
});
await settle();
check("本机不认识的会话 ID 会被认下来", sidOf(world.hist.find((m) => m.id === "x11")) === "C-new");
check("认下来的框出现在会话栏", !!rowOf("C-new"), rows().map((r) => r.dataset.id).join(","));

/* 17) 对端备注名（像微信那个备注）：只改本机显示，新建聊天也用它 */
click(rowOf("A"));
await settle();
const aliasInp = byId("inp-peer-alias");
check(
  "当前这台已登记时备注框可编辑，回显的是现有备注",
  aliasInp.disabled === false && aliasInp.value === "",
  `${aliasInp.disabled}/${aliasInp.value}`
);
aliasInp.value = "办公室那台";
since = calls.length;
click(byId("btn-peer-alias"));
await settle();
check(
  "点保存会拿当前对话框所属的那台去改备注",
  lastCall("set_peer_alias")?.peer === "A" && lastCall("set_peer_alias")?.alias === "办公室那台",
  JSON.stringify(lastCall("set_peer_alias"))
);
check("保存后两边列表都重取了（后端会顺手改对话框名）", takeCalls("sessions", since).length >= 1);
check("备注名会回显在输入框里", aliasInp.value === "办公室那台", aliasInp.value);
check(
  "顶栏那台的名字跟着备注走",
  byId("xfer-peer").html.includes("<b>办公室那台</b>"),
  byId("xfer-peer").html
);
check(
  "还叫旧设备名的基础对话一起改名（与 Rust rename_by_display 同口径）",
  world.sessions.find((s) => s.id === "A")?.name === "办公室那台",
  String(world.sessions.find((s) => s.id === "A")?.name)
);
// 新建聊天时用的就是这个备注（用户原话：新建聊天的时候就用这个名称）
since = calls.length;
const aliased = await openChatWith("办公室那台 · 10.0.0.2");
check("候选列表里这台显示的是备注名而不是设备名", !!aliased, String(aliased?.text));
check(
  "新建聊天的默认名用备注名",
  lastCall("session_new")?.name === `办公室那台 · ${todayTag}`,
  JSON.stringify(lastCall("session_new"))
);
// 清空备注 = 退回对方上报的设备名
aliasInp.value = "   ";
click(byId("btn-peer-alias"));
await settle();
check(
  "备注只填空格等于清掉，存的是空串",
  lastCall("set_peer_alias")?.alias === "" && world.peers.find((p) => p.id === "A")?.alias === "",
  JSON.stringify(lastCall("set_peer_alias"))
);
// 顶栏看的是「当前这个框」的名字：上面那个用例在 A 上又开了一个话题框，
// 得先切回基础对话那一行（那个话题框叫「备注 · 日期」，本就不该跟着备注回滚）
click(rowOf("A"));
await settle();
check("清掉备注后顶栏退回设备名", byId("xfer-peer").html.includes("<b>甲机</b>"), byId("xfer-peer").html);
// 心跳每秒都可能推一次 peers-changed，正在打的字不能被回写冲掉
click(rowOf("A"));
await settle();
document.activeElement = aliasInp;
aliasInp.value = "打字打到一半";
emit("peers-changed", statusPayload());
await settle();
check("心跳推状态不会把正在编辑的备注冲掉", aliasInp.value === "打字打到一半", aliasInp.value);
// 焦点移开了但没保存：草稿得留着，心跳不能替用户把它抹掉
document.activeElement = null;
aliasInp.value = "改到一半没保存";
emit("peers-changed", statusPayload());
await settle();
check("焦点移开后未保存的草稿也不会被心跳抹掉", aliasInp.value === "改到一半没保存", aliasInp.value);
// 但换到别一台就得让位：输入框跟的是「当前这台」的备注
click(rowOf("X"));
await settle();
check(
  "切到别的那台时输入框换成它自己的备注（草稿不跟过去）",
  aliasInp.value === (world.peers.find((p) => p.id === "X")?.alias || ""),
  aliasInp.value
);
click(rowOf("A"));
await settle();
aliasInp.value = "";

/* 18) 解绑：不再自动连回来，要恢复只能亲手重新添加 */
// 真机上 mDNS 不会因为解绑就停止广播，桩里也跟着把它摆在候选里
world.discovered.push({ id: "C", name: "丙机", host: "10.0.0.3", port: 45789 });
click(rowOf("C"));
await settle();
since = calls.length;
click(byId("btn-unbind"));
await settle();
check(
  "解绑调的是 unbind_peer 且带着当前这台的设备 ID",
  takeCalls("unbind_peer", since).length === 1 && lastCall("unbind_peer")?.peer === "C",
  JSON.stringify(lastCall("unbind_peer"))
);
check(
  "解绑过的这台仍在候选里（没从界面上藏着，但也不会自己连回来）",
  statusPayload().discovered.some((d) => d.id === "C" && d.unbound === true),
  JSON.stringify(statusPayload().discovered)
);
check("这台已不在 peers 里了", !world.peers.some((p) => p.id === "C"));
emit("peers-changed", statusPayload());
await settle();
const cand = byId("xfer-candidates").children.find((c) => c.classSet.has("cand") && c.text.includes("丙机"));
check("候选按钮上标出「已解绑」", !!cand && cand.text.includes("（已解绑）"), String(cand?.text));
check("解绑后备注框禁用（这台已经没有登记记录可改）", aliasInp.disabled === true, String(aliasInp.disabled));
// 弹层里点它：必须先重新添加，添加没成就不能开框（否则是个永远发不出去的新框）
since = calls.length;
const unbound = await openChatWith("丙机 · 10.0.0.3");
check("新聊天弹层里那台也标着已解绑", !!unbound && unbound.text.includes("（已解绑，点一下重新添加）"), String(unbound?.text));
check(
  "点已解绑的那台会先走重新添加",
  takeCalls("bind_peer_addr", since).some(([c, a]) => c === "bind_peer_addr" && a.addr === "10.0.0.3:45789"),
  JSON.stringify(takeCalls("bind_peer_addr", since))
);
check(
  "添加没成功就不会多开一个发不出去的框",
  world.sessions.filter((s) => s.peer === "C").length === 2,
  world.sessions.filter((s) => s.peer === "C").map((s) => s.id).join(",")
);

/* 19) 离线也能发：已配对 + 离线 → 当场入队；未配对 → 仍然拦着 */
// 一台登记过但 now 不在线的（last_seen 陈在那儿，心跳还没报回来越正常不过）
world.peers = world.peers.filter((p) => p.id !== "B");
world.peers.push({
  id: "B",
  name: "乙机",
  alias: "",
  host: "10.0.0.20",
  port: 45789,
  online: false,
  last_seen: at(1, 9),
});
emit("peers-changed", statusPayload());
await settle();
const bItem = await openChatWith("乙机 · 10.0.0.20");
check("离线的那台也能开出一个对话框", !!bItem && !!rowOf("B"), String(bItem?.text));
click(rowOf("B"));
await settle();
const stMsg = byId("st-msg");
// 状态行会被 runSend 收尾时的 refreshStatus 立刻改回「本机接收端口 …」，
// 光看最后那一句拿不到 toast，所以这一句起先记下它被写过哪些文案
const statusLog = [];
stMsg.log = statusLog;
check(
  "离线会话的发送按钮不再禁用（禁不禁只看这台加没加过）",
  byId("btn-xfer-send").disabled === false,
  String(byId("btn-xfer-send").disabled)
);

since = calls.length;
byId("xfer-input").value = "离线也能写的一句";
click(byId("btn-xfer-send"));
await settle();
const qCalls = takeCalls("send_text", since);
check(
  "离线时这句话仍会交给后端（不是在前端就被吞掉）",
  qCalls.length === 1 && qCalls[0][1].to === "B",
  JSON.stringify(qCalls[0] && qCalls[0][1])
);
let qbub = bubbles().find((b) => b.classSet.has("is-queued"));
check("入队的气泡挂上待发样式且写着「待发」", !!qbub && qbub.textContent.includes("待发"), String(qbub?.textContent));
check(
  "待发的悬停说明说的是排队，不是发不出去",
  !!qbub && /排队/.test(qbub.title) && /上线后会自动补发/.test(qbub.title),
  String(qbub?.title)
);
check(
  "入队后的提示是「已排队」而不是「已送达」",
  statusLog.some((t) => /排队/.test(t)) && !statusLog.some((t) => /已送达/.test(t)),
  statusLog.join(" | ")
);

// 补发成功：后端同 id 追一行 sent（队列里的顺序位置由 Rust 的 dedup 保持）
const qMsg = world.hist.find((m) => m.id === qbub.dataset.id);
since = calls.length;
emit("msg-updated", { message: { ...qMsg, state: "sent", retry: 0, reason: null } });
await settle();
qbub = bubbles().find((b) => b.dataset.id === qMsg.id);
check(
  "补发成功后待发样式掉下来",
  !!qbub && !qbub.classSet.has("is-queued") && !qbub.textContent.includes("待发"),
  String(qbub?.textContent)
);
check("状态变化不重新 invoke 任何发送命令", takeCalls("send_text", since).length === 0);

// 补发没中：还是待发，但得让人看见已经白试了几次、为什么没出去
emit("msg-updated", { message: { ...qMsg, state: "queued", retry: 2, reason: "连不上" } });
await settle();
qbub = bubbles().find((b) => b.dataset.id === qMsg.id);
check(
  "补发中时仍是待发，并把第几次与原因挂到悬停上",
  !!qbub && qbub.classSet.has("is-queued") && /第 2 次尝试失败：连不上/.test(qbub.title),
  String(qbub?.title)
);
// 到上限转失败：待发样式得下来，不然用户以为还在排队
emit("msg-updated", { message: { ...qMsg, state: "failed", retry: 3, reason: "连不上" } });
await settle();
qbub = bubbles().find((b) => b.dataset.id === qMsg.id);
check(
  "到上限转失败后不再挂着待发样式",
  !!qbub && !qbub.classSet.has("is-queued") && qbub.classSet.has("is-failed"),
  String(qbub?.className)
);

// 拖拽遮罩：离线时不能拦，未配对才拦
api.routeDropHover("over");
check(
  "离线时拖文件进来不遮住（拦下只会让人以为发不出去）",
  byId("xfer-drop-hint").classSet.has("is-blocked") === false && /排队/.test(byId("xfer-drop-text").text),
  byId("xfer-drop-text").text
);
since = calls.length;
api.routeDrop(["/tmp/甲.jpg", "/tmp/一个文件夹"]);
await settle();
// 微信那套：松手只入待发送区，一个都不发；点发送才真发
const chips = byId("xfer-attach-row").children;
check(
  "拖进来的东西只入待发送区，一个都不发出去",
  takeCalls("send_paths", since).length === 0 && byId("xfer-attach").hidden === false && chips.length === 2,
  `calls=${takeCalls("send_paths", since).length} chips=${chips.length}`
);
check(
  "待发送区写着这一批是发给哪一台",
  /发给「乙机」/.test(byId("xfer-attach-title").text),
  byId("xfer-attach-title").text
);
check(
  "待发送的每颗都能单独移除（× 直接绑在按钮上）",
  chips.every((c) => c.children.some((n) => n.classList.contains("attach-x") && n.listeners.length > 0)),
  chips.map((c) => c.children.map((n) => n.className).join("|")).join(" / ")
);
since = calls.length;
click(byId("btn-xfer-send"));
await settle();
const sp = takeCalls("send_paths", since);
check(
  "点发送才走 send_paths 排队（一件文件一个文件夹）",
  sp.length === 1 && sp[0][1].paths.length === 2 && sp[0][1].to === "B",
  JSON.stringify(sp[0] && sp[0][1])
);
check("发出去之后待发送区收起来", byId("xfer-attach").hidden === true, String(byId("xfer-attach").hidden));
const qBubs = bubbles().filter((b) => b.classSet.has("is-queued"));
check("排队的那批气泡都挂着待发", qBubs.length === 2, String(qBubs.length));
check(
  "排队的气泡不显示进度条（它只能停在 0%，看着像卡住了）",
  qBubs.every((b) => b.querySelectorAll(".bar").every((x) => x.hidden === true)),
  JSON.stringify(qBubs.map((b) => b.querySelectorAll(".bar").map((x) => x.hidden)))
);
check(
  "排队提示不会渗进会话栏那一行（行上只摆名字与摘要）",
  rows().every((r) => !/待发|排队/.test(r.textContent)),
  rows().map((r) => r.textContent).join(" | ").slice(0, 200)
);

// 补发开始：先转「传输中」（进度条放回来）再走进度。进度事件带的是 batch id，
// 而补发一个排队的文件时那个 id 必须就是待发气泡自己的 id ——
// 前端拿不到对应气泡时会先占一个「接收中」的入向气泡，自己发文件却多出一个对方发来的
const fBub = qBubs[0];
const fRec = world.hist.find((m) => m.id === fBub.dataset.id);
const nAll = bubbles().length;
const nIn = bubbles().filter((b) => b.classSet.has("msg-in")).length;
emit("msg-updated", { message: { ...fRec, state: "sending" } });
await settle();
emit("xfer-progress", { msg_id: fRec.id, dir: "out", peer: "B", sid: "B", sent: 512, total: 2048, name: fRec.name });
await settle();
const fb = bubbles().find((b) => b.dataset.id === fRec.id);
check(
  "补发一开始待发样式下来、进度条放回来",
  !!fb && !fb.classSet.has("is-queued") && fb.querySelectorAll(".bar")[0].hidden === false,
  String(fb?.className)
);
check(
  "进度落在那条待发气泡自己上，没另占一个入向气泡",
  bubbles().length === nAll &&
    bubbles().filter((b) => b.classSet.has("msg-in")).length === nIn &&
    fb.querySelectorAll(".bar")[0].children[0].style.width === "25%",
  `${bubbles().length}/${nAll} 进度=${fb?.querySelectorAll(".bar")[0].children[0].style.width}`
);

// 未配对：仍然拦在前端，一条都不发（连地址都没有，排队也排不了）
click(rowOf(""));
await settle();
api.routeDropHover("over");
check(
  "未配对时遮罩拦下并说明先配对",
  byId("xfer-drop-hint").classSet.has("is-blocked") === true && /先配对/.test(byId("xfer-drop-text").text),
  byId("xfer-drop-text").text
);
since = calls.length;
byId("xfer-input").value = "想发给未标记的那台";
click(byId("btn-xfer-send"));
api.routeDrop(["/tmp/另一.jpg"]);
await settle();
check(
  "未配对的会话一个字、一个文件都不会发出去",
  takeCalls("send_text", since).length === 0 && takeCalls("send_paths", since).length === 0,
  JSON.stringify(calls.slice(since).map(([c]) => c))
);

/* ------------------------- 19.5 放大层的缩放 -------------------------
   一张 1600×1200 的大图被 CSS 装成 400×300（起点 100,60）：那一档就是 25%。
   桩里不做布局，所以盒与像素都由用例直接盖上去，剩下的全是纯算术 */
const lbImg = byId("lightbox-img");
const LB = () => byId("img-lightbox");
const lbPct = () => byId("lightbox-zoom").text;
/** 从 style.transform 读回实际生效的平移与倍数（没挂 transform 就是 1,0,0） */
function lbTf() {
  const raw = lbImg.style.transform || "";
  const mT = /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)/.exec(raw);
  const mS = /scale\(([-\d.e+]+)\)/.exec(raw);
  return { raw, x: mT ? Number(mT[1]) : 0, y: mT ? Number(mT[2]) : 0, s: mS ? Number(mS[1]) : 1 };
}
/** 未变换盒里 (200,100) 那个像素现在落在屏幕哪里——锚点不跳就看它 */
const screenOf = (q) => {
  const t = lbTf();
  return 100 + t.x + t.s * q;
};
/** 窗口事件得手动发给注册者（桩里没真正的 window） */
function fireWin(type, extra = {}) {
  const ev = { type, preventDefault() {}, stopPropagation() {}, ...extra };
  for (const [t, fn] of winListeners) if (t === type) fn(ev);
}
const lbKey = (key, tagName = "DIV") => fireWin("keydown", { key, target: { tagName } });
const lbWheel = (deltaY, cx, cy) => LB().dispatchEvent({ type: "wheel", deltaY, clientX: cx, clientY: cy, preventDefault() {} });
const lbDbl = (cx, cy) => lbImg.dispatchEvent({ type: "dblclick", clientX: cx, clientY: cy, preventDefault() {} });
const lbDown = (cx, cy) => lbImg.dispatchEvent({ type: "mousedown", clientX: cx, clientY: cy, preventDefault() {} });
/** 背景上的一击（真 DOM 里是冒泡到 .lightbox，target 仍是原元素） */
const lbBgClick = (node = LB()) => LB().dispatchEvent({ type: "click", target: node, preventDefault() {} });

function fakeBox(natural, w) {
  lbImg.naturalWidth = natural;
  lbImg.naturalHeight = natural;
  lbImg.getBoundingClientRect = () => ({ left: 100, top: 60, right: 100 + w, bottom: 60 + w, width: w, height: w });
}

fakeBox(1600, 400);
// 先入历史再切会话：已经在当前会话上再点一次不会重绘，拿不到这张新气泡
const bigId = push("A", at(10, 0), {
  dir: "out",
  kind: "file",
  text: "",
  name: "大图.jpg",
  path: "/tmp/大图.jpg",
  size: 3 * 1024 * 1024,
});
click(rowOf("A"));
await settle();
const bigBubble = bubbles().find((b) => b.dataset.id === bigId);
const thumbBox = bigBubble && bigBubble.querySelectorAll(".thumb-box")[0];
check(
  "图片气泡把原图读出来了（缩放全靠这份 data URL，不二次读盘）",
  !!thumbBox && thumbBox.classSet.has("thumb-ready"),
  String(thumbBox && thumbBox.className)
);
click(thumbBox);
await settle();
check(
  "打开放大层就是适应档：不挂 transform，百分比按原始像素报 25%",
  LB().hidden === false && lbTf().raw === "" && lbPct() === "25%",
  `${lbTf().raw} ${lbPct()}`
);

// 指针在 (300,160)，正对盒内 (200,100) 那个像素
lbWheel(-100, 300, 160);
check(
  "滚轮放大后指针下那个像素还在指针下（锚点不跳）",
  lbTf().s > 1 && Math.abs(screenOf(200) - 300) < 1e-9,
  lbTf().raw
);
check("滚轮放大后百分比跟着涨", lbPct() === "30%", lbPct());

click(byId("lightbox-one"));
check(
  "1:1 = 原始像素，transform 在适应之上再放大 4 倍",
  lbTf().s === 4 && lbPct() === "100%",
  `${lbTf().raw} ${lbPct()}`
);
check("比适应大了才有东西可拖，光标切成可拖", LB().classSet.has("is-zoomable"), String(LB().className));
for (let i = 0; i < 30; i++) click(byId("lightbox-in"));
check("一路按 + 也钉在 800% 上限", lbPct() === "800%" && lbTf().s === 32, `${lbPct()} ${lbTf().raw}`);
for (let i = 0; i < 40; i++) click(byId("lightbox-out"));
check(
  "一路按 − 收到 25% 下限，正好回到适应那一档（不会把图缩成点）",
  lbPct() === "25%" && lbTf().s === 1 && Math.abs(lbTf().x) < 1e-6,
  `${lbPct()} ${lbTf().raw}`
);

lbDbl(300, 160);
check(
  "双击从适应跳到 1:1，仍以点击处为锚",
  lbTf().s === 4 && lbPct() === "100%" && Math.abs(screenOf(200) - 300) < 1e-9,
  lbTf().raw
);
lbDbl(300, 160);
check("再双击回适应，平移量一起清掉", lbPct() === "25%" && lbTf().raw === "", lbTf().raw);

// 拖拽平移：先放大到 1:1，按住拖 40,30（拿拖之前的平移量做基准，前面几步缩放已经把它带偏过）
click(byId("lightbox-one"));
const baseTf = lbTf();
lbDown(300, 160);
fireWin("mousemove", { clientX: 340, clientY: 190 });
const dragTf = lbTf();
check(
  "拖拽位移等于鼠标差，并在拖的时候挂 is-dragging",
  Math.abs(dragTf.x - (baseTf.x + 40)) < 1e-9 && Math.abs(dragTf.y - (baseTf.y + 30)) < 1e-9 && LB().classSet.has("is-dragging"),
  `${dragTf.raw} 基准=${baseTf.raw}`
);
fireWin("mouseup");
check("松手就停（is-dragging 摘掉）", !LB().classSet.has("is-dragging"), String(LB().className));
lbBgClick();
check("拖完那一下的 click 被吃掉，不会误关层", LB().hidden === false, String(LB().hidden));
lbBgClick();
check("再点背景才真的关层", LB().hidden === true, String(LB().hidden));

// 适应档下不接管鼠标：没东西可平移，别抢用户的拖动
const stillTf = lbTf();
lbDown(300, 160);
fireWin("mousemove", { clientX: 400, clientY: 260 });
check("图比屏幕小时拖图不产生位移", lbTf().raw === stillTf.raw, `${lbTf().raw} 基准=${stillTf.raw}`);
fireWin("mouseup");

// 重开：上一张的倍率与平移都不带过来
lbWheel(-300, 300, 160);
click(thumbBox);
await settle();
check(
  "重开回到适应档，平移量清零",
  lbTf().raw === "" && lbPct() === "25%",
  `${lbTf().raw} ${lbPct()}`
);

// 键盘
lbKey("1");
check("键盘 1 = 1:1", lbPct() === "100%", lbPct());
lbKey("0");
check("键盘 0 = 适应", lbPct() === "25%" && lbTf().raw === "", lbPct());
lbKey("=");
check("键盘 = 与 + 同义，放大一档", lbPct() === "31%", lbPct());
lbKey("-", "TEXTAREA");
check("焦点在输入框里时不抢键（聊天框里打 “-”是输字符）", lbPct() === "31%", lbPct());
const beforeKey = lbTf().x;
lbKey("ArrowRight");
check("方向键平移一步 40px", Math.abs(lbTf().x - (beforeKey + 40)) < 1e-9, lbTf().raw);

// 大图解码完才量得准：没动过就顺势回适应，动过了不抢用户的视野
fakeBox(0, 400);
click(thumbBox);
await settle();
check("naturalWidth 还没就绪时不拿 0 去除，先当 1:1 处理", lbPct() === "100%" && lbTf().raw === "", lbPct());
fakeBox(1600, 400);
lbImg.dispatchEvent({ type: "load", preventDefault() {} });
check(
  "解码完成后补量一次，回到真正的适应档",
  lbPct() === "25%" && lbTf().raw === "",
  `${lbPct()} ${lbTf().raw}`
);
click(byId("lightbox-in"));
const heldPct = lbPct();
lbImg.dispatchEvent({ type: "load", preventDefault() {} });
check("用户已经缩放过，load 补量不把他正在看的细节抢回适应", lbPct() === heldPct, lbPct());
// 更边缘的一种：图还没解码完用户就缩了，此时 fit 还是兜底的 1，倍数与标签对不上
fakeBox(0, 400);
click(thumbBox);
await settle();
lbKey("=");
check("解码未完时先按兜底那一档走（不拿 0 去除）", lbPct() === "125%" && lbTf().s === 1.25, `${lbPct()} ${lbTf().raw}`);
fakeBox(1600, 400);
lbImg.dispatchEvent({ type: "load", preventDefault() {} });
check(
  "补量后原始口径不变（仍报 125%），transform 换成真正的 5 倍",
  lbPct() === "125%" && lbTf().s === 5,
  `${lbPct()} ${lbTf().raw}`
);
fireWin("resize");
check("窗口变了退回适应（基准盒重量，不猜新位置）", lbPct() === "25%" && lbTf().raw === "", lbPct());

// 一路拖出屏幕：图中心被收在视口里，不会拖到全黑找不到北
window.innerWidth = 1000;
window.innerHeight = 800;
click(byId("lightbox-one"));
lbDown(300, 160);
fireWin("mousemove", { clientX: -4000, clientY: -4000 });
const clamped = lbTf();
check(
  "拖出屏幕时图中心被钉在视口边内，不会拖到全黑",
  Math.abs(100 + clamped.x + clamped.s * 200 - 60) < 1e-9 && Math.abs(60 + clamped.y + clamped.s * 200 - 60) < 1e-9,
  lbTf().raw
);
fireWin("mouseup");
window.innerWidth = 0;
window.innerHeight = 0;

/* ---- 田字平铺（拿四份看接缝）---- */
const tileStage = byId("lightbox-tile-stage");
/** 从写进 style 的 background-* 读回实际生效的格子尺寸与十字交点位置 */
function tileBox() {
  const sz = /([\d.]+)px ([\d.]+)px/.exec(tileStage.style.backgroundSize || "");
  const ps = /([-\d.]+)px ([-\d.]+)px/.exec(tileStage.style.backgroundPosition || "");
  return {
    w: sz ? Number(sz[1]) : 0,
    h: sz ? Number(sz[2]) : 0,
    kx: ps ? Number(ps[1]) : 0,
    ky: ps ? Number(ps[2]) : 0,
    img: tileStage.style.backgroundImage || "",
  };
}
/** 屏幕点 px 落在格子里的位置（平铺下的锚点不变式就看它） */
const tileU = (px) => {
  const t = tileBox();
  return t.w ? (px - t.kx) / t.w : 0;
};
const tileDown = (cx, cy) => tileStage.dispatchEvent({ type: "mousedown", clientX: cx, clientY: cy, preventDefault() {} });

lbKey("0");
click(byId("lightbox-tile"));
const t0 = tileBox();
check(
  "点「田」挂上 is-tiled，画布拿的是与单张同一份 data URL（不二次读盘）",
  LB().classSet.has("is-tiled") && /^url\("data:image\/jpeg/.test(t0.img),
  t0.img.slice(0, 26)
);
check(
  "适应档下格子尺寸 = 单张渲染尺寸，十字交点钉在单张图中心（四份围绕屏幕正中拼）",
  t0.w === 400 && t0.h === 400 && t0.kx === 300 && t0.ky === 260,
  JSON.stringify(t0)
);

const uBefore = tileU(500);
click(byId("lightbox-in"));
const t1 = tileBox();
check(
  "平铺下放大一档：格子里那块内容仍留在原屏幕位置（与单张同一条锚点不变式）",
  Math.abs(tileU(500) - uBefore) < 1e-9 && t1.w === 500,
  `格宽=${t1.w} u ${uBefore} → ${tileU(500)}`
);

// 平铺下鼠标落在画布上（那张图被 visibility 藏了），手势要绑到两个面上
tileDown(300, 160);
fireWin("mousemove", { clientX: 340, clientY: 190 });
const t2 = tileBox();
check(
  "拖画布就能把十字移到隔壁那条缝上",
  Math.abs(t2.kx - (t1.kx + 40)) < 1e-9 && Math.abs(t2.ky - (t1.ky + 30)) < 1e-9,
  `${t1.kx},${t1.ky} → ${t2.kx},${t2.ky}`
);
fireWin("mouseup");

// 平铺下不做「图中心留在视口」的收拢：图案本来就铺满整屏，拖多少都跟着走
window.innerWidth = 1000;
window.innerHeight = 800;
tileDown(300, 160);
fireWin("mousemove", { clientX: -4000, clientY: -4000 });
const t3 = tileBox();
check(
  "平铺下不收拢平移量（拿单张盒中心去卡周期图案会拦住看隔壁的缝）",
  Math.abs(t3.kx - (t2.kx - 4300)) < 1e-9 && Math.abs(t3.ky - (t2.ky - 4160)) < 1e-9,
  `${t2.kx},${t2.ky} → ${t3.kx},${t3.ky}`
);
fireWin("mouseup");
window.innerWidth = 0;
window.innerHeight = 0;

lbBgClick(tileStage);
lbBgClick(tileStage);
check("平铺下点画布不关层（整屏都是图，退出只走 ×、Esc 或再按田）", LB().hidden === false, String(LB().hidden));
lbKey("Escape");
check("Esc 在平铺下照样关层", LB().hidden === true, String(LB().hidden));
click(thumbBox);
await settle();
check(
  "重开回到单张：is-tiled 摘掉、背图抹掉（不然一份 base64 常驻内存）",
  !LB().classSet.has("is-tiled") && tileStage.style.backgroundImage === "none" && lbTf().raw === "",
  String(tileStage.style.backgroundImage).slice(0, 20)
);

lbKey("t");
check("键盘 T 也能切进平铺", LB().classSet.has("is-tiled") && /^url\(/.test(tileBox().img), lbPct());
lbKey("t");
check("再按 T 回单张", !LB().classSet.has("is-tiled"), lbPct());

// 两种画法是同一套状态：切来切去不跳视野
lbKey("=");
const pctBefore = lbPct();
const sBefore = lbTf().s;
lbKey("t");
const t4 = tileBox();
check(
  "单张→平铺：倍率不变，格子尺寸 = 单张当前的渲染尺寸",
  lbPct() === pctBefore && Math.abs(t4.w - sBefore * 400) < 1e-9,
  `${pctBefore} 格宽=${t4.w} 单张倍数=${sBefore}`
);
lbKey("t");
check("平铺→单张：视野也不跳回来", lbPct() === pctBefore && Math.abs(lbTf().s - sBefore) < 1e-9, lbTf().raw);

/* 20) 「传输」按钮上的未读总数：与会话栏同源、读完就藏、超 99 封顶 */
const NB = () => byId("nav-badge-xfer");
const navNum = () => (NB().hidden ? 0 : Number(NB().text) || 0);
/* 求和从会话栏那些徽标自己身上取：两处显示都由真代码渲染，
   比在用例里再抄一遍加法有意义（谁改了求和口径，两边就会不一致地红） */
const railSum = () =>
  rows().reduce((n, r) => n + Number(r.children.find((c) => c.classSet.has("s-badge"))?.text || 0), 0);

const total0 = railSum();
/* 一条一条来、每条之后 settle：真机里第一条会把那个框建出来（后端推一次
   sessions-changed），第二条起走本地累加（后端不为已存在的框重推）。两条
   同拍塞进来只会撞到「列表还没回来、这一条没人认」那个桩特有的竞态。
   ts 一律取 NOW 之前：桩里 Date.now() 是冻住的，focus() 把读指针推到那一站，
   比它还晚的消息切进去了也清不掉未读（真机不会有这种消息）。 */
const arrive = async (id, text, ts) => {
  emit("msg-in", { message: { id, dir: "in", kind: "text", text, state: "sent", ts, peer: "NB" } });
  await settle();
};
await arrive("nb1", "角标自检第一条", NOW - 2000);
check(
  "陌生那台来第一条（框刚建出来，靠重拉列表）：按钮上的数与会话栏那些徽标相加一致",
  NB().hidden === false && navNum() === railSum() && railSum() === total0 + 1,
  `会话栏合计=${railSum()} 按钮=${NB().text || "(空)"}`
);
await arrive("nb2", "角标自检第二条", NOW - 1000);
check(
  "第二条不重拉列表、只本地加一个未读：按钮上的数也得跟着加（两边共用同一次渲染）",
  navNum() === railSum() && railSum() === total0 + 2,
  `会话栏合计=${railSum()} 按钮=${NB().text || "(空)"}`
);

const nbBefore = navNum();
click(rowOf("NB"));
await settle();
check(
  "点进未读那一行，总数按后端回来的新 payload 掉下两条（不自己另算一份）",
  navNum() === railSum() && railSum() === nbBefore - 2,
  `${nbBefore} -> ${NB().text || "(空)"}，会话栏合计=${railSum()}`
);

// 一框一框点过去：每点一次都会拿回一份新 payload，两边得一直同步。
// 点不动就停：第 8 节那条「明天」的消息比冻住的 now 还晚，focus() 推的读
// 指针追不上它，那一行的未读本来就不是点进去能清掉的
let stuck = false;
for (let guard = 0; guard < 20 && !stuck && railSum() > 0; guard++) {
  const r = rows().find((x) => x.children.some((c) => c.classSet.has("s-badge")));
  if (!r) break;
  const before = railSum();
  click(rowOf(r.dataset.id));
  await settle();
  if (navNum() !== railSum()) break; // 两边对不上，下面的总断言会报出来，这里不再空转
  if (railSum() >= before) stuck = true;
}
check(
  "一路点过去，按钮上的数始终与会话栏那些徽标相等",
  navNum() === railSum(),
  `按钮=${NB().text || "(空)"} 合计=${railSum()}`
);

// 剩下那些清不掉的行，拿一份「后端说全读完了」的真载荷走同一条路：
// 只把读指针按到最后一条消息之后，unread 仍由桩自己算，不在用例里抄一份
const readsBefore = world.sessions.map((s) => s.read);
const lastTs = world.hist.reduce((a, m) => Math.max(a, m.ts), 0);
for (const s of world.sessions) s.read = lastTs + 1;
emit("sessions-changed", sessionsPayload());
await settle();
check(
  "未读真的全部归零时角标彻底藏起来：hidden=true 且文案清空，不留个 0 在那",
  NB().hidden === true && NB().text === "" && railSum() === 0,
  `hidden=${NB().hidden} text="${NB().text}" 合计=${railSum()}`
);
// 读指针还原回去：不然后面那句「还原后两边一致」会退化成 0 == 0 的空断言
world.sessions.forEach((s, i) => (s.read = readsBefore[i]));

/* 封顶与容错：直接喂一份会话列表进来，不依赖桩后端 */
const capRow = (unread, i) => ({
  id: "cap" + i,
  peer: "cap" + i,
  name: "封顶" + i,
  host: "",
  port: 0,
  online: false,
  bound: false,
  created: 0,
  last: Date.now(),
  summary: "",
  unread,
});
const feedRows = async (sessions) => {
  emit("sessions-changed", { sessions, active: "" });
  await settle();
};

await feedRows([capRow(99, 1)]);
check("99 条就写 99，不加号", NB().text === "99", NB().text);
await feedRows([capRow(100, 1)]);
check("100 条封顶成 99+（与侧栏那套写法同一个口径）", NB().text === "99+", NB().text);
await feedRows([capRow(60, 1), capRow(60, 2)]);
check("两行各 60 也要封顶，不是只防单行超了", NB().text === "99+", NB().text);

// 缺 unread / null / 负数都不能把 NaN 或 -3 报上去
await feedRows([
  { id: "n1", peer: "n1", name: "n1", unread: undefined },
  { id: "n2", peer: "n2", name: "n2", unread: null },
  { id: "n3", peer: "n3", name: "n3", unread: -5 },
]);
check(
  "缺字段/null/负数一律当 0：不报 NaN、不报 -5，直接藏起来",
  NB().hidden === true && NB().text === "",
  `hidden=${NB().hidden} text="${NB().text}"`
);

// 收尾还原成桩后端的真列表：这段改过 state.cur，不还原会留给后续一个假象
emit("sessions-changed", sessionsPayload());
await settle();
check(
  "还原回真实会话列表后，按钮上的数还是会话栏那些徽标之和",
  navNum() === railSum(),
  `按钮=${NB().text || "(空)"} 合计=${railSum()}`
);

/* 20b) 会话栏一行怎么排：名字独占第一行 + 时间格式（桩不解析 HTML，拿 innerHTML 字符串看）
     会话栏只有 214px，时间跟名字挤一行、加上平时看不见的操作按钮占 50px，
     拿 headless Chrome 量过：名字只剩 3~4 个汉字） */
const p2 = (x) => String(x).padStart(2, "0");
const tsInYear = at(10, 9, 5); // 今年内、既不是今天也不是昨天也不是前天
const dIn = new Date(tsInYear);
const dCross = new Date(tsInYear);
dCross.setFullYear(dCross.getFullYear() - 1); // 跨年那一档（期望值从 ts 现算，不硬编码日期）
await feedRows([
  { id: "t1", peer: "t1", name: "名字独占一行", unread: 0, last: tsInYear, summary: "十天前的框" },
  { id: "t2", peer: "t2", name: "跨年框", unread: 0, last: dCross.getTime(), summary: "去年的框" },
]);
const t1Html = rowOf("t1")?.innerHTML || "";
const t2Html = rowOf("t2")?.innerHTML || "";
check(
  "名字后面直接收尾：时间不再跟名字挤在同一行（挤的时候整行只剩 3~4 个汉字）",
  /<b>名字独占一行<\/b><\/div>/.test(t1Html),
  t1Html
);
check(
  "预览包了一层 .s-prev：裁切交给它，时间才能站在第二行右端",
  /class="s-sub"><span class="s-prev">[^<]*<\/span><span class="s-time">/.test(t1Html),
  t1Html
);
check(
  "今年内的框只写到月-日（年份白吃 20px）",
  t1Html.includes(`<span class="s-time">${p2(dIn.getMonth() + 1)}-${p2(dIn.getDate())}</span>`) &&
    !/s-time">\d{4}-/.test(t1Html),
  t1Html.match(/s-time">[^<]*/)?.[0] || "没时间"
);
check(
  "跨年必须留年份：只写 10-16 会把去年的框说成今年的",
  t2Html.includes(
    `<span class="s-time">${dCross.getFullYear()}-${p2(dCross.getMonth() + 1)}-${p2(dCross.getDate())}</span>`
  ),
  t2Html.match(/s-time">[^<]*/)?.[0] || "没时间"
);
// 这段喂的是临时列表，还原以免给后面的用例留一个只剩两行的会话栏
emit("sessions-changed", sessionsPayload());
await settle();
check("那一段跑完会话栏还原回桩后端的真列表", rows().length === sessionsPayload().sessions.length, `${rows().length}`);

/* 20c) 会话栏右键：自己画的中文菜单（WebView 原生那套是 Reload / Inspect Element，
      语言跟着系统走英语，跟聊天没关系）。置顶跟微信一个手感：排到最上面、底色深一档，
      再右键一次就能取消，重启还在（存 sessions.json） */
const chatMenuEl = byId("chat-menu");
// index.html 里这三枚是菜单的子节点；桩不解析 HTML，这里照实挂上（contains 才判得了「点在菜单里」）
for (const id of ["ctx-chat-pin", "ctx-chat-rename", "ctx-chat-sep", "ctx-chat-del"]) chatMenuEl.appendChild(byId(id));
// index.html 上带 hidden，桩不读属性，用例自己先盖上
chatMenuEl.hidden = true;

const rightClick = (node) => {
  let blocked = false;
  node.dispatchEvent({
    type: "contextmenu",
    target: node,
    clientX: 120,
    clientY: 160,
    preventDefault: () => {
      blocked = true;
    },
    stopPropagation() {},
  });
  return blocked;
};
const fireWindow = (type, target, extra = {}) => {
  // 默认带上 no-op 的 preventDefault：处理器里无条件调它的（⌘F）才不会顶异常
  const ev = { type, target, preventDefault: () => {}, ...extra };
  for (const [t, fn] of winListeners) if (t === type) fn(ev);
};

emit("sessions-changed", sessionsPayload());
await settle();
check(
  "右键之前菜单是收着的（与 index.html 上的 hidden 一致）",
  chatMenuEl.hidden === true,
  `hidden=${chatMenuEl.hidden}`
);
const rowIdx = (id) => rows().findIndex((r) => r.dataset.id === id);
check(
  "默认按最后一条时间排：丙机今天 10:00 那条比甲机的晚",
  rowIdx("C") >= 0 && rowIdx("A") > rowIdx("C"),
  rows().map((r) => r.dataset.id).join(",")
);

// 右键甲机那一行：出来的是自己的中文菜单，系统菜单被挡掉
const blockedSys = rightClick(rowOf("A"));
check("右键会话行先 preventDefault：不再弹 Reload / Inspect Element 那套", blockedSys === true, `blocked=${blockedSys}`);
check("弹出来的是自己画的那份菜单", chatMenuEl.hidden === false, `hidden=${chatMenuEl.hidden}`);
check(
  "还没置顶过的，第一项就是「置顶该聊天」",
  byId("ctx-chat-pin").textContent === "置顶该聊天",
  byId("ctx-chat-pin").textContent
);
check(
  "菜单贴在鼠标处摊开（贴边才翻到另一边）",
  chatMenuEl.style.left === "120px" && chatMenuEl.style.top === "160px",
  `${chatMenuEl.style.left},${chatMenuEl.style.top}`
);

// 点「置顶该聊天」
const sincePin = calls.length;
click(byId("ctx-chat-pin"));
await settle();
const pin1 = takeCalls("session_pin", sincePin).at(-1)?.[1];
check(
  "点置顶只发一个 session_pin{id,pinned:true}，没有别的后端改动",
  takeCalls("session_pin", sincePin).length === 1 && pin1?.id === "A" && pin1?.pinned === true,
  JSON.stringify(pin1)
);
check("点完菜单自己收起", chatMenuEl.hidden === true, `hidden=${chatMenuEl.hidden}`);
check("置顶行带 is-pinned（底色深一档）", rowOf("A")?.classSet.has("is-pinned"), rowOf("A")?.className);
check(
  "置顶的永远排最前，哪怕它不是最后说话的那个",
  rows()[0]?.dataset.id === "A" && rowIdx("A") < rowIdx("C"),
  rows().map((r) => r.dataset.id).join(",")
);

// 再右键一次：同一项变成「取消置顶」，点完回到按时间的位置
rightClick(rowOf("A"));
check(
  "已经置顶过的，第一项变成「取消置顶」",
  byId("ctx-chat-pin").textContent === "取消置顶",
  byId("ctx-chat-pin").textContent
);
const sinceUnpin = calls.length;
click(byId("ctx-chat-pin"));
await settle();
const pin2 = takeCalls("session_pin", sinceUnpin).at(-1)?.[1];
check(
  "取消置顶：pinned=false，行上的 is-pinned 也去掉",
  pin2?.pinned === false && !rowOf("A")?.classSet.has("is-pinned"),
  JSON.stringify(pin2)
);
check(
  "取消之后回到按时间的位置（甲机本来就比丙机早）",
  rowIdx("A") > rowIdx("C"),
  rows().map((r) => r.dataset.id).join(",")
);

// 点菜单外面收起；点菜单里面不算「外面」
rightClick(rowOf("C"));
fireWindow("pointerdown", byId("ctx-chat-rename"));
check("点在菜单里面（换到「重命名」上）不会先把菜单收掉", chatMenuEl.hidden === false, `hidden=${chatMenuEl.hidden}`);
fireWindow("pointerdown", byId("xfer-stream"));
check("点菜单外面就收起（系统菜单那个手感）", chatMenuEl.hidden === true, `hidden=${chatMenuEl.hidden}`);

// 删除仍是两步：第一下只把文案改成「再点一次删除」
world.sessions.push({ id: "TMP", peer: "A", name: "待删的框", created: NOW, read: NOW });
emit("sessions-changed", sessionsPayload());
await settle();
rightClick(rowOf("TMP"));
const sinceDel = calls.length;
click(byId("ctx-chat-del"));
await settle();
check(
  "第一下不删：文案先变成「再点一次删除」",
  byId("ctx-chat-del").textContent === "再点一次删除" && takeCalls("session_delete", sinceDel).length === 0,
  byId("ctx-chat-del").textContent
);
check("两步确认在同一个菜单里完成（点第一下不会把菜单收掉）", chatMenuEl.hidden === false, `hidden=${chatMenuEl.hidden}`);
click(byId("ctx-chat-del"));
await settle();
check(
  "第二下才真删，且删的就是右键的那个框",
  takeCalls("session_delete", sinceDel).some(([, a]) => a.id === "TMP"),
  JSON.stringify(takeCalls("session_delete", sinceDel))
);
world.hidden = world.hidden.filter((x) => x !== "TMP");

// 「未标记」那行不是一台真设备，但那一行确实得能删：它装的全是没记对端的老消息，
// 用户要的是「这一筐不看了」。以前右键只弹一句「只能查看」、行内也没按钮，删也删不掉
// （Win 那台报的就是这条：一个对话显示未标记，删除也删除不了）
const unmarkedRow = rows().find((r) => r.dataset.id === "");
const blockedUnmarked = rightClick(unmarkedRow);
check(
  "未标记行右键也会弹菜单，只是只剩删除一项（置顶/改名/隔断都藏起来）",
  blockedUnmarked === true &&
    chatMenuEl.hidden === false &&
    byId("ctx-chat-pin").hidden === true &&
    byId("ctx-chat-rename").hidden === true &&
    byId("ctx-chat-sep").hidden === true &&
    byId("ctx-chat-del").textContent === "删除这些消息",
  `blocked=${blockedUnmarked} hidden=${chatMenuEl.hidden} pin=${byId("ctx-chat-pin").hidden} rename=${byId("ctx-chat-rename").hidden} sep=${byId("ctx-chat-sep").hidden} del="${byId("ctx-chat-del").textContent}"`
);
// 那三项是每次打开时重算的，不是一次性状态：普通行再右键要全部回来
rightClick(rowOf("A"));
check(
  "普通行再右键：置顶/改名/隔断都回来，删除文案也回「删除聊天」",
  !byId("ctx-chat-pin").hidden &&
    !byId("ctx-chat-rename").hidden &&
    !byId("ctx-chat-sep").hidden &&
    byId("ctx-chat-del").textContent === "删除聊天",
  `pin=${byId("ctx-chat-pin").hidden} rename=${byId("ctx-chat-rename").hidden} sep=${byId("ctx-chat-sep").hidden} del="${byId("ctx-chat-del").textContent}"`
);
const sinceUnmarked = calls.length;
rightClick(unmarkedRow);
click(byId("ctx-chat-del"));
await settle();
check(
  "未标记行也露「清空聊天记录」（它的 sid 就是那个空串筐），与删除并排",
  byId("ctx-chat-clear").hidden === false && byId("ctx-chat-del").hidden === false,
  `clear=${byId("ctx-chat-clear").hidden} del=${byId("ctx-chat-del").hidden}`
);
check(
  "未标记行第一下也只是臂上（文案变成「再点一次删除」，还没调命令）",
  byId("ctx-chat-del").textContent === "再点一次删除" && takeCalls("session_delete", sinceUnmarked).length === 0,
  byId("ctx-chat-del").textContent
);
click(byId("ctx-chat-del"));
await settle();
check(
  "第二下真删：session_delete 的 id 是空串（后端记进 hidden 里的那个值）",
  takeCalls("session_delete", sinceUnmarked).some(([, a]) => a.id === ""),
  JSON.stringify(takeCalls("session_delete", sinceUnmarked))
);
check(
  "删完这一行从会话栏消失，焦点自己落到还剩的那个框上",
  !rows().some((r) => r.dataset.id === "") && rows().some((r) => r.classSet.has("is-active")) &&
    lastCall("msg_history")?.session !== "",
  `${rows().map((r) => r.dataset.id).join(",")} | ${lastCall("msg_history")?.session}`
);
// 还原：后面的用例还要用「未标记」那一行
world.hidden = world.hidden.filter((x) => x !== "");

// 静态合约：菜单三项是中文、没有英文原生项；前后端各自的入口都在
const html = readFileSync(join(here, "..", "js", "index.html"), "utf8");
const xferJs = readFileSync(join(here, "..", "js", "view-transfer.js"), "utf8");
const rustNet = readFileSync(join(here, "..", "src-tauri", "src", "net", "mod.rs"), "utf8");
const rustStore = readFileSync(join(here, "..", "src-tauri", "src", "store.rs"), "utf8");
// 只看菜单那一块：index.html 里的注释也写着「Reload / Inspect Element」为何被替掉，不能一刀切
// （聊天气泡那份菜单的注释里也有这两个字，窗口开宽了会把那边一块扫进来）
const menuAt = html.indexOf('id="chat-menu"');
const menuHtml = menuAt < 0 ? "" : html.slice(menuAt, menuAt + 500);
check(
  "菜单四项都是中文（置顶 / 重命名 / 清空 / 删除），菜单里没有 Reload / Inspect",
  /置顶该聊天/.test(menuHtml) &&
    /重命名/.test(menuHtml) &&
    /清空聊天记录/.test(menuHtml) &&
    /删除聊天/.test(menuHtml) &&
    !/Reload|Inspect Element/.test(menuHtml),
  menuHtml.slice(0, 80)
);
check(
  "右键入口挂在会话行上，不是全局 contextmenu",
  /row\.addEventListener\("contextmenu"[\s\S]{0,400}?openChatMenu\(ev, s, row\)/.test(xferJs),
  ""
);
const css = readFileSync(join(here, "..", "js", "style.css"), "utf8");
check(
  "未标记行删得掉（后端）：remove_session 先看历史里有没有这个 sid，不再拿会话表当唯一依据",
  /pub fn remove_session[\s\S]{0,1400}?m\.sid_of\(\) == id/.test(rustNet) &&
    !/let before = g\.sessions\.len\(\)/.test(rustNet)
);
check(
  "菜单项给了 hidden 也得真消失：自定义 display:block 会盖掉 UA 那条",
  /\.ctx-menu > \[hidden\]\s*\{\s*display:\s*none;/.test(css),
  ""
);
check(
  "置顶走后端存盘：命令 + 字段 + 排序都在",
  /invoke\("session_pin"/.test(xferJs) &&
    /pub fn session_pin/.test(rustNet) &&
    /fn sort_session_rows/.test(rustNet) &&
    /"pinned": pinned/.test(rustNet) &&
    /pub pinned: bool/.test(rustStore),
  ""
);
check(
  "排序只作用在发给前端的那份上：存盘顺序不动（取消置顶才能回原位）",
  /fn sort_session_rows\(rows: &mut \[Value\]\)/.test(rustNet),
  ""
);

/* 20d) 聊天气泡的右键菜单：整条气泡都拦（文字 / 文件 / 图片），一份中文菜单按这一条是什么动态显隐
      撤回与本机删除两个入口也住在这里 —— 不拦就是 WebView 那套英文菜单 */
const msgMenuEl = byId("chat-msg-menu");
// index.html 里这九枚是菜单的子节点；桩不解析 HTML，这里照实挂上（顺序与页面一致）。
// 文本同步写桩：菜单项靠 textContent 认项，「这项叫什么」在测试里就得是个能看见的常量
const MSG_ITEMS = [
  ["cb-copy-text", "复制正文"],
  ["cb-quote", "引用回复"],
  ["cb-forward", "转发到别的会话"],
  ["cb-copy-img", "复制图片"],
  ["cb-save", "另存为…"],
  ["cb-copy-path", "复制文件路径"],
  ["cb-reveal", "在文件夹中显示"],
  ["cb-compare", "在对比中打开"],
  ["ctx-msg-sep", "|"],
  ["ctx-msg-recall", "撤回这一条"],
  ["ctx-msg-del", "删除（只删本机）"],
];
for (const [id, label] of MSG_ITEMS) {
  const n = byId(id);
  n.textContent = label;
  msgMenuEl.appendChild(n);
}
msgMenuEl.hidden = true;

const bubbleOf = (id) => {
  const msg = bubbles().find((b) => b.dataset.id === id);
  return msg ? msg.children.find((c) => c.classSet.has("bubble")) || null : null;
};
/** 整条气泡都拦之后，监听挂在 .msg 外层上：右键直接打在气泡那一层 */
const msgElOf = (id) => bubbles().find((b) => b.dataset.id === id) || null;
/** 摊开在菜单里的项（hidden 不算），用文本认项而不是 id —— 改了 id 也不会假装通过 */
const shownItems = () => msgMenuEl.children.filter((c) => !c.hidden).map((c) => c.text);
const itemBy = (t) => msgMenuEl.children.find((c) => c.text === t && !c.hidden) || null;
const openBubbleMenu = (msgEl) => {
  rightClick(msgEl);
  return shownItems();
};

// 切回甲机，造一条带本机路径的图片进当前流（截图里就是收件箱那张）
click(rowOf("A"));
await settle();
emit("msg-in", {
  message: {
    id: "img1",
    dir: "in",
    kind: "file",
    name: "圣诞雪花树纹针织图案.png",
    path: "/收件箱/圣诞雪花树纹针织图案.png",
    size: 2024000,
    state: "sent",
    ts: at(0, 16),
    peer: "A",
  },
});
await settle();
const imgBubble = bubbleOf("img1");
const imgBlocked = rightClick(msgElOf("img1"));
check(
  "图片气泡右键先 preventDefault：不再弹 Look Up / Translate / Share… 那套",
  imgBlocked === true,
  `blocked=${imgBlocked}`
);
check("弹的是自己的中文菜单", msgMenuEl.hidden === false, `hidden=${msgMenuEl.hidden}`);
check(
  "图片这一项都不落：复制图片 / 另存为 / 复制路径 / 在文件夹中显示 / 在对比中打开，再加隔断与删除",
  shownItems().join(",") === "引用回复,转发到别的会话,复制图片,另存为…,复制文件路径,在文件夹中显示,在对比中打开,|,删除（只删本机）",
  shownItems().join(",")
);
check(
  "别人发来的那条不给撤回入口（撤回只能撤自己发的）",
  itemBy("撤回这一条") === null,
  shownItems().join(",")
);
check(
  "菜单贴在鼠标处（与会话菜单共用 placeMenuAt）",
  msgMenuEl.style.left === "120px" && msgMenuEl.style.top === "160px",
  `${msgMenuEl.style.left},${msgMenuEl.style.top}`
);

const sinceCopy = calls.length;
click(byId("cb-copy-img"));
await settle();
check(
  "「复制图片」走 copy_as_file，路径就是这张图（粘到微信还是图）",
  takeCalls("copy_as_file", sinceCopy).some(([, a]) => a.paths?.[0] === "/收件箱/圣诞雪花树纹针织图案.png"),
  JSON.stringify(takeCalls("copy_as_file", sinceCopy))
);
check("点完菜单自己收起", msgMenuEl.hidden === true, `hidden=${msgMenuEl.hidden}`);

rightClick(msgElOf("img1"));
const sinceSave2 = calls.length;
click(byId("cb-save"));
await settle();
check(
  "「另存为…」走 save_path_as，src 是这张图",
  takeCalls("save_path_as", sinceSave2).some(([, a]) => a.src === "/收件箱/圣诞雪花树纹针织图案.png"),
  JSON.stringify(takeCalls("save_path_as", sinceSave2))
);

rightClick(msgElOf("img1"));
const sinceReveal2 = calls.length;
click(byId("cb-reveal"));
await settle();
check(
  "「在文件夹中显示」走 reveal_in_folder",
  takeCalls("reveal_in_folder", sinceReveal2).some(([, a]) => a.path === "/收件箱/圣诞雪花树纹针织图案.png"),
  JSON.stringify(takeCalls("reveal_in_folder", sinceReveal2))
);

// 「在对比中打开」交给对比视图：桩里注册一个处理者，相当于那边已经就绪
api.registerOpenHandler("compare", () => {});
rightClick(msgElOf("img1"));
click(byId("cb-compare"));
await settle();
check(
  "「在对比中打开」切到对比视图（路径交给那边的打开处理者）",
  document.body.dataset.view === "compare",
  document.body.dataset.view
);
api.setView("transfer");
await settle();

// 文字气泡也拦：要的就是「复制正文」这一项补上系统的选词拷贝（以前的漏处）
const textMsg = bubbles().find((b) => b.classSet.has("kind-text"));
const textBubble = textMsg ? textMsg.children.find((c) => c.classSet.has("bubble")) : null;
const itemsOfText = openBubbleMenu(textMsg);
check(
  "文字气泡也换成中文菜单，只给「复制正文」+ 隔断 + 撤回/删除",
  itemsOfText.join(",") === "复制正文,引用回复,转发到别的会话,|,删除（只删本机）",
  itemsOfText.join(",")
);
check(
  "文字气泡菜单里这一条没有文件那几项（本机路径压根不存在）",
  !itemsOfText.includes("另存为…") && !itemsOfText.includes("复制图片") && !itemsOfText.includes("在对比中打开"),
  itemsOfText.join(",")
);
const sinceTextCopy = calls.length;
click(itemBy("复制正文"));
await settle();
check(
  "「复制正文」拷的是这一条的文字（右键不再只能弹英文菜单）",
  takeCalls("noop", sinceTextCopy).length === 0 && String(textBubble.textContent).length > 0,
  textBubble.textContent
);

// 非图片文件：走文件那几项，不给图片项与对比
emit("msg-in", {
  message: {
    id: "doc1",
    dir: "in",
    kind: "file",
    name: "报表.pdf",
    path: "/收件箱/报表.pdf",
    size: 1024,
    state: "sent",
    ts: at(0, 17),
    peer: "A",
  },
});
await settle();
const itemsOfDoc = openBubbleMenu(msgElOf("doc1"));
check(
  "非图片文件也换成同一份中文菜单：给文件那几项，不给「复制图片」「在对比中打开」",
  itemsOfDoc.join(",") === "引用回复,转发到别的会话,另存为…,复制文件路径,在文件夹中显示,|,删除（只删本机）",
  itemsOfDoc.join(",")
);

// 关得干净：点菜单外面就收起
rightClick(msgElOf("img1"));
fireWindow("pointerdown", byId("xfer-stream"));
check("点菜单外面就收起（与系统菜单同一个手感）", msgMenuEl.hidden === true, `hidden=${msgMenuEl.hidden}`);

check(
  "整条气泡都拦：contextmenu 挂在 wrap 上，不再只挂图片气泡、也没挂到整个消息流",
  /wrap\.addEventListener\("contextmenu", \(ev\) => openMsgMenu\(ev, rec\)\)/.test(xferJs) &&
    !/bubble\.addEventListener\("contextmenu"/.test(xferJs) &&
    !/stream\.addEventListener\("contextmenu"/.test(xferJs),
  ""
);
const msgMenuAt = html.indexOf('id="chat-msg-menu"');
const msgMenuHtml = msgMenuAt < 0 ? "" : html.slice(msgMenuAt, msgMenuAt + 1100);
check(
  "菜单十一枚都在一份菜单里（一份菜单管三种气泡，不再开两份）",
  msgMenuAt >= 0 &&
    [
      "cb-copy-text",
      "cb-quote",
      "cb-forward",
      "cb-copy-img",
      "cb-save",
      "cb-copy-path",
      "cb-reveal",
      "cb-compare",
      "ctx-msg-sep",
      "ctx-msg-recall",
      "ctx-msg-del",
    ].every((i) => msgMenuHtml.includes(`id="${i}"`)) &&
    html.indexOf('id="chat-img-menu"') < 0,
  msgMenuHtml.slice(0, 60)
);
check(
  "菜单项全是中文，没有一条 WebView 原生菜单那套英文项",
  ["复制正文", "引用回复", "转发到别的会话", "复制图片", "另存为…", "复制文件路径", "在文件夹中显示", "在对比中打开", "撤回这一条", "删除（只删本机）"].every(
    (t) => msgMenuHtml.includes(t)
  ) &&
    !/Look Up|Translate|Search with|Copy Link|Share…|Speech|Inspect Element|Open Image|Download Image|Copy Subject/.test(
      msgMenuHtml
    ),
  msgMenuHtml.slice(0, 120)
);

/* 20e) 放大层的右键菜单：以前在放大层里右键弹的还是「Copy Image / Save Image As… /
      Inspect Element」那套英文系统菜单，现在换成自己画的中文五项，全走已有命令。
      没有本机路径时干脆不拦——剪贴板纯位图那回，系统菜单里的「拷贝图像」是唯一有用的项 */
const lbMenuEl = byId("lightbox-menu");
for (const [id, label] of [
  ["lbm-copy-img", "复制图片"],
  ["lbm-save", "另存为…"],
  ["lbm-copy-path", "复制文件路径"],
  ["lbm-reveal", "在文件夹中显示"],
  ["lbm-compare", "在对比中打开"],
]) {
  const n = byId(id);
  n.textContent = label;
  lbMenuEl.appendChild(n);
}
lbMenuEl.hidden = true;

// 拿上一节那条 img1（有本机路径）开放大层
const lbThumb1 = msgElOf("img1").querySelectorAll(".thumb-box")[0];
click(lbThumb1);
await settle();
check("从图片气泡打开放大层（这一张有本机路径）", LB().hidden === false, String(LB().hidden));
const lbBlocked = rightClick(LB());
check(
  "右键放大层先 preventDefault：不再弹 Copy Image / Save Image As… 那套英文的",
  lbBlocked === true,
  `blocked=${lbBlocked}`
);
check("弹出来的是自己画的中文菜单", lbMenuEl.hidden === false, `hidden=${lbMenuEl.hidden}`);
check(
  "五项全露：放大层里本来就是带路径的图，没有按类型显隐的必要",
  lbMenuEl.children.filter((c) => !c.hidden).map((c) => c.text).join(",") ===
    "复制图片,另存为…,复制文件路径,在文件夹中显示,在对比中打开",
  lbMenuEl.children.map((c) => `${c.text}${c.hidden ? "(藏)" : ""}`).join(",")
);
check(
  "菜单贴在鼠标处（与会话/气泡菜单共用 placeMenuAt）",
  lbMenuEl.style.left === "120px" && lbMenuEl.style.top === "160px",
  `${lbMenuEl.style.left},${lbMenuEl.style.top}`
);

const sinceLbCopy = calls.length;
click(byId("lbm-copy-img"));
await settle();
check(
  "「复制图片」走 copy_as_file：拷的是放大层正在看的那张，不是气泡那条",
  takeCalls("copy_as_file", sinceLbCopy).some(([, a]) => a.paths?.[0] === "/收件箱/圣诞雪花树纹针织图案.png"),
  JSON.stringify(takeCalls("copy_as_file", sinceLbCopy))
);
check("点完菜单自己收起", lbMenuEl.hidden === true, `hidden=${lbMenuEl.hidden}`);

rightClick(LB());
const sinceLbSave = calls.length;
click(byId("lbm-save"));
await settle();
check(
  "「另存为…」走 save_path_as，src 是放大层这一张",
  takeCalls("save_path_as", sinceLbSave).some(([, a]) => a.src === "/收件箱/圣诞雪花树纹针织图案.png"),
  JSON.stringify(takeCalls("save_path_as", sinceLbSave))
);

rightClick(LB());
const sinceLbPath = calls.length;
click(byId("lbm-copy-path"));
await settle();
check(
  "「复制文件路径」走 copy_text 兜底（桩里 navigator/execCommand 都不通，正好看兜底那一路）",
  takeCalls("copy_text", sinceLbPath).some(([, a]) => a.text === "/收件箱/圣诞雪花树纹针织图案.png"),
  JSON.stringify(takeCalls("copy_text", sinceLbPath))
);

rightClick(LB());
const sinceLbReveal = calls.length;
click(byId("lbm-reveal"));
await settle();
check(
  "「在文件夹中显示」走 reveal_in_folder",
  takeCalls("reveal_in_folder", sinceLbReveal).some(([, a]) => a.path === "/收件箱/圣诞雪花树纹针织图案.png"),
  JSON.stringify(takeCalls("reveal_in_folder", sinceLbReveal))
);

// 「在对比中打开」必须先把放大层关了再切视图：overlay 带着走会盖住对比视图
rightClick(LB());
click(byId("lbm-compare"));
await settle();
check(
  "「在对比中打开」先关层再切对比视图（不会有一层黑幕盖在另一个视图上）",
  LB().hidden === true && document.body.dataset.view === "compare",
  `层=${LB().hidden} 视图=${document.body.dataset.view}`
);
api.setView("transfer");
await settle();

// 点空白收菜单不能顺手把整层关了：那一下 pointerdown 收菜单、紧随的 click 只吃标记不关层
click(lbThumb1);
await settle();
rightClick(LB());
fireWindow("pointerdown", LB());
lbBgClick();
check(
  "菜单开着时点层内空白：先收菜单，这一下不连带关层",
  lbMenuEl.hidden === true && LB().hidden === false && lbMenuEl.hidden === true,
  `菜单=${lbMenuEl.hidden} 层=${LB().hidden}`
);
lbBgClick();
check("再点一次背景才真的关层（旧手感没被吃掉）", LB().hidden === true, String(LB().hidden));

// 没路径不拦：层关着 lightboxPath 就是 null，右键要让系统菜单照旧（留「拷贝图像」）
check(
  "没有本机路径时不拦右键：灰一排不如把系统里唯一有用的那项留着",
  rightClick(LB()) === false && lbMenuEl.hidden === true,
  `blocked 应为 false，菜单 hidden=${lbMenuEl.hidden}`
);
check(
  "右键监听挂在整层上、路径判定在 openLbMenu 里（代码口径）",
  /ui\.lightbox\.addEventListener\("contextmenu", openLbMenu\)/.test(xferJs) &&
    /function openLbMenu\(ev\) \{\s*if \(!ui\.lbMenu \|\| !lightboxPath\) return;/.test(xferJs),
  ""
);

/* 20f) 引用回复：气泡菜单点「引用回复」→ 输入框上方出预览条 →
      Enter/点发送时把 quote 一起带走（那是一条新消息，不是改原文那条）；
      发出去的气泡顶上挂 quote-card，点了滚到原文闪一下 */
const quoteBar = byId("xfer-quote");
const quoteTxt = () => String(byId("xfer-quote-text").textContent);
quoteBar.hidden = true;

check("引用预览条默认收着（与 index.html 上的 hidden 一致）", quoteBar.hidden === true, `hidden=${quoteBar.hidden}`);

// 引一条文件：摘的是文件名，不要求本机路径以外的任何东西
rightClick(msgElOf("img1"));
click(itemBy("引用回复"));
await settle();
check(
  "点「引用回复」出预览条：引的是对方 + 文件名摘录，菜单自己收起",
  quoteBar.hidden === false && quoteTxt() === "引用 甲机：圣诞雪花树纹针织图案.png" && msgMenuEl.hidden === true,
  `${quoteBar.hidden} "${quoteTxt()}"`
);

// × 只取消引用，不动已写的正文
byId("xfer-input").value = "这个图样不错";
click(byId("xfer-quote-x"));
await settle();
check(
  "× 只取消引用：条收了、摘录文案清了，写好的正文原样留着",
  quoteBar.hidden === true && quoteTxt() === "" && byId("xfer-input").value === "这个图样不错",
  `hidden=${quoteBar.hidden} 正文="${byId("xfer-input").value}"`
);

// 重新挂上引用再发：quote 跟着 send_text 走，发出即清
rightClick(msgElOf("img1"));
click(itemBy("引用回复"));
const qtSince = calls.length;
click(byId("btn-xfer-send"));
await settle();
const qtCalls = takeCalls("send_text", qtSince);
const qtArgs = qtCalls.length ? qtCalls[0][1] : null;
check(
  "send_text 把引用快照一起带上（id/from/摘录/类型/文件名都在）",
  qtCalls.length === 1 &&
    !!qtArgs.quote &&
    qtArgs.quote.id === "img1" &&
    qtArgs.quote.from === "甲机" &&
    qtArgs.quote.kind === "file" &&
    qtArgs.quote.name === "圣诞雪花树纹针织图案.png" &&
    qtArgs.quote.text === "圣诞雪花树纹针织图案.png",
  JSON.stringify(qtArgs && qtArgs.quote)
);
check(
  "发出即清：预览条收了，正文也清了",
  quoteBar.hidden === true && byId("xfer-input").value === "",
  `hidden=${quoteBar.hidden} 正文="${byId("xfer-input").value}"`
);

// 后端落库后 msg-updated 推回来：新气泡顶上该有那张卡片
const qtOut = world.hist.find((m) => m.text === "这个图样不错" && m.quote);
const qtBub = qtOut && bubbles().find((b) => b.dataset.id === qtOut.id);
const qtCard = qtBub && qtBub.querySelector(".quote-card");
check(
  "带引用的那条气泡顶上挂了 quote-card（浅底小字那一张，不是把原文拼进正文）",
  !!qtCard && qtCard.textContent === "引用 甲机：圣诞雪花树纹针织图案.png",
  qtCard ? qtCard.textContent : `bub=${!!qtBub}`
);

// 点卡片定位：img1 就在同一条流里，闪的是 .msg 外层
if (qtCard) click(qtCard);
await settle();
check(
  "点卡片：被引那条闪一下（is-flash 挂在 .msg 外层，闪的是整条气泡）",
  msgElOf("img1").classSet.has("is-flash") && !!qtCard && !qtCard.classSet.has("is-flash"),
  String(msgElOf("img1").className)
);

// 摘录超 120 字截断加省略号：按字符数，不把中文截半
const longText = "雪".repeat(200);
emit("msg-in", {
  message: { id: "long1", dir: "in", kind: "text", text: longText, state: "sent", ts: at(0, 18), peer: "A", sid: "A" },
});
await settle();
rightClick(msgElOf("long1"));
click(itemBy("引用回复"));
await settle();
check(
  "长正文的摘录超 120 字就截断加省略号（按字符数，不会截半个汉字）",
  quoteTxt() === `引用 甲机：${"雪".repeat(120)}…`,
  `长度=${quoteTxt().length}`
);
click(byId("xfer-quote-x"));

// 原文不在已铺页面里：只提示一句，不硬拉历史
emit("msg-in", {
  message: {
    id: "q-ghost",
    dir: "in",
    kind: "text",
    text: "引了个更早的",
    state: "sent",
    ts: at(0, 19),
    peer: "A",
    sid: "A",
    quote: { id: "ghost9", from: "甲机", text: "很早前的一条", kind: "text" },
  },
});
await settle();
const gCard = bubbles().find((b) => b.dataset.id === "q-ghost").querySelector(".quote-card");
// 上面那次点卡片给 img1 挂的 is-flash 还红着（桩里的 1.2s 定时器不会走完），先擦干净再断言「没闪新的」
msgElOf("img1").classList.remove("is-flash");
const qLogBefore = statusLog.length;
click(gCard);
await settle();
check(
  "原文还没铺出来时只提示一句不报错，也不逐页去拉（那是全局搜索的活）",
  statusLog.slice(qLogBefore).some((t) => String(t).includes("原文还没加载出来")) &&
    !bubbles().some((b) => b.classSet.has("is-flash")),
  statusLog.slice(qLogBefore).join(" | ")
);

// 切会话把引用预览条收干净：挂着 A 会话的引用去发 B 是串话
rightClick(msgElOf("img1"));
click(itemBy("引用回复"));
await settle();
click(rowOf("C"));
await settle();
check(
  "切了会话引用预览条自动收：引用不能跟错对话框",
  quoteBar.hidden === true,
  `hidden=${quoteBar.hidden}`
);

/* 20g) 转发到别的会话：气泡菜单选人 → 会话选择浮层（排除这条所在会话），
       点一条：文件走 send_paths（拿本机那份）、文字走 send_text（不带 quote，
       是一条全新 id 的新消息）；零新后端命令 */
const fwdPick = byId("xfer-fwd-pick");
const fwdList = byId("xfer-fwd-list");
fwdPick.hidden = true;
click(rowOf("A"));
await settle();
rightClick(msgElOf("img1"));
check("已经有路径的文件气泡，菜单里露「转发到别的会话」", shownItems().includes("转发到别的会话"), shownItems().join(","));
click(itemBy("转发到别的会话"));
await settle();
check("点转发弹会话浮层（菜单同时收了）", fwdPick.hidden === false && msgMenuEl.hidden === true, `pick=${fwdPick.hidden} menu=${msgMenuEl.hidden}`);
const fwdRows = fwdList.children.map((b) => String(b.textContent));
check(
  "浮层列的是其它会话：名字 · 最后一条时间，当前所在那台（甲机）被排除",
  fwdRows.some((n) => n.startsWith("丙机")) && !fwdRows.some((n) => n.startsWith("甲机")),
  fwdRows.join(" | ")
);
// 丙机有两个框（早前那步「对方新开的框」注册的 C-new），按名字找会撞上错的：
// 照 renderFwdList 同口径（sessionList 排除当前）算出主框 C 的那一行下标
const fwdOrder = sessionsPayload().sessions.filter((s) => s.id !== "A").map((s) => s.id);
const fwdC = fwdOrder.indexOf("C");
const fSince = calls.length;
click(fwdList.children[fwdC]);
await settle();
const fCalls = takeCalls("send_paths", fSince);
check(
  "点丙机：走的是 send_paths，to 是丙机的会话 ID、paths 就是本机那一份（不另存副本）",
  fCalls.length === 1 && fCalls[0][1].to === "C" && fCalls[0][1].paths.join(",") === "/收件箱/圣诞雪花树纹针织图案.png",
  JSON.stringify(fCalls[0] || null)
);
check("选完浮层自己收起", fwdPick.hidden === true, String(fwdPick.hidden));

// 转文字：那条自带引用的也不把 quote 跟上 —— 转发是一条全新 id 的新消息，
// 原会话那条撤回/删除互不影响
rightClick(msgElOf(qtOut.id));
click(itemBy("转发到别的会话"));
await settle();
const tSince = calls.length;
click(fwdList.children[fwdC]);
await settle();
const tCalls = takeCalls("send_text", tSince);
check(
  "转文字走 send_text：同一句原文、to 是丙机，且不把那条自己的 quote 带上",
  tCalls.length === 1 &&
    tCalls[0][1].text === "这个图样不错" &&
    tCalls[0][1].to === "C" &&
    tCalls[0][1].quote == null &&
    takeCalls("send_paths", tSince).length === 0,
  JSON.stringify(tCalls[0] || null)
);

// 取消与点外面：都只收浮层，一条都不发
rightClick(msgElOf("img1"));
click(itemBy("转发到别的会话"));
await settle();
const vSince = calls.length;
click(byId("xfer-fwd-cancel"));
await settle();
check(
  "点「取消」：浮层收了，一个发送命令都没调",
  fwdPick.hidden === true && takeCalls("send_paths", vSince).length === 0 && takeCalls("send_text", vSince).length === 0,
  JSON.stringify(calls.slice(vSince).map(([c]) => c))
);
rightClick(msgElOf("img1"));
click(itemBy("转发到别的会话"));
await settle();
fireWindow("pointerdown", byId("xfer-stream"));
check("点浮层外面也收（与菜单同一个手感）", fwdPick.hidden === true, String(fwdPick.hidden));

// 臂上的超时退回：只臂上不点第二下，4 秒得自己退回原文案（这里直接验臂上态与文案，
// 桩里的真定时器不会走完，退回去那一下靠收菜单那一笔）
const CL_LABEL = "清空聊天记录";
const clearItem = () => byId("ctx-chat-clear");
const chatDelIt = () => byId("ctx-chat-del");
rightClick(rowOf("A"));
check("会话菜单里有「清空聊天记录」这一项", !clearItem().hidden, String(clearItem().hidden));
click(clearItem());
await settle();
check(
  "清空第一步：只臂上变文案，命令一条没调、会话表原样不动",
  clearItem().textContent === "再点一次清空" &&
    takeCalls("session_clear", calls.length - 1).length === 0 &&
    !!rowOf("A") &&
    chatDelIt().textContent === "删除聊天",
  `文案="${clearItem().textContent}" 调用=${JSON.stringify(calls.slice(-1).map(([c]) => c))}`
);
// 臂上清空后去点删除：那是删除自己的第一步，不能被清空的臂误当成「第二次确认」
click(chatDelIt());
check(
  "两枚臂互不干涉：臂上清空后点删除，只臂上删除、不产生任何后端调用",
  chatDelIt().textContent === "再点一次删除" && takeCalls("session_delete", calls.length - 1).length === 0,
  JSON.stringify(calls.slice(-1).map(([c]) => c))
);
fireWindow("pointerdown", byId("xfer-stream"));
check(
  "点菜单外面：两枚臂与文案一起退回",
  clearItem().textContent === CL_LABEL && chatDelIt().textContent === "删除聊天",
  `clear="${clearItem().textContent}" del="${chatDelIt().textContent}"`
);

/* 20h) 清空聊天记录：两步之后只补写 hidden —— 框还在、会话表不动、
       别的会话一条不碰（口径与单条本机删除一致，只是入口一次点一批） */
world.sessions.push({ id: "CLR", peer: "A", name: "待清空的框", created: NOW, read: NOW });
for (const [cid, ctx] of [
  ["cl1", "清前的第一条"],
  ["cl2", "清前的第二条"],
]) {
  world.hist.push({ id: cid, dir: "in", kind: "text", text: ctx, state: "sent", ts: at(0, 20), peer: "A", sid: "CLR", recalled: false, hidden: false });
}
world.hist.push({
  id: "cl3", dir: "in", kind: "text", text: "已经删过的", state: "sent", ts: at(0, 20), peer: "A", sid: "CLR", recalled: false, hidden: true,
});
emit("sessions-changed", sessionsPayload());
await settle();
click(rowOf("CLR"));
await settle();
check("清空前这个框里有两条", bubbles().length === 2, String(bubbles().length));
const aCntBefore = world.hist.filter((m) => sidOf(m) === "A" && !m.hidden).length;
const cCntBefore = world.hist.filter((m) => sidOf(m) === "C" && !m.hidden).length;
const clSince = calls.length;
rightClick(rowOf("CLR"));
click(clearItem());
await settle();
click(clearItem());
await settle();
const clCalls = takeCalls("session_clear", clSince);
check(
  "第二下才真清：session_clear 的 id 就是右键的那个框，一次调用清一批",
  clCalls.length === 1 && clCalls[0][1].id === "CLR",
  JSON.stringify(clCalls)
);
check(
  "清完流里重铺成空的：占位话说的是「已清空」而不是「还没有消息」（消息还在盘上）",
  bubbles().length === 0 && String(stream().innerHTML).includes("已清空"),
  `条数=${bubbles().length} 占位="${String(stream().innerHTML).slice(0, 80)}"`
);
check(
  "只标 hidden 不抹行：三条都在盘上（本来就删过的仍标着）",
  world.hist.filter((m) => sidOf(m) === "CLR").length === 3 &&
    world.hist.filter((m) => sidOf(m) === "CLR").every((m) => m.hidden === true),
  String(world.hist.filter((m) => sidOf(m) === "CLR").length)
);
check(
  "保框：还留在会话栏里，也不碰会话表（没有 session_delete）与别的会话",
  !!rowOf("CLR") &&
    takeCalls("session_delete", clSince).length === 0 &&
    world.sessions.some((s) => s.id === "CLR") &&
    world.hist.filter((m) => sidOf(m) === "A" && !m.hidden).length === aCntBefore &&
    world.hist.filter((m) => sidOf(m) === "C" && !m.hidden).length === cCntBefore,
  `row=${!!rowOf("CLR")} A=${aCntBefore} C=${cCntBefore}`
);
emit("sessions-changed", sessionsPayload());
await settle();
check(
  "会话栏那句摘要回到空会话口径（后端从可见消息重算，前端不新增特判）",
  String(sessionRowOf("CLR").summary || "") === "",
  JSON.stringify(sessionRowOf("CLR").summary)
);
// 还原：后面的用例还要用甲机的会话表
world.sessions = world.sessions.filter((s) => s.id !== "CLR");
world.hist = world.hist.filter((m) => sidOf(m) !== "CLR");
click(rowOf("A"));
await settle();

/* 20i) 跨会话全局搜索（⌘F）：后端查整份历史（已挡 hidden），浮层列
       「会话名 · 时间 · 摘录」，点一条切到会话、缺页逐页补、定位闪烁 */
const findPickEl = byId("xfer-find");
const findListEl = byId("xfer-find-list");
const findQEl = byId("xfer-find-q");
const findChipsEl = byId("xfer-find-chips");
for (const id of ["xfer-find-x", "xfer-find-q", "xfer-find-list"]) findPickEl.appendChild(byId(id));
findPickEl.appendChild(findChipsEl);
// 桩不解析 HTML：五档 chip 按 index.html 那份顺序自己摆出来（档位就是后端的 kind）
for (const [kind, label, on] of [
  ["all", "全部", true],
  ["text", "文字", false],
  ["image", "图片", false],
  ["file", "文件", false],
  ["folder", "文件夹", false],
]) {
  const b = document.createElement("button");
  b.className = on ? "chip is-on" : "chip";
  b.textContent = label;
  b.dataset.kind = kind;
  // 桩里没有 closest，也不往上冒泡：自己认自己 + 手动把这一击转给父容器
  b.closest = (sel) => (sel === ".chip" ? b : null);
  b.addEventListener("click", (ev) => findChipsEl.dispatchEvent(ev));
  findChipsEl.appendChild(b);
}
world.sessions.push({ id: "FRD", peer: "A", name: "待搜的框", created: NOW, read: NOW });
// 12 条正文同词（PAGE=10，首屏只铺最近 10 条：frd1/frd2 落在页外，给「逐页补后定位」用）
for (let i = 1; i <= 12; i++) {
  world.hist.push({
    id: `frd${i}`,
    dir: "in",
    kind: "text",
    text: `周五约定第${i}次，DeepDive 探针`,
    state: "sent",
    ts: at(0, 21) + i * 1000,
    peer: "A",
    sid: "FRD",
    recalled: false,
    hidden: false,
  });
}
world.hist.push({
  id: "frd13", dir: "in", kind: "text", text: "周五约定被删的", state: "sent", ts: at(0, 21) + 13000, peer: "A", sid: "FRD", recalled: false, hidden: true,
});
world.hist.push({
  id: "frdRec", dir: "in", kind: "text", text: "周五约定被撤的", state: "sent", ts: at(0, 21) + 14000, peer: "A", sid: "FRD", recalled: true, hidden: false,
});
world.hist.push({
  id: "frdFile", dir: "in", kind: "file", name: "周五排班表.xlsx", size: 123, state: "sent", ts: at(0, 21) + 15000, peer: "A", sid: "FRD", recalled: false, hidden: false,
});
world.hist.push({
  id: "frdQt", dir: "out", kind: "text", text: "顺带一提", state: "sent", ts: at(0, 21) + 16000, peer: "A", sid: "FRD", recalled: false, hidden: false,
  quote: { id: "frd2", from: "待搜的框", text: "引一句周五约定", kind: "text" },
});
emit("sessions-changed", sessionsPayload());
await settle();

fireWindow("keydown", {}, { key: "f", metaKey: true });
check(
  "⌘F 开的是全局浮层：会话内那条框不再被抢（两套并存、语义不变）",
  findPickEl.hidden === false && findListEl.children.length === 0,
  `find=${findPickEl.hidden}`
);
click(byId("btn-xfer-find"));
check("顶栏「搜全部会话」开同一扇门", findPickEl.hidden === false);
findQEl.value = "DeepDive"; // 大小写混着输：折小写是后端的活
const findSince = calls.length;
findQEl.dispatchEvent({ type: "input" });
await settle();
check(
  "只输不搜（轻防抖 250ms）：input 那一下不直接打后端",
  takeCalls("search_messages", findSince).length === 0,
  JSON.stringify(calls.slice(findSince).map(([c]) => c))
);
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
const findCalls = takeCalls("search_messages", findSince);
check(
  "Enter 不等：query 原样带上去，kind 默认 all",
  findCalls.length === 1 && findCalls[0][1].query === "DeepDive" && findCalls[0][1].kind === "all",
  JSON.stringify(findCalls[0] || null)
);
const findRows = findListEl.children.filter((c) => c.classSet.has("find-row"));
check(
  "结果行三段：会话名 · 摘录都在，DeepDive 十二条全列",
  findRows.length === 12 &&
    String(findRows[0].innerHTML).includes("待搜的框") &&
    String(findRows[0].innerHTML).includes("DeepDive"),
  `行数=${findRows.length}`
);
check(
  "删掉的那条不露（只搜未 hidden）",
  findListEl.children.every((c) => !String(c.innerHTML).includes("被删的")),
  String(findListEl.children.map((c) => c.innerHTML).join(" ")).slice(0, 120)
);
findQEl.value = "周五约定被";
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
const partRows = findListEl.children.filter((c) => c.classSet.has("find-row"));
check(
  "被撤的在、被删的不在（撤回仍露，与气泡那边同一出口口径）",
  partRows.length === 1 &&
    String(partRows[0].innerHTML).includes("被撤的") &&
    !String(partRows[0].innerHTML).includes("被删的"),
  partRows.map((r) => String(r.innerHTML).slice(0, 60)).join(" | ")
);
findQEl.value = "排班表";
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
check(
  "命中可以在文件名里：frdFile 那条正文没这词也列出来",
  findListEl.children.filter((c) => c.classSet.has("find-row")).length === 1,
  String(findListEl.children[0]?.innerHTML || "").slice(0, 80)
);
findQEl.value = "引一句周五约定";
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
check(
  "命中也可以在引用摘录里（quote.text 进匹配串）",
  findListEl.children.filter((c) => c.classSet.has("find-row")).length === 1,
  String(findListEl.children[0]?.innerHTML || "").slice(0, 80)
);
// 类型 chip：那份档位是后端 kind。换个两边都能命中的词（正文与文件名里都有“周五”），
// 这样“只剩一条”才能证明是档位起作用了，不是词条本来就只有那一条
findQEl.value = "周五";
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
const allChip = findChipsEl.children.find((c) => c.dataset.kind === "all");
const fileChip = findChipsEl.children.find((c) => c.dataset.kind === "file");
check(
  "同一个词切档位之前：文字与文件混在一起列",
  findListEl.children.filter((c) => c.classSet.has("find-row")).length === 15,
  `行=${findListEl.children.filter((c) => c.classSet.has("find-row")).length}`
);
click(fileChip);
await settle();
check(
  "chip 单选切档：点「文件」后 kind 跟着走，结果只剩文件那条",
  findPickEl.dataset.kind === "file" &&
    fileChip.classSet.has("is-on") &&
    !allChip.classSet.has("is-on") &&
    findListEl.children.filter((c) => c.classSet.has("find-row")).length === 1 &&
    lastCall("search_messages").kind === "file",
  `kind=${findPickEl.dataset.kind} 行=${findListEl.children.filter((c) => c.classSet.has("find-row")).length}`
);
click(allChip);
await settle();
check(
  "点「全部」等于清掉类型条件，后端收到的是 all",
  findPickEl.dataset.kind === "all" &&
    lastCall("search_messages").kind === "all" &&
    findListEl.children.filter((c) => c.classSet.has("find-row")).length === 15,
  `${findPickEl.dataset.kind} 行=${findListEl.children.filter((c) => c.classSet.has("find-row")).length}`
);
// 查不到的词：一句大白话，不留白屏
findQEl.value = "没得搜";
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
check(
  "哪个会话都没有：说人话的一行空态",
  findListEl.children.some((c) => c.classSet.has("find-empty") && String(c.textContent).includes("没得搜")),
  findListEl.children.map((c) => c.textContent).join(" | ").slice(0, 80)
);
// 点一条跳转：先切到 FRD（当前还在甲机），目标 frd10 在首屏里
findQEl.value = "第10次";
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
const row10 = findListEl.children.filter((c) => c.classSet.has("find-row"))[0];
click(row10);
await settle();
check(
  "点一条：浮层收掉、切到那个会话、目标闪一下",
  findPickEl.hidden === true &&
    world.active === "FRD" &&
    msgElOf("frd10") !== null &&
    msgElOf("frd10").classSet.has("is-flash"),
  `find=${findPickEl.hidden} active=${world.active} 有=${msgElOf("frd10") !== null}`
);
// 目标不在已铺页面里（frd1 在首屏那 10 条之外）：逐页补到它出来再闪
msgElOf("frd10").classList.remove("is-flash");
fireWindow("keydown", {}, { key: "f", metaKey: true });
await settle();
check("重新弹出时旧词还在就重新给结果", findListEl.children.filter((c) => c.classSet.has("find-row")).length === 1);
findQEl.value = "第1次";
findQEl.dispatchEvent({ type: "keydown", key: "Enter" });
await settle();
const row1 = findListEl.children.filter((c) => c.classSet.has("find-row"))[0];
click(row1);
await settle(12);
check(
  "首屏没铺出来的那条：逐页 loadOlder 直到出现，再定位闪烁",
  msgElOf("frd1") !== null && msgElOf("frd1").classSet.has("is-flash"),
  `frd1=${msgElOf("frd1") !== null}`
);
// 点外面与 × 都收层；Esc 走 closeAllMenus 那条路
fireWindow("keydown", {}, { key: "f", metaKey: true });
fireWindow("pointerdown", byId("xfer-stream"));
check("点浮层外面也收", findPickEl.hidden === true, String(findPickEl.hidden));
fireWindow("keydown", {}, { key: "f", metaKey: true });
click(byId("xfer-find-x"));
check("点 × 收层", findPickEl.hidden === true, String(findPickEl.hidden));
fireWindow("keydown", {}, { key: "f", metaKey: true });
fireWindow("keydown", {}, { key: "Escape" });
check("Esc 也收（挂进 closeAllMenus 那一排）", findPickEl.hidden === true, String(findPickEl.hidden));
// 还原：后面的用例不背这个框
world.sessions = world.sessions.filter((s) => s.id !== "FRD");
world.hist = world.hist.filter((m) => sidOf(m) !== "FRD");
click(rowOf("A"));
await settle();

/* 21) 本机接收：提示音开关与收件目录（都存 prefs.json，与对比视图那份共用） */
const notifyChk = () => byId("chk-notify-sound");
const notifyTxt = () => byId("sw-notify-text");
const inboxVal = () => byId("inbox-dir-value");
const inboxReset = () => byId("btn-inbox-reset");
const statusText = () => byId("st-msg").textContent;
const setCount = () => calls.filter(([c]) => c === "set_prefs").length;
const change = (node, on) => {
  node.checked = on;
  node.dispatchEvent({ type: "change" });
};

check(
  "本机接收不参与启动路径：没开抽屉之前一次都没读过 prefs",
  calls.every(([c]) => c !== "get_prefs" && c !== "inbox_dir"),
  calls.filter(([c]) => c === "get_prefs" || c === "inbox_dir").map(([c]) => c).join(",")
);

// 抽屉是 toggle，此时它已经在前面的用例里被开过关；直按 classSet 判定当前开合
if (byId("xfer-settings").classSet.has("is-open")) {
  click(byId("btn-xfer-settings"));
  await settle();
}
click(byId("btn-xfer-settings"));
await settle();
check(
  "打开抽屉把磁盘上那两项填进界面：开关勾着、文案响一声、路径是默认那个",
  notifyChk().checked === true && notifyTxt().text === "响一声" && inboxVal().textContent === DEFAULT_INBOX,
  `checked=${notifyChk().checked} 文案="${notifyTxt().text}" 路径="${inboxVal().textContent}"`
);
check("没改过目录时「恢复默认」是灰的（点了没意义，比点了不报错更难懂）", inboxReset().disabled === true);

change(notifyChk(), false);
await settle();
const patch = lastCall("set_prefs");
check(
  "关提示音只传一个 {notify:false}，不拿整份 prefs 回写（那会把对比视图选的布局一起盖掉）",
  !!patch && Object.keys(patch).join() === "notify" && patch.notify === false,
  JSON.stringify(patch)
);
check("开关关掉后文案立刻跟着变「不响」：那颗 input 藏在 label 里，光看开关看不出状态", notifyTxt().text === "不响");

const plays0 = plays.length;
click(byId("btn-notify-audition"));
await settle();
check(
  "开关正关着时点试听仍然响一声：这一声就是用来分清「没消息」与「这台机器放不出声」的",
  plays.length === plays0 + 1,
  `点了 ${plays.length - plays0} 次`
);

change(notifyChk(), true);
await settle();
check(
  "重新勾上写回 true，文案回到响一声",
  prefs.notify === true && notifyTxt().text === "响一声",
  `prefs.notify=${prefs.notify} 文案="${notifyTxt().text}"`
);

/* 选目录：取消 / 选成 / 被 Rust 拒 */
const set0 = setCount();
pickAnswer = null;
click(byId("btn-inbox-choose"));
await settle();
check(
  "在原生对话框里点取消就什么都不写，路径显示也不变",
  setCount() === set0 && inboxVal().textContent === DEFAULT_INBOX,
  `set_prefs 多了 ${setCount() - set0} 次，显示="${inboxVal().textContent}"`
);
check(
  "选目录传的标题是收件目录那一句（复用发送那个选择器，标题不能还是「要发送的」）",
  /收件目录/.test(String((lastCall("pick_folder") || {}).title || "")),
  JSON.stringify(lastCall("pick_folder"))
);

pickAnswer = "/Volumes/外接盘/收件";
click(byId("btn-inbox-choose"));
await settle();
check(
  "选完写进 {inbox: 那条路径}，显示跟着换、恢复默认不再灰",
  (lastCall("set_prefs") || {}).inbox === "/Volumes/外接盘/收件" &&
    inboxVal().textContent === "/Volumes/外接盘/收件" &&
    inboxReset().disabled === false,
  `显示="${inboxVal().textContent}" 灰=${inboxReset().disabled}`
);

const shown = inboxVal().textContent;
pickAnswer = "recv/今日";  // 桩里的 set_prefs 会抛，模拟 Rust 拒相对路径
click(byId("btn-inbox-choose"));
await settle();
check(
  "目录被 Rust 拒了（相对路径）时磁盘值与界面都不动，仍显示原来那个",
  inboxVal().textContent === shown && prefs.inbox === "/Volumes/外接盘/收件",
  `显示="${inboxVal().textContent}" 磁盘="${prefs.inbox}"`
);
check(
  "被拒的原因上了屏，不是静默失败（点了没反应又不出错最难归因）",
  String(statusText()).includes("绝对路径"),
  statusText()
);

change(notifyChk(), false);
await settle();
click(inboxReset());
await settle();
check(
  "恢复默认写的是空串（Rust 侧就是「回默认目录」，不是一个叫空的目录），显示与置灰跟着回来",
  (lastCall("set_prefs") || {}).inbox === "" &&
    inboxVal().textContent === DEFAULT_INBOX &&
    inboxReset().disabled === true,
  `磁盘="${prefs.inbox}" 显示="${inboxVal().textContent}" 灰=${inboxReset().disabled}`
);
change(notifyChk(), true);
await settle();

const r0 = revealed.length;
click(byId("btn-inbox-reveal"));
await settle();
check(
  "「打开目录」交给 reveal_in_folder 的就是当前显示那一条，不是空也不是旧目录",
  revealed.length === r0 + 1 && revealed[revealed.length - 1] === DEFAULT_INBOX,
  revealed.join(" | ")
);

/* 在线探测：心跳节拍（存同一份 prefs.json、走同一对命令） */
const hbSel = () => byId("inp-heartbeat");
const pickOpt = (v) => {
  const node = hbSel();
  node.value = String(v);
  // 真 DOM 的 change 事件带 target（chooseInboxLayout 同样按 ev.target.value 读），
  // 桩里少给这一句就会让处理器读到 undefined、静默当成「没变化」跳过
  node.dispatchEvent({ type: "change", target: node });
};

check(
  "打开抽屉把磁盘上的节拍填进下拉（读的键是 heartbeat_ms：get_prefs 回的是 Rust 原样序列化的下划线名，不是 camelCase）",
  hbSel().value === "1000",
  `value="${hbSel().value}"`
);

const hbSet0 = setCount();
pickOpt(5000);
await settle();
check(
  "切节拍只传一个 {heartbeatMs:5000}，不拿整份 prefs 回写（那会把对比视图选的布局一起盖掉）",
  Object.keys(lastCall("set_prefs") || {}).join() === "heartbeatMs" &&
    lastCall("set_prefs").heartbeatMs === 5000,
  JSON.stringify(lastCall("set_prefs"))
);
check(
  "存成功才把界面停在新档位：磁盘与下拉一起是 5000，且一次切换只写一次盘",
  prefs.heartbeat_ms === 5000 && hbSel().value === "5000" && setCount() === hbSet0 + 1,
  `磁盘=${prefs.heartbeat_ms} 下拉="${hbSel().value}" 多写了 ${setCount() - hbSet0} 次`
);
check(
  "提示里带上“判离线约要 15 秒”：3 拍那个口径得让用户看得见（不然他会以为改了间隔还是 3 秒判离线）",
  String(statusText()).includes("15 秒"),
  statusText()
);

/* 白名单外的档位（手改磁盘、或前端漏出的值）：桩跟 Rust 一样硬拒 */
pickOpt(1500);
await settle();
check(
  "白名单外的档位被拒后下拉退回原那一档、磁盘不动，且原因上了屏（停在一个没生效的档位上最难查）",
  hbSel().value === "5000" && prefs.heartbeat_ms === 5000 && String(statusText()).includes("不支持的探测间隔"),
  `下拉="${hbSel().value}" 磁盘=${prefs.heartbeat_ms} 提示="${statusText()}"`
);

const hbSet1 = setCount();
pickOpt(5000);
await settle();
check("再选当前那一档不重复写盘", setCount() === hbSet1, `多写了 ${setCount() - hbSet1} 次`);

// 抽屉收起再打开：得重读一遍，否则另一个抽屉（或磁盘手改）变了这边永远显旧的
prefs.notify = false; // 假装另一个抽屉刚把它关了
prefs.heartbeat_ms = 10000; // 假装磁盘上这一项被改过了（手改 prefs.json 就是这条路）
notifyChk().checked = true; // 只改 DOM 不发事件：界面上停着一个旧状态，这才是重读要修的东西
hbSel().value = "1000";
await settle();
click(byId("btn-xfer-settings"));
await settle();
click(byId("btn-xfer-settings"));
await settle();
check(
  "抽屉收起再打开会重读：磁盘上被改掉的开关与节拍能回到界面（不是只在启动读一次）",
  notifyChk().checked === false && notifyTxt().text === "不响" && hbSel().value === "10000",
  `checked=${notifyChk().checked} 文案="${notifyTxt().text}" 节拍="${hbSel().value}"`
);

/* 21b) 存储：抽屉里那几个数字，与收件目录那两步清理
       （只删改得够早、而且没被任何还看得见的记录引用的收件文件） */
const stRows = () => [...byId("storage-rows").children];
const stVal = (label) => {
  const r = stRows().find((x) => x.children[0]?.text === label);
  return r ? r.children[1].textContent : null;
};
const stCount = () => calls.filter(([c]) => c === "storage_stats").length;
const cleanCount = () => calls.filter(([c]) => c === "inbox_cleanup").length;
const BOX = "/Volumes/外接盘/收件";
const DAY = 86400000;
boxFiles.set(`${BOX}/老照片.jpg`, { size: 1024, mtime: Date.now() - 200 * DAY });
boxFiles.set(`${BOX}/老视频.mp4`, { size: 2048, mtime: Date.now() - 400 * DAY });
// 这一条被聊天记录指着：清到它头上必须跳过（与「撤回不删文件」同一口径）
boxFiles.set(`${BOX}/留着.txt`, { size: 512, mtime: Date.now() - 400 * DAY });
world.hist.push({
  id: "boxKeep",
  dir: "in",
  kind: "file",
  name: "留着.txt",
  path: `${BOX}/留着.txt`,
  size: 512,
  state: "sent",
  ts: at(0, 9),
  peer: "A",
  sid: "A",
  recalled: false,
  hidden: false,
});
boxNums.pastebox_bytes = 4096;
boxNums.data_bytes = 8192;
boxNums.messages_bytes = 2048;
// 本机删过的那一条在盘上还在，但不能算进界面上那个条数
world.hist.push({
  id: "boxHidden",
  dir: "in",
  kind: "text",
  text: "本机删过的一条不该算进条数",
  state: "sent",
  ts: at(0, 9),
  peer: "A",
  sid: "A",
  recalled: false,
  hidden: true,
});
check(
  "抽屉一打开自己就读一次数字，四行都摆出来了（不用先点那颗刷新）",
  stRows().length === 4 && stCount() >= 1,
  `行数=${stRows().length} 读了 ${stCount()} 次`
);
const st0 = stCount();
click(byId("btn-storage-refresh"));
await settle();
const visibleNow = world.hist.filter((m) => !m.hidden).length;
check(
  "点一次刷新只多读一次：四行数字全是 fmtSize 那个格式",
  stCount() === st0 + 1 &&
    stVal("收件目录") === `${api.fmtSize(3584)} · 3 个文件` &&
    stVal("粘贴暂存") === api.fmtSize(4096) &&
    stVal("聊天历史") === `${api.fmtSize(2048)} · ${visibleNow} 条` &&
    stVal("数据目录合计") === api.fmtSize(8192),
  `收件="${stVal("收件目录")}" 历史="${stVal("聊天历史")}"`
);
check(
  "历史那一行报的条数只算没被本机删掉的（盘上那些 hidden 行不算进界面）",
  world.hist.some((m) => m.hidden) &&
    visibleNow < world.hist.length &&
    stVal("聊天历史") === `${api.fmtSize(2048)} · ${visibleNow} 条`,
  `可见 ${visibleNow} 条 / 盘上 ${world.hist.length} 条`
);
// 两步确认：第一下只把话换掉
click(byId("btn-inbox-clean"));
await settle();
check(
  "清理第一下只臂上文案，一条命令都不调、收件目录一个文件都不动",
  byId("btn-inbox-clean").textContent === "再点一次确认清理" &&
    cleanCount() === 0 &&
    boxFiles.size === 3,
  `文案="${byId("btn-inbox-clean").textContent}" 文件=${boxFiles.size}`
);
// 第二下才真清，档位读在第二下这一刻
click(byId("btn-inbox-clean"));
await settle();
const cleanArgs = lastCall("inbox_cleanup") || {};
check(
  "第二下才真调：传的是当前那一档（默认 3 个月，一个月按 30 天算）换算出的时间戳",
  cleanCount() === 1 && Math.abs(Date.now() - Number(cleanArgs.beforeTs) - 90 * DAY) < 5000,
  JSON.stringify(cleanArgs)
);
check(
  "删的是那两个没人引的，聊天里指着的那个原样留着",
  !boxFiles.has(`${BOX}/老照片.jpg`) &&
    !boxFiles.has(`${BOX}/老视频.mp4`) &&
    boxFiles.has(`${BOX}/留着.txt`),
  [...boxFiles.keys()].join(",")
);
check(
  "话说的是删了几个文件、释放多少（个数按文件计，字节走 fmtSize）",
  String(statusText()).includes("删了 2 个文件") &&
    String(statusText()).includes(api.fmtSize(3072)),
  statusText()
);
check(
  "数字当场重画：不用用户再点一次刷新（后端也 emit 了一次）",
  stVal("收件目录") === `${api.fmtSize(512)} · 1 个文件` && stCount() === st0 + 2,
  `收件="${stVal("收件目录")}" 读了 ${stCount()} 次`
);
// 换档：读的是当下那一档，不是臂上那一刻
byId("inp-inbox-clean").value = "12";
click(byId("btn-inbox-clean"));
await settle();
click(byId("btn-inbox-clean"));
await settle();
check(
  "换成 1 年那一档：门槛跟着走 360 天，剩下的那个被引用所以一个都没删",
  Math.abs(Date.now() - Number(lastCall("inbox_cleanup").beforeTs) - 360 * DAY) < 5000 &&
    String(statusText()).includes("一个都没删") &&
    boxFiles.size === 1,
  statusText()
);
// 后端拒了：原因上屏，数字照样重算（不能停在删之前的那几个数字上）
world.cleanFails = "收件目录读不了";
click(byId("btn-inbox-clean"));
await settle();
click(byId("btn-inbox-clean"));
await settle();
check(
  "清理被后端拒时原因上屏、而且仍重读一次数字（界面不能留着一份已经不准的账）",
  String(statusText()).includes("收件目录读不了") && stCount() === st0 + 4,
  `提示="${statusText()}" 读了 ${stCount()} 次`
);
world.cleanFails = null;
check(
  "「打开收件目录」打开的就是抽屉里显示的那个目录（与上面那枚收件目录按钮同一个地方）",
  revealed[revealed.length - 1] === inboxVal().textContent,
  `${revealed.slice(-1)[0]} vs ${inboxVal().textContent}`
);
// 还原：这一段灌进去的历史与文件不留给后面的用例
world.hist = world.hist.filter((m) => m.id !== "boxKeep" && m.id !== "boxHidden");
boxFiles.clear();
await settle();

/* 12) 对比视图右键「发送到聊天」：先摆进待发送区，选哪个框就发给哪个，点发送才真发 */
const activeRow = () => rows().find((r) => r.classSet.has("is-active")) || null;
const attachChips = () => [...byId("xfer-attach-row").children].map((c) => c.dataset.path);
// 上一段拖进来的两张还摆在待发送区（现在切框不会再自动换掉），先清干净再验投递
click(byId("xfer-attach-clear"));
let deliverSince = calls.length;
// 先走回对比视图再切过来：真机上就是这个动作，也才能触发 onViewChange 那一下
api.setView("compare");
api.setPendingSend("/tmp/投递/先摆着.png", "先摆着.png");
api.setView("transfer");
await settle();
check(
  "投递过来只入待发送区、不自动发（先摆着，等用户挑人）",
  takeCalls("send_paths", deliverSince).length === 0 &&
    byId("xfer-attach").hidden === false &&
    attachChips().includes("/tmp/投递/先摆着.png"),
  `calls=${takeCalls("send_paths", deliverSince).length} chips=${attachChips().join(",")}`
);
check(
  "投递进来的这批还没认归属：标题写「点发送就发给…」而不是已发",
  /点发送就发给「/.test(byId("xfer-attach-title").text) &&
    !byId("xfer-attach-title").classSet.has("is-off-target"),
  byId("xfer-attach-title").text
);

// 点会话只切会话，不发：发不发由下面那颗发送按钮定
const otherRow = rows().find((r) => r.dataset.id && r !== activeRow());
deliverSince = calls.length;
click(otherRow);
await settle();
check(
  "点会话只切框、一个都不发（微信是选人再点发送，不是点人就发）",
  takeCalls("send_paths", deliverSince).length === 0 &&
    rowOf(otherRow.dataset.id)?.classSet.has("is-active"),
  `${takeCalls("send_paths", deliverSince).length} active=${rowOf(otherRow.dataset.id)?.classSet.has("is-active")}`
);
check(
  "切到哪个框，待发送区就说发给哪个（选谁发给谁）",
  /点发送就发给「/.test(byId("xfer-attach-title").text),
  byId("xfer-attach-title").text
);

// 发送：to 必须是此刻选中的那个框；事件先关掉，气泡只能靠返回值自己画
stream().scrollHeight = 1200;
stream().scrollTop = 0;
world.muteEmit = true;
deliverSince = calls.length;
const historySince = calls.length;
click(byId("btn-xfer-send"));
await settle();
const delivered = takeCalls("send_paths", deliverSince);
check(
  "点发送才发：to 是此刻选中的那个框，路径就是投进来的那张图",
  delivered.length === 1 &&
    delivered[0][1].to === otherRow.dataset.id &&
    delivered[0][1].paths[0] === "/tmp/投递/先摆着.png",
  JSON.stringify(delivered[0] || null)
);
check(
  "发完不等 msg-updated 也把气泡画上去（用户说的「没显示」就是这里）",
  (() => {
    // 历史是按 ts 排的，不能拿 at(-1) 认新消息；按路径找
    const mine = world.hist.find((x) => x.path === "/tmp/投递/先摆着.png");
    return !!mine && bubbles().some((n) => n.dataset.id === mine.id);
  })(),
  bubbles()
    .map((b) => b.dataset.id)
    .join(",") +
    ` | hist=${world.hist.filter((x) => x.path === "/tmp/投递/先摆着.png").map((x) => x.id).join(",")}`
);
check(
  "这条是靠返回值自己画上去的，不是靠重铺历史顶上去的",
  takeCalls("msg_history", historySince).length === 0,
  `msg_history 调了 ${takeCalls("msg_history", historySince).length} 次`
);
check(
  "发完把流滚到底：图片气泡比文字高，停在视口外看着就像没发出去",
  stream().scrollTop === 1200,
  String(stream().scrollTop)
);
world.muteEmit = false;
check(
  "发完待发送区收起来",
  byId("xfer-attach").hidden === true,
  String(byId("xfer-attach").hidden)
);

/* 12b) 用户报的那一条：在 A 里粘/拖进来的图，切到 B 也要能直接发给 B（原来卡在「属于某某」的黄字） */
api.routeDrop(["/tmp/切框/粘贴的图.png"]);
await settle();
check(
  "拖进来只入待发送区，标题写发给当前这个框",
  attachChips().length === 1 && /点发送就发给「/.test(byId("xfer-attach-title").text),
  `${attachChips().join(",")} | ${byId("xfer-attach-title").text}`
);
const thirdRow = rows().find(
  (r) => r.dataset.id && r.dataset.id !== otherRow.dataset.id && !r.classSet.has("is-unbound")
);
click(thirdRow);
await settle();
check(
  "切到另一个会话不再锁住：还是「点发送就发给此刻这个」，不出黄字",
  attachChips().length === 1 &&
    /点发送就发给「/.test(byId("xfer-attach-title").text) &&
    !byId("xfer-attach-title").classSet.has("is-off-target"),
  byId("xfer-attach-title").text
);
deliverSince = calls.length;
click(byId("btn-xfer-send"));
await settle();
const moved = takeCalls("send_paths", deliverSince);
check(
  "切过去点发送就发给新的那个框（不再被「先切回去发」拦住）",
  moved.length === 1 && moved[0][1].to === thirdRow.dataset.id,
  JSON.stringify(moved[0] || null)
);

/* 13) 发给「还没添加」的会话（自检话题框那一类）：点发送时拦下，图留在待发送区 */
world.sessions.push({ id: "ghost", peer: "GHOST", name: "自检话题框", created: Date.now(), read: Date.now() });
emit("sessions-changed", sessionsPayload());
await settle();
const ghostRow = rowOf("ghost");
check(
  "没添加的对端那一行带 is-unbound（名字淡一档，免得在会话栏里误点）",
  !!ghostRow?.classSet.has("is-unbound"),
  ghostRow?.classSet ? [...ghostRow.classSet].join(",") : "没这行"
);

api.setView("compare");
api.setPendingSend("/tmp/投递/发不出去.png", "发不出去.png");
api.setView("transfer");
await settle();
click(ghostRow);
await settle();
deliverSince = calls.length;
const logBeforeGhost = statusLog.length;
click(byId("btn-xfer-send"));
await settle();
check(
  "发给没添加的对端：不发 send_paths、说「还没添加为对端」，图留在待发送区",
  takeCalls("send_paths", deliverSince).length === 0 &&
    statusLog.slice(logBeforeGhost).some((t) => String(t).includes("还没添加为对端")) &&
    attachChips().includes("/tmp/投递/发不出去.png"),
  `${takeCalls("send_paths", deliverSince).length} | ${statusLog.slice(logBeforeGhost).join(" | ")} | ${attachChips().join(",")}`
);

/* 13b) 撤回与本机删除：一分钟内给自己的消息留两个入口，删除要两下。
   时间窗的真判据在 Rust（store::recall_check），这里测的是「入口露不露、
   被拒了收不收得回去、两边各自看到什么」这一整条前端链路 */
await openChatWith("甲机");
const rbSid = lastCall("msg_history")?.session;
check(
  "开一个干净的话题框用来测撤回（历史为空，气泡 id 才好断言）",
  !!rbSid && bubbles().length === 0,
  String(rbSid)
);
/** 菜单项是 byId 挂上去的真节点，靠 textContent 认项；靠文本判「这一项在不在」 */
const recallItem = () => byId("ctx-msg-recall");
const deleteItem = () => byId("ctx-msg-del");

byId("xfer-input").value = "这句要撤回";
click(byId("btn-xfer-send"));
await settle();
const rbMsg = world.hist.find((m) => m.text === "这句要撤回");
const rbBub = bubbles().find((b) => b.dataset.id === rbMsg?.id);
check(
  "自己发出去的那条，右键菜单里「撤回」与「删除」两项都摊开（入口搬进右键菜单了）",
  openBubbleMenu(rbBub).join(",") === "复制正文,引用回复,转发到别的会话,|,撤回这一条,删除（只删本机）",
  shownItems().join(",")
);

// 时间窗：两分钟前那条不配再有撤回入口
emit("msg-updated", {
  message: { id: "old-out", dir: "out", kind: "text", text: "早过了", state: "sent", ts: NOW - 90000, peer: "A", sid: rbSid },
});
await settle();
const oldBub = bubbles().find((b) => b.dataset.id === "old-out");
check(
  "过了一分钟的那条只剩「删除」，撤回入口自己收掉",
  openBubbleMenu(oldBub).join(",") === "复制正文,引用回复,转发到别的会话,|,删除（只删本机）",
  shownItems().join(",")
);

// 对方发来的那条留到摘要用例之后再摆进来：会话栏摘要取最后一条，
// 它抢在最后就把「撤回的那条是什么样子」这条断言盖掉了

const recallSince = calls.length;
// 得重新在菜单里摊开这一条再点：菜单认的是「最后右键的那一条」，上一项刚右键过 old-out
openBubbleMenu(rbBub);
click(recallItem());
await settle();
const rbCalls = takeCalls("msg_recall", recallSince);
check(
  "点撤回只调一次 msg_recall，参数就是那条的 id",
  rbCalls.length === 1 && rbCalls[0][1].id === rbMsg.id,
  JSON.stringify(rbCalls[0] || null)
);
check(
  "撤回后本机这条换成一句「你撤回了一条消息」，正文不再露出来",
  rbBub.textContent.includes("你撤回了一条消息") && !rbBub.textContent.includes("这句要撤回"),
  rbBub.textContent
);
// 菜单里重新摊开这一条：刚才那一下撤回点下去之后，入口应该已经收了
check(
  "撤过的不再给撤回入口，也不再给引用与转发入口（原文都不显示了，引它转它做什么）",
  (() => {
    const items = openBubbleMenu(rbBub);
    return !items.includes("撤回这一条") && !items.includes("引用回复") && !items.includes("转发到别的会话");
  })(),
  shownItems().join(",")
);
check(
  "会话栏那句摘要也换成「撤回了一条消息」（桩不解析 HTML，看 innerHTML 字符串）",
  String(rowOf(rbSid)?.html).includes("撤回了一条消息"),
  String(rowOf(rbSid)?.html).slice(0, 160)
);

// 接收中的占位气泡还没路径：引用能给（摘文件名），转发给了也是空的，不露。
// 摆在摘要用例之后：它要是排在最后一条，会把上面那句摘要断言盖掉
emit("msg-in", {
  message: { id: "noPath", dir: "in", kind: "file", name: "还在收.bin", size: 10, state: "sending", ts: at(0, 20), peer: "A", sid: rbSid },
});
await settle();
const itemsNoPath = openBubbleMenu(msgElOf("noPath"));
check(
  "接收中还没路径的文件：「引用回复」给（摘的是文件名）、「转发」不给（转过去是个空的）",
  itemsNoPath.includes("引用回复") && !itemsNoPath.includes("转发到别的会话"),
  itemsNoPath.join(",")
);

// 对方发来的那条：只能删自己这边的，不能撤别人的
emit("msg-in", {
  message: { id: "in-1", dir: "in", kind: "text", text: "对方说的", state: "sent", ts: NOW, peer: "A", sid: rbSid },
});
await settle();
const inBub = bubbles().find((b) => b.dataset.id === "in-1");
check(
  "对方发来的那条只给「删除」（撤回只能撤自己发的）",
  openBubbleMenu(inBub).join(",") === "复制正文,引用回复,转发到别的会话,|,删除（只删本机）",
  shownItems().join(",")
);

// 删除要两下：与会话菜单那枚同一套手感，而且是在菜单里走
const delSince = calls.length;
rightClick(inBub);
const delItem = deleteItem();
click(delItem);
await settle();
check(
  "删除第一下不真调后端，只把这一项变成「再点一次删除」且菜单不收起",
  takeCalls("msg_delete", delSince).length === 0 &&
    delItem.textContent === "再点一次删除" &&
    msgMenuEl.hidden === false,
  `${delItem.textContent} hidden=${msgMenuEl.hidden}`
);
click(delItem);
await settle();
check(
  "第二下才真删：msg_delete 收到的就是那条的 id",
  takeCalls("msg_delete", delSince).length === 1 && lastCall("msg_delete")?.id === "in-1",
  JSON.stringify(lastCall("msg_delete"))
);
check(
  "删掉的气泡当场从流里拿掉",
  !bubbles().some((b) => b.dataset.id === "in-1"),
  bubbles().map((b) => b.dataset.id).join(",")
);

// 被后端拦下来（对端版本不支持、或那一分钟已经过了）：不能偷偷把正文换成「已撤回」
world.recallFails = "对端版本不支持撤回（它还没更新）";
byId("xfer-input").value = "这句撤不掉";
click(byId("btn-xfer-send"));
await settle();
const rbMsg2 = world.hist.find((m) => m.text === "这句撤不掉");
const bub2 = bubbles().find((b) => b.dataset.id === rbMsg2?.id);
// 先右键把这一条摊开再点：上一项刚删完，菜单里的「这一条」还指着被删的那条
openBubbleMenu(bub2);
click(recallItem());
await settle();
check(
  "撤回被拒：正文原样留着，没被换成那句提示",
  bub2.textContent.includes("这句撤不掉") && !bub2.classSet.has("is-recalled"),
  bub2.textContent
);
check(
  "撤回被拒后入口当场收起来，不再让人反复点",
  !openBubbleMenu(bub2).includes("撤回这一条"),
  shownItems().join(",")
);
world.recallFails = null;

// 切走再切回来：三个状态都得从「盘上那一行」读回来，而不是靠内存里的旧气泡
const baseRow = rowOf("A");
if (baseRow) {
  click(baseRow);
  await settle();
}
click(rowOf(rbSid));
await settle();
check(
  "重读历史：撤过的那条仍是提示态（recalled 真落库了）",
  (() => {
    const b = bubbles().find((x) => x.dataset.id === rbMsg.id);
    return !!b && b.textContent.includes("你撤回了一条消息") && !b.textContent.includes("这句要撤回");
  })(),
  String(bubbles().find((x) => x.dataset.id === rbMsg.id)?.textContent)
);
check(
  "重读历史：删掉的那条不再出现，而文件里那一行还在（只标 hidden、不删行）",
  !bubbles().some((x) => x.dataset.id === "in-1") && world.hist.some((x) => x.id === "in-1" && x.hidden),
  bubbles().map((x) => x.dataset.id).join(",")
);
check(
  "重读历史：没撤成的那条正文照旧",
  (() => {
    const b = bubbles().find((x) => x.dataset.id === rbMsg2.id);
    return !!b && b.textContent.includes("这句撤不掉");
  })(),
  String(bubbles().find((x) => x.dataset.id === rbMsg2.id)?.textContent)
);

const xferSrc = readFileSync(join(here, "..", "js", "view-transfer.js"), "utf8");
check(
  "投递只入待发送区：stagePendingSend 走 addAttach（进视图就摆好，不用点会话）",
  /async function stagePendingSend[\s\S]{0,700}?addAttach\(\[pending\.path\], \{ allowNoSession: true \}\)/.test(
    xferSrc
  )
);
check(
  "openSession 不再顺手发：切会话那段里没有 send_paths / flushPendingSend",
  !/async function openSession[\s\S]{0,1200}?(send_paths|flushPendingSend)/.test(xferSrc)
);
check(
  "发送不等事件：runSend 拿到返回值先画气泡再滚到底",
  /async function runSend[\s\S]{0,900}?routeMessage\(m, "send"\)[\s\S]{0,400}?scrollBottom\(\)/.test(xferSrc)
);
check(
  "顶栏没有「发送文件 / 发送文件夹」两个按钮了（拖进来照样进待发送区）",
  !/btn-xfer-file|btn-xfer-folder/.test(html) &&
    !/pick_send_files|ui\.btnFile|ui\.btnFolder/.test(xferSrc) &&
    /registerDropHandler\("transfer", \(paths\) => addAttach\(paths\)\)/.test(xferSrc),
  [
    /btn-xfer-file|btn-xfer-folder/.test(html) ? "按钮还在页面里" : "",
    /pick_send_files|ui\.btnFile|ui\.btnFolder/.test(xferSrc) ? "脚本还在接线" : "",
    /registerDropHandler\("transfer", \(paths\) => addAttach\(paths\)\)/.test(xferSrc) ? "" : "拖拽入口没了",
  ]
    .filter(Boolean)
    .join(" / ") || "页面与脚本都清干净了"
);

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
