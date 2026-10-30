/* ==========================================================================
 * 视图四：图片归类
 *
 * 三段式，中间那段必须零副作用：
 *   ① 选源目录（对话框 / 手输 / 拖文件夹进来）
 *   ② 配规则 → 「预览」只算不落盘（preview_sort），右边逐条列出「这张图会去哪」，
 *      可点一行手动排除（改判 hold）
 *   ③ 「执行」才真动文件（apply_sort）：移动 / 复制两档，移动档两步确认
 *
 * 数据口径全部在 Rust 侧（sort.rs），这里只发命令 + 渲染。命令/字段名一律 snake_case
 * （嵌套 input 里的键是 serde 结构体字段名，不是 Tauri 参数名；只有 set_prefs 的多词参数
 * 走 camelCase —— 传成 sortPlans，读 get_prefs 回来的是 sort_plans）。
 * ========================================================================== */

import {
  cleanPath,
  el,
  errText,
  fmtSize,
  invoke,
  isTauriRuntime,
  registerDropHandler,
  setStatus,
  toast,
} from "./api.js";

const ui = {
  pick: el("btn-sort-pick"),
  src: el("inp-sort-src"),
  rec: el("chk-sort-rec"),
  preview: el("btn-sort-preview"),
  apply: el("btn-sort-apply"),
  undo: el("btn-sort-undo"),
  modeMove: el("btn-sort-mode-move"),
  modeCopy: el("btn-sort-mode-copy"),
  planName: el("inp-sort-plan-name"),
  planSel: el("sel-sort-plan"),
  savePlan: el("btn-sort-save-plan"),
  newPlan: el("btn-sort-new-plan"),
  delPlan: el("btn-sort-del-plan"),
  addRule: el("btn-sort-add-rule"),
  auto: el("chk-sort-auto"),
  spreadKw: el("inp-sort-spread-kw"),
  rules: el("sort-rules"),
  target: el("inp-sort-target"),
  fall: el("inp-sort-fall"),
  summary: el("sort-summary"),
  list: el("sort-preview-list"),
};

const state = {
  src: "",
  recursive: false,
  targetRoot: "",
  fallthrough: "其他",
  autoGroup: true,
  spreadKws: "细节,尺寸",
  mode: "move",
  /** 规则数组，元素键与 Rust 的 SortRule 字段一一对应（snake_case，直接当 JSON 发） */
  rules: [],
  items: [],
  /** preview_sort 回来的整份计划，entries 是可被手动改判的活数据 */
  plan: null,
  plans: [], // 从 prefs 读回的已存方案（不透明 JSON）
  activePlanId: null,
  /** 上一次执行的可回滚记录 { ops, targetRoot }；撤完就清空（只支持撤一步） */
  lastUndo: null,
};

/** 一条空规则的默认形状：两个条件都空 = 什么都不捞，folder 也空 = 原地不动。
 * action 是这条规则自己的动作：move 把命中的图移进本夹，copy 复制一份进本夹、源留着
 *（一张图能命中多条规则 —— 「07-细节.png」既进细节夹又进别的夹，靠的就是每条各定动作）。
 * 按年月日分的条件已拆：规则就认「格式 + 名称关键词」两样，界面和心智都简单一截 */
function blankRule() {
  return { exts: [], name_glob: "", folder: "", action: "move" };
}

/** 方案 id：不引 uuid 依赖，Date+随机在这个量级下不会撞 */
function newId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* 当前正在编辑的规则（未存为方案）也落一份 localStorage：改代码重启应用不再把它清掉 */
const WORK_KEY = "imageCompare.sortWorking";
let saveTimer = 0;
function saveWorking() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        WORK_KEY,
        JSON.stringify({
          src: ui.src ? ui.src.value : state.src,
          rules: state.rules,
          targetRoot: ui.target ? ui.target.value : state.targetRoot,
          fallthrough: ui.fall ? ui.fall.value : state.fallthrough,
          autoGroup: ui.auto ? !!ui.auto.checked : state.autoGroup,
          spreadKws: ui.spreadKw ? ui.spreadKw.value : state.spreadKws,
          mode: state.mode,
        }),
      );
    } catch {
      /* localStorage 不可用就当没存，不影响主流程 */
    }
  }, 200);
}

