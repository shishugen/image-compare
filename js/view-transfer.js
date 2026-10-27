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
  assetSrc,
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
  noteViewSeen,
  onViewChange,
  openInCompare,
  registerDropHandler,
  registerDropHoverHandler,
  registerPasteTextHandler,
  setStatus,
  takePendingSend,
  toast,
} from "./api.js";

const ui = {
  stream: el("xfer-stream"),
  input: el("xfer-input"),
  btnSend: el("btn-xfer-send"),
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
  // 本机接收（提示音 / 收件目录 / 收件目录里的摆放）
  notifyChk: el("chk-notify-sound"),
  notifyText: el("sw-notify-text"),
  btnAudition: el("btn-notify-audition"),
  inboxValue: el("inbox-dir-value"),
  btnInboxChoose: el("btn-inbox-choose"),
  btnInboxReset: el("btn-inbox-reset"),
  btnInboxReveal: el("btn-inbox-reveal"),
  inboxLayout: el("inp-inbox-layout"),
  inboxSample: el("inbox-layout-sample"),
  // 存储（占用统计与收件目录清理）
  storageRows: el("storage-rows"),
  btnStorageRefresh: el("btn-storage-refresh"),
  btnStorageReveal: el("btn-storage-reveal"),
  inboxCleanSel: el("inp-inbox-clean"),
  btnInboxClean: el("btn-inbox-clean"),
  // 在线探测（心跳节拍）
  heartbeatSel: el("inp-heartbeat"),
  dropHint: el("xfer-drop-hint"),
  dropText: el("xfer-drop-text"),
  // 待发送区（选好/拖进来的东西先摆在这里，点发送才发）
  attach: el("xfer-attach"),
  attachRow: el("xfer-attach-row"),
  attachTitle: el("xfer-attach-title"),
  btnAttachClear: el("xfer-attach-clear"),
  older: el("xfer-older"),
  search: el("xfer-search"),
  chips: el("xfer-chips"),
  filterCount: el("xfer-filter-count"),
  sessions: el("xfer-sessions"),
  sessionRows: el("xfer-session-rows"),
  // 会话行右键菜单（置顶 / 重命名 / 删除），替掉 WebView 那套英文原生菜单
  chatMenu: el("chat-menu"),
  chatPin: el("ctx-chat-pin"),
  chatRename: el("ctx-chat-rename"),
  chatSep: el("ctx-chat-sep"),
  chatClear: el("ctx-chat-clear"),
  chatDel: el("ctx-chat-del"),
  // 聊天气泡的右键菜单（文字 / 文件 / 图片共用一份，中文）：撤回与本机删除的入口也在这里
  msgMenu: el("chat-msg-menu"),
  msgCopyText: el("cb-copy-text"),
  msgCopyImg: el("cb-copy-img"),
  msgSave: el("cb-save"),
  msgCopyPath: el("cb-copy-path"),
  msgReveal: el("cb-reveal"),
  msgCompare: el("cb-compare"),
  msgSep: el("ctx-msg-sep"),
  msgRecall: el("ctx-msg-recall"),
  msgDel: el("ctx-msg-del"),
  msgQuote: el("cb-quote"),
  msgForward: el("cb-forward"),
  quoteBar: el("xfer-quote"),
  quoteBarText: el("xfer-quote-text"),
  quoteClear: el("xfer-quote-x"),
  fwdPick: el("xfer-fwd-pick"),
  fwdList: el("xfer-fwd-list"),
  fwdCancel: el("xfer-fwd-cancel"),
  // 跨会话全局搜索的浮层（⌘F / 顶栏按钮）
  findBtn: el("btn-xfer-find"),
  findPick: el("xfer-find"),
  findX: el("xfer-find-x"),
  findQ: el("xfer-find-q"),
  findChips: el("xfer-find-chips"),
  findList: el("xfer-find-list"),
  // 放大层的右键菜单（中文五项）：至此对比视图、聊天气泡、放大层三处右键都是自己的菜单了
  lbMenu: el("lightbox-menu"),
  lbCopyImg: el("lbm-copy-img"),
  lbSave: el("lbm-save"),
  lbCopyPath: el("lbm-copy-path"),
  lbReveal: el("lbm-reveal"),
  lbCompare: el("lbm-compare"),
  navBadge: el("nav-badge-xfer"),
  btnNewChat: el("btn-session-new"),
  chatPick: el("xfer-chat-pick"),
  pickList: el("xfer-pick-list"),
  lightbox: el("img-lightbox"),
  lightboxImg: el("lightbox-img"),
  lightboxCap: el("lightbox-cap"),
  lightboxClose: el("lightbox-close"),
  lightboxIn: el("lightbox-in"),
  lightboxOut: el("lightbox-out"),
  lightboxFit: el("lightbox-fit"),
  lightboxOne: el("lightbox-one"),
  lightboxZoom: el("lightbox-zoom"),
  lightboxTile: el("lightbox-tile"),
  lightboxTileStage: el("lightbox-tile-stage"),
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
  /** 待发送区：选好/拖进来但还没发出去的东西，按选的顺序摆着。
   *  它只是「下一句要发的东西」，不认会话 —— 跟着当前对话框走，所以切了框也能在这里直接发。
   *  以前给这一批记一个归属（attachSid）并在切走后拦下，结果是粘一张图、切个框就卡在那
   *  发不出去也删不掉的黄字上（用户报过），那层锁多余 */
  attach: [],
  /** 引用回复：待发送的那张小卡片（没发出去前住在预览条里），跟着下一条文字走 */
  quote: null,
  /** 转发中的那条快照：浮层选人之前拿着它等点击 */
  fwd: null,
  /** 当前搜索条件：kind 为 all/text/image/folder/archive/other，q 为关键词 */
  filter: { kind: "all", q: "" },
  /** 当前生效的收件目录，只给「打开目录」用（抽屉打开时读一次） */
  inboxDir: "",
  /** 收件目录里的摆放：day / month / flat。记一份是为了在下拉存盘失败时能退回原值 */
  inboxLayout: "day",
  /** 心跳节拍（毫秒）：同上，存不下要能退回原来那一档 */
  heartbeatMs: 1000,
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
  // 今年内只到月-日：带上年的那种写法要 60px，而这一行总共才 194px；跨年才留年份
  if (d.getFullYear() === new Date().getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// IMAGE_EXT 从 api.js 导，三个视图共用一份口径

/** 能撤回的时间窗（毫秒）：与 store.rs 的 RECALL_WINDOW_MS 同一个口径。这里只决定
 *  入口露不露，真正的拦在那边 —— 气泡放着不动不会自己重画，前端这一档只是手感 */
const RECALL_MS = 60000;
/** 撤回之后两边各看到的那句话 */
const RECALL_TEXT = { out: "你撤回了一条消息", in: "对方撤回了一条消息" };
/** 会话栏摘要里那句短文案，与 Rust 的 RECALL_SUMMARY 一份口径 */
const RECALL_SUMMARY = "撤回了一条消息";

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
  // 能不能发只看这台加没加过：离线也能发（存本机排队，上线自动补发），
  // 而未配对是连地址都没有、排队也排不了，所以那个仍然得禁着
  const canSend = !!sess && sess.bound;
  const reachable = canSend && sess.online;
  node.classList.toggle("is-online", reachable);
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

/* --------------------------------------------------------------------------
 * 左侧「传输」按钮上的未读总数
 *
 * 与会话栏每行那个数、以及图标角标（Rust 侧 badge.rs）同一个口径：
 * 就是把 sessions 里每行的 unread 加起来，「未标记」与补漏行在后端已被置 0，
 * 掺不进来。封顶 99+ 也照抄会话行那套写法，免得同一个未读数在三个地方长三种样。
 *
 * 只由 renderSessionRail() 调：本地累加未读那条路（bumpRail）不重新取列表，
 * 挂在这里两边就不可能各算一份。
 * ------------------------------------------------------------------------ */
function renderNavBadge(rows) {
  const b = ui.navBadge;
  if (!b) return;
  // unread 缺字段、为 null、为负都当 0：宁可少报一个角标，不能报出个 NaN
  const total = (rows || []).reduce((n, s) => n + (s.unread > 0 ? s.unread : 0), 0);
  if (!total) {
    b.textContent = "";
    b.hidden = true;
    return;
  }
  b.textContent = total > 99 ? "99+" : String(total);
  b.hidden = false;
}

/** 切到某个对话框（参数是会话 ID，不是对端 ID） */
async function openSession(id) {
  if (state.cur === id) return;
  hidePick();
  state.cur = id;
  // 引用指着的是某个具体会话里的某一条：换了框还挂着会把 A 会话的原文引到 B 里去发
  clearQuote();
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
  // 待发送区标着「发给哪个框」：换了框得把这句话与「不在这个会话」的提示重新算一遍
  renderAttach();
}

/** 对比视图右键「发送到聊天」带过来的一张图：先摆进待发送区，用户挑好框再点发送。
 *  微信也是这个顺序（先放进输入框、再选人），而不是点完会话就发出去 ——
 *  那样没给人“反悔”的机会，也看不出到底是发给了谁。 */
async function stagePendingSend() {
  const pending = takePendingSend();
  if (!pending) return;
  // 反复投同一张：别把 addAttach 那句“已经在待发送区了”和下面这句叠成两条 toast
  if (state.attach.some((a) => a.path === pending.path)) {
    toast(`「${pending.name}」已经在待发送区了`);
    return;
  }
  await addAttach([pending.path], { allowNoSession: true });
  toast(
    state.cur === null
      ? `「${pending.name}」已放入待发送区：在左边选一个会话，再点发送`
      : `「${pending.name}」已放入待发送区：换选别的会话也行，点发送发给当前这个`
  );
}

/** 会话栏重建的代价虽然小，但心跳每秒都推一次 peers-changed，
 *  不去重就会每秒拆建一次 DOM（连带丢掉悬停与列表的滚动位置） */
let railSig = "";

/* --------------------------------------------------------------------------
 * 会话行右键菜单
 *
 * 为什么要自己画：右键点会话行时 WKWebView 会弹它自己那套原生菜单（Reload / Inspect
 * Element），语言跟着系统走英语，跟聊天一项关系都没有。这里换成中文三项：置顶 /
 * 重命名 / 删除（删除跟行内那枚一样要两步）。
 *
 * 置顶的口径跟微信一样：置顶的永远排在最上面（不按最后一条消息时间），底色深一档；
 * 取消置顶就回到按时间的位置。存在 sessions.json 里，重启还在。
 * ------------------------------------------------------------------------ */
const railMenu = { row: null, s: null, armed: false, clearArmed: false };
/** 「删除聊天」臂上之后没人点，几秒得自己退回去 */
let railArmTimer = 0;
/** 「清空聊天记录」自己的一枚臂与计时器：同一个菜单里两项破坏性入口，
 *  臂不能互咬（臂上清空后去点删除，不该被当成「第二次确认」） */
let railClearTimer = 0;
const CHAT_CLEAR_LABEL = "清空聊天记录";

/** 「删除」这一项在两种行上的文案：「未标记」删的是一格筐里的老消息，不是一台设备 */
function delLabel(s) {
  return s && s.peer === UNMARKED ? "删除这些消息" : "删除聊天";
}

function closeChatMenu() {
  if (!ui.chatMenu || ui.chatMenu.hidden) return;
  ui.chatMenu.hidden = true;
  railMenu.row = null;
  railMenu.s = null;
  railMenu.armed = false;
  railMenu.clearArmed = false;
  clearTimeout(railArmTimer);
  clearTimeout(railClearTimer);
  if (ui.chatDel) ui.chatDel.textContent = "删除聊天";
  if (ui.chatClear) ui.chatClear.textContent = CHAT_CLEAR_LABEL;
}

/** 菜单在鼠标处摊开：先显示再量尺寸，贴到窗口右/下边时翻到另一边。
 *  会话菜单与聊天气泡里的图片菜单共用这一份 —— 贴边翻页只写一次 */
function placeMenuAt(m, ev) {
  m.hidden = false;
  // 先把坐标清零再量：留旧坐标会把贴边翻页算错（图片菜单踩过这个）
  m.style.left = "0px";
  m.style.top = "0px";
  const rect = m.getBoundingClientRect ? m.getBoundingClientRect() : { width: 0, height: 0 };
  const gap = 8;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  let x = ev.clientX || 0;
  let y = ev.clientY || 0;
  if (vw && x + rect.width + gap > vw) x = Math.max(gap, x - rect.width);
  if (vh && y + rect.height + gap > vh) y = Math.max(gap, y - rect.height);
  m.style.left = x + "px";
  m.style.top = y + "px";
}

/** 在鼠标处摊开会话菜单（算法见 placeMenuAt） */
function openChatMenu(ev, s, row) {
  if (!ui.chatMenu) return;
  if (ev.preventDefault) ev.preventDefault();
  if (ev.stopPropagation) ev.stopPropagation();
  if (!ui.chatMenu.hidden) closeChatMenu();
  railMenu.row = row;
  railMenu.s = s;
  railMenu.armed = false;
  railMenu.clearArmed = false;
  if (ui.chatClear) ui.chatClear.textContent = CHAT_CLEAR_LABEL;
  // 「未标记」不是一台真设备：置顶与改名都没有落点，这两项连同隔断一起藏起来，只留清空与删除。
  // 以前这一行右键只弹一句「只能查看」——用户看到的就是「删也删不了」
  const unmarked = s.peer === UNMARKED;
  if (ui.chatPin) {
    ui.chatPin.hidden = unmarked;
    // 文案跟当前状态走：已经置顶过的，第一项就是「取消置顶」
    ui.chatPin.textContent = s.pinned ? "取消置顶" : "置顶该聊天";
  }
  if (ui.chatRename) ui.chatRename.hidden = unmarked;
  if (ui.chatSep) ui.chatSep.hidden = unmarked;
  if (ui.chatDel) ui.chatDel.textContent = delLabel(s);
  placeMenuAt(ui.chatMenu, ev);
}

/* --------------------------------------------------------------------------
 * 聊天气泡的右键菜单
 *
 * 与对比视图那套（`#img-menu`）同一批命令、同一套中文文案，差别只有一项：
 * 这里本来就在聊天里，所以没有「发送到聊天」，换成「在对比中打开」。
 *
 * 整条气泡都拦（文字 / 文件 / 图片都拦）：不拦就是 WebView 那套英文菜单
 * （Look Up / Translate / Search with Baidu / Share… / Inspect Element），
 * 而撤回与本机删除两个入口也得有个地方放。一个菜单管三种气泡：每一项按
 * 这一条当下是什么动态显隐，比开三份菜单更容易对不齐。
 * 文字气泡里因此拿不到系统的选词与拷贝，菜单里给了「复制正文」补上这一项。
 * ------------------------------------------------------------------------ */
const msgMenu = { rec: null, armed: false };
/** 「删除」臂上之后没人点，几秒得自己退回去（与会话菜单那枚同一套手感） */
let msgArmTimer = 0;
const MSG_DEL_LABEL = "删除（只删本机）";

function closeMsgMenu() {
  if (!ui.msgMenu || ui.msgMenu.hidden) return;
  ui.msgMenu.hidden = true;
  msgMenu.rec = null;
  msgMenu.armed = false;
  clearTimeout(msgArmTimer);
  if (ui.msgDel) ui.msgDel.textContent = MSG_DEL_LABEL;
}

/** 这一条当下算得出什么：路径与是不是图片都从最新那份快照看（占位气泡后来才补上） */
function msgTargets(rec) {
  const m = rec?.msg || {};
  const path = m.path || rec?.path || "";
  const name = m.name || rec?.name || "";
  return {
    m,
    path,
    name,
    isText: m.kind === "text",
    isImage: m.kind === "file" && !!path && IMAGE_EXT.test(name),
    hasFile: !!path,
  };
}

/** 在鼠标处摊开消息菜单，先把与这一条无关的项藏掉（贴边翻页交给 placeMenuAt） */
function openMsgMenu(ev, rec) {
  if (!ui.msgMenu || !rec) return;
  if (ev.preventDefault) ev.preventDefault();
  if (ev.stopPropagation) ev.stopPropagation();
  if (!ui.msgMenu.hidden) closeMsgMenu();
  const t = msgTargets(rec);
  const show = (node, on) => {
    if (node) node.hidden = !on;
  };
  show(ui.msgCopyText, t.isText);
  // 引用回复：正文非空且没被撤回才露。文字引正文、文件引文件名，都不要求本机路径
  show(ui.msgQuote, !t.m.recalled && !!((t.isText ? t.m.text : t.name) || "").trim());
  // 转发：有正文或有本机路径才露（接收中的占位气泡还没拿到路径，转了也是空的）
  show(ui.msgForward, !t.m.recalled && ((t.isText && !!(t.m.text || "").trim()) || t.hasFile));
  show(ui.msgCopyImg, t.isImage);
  show(ui.msgSave, t.hasFile);
  show(ui.msgCopyPath, t.hasFile);
  show(ui.msgReveal, t.hasFile);
  show(ui.msgCompare, t.isImage);
  // 上面一组一项都没有（接收中、还拿不到路径的文件）时，那根隔断也不该留白
  show(ui.msgSep, t.isText || t.isImage || t.hasFile);
  show(ui.msgRecall, recallable(rec, t.m));
  show(ui.msgDel, true);
  if (ui.msgDel) ui.msgDel.textContent = MSG_DEL_LABEL;
  msgMenu.rec = rec;
  msgMenu.armed = false;
  placeMenuAt(ui.msgMenu, ev);
}

async function runMsgMenu(act) {
  const t = msgTargets(msgMenu.rec);
  closeMsgMenu();
  const p = t.path;
  const name = t.name || p;
  // 引用只要正文或文件名就算得出来，不要求本机路径（接收中的文件也能引）
  if (act === "quote") {
    setQuote(t.m);
    return;
  }
  // 转发弹的是会话选择浮层，发送等点完那条再做（也先于「必须有路径」那道闸门）
  if (act === "forward") {
    openFwdPick(t);
    return;
  }
  // 除了「复制正文」，其余每一项都要本机路径；路径还没到手（接收中）就什么都不做
  if (act !== "copy-text" && !p) return;
  try {
    if (act === "copy-text") {
      await copyText(t.m.text || "");
    } else if (act === "copy-img") {
      // 与对比视图同一个命令：剪贴板里同时有文件与位图，粘到微信就是图
      await copyPathAsFile([p]);
    } else if (act === "save") {
      const saved = await invoke("save_path_as", { src: p });
      // null = 选文件框里按了取消：这不是失败，不用弹提示
      if (saved) toast(`已保存到 ${saved}`);
    } else if (act === "copy-path") {
      await copyText(p);
    } else if (act === "reveal") {
      await invoke("reveal_in_folder", { path: p });
    } else if (act === "compare") {
      openInCompare([p]);
    }
  } catch (err) {
    console.error("[xfer] 消息菜单操作失败:", act, err);
    toast(errText(err) || `${name} 操作失败`, "error");
  }
}

for (const [node, act] of [
  [ui.msgCopyText, "copy-text"],
  [ui.msgQuote, "quote"],
  [ui.msgForward, "forward"],
  [ui.msgCopyImg, "copy-img"],
  [ui.msgSave, "save"],
  [ui.msgCopyPath, "copy-path"],
  [ui.msgReveal, "reveal"],
  [ui.msgCompare, "compare"],
]) {
  if (node) node.addEventListener("click", () => runMsgMenu(act));
}

if (ui.msgRecall) {
  ui.msgRecall.addEventListener("click", () => {
    const rec = msgMenu.rec;
    closeMsgMenu();
    if (rec) recallMessage(rec);
  });
}
if (ui.msgDel) {
  ui.msgDel.addEventListener("click", () => {
    const rec = msgMenu.rec;
    if (!rec) return;
    // 跟会话菜单那枚一样要两步：右键手一下不该就把一条消息从本机抹掉
    if (!msgMenu.armed) {
      msgMenu.armed = true;
      ui.msgDel.textContent = "再点一次删除";
      clearTimeout(msgArmTimer);
      msgArmTimer = setTimeout(() => {
        msgMenu.armed = false;
        if (ui.msgDel) ui.msgDel.textContent = MSG_DEL_LABEL;
      }, 4000);
      return;
    }
    closeMsgMenu();
    deleteMessage(rec);
  });
}

/* --------------------------------------------------------------------------
 * 引用回复
 *
 * 存的是被引那一刻的快照（后端 store::Quote）：原文后来被撤回、被删、
 * 还在没铺出来的历史页里，卡片都能照渲染。发出后就是一条带 quote 的新消息，
 * 老对端不认这个字段也只当普通文字显示（降级不报错）。
 * ------------------------------------------------------------------------ */
/** 摘录超这几字符就截断加省略号（与后端 Quote.text 的注释同一口径） */
const QUOTE_MAX = 120;

/** 按字符截不按字节：中文一个字在 .length 里占两个，按字节切会拦腰掉字 */
function quoteSnippet(s) {
  const chars = Array.from(String(s || ""));
  return chars.length > QUOTE_MAX ? chars.slice(0, QUOTE_MAX).join("") + "…" : chars.join("");
}

/** 从一条消息算出引用快照：引文字摘正文，引文件摘文件名。
 *  被引人名字当场算好存死（改名不回头改旧卡片），不是 id */
function makeQuote(m) {
  if (!m || !m.id) return null;
  const isText = m.kind === "text";
  const raw = String((isText ? m.text : m.name) || "");
  if (!raw.trim()) return null;
  return {
    id: m.id,
    from: m.dir === "out" ? "我" : sessName(state.cur, m.peer),
    text: quoteSnippet(raw),
    kind: m.kind,
    name: isText ? null : m.name || null,
  };
}

/** 把引用挂到预览条上：输入框上方那一条，Enter/点发送时跟着正文一起走 */
function setQuote(m) {
  const q = makeQuote(m);
  if (!q) {
    toast("这一条是空的，引用不了", "error");
    return;
  }
  state.quote = q;
  if (ui.quoteBar) ui.quoteBar.hidden = false;
  if (ui.quoteBarText) ui.quoteBarText.textContent = `引用 ${q.from}：${q.text}`;
}

function clearQuote() {
  state.quote = null;
  if (ui.quoteBar) ui.quoteBar.hidden = true;
  if (ui.quoteBarText) ui.quoteBarText.textContent = "";
}

if (ui.quoteClear) ui.quoteClear.addEventListener("click", clearQuote);

/** 跳到被引那一条：滚到中间闪一下。不在已铺页面里只提示不硬拉 ——
 *  为了点一下卡片把几十页历史全加载出来不值得（全局搜索那边才有逐页找的逻辑） */
function jumpToQuoted(id) {
  if (!id) return;
  let el = null;
  for (const c of ui.stream.children) {
    if (c.dataset && c.dataset.id === id) {
      el = c;
      break;
    }
  }
  if (!el) {
    toast("原文还没加载出来");
    return;
  }
  if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
  flashNode(el);
}

/** 闪一下：挂 is-flash 让 CSS 动画跑完再撤掉（引用定位与全局搜索共用这一套） */
function flashNode(node) {
  node.classList.add("is-flash");
  setTimeout(() => node.classList.remove("is-flash"), 1200);
}

/** 气泡顶部那张小卡片：浅底小一号字，点了滚回原文 */
function quoteCard(q) {
  const card = document.createElement("div");
  card.className = "quote-card";
  card.textContent = `引用 ${q.from || ""}：${q.text || q.name || ""}`;
  card.title = "点击跳到被引用的那一条";
  card.addEventListener("click", (ev) => {
    // 卡片在气泡里，不能让这一击再冒泡去干别的（文字气泡将来可能挂双击复制）
    if (ev.stopPropagation) ev.stopPropagation();
    jumpToQuoted(q.id);
  });
  return card;
}

/* --------------------------------------------------------------------------
 * 转发到别的会话
 *
 * 零新后端命令：文字走 send_text（不带 quote —— 转发的是一条全新 id 的新消息，
 * 原会话那条撤回/删除互不影响），文件走 send_paths 拿的就是本机那份。
 * 离线对端照旧自动入队，不用先切会话再发。
 * ------------------------------------------------------------------------ */
function openFwdPick(t) {
  state.fwd = t;
  renderFwdList();
  if (ui.fwdPick) ui.fwdPick.hidden = false;
}

function closeFwdPick() {
  if (ui.fwdPick) ui.fwdPick.hidden = true;
  state.fwd = null;
  if (ui.fwdList) ui.fwdList.textContent = "";
}

/** 列其它所有会话（排除这一条所在的那个 —— 转发给自己没有意义），
 *  一行就报「名字 · 最后一条时间」，与会话栏那一行同样的信息量 */
function renderFwdList() {
  if (!ui.fwdList) return;
  ui.fwdList.textContent = "";
  for (const s of state.sessionList) {
    if (s.id === state.cur) continue;
    const b = document.createElement("button");
    b.textContent = `${s.name || peerName(s.peer)} · ${railTime(s.last) || "还没有消息"}`;
    b.addEventListener("click", () => doForward(s));
    ui.fwdList.appendChild(b);
  }
  if (!ui.fwdList.children.length) {
    const b = document.createElement("button");
    b.disabled = true;
    b.textContent = "还没有别的会话：先从顶上「＋ 新聊天」开一个";
    ui.fwdList.appendChild(b);
  }
}

async function doForward(s) {
  const t = state.fwd;
  closeFwdPick();
  if (!t) return;
  try {
    let res;
    if (t.hasFile && t.path) {
      res = await invoke("send_paths", { paths: [t.path], to: s.id });
    } else {
      res = await invoke("send_text", { text: String(t.m.text || ""), to: s.id });
    }
    const queued = (Array.isArray(res) ? res : [res]).some((x) => x && x.state === "queued");
    const label = s.name || peerName(s.peer);
    toast(queued ? `已转发到「${label}」：对方离线，排队等上线补发` : `已转发到「${label}」`);
  } catch (err) {
    console.error("[xfer] 转发失败:", err);
    toast(errText(err) || "转发失败", "error");
  }
}

if (ui.fwdCancel) ui.fwdCancel.addEventListener("click", closeFwdPick);

/* --------------------------------------------------------------------------
 * 跨会话全局搜索（⌘F）
 *
 * 与会话内那条小搜索框并存、语义不变：那一边只筛已铺出来的气泡，这一边
 * 走后端 search_messages 查整份历史（已挡 hidden，撤回/删掉的天然不露）。
 * 点一条：openSession 切过去，目标没铺出来就逐页 loadOlder 直到出现
 *（封顶 60 页与会话内拉齐同口径），再滚到中间闪一下。
 * ------------------------------------------------------------------------ */
function openFind() {
  if (!ui.findPick) return;
  closeFwdPick();
  ui.findPick.hidden = false;
  if (ui.findQ) {
    ui.findQ.focus();
    if (ui.findQ.value) runFind(); // 上回搜过的词还在：重新弹出来就该重新给结果
  }
}

function closeFind() {
  if (ui.findPick) ui.findPick.hidden = true;
}

/** 逐字符全量重读一份 JSONL 不便宜，轻防抖一下；Enter 不等 */
let findTimer = 0;

async function runFind() {
  if (!ui.findList) return;
  const q = String(ui.findQ?.value || "").trim();
  if (!q) {
    ui.findList.textContent = "";
    return;
  }
  const kind = ui.findPick.dataset.kind || "all";
  let list = [];
  try {
    list = (await invoke("search_messages", { query: q, kind })) || [];
  } catch (err) {
    console.error("[xfer] 全局搜索失败:", err);
    ui.findList.textContent = "";
    const b = document.createElement("div");
    b.className = "find-empty";
    b.textContent = "搜不了：" + (errText(err) || "后端没应答");
    ui.findList.appendChild(b);
    return;
  }
  // 重画前用户又改了词：这一份已经过时，丢给下一次 debounce 的调用
  if (String(ui.findQ?.value || "").trim() !== q) return;
  renderFindHits(list, q);
}

/** 一行：会话名 · 时间 · 摘录；命中够不到两千条才补一句封顶提示 */
function renderFindHits(list, q) {
  const box = ui.findList;
  if (!box) return;
  box.textContent = "";
  if (!list.length) {
    const b = document.createElement("div");
    b.className = "find-empty";
    b.textContent = "哪个会话里都没找到「" + q + "」";
    box.appendChild(b);
    return;
  }
  for (const h of list) {
    const b = document.createElement("button");
    b.className = "find-row";
    b.innerHTML =
      `<span class="find-sess">${escapeHtml(h.session || "未标记")}</span>` +
      `<span class="find-time">${railTime(h.ts)}</span>` +
      `<span class="find-snip">${escapeHtml(h.snippet || h.name || "")}</span>`;
    b.title = "跳到这个会话并定位到那一条";
    b.addEventListener("click", () => gotoHit(h));
    box.appendChild(b);
  }
  if (list.length >= 200) {
    const b = document.createElement("div");
    b.className = "find-empty";
    b.textContent = "先列最近这 200 条：关键词再具体一点";
    box.appendChild(b);
  }
}

/** 点一条：切过去 → 没铺出来就逐页补 → 滚到中间闪一下 */
async function gotoHit(h) {
  closeFind();
  if (!h || !h.id) return;
  await openSession(h.sid);
  const s = cur();
  let guard = 0;
  while (!s.bubbles.has(h.id) && s.hasMore && guard++ < 60) await loadOlder();
  const node = s.bubbles.get(h.id) && s.bubbles.get(h.id).el;
  if (!node) {
    // 只剩「封顶翻完还没见到」这一种：说人话，不静悄悄
    toast("原文还没加载出来");
    return;
  }
  if (node.scrollIntoView) node.scrollIntoView({ block: "center" });
  flashNode(node);
}

if (ui.findBtn) ui.findBtn.addEventListener("click", openFind);
if (ui.findX) ui.findX.addEventListener("click", closeFind);
if (ui.findQ) {
  ui.findQ.addEventListener("input", () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(runFind, 250);
  });
  ui.findQ.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      clearTimeout(findTimer);
      runFind();
    }
  });
}
// 类型 chip 单选：这份的档位是后端 kind（text/image/file/folder），
// 与会话内那组（前端按名字归类）不共用数据源，各自各的
if (ui.findChips) {
  ui.findChips.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".chip");
    if (!btn || !ui.findChips.contains(btn)) return;
    ui.findPick.dataset.kind = btn.dataset.kind || "all";
    for (const b of ui.findChips.querySelectorAll(".chip")) b.classList.toggle("is-on", b === btn);
    runFind();
  });
}

