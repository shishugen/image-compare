/* ==========================================================================
 * 视图三：三级文字收藏
 *
 * 数据只有一个 favorites.json，Rust 侧整份读写并做三级深度守卫，这里负责：
 * 把扁平节点表拼成树、按选中分类列条目、抽屉里编辑、以及和传输/对比视图互跳。
 * 守卫规则前后端都清楚（分类最多三级、条目只能是叶子），前端提前拦一下只是
 * 少一次往返，最终仍以 Rust 的判定为准。
 * ========================================================================== */

import {
  copyText,
  el,
  errText,
  fmtTime,
  IMAGE_EXT,
  invoke,
  isTauriRuntime,
  onViewChange,
  openInCompare,
  registerDropHandler,
  registerPasteTextHandler,
  sendPathsToPeer,
  sendTextToPeer,
  setStatus,
  toast,
} from "./api.js";

const MAX_CAT_LEVEL = 3; // 与 favorites.rs 一致
// IMAGE_EXT 从 api.js 导，三个视图共用一份口径

const ui = {
  tree: el("fav-tree"),
  list: el("fav-list"),
  count: el("fav-count"),
  search: el("inp-fav-search"),
  newCat: el("btn-fav-new-cat"),
  newItem: el("btn-fav-new-item"),
  editor: el("fav-editor"),
  heading: el("fav-editor-heading"),
  title: el("inp-fav-title"),
  body: el("inp-fav-body"),
  parent: el("sel-fav-parent"),
  btnSave: el("btn-fav-save"),
  btnDelete: el("btn-fav-delete"),
  btnCopy: el("btn-fav-copy"),
  btnSend: el("btn-fav-send"),
  btnOpen: el("btn-fav-open"),
};

const state = {
  nodes: [],
  byId: new Map(),
  selected: null, // 选中的分类 id，null = 顶层
  expanded: new Set(),
  editing: null, // 正在编辑的节点，null 表示新建
  editingKind: "fav",
  query: "",
};

/* --------------------------------------------------------------------------
 * 取数与索引
 * ------------------------------------------------------------------------ */
async function load() {
  if (!isTauriRuntime) {
    setStatus("非 Tauri 环境，收藏数据不可用");
    return;
  }
  try {
    const res = await invoke("fav_list");
    state.nodes = res?.nodes || [];
    state.byId = new Map(state.nodes.map((n) => [n.id, n]));
    // 选中的分类可能刚被删掉，退回顶层而不是画出一棵断树
    if (state.selected && !state.byId.has(state.selected)) state.selected = null;
    render();
  } catch (err) {
    console.error("[fav] 读收藏失败:", err);
    setStatus("读收藏失败: " + errText(err));
  }
}

const childrenOf = (pid) => state.nodes.filter((n) => (n.parent || null) === (pid || null));
const catsOf = (pid) => childrenOf(pid).filter((n) => n.kind === "cat");
const favsOf = (pid) => childrenOf(pid).filter((n) => n.kind === "fav");

/** 按标题排序，中文用 localeCompare，稳定顺序比创建顺序更好找回 */
const sortTitle = (a, b) => a.title.localeCompare(b.title, "zh-Hans-CN");

/** 节点所在层级（顶层为 1），与 Rust 的 fav_depth 同语义 */
function depthOf(id) {
  let d = 0;
  let cur = state.byId.get(id);
  while (cur) {
    d += 1;
    if (d > 8) break; // 数据被手改出环时的保险
    cur = cur.parent ? state.byId.get(cur.parent) : null;
  }
  return d;
}

/** 自身 + 全部后代，用于「不能把分类移进自己里面」 */
function subtreeIds(id) {
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of state.nodes) {
      if ((n.parent || null) === cur && !out.has(n.id)) {
        out.add(n.id);
        stack.push(n.id);
      }
    }
  }
  return out;
}

function summary(node) {
  const lines = String(node.body || "").split(/\r?\n/).filter(Boolean);
  return (lines[0] || "（空）").slice(0, 120);
}

/** 正文里像图片路径的行：绝对路径 + 图片后缀，用来一键丢进对比视图 */
function imagePathsIn(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) => /^([/\\]|[A-Za-z]:[\\/])/.test(s) && IMAGE_EXT.test(s));
}

/* --------------------------------------------------------------------------
 * 左：分类树
 * ------------------------------------------------------------------------ */