function restoreWorking() {
  let raw = null;
  try {
    raw = localStorage.getItem(WORK_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  let w;
  try {
    w = JSON.parse(raw);
  } catch {
    return false;
  }
  if (Array.isArray(w.rules)) state.rules = w.rules.map((r) => ({ ...blankRule(), ...r }));
  if (typeof w.src === "string" && ui.src) {
    state.src = w.src;
    ui.src.value = w.src;
  }
  if (typeof w.targetRoot === "string" && ui.target) {
    state.targetRoot = w.targetRoot;
    ui.target.value = w.targetRoot;
  }
  if (typeof w.fallthrough === "string" && ui.fall) {
    state.fallthrough = w.fallthrough;
    ui.fall.value = w.fallthrough;
  }
  if (typeof w.autoGroup === "boolean") {
    state.autoGroup = w.autoGroup;
    if (ui.auto) ui.auto.checked = w.autoGroup;
  }
  if (typeof w.spreadKws === "string") {
    state.spreadKws = w.spreadKws;
    if (ui.spreadKw) ui.spreadKw.value = w.spreadKws;
  }
  if (w.mode === "copy" || w.mode === "move") state.mode = w.mode;
  return state.rules.length > 0;
}

/** 从文件名里抽「能当文件夹名的关键词」：去掉开头编号与分隔符、紧跟的数字。
 * 01-粉色 → 粉色；02--2黑色 → 黑色；01_灰色 → 灰色；01-2 → 空（没有词就不建夹）
 * 07-尺寸 (1) → 尺寸（副本后缀不算新关键词，否则会冒出「尺寸 (1)」夹） */
function keywordOf(name) {
  const stem = String(name).replace(/\.[^.]+$/, "");
  let s = stem.replace(/^[0-9０-９]+[\s\-_]*/, "");
  s = s.replace(/^[0-9０-９]+\s*/, "");
  s = s.replace(/\s*[（(]\s*\d+\s*[)）]\s*$/, "");
  return s.trim();
}

/** 取父目录（统一成 / 分隔，方便和 dest_dir 对比） */
function parentDir(path) {
  const s = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "";
}

/* --------------------------------------------------------------------------
 * 规则行的渲染与编辑（每条一行，输入直接改 state.rules[i]，不整表重画免得丢焦点）
 * ------------------------------------------------------------------------ */
function textInput(rule, key, holder, ph, parser) {
  const i = document.createElement("input");
  i.className = "input";
  i.placeholder = ph || "";
  i.value = parser ? parser(rule[key]) : rule[key] || "";
  i.addEventListener("input", () => {
    rule[key] = i.value;
    saveWorking();
  });
  holder.appendChild(i);
  return i;
}

function actionSelect(rule, holder) {
  const s = document.createElement("select");
  s.className = "select sort-action";
  s.title =
    "命中的图怎么落：移动 = 收进本夹、源不留；复制到 = 本夹再放一份，源留着；" +
    "复制到每个夹 = 本条不建夹，往本次会建的每个夹里各放一份（细节/尺寸用这个）";
  for (const [v, t] of [
    ["move", "移动"],
    ["copy", "复制到"],
    ["spread", "复制到每个夹"],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    s.appendChild(o);
  }
  const known = (v) => v === "copy" || v === "spread";
  s.value = known(rule.action) ? rule.action : "move";
  s.addEventListener("change", () => {
    rule.action = known(s.value) ? s.value : "move";
    saveWorking();
  });
  holder.appendChild(s);
}

function renderRuleRow(rule) {
  const row = document.createElement("div");
  row.className = "sort-rule";

  // 格式：界面上是逗号串，落到 rule 里是数组
  const ext = document.createElement("input");
  ext.className = "input";
  ext.placeholder = "png,jpg";
  ext.title = "扩展名（不含点），多个用逗号或空格分隔；留空 = 不限格式";
  ext.value = rule.exts.join(",");
  ext.addEventListener("input", () => {
    rule.exts = ext.value
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean);
  });
  row.appendChild(ext);

  textInput(rule, "name_glob", row, "如：红色 / 细节 / IMG_*");
  const folder = textInput(rule, "folder", row, "留空=按关键词建夹");
  folder.title = "可用模板 {yyyy} {MM} {格式}；留空时若关键词不含 *，就用关键词当文件夹名（如关键词「红色」→ 红色夹）";
  actionSelect(rule, row);

  const del = document.createElement("button");
  del.className = "sort-del";
  del.textContent = "×";
  del.title = "删掉这条规则";
  del.addEventListener("click", () => {
    const at = state.rules.indexOf(rule);
    if (at >= 0) state.rules.splice(at, 1);
    renderRules();
    saveWorking();
  });
  row.appendChild(del);
  return row;
}

function renderRules() {
  if (!ui.rules) return;
  ui.rules.textContent = "";
  for (const r of state.rules) ui.rules.appendChild(renderRuleRow(r));
  if (!state.rules.length) {
    const tip = document.createElement("p");
    tip.className = "hint";
    tip.textContent = state.autoGroup
      ? "不用加规则，会自动按文件名建夹。"
      : "还没有规则，点「＋加一条」。";
    ui.rules.appendChild(tip);
  }
}

/* --------------------------------------------------------------------------
 * 读输入框 → state（预览/执行前都同步一次，省得每个 input 都挂监听）
 * ------------------------------------------------------------------------ */
function syncFromInputs() {
  state.src = cleanPath(ui.src.value);
  // 长路径悬停能看全（输入框只能横向滚，别只靠光标）
  if (ui.src) ui.src.title = state.src;
  state.recursive = !!ui.rec.checked;
  state.targetRoot = cleanPath(ui.target.value);
  state.fallthrough = (ui.fall.value || "").trim();
  state.autoGroup = ui.auto ? !!ui.auto.checked : state.autoGroup;
  state.spreadKws = ui.spreadKw ? ui.spreadKw.value.trim() : state.spreadKws;
}

/* --------------------------------------------------------------------------
 * 预览：scan → preview_sort → 渲染。全程不写文件
 * ------------------------------------------------------------------------ */
async function doPreview() {
  syncFromInputs();
  saveWorking();
  if (!state.src) return toast("先选或填一个图片目录", "error");
  ui.apply.disabled = true;
  ui.apply.dataset.armed = "";
  ui.apply.textContent = "执行";
  setStatus("扫描目录…");
  let scan;
  try {
    scan = await invoke("scan_sort_dir", {
      dir: state.src,
      recursive: state.recursive,
      targetRoot: state.targetRoot || null,
    });
  } catch (err) {
    return failScan(errText(err));
  }
  state.items = scan?.items || [];
  if (!state.items.length) {
    state.plan = null;
    setSummary("这个目录里没扫到可归类的图片" + (state.recursive ? "（含子目录）" : "") + "。");
    ui.list.textContent = "";
    setStatus("");
    return;
  }
  setStatus("计算落点…");
  let plan;
  try {
    plan = await invoke("preview_sort", {
      input: {
        src: state.src,
        target_root: state.targetRoot,
        rules: effectiveRules(),
        fallthrough: state.fallthrough,
        items: state.items,
      },
    });
  } catch (err) {
    return failScan(errText(err));
  }
  // 含子目录时，上一次归好的成果就在目标夹里，递归扫描会把它们重新当素材扫进来：
  // 这些已经是产物，再参与一遍只会越复制越乱 —— 直接把「已经在自己的落点夹里」的剔掉
  let dropped = 0;
  if (state.recursive && Array.isArray(plan?.entries) && plan.entries.length) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const destDirs = new Set(plan.entries.map((e) => norm(e.dest_dir)).filter(Boolean));
    const kept = state.items.filter((it) => !destDirs.has(parentDir(it.path)));
    dropped = state.items.length - kept.length;
    if (dropped > 0) {
      state.items = kept;
      try {
        plan = await invoke("preview_sort", {
          input: {
            src: state.src,
            target_root: state.targetRoot,
            rules: effectiveRules(),
            fallthrough: state.fallthrough,
            items: kept,
          },
        });
      } catch (err) {
        return failScan(errText(err));
      }
    }
  }
  state.plan = plan;
  renderPreview();
  if (dropped > 0 && !state.items.length) {
    setSummary(`目录里的 ${dropped} 张图都已经在各自的夹里了，没有待归类的。`);
  }
  setStatus("");
  if (scan.truncated) toast(`图片超过 2000 张，只处理扫到的这些`, "error");
}

function failScan(msg) {
  setStatus("");
  toast(msg, "error");
  // 扫描/预览失败就把执行锁回去，免得拿着半截的旧计划点执行
  ui.apply.disabled = true;
  state.plan = null;
  ui.list.textContent = "";
}

/** 算出这次真正发给后端的规则。自动分夹开启时（默认），按目录里文件名的关键词
 * 自动补「移动」规则，再给「复制到每个夹」的关键词补 spread 规则——颜色这些不用手写，
 * 目录里有什么词就建什么夹。用户手写的规则优先级更高，同一个关键词不会重复。 */
function effectiveRules() {
  // 自动模式下，空白的占位行（没格式、没关键词、没目标）不能当规则——否则它会被
  // 当成「命中所有图」，把自动分夹全搅成不动
  const rules = state.rules
    .filter((r) => {
      if (!state.autoGroup) return true;
      const noExt = !(Array.isArray(r.exts) && r.exts.length);
      return !(noExt && !String(r.name_glob || "").trim() && !String(r.folder || "").trim());
    })
    .map((r) => ({ ...r }));
  if (!state.autoGroup) return rules;
  // 用户规则已经包住某个关键词，就不自动补（否则同一关键词既 move 又 spread）
  const userKws = rules
    .map((r) => String(r.name_glob || "").trim().toLowerCase())
    .filter((k) => k && !k.includes("*"));
  // 有一条「两个条件都空」的规则 = 命中所有图，自动分夹让位
  const anyAll = rules.some(
    (r) => !String(r.name_glob || "").trim() && !(Array.isArray(r.exts) ? r.exts.length : 0),
  );
  if (anyAll) return rules;
  const covered = (kw) => {
    const low = kw.toLowerCase();
    return userKws.some((k) => low.includes(k) || k.includes(low));
  };
  const spreadKws = String(state.spreadKws || "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 1) 先补「复制到每个夹」的关键词：不建自己的夹，只往别的夹里各放一份
  for (const kw of spreadKws) {
    if (!covered(kw)) rules.push({ exts: [], name_glob: kw, folder: "", action: "spread" });
  }
  // 2) 再按目录里实际出现的关键词补「移动」规则（颜色等自动建夹）
  const done = new Set();
  for (const it of state.items) {
    const kw = keywordOf(it.name);
    if (!kw) continue;
    const low = kw.toLowerCase();
    if (done.has(low)) continue;
    done.add(low);
    if (spreadKws.includes(kw)) continue;
    if (covered(kw)) continue;
    rules.push({ exts: [], name_glob: kw, folder: "", action: "move" });
  }
  return rules;
}

/** 手动排除/恢复：点一张图，**同一张图的所有落点一起**在「原判定」和 hold 之间来回。
 * 因为「复制到每个夹」会让一张图出现在好几个夹里，只取消其中一个夹的副本没意义 ——
 * 取消命中就是这张图整张不参与。没有落点的 hold（从未命中）点了也不能凭空恢复成
 * move —— 那会拿空落点去执行，报「落点不在目标根目录里」*/
function toggleHold(entry) {
  if (!state.plan) return;
  const same = state.plan.entries.filter((e) => e.src === entry.src);
  const activeNow = same.some((e) => e.action === "move" || e.action === "copy");
  if (activeNow) {
    for (const e of same) {
      if (e.action === "move" || e.action === "copy") {
        e.__orig = e.action;
        e.action = "hold";
      }
    }
  } else {
    for (const e of same) {
      if (e.action === "hold" && e.__orig) e.action = e.__orig;
    }
  }
  renderPreview();
}

function renderPreview() {
  const plan = state.plan;
  if (!plan) return;
  ui.list.textContent = "";

  const s = recount(plan.entries);
  // 命中了规则、却没填目标/关键词（所以没有去处）的落点数：这类只是「没告诉他去哪」，
  // 不能当成真的未命中，得在摘要里点出来，否则用户会以为「有文件却一个都没选中」
  const noTarget = plan.entries.filter((e) => e.action === "hold" && e.rule_index != null).length;
  setSummary(
    `共 ${s.files} 张图 → 将创建 ${s.folders} 个文件夹：移动 ${s.moves} 个落点、复制 ${s.copies} 个落点；` +
      `已在位 ${s.skip}，不参与 ${s.hold}。` +
      (noTarget
        ? `\n有 ${noTarget} 个落点命中了规则，但那条规则没填「名称关键词」也没填目标 —— 到规则里把关键词填上（如 红色），目标留空会自动建同名文件夹。`
        : "") +
      (state.mode === "copy" ? "\n（整体选了「复制」：本批一个源都不动，规则里的移动也改走复制）" : "") +
      (state.rules.length === 0 && !state.autoGroup
        ? `\n当前没有规则，${s.files} 张全进了兜底夹；勾上「自动按文件名分夹」或＋加一条手填。`
        : ""),
  );

  // 按目标目录分组；一张图命中多条规则就会出现在多个组里
  const groups = new Map();
  for (const e of plan.entries) {
    const key = e.action === "hold" ? "" : e.dest_dir;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  for (const key of keys) {
    const rows = groups.get(key);
    const head = document.createElement("div");
    head.className = "sort-grp";
    if (key === "") {
      head.textContent = "（不参与本次执行）";
    } else {
      // 组头带上这条夹来自哪几条规则，用户能对上「为什么这几张进这儿」；
      // 括号里的张数就是执行后这个夹里有几张图
      const labels = [...new Set(rows.map((e) => e.rule_label).filter(Boolean))].join("、");
      head.textContent = `${baseTail(key)}（执行后 ${rows.length} 张）` + (labels ? `　${labels}` : "");
    }
    ui.list.appendChild(head);
    for (const e of rows) ui.list.appendChild(renderPreviewRow(e));
  }
  ui.preview.disabled = false;
  ui.apply.disabled = s.actionable === 0;
}

/** 目标目录尾段（就展示最后那层，前缀太长没意义；完整路径靠 title） */
function baseTail(dir) {
  const parts = String(dir).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

function renderPreviewRow(e) {
  // 没有落点的 hold 有两种：
  //   · 真没命中任何规则（rule_index 为空）→ 「未命中」
  //   · 命中了规则但那条没填关键词/目标 → 「缺目标」（该去补规则，不是图的问题）
  // 两种都没有 dest_dir，都不能点着「恢复参与」（否则会拿空落点去执行）
  const noDest = e.action === "hold" && !e.dest_dir;
  const unmatched = noDest && e.rule_index == null;
  const missingTarget = noDest && e.rule_index != null;
  const row = document.createElement("div");
  row.className =
    "sort-row" + (e.action === "hold" ? " is-hold" : "") + (noDest ? " is-fixed" : "");
  const name = String(e.src).split(/[\\/]/).pop() || e.src;
  row.title = unmatched
    ? `${e.src}\n没命中任何规则，也没有兜底文件夹：原地不动`
    : missingTarget
      ? `${e.src}\n命中了规则，但规则没填「名称关键词」也没填目标，无处可去：去规则里补上`
      : `${e.src}\n→ ${e.dest_dir ? e.dest_dir + "/" + e.final_name : "原地不动"}\n点一下${
          e.action === "hold" ? "恢复参与" : "排除这张"
        }`;

  const badge = document.createElement("span");
  badge.className = "sort-badge " + e.action;
  badge.textContent = unmatched
    ? "未命中"
    : missingTarget
      ? "缺目标"
      : { move: "移", copy: "复", skip: "已在位", hold: "排除" }[e.action] || e.action;

  const file = document.createElement("span");
  file.className = "sort-file";
  file.textContent = name;

  row.append(badge, file);
  if (e.action === "move" || e.action === "copy") {
    const to = document.createElement("span");
    to.className = "sort-to";
    to.textContent = e.final_name && e.final_name !== name ? `→ ${e.final_name}` : "";
    row.appendChild(to);
  }
  if (!noDest) row.addEventListener("click", () => toggleHold(e));
  return row;
}

/** 现场重算计数（用户可能在界面上排除了一些，Rust 那份 summary 不再准）。
 * entries 是「落点」不是「文件」：同一张图命中多条规则会有好几条，文件数去重算 */
function recount(entries) {
  let actionable = 0,
    moves = 0,
    copies = 0,
    skip = 0,
    hold = 0;
  const folders = new Set();
  const files = new Set();
  for (const e of entries) {
    if (e.action === "move" || e.action === "copy") {
      actionable += 1;
      if (e.action === "move") moves += 1;
      else copies += 1;
      folders.add(e.dest_dir);
      files.add(e.src);
    } else if (e.action === "skip") skip += 1;
    else hold += 1;
  }
  return { actionable, moves, copies, skip, hold, folders: folders.size, files: files.size };
}

function setSummary(text) {
  if (ui.summary) ui.summary.textContent = text;
}

/* --------------------------------------------------------------------------
 * 执行：move 档两步确认，copy 档一步
 * ------------------------------------------------------------------------ */
async function doApply() {
  if (!state.plan) return toast("先预览一次再执行", "error");
  const s = recount(state.plan.entries);
  if (s.actionable === 0) return toast("没有要处理的图片（都被排除了？）", "error");

  if (state.mode === "move" && ui.apply.dataset.armed !== "1") {
    // 第一步只把按钮翻成确认态，绝不 Promise 直接执行（不可逆动作，给一次反悔）
    ui.apply.dataset.armed = "1";
    ui.apply.textContent = "确认执行移动？";
    setTimeout(() => {
      if (!ui.apply.isConnected) return;
      ui.apply.dataset.armed = "";
      ui.apply.textContent = "执行";
    }, 5000);
    return;
  }

  ui.apply.disabled = true;
  setStatus(state.mode === "move" ? "移动中…" : "复制中…");
  try {
    const out = await invoke("apply_sort", {
      input: {
        entries: state.plan.entries,
        mode: state.mode,
        // 用预览回来的那份 target_root（已是绝对路径且验过），保证落点校验口径一致
        target_root: state.plan.target_root,
      },
    });
    const r = out?.result || {};
    const line =
      `${r.moved || 0} ${state.mode === "move" ? "移" : "复"}成功` +
      `，跳过 ${r.skipped || 0}` +
      (r.failed ? `，失败 ${r.failed}` : "");
    setStatus("");
    toast(line, r.failed ? "error" : undefined);
    if (r.failed) console.error("[sort] 执行失败明细:", r.errors);
    // 记住回滚记录：撤销上一步只针对刚刚这一批（plan 马上会被重新预览换掉，先抓下来）
    if (Array.isArray(r.undo) && r.undo.length) {
      state.lastUndo = { ops: r.undo, targetRoot: state.plan.target_root };
    } else {
      // 这批全是「已在位/跳过」：没有任何改变，别把上一批的撤销记录留着冒充「刚这批」
      state.lastUndo = null;
    }
    syncUndoBtn();
  } catch (err) {
    setStatus("");
    toast(errText(err), "error");
  } finally {
    ui.apply.dataset.armed = "";
    ui.apply.textContent = "执行";
  }
  // 归完再预览一次：已归好的会判成 skip，用户能确认「重复执行不重复搬」
  await doPreview();
}

/** 撤销按钮的可用态：只有记着上一批落盘操作时才点得动 */
function syncUndoBtn() {
  if (!ui.undo) return;
  const n = state.lastUndo?.ops?.length || 0;
  ui.undo.disabled = n === 0;
  ui.undo.title = n
    ? `撤销上一次执行：移回移走的 ${n} 个落点、删掉复制出来的副本`
    : "还没有可撤销的操作（执行成功一批后才可用）";
}

/* --------------------------------------------------------------------------
 * 撤销上一步：按执行时记下的回滚记录倒着来
 *   · move 条目 → 从新位置移回原路径（原位置被占就换名，不覆盖）
 *   · copy 条目 → 删掉复制出来的那份副本
 * 删副本/移文件都算不可逆动作，同样走两步确认
 * ------------------------------------------------------------------------ */
async function doUndo() {
  const last = state.lastUndo;
  if (!last || !last.ops?.length) return toast("没有可撤销的操作", "error");

  if (ui.undo.dataset.armed !== "1") {
    ui.undo.dataset.armed = "1";
    ui.undo.textContent = "确认撤销？";
    setTimeout(() => {
      if (!ui.undo.isConnected) return;
      ui.undo.dataset.armed = "";
      ui.undo.textContent = "撤销上一步";
    }, 5000);
    return;
  }

  ui.undo.disabled = true;
  setStatus("撤销中…");
  try {
    const out = await invoke("undo_sort", {
      input: { ops: last.ops, target_root: last.targetRoot },
    });
    const r = out?.result || {};
    setStatus("");
    const line =
      `已撤销：移回 ${r.restored || 0} 张` +
      `，删掉副本 ${r.removed || 0} 个` +
      (r.failed ? `，失败 ${r.failed}` : "");
    toast(line, r.failed ? "error" : undefined);
    if (r.failed) console.error("[sort] 撤销失败明细:", r.errors);
    state.lastUndo = null;
  } catch (err) {
    setStatus("");
    toast(errText(err), "error");
  } finally {
    ui.undo.dataset.armed = "";
    ui.undo.textContent = "撤销上一步";
    syncUndoBtn();
  }
  // 撤完重新扫一遍：移回的文件会重新出现在列表里
  await doPreview();
}

/* --------------------------------------------------------------------------
 * 方案存取：整份 sortPlans 覆盖式存进 prefs.json（Rust 那边只当不透明 JSON）
 * ------------------------------------------------------------------------ */
async function loadPlans() {
  if (!isTauriRuntime) return;
  try {
    const p = await invoke("get_prefs");
    state.plans = Array.isArray(p?.sort_plans) ? p.sort_plans : [];
  } catch (err) {
    console.warn("[sort] 读方案失败（当作没有）:", errText(err));
    state.plans = [];
  }
  renderPlanSelect();
}

function renderPlanSelect() {
  if (!ui.planSel) return;
  ui.planSel.textContent = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = state.rules.length ? "（当前未保存的规则）" : "（还没有方案）";
  ui.planSel.appendChild(ph);
  for (const plan of state.plans) {
    const o = document.createElement("option");
    o.value = plan.id || "";
    o.textContent = plan.name || "未命名";
    ui.planSel.appendChild(o);
  }
  ui.planSel.value = state.activePlanId || "";
}

/** 把界面上的规则/目标/源目录读进一个方案对象（rules 直接就是 snake_case JSON） */
function currentPlan(name, id) {
  return {
    id: id || newId(),
    name,
    // 源目录一起存：下次选这个方案，目录也带回来，不用每次重选
    src: state.src,
    rules: state.rules.map((r) => ({ ...blankRule(), ...r })),
    target_root: state.targetRoot,
    fallthrough: state.fallthrough,
    auto_group: state.autoGroup,
    spread_kws: state.spreadKws,
  };
}

async function savePlan() {
  syncFromInputs();
  const name = (ui.planName.value || "").trim();
  if (!name) return toast("先给方案起个名", "error");
  // 同名视为覆盖（用户就是冲着「更新这套」来的）；否则按选中的 id 更新，再否则新增
  const sameName = state.plans.find((p) => p.name === name);
  const id = sameName?.id || ui.planSel.value || newId();
  const plan = currentPlan(name, id);
  const at = state.plans.findIndex((p) => p.id === id);
  if (at >= 0) state.plans[at] = plan;
  else state.plans.push(plan);
  state.activePlanId = id;

  try {
    // set_prefs 是多词参数：前端传 camelCase 的 sortPlans（与 inboxLayout 同一条规则）
    await invoke("set_prefs", { sortPlans: state.plans });
    renderPlanSelect();
    ui.planSel.value = id;
    toast(sameName ? "方案已更新" : "方案已保存");
  } catch (err) {
    toast(errText(err), "error");
  }
}

function applyPlan(id) {
  const plan = state.plans.find((p) => p.id === id);
  if (!plan) return;
  state.activePlanId = id;
  state.rules = (Array.isArray(plan.rules) ? plan.rules : []).map((r) => ({
    ...blankRule(),
    ...r,
    // exts 老数据可能是字符串数组，统一成小写数组，缺了给空
    exts: Array.isArray(r.exts) ? r.exts.map((x) => String(x).toLowerCase()) : [],
  }));
  state.targetRoot = plan.target_root || "";
  state.fallthrough = plan.fallthrough || "";
  // 老方案可能没存这两项：缺了就保持界面现状，不当成「关掉自动分夹」
  if (plan.auto_group != null) {
    state.autoGroup = !!plan.auto_group;
    if (ui.auto) ui.auto.checked = state.autoGroup;
  }
  if (typeof plan.spread_kws === "string" && ui.spreadKw) {
    state.spreadKws = plan.spread_kws;
    ui.spreadKw.value = state.spreadKws;
  }
  // 源目录跟着方案走：选中方案就把目录填回去
  state.src = plan.src || "";
  if (ui.src) ui.src.value = state.src;
  ui.planName.value = plan.name || "";
  ui.target.value = state.targetRoot;
  ui.fall.value = state.fallthrough;
  renderRules();
  saveWorking();
  // 目录有效就顺手预览一次，省得再点一下
  if (state.src) doPreview().catch((e) => console.error("[sort] 方案预览失败:", e));
}

function newPlan() {
  state.activePlanId = null;
  state.rules = state.autoGroup ? [] : [blankRule()];
  ui.planName.value = "";
  ui.target.value = "";
  ui.fall.value = "其他";
  state.targetRoot = "";
  state.fallthrough = "其他";
  renderRules();
  renderPlanSelect();
  saveWorking();
}

async function delPlan() {
  const id = ui.planSel.value;
  if (!id) return toast("先在下拉里选一个要删的方案", "error");
  if (ui.delPlan.dataset.armed !== "1") {
    ui.delPlan.dataset.armed = "1";
    ui.delPlan.textContent = "确认删？";
    setTimeout(() => {
      if (!ui.delPlan.isConnected) return;
      ui.delPlan.dataset.armed = "";
      ui.delPlan.textContent = "删方案";
    }, 4000);
    return;
  }
  ui.delPlan.dataset.armed = "";
  ui.delPlan.textContent = "删方案";
  state.plans = state.plans.filter((p) => p.id !== id);
  if (state.activePlanId === id) state.activePlanId = null;
  try {
    await invoke("set_prefs", { sortPlans: state.plans });
    renderPlanSelect();
    toast("方案已删除");
  } catch (err) {
    toast(errText(err), "error");
  }
}

/* --------------------------------------------------------------------------
 * 目录选择与拖入
 * ------------------------------------------------------------------------ */
async function chooseSrc() {
  let picked = null;
  try {
    picked = await invoke("pick_folder", { title: "选择要归类的图片目录" });
  } catch (err) {
    return toast(errText(err), "error");
  }
  if (!picked) return; // 用户在原生对话框里取消：什么都别动
  ui.src.value = picked;
  syncFromInputs();
  await doPreview();
}

/** 拖进来的第一项当目录用（拖文件夹最常见）；是单张图就取它所在目录 */
function acceptDrop(paths) {
  const p = (paths || []).map(cleanPath).find(Boolean);
  if (!p) return;
  ui.src.value = p.replace(/[\\/]+$/, "");
  syncFromInputs();
  doPreview().catch((err) => console.error("[sort] 拖入后预览失败:", err));
}

/* --------------------------------------------------------------------------
 * 绑定
 * ------------------------------------------------------------------------ */
function setMode(mode) {
  state.mode = mode;
  ui.modeMove.classList.toggle("is-active", mode === "move");
  ui.modeCopy.classList.toggle("is-active", mode === "copy");
  // 换档改变了「执行会不会移走源文件」，确认态必须作废，且摘要要重画那句提示
  ui.apply.dataset.armed = "";
  ui.apply.textContent = "执行";
  saveWorking();
  if (state.plan) renderPreview();
}

function wire() {
  ui.pick.addEventListener("click", chooseSrc);
  ui.src.addEventListener("change", () => {
    syncFromInputs();
    ui.preview.disabled = !cleanPath(ui.src.value);
  });
  ui.rec.addEventListener("change", () => {
    syncFromInputs();
    if (state.src) doPreview().catch((e) => console.error(e));
  });
  ui.target.addEventListener("change", () => {
    syncFromInputs();
    saveWorking();
  });
  ui.fall.addEventListener("change", () => {
    syncFromInputs();
    saveWorking();
  });
  ui.preview.addEventListener("click", () => doPreview().catch((e) => console.error("[sort] 预览失败:", e)));
  ui.apply.addEventListener("click", () => doApply().catch((e) => console.error("[sort] 执行失败:", e)));
  if (ui.undo) {
    ui.undo.addEventListener("click", () => doUndo().catch((e) => console.error("[sort] 撤销失败:", e)));
  }
  ui.modeMove.addEventListener("click", () => setMode("move"));
  ui.modeCopy.addEventListener("click", () => setMode("copy"));
  ui.addRule.addEventListener("click", () => {
    state.rules.push(blankRule());
    renderRules();
    saveWorking();
  });
  if (ui.auto) {
    ui.auto.addEventListener("change", () => {
      syncFromInputs();
      renderRules();
      saveWorking();
      if (state.plan) doPreview().catch((e) => console.error(e));
    });
  }
  if (ui.spreadKw) {
    ui.spreadKw.addEventListener("change", () => {
      syncFromInputs();
      saveWorking();
      if (state.plan) doPreview().catch((e) => console.error(e));
    });
  }
  ui.savePlan.addEventListener("click", () => savePlan().catch((e) => console.error(e)));
  ui.newPlan.addEventListener("click", newPlan);
  ui.delPlan.addEventListener("click", () => delPlan().catch((e) => console.error(e)));
  ui.planSel.addEventListener("change", () => {
    const id = ui.planSel.value;
    if (id) applyPlan(id);
  });
}

/* --------------------------------------------------------------------------
 * 初始化
 * ------------------------------------------------------------------------ */
async function boot() {
  if (!isTauriRuntime) {
    setStatus("非 Tauri 环境，图片归类不可用");
    renderRules();
    return;
  }
  wire();
  registerDropHandler("sort", acceptDrop);
  // 先把上次（包括改代码重启前）正在编辑的规则恢复回来，再画表：否则重启就丢
  const restored = restoreWorking();
  if (restored && state.mode === "copy") setMode("copy");
  // 自动分夹模式下不强制塞空白规则行（空白行会被当成「命中所有图」）
  if (!state.rules.length && !state.autoGroup) state.rules = [blankRule()];
  renderRules();
  await loadPlans();
  syncUndoBtn();
  console.log("[sort] 归类视图初始化完成", restored ? "（已恢复上次规则）" : "");
}

boot().catch((err) => {
  console.error("[sort] 初始化失败:", err);
  setStatus("归类初始化失败: " + errText(err));
});
