#!/usr/bin/env node
/* 局域网接收端的端到端自检：对着真正运行中的 app 发几种请求，把每条路由的状态码、
 * 落盘位置、路径守卫、「多身份各自一个会话」、以及「同一台靠 X-Session 分落好几个对话框」一次跑清楚。只在开发期手工执行：
 *   node tools/net_selftest.mjs                          # 打本机，口令从 device.json 读
 *   node tools/net_selftest.mjs <配对口令>                # 打本机，显式给口令
 *   node tools/net_selftest.mjs <口令> --host 192.168.1.20  # 打另一台机器
 * 本机模式会读 device.json 并对收件箱做真实核对；远程模式只看状态码
 * （对端的 device.json 与落盘目录都在那台机器上，需过去逐项确认）。
 * 前置：被测那台的配对口令必须与本次用的口令一致，且 app 正在运行。
 * 用完会自动清掉自己写进收件箱的东西；聊天记录 messages.jsonl 不动（条目都带「自检」字样），
 * 最后几段会在 sessions.json 里留下几行自检会话（两个身份 + 同一台的几个话题框），在界面上删掉即可（也只删会话与读指针）。 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const PASS_ARG = argv.find((a) => !a.startsWith("--"));
function opt(name, dft) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dft;
}
const HOST = opt("host", "127.0.0.1");
const PORT = Number(opt("port", "45789"));
const LOCAL = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

const DATA = path.join(
  os.homedir(),
  "Library/Application Support/cn.aibbl.image-compare"
);
let device = { id: "selftest-remote-peer", passphrase: "" };
if (LOCAL) {
  // 远程时读不到对端的 device.json，签名里的 deviceId 可以是任意值：
  // 服务端只把它当签名输入之一，不校验它是否认识
  device = JSON.parse(fs.readFileSync(path.join(DATA, "device.json"), "utf8"));
}
const PASS = PASS_ARG ?? device.passphrase;
if (!PASS) {
  console.error("没有可用口令：显式传 <口令>，或本机先在「配对设置」里设好口令");
  process.exit(2);
}
const DEV_ID = device.id;

/* 收件落脚点跟着 prefs.json 的 `inbox_layout` 走（day / month / flat）：自检拿这台机器
 * 的**真实偏好**算一遍，而不是假定根目录 —— 假定错了会连着红一大片，看起来像落盘坏了。
 * 工位目录（UUID 批次）永远在根下，不受摆放规则影响 */
const ROOT_INBOX = path.join(DATA, "inbox");
let boxLayout = "day";
try {
  boxLayout = JSON.parse(fs.readFileSync(path.join(DATA, "prefs.json"), "utf8")).inbox_layout || "day";
} catch {
  /* 远程模式 / 首启动没这份文件：按出厂口径算 */
}
if (!["day", "month", "flat"].includes(boxLayout)) boxLayout = "day";
const pad2 = (n) => String(n).padStart(2, "0");
const today = new Date();
const ymd = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
const INBOX =
  boxLayout === "day"
    ? path.join(ROOT_INBOX, `${ymd}-${pad2(today.getDate())}`)
    : boxLayout === "month"
      ? path.join(ROOT_INBOX, ymd)
      : ROOT_INBOX;
/** 落点目录的相对说法，用在断言的标题里（"." 表示根） */
const BOX = path.relative(DATA, INBOX) || ".";
// 与 client.rs 一样报自己的显示名：远程模式读不到 device.json，用个固定名字
const DEV_NAME = device.name || "selftest-remote-peer";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const EMPTY_SHA = sha(Buffer.alloc(0));

function ask(method, urlPath, headers, body) {
  // 显式给 Content-Length，不用 chunked：与 Rust 侧 http.rs 的写法保持一致
  const h = { ...headers };
  if (body && !("Content-Length" in h)) h["Content-Length"] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, method, path: urlPath, headers: h },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 以指定身份签名。与 client.rs::signed_headers 同构：显示名走 base64 头、
 *  不参与签名，签名里的设备 ID 必须与 X-Device 一致 */