/* --------------------------------------------------------------------------
 * 放大层的右键菜单
 *
 * 五项全走已有命令，有本机路径就全露（放大层里本来就是图，没有按类型显隐的必要）。
 * 没路径不拦：剪贴板粘进来的纯位图没有文件可存可拷，系统的「拷贝图像」比一排灰项有用。
 * ------------------------------------------------------------------------ */
/** 收菜单的那一下 click 会落到背景上，不能连带把整层关了：这个标记只吃一次 */
let lbKeepLayerOnce = false;

function closeLbMenu(fromOutside = false) {
  if (!ui.lbMenu || ui.lbMenu.hidden) return;
  ui.lbMenu.hidden = true;
  if (fromOutside) lbKeepLayerOnce = true;
}

function openLbMenu(ev) {
  if (!ui.lbMenu || !lightboxPath) return;
  if (ev.preventDefault) ev.preventDefault();
  if (ev.stopPropagation) ev.stopPropagation();
  if (!ui.lbMenu.hidden) closeLbMenu();
  placeMenuAt(ui.lbMenu, ev);
}

async function runLbMenu(act) {
  const p = lightboxPath;
  closeLbMenu();
  if (!p) return;
  try {
    if (act === "copy-img") {
      await copyPathAsFile([p]);
    } else if (act === "save") {
      const saved = await invoke("save_path_as", { src: p });
      // null = 选文件框里按了取消：这不是失败，不用弹提示
      if (saved) toast(`已保存到 ${saved}`);
    } else if (act === "copy-path") {
      await copyText(p);
    } else if (act === "reveal") {
      await invoke("reveal_in_folder", { path: p });
    } else if (act === "compare") {
      // 带着这一层切去对比视图会把 overlay 盖在另一个视图上：先关层
      closeLightbox();
      openInCompare([p]);
    }
  } catch (err) {
    console.error("[xfer] 放大层菜单操作失败:", act, err);
    toast(errText(err) || "操作失败", "error");
  }
}

