/* ==========================================================================
 * 视图二：局域网传输（相当于自己的「文件传输助手」，可以同时和几台设备聊）
 *
 * 界面只干两件事：把用户意图交给 Rust 命令，把 Rust 推来的事件画成气泡。
 * 所有网络与校验都在 Rust 侧，这里不碰 socket、不算 sha256。
 *
 * 会话有自己的 ID，所以同一台设备可以开好几个对话框（基础对话的 ID 就是那台的
 * 设备 ID，新话题另造 UUID）。一条消息落进哪个框看的是它自带的 sid，两边靠线上
 * 的 X-Session 对得上。每个对话框各留一份气泡与分页游标，切来切去不会串页；
 * 在线态与地址则取自所属那台 —— 一台的几个框共用一个对端，也一起可发/不可发。
 * ========================================================================== */

import {
  copyPathAsFile,
  copyText,
  currentView,
  el,
  errText,
  fmtDayDivider,
  fmtSize,
  fmtTime,
  IMAGE_EXT,
  invoke,
  isTauriRuntime,
  listen,
  openInCompare,
  registerDropHandler,
  registerDropHoverHandler,
  registerPasteTextHandler,
  setStatus,
  toast,
} from "./api.js";

const ui = {
  stream: el("xfer-stream"),
  input: el("xfer-input"),
  btnSend: el("btn-xfer-send"),
  btnFile: el("btn-xfer-file"),
  btnFolder: el("btn-xfer-folder"),
  peer: el("xfer-peer"),
  passphrase: el("inp-passphrase"),
  deviceName: el("inp-device-name"),
  btnPair: el("btn-pair-save"),
  manualAddr: el("inp-manual-addr"),
  btnManual: el("btn-bind-addr"),
  peerAlias: el("inp-peer-alias"),
  btnPeerAlias: el("btn-peer-alias"),
  btnUnbind: el("btn-unbind"),
  btnReprobe: el("btn-reprobe"),
  candidates: el("xfer-candidates"),
  settings: el("xfer-settings"),
  btnSettings: el("btn-xfer-settings"),
  dropHint: el("xfer-drop-hint"),
  dropText: el("xfer-drop-text"),
  older: el("xfer-older"),
  search: el("xfer-search"),
  chips: el("xfer-chips"),
  filterCount: el("xfer-filter-count"),
  sessions: el("xfer-sessions"),
  sessionRows: el("xfer-session-rows"),
  btnNewChat: el("btn-session-new"),
  chatPick: el("xfer-chat-pick"),
  pickList: el("xfer-pick-list"),
  lightbox: el("img-lightbox"),
  lightboxImg: el("lightbox-img"),
  lightboxCap: el("lightbox-cap"),
  lightboxClose: el("lightbox-close"),
};

/** 「未标记」那一行的会话 ID 与对端 ID 都是空串：老历史里 peer 缺失的那些消息进这里。
 *  它只用来查看，既删不掉（会话表里本来就没有这一行）也不能当发送目标 */
const UNMARKED = "";

const state = {
  status: null, // net_status / peers-changed 的最新快照（含 peers[] 与 active）
  /** sessions() 的最新结果，顺序就是会话栏的顺序 */
  sessionList: [],
  /** 当前对话框的会话 ID（不是对端 ID：同一台能有好几个框）。null = 还没有任何会话 */
  cur: null,
  sending: false,
  /** 当前搜索条件：kind 为 all/text/image/folder/archive/other，q 为关键词 */
  filter: { kind: "all", q: "" },
};

/**
 * 每个对话框一份流状态。以前这些字段直接挂在 state 上，那是「全世界只有一条
 * 消息流」的假设；同一台开好几个框之后，切换就是换一份 DOM 与游标，所以按会话 ID 分开放。
 */
const streams = new Map();

function streamOf(id) {
  let s = streams.get(id);
  if (!s) {
    s = {
      /** msgId -> { el, bar, state, kind } 便于原地更新进度与状态 */
      bubbles: new Map(),
      /** 已铺到最早那一条的 id，往前翻页的游标（用 id 不用条数：中间来新消息也不会串页） */
      oldestId: null,
      /** 历史里比游标更早的还有没有 */
      hasMore: true,
      loadingOlder: false,
    };
    streams.set(id, s);
  }
  return s;
}

/** 当前会话的那一份流 */
function cur() {
  return streamOf(state.cur === null ? UNMARKED : state.cur);
}

/** 会话栏里的那一行（拿不到就说明这个对话框不在了） */
function sessionRowOf(id) {
  return state.sessionList.find((x) => x.id === id) || null;
}

/** 一条消息属于哪个对话框。老历史没有 sid，后端按 peer 归基础对话，这里口径一致 */
function msgSid(m) {
  return m?.sid || m?.peer || UNMARKED;
}

/** 一台对端在界面上到底叫什么：备注名优先，没备注才用对方上报的设备名。
 *  口径与 Rust 侧的 Peer::display_name() 完全一致，两边得一起改 */
function peerLabel(p) {
  if (!p) return "";
  const a = (p.alias || "").trim();
  if (a) return a;
  const n = (p.name || "").trim();
  if (n) return n;
  return `设备 ${String(p.id || "").slice(0, 8)}`;
}

/**
 * 对端的显示名：必须按「这条消息自带的 peer」去解析。以前读的是「我绑定的
 * 那台」，多台之后那样所有人都会显示同一个名字。
 * 口径与后端 session_name() 一致：会话名 > 对端显示名（备注优先）> 露一截设备 ID
 */
function peerName(peer) {
  if (!peer) return "未标记";
  const p = (state.status?.peers || []).find((x) => x.id === peer);
  return p ? peerLabel(p) : `设备 ${peer.slice(0, 8)}`;
}

/** 气泡上那个名字用的是对话框名，不是设备名：同一台的两个框得区分得开 */
function sessName(sid, peer) {
  const s = sessionRowOf(sid);
  if (s?.name) return s.name;
  // 会话栏里还没这一行（事件比 sessions-changed 先到）：退回所属那台的名
  return peerName(s ? s.peer : (peer ?? sid));
}

/** 会话栏右边那一小列时间：今天只到时分，昨天写「昨天」，再早给日期 */
function railTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  if (d.toDateString() === new Date().toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (Math.floor((Date.now() - ts) / 86400000) === 1) return "昨天";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// IMAGE_EXT 从 api.js 导，三个视图共用一份口径

/** 一次铺多少条：跟微信一样先只看最近这几条，滚到顶再往前翻页 */
const PAGE = 10;
/** 压缩包单独一类：收发列表里它们和文档最容易混，按微信的习惯也是分开显示的 */
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|jar|apk|iso)$/i;
/** 缩略图自动读盘的上限：超过它就先占位，点一下才走 IPC，铺历史时不会一次拽几十张图 */
const PREVIEW_AUTO_MAX = 4 * 1024 * 1024;
/** 硬上限：再大就不在聊天里解图，引导用「在对比中打开」（对比视图本来就是为大图设计的） */
const PREVIEW_HARD_MAX = 40 * 1024 * 1024;
/** path -> data URL，缩略图与放大层共用同一份，一张图只读一次盘 */
const imgCache = new Map();

/* --------------------------------------------------------------------------
 * 连接状态
 * ------------------------------------------------------------------------ */