function signedAs(id, name, extra, digest) {
  const ts = Date.now();
  return {
    "X-Device": id,
    "X-Device-Name": b64(name),
    "X-Ts": String(ts),
    "X-Sig": sha(`${PASS}|${id}|${ts}|${digest}`),
    ...extra,
  };
}

/** 会话头：与 client.rs::session_headers 同构。X-Session 是会话 ID（UUID 或设备 ID，
 *  本来就只有 ASCII）直接明文；X-Session-Name 可能含中文，走 base64。
 *  两个头都故意不进签名（与 X-Device-Name 同理）：改个框名不该让旧请求失效 */
function sessionHeaders(sess) {
  if (!sess || !sess.id) return {};
  const h = { "X-Session": sess.id };
  if (sess.name) h["X-Session-Name"] = b64(sess.name);
  return h;
}

function signed(extra, digest) {
  return signedAs(DEV_ID, DEV_NAME, extra, digest);
}

/** 发一个文件。rel 决定收件箱里的相对路径，X-Name 是气泡上显示的名字。
 *  shaOverride 只改 X-Sha256（签名仍按覆盖后的值算），用来专门制造
 *  「签名能过、但头部声明的哈希与真实内容不符」这一岔路。
 * as 是换一个设备身份发（双身份那段要验的就是这个）；
 *  session 是这次落在哪个对话框（同一台可以有好几个框） */
async function putFile({ batch, rel, name, content, isLast, batchSize, shaOverride, as, session }) {
  const digest = shaOverride ?? sha(content);
  const extra = {
    ...sessionHeaders(session),
    "X-Sha256": digest,
    "X-Size": String(content.length),
    "X-Name": b64(name),
    "X-Rel-Path": b64(rel),
    "X-Batch": batch,
    "X-Batch-Size": String(batchSize ?? content.length),
    "X-Last": isLast ? "1" : "0",
  };
  const headers = as ? signedAs(as.id, as.name, extra, digest) : signed(extra, digest);
  return ask("PUT", "/file", headers, content);
}

/** 发一条文字消息。as 同样只用来换一个设备身份；session 决定落进对端哪个框 */
async function postText(text, as, session) {
  const body = Buffer.from(
    JSON.stringify({ msg_id: crypto.randomUUID().replace(/-/g, ""), ts: Date.now(), text }),
    "utf8"
  );
  const extra = { ...sessionHeaders(session), "Content-Type": "application/json" };
  const digest = sha(body);
  const headers = as ? signedAs(as.id, as.name, extra, digest) : signed(extra, digest);
  return ask("POST", "/msg", headers, body);
}

