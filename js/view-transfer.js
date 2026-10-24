/* ==========================================================================
 * 视图二：局域网传输（相当于自己的「文件传输助手」，只绑定两台设备）
 *
 * 界面只干两件事：把用户意图交给 Rust 命令，把 Rust 推来的事件画成气泡。
 * 所有网络与校验都在 Rust 侧，这里不碰 socket、不算 sha256。
 * ========================================================================== */

import {
  copyText,
  el,
  errText,
  fmtSize,
  fmtTime,
  invoke,
  isTauriRuntime,
  listen,
  openInCompare,
  registerDropHandler,
  registerDropHoverHandler,
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
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
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
  ui.lightboxImg.src = dataUrl;
  ui.lightboxImg.alt = name || "";
  ui.lightboxCap.textContent = [name, p].filter(Boolean).join(" · ");
  ui.lightbox.hidden = false;
}

function closeLightbox() {
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

/** 追加或原地更新一条消息（同 id 的多次状态更新只重画一次气泡） */
function upsertMessage(m) {
  if (!m || !m.id) return;
  const atBottom = isNearBottom();
  let rec = state.bubbles.get(m.id);
  if (!rec) {
    rec = buildBubble(m);
    state.bubbles.set(m.id, rec);
    ui.stream.appendChild(rec.el);
  }
  rec.state = m.state || rec.state;
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
    const list = await invoke("msg_history", { limit: 500 });
    ui.stream.textContent = "";
    state.bubbles.clear();
    for (const m of list || []) upsertMessage(m);
    if (!state.bubbles.size) {
      ui.stream.innerHTML = `<div class="stream-empty">还没有消息。把文件拖进来，或选中文字收藏前先发一条。</div>`;
    }
    scrollBottom();
  } catch (err) {
    console.error("[xfer] 读历史失败:", err);
    setStatus("读历史失败: " + errText(err));
  }
}

function clearEmptyHint() {
  const hint = ui.stream.querySelector(".stream-empty");
  if (hint) hint.remove();
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

refreshStatus();
loadHistory();
console.log("[xfer] 传输视图初始化完成");