function renderStatus(s) {
  state.status = s;
  if (!s) return;
  const peers = s.peers || [];

  // 本机端口 + 防火墙提示（Windows 首次监听一定要允许）
  const portText = s.server_ok ? `本机接收端口 ${s.port}` : "接收服务未启动";
  const parts = [portText];
  if (s.error) parts.push(s.error);
  setStatus(parts.join(" · "));

  // 候选 = mDNS 发现且还没登记成对端的（登记过的直接在会话栏里切过去就行）
  const ids = new Set(peers.map((p) => p.id));
  const cands = (s.discovered || []).filter((d) => !ids.has(d.id));
  ui.candidates.textContent = "";
  if (!cands.length) {
    ui.candidates.textContent = "已发现设备：无（mDNS 常被公司网络/VPN 屏蔽，请用下面的手动 IP）";
  } else {
    // 发现结果直接做成按钮：点一下就走 /ping 校口令绑定，不要求用户手抄 IP
    const label = document.createElement("span");
    label.className = "cand-label";
    label.textContent = "已发现（点一下即添加并开一个对话框）：";
    ui.candidates.appendChild(label);
    for (const d of cands) {
      const b = document.createElement("button");
      b.className = "cand";
      // 解绑过的那台仍会被 mDNS 扫到，但后台不会再替用户把它绑回来：
      // 不标出来，用户看到的就只是「解绑了但它又自己冒出来了」
      b.textContent = `${d.name} · ${d.host}:${d.port}${d.unbound ? "（已解绑）" : ""}`;
      b.title = d.unbound
        ? "这台被你解绑过了，不会再自动连上；点一下才算亲手重新添加"
        : "向它发 /ping，口令一致才添加";
      b.addEventListener("click", () => bindAddr(`${d.host}:${d.port}`));
      ui.candidates.appendChild(b);
    }
  }
  ui.passphrase.value = "";
  ui.passphrase.placeholder = s.passphrase_set ? "已设置，留空不修改" : "设置配对口令（≥4 字符）";
  if (ui.deviceName.value === "" && s.device_name) ui.deviceName.value = s.device_name;
  syncRailFromStatus();
  renderPeerHead();
  renderSessionRail();
}

/** 会话行的在线态取自 sessions()，而心跳只推 status（里面带每台 peers 的在线态）：
 *  不拿后者回填前者，列表里的在线点与「可不可发」就会停在上一次重拉的时刻。
 *  按 peer 回填：一台的几个框本来就是同一个对端，一起在线一起离线 */
function syncRailFromStatus() {
  const peers = state.status?.peers || [];
  for (const row of state.sessionList) {
    const p = peers.find((x) => x.id === row.peer);
    if (!p) continue;
    row.bound = true;
    row.online = !!p.online;
    row.host = p.host;
    row.port = p.port;
  }
}

/** 顶栏那一条：它只能是「正在聊的那个对话框」，所以数据取自当前会话行 */
function renderPeerHead() {
  const node = ui.peer;
  const sess = sessionRowOf(state.cur);
  // 地址与最后在线时间取自 peers 列表：会话行里的 last 是「最后一条消息」，不是「最后 ping 通」
  const peer = (state.status?.peers || []).find((p) => p.id === sess?.peer) || null;
  const canSend = !!sess && sess.bound && sess.online;
  node.classList.toggle("is-online", canSend);
  if (!state.status?.passphrase_set) {
    node.innerHTML = `<span class="dot dot-warn"></span><b>还没设置配对口令</b><span class="peer-sub">每台填同一个口令才能互认</span>`;
  } else if (!sess) {
    node.innerHTML = `<span class="dot dot-off"></span><b>还没有会话</b><span class="peer-sub">等一台设备给你发消息，或在左边开一个新聊天</span>`;
  } else if (!peer) {
    // 会话可以是「它来过消息但还没登记」的：历史看得见，消息发不出去
    node.innerHTML = `<span class="dot dot-off"></span><b>${escapeHtml(sess.name)}</b><span class="peer-sub">还没添加这台，只能查看历史</span>`;
  } else {
    node.innerHTML = `<span class="dot ${peer.online ? "dot-on" : "dot-off"}"></span><b>${escapeHtml(
      sess.name
    )}</b><span class="peer-sub">${peer.host}:${peer.port} · ${
      peer.online ? "在线" : "离线（最近 " + fmtTime(peer.last_seen) + "）"
    }</span>`;
  }
  ui.btnSend.disabled = !canSend || state.sending;
  ui.btnFile.disabled = ui.btnSend.disabled;
  ui.btnFolder.disabled = ui.btnSend.disabled;
  ui.btnUnbind.disabled = !(sess && peer);
  ui.btnReprobe.disabled = !(sess && peer);
  // 备注名是改「这台」的，不是改某个对话框的：没有登记过的对端没得改
  syncAliasInput(peer);
  // 多台之后手动添加不再受「已绑定」限制：每台都值得一行地址
  ui.btnManual.disabled = !state.status?.passphrase_set;
}

/** 上一次由代码写进备注框的那份值，与它是给哪一台的（回写前要比这两个） */
let aliasShown = "";
let aliasShownFor = "";

/** 把备注名输入框对齐到当前这台。它跟着「当前对话框所属的那台」走，
 *  而不是跟着用户正在打的内容走 —— 心跳每秒都可能推一次 peers-changed：
 *  1. 正在编辑（焦点在这个框里）绝不回写，否则字打到一半就被冲掉；
 *  2. 没在编辑但框里是一份**未保存的草稿**（与代码上次写进去的那份不一样、
 *     后端却没变）也不回写，否则点去别处一下就把草稿抹了；
 *  3. 换了那一台，或后端那份真变了（存好了 / 被改回来了）才回写 */
function syncAliasInput(peer) {
  if (!ui.peerAlias) return;
  const on = !!peer;
  ui.peerAlias.disabled = !on;
  if (ui.btnPeerAlias) ui.btnPeerAlias.disabled = !on;
  if (!on) {
    ui.peerAlias.value = "";
    aliasShown = "";
    aliasShownFor = "";
    return;
  }
  const want = peer.alias || "";
  if (document.activeElement === ui.peerAlias) return;
  if (aliasShownFor === peer.id && ui.peerAlias.value !== aliasShown && want === aliasShown) return;
  ui.peerAlias.value = want;
  aliasShown = want;
  aliasShownFor = peer.id;
}

/** 保存当前这台的备注名。空串是个明确意图：清掉备注，退回对方上报的设备名 */
async function savePeerAlias() {
  const sess = sessionRowOf(state.cur);
  const peerId = sess?.peer;
  if (!peerId) {
    toast("这台还没添加，改不了备注", "error");
    return;
  }
  const alias = ui.peerAlias.value.trim();
  try {
    await invoke("set_peer_alias", { peer: peerId, alias });
    toast(alias ? `已把这台备注为「${alias}」` : "已清除备注，退回对方上报的设备名");
  } catch (err) {
    toast(errText(err), "error");
    return;
  }
  // 后端会顺手把还叫旧名的对话框一起改名，所以两边列表都得重取
  await refreshStatus();
  await loadSessions();
}

/* --------------------------------------------------------------------------
 * 会话栏：一个对话框一行，同一台可以有好几行
 * ------------------------------------------------------------------------ */

/** 未读数只在后端 sessions() 里算（要整读一遍历史），心跳推的 status 里没有它 */
async function loadSessions() {
  if (!isTauriRuntime) return;
  try {
    applySessions(await invoke("sessions"));
  } catch (err) {
    console.error("[xfer] 读会话列表失败:", err);
    setStatus("读会话列表失败: " + errText(err));
  }
}

