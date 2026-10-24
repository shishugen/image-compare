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
};

const state = {
  status: null, // net_status / peers-changed 的最新快照
  /** msgId -> { el, bar, state, kind } 便于原地更新进度与状态 */
  bubbles: new Map(),
  sending: false,
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

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

  const rec = { el: wrap, meta, bubble, bar: null, state: m.state, kind: m.kind };

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

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = m.state === "sent" ? "100%" : "0%";
    bar.appendChild(fill);
    bubble.appendChild(bar);
    rec.bar = fill;

    const acts = [];
    if (m.path) {
      acts.push(["打开位置", () => invoke("reveal_in_folder", { path: m.path }).catch((e) => toast(errText(e), "error"))]);
      const isImage = m.kind === "file" && IMAGE_EXT.test(m.name || "");
      if (isImage) {
        acts.push(["在对比中打开", () => openInCompare([m.path])]);
      }
    }
    bubble.appendChild(actions(acts));
  } else {
    const body = document.createElement("div");
    body.className = "msg-text";
    body.textContent = m.text || m.name || "";
    bubble.appendChild(body);
  }
  return rec;
}

function actions(list) {
  const box = document.createElement("div");
  box.className = "msg-actions";
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
