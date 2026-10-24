/**
 * 缩放/同步核心算法的纯数学自检（与 js/main.js 中 applyZoom 保持同一公式）
 * 运行：node tools/zoom_math_check.js
 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function applyZoom(st, factor, anchor) {
  const target = clamp(st.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = target / st.scale;
  st.x = anchor.x - (anchor.x - st.x) * k;
  st.y = anchor.y - (anchor.y - st.y) * k;
  st.scale = target;
  return st;
}

/** 屏幕点 -> 图像像素坐标 */
const toImage = (st, screen) => ({
  x: (screen.x - st.x) / st.scale,
  y: (screen.y - st.y) / st.scale,
});

let failed = 0;
const assert = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

// 1) 锚点不变性：连续缩放 200 次，鼠标下的图像像素始终不动
{
  const st = { scale: 1, x: -120, y: -80 };
  const anchor = { x: 300, y: 220 };
  const before = toImage(st, anchor);
  let cur = st;
  for (let i = 0; i < 200; i++) {
    cur = applyZoom(cur, i % 2 ? 1.1 : 0.9, anchor);
  }
  const after = toImage(cur, anchor);
  assert(
    "锚点不变性（反复缩放后鼠标下的图像点未漂移）",
    Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6,
    `${before.x.toFixed(4)},${before.y.toFixed(4)} -> ${after.x.toFixed(4)},${after.y.toFixed(4)}`
  );
}

// 2) 倍率夹在 25%~800%
{
  const st = { scale: 1, x: 0, y: 0 };
  let cur = st;
  for (let i = 0; i < 500; i++) cur = applyZoom(cur, 1.25, { x: 100, y: 100 });
  assert("上限封顶 800%", cur.scale === MAX_SCALE, `scale=${cur.scale}`);
  cur = { scale: 1, x: 0, y: 0 };
  for (let i = 0; i < 500; cur = applyZoom(cur, 0.8, { x: 100, y: 100 }), i++);
  assert("下限封顶 25%", cur.scale === MIN_SCALE, `scale=${cur.scale}`);
}

// 3) 同步模式：两窗共享同一份状态后，同一屏幕点映射到同一图像坐标
{
  const a = { scale: 1, x: -50, y: -30 };
  const b = { scale: 0.4, x: 200, y: 900 };
  applyZoom(a, 3.7, { x: 410, y: 260 });
  Object.assign(b, a); // syncFrom(src) 的等价操作
  const p = { x: 120, y: 340 };
  const ia = toImage(a, p);
  const ib = toImage(b, p);
  assert(
    "同步后两窗同一屏幕位置对应同一图像像素",
    ia.x === ib.x && ia.y === ib.y,
    `A(${ia.x},${ia.y}) B(${ib.x},${ib.y})`
  );
}

// 4) 1:1 -> 800% 全程锚点误差仍在 1e-9 内（验收口径：放大到 800% 无漂移）
{
  const st = { scale: 1, x: 0, y: 0 };
  const anchor = { x: 640, y: 360 };
  const base = toImage(st, anchor);
  let cur = st;
  while (cur.scale < MAX_SCALE) cur = applyZoom(cur, 1.05, anchor);
  const got = toImage(cur, anchor);
  assert(
    "100% 放大到 800% 锚点误差 < 1e-9",
    Math.abs(got.x - base.x) < 1e-9 && Math.abs(got.y - base.y) < 1e-9,
    `误差 dx=${(got.x - base.x).toExponential(2)} dy=${(got.y - base.y).toExponential(2)}`
  );
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