function applySessions(payload) {
  state.sessionList = payload?.sessions || [];
  // 焦点存在后端 sessions.json 里，前端只跟着走。当前会话没了（还没定、
  // 或刚被删掉）才改选：不然会把用户正在看的那个框偷偷换走
  if (state.cur === null || !sessionRowOf(state.cur)) {
    const active = payload?.active || "";
    state.cur = sessionRowOf(active) ? active : (state.sessionList[0]?.id ?? null);
  }
  renderSessionRail();
  renderPeerHead();
}

/** 切到某个对话框（参数是会话 ID，不是对端 ID） */
async function openSession(id) {
  if (state.cur === id) return;
  hidePick();
  state.cur = id;
  renderSessionRail();
  renderPeerHead();
  try {
    // 切进来即已读：session_focus 一次做完「设焦点 + 推读指针」，不用前端再补一刀
    applySessions(await invoke("session_focus", { id }));
  } catch (err) {
    console.error("[xfer] 切会话失败:", err);
    toast(errText(err), "error");
  }
  await loadHistory();
}

/** 会话栏重建的代价虽然小，但心跳每秒都推一次 peers-changed，
 *  不去重就会每秒拆建一次 DOM（连带丢掉悬停与列表的滚动位置） */
let railSig = "";

function renderSessionRail() {
  if (!ui.sessionRows) return;
  const sig = JSON.stringify([
    state.cur,
    state.sessionList.map((s) => [s.id, s.peer, s.name, s.online, s.unread, s.last, s.summary]),
  ]);
  if (sig === railSig) return;
  railSig = sig;
  ui.sessionRows.textContent = "";
  if (!state.sessionList.length) {
    const p = document.createElement("div");
    p.className = "session-empty";
    p.textContent = "还没有会话。对方给你发一条消息，就会自动出现在这里。";
    ui.sessionRows.appendChild(p);
    return;
  }
  for (const s of state.sessionList) ui.sessionRows.appendChild(sessionNode(s));
}

function sessionNode(s) {
  const unmarked = s.peer === UNMARKED;
  const row = document.createElement("div");
  row.className = "session-row" + (s.id === state.cur ? " is-active" : "");
  // 带上会话 ID：名字会重名也会改，同一台还能有好几个框，行归属只认这个
  row.dataset.id = s.id;
  row.dataset.peer = s.peer;
  row.title = unmarked
    ? "老历史里没记对端的那些消息，只用来查看"
    : s.bound
      ? `${s.host}:${s.port}`
      : "这台还没添加，只能查看历史";
  const dot = unmarked ? "dot-warn" : s.online ? "dot-on" : "dot-off";
  row.innerHTML = `<span class="dot ${dot}"></span>
    <div class="s-main">
      <div class="s-top"><b>${escapeHtml(s.name)}</b><span class="s-time">${railTime(s.last)}</span></div>
      <div class="s-sub">${escapeHtml(s.summary || "还没有消息")}</div>
    </div>`;
  if (!unmarked && s.unread > 0) {
    const b = document.createElement("span");
    b.className = "s-badge";
    b.textContent = s.unread > 99 ? "99+" : String(s.unread);
    row.appendChild(b);
  }
  if (!unmarked) {
    // 「未标记」不是一台真设备：既没有读指针可删，也没有行上操作可给。
    // 这一行只放「改名」与「删除」两个：会话栏只有 214px，按钮一多名字就被挤没；
    // 再开一个框走「＋ 新聊天」里点那台，解绑走「配对设置」的「解绑当前对端」
    const acts = document.createElement("div");
    acts.className = "s-acts";
    acts.appendChild(railBtn("改名", () => startRename(s, row), true, "只改本机看到的这个名字，不会传给对端"));
    acts.appendChild(railBtn("删除", (btn) => armRailDelete(btn, s), true, "只删这个对话框（要点两下确认），聊天历史与收件箱文件都不动"));
    row.appendChild(acts);
  }
  row.addEventListener("click", () => openSession(s.id));
  return row;
}

function railBtn(label, fn, enabled, title) {
  const b = document.createElement("button");
  b.className = "link-btn";
  b.textContent = label;
  b.title = title;
  b.disabled = !enabled;
  // 行本身是「切会话」，按钮不拦住冒泡的话删一下就会顺手把会话切走
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    fn(b);
  });
  return b;
}

/** 行内改名：webview 里 window.prompt 不一定能用，就直接在那一行里换成输入框。
 *  名字只改本机这一份 —— 后端已经不拿对端上报的名覆盖它了 */
function startRename(s, row) {
  const nameEl = row.querySelector(".s-top b");
  if (!nameEl || row.querySelector(".s-rename")) return;
  const input = document.createElement("input");
  input.className = "s-rename";
  input.type = "text";
  input.value = s.name;
  input.maxLength = 40;
  input.placeholder = "会话名";
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let closed = false;
  // 无论改成没成，重建一次才能把输入框换回名字（改名成功时列表本来就要重拉）
  const reset = () => {
    railSig = "";
    renderSessionRail();
  };
  const close = async (commit) => {
    if (closed) return;
    closed = true;
    const name = input.value.trim();
    if (commit && name && name !== s.name) {
      try {
        applySessions(await invoke("session_rename", { id: s.id, name }));
      } catch (err) {
        toast(errText(err), "error");
      }
    }
    reset();
  };
  input.addEventListener("click", (ev) => ev.stopPropagation());
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") close(true);
    else if (ev.key === "Escape") close(false);
  });
  // 点旁边就当作认了：行内编辑没有「确定」按钮，取消靠 Esc
  input.addEventListener("blur", () => close(true));
}

/** 新话题的名字按「设备名 · 月-日」起：本机的本地日期只有前端知道（Rust 侧只有
 *  epoch 毫秒、算不出时区），同一天再开一个由后端加 (2) 区分。
 *  拿不到设备名（还没登记过的那台）就传空，让后端退回「设备名 · 话题 N」 */