let pass = 0;
let fail = 0;
let skip = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}  ${detail || ""}`);
  }
}
function checkLocal(name, fn) {
  if (!LOCAL) {
    skip += 1;
    console.log(`SKIP  ${name}（远程模式核对不到对端磁盘）`);
    return;
  }
  check(name, fn());
}

/** 自检写进收件箱的东西，跑完逐个清掉，不污染真实数据 */
const madePaths = [];
function mark(p) {
  if (LOCAL) madePaths.push(p);
}
/**
 * 把落点目录里同一基名的历史残留**立马清掉**（含 `名字 (1)` 这类序号），再把路径
 * 登记给收尾那次删除。只登记不删是不够的：本次发送会撞上残留而被加序号，
 * 「消息里的名字就是原名」就对不上了；换个摆放规则那次没清干净的残留就会这么传下去。
 */
function markFamily(dir, base) {
  if (!LOCAL) return;
  // 先把本次即将落地的原名登记上：目录里干净时下面的循环什么都不会做，
  // 不先登记就会留下这一轮刚落的文件（上一次就是这么把残留传下去的）
  mark(path.join(dir, base));
  const stem = path.parse(base).name;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // 目录还没建：第一次收东西时服务端自己建
  }
  for (const n of names) {
    if (n !== base && !n.startsWith(`${stem} (`)) continue;
    const p = path.join(dir, n);
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      console.log(`清历史残留 ${p} 失败: ${e.message}`);
    }
    mark(p);
  }
}
/** messages.jsonl 最后一条（新到的消息一定在最末尾） */
function lastMessage() {
  const lines = jsonlLines();
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}
/** 整个历史（自检靠它在里面找自己发的那几条，peer 字段就得从这核） */
function jsonlLines() {
  const f = path.join(DATA, "messages.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n");
}
/** sessions.json 的会话行：只读不写，app 那边是原子落盘，读不会拿到半截 */
function sessionRows() {
  try {
    const f = path.join(DATA, "sessions.json");
    return JSON.parse(fs.readFileSync(f, "utf8")).sessions || [];
  } catch {
    return [];
  }
}
/**
 * 找最近一条匹配的历史。**从末尾往前**找：同名文件每轮自检都会再发一遍，
 * 从头找会命中上一轮那条（path 指向换摆放规则之前的旧落点，peer 也是上一轮的）
 */
function findMessage(sub) {
  const lines = jsonlLines();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes(sub)) continue;
    try {
      const m = JSON.parse(lines[i]);
      if (m.text === sub || m.name === sub || (m.text || "").includes(sub)) return m;
    } catch {}
  }
  return null;
}

console.log(`目标 http://${HOST}:${PORT}  模式 ${LOCAL ? "本机（可核对落盘）" : "远程（只看状态码）"}\n`);

/* 1. 未签名必须被拒 */
{
  const r = await ask("GET", "/ping", {}, null);
  check("未签名 /ping 回 403", r.status === 403, r.status + " " + r.text);
}

/* 2. 正确签名可拿到身份 */
{
  const r = await ask("GET", "/ping", signed({}, EMPTY_SHA), null);
  let j = {};
  try {
    j = JSON.parse(r.text);
  } catch {}
  const idOk = !LOCAL || j.device_id === DEV_ID;
  check(
    "签名 /ping 回 200 且身份正确",
    r.status === 200 && j.ok === true && j.app === "image-compare" && idOk,
    r.status + " " + r.text
  );
  if (LOCAL && j.port && j.port !== PORT) {
    console.log(`提示  对端自报端口 ${j.port}，与本次连接的 ${PORT} 不同`);
  }
}

/* 3. 口令不对 -> 签名对不上 -> 403 */
{
  const ts = Date.now();
  const r = await ask(
    "GET",
    "/ping",
    {
      "X-Device": DEV_ID,
      "X-Ts": String(ts),
      "X-Sig": sha(`错的口令|${DEV_ID}|${ts}|${EMPTY_SHA}`),
    },
    null
  );
  check("口令不一致的 /ping 回 403", r.status === 403, r.status + " " + r.text);
}

/* 4. 文字消息落库 */
{
  const text = "自检消息 " + Date.now();
  const r = await postText(text);
  if (r.status !== 200) {
    check("签名 /msg 回 200", false, r.status + " " + r.text);
  } else {
    check("签名 /msg 回 200", true);
    checkLocal("消息确实写进 messages.jsonl", () => jsonlLines().some((l) => l.includes(text)));
  }
}

/* 5. 中文名单文件流式上传：收完应摊平成 <摆放>/<名字>，不再有 UUID 工位目录 */
{
  const batch = "selftest" + Date.now();
  const name = "自检 中文文件.txt";
  const content = Buffer.from("图片对比局域网自检内容 ×".repeat(400), "utf8");
  markFamily(INBOX, name);
  const r = await putFile({ batch, rel: name, name, content, isLast: true });
  check("中文名单文件回 200", r.status === 200, r.status + " " + r.text);
  const landed = path.join(INBOX, name);
  checkLocal(`${BOX}/<文件名>：摆了日期子目录就不再套 UUID，也真在里面`, () =>
    fs.existsSync(landed) && fs.readFileSync(landed).equals(content)
  );
  checkLocal("UUID 工位目录已被清掉（工位永远在根上，不受摆放规则影响）", () =>
    !fs.existsSync(path.join(ROOT_INBOX, batch))
  );
  checkLocal("消息里 kind=file、大小与路径都对", () => {
    const m = lastMessage();
    return m && m.kind === "file" && m.size === content.length && m.name === name && m.path === landed;
  });
}

/* 6. sha256 不符 -> 422 且不留半成品 */
{
  const batch = "selftestbad" + Date.now();
  const content = Buffer.from("真内容", "utf8");
  const rel = "自检坏校验.txt";
  markFamily(INBOX, rel);
  mark(path.join(ROOT_INBOX, batch));
  // /file 的签名摘要就是 X-Sha256，所以两者必须一起假造：
  // 签名能过（说明确实进了写盘分支），落盘后算出的真实哈希与 X-Sha256 不符 -> 422
  const fake = sha(Buffer.from("对端不该收到的摘要", "utf8"));
  const r = await putFile({ batch, rel, name: rel, content, isLast: true, shaOverride: fake });
  check("sha256 不符回 422", r.status === 422, r.status + " " + r.text);
  checkLocal("校验失败后不留下文件", () => !fs.existsSync(path.join(INBOX, rel)));
}

/* 7. 重名不覆盖：同一名字再发一次应落成 “名字 (1)” */
{
  const batch = "selfrestdup" + Date.now();
  const name = "自检 中文文件.txt";
  const dup = Buffer.from("第二次发的内容，和第一次不一样", "utf8");
  const r = await putFile({ batch, rel: name, name, content: dup, isLast: true });
  check("重名文件回 200", r.status === 200, r.status + " " + r.text);
  const second = path.join(INBOX, "自检 中文文件 (1).txt");
  mark(second);
  checkLocal("原件保留、新到的加 (1) 序号", () => {
    const first = path.join(INBOX, name);
    return (
      fs.existsSync(second) &&
      fs.readFileSync(second).equals(dup) &&
      fs.readFileSync(first).length !== dup.length
    );
  });
}

/* 8. 文件夹批次：所有 rel 都以文件夹名打头（真实发送端就是这样），
      收完应是 <摆放>/<文件夹名>/…，且消息报整批大小而不是最后一个文件的大小 */
{
  const batch = "selftestdir" + Date.now();
  const top = "自检文件夹";
  markFamily(INBOX, top);
  const a = Buffer.from("A".repeat(1024), "utf8");
  const b = Buffer.from("中文内容".repeat(700), "utf8");
  let bad = "";
  const total = a.length + b.length;
  for (const [rel, content, isLast] of [
    [`${top}/甲.txt`, a, false],
    [`${top}/内层/乙.txt`, b, true],
  ]) {
    const r = await putFile({ batch, rel, name: top, content, isLast, batchSize: total });
    if (r.status !== 200) bad = `${rel} 回 ${r.status} ${r.text}`;
  }
  check("同一批次连发两个文件均回 200", !bad, bad);
  checkLocal(`整个目录树搬到 ${BOX}/<文件夹名> 下`, () =>
    fs.existsSync(path.join(INBOX, top, "甲.txt")) &&
    fs.readFileSync(path.join(INBOX, top, "内层", "乙.txt")).equals(b)
  );
  checkLocal("文件夹消息报整批大小且归类为 folder", () => {
    const m = lastMessage();
    return m && m.kind === "folder" && m.size === total && m.name === top;
  });
}

/* 9. 路径穿越必须被拒 */
for (const rel of ["../逃逸.txt", "/etc/逃逸.txt", "a/../../逃逸.txt", ".."]) {
  const content = Buffer.from("x", "utf8");
  const r = await putFile({
    batch: "selftestslip" + Date.now(),
    rel,
    name: "逃逸.txt",
    content,
    isLast: true,
  });
  check(`拒绝非法相对路径 ${JSON.stringify(rel)}`, r.status === 400, r.status + " " + r.text);
}

/* 10. 收件箱里不能多出逃逸文件 */
checkLocal("路径守卫没有真的写出文件", () =>
  ["/tmp/逃逸.txt", path.join(DATA, "逃逸.txt")].every((p) => !fs.existsSync(p))
);

/* 11. 两个身份打同一台接收端：落库的 peer 必须是签名里那个 X-Device，
      而且一人一行会话。
      这里用的是「两个身份打一台」而不是「起两个 app 实例互发」：本机第二个实例
      跟第一个共用同一个 app_data_dir（同一份 messages.jsonl 与 sessions.json），
      「分别落进两个会话」根本核不出来；真两台要拿两台机器跑，本机跑不出那个拓扑 */
// 第 12 段要拿这个身份的会话 ID 演一次「冒用别人的框」，所以把它提到块外
const B_ID = "selftest-peer-" + Date.now().toString(16);
const B_NAME = "自检乙机";
{
  const stamp = Date.now();
  const mine = "自检甲消息 " + stamp;
  const theirs = "自检乙消息 " + stamp;
  const fileRel = "自检乙机的文件.txt";
  markFamily(INBOX, fileRel);
  const content = Buffer.from("两份身份共用一台接收端", "utf8");
  const r1 = await postText(mine);
  const r2 = await postText(theirs, { id: B_ID, name: B_NAME });
  const r3 = await putFile({
    batch: "selftesttwo" + stamp,
    rel: fileRel,
    name: fileRel,
    content,
    isLast: true,
    as: { id: B_ID, name: B_NAME },
  });
  check(
    "两个身份的 /msg 与 /file 都回 200",
    r1.status === 200 && r2.status === 200 && r3.status === 200,
    `${r1.status}/${r2.status}/${r3.status}`
  );
  checkLocal("文字消息的 peer 取自 X-Device，不是接收端绑的那台", () => {
    const a = findMessage(mine);
    const b = findMessage(theirs);
    return !!a && !!b && a.peer === DEV_ID && b.peer === B_ID;
  });
  checkLocal("文件消息的 peer 也是 X-Device（/file 与 /msg 两条落库路径同口径）", () => {
    const f = findMessage(fileRel);
    return !!f && f.kind === "file" && f.peer === B_ID;
  });
  checkLocal("两个身份各自一行会话，没被合并成一行", () => {
    // 基础对话的会话 ID 就等于设备 ID（老历史才能不改写就归位）。本段一概不带
    // X-Session，所以这两个身份名下都只该有那一行；多框是第 12 段的事
    const rows = sessionRows().filter(
      (s) => (s.peer === DEV_ID || s.peer === B_ID) && s.id === s.peer
    );
    return new Set(rows.map((s) => s.peer)).size === 2;
  });
  checkLocal("陌生身份自动建会话，名字用的是 X-Device-Name", () => {
    const row = sessionRows().find((s) => s.peer === B_ID);
    return !!row && row.name === B_NAME;
  });
  // 同一个身份再来一条：必须回到刚才那一行，不能多开一个框
  const again = await postText("自检乙机第二条 " + stamp, { id: B_ID, name: B_NAME });
  check("同身份的第二条 /msg 回 200", again.status === 200, String(again.status));
  checkLocal("同身份的第二条不会多出第二个框", () => sessionRows().filter((s) => s.peer === B_ID).length === 1);
  console.log(`提示  本段会在会话列表里留下两行（本机身份与「${B_NAME}」）`);
  console.log("      用会话栏那一行的「删除」清掉即可，聊天记录与收件箱都不受影响。");
}

/* 12. 同一台开多个对话框：落点由 X-Session 决定。会话 ID 是发起方生成的，
      接收端只看「这个 ID 本机有没有、属不属于发来的那台」。
      本机同样跑不出「两台各开一个框并互发」的拓扑，但入向分发是纯本地判断：
      用同一个 X-Device 换几个 X-Session，就能把落点规则的四条分支全部踩一遍 */
{
  const stamp = Date.now();
  // 两个本机没见过的会话 ID：模拟“同一台的第二个、第三个框”
  const T1 = "selftest-topic-" + stamp.toString(16);
  const T2 = "selftest-topic2-" + stamp.toString(16);
  const T1_NAME = "自检话题框";
  const noHead = "自检没有会话头 " + stamp; // 上一版根本不发 X-Session
  const topic1 = "自检话题一 " + stamp;
  const topic1Again = "自检话题一再发 " + stamp;
  const topic2 = "自检话题二 " + stamp;
  const hijack = "自检冒用他人会话 " + stamp; // 拿 B_ID 那个框的 ID 往本机框里塞消息
  const fileRel = "自检话题里的文件.txt";
  markFamily(INBOX, fileRel);
  const replies = [];
  replies.push(await postText(noHead));
  replies.push(await postText(topic1, undefined, { id: T1, name: T1_NAME }));
  // 同一个框的第二条，故意换一个会话名：名字只在头一回见到这个会话时用
  replies.push(await postText(topic1Again, undefined, { id: T1, name: "对方后来改的名" }));
  replies.push(await postText(topic2, undefined, { id: T2 }));
  replies.push(await postText(hijack, undefined, { id: B_ID }));
  replies.push(
    await putFile({
      batch: "selftesttopic" + stamp,
      rel: fileRel,
      name: fileRel,
      content: Buffer.from("落进话题框的一个文件", "utf8"),
      isLast: true,
      session: { id: T1, name: T1_NAME },
    })
  );
  check(
    "带与不带 X-Session 的 /msg 与 /file 都回 200",
    replies.every((r) => r.status === 200),
    replies.map((r) => `${r.status} ${r.text}`).join(" | ")
  );
  checkLocal("不带 X-Session 落进那台的基础对话（上一版兼容）", () => {
    const m = findMessage(noHead);
    return !!m && m.peer === DEV_ID && m.sid === DEV_ID;
  });
  checkLocal("本机没见过的会话 ID 被认下来，消息落进那个框", () => {
    const m = findMessage(topic1);
    return !!m && m.peer === DEV_ID && m.sid === T1;
  });
  checkLocal("同一个 X-Session 的第二条仍落进同一个框", () => findMessage(topic1Again)?.sid === T1);
  checkLocal("文件也按 X-Session 落进同一个话题框", () => {
    const m = findMessage(fileRel);
    return !!m && m.kind === "file" && m.sid === T1;
  });
  checkLocal("同一台的三个框各存各的：基础对话 / 话题一 / 话题二 互不混", () => {
    const sids = [noHead, topic1, topic2].map((t) => findMessage(t)?.sid);
    return sids[0] === DEV_ID && sids[1] === T1 && sids[2] === T2 && new Set(sids).size === 3;
  });
  checkLocal("新框自动进会话表，名字取 X-Session-Name", () => {
    const row = sessionRows().find((s) => s.id === T1);
    return !!row && row.peer === DEV_ID && row.name === T1_NAME;
  });
  checkLocal("对端后来改的会话名不会覆盖本机这一行（用户重命名不被打回）", () => {
    const row = sessionRows().find((s) => s.id === T1);
    return !!row && row.name === T1_NAME;
  });
  checkLocal("只带 X-Session 不带名字时，退回用设备名建框", () => {
    const row = sessionRows().find((s) => s.id === T2);
    return !!row && row.peer === DEV_ID && row.name === DEV_NAME;
  });
  checkLocal("冒用另一台的会话 ID：落回自己这台的基础对话", () => {
    const m = findMessage(hijack);
    return !!m && m.peer === DEV_ID && m.sid === DEV_ID;
  });
  checkLocal("被冒用的那个框归属没被搅乱，消息也没被插进去", () => {
    const row = sessionRows().find((s) => s.id === B_ID);
    return !!row && row.peer === B_ID && findMessage(hijack)?.sid !== B_ID;
  });
  console.log(`提示  本段在本机身份名下多开了两行话题框（${T1} / ${T2}）`);
}

/* 收尾：删掉自检写进收件箱的东西 */
for (const p of madePaths) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    console.log(`清理 ${p} 失败: ${e.message}`);
  }
}

console.log(`\n合计 PASS=${pass} FAIL=${fail}` + (skip ? ` SKIP=${skip}` : ""));
if (!LOCAL && skip) console.log("远程模式下跳过的落盘核对，请到对端机器的 inbox/ 目录里手工确认");
process.exit(fail ? 1 : 0);