function treeRow(node, depth) {
  const row = document.createElement("div");
  const id = node.id || "";
  row.className = "tree-row" + (String(state.selected || "") === id ? " is-sel" : "");
  row.dataset.id = id;
  row.style.setProperty("--depth", depth);

  const twist = document.createElement("span");
  twist.className = "tree-twist";
  twist.dataset.twist = "1";
  const kids = catsOf(node.id).length;
  twist.textContent = kids ? (state.expanded.has(node.id) ? "▾" : "▸") : "·";
  row.appendChild(twist);

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = node.title || "全部收藏";
  name.title = node.title || "";
  row.appendChild(name);

  const num = document.createElement("span");
  num.className = "tree-num";
  num.textContent = String(favsOf(node.id).length);
  num.title = "本级条目数";
  row.appendChild(num);

  // 第三级分类不再给「＋分类」：前端先拦住，省一次往返与一次报错
  if (!node.id || depthOf(node.id) < MAX_CAT_LEVEL) {
    row.appendChild(addBtn("cat", node.id, "在此新建子分类"));
  }
  row.appendChild(addBtn("fav", node.id, "在此新建收藏"));
  return row;
}

function addBtn(kind, id, title) {
  const b = document.createElement("button");
  b.className = "tree-add";
  b.dataset.add = kind;
  b.dataset.id = id || "";
  b.textContent = kind === "cat" ? "＋类" : "＋条";
  b.title = title;
  return b;
}

function renderTree() {
  ui.tree.textContent = "";
  ui.tree.appendChild(treeRow({ id: null, title: "全部收藏" }, 0));
  const walk = (pid, depth) => {
    for (const cat of catsOf(pid).sort(sortTitle)) {
      ui.tree.appendChild(treeRow(cat, depth));
      if (state.expanded.has(cat.id)) walk(cat.id, depth + 1);
    }
  };
  walk(null, 1);
}

ui.tree.addEventListener("click", (ev) => {
  const add = ev.target.closest("[data-add]");
  if (add) {
    ev.stopPropagation();
    startCreate(add.dataset.add, add.dataset.id || null);
    return;
  }
  const row = ev.target.closest(".tree-row");
  if (!row) return;
  const id = row.dataset.id || null;
  if (ev.target.dataset.twist !== undefined && catsOf(id).length) {
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
  }
  state.selected = id;
  state.query = "";
  ui.search.value = "";
  render();
});

/* --------------------------------------------------------------------------
 * 右：条目列表
 * ------------------------------------------------------------------------ */
function listItems() {
  const q = state.query.trim().toLowerCase();
  if (q) {
    // 搜索跨全树，标题命中优先于正文命中
    return state.nodes
      .filter((n) => n.kind === "fav")
      .sort((a, b) => score(b, q) - score(a, q) || sortTitle(a, b));
  }
  return favsOf(state.selected).sort(sortTitle);
}

const score = (n, q) => (n.title.toLowerCase().includes(q) ? 2 : 0) + (n.body.toLowerCase().includes(q) ? 1 : 0);

function pathOfLabel(node) {
  // 挂在哪个分类下面，避免同名条目分不清是谁
  const seg = [];
  let cur = node.parent ? state.byId.get(node.parent) : null;
  while (cur) {
    seg.unshift(cur.title);
    cur = cur.parent ? state.byId.get(cur.parent) : null;
  }
  return seg.length ? "分类：" + seg.join(" / ") : "分类：顶层";
}

function renderList() {
  ui.list.textContent = "";
  const items = listItems();
  if (!items.length) {
    ui.list.innerHTML = `<div class="list-empty">${
      state.query
        ? "没有匹配的收藏。"
        : "这个分类还是空的。选中文字后可以在传输视图直接「收藏」，也可以用上面的「新建收藏」。"
    }</div>`;
    return;
  }
  for (const node of items) {
    const row = document.createElement("div");
    row.className = "fav-row";
    row.dataset.id = node.id;
    row.title = pathOfLabel(node);

    const main = document.createElement("div");
    main.className = "fav-row-main";
    const t = document.createElement("div");
    t.className = "fav-row-title";
    t.textContent = node.title;
    const s = document.createElement("div");
    s.className = "fav-row-sum";
    s.textContent = summary(node);
    main.append(t, s);

    const side = document.createElement("div");
    side.className = "fav-row-side";
    const time = document.createElement("span");
    time.className = "fav-row-time";
    time.textContent = fmtTime(node.updated);
    side.appendChild(time);

    const acts = document.createElement("div");
    acts.className = "fav-row-acts";
    acts.append(
      actBtn("copy", "复制"),
      actBtn("edit", "编辑"),
      actBtn("send", "发送"),
      ...(imagePathsIn(node.body).length ? [actBtn("open", "对比中打开")] : []),
      actBtn("del", "删除")
    );
    side.appendChild(acts);

    row.append(main, side);
    ui.list.appendChild(row);
  }
}