function topicNameByDate(peer) {
  const base = peerName(peer);
  if (!base) return "";
  const d = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  return `${base} · ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 在同一台上再开一个对话框。后端把焦点直接切到新框，id 就放在返回的 active 里 */
async function newTopic(peer) {
  if (!peer) {
    toast("这一行还没对端，开不了新话题", "error");
    return;
  }
  hidePick();
  try {
    const payload = await invoke("session_new", { peer, name: topicNameByDate(peer) });
    applySessions(payload);
    await openSession(payload?.active || "");
  } catch (err) {
    console.error("[xfer] 开新话题失败:", err);
    toast(errText(err), "error");
  }
}

async function unbindOne(s) {
  if (!s) return;
  try {
    await invoke("unbind_peer", { peer: s.peer });
    toast(`已解绑「${s.name}」：不再主动连它，它下次发消息仍会回到这个对话框`);
  } catch (err) {
    toast(errText(err), "error");
  }
  await refreshStatus();
  await loadSessions();
}

/** webview 里 window.confirm 不一定可用（收藏视图删除也是这个口径），
 *  确认就地长在那一行里：点一下变成「确认删除？」，4 秒内再点一次才真删。
 *  超时、切会话、列表重建都会自动复位，不会把一个行停在“待确认”的状态里 */
function armRailDelete(btn, s) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "确认删除？";
    toast("再点一次「确认删除？」才会删掉这个对话框，聊天记录与收到的文件都不会动");
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.dataset.armed = "";
      btn.textContent = "删除";
    }, 4000);
    return;
  }
  return removeOne(s);
}

async function removeOne(s) {
  const wasCur = s.id === state.cur;
  try {
    applySessions(await invoke("session_delete", { id: s.id }));
    toast("已删除会话，聊天记录与收到的文件都还在");
  } catch (err) {
    toast(errText(err), "error");
    return;
  }
  // 删的是正在聊的那个框：流的 DOM 与游标都得换成另一个会话的，不然屏幕上还是旧内容
  streams.delete(s.id);
  if (wasCur) await loadHistory();
}

/* --------------------------------------------------------------------------
 * 「＋ 新聊天」弹层
 * ------------------------------------------------------------------------ */
function hidePick() {
  if (ui.chatPick) ui.chatPick.hidden = true;
}

function togglePick() {
  if (!ui.chatPick) return;
  ui.chatPick.hidden = !ui.chatPick.hidden;
  if (!ui.chatPick.hidden) renderPickList();
}

/** 把已登记的对端与刚发现的设备合成一份候选，点一下就开对话框。
 *  两边都有的按对端 ID 去重，登记过的那份地址才是可用的。
 *  已经有框的那台不是「不能开」而是「再开一个」：同一台开好几个对话这轮是正当需求 */
function renderPickList() {
  if (!ui.pickList) return;
  ui.pickList.textContent = "";
  const ids = new Set();
  const items = [];
  for (const p of state.status?.peers || []) {
    ids.add(p.id);
    // 候选里也用显示名：刚设完备注就去点「＋ 新聊天」，还看到设备名会很奇怪
    items.push({ peer: p.id, name: peerLabel(p), addr: `${p.host}:${p.port}`, bound: true });
  }
  for (const d of state.status?.discovered || []) {
    if (!ids.has(d.id))
      items.push({ peer: d.id, name: d.name, addr: `${d.host}:${d.port}`, bound: false, unbound: !!d.unbound });
  }
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "局域网里还没发现别的设备，可以在「配对设置」里用手动 IP 添加。";
    ui.pickList.appendChild(p);
    return;
  }
  for (const it of items) {
    const n = state.sessionList.filter((x) => x.peer === it.peer).length;
    const b = document.createElement("button");
    b.textContent = `${it.name} · ${it.addr}${it.unbound ? "（已解绑，点一下重新添加）" : n ? `（已有 ${n} 个，再开一个）` : ""}`;
    b.title = it.unbound
      ? "这台被你解绑过了：点一下才重新添加并开一个对话框，后台不会再替你做这件事"
      : n
        ? "在这台上另开一个话题框（已有的那几个去左边列表里点）"
        : "添加这台并开一个对话框";
    b.addEventListener("click", () => startChat(it, n > 0));
    ui.pickList.appendChild(b);
  }
}

async function startChat(item, have) {
  hidePick();
  // 没登记的先加进来再开框。解绑过的那台后台不会再自动连，这里不补上一步
  // 就会开出一个永远发不出去的新框（哪怕它已经有历史、走的是下面那条分支）
  if (!item.bound && !(await bindAddr(item.addr, false))) return;
  // 已经有框的那台直接另开一个：会话 ID 不再等于设备 ID，同一个人也能有好几个框
  if (have) {
    await newTopic(item.peer);
    return;
  }
  try {
    applySessions(await invoke("session_create", { peer: item.peer, name: item.name }));
  } catch (err) {
    toast(errText(err), "error");
    return;
  }
  await openSession(item.peer);
}

async function refreshStatus() {
  if (!isTauriRuntime) {
    setStatus("非 Tauri 环境，传输功能不可用");
    return;
  }
  try {
    renderStatus(await invoke("net_status"));
  } catch (err) {
    console.error("[xfer] 取连接状态失败:", err);
    setStatus("取连接状态失败: " + errText(err));
  }
}

/* --------------------------------------------------------------------------
 * 消息流
 * ------------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 气泡骨架：文字气泡只有正文，文件/文件夹气泡带名称、大小、进度条与操作 */
function buildBubble(m) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${m.dir === "in" ? "in" : "out"} kind-${m.kind}`;
  wrap.dataset.id = m.id;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  wrap.appendChild(meta);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  wrap.appendChild(bubble);

  const rec = {
    el: wrap,
    meta,
    bubble,
    bar: null,
    state: m.state,
    kind: m.kind,
    thumbBox: null,
    fileName: null,
    fileSize: null,
    actsBox: null,
  };

  if (m.kind === "text") {
    const body = document.createElement("div");
    body.className = "msg-text";
    body.textContent = m.text || "";
    bubble.appendChild(body);
    bubble.appendChild(
      actions([
        ["复制", () => copyText(m.text || "")],
        ["收藏", () => favoriteText(m.text || "")],
      ])
    );
  } else if (m.kind === "file" || m.kind === "folder") {
    const head = document.createElement("div");
    head.className = "file-head";
    head.innerHTML = `<span class="file-ico">${m.kind === "folder" ? "🗀" : "🗎"}</span>
      <span class="file-name" title="${escapeHtml(m.path || "")}">${escapeHtml(m.name || "")}</span>
      <span class="file-size">${fmtSize(m.size || 0)}</span>`;
    bubble.appendChild(head);
    rec.fileName = head.querySelector(".file-name");
    rec.fileSize = head.querySelector(".file-size");

    // 预览位先占好：接收中的占位气泡还没有 path，等 xfer-done 再填，顺序才不会跑到进度条后面
    const thumbBox = document.createElement("div");
    thumbBox.className = "thumb-box";
    thumbBox.hidden = true;
    bubble.appendChild(thumbBox);
    rec.thumbBox = thumbBox;

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = m.state === "sent" ? "100%" : "0%";
    bar.appendChild(fill);
    bubble.appendChild(bar);
    rec.bar = fill;

    const actsBox = document.createElement("div");
    actsBox.className = "msg-actions";
    bubble.appendChild(actsBox);
    rec.actsBox = actsBox;
    attachActions(rec, m);
  } else {
    const body = document.createElement("div");
    body.className = "msg-text";
    body.textContent = m.text || m.name || "";
    bubble.appendChild(body);
  }
  return rec;
}

function fillActions(box, list) {
  box.textContent = "";
  for (const [label, fn] of list) {
    const b = document.createElement("button");
    b.className = "link-btn";
    b.textContent = label;
    b.addEventListener("click", () => {
      try {
        fn();
      } catch (err) {
        console.error("[xfer] 操作失败:", err);
        toast(errText(err), "error");
      }
    });
    box.appendChild(b);
  }
  return box;
}

function actions(list) {
  const box = document.createElement("div");
  box.className = "msg-actions";
  return fillActions(box, list);
}

/** 操作区跟预览位一样要等 xfer-done 拿到路径才能补全，否则接收完的气泡一个按钮都没有 */
function attachActions(rec, m) {
  if (!rec.actsBox || !m.path) return;
  if (rec.actsPath === m.path) return;
  rec.actsPath = m.path;
  const isImage = m.kind === "file" && IMAGE_EXT.test(m.name || "");
  const list = [
    ["另存为", () => saveAs(m.path)],
    // 「复制」是写到系统剪贴板（文件形式），不是复制一份文件
    ["复制", () => copyPathAsFile(m.path)],
    ["打开位置", () => invoke("reveal_in_folder", { path: m.path }).catch((e) => toast(errText(e), "error"))],
  ];
  if (isImage) list.push(["在对比中打开", () => openInCompare([m.path])]);
  fillActions(rec.actsBox, list);
}

/* --------------------------------------------------------------------------
 * 图片预览与另存为
 *
 * 图不走网络也不走 asset: 协议：直接复用对比视图已有的 read_image 命令拿 base64
 * data URL，CSP 的 img-src 早就允许 data:，所以不用新增任何权限或改 CSP。
 * ------------------------------------------------------------------------ */

/** 放大层当前那张图的本机路径，给 ⌘C 用（离开放大层就清掉） */
let lightboxPath = null;