for (const [node, act] of [
  [ui.lbCopyImg, "copy-img"],
  [ui.lbSave, "save"],
  [ui.lbCopyPath, "copy-path"],
  [ui.lbReveal, "reveal"],
  [ui.lbCompare, "compare"],
]) {
  if (node) node.addEventListener("click", () => runLbMenu(act));
}

/** 置顶 / 取消置顶：后端只改标记 + 存盘，顺序与底色都靠返回的那份 payload 重画 */
async function pinSession(s) {
  const pinned = !s.pinned;
  try {
    applySessions(await invoke("session_pin", { id: s.id, pinned }));
    toast(pinned ? "已置顶：会一直排在列表最上面" : "已取消置顶，回到按最后一条消息时间排的位置");
  } catch (err) {
    toast(errText(err) || "置顶失败", "error");
  }
}

if (ui.chatPin) {
  ui.chatPin.addEventListener("click", () => {
    const s = railMenu.s;
    closeChatMenu();
    if (s) pinSession(s);
  });
}
if (ui.chatRename) {
  ui.chatRename.addEventListener("click", () => {
    const s = railMenu.s;
    const row = railMenu.row;
    closeChatMenu();
    // 行还挂在 DOM 上才能就地换成输入框（列表刚重画过就不硬塞了）
    if (s && row && row.isConnected) startRename(s, row);
  });
}
if (ui.chatClear) {
  ui.chatClear.addEventListener("click", () => {
    const s = railMenu.s;
    if (!s) return;
    // 与「删除聊天」同款两步：右键一下手滑不该把一整格记录抹掉
    if (!railMenu.clearArmed) {
      railMenu.clearArmed = true;
      ui.chatClear.textContent = "再点一次清空";
      clearTimeout(railClearTimer);
      railClearTimer = setTimeout(() => {
        railMenu.clearArmed = false;
        if (ui.chatClear) ui.chatClear.textContent = CHAT_CLEAR_LABEL;
      }, 4000);
      return;
    }
    closeChatMenu();
    clearSession(s);
  });
}
if (ui.chatDel) {
  ui.chatDel.addEventListener("click", () => {
    const s = railMenu.s;
    if (!s) return;
    // 跟行内那枚一样要两步：右键一下手滑不该就把对话框删了
    if (!railMenu.armed) {
      railMenu.armed = true;
      ui.chatDel.textContent = "再点一次删除";
      clearTimeout(railArmTimer);
      // 超时退回时得退回「这一行自己的文案」：未标记那一行本来就不叫「删除聊天」
      const back = delLabel(s);
      railArmTimer = setTimeout(() => {
        railMenu.armed = false;
        if (ui.chatDel) ui.chatDel.textContent = back;
      }, 4000);
      return;
    }
    closeChatMenu();
    removeOne(s);
  });
}
// 点菜单以外就收起（系统菜单就是这个手感）；菜单里自己的点击不算「外面」。
// 用 pointerdown 而不是 click：按住拖出菜单外再松手，菜单也不会留到下一轮。
// 右键也会先过这里 —— 关掉旧菜单后紧接着的 contextmenu 会在新目标上再开一个
window.addEventListener("pointerdown", (ev) => {
  const t = ev.target;
  if (ui.chatMenu && !ui.chatMenu.hidden && !(t && ui.chatMenu.contains && ui.chatMenu.contains(t))) {
    closeChatMenu();
  }
  if (ui.msgMenu && !ui.msgMenu.hidden && !(t && ui.msgMenu.contains && ui.msgMenu.contains(t))) {
    closeMsgMenu();
  }
  if (ui.lbMenu && !ui.lbMenu.hidden && !(t && ui.lbMenu.contains && ui.lbMenu.contains(t))) {
    closeLbMenu(true);
  }
  if (ui.fwdPick && !ui.fwdPick.hidden && !(t && ui.fwdPick.contains && ui.fwdPick.contains(t))) {
    closeFwdPick();
  }
  // 搜索浮层里点外面也收（输入框里持着焦点时 Esc 那条不会走，得给这一击兼着）
  if (ui.findPick && !ui.findPick.hidden && !(t && ui.findPick.contains && ui.findPick.contains(t))) {
    closeFind();
  }
});
const closeAllMenus = () => {
  closeChatMenu();
  closeMsgMenu();
  closeLbMenu();
  closeFwdPick();
  closeFind();
};
window.addEventListener("wheel", closeAllMenus, { passive: true });
window.addEventListener("resize", closeAllMenus);
window.addEventListener("blur", closeAllMenus);
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeAllMenus();
});