function actBtn(act, label) {
  const b = document.createElement("button");
  b.className = "link-btn";
  b.dataset.act = act;
  b.textContent = label;
  return b;
}

ui.list.addEventListener("click", async (ev) => {
  const row = ev.target.closest(".fav-row");
  if (!row) return;
  const node = state.byId.get(row.dataset.id);
  if (!node) return;
  const btn = ev.target.closest("[data-act]");
  if (!btn) return openEditor(node);

  const act = btn.dataset.act;
  if (act === "copy") return copyText(node.body || node.title);
  if (act === "edit") return openEditor(node);
  if (act === "send") return sendTextToPeer(node.body || node.title);
  if (act === "open") {
    const paths = imagePathsIn(node.body);
    if (!paths.length) return toast("这条收藏里没有图片路径", "error");
    return openInCompare(paths);
  }
  if (act === "del") return armDelete(btn, node);
});

/** WebView 里 window.confirm 不一定可用，删除用「再点一次确认」两步式 */
async function armDelete(btn, node) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = node.kind === "cat" ? "确认删除整个子树？" : "确认删除？";
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.dataset.armed = "";
      btn.textContent = "删除";
    }, 4000);
    return;
  }
  try {
    const n = await invoke("fav_delete", { id: node.id });
    toast(`已删除 ${n} 个节点`);
    if (state.editing?.id === node.id) closeEditor();
    await load();
  } catch (err) {
    toast(errText(err), "error");
  }
}

/* --------------------------------------------------------------------------
 * 抽屉：新建与编辑
 * ------------------------------------------------------------------------ */
function fillParents(node) {
  ui.parent.textContent = "";
  const add = (value, label) => {
    const o = document.createElement("option");
    o.value = value || "";
    o.textContent = label;
    ui.parent.appendChild(o);
  };
  add(null, "（顶层）");
  const banned = node ? subtreeIds(node.id) : new Set();
  for (const cat of state.nodes.filter((n) => n.kind === "cat" && !banned.has(n.id)).sort(sortTitle)) {
    add(cat.id, "　".repeat(depthOf(cat.id) - 1) + cat.title);
  }
  ui.parent.value = node?.parent || "";
}

function openEditor(node) {
  state.editing = node;
  state.editingKind = node.kind;
  ui.heading.textContent = "编辑" + (node.kind === "cat" ? "分类" : "收藏");
  ui.title.value = node.title || "";
  ui.body.value = node.body || "";
  // 分类不存正文，Rust 侧也会把分类的 body 清空，这里直接不给编辑
  ui.body.readOnly = node.kind === "cat";
  ui.body.placeholder = node.kind === "cat" ? "分类不需要正文" : "一行一个内容；图片绝对路径可以直接粘贴进来";
  fillParents(node);
  const isFav = node.kind === "fav";
  ui.btnCopy.hidden = !isFav;
  ui.btnSend.hidden = !isFav;
  ui.btnOpen.hidden = !isFav || !imagePathsIn(node.body).length;
  ui.btnDelete.hidden = false;
  setDeleteLabel(false);
  ui.editor.classList.add("is-open");
  ui.title.focus();
}

function startCreate(kind, parentId) {
  // 从三级分类点「＋类」时树里已经不给了，这里再兜一层（比如顶层刚被点过）
  if (kind === "cat" && parentId && depthOf(parentId) >= MAX_CAT_LEVEL) {
    return toast(`分类最多 ${MAX_CAT_LEVEL} 级，可以直接在第三级下建条目`, "error");
  }
  state.editing = null;
  state.editingKind = kind;
  ui.heading.textContent = "新建" + (kind === "cat" ? "分类" : "收藏");
  ui.title.value = "";
  ui.body.value = "";
  ui.body.readOnly = kind === "cat";
  ui.body.placeholder = kind === "cat" ? "分类不需要正文" : "一行一个内容；图片绝对路径可以直接粘贴进来";
  fillParents(null);
  ui.parent.value = parentId || "";
  ui.btnCopy.hidden = true;
  ui.btnSend.hidden = true;
  ui.btnOpen.hidden = true;
  ui.btnDelete.hidden = true;
  ui.editor.classList.add("is-open");
  ui.title.focus();
}