/** 只有带本机路径的图片才出预览；接收中的占位气泡没 path，等 xfer-done 补上再调一次 */
function attachThumb(rec, m) {
  if (!rec.thumbBox || rec.thumbLoaded) return;
  if (!(m.kind === "file" && m.path && IMAGE_EXT.test(m.name || ""))) return;
  Object.assign(rec, {
    path: m.path,
    size: m.size || rec.size || 0,
    name: m.name || rec.name || "",
  });
  rec.thumbBox.hidden = false;
  if (rec.size > PREVIEW_AUTO_MAX) renderThumbLazy(rec);
  else loadThumb(rec);
}

/** 大图先占位，用户点了才读盘 */
function renderThumbLazy(rec) {
  rec.thumbBox.textContent = "";
  const b = document.createElement("button");
  b.className = "link-btn thumb-lazy";
  b.textContent = `点我预览（${fmtSize(rec.size)}）`;
  b.addEventListener("click", () => loadThumb(rec, true));
  rec.thumbBox.appendChild(b);
}

async function loadThumb(rec, force = false) {
  if (!rec.thumbBox || rec.thumbLoaded || !rec.path) return;
  if (!force && rec.size > PREVIEW_AUTO_MAX) {
    renderThumbLazy(rec);
    return;
  }
  if (rec.size > PREVIEW_HARD_MAX) {
    rec.thumbBox.className = "thumb-box thumb-fail";
    rec.thumbBox.textContent = "图片过大，请用「在对比中打开」查看";
    return;
  }
  const cached = imgCache.get(rec.path);
  if (cached) {
    paintThumb(rec, cached);
    return;
  }
  rec.thumbBox.className = "thumb-box thumb-loading";
  rec.thumbBox.textContent = "读取中…";
  try {
    const payload = await invoke("read_image", { path: rec.path });
    imgCache.set(payload.path || rec.path, payload.data_url);
    paintThumb(rec, payload.data_url);
  } catch (err) {
    // 文件被移走 / 解码失败都很常见，不能把整条消息弄成坏的
    console.warn("[xfer] 缩略图读取失败:", rec.path, err);
    rec.thumbBox.className = "thumb-box thumb-fail";
    rec.thumbBox.textContent = "预览失败（文件可能被移动或删除）";
  }
}

function paintThumb(rec, dataUrl) {
  rec.thumbLoaded = true;
  rec.thumbBox.className = "thumb-box thumb-ready";
  rec.thumbBox.textContent = "";
  const img = document.createElement("img");
  img.className = "thumb";
  img.src = dataUrl;
  img.alt = rec.name;
  img.title = "点击放大";
  rec.thumbBox.appendChild(img);
  rec.thumbBox.addEventListener("click", () => openLightbox(dataUrl, rec.name, rec.path));
}

function openLightbox(dataUrl, name, p) {
  lightboxPath = p || null;
  ui.lightboxImg.src = dataUrl;
  ui.lightboxImg.alt = name || "";
  ui.lightboxCap.textContent = [name, p].filter(Boolean).join(" · ");
  ui.lightbox.hidden = false;
}

function closeLightbox() {
  lightboxPath = null;
  if (ui.lightbox.hidden) return;
  ui.lightbox.hidden = true;
  // 去掉 src 让 webview 立刻释放解码后的大图内存
  ui.lightboxImg.removeAttribute("src");
}

/** 「下载」在这套架构里就是「把已落盘的东西复制到用户选的位置」：
 *  收件箱里的原件不动，校过 sha256 的内容不会被二次改写 */
async function saveAs(path) {
  try {
    const saved = await invoke("save_path_as", { src: path });
    if (saved) toast(`已保存到 ${saved}`);
  } catch (err) {
    console.error("[xfer] 另存为失败:", err);
    toast(errText(err), "error");
  }
}

function paintMeta(rec, m) {
  // 收进来的那一条标的是对话框名而不是设备名：同一台的两个框得能看出不是同一个
  const who = m.dir === "in" ? sessName(msgSid(m), m.peer) : "本机";
  const stateText =
    rec.state === "sending" ? " · 传输中" : rec.state === "failed" ? " · 失败" : "";
  rec.meta.textContent = `${who} · ${fmtTime(m.ts)}${stateText}`;
  rec.el.classList.toggle("is-failed", rec.state === "failed");
  rec.el.classList.toggle("is-sending", rec.state === "sending");
}

/**
 * 追加或原地更新一条消息（同 id 的多次状态更新只重画一次气泡）。
 * 只管当前会话的那一份流；属于别的会话的消息由 routeMessage() 拦在外面。
 * `anchor` 非空时插在这个元素之前：往前翻历史要把更早的铺到最上面，
 * 同一页按「旧的在前」依次插到同一个锚点前，顺序自然就是对的。
 * 返回 true 表示本次新建了气泡（调用方据此决定要不要重排日期分隔线）
 */
function upsertMessage(m, anchor = null) {
  if (!m || !m.id) return false;
  const atBottom = isNearBottom();
  const s = cur();
  let rec = s.bubbles.get(m.id);
  let created = false;
  if (!rec) {
    rec = buildBubble(m);
    s.bubbles.set(m.id, rec);
    created = true;
    if (anchor && anchor.parentNode === ui.stream) ui.stream.insertBefore(rec.el, anchor);
    else ui.stream.appendChild(rec.el);
  }
  rec.state = m.state || rec.state;
  // 累计一份最新的消息快照：搜索与类型归类都只读它，
  // 占位气泡后来才补齐的 name/path/size 也在这里落地
  rec.msg = { ...(rec.msg || {}), ...m };
  paintMeta(rec, m);
  // 接收完成时才拿到落盘路径与真实名字/大小，逐块补上（已填过则内部直接返回）
  if (rec.fileName && m.name) {
    rec.fileName.textContent = m.name;
    rec.fileName.title = m.path || "";
  }
  if (rec.fileSize && m.size) rec.fileSize.textContent = fmtSize(m.size);
  attachThumb(rec, m);
  attachActions(rec, m);
  if (rec.bar && m.size) {
    // 状态已终结时用满格，避免出现「已送达但进度条 98%」
    rec.bar.style.width = m.state === "sent" ? "100%" : rec.bar.style.width || "0%";
  }
  // 正筛着的时候来了新消息，不能让它绕过筛选直接冒出来
  if (filterActive()) applyFilter();
  if (atBottom) scrollBottom();
  return created;
}

/**
 * 按相邻消息重排日期分隔线。首屏、往前补页、新消息追加这三个地方都要走，
 * 少一处就会出现「往前翻页补进来的历史缺日期线」。
 * 这里不做增量维护：先把线全拆掉再按当前 DOM 顺序重算，比在每条路径上
 * 各自记住「上一条是谁」可靠得多（已铺出来的就几百条，成本可以忽略）
 */
function reconcileDividers() {
  const s = ui.stream;
  for (const d of Array.from(s.querySelectorAll(".day-divider"))) d.remove();
  let prev = null;
  for (const node of Array.from(s.querySelectorAll(".msg"))) {
    const m = cur().bubbles.get(node.dataset.id)?.msg;
    const ts = typeof m?.ts === "number" ? m.ts : null;
    if (ts === null) continue;
    const text = fmtDayDivider(ts, prev);
    if (text) {
      const d = document.createElement("div");
      d.className = "day-divider";
      d.textContent = text;
      s.insertBefore(d, node);
    }
    prev = ts;
  }
}

/**
 * 事件推来的消息不一定属于当前会话：属于当前会话才铺进气泡，
 * 别的会话只动会话栏那一行（历史已落库，切过去自然会重读到）。
 * 归属看的是会话 ID（老消息没 sid 就归它那台的基础对话），不是设备 ID
 */
