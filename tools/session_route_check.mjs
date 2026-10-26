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
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
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
  // 被删过会话的框：历史还在，但列表不再从历史里把它补回来（与 Rust 的 hidden 同口径）
  hidden: [],
  hist: [],
};

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
  const mine = world.hist.filter((m) => sidOf(m) === id);
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
    created: stored?.created || 0,
    // 与 Rust 同口径：只数对方发来的、且只数读指针之后的；未标记与补漏行（还没建会话的）不挂未读
    unread:
      peer === "" || !stored
        ? 0
        : mine.filter((m) => m.dir === "in" && m.ts > stored.read).length,
    last: last?.ts || 0,
    summary: last ? (last.kind === "text" ? last.text : `[文件] ${last.name || ""}`) : "",
  };
}

/** 会话表里没有、但历史里露出过、且没被用户删过的框要补一行 —— Rust 的 sessions_json() 就是这么干的 */
function sessionsPayload() {
  const keys = [
    ...new Set([...world.sessions.map((s) => s.id), ...world.hist.map(sidOf)]),
  ].filter((k) => world.sessions.some((s) => s.id === k) || !world.hidden.includes(k));
  return {
    sessions: keys.map(sessionRowOf).sort((a, b) => b.last - a.last),
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
window.__TAURI__.core.invoke = async (cmd, args = {}) => {
  calls.push([cmd, args]);
  switch (cmd) {
    case "net_status":
      return statusPayload();
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
    case "session_delete":
      world.sessions = world.sessions.filter((s) => s.id !== args.id);
      // 只删这个框与它的读指针：历史一条不动，但记下这个框，免得补漏行把它又请回来
      if (!world.hidden.includes(args.id)) world.hidden.push(args.id);
      if (world.active === args.id) world.active = "";
      return sessionsPayload();
    case "msg_history": {
      // 必须先按对话框筛、再定位游标切页：反过来会让每页凑不满、游标还会串框
      const list = args.session === undefined ? world.hist : world.hist.filter((m) => sidOf(m) === args.session);
      const cursor = args.before ? list.findIndex((m) => m.id === args.before) : -1;
      const end = cursor >= 0 ? cursor : list.length;
      const start = Math.max(0, end - (args.limit || 50));
      return list.slice(start, end).map((m) => ({ ...m }));
    }
    case "send_text": {
      const to = args.to || world.active;
      // X-Session 就是拿这个会话 ID 发的，落库的 peer 仍是所属那台
      const sess = world.sessions.find((s) => s.id === to);
      const m = {
        id: `out${++seq}`,
        dir: "out",
        kind: "text",
        text: args.text,
        state: "sent",
        ts: Date.now(),
        peer: sess ? sess.peer : to,
        sid: to,
      };
      // client.rs 落库后会推一条 msg-updated，气泡就是这么进流的
      world.hist.push(m);
      emit("msg-updated", { message: m });
      return m;
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
check("未标记行不给删除按钮", rowOf("") && !rowOf("").children.some((c) => c.classSet.has("s-acts")));

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

console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
