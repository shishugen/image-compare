#!/usr/bin/env node
/* 局域网接收端的端到端自检：对着真正运行中的 app 发四种请求，把每条路由的状态码、
 * 落盘位置、路径守卫一次跑清楚。只在开发期手工执行：
 *   node tools/net_selftest.mjs                          # 打本机，口令从 device.json 读
 *   node tools/net_selftest.mjs <配对口令>                # 打本机，显式给口令
 *   node tools/net_selftest.mjs <口令> --host 192.168.1.20  # 打另一台机器
 * 本机模式会读 device.json 并对收件箱做真实核对；远程模式只看状态码
 * （对端的 device.json 与落盘目录都在那台机器上，需过去逐项确认）。
 * 前置：被测那台的配对口令必须与本次用的口令一致，且 app 正在运行。
 * 用完会自动清掉自己写进收件箱的东西；聊天记录 messages.jsonl 不动（条目都带「自检」字样）。 */
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

function signed(extra, digest) {
  const ts = Date.now();
  return {
    "X-Device": DEV_ID,
    "X-Ts": String(ts),
    "X-Sig": sha(`${PASS}|${DEV_ID}|${ts}|${digest}`),
    ...extra,
  };
}

/** 发一个文件。rel 决定收件箱里的相对路径，X-Name 是气泡上显示的名字。
 *  shaOverride 只改 X-Sha256（签名仍按覆盖后的值算），用来专门制造
 *  「签名能过、但头部声明的哈希与真实内容不符」这一岔路 */
async function putFile({ batch, rel, name, content, isLast, batchSize, shaOverride }) {
  const digest = shaOverride ?? sha(content);
  const headers = signed(
    {
      "X-Sha256": digest,
      "X-Size": String(content.length),
      "X-Name": b64(name),
      "X-Rel-Path": b64(rel),
      "X-Batch": batch,
      "X-Batch-Size": String(batchSize ?? content.length),
      "X-Last": isLast ? "1" : "0",
    },
    digest
  );
  return ask("PUT", "/file", headers, content);
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
/** messages.jsonl 最后一条（新到的消息一定在最末尾） */
function lastMessage() {
  const f = path.join(DATA, "messages.jsonl");
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
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
  const body = Buffer.from(
    JSON.stringify({ msg_id: crypto.randomUUID().replace(/-/g, ""), ts: Date.now(), text }),
    "utf8"
  );
  const r = await ask("POST", "/msg", signed({ "Content-Type": "application/json" }, sha(body)), body);
  if (r.status !== 200) {
    check("签名 /msg 回 200", false, r.status + " " + r.text);
  } else {
    check("签名 /msg 回 200", true);
    checkLocal("消息确实写进 messages.jsonl", () => {
      const lines = fs.readFileSync(path.join(DATA, "messages.jsonl"), "utf8").trim().split("\n");
      return lines.some((l) => l.includes(text));
    });
  }
}

/* 5. 中文名单文件流式上传：收完应摊平成 inbox/<名字>，不再有 UUID 工位目录 */
{
  const batch = "selftest" + Date.now();
  const name = "自检 中文文件.txt";
  const content = Buffer.from("图片对比局域网自检内容 ×".repeat(400), "utf8");
  mark(path.join(DATA, "inbox", name));
  const r = await putFile({ batch, rel: name, name, content, isLast: true });
  check("中文名单文件回 200", r.status === 200, r.status + " " + r.text);
  const landed = path.join(DATA, "inbox", name);
  checkLocal("落盘是 inbox/<文件名>（跟微信一样不套一层 UUID 目录）", () =>
    fs.existsSync(landed) && fs.readFileSync(landed).equals(content)
  );
  checkLocal("UUID 工位目录已被清掉", () => !fs.existsSync(path.join(DATA, "inbox", batch)));
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
  mark(path.join(DATA, "inbox", rel));
  mark(path.join(DATA, "inbox", batch));
  // /file 的签名摘要就是 X-Sha256，所以两者必须一起假造：
  // 签名能过（说明确实进了写盘分支），落盘后算出的真实哈希与 X-Sha256 不符 -> 422
  const fake = sha(Buffer.from("对端不该收到的摘要", "utf8"));
  const r = await putFile({ batch, rel, name: rel, content, isLast: true, shaOverride: fake });
  check("sha256 不符回 422", r.status === 422, r.status + " " + r.text);
  checkLocal("校验失败后不留下文件", () => !fs.existsSync(path.join(DATA, "inbox", rel)));
}

/* 7. 重名不覆盖：同一名字再发一次应落成 “名字 (1)” */
{
  const batch = "selfrestdup" + Date.now();
  const name = "自检 中文文件.txt";
  const dup = Buffer.from("第二次发的内容，和第一次不一样", "utf8");
  const r = await putFile({ batch, rel: name, name, content: dup, isLast: true });
  check("重名文件回 200", r.status === 200, r.status + " " + r.text);
  const second = path.join(DATA, "inbox", "自检 中文文件 (1).txt");
  mark(second);
  checkLocal("原件保留、新到的加 (1) 序号", () => {
    const first = path.join(DATA, "inbox", name);
    return (
      fs.existsSync(second) &&
      fs.readFileSync(second).equals(dup) &&
      fs.readFileSync(first).length !== dup.length
    );
  });
}

/* 8. 文件夹批次：所有 rel 都以文件夹名打头（真实发送端就是这样），
      收完应是 inbox/<文件夹名>/…，且消息报整批大小而不是最后一个文件的大小 */
{
  const batch = "selftestdir" + Date.now();
  const top = "自检文件夹";
  mark(path.join(DATA, "inbox", top));
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
  checkLocal("整个目录树搬到 inbox/<文件夹名> 下", () =>
    fs.existsSync(path.join(DATA, "inbox", top, "甲.txt")) &&
    fs.readFileSync(path.join(DATA, "inbox", top, "内层", "乙.txt")).equals(b)
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