function routeMessage(m, kind) {
  if (!m || !m.id) return false;
  const sid = msgSid(m);
  if (state.cur === null || sid !== state.cur) {
    bumpRail(m, sid, kind);
    return false;
  }
  clearEmptyHint();
  const created = upsertMessage(m);
  // 只有新增气泡才需要重排日期线，同一个气泡的进度/状态更新不用动
  if (created) reconcileDividers();
  // 会话栏那一行的「最后一条」跟着走，否则自己发出去的消息不会顶到列表最上面
  const row = sessionRowOf(state.cur);
  if (row && (m.ts || 0) >= (row.last || 0)) {
    row.last = m.ts;
    row.summary = summarize(m);
    renderSessionRail();
  }
  return true;
}

/** 会话栏那一行的本地累加，不值得为一两条消息去整读一遍历史 */
let railReloadPending = false;

function bumpRail(m, sid, kind) {
  const row = sessionRowOf(sid);
  if (!row) {
    // 陌生设备的第一条：后端已经给它建好会话了，重新拉一份列表（不逐条拉，
    // 只在没人认领时来一次，免得一个文件夹的几十个进度事件刷出几十次 RPC）
    if (!railReloadPending) {
      railReloadPending = true;
      loadSessions().finally(() => {
        railReloadPending = false;
      });
    }
    return;
  }
  if ((m.ts || 0) >= (row.last || 0)) {
    row.last = m.ts;
    row.summary = summarize(m);
  }
  // 未读只数「对方发来的、且是这条消息最后一次落地」：msg-in 与 xfer-done 各算一次，
  // 进度与状态更新不算，否则一个文件能刷出十几个未读
  if (m.dir === "in" && (kind === "msg-in" || kind === "xfer-done")) {
    row.unread = (row.unread || 0) + 1;
  }
  renderSessionRail();
}

/** 会话栏摘要的口径与后端 session_stats() 一致，改这一行时要同时改那边 */
function summarize(m) {
  if (m.kind === "text") return m.text || "";
  if (m.kind === "folder") return `[文件夹] ${m.name || ""}`;
  if (m.kind === "file") return `[文件] ${m.name || ""}`;
  return m.kind || "";
}

function isNearBottom() {
  const s = ui.stream;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

function scrollBottom() {
  ui.stream.scrollTop = ui.stream.scrollHeight;
}

async function loadHistory() {
  if (!isTauriRuntime) return;
  const s = cur();
  const id = state.cur;
  ui.stream.textContent = "";
  s.bubbles.clear();
  s.oldestId = null;
  if (id === null) {
    // 还没有任何会话：流里只留一句话，不能把别人的历史铺到这里
    ui.stream.innerHTML = `<div class="stream-empty">还没有会话。点左上角「＋ 新聊天」，或等一台设备给你发消息。</div>`;
    renderOlderBar();
    renderFilterCount(0);
    return;
  }
  try {
    // 首屏只拉当前对话框最近 PAGE 条（跟微信一样先看到最新的），更早的靠滚到顶/点顶栏补
    const list = await invoke("msg_history", { limit: PAGE, session: id });
    if (state.cur !== id) return; // 等回来的时候已经切走了，这一页不该再铺
    for (const m of list || []) {
      upsertMessage(m);
      if (!s.oldestId) s.oldestId = m.id; // 列表旧的在前，第一条即最老
    }
    s.hasMore = (list || []).length >= PAGE;
    if (!s.bubbles.size) {
      ui.stream.innerHTML = `<div class="stream-empty">还没有消息。把文件拖进来，或先写一句发过去。</div>`;
    }
    renderOlderBar();
    reconcileDividers();
    // 重铺历史后把当前搜索条件再应用一次（applyFilter 会自己滚到底）
    applyFilter();
    if (!filterActive()) scrollBottom();
  } catch (err) {
    console.error("[xfer] 读历史失败:", err);
    setStatus("读历史失败: " + errText(err));
  }
}

/** 往前补一页：铺完要把滚动位置接回去，否则视口会被新内容顶到最早那条上 */
async function loadOlder() {
  const s = cur();
  if (!isTauriRuntime || state.cur === null || s.loadingOlder || !s.hasMore || !s.oldestId) return;
  const id = state.cur;
  s.loadingOlder = true;
  setOlderBarText("正在加载更早的消息…");
  const h0 = ui.stream.scrollHeight;
  const t0 = ui.stream.scrollTop;
  try {
    const list = await invoke("msg_history", { limit: PAGE, before: s.oldestId, session: id });
    if (state.cur !== id) return; // 期间切了对话框，别把另一个框的历史铺进来
    if (!list || !list.length) {
      s.hasMore = false;
      return;
    }
    // 当前最老那条气泡（用 .msg 而不是 firstElementChild：前者天然跳过日期线与占位句）
    const anchor = ui.stream.querySelector(".msg");
    for (const m of list) {
      upsertMessage(m, anchor);
      s.oldestId = m.id; // 列表旧的在前，最后一条就是新的最老游标
    }
    s.hasMore = list.length >= PAGE;
    applyFilter();
    reconcileDividers();
    // 往上加了内容，得把多出来的高度补回 scrollTop，视口才能停在原来那几条上
    ui.stream.scrollTop = ui.stream.scrollHeight - h0 + t0;
  } catch (err) {
    console.error("[xfer] 加载更早的消息失败:", err);
    setStatus("加载更早的消息失败: " + errText(err));
  } finally {
    s.loadingOlder = false;
    renderOlderBar();
  }
}

function setOlderBarText(text) {
  if (ui.older) ui.older.textContent = text;
}

/**
 * 搜索/筛选得覆盖整份历史：现在只铺了最近 10 条，
 * 不先把早期的补进来会让人误判“没搜到”。最多翻 60 页（后端一页上限 500 条）。
 * 拉齐范围只在当前对话框内（loadOlder 自己带 session），跳会话搜索这轮不做。
 */
async function loadAllForSearch() {
  const s = cur();
  let guard = 0;
  while (s.hasMore && guard++ < 60) await loadOlder();
}

/** 没更多了就把栏收起来，免得留一个点了没反应按钮 */
function renderOlderBar() {
  if (!ui.older) return;
  const s = cur();
  ui.older.hidden = !(s.hasMore && s.bubbles.size);
  setOlderBarText("加载更早的消息");
}

function clearEmptyHint() {
  const hint = ui.stream.querySelector(".stream-empty");
  if (hint) hint.remove();
}

/* --------------------------------------------------------------------------
 * 搜索：只搜当前会话，按类型筛已有气泡 + 关键词搜名字/文字内容
 *
 * 搜索会先把更早的历史逐页补进来（loadAllForSearch），再在内存里筛：
 * 后端只存了一份小 JSONL，再加一层搜索接口只能把同一份文件重解一遍。
 * 跳会话搜索不做：跟分页游标纠缠在一起容易串页，收益不值。
 * ------------------------------------------------------------------------ */

/** 归类：文件夹看 kind，图片/压缩包看名字后缀，剩下的文件进「其他」 */
function classify(m) {
  if (!m) return "other";
  if (m.kind === "text") return "text";
  if (m.kind === "folder") return "folder";
  const n = m.name || "";
  if (IMAGE_EXT.test(n)) return "image";
  if (ARCHIVE_EXT.test(n)) return "archive";
  return "other";
}

function filterActive() {
  return state.filter.kind !== "all" || !!state.filter.q;
}

function matches(rec) {
  const m = rec.msg;
  if (!m) return true;
  const f = state.filter;
  if (f.kind !== "all" && classify(m) !== f.kind) return false;
  if (!f.q) return true;
  // 文字消息搜正文，文件/文件夹搜名字（path 不搜：太长且容易误命中目录部分）
  const hay = `${m.name || ""} ${m.text || ""}`.toLowerCase();
  return hay.includes(f.q);
}

/** 全量过一遍：切类型、改关键词、以及筛选中来了新消息时调用 */
function applyFilter() {
  const s = cur();
  // 筛的是当前会话的整份历史，不是已铺出来的那一页 —— 先把早期的拉齐再筛
  if (filterActive() && s.hasMore && !s.loadingOlder) loadAllForSearch();
  // 筛着的时候日期线会变成噪声（匹配结果本来就不连续），给流挂个标记让 CSS 隐掉
  ui.stream.classList.toggle("is-filtering", filterActive());
  let hit = 0;
  for (const rec of s.bubbles.values()) {
    const ok = matches(rec);
    rec.el.classList.toggle("is-filtered", !ok);
    if (ok) hit++;
  }
  renderFilterCount(hit);
  renderFilterEmpty(hit);
  // 筛完剩下的往往都在上面，不滚一次的话视口会停在刚被藏起来的那片空白里
  if (hit) scrollBottom();
}

function renderFilterCount(hit) {
  const box = ui.filterCount;
  if (!box) return;
  if (!filterActive()) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  // 带上对话框名：不写清楚很容易以为搜的是全部聊天（同一台还有好几个框时更是）
  box.textContent = `${sessName(state.cur)} · 匹配 ${hit} / ${cur().bubbles.size}`;
}

/** 一条都不剩时给句话，否则整个流是空白的，看起来像程序坏了 */
function renderFilterEmpty(hit) {
  const s = cur();
  let hint = ui.stream.querySelector(".filter-empty");
  if (hit === 0 && s.bubbles.size > 0) {
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "filter-empty";
      ui.stream.appendChild(hint);
    }
    hint.textContent = `「${sessName(state.cur)}」里没有符合条件的消息（只搜已加载的历史，不含对端）`;
  } else if (hint) {
    hint.remove();
  }
}