function closeEditor() {
  ui.editor.classList.remove("is-open");
  state.editing = null;
}

async function saveEditor() {
  const title = ui.title.value.trim();
  if (!title) return toast("标题不能为空", "error");
  const parent = ui.parent.value || null;
  const node = state.editing;
  try {
    // 只挪了归属就先走 fav_move，让 fav_upsert 专心改文字
    if (node && (node.parent || null) !== parent) {
      await invoke("fav_move", { id: node.id, parent });
    }
    await invoke("fav_upsert", {
      node: {
        id: node?.id ?? null,
        parent,
        kind: state.editingKind,
        title,
        body: ui.body.value,
      },
    });
    toast(node ? "已保存" : "已新建");
    if (parent) state.expanded.add(parent);
    state.selected = node?.kind === "cat" ? node.id : parent;
    closeEditor();
    await load();
  } catch (err) {
    console.error("[fav] 保存失败:", err);
    toast(errText(err), "error");
  }
}

function setDeleteLabel(armed) {
  ui.btnDelete.textContent = armed ? "确认删除？" : "删除";
  ui.btnDelete.dataset.armed = armed ? "1" : "";
}

ui.btnSave.addEventListener("click", saveEditor);
el("btn-fav-cancel").addEventListener("click", closeEditor);
ui.btnDelete.addEventListener("click", async () => {
  if (!state.editing) return;
  if (ui.btnDelete.dataset.armed !== "1") return setDeleteLabel(true);
  try {
    const n = await invoke("fav_delete", { id: state.editing.id });
    toast(`已删除 ${n} 个节点`);
    closeEditor();
    await load();
  } catch (err) {
    toast(errText(err), "error");
  }
});
ui.btnCopy.addEventListener("click", () => state.editing && copyText(state.editing.body || state.editing.title));
ui.btnSend.addEventListener("click", () => state.editing && sendTextToPeer(state.editing.body || state.editing.title));
ui.btnOpen.addEventListener("click", () => {
  if (!state.editing) return;
  const paths = imagePathsIn(state.editing.body);
  if (!paths.length) return toast("这条收藏里没有图片路径", "error");
  openInCompare(paths);
});

ui.newCat.addEventListener("click", () => startCreate("cat", state.selected));
ui.newItem.addEventListener("click", () => startCreate("fav", state.selected));
ui.search.addEventListener("input", () => {
  state.query = ui.search.value;
  renderList();
});
ui.search.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ui.search.value = "";
    state.query = "";
    renderList();
  }
});

// 标题回车即保存；正文里 Ctrl/⌘+Enter 也保存，和常见编辑器习惯一致
ui.title.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    saveEditor();
  }
});
ui.body.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    saveEditor();
  }
});

/* --------------------------------------------------------------------------
 * 与其它视图的打通
 * ------------------------------------------------------------------------ */
// 非对比视图里拖进来的文件按方案走发送队列，不进图窗命中
registerDropHandler("fav", (paths) => sendPathsToPeer(paths));

// 焦点不在抽屉里时粘文字：直接起一个新收藏条目把文字放进去，省掉先点「＋条目」这一步
registerPasteTextHandler("fav", (text) => {
  // 抽屉开着且正文可写就接着用；正在建分类时正文是只读的，得先换到条目
  const reusable = ui.editor.classList.contains("is-open") && !ui.body.readOnly;
  if (!reusable) startCreate("fav", state.selected);
  const cur = ui.body.value.replace(/\s+$/, "");
  ui.body.value = cur ? cur + "\n" + text : text;
  ui.body.focus();
  toast("已粘进正文，起个标题就能保存");
});

// 传输视图里的「收藏」按钮会写新节点，切回来时重新取一次
onViewChange((name) => {
  if (name === "fav") load();
});

/* --------------------------------------------------------------------------
 * 初始化
 * ------------------------------------------------------------------------ */
function render() {
  renderTree();
  renderList();
  const favs = state.nodes.filter((n) => n.kind === "fav").length;
  const cats = state.nodes.filter((n) => n.kind === "cat").length;
  ui.count.textContent = state.query ? `匹配 ${listItems().length} 条` : `条目 ${favs} · 分类 ${cats}`;
}

load().catch((err) => console.error("[fav] 初始化失败:", err));
console.log("[fav] 收藏视图初始化完成");
