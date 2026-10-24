/* ==========================================================================
 * 视图二：局域网传输（相当于自己的「文件传输助手」，只绑定两台设备）
 *
 * 界面只干两件事：把用户意图交给 Rust 命令，把 Rust 推来的事件画成气泡。
 * 所有网络与校验都在 Rust 侧，这里不碰 socket、不算 sha256。
 * ========================================================================== */

import {
  copyPathAsFile,
  copyText,
  currentView,
  el,
  errText,
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
  lightbox: el("img-lightbox"),
  lightboxImg: el("lightbox-img"),
  lightboxCap: el("lightbox-cap"),
  lightboxClose: el("lightbox-close"),
};

const state = {
  status: null, // net_status / peers-changed 的最新快照
  /** msgId -> { el, bar, state, kind } 便于原地更新进度与状态 */
  bubbles: new Map(),
  sending: false,
  /** 当前搜索条件：kind 为 all/text/image/folder/archive/other，q 为关键词 */
  filter: { kind: "all", q: "" },
  /** 已铺到最早那一条的 id，往前翻页的游标（用 id 不用条数：中间来新消息也不会串页） */
  oldestId: null,
  /** 历史里比游标更早的还有没有 */
  hasMore: true,
  loadingOlder: false,
};

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
  const peer = s.peer;
  const node = ui.peer;
  node.classList.toggle("is-online", !!peer && peer.online);
  if (!s.passphrase_set) {
    node.innerHTML = `<span class="dot dot-warn"></span><b>还没设置配对口令</b><span class="peer-sub">两台填同一个口令才能互认</span>`;
  } else if (!peer) {
    node.innerHTML = `<span class="dot dot-off"></span><b>未绑定对端</b><span class="peer-sub">等待口令一致的设备，或用手动 IP 绑定</span>`;
  } else {
    node.innerHTML = `<span class="dot ${peer.online ? "dot-on" : "dot-off"}"></span><b>${escapeHtml(
      peer.name
    )}</b><span class="peer-sub">${peer.host}:${peer.port} · ${
      peer.online ? "在线" : "离线（最近 " + fmtTime(peer.last_seen) + "）"
    }</span>`;
  }
  ui.btnSend.disabled = !(peer && peer.online) || state.sending;
  ui.btnFile.disabled = ui.btnSend.disabled;
  ui.btnFolder.disabled = ui.btnSend.disabled;
  ui.btnUnbind.disabled = !peer;
  ui.btnManual.disabled = !!peer;
  ui.btnReprobe.disabled = !peer;

  // 本机端口 + 防火墙提示（Windows 首次监听一定要允许）
  const portText = s.server_ok ? `本机接收端口 ${s.port}` : "接收服务未启动";
  const parts = [portText];
  if (s.error) parts.push(s.error);
  setStatus(parts.join(" · "));

  const cands = (s.discovered || []).filter((d) => !peer || d.id !== peer.id);
  ui.candidates.textContent = "";
  if (!cands.length) {
    ui.candidates.textContent = "已发现设备：无（mDNS 常被公司网络/VPN 屏蔽，请用下面的手动 IP）";
  } else {
    // 发现结果直接做成按钮：点一下就走 /ping 校口令绑定，不要求用户手抄 IP
    const label = document.createElement("span");
    label.className = "cand-label";
    label.textContent = "已发现（只支持一台，点击绑定）：";
    ui.candidates.appendChild(label);
    for (const d of cands) {
      const b = document.createElement("button");
      b.className = "cand";
      b.textContent = `${d.name} · ${d.host}:${d.port}`;
      b.title = "向它发 /ping，口令一致才绑定";
      b.addEventListener("click", () => bindAddr(`${d.host}:${d.port}`));
      ui.candidates.appendChild(b);
    }
  }
  ui.passphrase.value = "";
  ui.passphrase.placeholder = s.passphrase_set ? "已设置，留空不修改" : "设置配对口令（≥4 字符）";
  if (ui.deviceName.value === "" && s.device_name) ui.deviceName.value = s.device_name;
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
  const who = m.dir === "in" ? (state.status?.peer?.name || "对端") : "本机";
  const stateText =
    rec.state === "sending" ? " · 传输中" : rec.state === "failed" ? " · 失败" : "";
  rec.meta.textContent = `${who} · ${fmtTime(m.ts)}${stateText}`;
  rec.el.classList.toggle("is-failed", rec.state === "failed");
  rec.el.classList.toggle("is-sending", rec.state === "sending");
}