function renderSessionRail() {
  if (!ui.sessionRows) return;
  // 按钮上那个总数与这些行同时从 state.sessionList 算出来：
  // 只在这里刷新，本地加未读（bumpRail）那条路才不会漏掉角标
  renderNavBadge(state.sessionList);
  const sig = JSON.stringify([
    state.cur,
    // bound 也得进签名：同一行从「没添加」变成「已添加」时名字那档颜色要跟着变
    // pinned 同理：置顶/取消置顶要重画（底色与位置都在这一份里）
    state.sessionList.map((s) => [s.id, s.peer, s.name, s.bound, s.pinned, s.online, s.unread, s.last, s.summary]),
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
  row.className =
    "session-row" +
    (s.id === state.cur ? " is-active" : "") +
    (s.bound ? "" : " is-unbound") +
    // 置顶行底色深一档（微信那种），排序在后端：这一行永远在最前
    (s.pinned ? " is-pinned" : "");
  // 带上会话 ID：名字会重名也会改，同一台还能有好几个框，行归属只认这个
  row.dataset.id = s.id;
  row.dataset.peer = s.peer;
  row.title = unmarked
    ? "老历史里没记对端的那些消息，只用来查看；右键或行内那枚都能把这一行删掉"
    : s.bound
      ? `${s.host}:${s.port}`
      : "这台还没添加，只能查看历史";
  const dot = unmarked ? "dot-warn" : s.online ? "dot-on" : "dot-off";
  // 名字独占第一行，时间与预览共用第二行：会话栏只 214px，时间跟名字挤在同一行时
  // 实测名字只剩 3~4 个汉字（拿 headless Chrome 量的），而「什么时候最后说的」远没名字重要
  row.innerHTML = `<span class="dot ${dot}"></span>
    <div class="s-main">
      <div class="s-top"><b>${escapeHtml(s.name)}</b></div>
      <div class="s-sub"><span class="s-prev">${escapeHtml(s.summary || "还没有消息")}</span><span class="s-time">${railTime(s.last)}</span></div>
    </div>`;
  if (!unmarked && s.unread > 0) {
    const b = document.createElement("span");
    b.className = "s-badge";
    b.textContent = s.unread > 99 ? "99+" : String(s.unread);
    row.appendChild(b);
  }
  // 行上只放「改名」与「删除」两个：会话栏只有 214px，按钮一多名字就被挤没；
  // 再开一个框走「＋ 新聊天」里点那台，解绑走「配对设置」的「解绑当前对端」。
  // 「未标记」没有名字可改（它就是一个筐），但删除必须给 —— 以前这一行一个按钮都不给，
  // 用户看到的就是「删也删不了」（Win 那台报的就是这条）
  const acts = document.createElement("div");
  acts.className = "s-acts";
  if (!unmarked) {
    acts.appendChild(railBtn("改名", () => startRename(s, row), true, "只改本机看到的这个名字，不会传给对端"));
  }
  acts.appendChild(
    railBtn(
      "删除",
      (btn) => armRailDelete(btn, s),
      true,
      unmarked
        ? "把这些没记对端的老消息从列表里拿掉（要点两下确认），消息文件本身不动"
        : "只删这个对话框（要点两下确认），聊天历史与收件箱文件都不动"
    )
  );
  row.appendChild(acts);
  row.addEventListener("click", () => openSession(s.id));
  // 右键换成自己的中文菜单（系统那套是 Reload / Inspect Element）。
  // 「未标记」也能删：菜单里只留删除一项，置顶与改名对它没有意义
  row.addEventListener("contextmenu", (ev) => openChatMenu(ev, s, row));
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
  // 「未标记」不在会话表里，后端记进 hidden 就够：消息文件本身一行不动
  const unmarked = s.peer === UNMARKED;
  try {
    applySessions(await invoke("session_delete", { id: s.id }));
    toast(
      unmarked
        ? "已删掉「未标记」这一行：消息文件还在，只是不再显示"
        : "已删除会话，聊天记录与收到的文件都还在"
    );
  } catch (err) {
    toast(errText(err), "error");
    return;
  }
  // 删的是正在聊的那个框：流的 DOM 与游标都得换成另一个会话的，不然屏幕上还是旧内容
  streams.delete(s.id);
  if (wasCur) await loadHistory();
}

/* --------------------------------------------------------------------------
 * 清空聊天记录（会话菜单那枚两步确认的落点）
 *
 * 与「删除聊天」的区别：框还在、设备还在、对端那份与收件箱里的文件都不动，
 * 只是这一台不再显示（后端逐条补写 hidden，口径与单条本机删除一致）。
 * 会话栏的摘要与未读靠后端 emit_sessions 推回来，这里只管重铺当前这一格。
 * ------------------------------------------------------------------------ */
async function clearSession(s) {
  try {
    const res = await invoke("session_clear", { id: s.id });
    const n = Number(res?.cleared) || 0;
    toast(n ? `已清空 ${n} 条聊天记录：对方那份与收到的文件都没动` : "这个会话本来就没有消息");
  } catch (err) {
    console.error("[xfer] 清空失败:", err);
    toast(errText(err) || "清空失败", "error");
    return;
  }
  if (s.id === state.cur) {
    // 重铺：msg_history 已挡 hidden，拉回来的是空的
    await loadHistory();
    // loadHistory 给全新会话写的是「还没有消息」；清空过的说准一点 ——
    // 消息还在盘上，只是这一台不再显示（与 toast 同一口径）
    if (!cur().bubbles.size && !s.hasMore) {
      ui.stream.innerHTML = `<div class="stream-empty">聊天记录已清空：对方那份与收到的文件都还在。</div>`;
    }
  }
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

  // 引用卡片住在正文上面（文字/文件气泡都一样）；被撤回的那条随后会被
  // paintRecalled 连卡片一起拆掉，这里不用特判
  if (m.quote && m.quote.id) bubble.appendChild(quoteCard(m.quote));

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

  // 整条气泡都拦右键（文字 / 文件 / 图片都拦）：不拦就是 WebView 那套英文菜单，
  // 而撤回与本机删除两个入口也住在里面。挂在 wrap 而不是 bubble 上：
  // 名字、大小、进度条、预览位都是这一条的一部分，点哪里都该是同一个菜单
  wrap.addEventListener("contextmenu", (ev) => openMsgMenu(ev, rec));

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
    // 刚入队的那一条还没开始传，进度条只能是一路 0%，看着像卡住了：先藏起来
    bar.appendChild(fill);
    bar.hidden = m.state === "queued";
    bubble.appendChild(bar);
    rec.bar = fill;
    rec.barBox = bar;

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
/** 当前那张图的 data URL：田字平铺拿它当 background-image（与单张同一份数据，不二次读盘） */
let lightboxSrc = null;

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
  img.title = "点击放大（滚轮缩放、拖拽平移）";
  rec.thumbBox.appendChild(img);
  rec.thumbBox.addEventListener("click", () => openLightbox(dataUrl, rec.name, rec.path));
}

function openLightbox(dataUrl, name, p) {
  lightboxPath = p || null;
  lightboxSrc = dataUrl || null;
  // 放大看过就算真看过：记一条查看历史（带绝对路径才记，聊天气泡里那张没落盘的没得记）。
  // 只落盘不重排：侧栏在对比视图里，这会儿看不见；不 await，不能卡住放大这一下
  if (lightboxPath) noteViewSeen(lightboxPath);
  ui.lightboxImg.src = dataUrl;
  ui.lightboxImg.alt = name || "";
  ui.lightboxCap.textContent = [name, p].filter(Boolean).join(" · ");
  ui.lightbox.hidden = false;
  // 每次打开都从「适应窗口」开始，不拿上一张的倍率去套这一张
  lbMeasure();
  lbReset();
  lb.touched = false;
}

function closeLightbox() {
  lightboxPath = null;
  // 层都关了，菜单不能留在屏上指着空气
  closeLbMenu();
  if (ui.lightbox.hidden) return;
  ui.lightbox.hidden = true;
  // 去掉 src 让 webview 立刻释放解码后的大图内存
  ui.lightboxImg.removeAttribute("src");
  // 关层把倍数、变换与平铺一起清掉：图还挂在 DOM 上，留着旧 transform 会让下次打开时
  // 新图解码完成前的那一瞬按上一张的倍率撑开
  lb.zoom = lb.fit = 1;
  lb.x = lb.y = 0;
  lb.drag = null;
  lb.moved = false;
  lb.touched = false;
  lb.tiled = false;
  if (ui.lightboxImg.style) ui.lightboxImg.style.transform = "";
  if (ui.lightboxTileStage && ui.lightboxTileStage.style) {
    // 背图不抹掉就是一份 base64 一直挂在内存里（与去掉 img.src 同一个道理）
    ui.lightboxTileStage.style.backgroundImage = "none";
    lb.bgSrc = null;
  }
  if (ui.lightbox.classList) {
    ui.lightbox.classList.remove("is-zoomable", "is-dragging", "is-tiled");
  }
}

/* ---------- 放大层的缩放 ----------
   口径跟对比视图那套一致：存的 zoom = 渲染宽 / 原始宽，1 = 100% = 原始像素，25%~800%，
   步长、滚轮因子、锚点公式都与 view-compare.js 一致（学一次两边通用）。 */
const LB_MIN = 0.25;
const LB_MAX = 8;
const LB_STEP_IN = 1.25;
const LB_STEP_OUT = 0.8;
// 与对比视图的滚轮因子同值
const LB_WHEEL_K = 0.0018;
// 拖拽超过这几个像素才算「在平移」，否则仍当点击处理（背着一张图点背景是关层，不是拖动）
const LB_DRAG_SLOP = 3;
// 键盘平移一步
const LB_PAN_KEY = 40;
// 图被拖出去时至少留在屏幕里的部分，不然一路拖会拖到全黑找不到北
const LB_KEEP = 60;

const clampLb = (v) => Math.min(LB_MAX, Math.max(LB_MIN, v));

/** zoom = 渲染/原始；fit = 被 CSS 装进屏幕那一档对应的 zoom（图比屏幕小就是 1，
 *  CSS 不会把图放大）；box = 打开那一刻量到的**未变换**布局盒，变换不改布局，
 *  所以整层开着期间都拿它当基准（窗口变宽了会重新量，见 resize） */
const lb = { zoom: 1, fit: 1, x: 0, y: 0, natural: 0, box: { left: 0, top: 0, w: 0, h: 0 }, drag: null, moved: false, touched: false, tiled: false, bgSrc: null };

/** CSS 已经把图装进屏幕了，transform 只负责在它之上再放大多少 */
const lbScale = () => lb.zoom / (lb.fit || 1);

function lbMeasure() {
  const r = ui.lightboxImg.getBoundingClientRect();
  lb.natural = ui.lightboxImg.naturalWidth || 0;
  lb.box = { left: r.left || 0, top: r.top || 0, w: r.width || 0, h: r.height || 0 };
  lb.fit = lb.natural > 0 && lb.box.w > 0 ? lb.box.w / lb.natural : 1;
}

function lbReset() {
  lb.zoom = lb.fit;
  lb.x = 0;
  lb.y = 0;
  lb.drag = null;
  lbRender();
}

/** 平移量收拢：让图中心至少落在视口内 LB_KEEP 的位置上。
 *  平铺模式下不收：图案本来就铺满了整屏，拖不到全黑；而拿单张那个盒的中心去卡
 *  一个周期图案，只会把「拖到隔壁那条缝」错拦下来 */
function lbClamp() {
  if (lb.tiled) return;
  const s = lbScale();
  const w = lb.box.w * s;
  const h = lb.box.h * s;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  if (!vw || !vh) return;
  const cx = lb.box.left + lb.x + w / 2;
  const cy = lb.box.top + lb.y + h / 2;
  const nx = Math.min(vw - LB_KEEP, Math.max(LB_KEEP, cx));
  const ny = Math.min(vh - LB_KEEP, Math.max(LB_KEEP, cy));
  lb.x += nx - cx;
  lb.y += ny - cy;
}

function lbRender() {
  const s = lbScale();
  lbClamp();
  if (ui.lightboxImg.style) {
    ui.lightboxImg.style.transform =
      s === 1 && lb.x === 0 && lb.y === 0 ? "" : `translate(${lb.x}px, ${lb.y}px) scale(${s})`;
  }
  if (ui.lightboxZoom) ui.lightboxZoom.textContent = `${Math.round(lb.zoom * 100)}%`;
  // 只比适应窗口大才有东西可平移；适应状态下拖图是无意义的抢鼠标
  const draggable = s > 1.001;
  if (ui.lightbox && ui.lightbox.classList) {
    ui.lightbox.classList.toggle("is-zoomable", draggable);
    ui.lightbox.classList.toggle("is-tiled", lb.tiled);
    if (!draggable) ui.lightbox.classList.remove("is-dragging");
  }
  if (lb.tiled) lbRenderTiles(s);
}

/** 田字平铺：格子尺寸 = 单张在当前倍率下的渲染尺寸，把「某个格子的左上角」
 *  （也就是四份的十字交点）钉在单张图的中心 + 平移量上 —— 于是十字落在屏幕正中，
 *  四份围绕它拼。与单张共用同一套 zoom/x/y，所以切换不跳视野 */
function lbRenderTiles(s) {
  const st = ui.lightboxTileStage;
  if (!st || !st.style) return;
  // background-image 只在换图时写一次：那串 base64 可以很大，每一帧重拼字符串会卡
  if (lb.bgSrc !== lightboxSrc) {
    lb.bgSrc = lightboxSrc || null;
    st.style.backgroundImage = lightboxSrc ? `url("${lightboxSrc}")` : "none";
  }
  const tw = Math.max(1, lb.box.w * s);
  const th = Math.max(1, lb.box.h * s);
  st.style.backgroundSize = `${tw}px ${th}px`;
  st.style.backgroundPosition = `${lb.box.left + lb.box.w / 2 + lb.x}px ${lb.box.top + lb.box.h / 2 + lb.y}px`;
}

/** 田字开关：倍率与平移量原样带过去，单张与平铺是同一套状态的两种画法 */
function lbSetTiled(on) {
  lb.tiled = on === undefined ? !lb.tiled : !!on;
  lbRender();
}

/** 当前这张渲染后图的中心，换算成「相对未变换盒左上」的锚点（按钮与键盘走这里，
 *  所以图是围着自己的中心长回去，不会跳到屏幕中间） */
function lbCenter() {
  const s = lbScale();
  return { x: lb.x + (lb.box.w * s) / 2, y: lb.y + (lb.box.h * s) / 2 };
}

/** 锚点缩放：保住 anchor 处的图像内容不动。anchor 是相对未变换布局盒左上的坐标，
 *  算法与 view-compare.js 的 applyZoom 同一套（scale 与 zoom 只差一个常数，比例可直代） */
function lbZoomAt(target, anchor) {
  const z = clampLb(target);
  const k = z / lb.zoom;
  if (k === 1) return;
  lb.touched = true;
  lb.x = anchor.x - (anchor.x - lb.x) * k;
  lb.y = anchor.y - (anchor.y - lb.y) * k;
  lb.zoom = z;
  lbRender();
}

function lbStep(factor) {
  lbZoomAt(lb.zoom * factor, lbCenter());
}

/** 鼠标点 → 锚点坐标（减掉打开时量到的盒左上） */
function lbAnchor(ev) {
  return { x: (ev.clientX || 0) - lb.box.left, y: (ev.clientY || 0) - lb.box.top };
}

/** 「适应」与「1:1」：前者连平移量一起清掉，后者以当前中心为锚 */
function lbToFit() {
  lb.touched = true;
  lbReset();
}

function lbToOne() {
  lb.touched = true;
  lbZoomAt(1, lbCenter());
}

/** 双击：在「适应」与「原始像素」之间切，以点击处为锚 */
function lbToggleDbl(ev) {
  lb.touched = true;
  if (lb.zoom > lb.fit * 1.001) {
    lbToFit();
  } else {
    lbZoomAt(1, lbAnchor(ev));
  }
}

function lbPan(dx, dy) {
  lb.touched = true;
  lb.x += dx;
  lb.y += dy;
  lbRender();
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
  // 撤回的那条不再报投递状态：那几个字段讲的是「有没有送到」，而它已经从两边撤下来了
  const stateText = m.recalled
    ? " · 已撤回"
    : rec.state === "sending"
      ? " · 传输中"
      : rec.state === "failed"
        ? " · 失败"
        : rec.state === "queued"
          ? " · 待发"
          : "";
  rec.meta.textContent = `${who} · ${fmtTime(m.ts)}${stateText}`;
  const off = !!m.recalled;
  rec.el.classList.toggle("is-failed", !off && rec.state === "failed");
  rec.el.classList.toggle("is-sending", !off && rec.state === "sending");
  rec.el.classList.toggle("is-queued", !off && rec.state === "queued");
  // 进度条只在真在传的时候才有意义：排队那几天它只能停在 0%，
  // 补发一开始（状态转 sending）就把它放回来
  if (rec.barBox) rec.barBox.hidden = rec.state === "queued" || off;
  // 排队与失败都得看得出「为什么还没出去、已经白试了几次」，
  // 否则用户只看到一颗待发点，不知道是该等还是该重发
  const why = m.reason ? `（第 ${m.retry || 1} 次尝试失败：${m.reason}）` : "";
  rec.el.title = m.recalled
    ? RECALL_TEXT[m.dir === "in" ? "in" : "out"]
    : rec.state === "queued"
      ? `对方离线，已排队；它上线后会自动补发${why}`
      : rec.state === "failed"
        ? `补发失败，已停手${why}；可以重新发送`
        : "";
}

/* --------------------------------------------------------------------------
 * 撤回与本机删除
 *
 * 两件事只差在「问不问对方」：撤回限在发送方一分钟以内、且真去通知对端，两边
 * 都不再显示正文；删除只是本机不再显示它，对端那份与收件箱里的文件一概不动。
 * 硬判据（谁能撤、什么时候过期）写在 Rust 的 store::recall_check 里，下面那一档
 * 只决定入口露不露 —— 气泡不会自己按时重画，真过期了那一刀还得那边拦。
 * ------------------------------------------------------------------------ */

/** 这一条还给不给撤回入口：本机发出的、没撤过、还在一分钟内，
 *  而且这一轮没被后端判过（点了被拒多半就是时间窗过了，别再让人反复点） */
function recallable(rec, m) {
  return (
    !!m &&
    m.dir === "out" &&
    !m.recalled &&
    !rec.noRecall &&
    Date.now() - (m.ts || 0) < RECALL_MS
  );
}

/** 把这一条换成一句「撤回了一条消息」：正文、预览、文件操作全拆下来。
 *  只改显示 —— 已经落进收件箱的那个文件不跟着删（它可能早被人打开过了） */
function paintRecalled(rec) {
  if (rec.recalledPainted) return;
  rec.recalledPainted = true;
  const m = rec.msg || {};
  // 底色与边框跟着正文一起退场（那一层蓝/灰是给「有内容」用的）
  rec.el.classList.add("is-recalled");
  rec.bubble.textContent = "";
  const line = document.createElement("div");
  line.className = "msg-recalled";
  line.textContent = RECALL_TEXT[m.dir === "in" ? "in" : "out"];
  rec.bubble.appendChild(line);
  if (rec.actsBox) rec.actsBox.textContent = "";
  if (rec.thumbBox) rec.thumbBox.hidden = true;
}

/** 撤回这一条：成功就走一遍重画，两边都换成一句提示 */
async function recallMessage(rec) {
  const id = rec?.msg?.id;
  if (!id) return;
  try {
    const done = await invoke("msg_recall", { id });
    // 不等事件再画：点了该当场看见结果（msg-updated 推回来的也是这一条，重画一次不冲突）
    if (done && done.id) {
      upsertMessage(done);
      reconcileDividers();
    }
    await loadSessions();
    toast("已撤回：对方那边也不再显示正文");
  } catch (err) {
    console.error("[xfer] 撤回失败:", err);
    toast(errText(err), "error");
    // 被拦下来就记住这一轮别再给撤回入口（那一分钟已经过了，或者这台已经不认
    // 对方了）—— 菜单每次摊开都重算，不记的话用户还会反复点
    rec.noRecall = true;
  }
}

/** 本机删除：成功后才把气泡拿掉，失败就原样留着 —— 不能让用户以为删了而它还在。
 *  历史文件里那一行仍然留着，只是读的时候被 hidden 挡掉，所以重启也不会它又冒出来 */
async function deleteMessage(rec) {
  const id = rec?.msg?.id;
  if (!id) return;
  try {
    await invoke("msg_delete", { id });
  } catch (err) {
    console.error("[xfer] 删除失败:", err);
    toast(errText(err), "error");
    return;
  }
  const s = cur();
  s.bubbles.delete(id);
  rec.el.remove();
  if (s.oldestId === id) {
    // 翻页锚点不能指着一条已经不显示的消息：后端把失效游标当成「从头给最新一页」，
    // 「加载更早」会原地打转
    s.oldestId = ui.stream.querySelector(".msg")?.dataset?.id || null;
  }
  if (!s.bubbles.size) {
    // 删空了这一页但更早还有：得让后端再给一页，否则会话栏里那个框就翻不回去了
    //（一条气泡都没有时「加载更早」那根栏是收起来的）
    if (s.hasMore) {
      await loadHistory();
      return;
    }
    ui.stream.innerHTML = `<div class="stream-empty">这个对话框里的消息都被删掉了。</div>`;
  }
  renderOlderBar();
  reconcileDividers();
  applyFilter();
  // 会话栏那句摘要很可能就是刚删掉的这一条，未读数也可能跟着变了
  await loadSessions();
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
  if (rec.msg.recalled) {
    // 撤回之后：正文与预览都不该再露出来，后面的进度/路径补全一律不走了
    paintRecalled(rec);
  } else {
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
  // 撤回的那条不再露正文（与 Rust 那份同口径，两边都得是同一句话）
  if (m.recalled) return RECALL_SUMMARY;
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
  // 撤回的那条不参加搜索：正文已经看不见了，命中它就是搜一个不存在的内容。
  // 但没在筛的时候它仍要露着那句「撤回了一条消息」，所以判据盯的是筛着的时候
  if (m.recalled) return !filterActive();
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
 * 待发送区：选好/拖进来的东西先摆着，点发送才真发（微信那套）
 * ------------------------------------------------------------------------ */

/** 一次最多摆多少个：摆太多横向铺到看不完，也顺手挡住误拖一整个大目录 */
const ATTACH_LIMIT = 50;

function baseName(p) {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || "");
}

/** 扩展名方块上那两三个字母：没有后缀就给 FILE，不留空 */
function extLabel(name, isDir) {
  if (isDir) return "DIR";
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
  return m ? m[1].toUpperCase() : "FILE";
}

function fallbackBox(text) {
  const fb = document.createElement("span");
  fb.className = "attach-fallback";
  fb.textContent = text;
  return fb;
}

/** 选完/拖完/粘完只入列，不发网络。名字与大小问 Rust（前端分不出文件夹，也拿不到大小）
 *  opts.allowNoSession：还没选会话也让进（对比视图投递过来的那张图） */
async function addAttach(paths, opts = {}) {
  const incoming = (paths || []).filter(Boolean);
  if (!incoming.length) return;
  // 拖拽/粘贴默认要有个明确的收件框；投递进来的那张例外，先摆着再选人
  if (state.cur === null && !opts.allowNoSession) {
    toast("先在左边开一个会话，再往里放文件", "error");
    return;
  }
  // 同一个文件拖两次不该出现两颗；已经摆着的算命中，不再重复问后端
  const have = new Set(state.attach.map((a) => a.path));
  const fresh = incoming.filter((p) => !have.has(p));
  if (!fresh.length) {
    toast("这些已经在待发送区了", "error");
    return;
  }

  let metas = null;
  try {
    metas = await invoke("stat_paths", { paths: fresh });
  } catch (err) {
    // 问不到元信息不该拦住发送：退回只认路径，名字从路径尾巴取
    console.warn("[xfer] 取文件信息失败，待发送区只显示名字:", err);
  }
  // 命令没回数组（旧版后端 / 桩环境）也走退路：待发送区不能因为一个查询失败就空着
  if (!Array.isArray(metas)) {
    metas = fresh.map((p) => ({ path: p, name: baseName(p), size: 0, isDir: false, missing: false }));
  }

  const room = ATTACH_LIMIT - state.attach.length;
  const take = metas.slice(0, Math.max(0, room));
  for (const m of take) {
    state.attach.push({
      path: m.path,
      name: m.name || baseName(m.path),
      size: Number(m.size) || 0,
      isDir: !!m.isDir,
      missing: !!m.missing,
    });
  }
  renderAttach();

  const over = metas.length - take.length;
  if (over > 0) toast(`待发送区最多放 ${ATTACH_LIMIT} 个，多出来的 ${over} 个没放进来`, "error");
  const gone = take.filter((m) => m.missing).length;
  if (gone) toast(`有 ${gone} 个路径已经找不到了，发送前先移除`, "error");
}

function removeAttach(path) {
  state.attach = state.attach.filter((a) => a.path !== path);
  renderAttach();
}

function clearAttach() {
  state.attach = [];
  renderAttach();
}

/** 一颗待发送：图片给缩略图，其余给扩展名方块 + 名字 + 大小（都是 dom 拼，不走 innerHTML：文件名里有尖括号不能当标签） */
function attachChip(a) {
  const isImage = !a.isDir && IMAGE_EXT.test(a.name);
  const chip = document.createElement("div");
  chip.className = `attach-chip ${isImage ? "is-image" : "is-file"}` + (a.missing ? " is-missing" : "");
  chip.dataset.path = a.path;
  chip.title = a.missing ? `${a.path}\n这个路径已经找不到了` : a.path;

  if (isImage) {
    const src = a.missing ? null : assetSrc(a.path);
    if (src) {
      const img = document.createElement("img");
      img.alt = a.name;
      img.src = src;
      // asset 协议拿不到就退回扩展名方块：留一个灰窟窿比没有更让人怀疑程序坏了
      img.addEventListener(
        "error",
        () => {
          img.remove();
          chip.appendChild(fallbackBox(extLabel(a.name, false)));
        },
        { once: true }
      );
      chip.appendChild(img);
    } else {
      chip.appendChild(fallbackBox(extLabel(a.name, false)));
    }
  } else {
    const ext = document.createElement("span");
    ext.className = "attach-ext";
    ext.textContent = extLabel(a.name, a.isDir);
    chip.appendChild(ext);

    const body = document.createElement("div");
    body.className = "attach-body";
    const name = document.createElement("span");
    name.className = "attach-name";
    name.textContent = a.name;
    const size = document.createElement("span");
    size.className = "attach-size";
    size.textContent = a.missing ? "路径已不存在" : a.isDir ? "文件夹（整个发过去）" : fmtSize(a.size);
    body.appendChild(name);
    body.appendChild(size);
    chip.appendChild(body);
  }

  const x = document.createElement("button");
  x.type = "button";
  x.className = "attach-x";
  x.textContent = "×";
  x.title = "从待发送区移除（不发送）";
  // 直接绑在按钮上：挂父级委托要依赖事件冒泡，自检桩里派发不冒泡，真机上多一层也无益
  x.addEventListener("click", (ev) => {
    ev?.stopPropagation?.();
    removeAttach(a.path);
  });
  chip.appendChild(x);
  return chip;
}

function renderAttach() {
  if (!ui.attach || !ui.attachRow) return;
  const list = state.attach;
  ui.attach.hidden = !list.length;
  ui.attachRow.textContent = "";
  if (!list.length) return;

  // 这批东西不认会话：跟着当前对话框走，切到哪个框就发给哪个（用户报过“属于某某、发不出去”的黄字）
  const who = state.cur === null
    ? "还没选会话：在左边点一个，再点发送"
    : `点发送就发给「${sessName(state.cur)}」`;
  // 多会话下必须把「发给谁」写出来：不写的话切了个框还以为这批是给上一个框的
  ui.attachTitle.textContent = `待发送 ${list.length} 个 · ${who}`;
  for (const a of list) ui.attachRow.appendChild(attachChip(a));
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

/** 一次点击把待发送区的文件与输入框里的文字一起发出去。
 *  微信也是先摆着再点发送；附件先出、文字随后，两条只弹一次 toast */
async function sendComposer() {
  const text = ui.input.value.trim();
  if (!text && !state.attach.length) {
    toast("先写点内容，或选好要发送的文件", "error");
    return;
  }
  if (!requireSession()) return;

  const gone = state.attach.filter((a) => a.missing);
  if (gone.length) {
    toast(`待发送区有 ${gone.length} 个路径已经不在了，先移除再发`, "error");
    return;
  }

  const paths = state.attach.map((a) => a.path);
  let sentPaths = false;
  let sentText = false;
  let queued = false;

  const ok = await runSend(async () => {
    const out = [];
    // 先文件后文字：附件是刚选的那一批，文字落在它下面读起来才顺
    if (paths.length) {
      const res = await invoke("send_paths", { paths, to: state.cur });
      out.push(...(Array.isArray(res) ? res : [res]));
      sentPaths = true;
    }
    if (text) {
      // 引用跟着这一条文字走（发出即清）；没引用时 quote 是 null，后端当没这字段
      out.push(await invoke("send_text", { text, to: state.cur, quote: state.quote }));
      sentText = true;
    }
    queued = out.some((m) => m && m.state === "queued");
    return out;
  });

  // 成功的部分才从输入区拿掉；失败就留着，省得用户从头再选一遍
  if (sentPaths) clearAttach();
  if (sentText) {
    ui.input.value = "";
    ui.input.style.height = "";
    clearQuote();
  }
  if (ok) toast(queued ? "对方离线，已排队，上线自动发出" : "已送达");
}

/** 发送期间的统一收口：按钮禁上、错误提示、结束后按最新状态恢复。
 *  成功文案交给调用方合并（文字 + 附件是两次 invoke，各说一次会连弹两个） */
async function runSend(task) {
  clearEmptyHint();
  state.sending = true;
  ui.btnSend.disabled = true;
  try {
    const out = await task();
    // 不等 msg-updated 再画：事件比 invoke 返回值慢一拍，而用户点完发送该立刻看见自己发出去的东西。
    // 图片气泡又比文字高，追加在末尾正好落在视口外，不滚到底看着就像没发出去（用户报过这一条）
    const msgs = (Array.isArray(out) ? out : [out]).filter((m) => m && m.id);
    let shown = false;
    for (const m of msgs) shown = routeMessage(m, "send") || shown;
    // 万一会话 ID 与消息里的 sid 对不上（老数据/异路径），重铺一遍兜底，不能只发在后台
    if (msgs.length && !shown) await loadHistory();
    if (msgs.length && !filterActive()) scrollBottom();
    return true;
  } catch (err) {
    const msg = errText(err);
    console.error("[xfer] 发送失败:", err);
    toast(msg, "error");
    return false;
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

/* --------------------------------------------------------------------------
 * 本机接收：提示音与收件目录
 *
 * 这几项都存在 prefs.json，与对比视图那份是同一个文件、同一对命令（get_prefs / set_prefs）。
 * set_prefs 是局部更新：这里只传 notify / inbox，不会把用户选的布局冲掉，反之也一样。
 * 声音本身在 Rust 侧播（js 里 new Audio() 会被 WKWebView 的自动播放策略拦下，
 * 而且窗口关掉后根本没人在场），这里只负责那个开关。
 * ------------------------------------------------------------------------ */

/** 开关那颗是真 input 藏在 label 里、靠 CSS 画的，关着时从外观上看不出区别，所以文案跟着状态走 */
function paintNotifySwitch(on) {
  if (ui.notifyChk) ui.notifyChk.checked = on;
  if (ui.notifyText) ui.notifyText.textContent = on ? "响一声" : "不响";
}

function paintInboxDir(path, custom) {
  state.inboxDir = path;
  if (ui.inboxValue) ui.inboxValue.textContent = path || "读取失败";
  // 已经在默认目录上时「恢复默认」没有意义，灰掉比点了没反应好懂
  if (ui.btnInboxReset) ui.btnInboxReset.disabled = !custom;
  paintInboxSample(path, state.inboxLayout);
}

/** 三档摆放的中文名：只用在 toast 里，抽屉里的下拉自己带文案 */
const INBOX_LAYOUT_NAME = {
  day: "一天一个文件夹",
  month: "一个月一个文件夹",
  flat: "不分目录",
};

/**
 * 与 Rust 侧 `chrono::Local::format("%Y-%m" / "%Y-%m-%d")` 同一口径的本地日期串。
 * 抽屉里那行「新收到的文件落在 …」要靠它拼出一个真路径，写死示例会跟实际
 * 落点对不上（跨月那天看抽屉，示例还停在示例里那个日期）。
 */
function localDateStamp(layout) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const ym = `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
  if (layout === "month") return ym;
  if (layout === "day") return `${ym}-${p2(d.getDate())}`;
  return "";
}

function paintInboxSample(path, layout) {
  if (!ui.inboxSample) return;
  if (!path) {
    ui.inboxSample.textContent = "…";
    return;
  }
  const stamp = localDateStamp(layout);
  ui.inboxSample.textContent = stamp ? `${path}/${stamp}/` : `${path}/`;
}

function paintInboxLayout(layout) {
  // 读回一个前端不认的值时按下拉第一项（= 出厂按天）显示：界面上的选项
  // 必须与 Rust 那边实际用的规则一致，两边不一致比没得选更难查
  const v = INBOX_LAYOUT_NAME[layout] ? layout : "day";
  state.inboxLayout = v;
  if (ui.inboxLayout) ui.inboxLayout.value = v;
  paintInboxSample(state.inboxDir, v);
}

/** 抽屉每次打开都重读：另一个抽屉可能刚改过同一份 prefs.json，用户也可能手改过磁盘 */
async function refreshRecvPrefs() {
  try {
    const p = await invoke("get_prefs");
    // 老 prefs.json 里没这两项时 Rust 已按出厂态补齐，这里只兜「命令整个没回」
    if (p && typeof p.notify === "boolean") paintNotifySwitch(p.notify);
    // 心跳节拍。键名就是 heartbeat_ms：get_prefs 回的是 Rust 结构体原样序列化（下划线），
    // 只有传进去的调用参数才走 Tauri 的 camelCase，两边拿同一个名字去读会永远读不到
    if (p && typeof p.heartbeat_ms === "number") paintHeartbeat(p.heartbeat_ms);
  } catch (_) {
    /* 非 Tauri 环境（自检桩）保持 HTML 初始态 */
  }
  try {
    const d = await invoke("inbox_dir");
    if (d && d.layout) paintInboxLayout(String(d.layout));
    if (d && d.path) paintInboxDir(String(d.path), !!d.custom);
  } catch (_) {}
}

/** 存一项偏好。失败时 Rust 那句带路径的原因必须原样上屏，否则只能看到「点了没反应」 */
async function saveRecvPrefs(patch, okText) {
  try {
    await invoke("set_prefs", patch);
    if (okText) toast(okText);
    return true;
  } catch (err) {
    toast(errText(err), "error");
    return false;
  }
}

async function chooseInboxDir() {
  let picked = null;
  try {
    picked = await invoke("pick_folder", { title: "选择收件目录" });
  } catch (err) {
    toast(errText(err), "error");
    return;
  }
  // 用户在原生对话框里点了取消：什么都不该做，更不该把目录清空
  if (!picked) return;
  const ok = await saveRecvPrefs(
    { inbox: picked },
    "收件目录已改，只影响新收到的文件；旧的留在原处照样能打开",
  );
  if (ok) await refreshRecvPrefs();
}

async function resetInboxDir() {
  // 空串在 Rust 侧就是「回到 <数据目录>/inbox」，不是一个叫空的目录
  if (await saveRecvPrefs({ inbox: "" }, "收件目录已恢复默认")) await refreshRecvPrefs();
}

async function revealInboxDir() {
  if (!state.inboxDir) return;
  try {
    await invoke("reveal_in_folder", { path: state.inboxDir });
  } catch (err) {
    toast(errText(err), "error");
  }
}

/** 切换收件目录的摆放。存不下就把下拉退回原值 —— 停在一个没生效的选项上，
 * 用户下次收东西会跑到别的地方去找 */
async function chooseInboxLayout(ev) {
  const next = ev?.target?.value || "day";
  const prev = state.inboxLayout;
  if (next === prev) return;
  // 参数名按 Tauri 默认 camelCase：Rust 那边是 `inbox_layout`
  const ok = await saveRecvPrefs(
    { inboxLayout: next },
    `收件目录改成「${INBOX_LAYOUT_NAME[next] || next}」，只影响之后收到的文件`,
  );
  if (ok) paintInboxLayout(next);
  else paintInboxLayout(prev);
}

/* --------------------------------------------------------------------------
 * 存储：那几个数字与收件目录清理
 *
 * 只在抽屉打开与点「刷新」时读一次：storage_stats 在 Rust 侧是递归走一遍目录树，
 * 把它放进任何轮询里都划不来。「清理」沿用两步确认那套手感（与删会话、逐条删除
 * 一样：第一下只是把话换成「再点一次」，没人点就自己退回去）。
 * 删什么、留什么的口径全在后端：只动「改得够早，而且没被任何还看得见的消息引用」
 * 的收件文件，这里只负责把数字摆出来、把两步确认按住。
 * ------------------------------------------------------------------------ */

/** 一行一个数字：标签怎么叫、后端那几个键怎么拼成这一句 */
const STORAGE_ROWS = [
  ["收件目录", (s) => `${fmtSize(s.inbox_bytes)} · ${s.inbox_count} 个文件`],
  ["粘贴暂存", (s) => fmtSize(s.pastebox_bytes)],
  ["聊天历史", (s) => `${fmtSize(s.messages_bytes)} · ${s.messages_count} 条`],
  ["数据目录合计", (s) => fmtSize(s.data_bytes)],
];

/** 一行一行摊出来，而不是拼一大段 innerHTML：这几行是数字表，将来要按行加个
 *  「点开看目录」的入口，节点先留着比到时候再拆字符串省事 */
function renderStorage(st) {
  if (!ui.storageRows) return;
  ui.storageRows.textContent = "";
  for (const [label, fn] of STORAGE_ROWS) {
    const row = document.createElement("div");
    row.className = "storage-row";
    const k = document.createElement("span");
    k.textContent = label;
    const v = document.createElement("b");
    v.textContent = st ? fn(st) : "读取失败";
    row.appendChild(k);
    row.appendChild(v);
    ui.storageRows.appendChild(row);
  }
}

/** 命令整个没回也只把这一节写成「读取失败」，不额外弹 toast：抽屉一打开就被
 *  一句报错抢掉视线，比数字没刷出来更烦人 */
async function refreshStorage() {
  let st = null;
  try {
    st = await invoke("storage_stats");
  } catch (_) {
    st = null;
  }
  renderStorage(st);
}

/** 「清理」第一下之后的文案，四秒没人点就退回这两个字 */
const CLEAN_LABEL = "清理";
let cleanArmed = false;
let cleanTimer = 0;

function disarmClean() {
  cleanArmed = false;
  clearTimeout(cleanTimer);
  if (ui.btnInboxClean) ui.btnInboxClean.textContent = CLEAN_LABEL;
}

async function cleanInbox() {
  if (!ui.btnInboxClean) return;
  if (!cleanArmed) {
    cleanArmed = true;
    ui.btnInboxClean.textContent = "再点一次确认清理";
    cleanTimer = setTimeout(disarmClean, 4000);
    return;
  }
  // 真要用的是当前那一档，所以档位读在第二下这一刻，不是读在臂上的时候
  disarmClean();
  const months = Number(ui.inboxCleanSel?.value) || 3;
  // 一个月按 30 天算：这是个粗清理的门槛，不是日历账
  const beforeTs = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  let res = null;
  try {
    res = await invoke("inbox_cleanup", { beforeTs });
  } catch (err) {
    toast(errText(err) || "清理失败", "error");
    await refreshStorage();
    return;
  }
  const n = Number(res?.deleted_count) || 0;
  const b = Number(res?.freed_bytes) || 0;
  toast(
    n
      ? `删了 ${n} 个文件，释放 ${fmtSize(b)}：聊天里引着的一个都没动`
      : "这一档之前的收件文件都被聊天记录引着，一个都没删"
  );
  // 数字得跟着重算：后端删完也 emit 了一次，这里再拉一遍是为了「没开抽屉也能点刷新看到」
  await refreshStorage();
}

/* --------------------------------------------------------------------------
 * 在线探测：心跳节拍
 *
 * 节拍是 Rust 那边心跳线程每拍从 prefs.json 读的（不缓存），所以这里存下去
 * 下一拍就生效，不必重启；前端不自己开计时器，否则两份节拍会互相盖。
 * ------------------------------------------------------------------------ */

/** 与 store.rs 的 HEARTBEAT_OPTIONS 一份口径：多一档少一档都会让下拉与白名单对不上 */
const HEARTBEAT_NAME = {
  1000: "1 秒",
  2000: "2 秒",
  5000: "5 秒",
  10000: "10 秒",
};
/** 连续几拍探不通才算离线（client.rs 的 OFFLINE_THRESHOLD），只用来拼那句提示 */
const OFFLINE_BEATS = 3;

function paintHeartbeat(ms) {
  // 读回一个白名单外的值时按出厂那一档显示：界面上的选项必须与心跳线程真正
  // 在用的那拍一致（value 设不进去时下拉会停在空白处，那比退回默认更难查）
  const v = HEARTBEAT_NAME[ms] ? ms : 1000;
  state.heartbeatMs = v;
  if (ui.heartbeatSel) ui.heartbeatSel.value = String(v);
}

/** 切换探测间隔。存不下就把下拉退回原值：界面停在一个没生效的档位上，
 * 用户等补发、等离线标记时按的那个时长就全猜错 */
async function chooseHeartbeat(ev) {
  const next = Number(ev?.target?.value) || 1000;
  const prev = state.heartbeatMs;
  if (next === prev) return;
  // 参数名按 Tauri 默认 camelCase：Rust 那边是 `heartbeat_ms`
  const ok = await saveRecvPrefs(
    { heartbeatMs: next },
    `探测间隔改成「${HEARTBEAT_NAME[next] || next}」，判离线约要 ${((next * OFFLINE_BEATS) / 1000) | 0} 秒，下一拍就生效`,
  );
  if (ok) paintHeartbeat(next);
  else paintHeartbeat(prev);
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
ui.btnSend.addEventListener("click", sendComposer);
ui.input.addEventListener("keydown", (ev) => {
  // Enter 发送、Shift+Enter 换行；输入法组合期间不能截走 Enter
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    sendComposer();
  }
});
ui.input.addEventListener("input", () => {
  ui.input.style.height = "auto";
  ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + "px";
});

// 顶栏那两个「发送文件 / 发送文件夹」撤掉了（用户要求聊天框上面不再显示）：
// 拖进来、复制粘贴、从对比视图「发送到聊天」这三条都能往待发送区放东西，
// 选完照样只入列不发，点发送才发 —— 少两个按钮不改这套口径。
// 拖文件进窗口也只入待发送区：松手即发会让人没机会确认发的是哪个、发给谁
registerDropHandler("transfer", (paths) => addAttach(paths));

// 「全部移除」：只改本地列表，不碰网络
ui.btnAttachClear?.addEventListener("click", () => clearAttach());

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
  // 遮罩只在**未配对**时才拦：离线也已经能接了（入队等补发），拦住只会让人以为发不出去
  const bound = !!sess && sess.bound;
  const online = bound && sess.online;
  ui.dropHint.hidden = false;
  ui.dropHint.classList.toggle("is-blocked", !bound);
  ui.dropText.textContent = !state.status?.passphrase_set
    ? "先在「配对设置」里填口令"
    : !sess
      ? "先在左边选一个会话"
      : !bound
        ? `「${sess.name}」还没添加：先配对才能发给它`
        : online
          ? `松开即放入待发送：「${sess.name}」`
          : `松开即放入待发送：「${sess.name}」离线，点发送后排队等它上线补发`;
});

// 放大层：点背景/关闭按钮/Esc 都能退出，图本身可以缩放与平移，只在有该 DOM 时绑定
if (ui.lightbox && ui.lightboxClose) {
  ui.lightboxClose.addEventListener("click", closeLightbox);
  // 整层都拦右键：这是最后一处还会弹系统英文菜单的地方（没路径时 openLbMenu 自己不拦）
  ui.lightbox.addEventListener("contextmenu", openLbMenu);
  ui.lightbox.addEventListener("click", (ev) => {
    // 刚被这一下 pointerdown 收掉的菜单：落点也在背景上，这一次只收菜单，不关层
    if (lbKeepLayerOnce) {
      lbKeepLayerOnce = false;
      return;
    }
    // 拖完图那一下松手也会发 click（落在背景上就会被当成「关层」），
    // 所以这一只整体吃掉，不挑 target——否则背着一张图拖完还得再点一次才关得上
    if (lb.moved) {
      lb.moved = false;
      return;
    }
    if (ev.target === ui.lightbox) closeLightbox();
  });
  // 大图解码完 naturalWidth 才准（开着层时量到的都是 0，1:1 与百分比会跟着偏）；
  // 用户还没动过就顺势回到适应，动过了只把新量到的那一档补进渲染（倍率按原始口径不变，
  // 不抢他正在看的细节，但标签也不能继续说谎）
  ui.lightboxImg.addEventListener("load", () => {
    lbMeasure();
    if (!lb.touched) lbReset();
    else lbRender();
  });
  // 视口变了，CSS 装出来的那一档（fit）与盒位置都得重量；直接退回适应，不猜新位置
  window.addEventListener("resize", () => {
    if (ui.lightbox.hidden) return;
    lbMeasure();
    lbReset();
  });
  // 滚轮以指针为锚缩放。必须 passive:false：被动监听器里 preventDefault 会被浏览器
  // 忽略（并在控制台报告警），这一下就会漏给页面滚动
  ui.lightbox.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      lbZoomAt(lb.zoom * Math.exp(-ev.deltaY * LB_WHEEL_K), lbAnchor(ev));
    },
    { passive: false }
  );
  // 双击与拖拽两个手势在「单张」与「平铺」下语义完全一样，写一份绑到两个面上：
  // 平铺时那张图被 visibility 藏了（pointer-events 也不接），鼠标实际落在画布上
  const lbOnDbl = (ev) => lbToggleDbl(ev);
  const lbOnDown = (ev) => {
    // 只在比适应窗口大的时候接管鼠标，否则适应状态下拖图无意义还抢鼠标
    if (lbScale() <= 1.001) return;
    ev.preventDefault();
    lb.moved = false;
    lb.drag = { x: ev.clientX || 0, y: ev.clientY || 0, ox: lb.x, oy: lb.y };
  };
  ui.lightboxImg.addEventListener("dblclick", lbOnDbl);
  ui.lightboxImg.addEventListener("mousedown", lbOnDown);
  // 顺带一个后果：平铺下整屏都是画布，点空白处永远命不中 `ev.target === lightbox`，
  // 「点背景关层」自然失效，退出靠 ×、Esc 或再按一次田
  if (ui.lightboxTileStage) {
    ui.lightboxTileStage.addEventListener("dblclick", lbOnDbl);
    ui.lightboxTileStage.addEventListener("mousedown", lbOnDown);
  }
  window.addEventListener("mousemove", (ev) => {
    if (!lb.drag) return;
    const dx = (ev.clientX || 0) - lb.drag.x;
    const dy = (ev.clientY || 0) - lb.drag.y;
    if (Math.abs(dx) + Math.abs(dy) < LB_DRAG_SLOP) return;
    lb.touched = true;
    lb.moved = true;
    lb.x = lb.drag.ox + dx;
    lb.y = lb.drag.oy + dy;
    lbRender();
    if (ui.lightbox.classList) ui.lightbox.classList.add("is-dragging");
  });
  window.addEventListener("mouseup", () => {
    if (!lb.drag) return;
    lb.drag = null;
    if (ui.lightbox.classList) ui.lightbox.classList.remove("is-dragging");
  });
  if (ui.lightboxIn) ui.lightboxIn.addEventListener("click", () => lbStep(LB_STEP_IN));
  if (ui.lightboxOut) ui.lightboxOut.addEventListener("click", () => lbStep(LB_STEP_OUT));
  if (ui.lightboxFit) ui.lightboxFit.addEventListener("click", lbToFit);
  if (ui.lightboxOne) ui.lightboxOne.addEventListener("click", lbToOne);
  if (ui.lightboxTile) ui.lightboxTile.addEventListener("click", () => lbSetTiled());
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeLightbox();
    // 放大状态下 ⌘C 等于「把这张图当文件复制」，不另设按钮
    if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && (ev.key || "").toLowerCase() === "c") {
      if (ui.lightbox.hidden) return;
      ev.preventDefault();
      if (lightboxPath) copyPathAsFile(lightboxPath);
      return;
    }
    if (ui.lightbox.hidden) return;
    // 聊天输入框里打 “-”“0” 是要输字符，不是缩图；聚焦在输入控件里就让开
    const tag = ((ev.target && ev.target.tagName) || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    const k = (ev.key || "").toLowerCase();
    // + 与 = 同义：⌘+ 在 webview 里给的是 "+"，直接按则往往是 "="
    if (k === "+" || k === "=") {
      ev.preventDefault();
      lbStep(LB_STEP_IN);
    } else if (k === "-" || k === "_") {
      ev.preventDefault();
      lbStep(LB_STEP_OUT);
    } else if (k === "0") {
      ev.preventDefault();
      lbToFit();
    } else if (k === "1") {
      ev.preventDefault();
      lbToOne();
    } else if (k === "t") {
      ev.preventDefault();
      lbSetTiled();
    } else if (k === "arrowleft") {
      ev.preventDefault();
      lbPan(-LB_PAN_KEY, 0);
    } else if (k === "arrowright") {
      ev.preventDefault();
      lbPan(LB_PAN_KEY, 0);
    } else if (k === "arrowup") {
      ev.preventDefault();
      lbPan(0, -LB_PAN_KEY);
    } else if (k === "arrowdown") {
      ev.preventDefault();
      lbPan(0, LB_PAN_KEY);
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
  // 打开时读一次最新值：收起时没人看这几项，不值得时刻维护
  if (ui.settings.classList.contains("is-open")) {
    refreshRecvPrefs();
    refreshStorage();
  }
});

/* 本机接收那一段：开关即时存，失败就退回磁盘上那份 */
if (ui.notifyChk) {
  ui.notifyChk.addEventListener("change", async () => {
    const on = ui.notifyChk.checked;
    paintNotifySwitch(on);
    if (!(await saveRecvPrefs({ notify: on }))) await refreshRecvPrefs();
  });
}
if (ui.btnAudition) {
  // 试听无视开关直接响（这一声就是用来分清「没消息」与「这台机器放不出声」的）
  ui.btnAudition.addEventListener("click", () => {
    invoke("play_notify_sound").catch((err) => toast(errText(err), "error"));
  });
}
if (ui.btnInboxChoose) ui.btnInboxChoose.addEventListener("click", chooseInboxDir);
if (ui.btnInboxReset) ui.btnInboxReset.addEventListener("click", resetInboxDir);
if (ui.btnInboxReveal) ui.btnInboxReveal.addEventListener("click", revealInboxDir);
if (ui.inboxLayout) ui.inboxLayout.addEventListener("change", chooseInboxLayout);
// 存储：「打开收件目录」与上面那一枚走同一个函数（同一个目录，不另算一份路径）
if (ui.btnStorageRefresh) ui.btnStorageRefresh.addEventListener("click", refreshStorage);
if (ui.btnStorageReveal) ui.btnStorageReveal.addEventListener("click", revealInboxDir);
if (ui.btnInboxClean) ui.btnInboxClean.addEventListener("click", cleanInbox);
if (ui.heartbeatSel) ui.heartbeatSel.addEventListener("change", chooseHeartbeat);

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

// ⌘F/Ctrl+F 开的是跨会话的全局搜索浮层（会话内那条框改用手点）；
// Esc 在搜索框里是清空并交还焦点，不抢其它地方的 Esc（比如关掉放大层）
window.addEventListener("keydown", (ev) => {
  if (currentView() !== "transfer") return;
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    openFind();
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
// 对比视图右键「发送到聊天」切过来时把那张图摆进待发送区。
// 挂在切换回调上而不是某个会话的点击上：进来就得看见它，选谁由用户随后决定
onViewChange((name) => {
  if (name === "transfer") stagePendingSend();
});
// 会话的新建与删除都从这里走：陌生设备的第一条消息就是在这里把行放进会话栏的
listen("sessions-changed", applySessions);
// 清理完后端推一句：抽屉开着就重画那几个数字（没开着也没关系，下次打开自己会读）
listen("storage-changed", (payload) => {
  if (payload && payload.stats) renderStorage(payload.stats);
});
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