/* --------------------------------------------------------------------------
 * 发送
 * ------------------------------------------------------------------------ */

/** 没选定对话框（或这台还没添加为对端）时不能发：后端会拿 active 兜底，
 *  而 active 为空直接报错，不如在这里先拦住，提示也更准 */
function requireSession() {
  if (state.cur === null) {
    toast("先在左边开一个会话", "error");
    return false;
  }
  const sess = sessionRowOf(state.cur);
  if (!sess || !sess.bound) {
    toast(`「${sessName(state.cur)}」还没添加为对端，先配对才能主动发给它`, "error");
    return false;
  }
  return true;
}

async function sendText() {
  const text = ui.input.value;
  if (!text.trim()) {
    toast("先写点内容", "error");
    return;
  }
  if (!requireSession()) return;
  ui.input.value = "";
  ui.input.style.height = "";
  // `to` 是会话 ID：同一台的几个框各自发到自己那个框里，后端拿它去带 X-Session
  await runSend(() => invoke("send_text", { text, to: state.cur }));
}

async function sendPaths(paths) {
  if (!paths || !paths.length) return;
  if (!requireSession()) return;
  clearEmptyHint();
  await runSend(() => invoke("send_paths", { paths, to: state.cur }));
}

/** 发送期间的统一收口：禁用按钮、错误提示、结束后按最新状态恢复 */
async function runSend(task) {
  clearEmptyHint();
  state.sending = true;
  ui.btnSend.disabled = true;
  ui.btnFile.disabled = true;
  ui.btnFolder.disabled = true;
  try {
    await task();
    toast("已送达");
  } catch (err) {
    const msg = errText(err);
    console.error("[xfer] 发送失败:", err);
    toast(msg, "error");
  } finally {
    state.sending = false;
    await refreshStatus();
    // 会话栏的摘要与在线点：发出去的那一条也要在列表里露出来
    await loadSessions();
  }
}

/* --------------------------------------------------------------------------
 * 剪贴板走 api.js 的共享实现（收藏视图同样要用）
 * ------------------------------------------------------------------------ */

/** 选中聊天文字即可收藏；默认挂在收藏根层级，之后可在收藏视图里归类 */
async function favoriteText(text) {
  const title = (text.split(/\r?\n/)[0] || "").slice(0, 40) || "未命名收藏";
  try {
    await invoke("fav_upsert", { node: { kind: "fav", title, body: text, parent: null } });
    toast(`已收藏「${title}」，可在收藏视图归类`);
  } catch (err) {
    toast(errText(err), "error");
  }
}

/* --------------------------------------------------------------------------
 * 配对设置
 * ------------------------------------------------------------------------ */
async function savePairConfig() {
  const args = {};
  const p = ui.passphrase.value.trim();
  if (p) args.passphrase = p;
  const n = ui.deviceName.value.trim();
  if (n) args.name = n;
  if (!Object.keys(args).length) {
    toast("口令与设备名都是空的", "error");
    return;
  }
  try {
    renderStatus(await invoke("set_pair_config", args));
    toast("配对设置已保存");
  } catch (err) {
    toast(errText(err), "error");
  }
}

/**
 * 添加一台对端。多台之后这不是「换一台绑」而是「多一台可发」，
 * `autoFocus` 为 true 时顺手给它建好基础对话并切过去（这台已经能开好几个框，
 * 这里建的永远是最早那一个：新话题走 session_new）；返回是否成功，
 * 让「＋ 新聊天」那类调用点能在失败时别接着建会话
 */
async function bindAddr(addr, autoFocus = true) {
  if (!addr) {
    toast("填对端 IP，形如 192.168.1.23 或 192.168.1.23:45790", "error");
    return false;
  }
  ui.btnManual.disabled = true;
  // 前后两份对端列表求差集就能认出「刚加的那台」：端口是试探出来的，
  // 拿用户填的地址去反查会猜错
  const known = new Set((state.status?.peers || []).map((p) => p.id));
  let ok = true;
  try {
    await invoke("bind_peer_addr", { addr });
    ui.manualAddr.value = "";
    toast("已添加对端");
  } catch (err) {
    ok = false;
    toast(errText(err), "error");
  } finally {
    await refreshStatus();
    await loadSessions();
  }
  if (ok && autoFocus) {
    const fresh = (state.status?.peers || []).find((p) => !known.has(p.id));
    if (fresh) {
      // 刚添加就顺手把基础对话建出来：只切焦点不建行，会话栏里连个高亮都没有
      try {
        applySessions(await invoke("session_create", { peer: fresh.id, name: peerLabel(fresh) }));
      } catch (err) {
        toast(errText(err), "error");
      }
      await openSession(fresh.id);
    }
  }
  return ok;
}

function bindManual() {
  bindAddr(ui.manualAddr.value.trim());
}

/* --------------------------------------------------------------------------
 * 事件绑定
 * ------------------------------------------------------------------------ */
ui.btnSend.addEventListener("click", sendText);
ui.input.addEventListener("keydown", (ev) => {
  // Enter 发送、Shift+Enter 换行；输入法组合期间不能截走 Enter
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    sendText();
  }
});
ui.input.addEventListener("input", () => {
  ui.input.style.height = "auto";
  ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + "px";
});

ui.btnFile.addEventListener("click", async () => {
  try {
    const paths = await invoke("pick_send_files");
    if (paths?.length) await sendPaths(paths);
  } catch (err) {
    toast(errText(err), "error");
  }
});