/**
 * 追加或原地更新一条消息（同 id 的多次状态更新只重画一次气泡）。
 * `anchor` 非空时插在这个元素之前：往前翻历史要把更早的铺到最上面，
 * 同一页按「旧的在前」依次插到同一个锚点前，顺序自然就是对的。
 */
function upsertMessage(m, anchor = null) {
  if (!m || !m.id) return;
  const atBottom = isNearBottom();
  let rec = state.bubbles.get(m.id);
  if (!rec) {
    rec = buildBubble(m);
    state.bubbles.set(m.id, rec);
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
  try {
    // 首屏只拉最近 PAGE 条（跟微信一样先看到最新的），更早的靠滚到顶/点顶栏补
    const list = await invoke("msg_history", { limit: PAGE });
    ui.stream.textContent = "";
    state.bubbles.clear();
    state.oldestId = null;
    for (const m of list || []) {
      upsertMessage(m);
      if (!state.oldestId) state.oldestId = m.id; // 列表旧的在前，第一条即最老
    }
    state.hasMore = (list || []).length >= PAGE;
    if (!state.bubbles.size) {
      ui.stream.innerHTML = `<div class="stream-empty">还没有消息。把文件拖进来，或选中文字收藏前先发一条。</div>`;
    }
    renderOlderBar();
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
  if (!isTauriRuntime || state.loadingOlder || !state.hasMore || !state.oldestId) return;
  state.loadingOlder = true;
  setOlderBarText("正在加载更早的消息…");
  const h0 = ui.stream.scrollHeight;
  const t0 = ui.stream.scrollTop;
  try {
    const list = await invoke("msg_history", { limit: PAGE, before: state.oldestId });
    if (!list || !list.length) {
      state.hasMore = false;
      return;
    }
    // 当前最老那条气泡（用 .msg 而不是 firstElementChild，避开「还没有消息」那句占位）
    const anchor = ui.stream.querySelector(".msg");
    for (const m of list) {
      upsertMessage(m, anchor);
      state.oldestId = m.id; // 列表旧的在前，最后一条就是新的最老游标
    }
    state.hasMore = list.length >= PAGE;
    applyFilter();
    // 往上加了内容，得把多出来的高度补回 scrollTop，视口才能停在原来那几条上
    ui.stream.scrollTop = ui.stream.scrollHeight - h0 + t0;
  } catch (err) {
    console.error("[xfer] 加载更早的消息失败:", err);
    setStatus("加载更早的消息失败: " + errText(err));
  } finally {
    state.loadingOlder = false;
    renderOlderBar();
  }
}

function setOlderBarText(text) {
  if (ui.older) ui.older.textContent = text;
}

/**
 * 搜索/筛选得覆盖整份历史：现在只铺了最近 10 条，
 * 不先把早期的补进来会让人误判“没搜到”。最多翻 60 页（后端一页上限 500 条）。
 */
async function loadAllForSearch() {
  let guard = 0;
  while (state.hasMore && guard++ < 60) await loadOlder();
}

/** 没更多了就把栏收起来，免得留一个点了没反应按钮 */
function renderOlderBar() {
  if (!ui.older) return;
  ui.older.hidden = !(state.hasMore && state.bubbles.size);
  setOlderBarText("加载更早的消息");
}

function clearEmptyHint() {
  const hint = ui.stream.querySelector(".stream-empty");
  if (hint) hint.remove();
}

/* --------------------------------------------------------------------------
 * 搜索：按类型筛已有气泡 + 关键词搜名字/文字内容
 *
 * 搜索会先把更早的历史逐页补进来（loadAllForSearch），再在内存里筛：
 * 后端只存了一份小 JSONL，再加一层搜索接口只能把同一份文件重解一遍。
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
  // 搜的是整份历史，不是已铺出来的那一页 —— 先把早期的拉齐再筛
  if (filterActive() && state.hasMore && !state.loadingOlder) loadAllForSearch();
  let hit = 0;
  for (const rec of state.bubbles.values()) {
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
  box.textContent = `匹配 ${hit} / ${state.bubbles.size}`;
}

/** 一条都不剩时给句话，否则整个流是空白的，看起来像程序坏了 */
function renderFilterEmpty(hit) {
  let hint = ui.stream.querySelector(".filter-empty");
  if (hit === 0 && state.bubbles.size > 0) {
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "filter-empty";
      ui.stream.appendChild(hint);
    }
    hint.textContent = "没有符合条件的消息（只搜本机已加载的历史，不含对端）";
  } else if (hint) {
    hint.remove();
  }
}

/* --------------------------------------------------------------------------
 * 发送
 * ------------------------------------------------------------------------ */
async function sendText() {
  const text = ui.input.value;
  if (!text.trim()) {
    toast("先写点内容", "error");
    return;
  }
  ui.input.value = "";
  ui.input.style.height = "";
  await runSend(() => invoke("send_text", { text }));
}

async function sendPaths(paths) {
  if (!paths || !paths.length) return;
  clearEmptyHint();
  await runSend(() => invoke("send_paths", { paths }));
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

async function bindAddr(addr) {
  if (!addr) {
    toast("填对端 IP，形如 192.168.1.23 或 192.168.1.23:45790", "error");
    return;
  }
  ui.btnManual.disabled = true;
  try {
    await invoke("bind_peer_addr", { addr });
    ui.manualAddr.value = "";
    toast("已绑定对端");
  } catch (err) {
    toast(errText(err), "error");
  } finally {
    ui.btnManual.disabled = false;
    await refreshStatus();
  }
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
  const peer = state.status?.peer;
  const online = !!peer && peer.online;
  ui.dropHint.hidden = false;
  ui.dropHint.classList.toggle("is-blocked", !online);
  ui.dropText.textContent = !state.status?.passphrase_set
    ? "先在「配对设置」里填口令"
    : online
      ? `松开即发送给「${peer.name}」`
      : `对端${peer ? `「${peer.name}」` : ""}离线，暂发不出去`;
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
ui.btnManual.addEventListener("click", bindManual);
ui.manualAddr.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") bindManual();
});
ui.btnUnbind.addEventListener("click", async () => {
  try {
    renderStatus(await invoke("unbind_peer"));
    toast("已解绑，可重新绑定另一台");
  } catch (err) {
    toast(errText(err), "error");
  }
});
ui.btnReprobe.addEventListener("click", async () => {
  ui.btnReprobe.disabled = true;
  try {
    await invoke("reprobe_peer");
    toast("对端在线");
  } catch (err) {
    toast(errText(err), "error");
  } finally {
    await refreshStatus();
  }
});
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
listen("msg-in", (payload) => {
  clearEmptyHint();
  upsertMessage(payload?.message);
  scrollBottom();
});
listen("msg-updated", (payload) => upsertMessage(payload?.message));
listen("xfer-progress", (p) => {
  if (!p || !p.msg_id) return;
  const rec = state.bubbles.get(p.msg_id);
  if (rec && rec.bar && p.total) {
    rec.bar.style.width = Math.min(100, Math.round((p.sent / p.total) * 100)) + "%";
    rec.bar.title = `${p.name} ${fmtSize(p.sent)} / ${fmtSize(p.total)}`;
  } else if (!rec) {
    // 收文件时第一条进度可能早于 xfer-done，先占个气泡，done 再补全信息
    upsertMessage({
      id: p.msg_id,
      dir: "in",
      kind: "file",
      name: p.name || "接收中",
      size: p.total,
      state: "sending",
      ts: Date.now(),
    });
  }
  if (isNearBottom()) scrollBottom();
});
listen("xfer-done", (payload) => upsertMessage(payload?.message));

/* 往前翻页：滚到顶自动补一页，内容不够一屏（滚不动）时靠顶栏点一下 */
ui.stream.addEventListener("scroll", () => {
  if (ui.stream.scrollTop < 30) loadOlder();
});
if (ui.older) ui.older.addEventListener("click", loadOlder);

refreshStatus();
loadHistory();
console.log("[xfer] 传输视图初始化完成");
