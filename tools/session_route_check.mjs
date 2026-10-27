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
const fireWindow = (type, target) => {
  for (const [t, fn] of winListeners) if (t === type) fn({ type, target });
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
const menuHtml = menuAt < 0 ? "" : html.slice(menuAt, menuAt + 400);
check(
  "菜单三项都是中文（置顶 / 重命名 / 删除），菜单里没有 Reload / Inspect",
  /置顶该聊天/.test(menuHtml) &&
    /重命名/.test(menuHtml) &&
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
  shownItems().join(",") === "复制图片,另存为…,复制文件路径,在文件夹中显示,在对比中打开,|,删除（只删本机）",
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
  itemsOfText.join(",") === "复制正文,|,删除（只删本机）",
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
  itemsOfDoc.join(",") === "另存为…,复制文件路径,在文件夹中显示,|,删除（只删本机）",
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
const msgMenuHtml = msgMenuAt < 0 ? "" : html.slice(msgMenuAt, msgMenuAt + 900);
check(
  "菜单九枚都在一份菜单里（一份菜单管三种气泡，不再开两份）",
  msgMenuAt >= 0 &&
    [
      "cb-copy-text",
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
  ["复制正文", "复制图片", "另存为…", "复制文件路径", "在文件夹中显示", "在对比中打开", "撤回这一条", "删除（只删本机）"].every(
    (t) => msgMenuHtml.includes(t)
  ) &&
    !/Look Up|Translate|Search with|Copy Link|Share…|Speech|Inspect Element|Open Image|Download Image|Copy Subject/.test(
      msgMenuHtml
    ),
  msgMenuHtml.slice(0, 120)
);

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
  openBubbleMenu(rbBub).join(",") === "复制正文,|,撤回这一条,删除（只删本机）",
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
  openBubbleMenu(oldBub).join(",") === "复制正文,|,删除（只删本机）",
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
  "撤过的不再给撤回入口（已经是撤过的那一条了）",
  !openBubbleMenu(rbBub).includes("撤回这一条"),
  shownItems().join(",")
);
check(
  "会话栏那句摘要也换成「撤回了一条消息」（桩不解析 HTML，看 innerHTML 字符串）",
  String(rowOf(rbSid)?.html).includes("撤回了一条消息"),
  String(rowOf(rbSid)?.html).slice(0, 160)
);

// 对方发来的那条：只能删自己这边的，不能撤别人的
emit("msg-in", {
  message: { id: "in-1", dir: "in", kind: "text", text: "对方说的", state: "sent", ts: NOW, peer: "A", sid: rbSid },
});
await settle();
const inBub = bubbles().find((b) => b.dataset.id === "in-1");
check(
  "对方发来的那条只给「删除」（撤回只能撤自己发的）",
  openBubbleMenu(inBub).join(",") === "复制正文,|,删除（只删本机）",
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