ui.btnFolder.addEventListener("click", async () => {
  try {
    const dir = await invoke("pick_folder");
    if (dir) await sendPaths([dir]);
  } catch (err) {
    toast(errText(err), "error");
  }
});

// 拖文件进窗口即发送：注册给 api.js 的拖拽路由（对比视图不会走到这里）
registerDropHandler("transfer", (paths) => sendPaths(paths));

// 焦点不在输入框上时粘文字：先填到输入框让用户看一眼再发，不直接往对端推
registerPasteTextHandler("transfer", (text) => {
  ui.input.value = text;
  ui.input.focus();
  // 高度自适应绑在 input 事件上，不手动派一次会停在默认行高
  ui.input.dispatchEvent(new Event("input"));
  toast("已粘到输入框，Enter 发送");
});

// 拖拽悬停遮罩：像微信那样先告诉用户「松开就发」，离线时也明确拦在那里
registerDropHoverHandler("transfer", (phase) => {
  if (!ui.dropHint) return;
  if (phase === "drop" || phase === "leave") {
    ui.dropHint.hidden = true;
    return;
  }
  const sess = sessionRowOf(state.cur);
  const online = !!sess && sess.bound && sess.online;
  ui.dropHint.hidden = false;
  ui.dropHint.classList.toggle("is-blocked", !online);
  ui.dropText.textContent = !state.status?.passphrase_set
    ? "先在「配对设置」里填口令"
    : !sess
      ? "先在左边选一个会话"
      : online
        ? `松开即发送给「${sess.name}」`
        : `「${sess.name}」${sess.bound ? "离线，暂发不出去" : "还没添加，发不出去"}`;
});

// 放大层：点背景/关闭按钮/Esc 都能退出，只在有该 DOM 时绑定
if (ui.lightbox && ui.lightboxClose) {
  ui.lightboxClose.addEventListener("click", closeLightbox);
  ui.lightbox.addEventListener("click", (ev) => {
    if (ev.target === ui.lightbox) closeLightbox();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeLightbox();
    // 放大状态下 ⌘C 等于「把这张图当文件复制」，不另设按钮
    if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && (ev.key || "").toLowerCase() === "c") {
      if (ui.lightbox.hidden) return;
      ev.preventDefault();
      if (lightboxPath) copyPathAsFile(lightboxPath);
    }
  });
}

ui.btnPair.addEventListener("click", savePairConfig);
// 备注名：点按钮与按回车走同一条保存，不拿 blur 当保存（从输入框移开鼠标不等于想改名）
ui.btnPeerAlias.addEventListener("click", savePeerAlias);
ui.peerAlias.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.isComposing) savePeerAlias();
});
ui.btnManual.addEventListener("click", bindManual);
ui.manualAddr.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") bindManual();
});
ui.btnUnbind.addEventListener("click", () => unbindOne(sessionRowOf(state.cur)));
ui.btnReprobe.addEventListener("click", async () => {
  const sess = sessionRowOf(state.cur);
  if (!sess) return;
  ui.btnReprobe.disabled = true;
  try {
    await invoke("reprobe_peer", { peer: sess.peer });
    toast("对端在线");
  } catch (err) {
    toast(errText(err), "error");
  } finally {
    await refreshStatus();
    await loadSessions();
  }
});
// 「＋ 新聊天」：弹层里把已登记的与刚发现的合成一份候选
ui.btnNewChat?.addEventListener("click", togglePick);
// 点弹层外面就收起，不强迫用户先找到那个开着的开关
ui.stream.addEventListener("pointerdown", hidePick);
ui.btnSettings.addEventListener("click", () => {
  ui.settings.classList.toggle("is-open");
});

/* 搜索：输入就筛。不加防抖——纯内存遍历几百个气泡，比等防抖窗口更快出结果 */
if (ui.search) {
  ui.search.addEventListener("input", () => {
    state.filter.q = ui.search.value.trim().toLowerCase();
    applyFilter();
  });
}

// 类型 chip 单选，点「全部」等于清掉类型条件
if (ui.chips) {
  ui.chips.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".chip");
    if (!btn || !ui.chips.contains(btn)) return;
    state.filter.kind = btn.dataset.kind || "all";
    for (const b of ui.chips.querySelectorAll(".chip")) b.classList.toggle("is-on", b === btn);
    applyFilter();
  });
}

// ⌘F/Ctrl+F 直跳搜索框；Esc 在搜索框里是清空并交还焦点，不抢其它地方的 Esc（比如关掉放大层）
window.addEventListener("keydown", (ev) => {
  if (currentView() !== "transfer" || !ui.search) return;
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    ui.search.focus();
    ui.search.select();
    return;
  }
  if (ev.key === "Escape" && document.activeElement === ui.search) {
    ui.search.value = "";
    state.filter.q = "";
    applyFilter();
    ui.search.blur();
  }
});

// 抽屉内部的收起入口（收藏夹抽屉同样用这套 data 属性）
document.querySelectorAll("[data-close-drawer]").forEach((btn) =>
  btn.addEventListener("click", () => {
    el(btn.dataset.closeDrawer)?.classList.remove("is-open");
  })
);

/* --------------------------------------------------------------------------
 * 初始化与事件订阅
 * ------------------------------------------------------------------------ */
listen("peers-changed", renderStatus);
// 会话的新建与删除都从这里走：陌生设备的第一条消息就是在这里把行放进会话栏的
listen("sessions-changed", applySessions);
listen("msg-in", (payload) => {
  if (routeMessage(payload?.message, "msg-in")) scrollBottom();
});
listen("msg-updated", (payload) => routeMessage(payload?.message, "msg-updated"));
listen("xfer-progress", (p) => {
  if (!p || !p.msg_id) return;
  // 进度事件也带会话 ID（不带就不知道该铺进哪个框）；不是当前会话的这一条直接丢下。
  // 接收端的进度可能早于会话建好，那一刻 sid 还是空的，只能拿设备 ID 兼一下
  const sid = p.sid || p.peer || UNMARKED;
  if (state.cur === null || sid !== state.cur) return;
  const rec = cur().bubbles.get(p.msg_id);
  if (rec && rec.bar && p.total) {
    rec.bar.style.width = Math.min(100, Math.round((p.sent / p.total) * 100)) + "%";
    rec.bar.title = `${p.name} ${fmtSize(p.sent)} / ${fmtSize(p.total)}`;
  } else if (!rec) {
    // 收文件时第一条进度可能早于 xfer-done，先占个气泡，done 再补全信息
    if (upsertMessage({
      id: p.msg_id,
      dir: "in",
      kind: "file",
      peer: p.peer ?? "",
      sid: p.sid ?? "",
      name: p.name || "接收中",
      size: p.total,
      state: "sending",
      ts: Date.now(),
    })) {
      reconcileDividers();
    }
  }
  if (isNearBottom()) scrollBottom();
});
listen("xfer-done", (payload) => routeMessage(payload?.message, "xfer-done"));

/* 往前翻页：滚到顶自动补一页，内容不够一屏（滚不动）时靠顶栏点一下 */
ui.stream.addEventListener("scroll", () => {
  if (ui.stream.scrollTop < 30) loadOlder();
});
if (ui.older) ui.older.addEventListener("click", loadOlder);

/* 启动顺序：状态 → 会话 → 历史。会话栏要先知道哪台在线，
 * 历史要拿当前会话的 peer 去筛，反过来做会先铺一页不该看的 */
(async function boot() {
  await refreshStatus();
  await loadSessions();
  await loadHistory();
  console.log("[xfer] 传输视图初始化完成");
})();
