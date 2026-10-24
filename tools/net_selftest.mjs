#!/usr/bin/env node
/* 局域网接收端的端到端自检：对着真正运行中的 app 发四种请求，把每条路由的状态码、
 * 落盘位置、路径守卫一次跑清楚。只在开发期手工执行：
 *   node tools/net_selftest.mjs <配对口令>                     # 打本机（需先启动 app）
 *   node tools/net_selftest.mjs <配对口令> --host 192.168.1.20 # 打另一台机器
 * 本机模式会读 device.json 并对收件箱做真实核对；远程模式只看状态码
 * （对端的 device.json 与落盘目录都在那台机器上，需过去逐项确认）。
 * 前置：被测那台的配对口令必须与命令行给的口令一致。 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const PASS = argv.find((a) => !a.startsWith("--"));
function opt(name, dft) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dft;
}
if (!PASS) {
  console.error("用法: node tools/net_selftest.mjs <配对口令> [--host IP] [--port 45789]");
  process.exit(2);
}
const HOST = opt("host", "127.0.0.1");
const PORT = Number(opt("port", "45789"));
const LOCAL = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

const DATA = path.join(
  os.homedir(),
  "Library/Application Support/cn.aibbl.image-compare"
);
// 远程时读不到对端的 device.json，签名里的 deviceId 可以是任意值：
// 服务端只把它当签名输入之一，不校验它是否认识
const DEV_ID = LOCAL
  ? JSON.parse(fs.readFileSync(path.join(DATA, "device.json"), "utf8")).id
  : "selftest-remote-peer";
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

/** 本机自检产生的收件箱目录，跑完顺手清掉，别污染真实数据 */
const madeBatches = [];
function markBatch(b) {
  if (LOCAL) madeBatches.push(b);
}

console.log(`目标 http://${HOST}:${PORT}  模式 ${LOCAL ? "本机（可核对落盘）" : "远程（只看状态码）"}\n`);

/* 1. 未签名必须被拒 */
{
  const r = await ask("GET", "/ping", {}, null);
  check("未签名 /ping 回 403", r.status === 403, r.status + " " + r.text);
}

/* 2. 正确签名可拿到身份 */
let pingBody = {};
{
  const r = await ask("GET", "/ping", signed({}, EMPTY_SHA), null);
  try {
    pingBody = JSON.parse(r.text);
  } catch {}
  const idOk = !LOCAL || pingBody.device_id === DEV_ID;
  check(
    "签名 /ping 回 200 且身份正确",
    r.status === 200 && pingBody.ok === true && pingBody.app === "image-compare" && idOk,
    r.status + " " + r.text
  );
  if (LOCAL && pingBody.port && pingBody.port !== PORT) {
    console.log(`提示  对端自报端口 ${pingBody.port}，与本次连接的 ${PORT} 不同`);
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
      const lines = fs.existsSync(path.join(DATA, "messages.jsonl"))
        ? fs.readFileSync(path.join(DATA, "messages.jsonl"), "utf8").trim().split("\n")
        : [];
      return lines.some((l) => l.includes(text));
    });
  }
}

/* 5. 中文 + 子目录的单文件流式上传：内容、名字、目录结构逐项核对 */
{
  const batch = "selftest" + Date.now();
  markBatch(batch);
  const content = Buffer.from("图片对比局域网自检内容 ×".repeat(400), "utf8");
  const rel = "自检目录/中文 文件名.txt";
  const headers = signed(
    {
      "X-Sha256": sha(content),
      "X-Size": String(content.length),
      "X-Name": b64("中文 文件名.txt"),
      "X-Rel-Path": b64(rel),
      "X-Batch": batch,
      "X-Last": "1",
    },
    sha(content)
  );
  const r = await ask("PUT", "/file", headers, content);
  check("中文子目录文件回 200", r.status === 200, r.status + " " + r.text);
  checkLocal("落盘字节与源文件一致", () => {
    const dest = path.join(DATA, "inbox", batch, rel);
    return fs.existsSync(dest) && fs.readFileSync(dest).equals(content);
  });
}

/* 6. sha256 不符 -> 422 且不留半成品 */
{
  const batch = "selftestbad" + Date.now();
  markBatch(batch);
  const content = Buffer.from("真内容", "utf8");
  const rel = "坏校验.txt";
  // /file 的签名摘要就是 X-Sha256，所以两者必须一起假造：
  // 签名能过（说明确实进了写盘分支），落盘后算出的真实哈希与 X-Sha256 不符 -> 422
  const fake = sha(Buffer.from("对端不该收到的摘要", "utf8"));
  const headers = signed(
    {
      "X-Sha256": fake,
      "X-Size": String(content.length),
      "X-Name": b64(rel),
      "X-Rel-Path": b64(rel),
      "X-Batch": batch,
      "X-Last": "1",
    },
    fake
  );
  const r = await ask("PUT", "/file", headers, content);
  check("sha256 不符回 422", r.status === 422, r.status + " " + r.text);
  checkLocal("校验失败后不留下文件", () =>
    !fs.existsSync(path.join(DATA, "inbox", batch, rel))
  );
}

/* 7. 路径穿越必须被拒 */
for (const rel of ["../逃逸.txt", "/etc/逃逸.txt", "a/../../逃逸.txt", ".."]) {
  const content = Buffer.from("x", "utf8");
  const headers = signed(
    {
      "X-Sha256": sha(content),
      "X-Size": String(content.length),
      "X-Name": b64("逃逸.txt"),
      "X-Rel-Path": b64(rel),
      "X-Batch": "selftestslip" + Date.now(),
      "X-Last": "1",
    },
    sha(content)
  );
  const r = await ask("PUT", "/file", headers, content);
  check(`拒绝非法相对路径 ${JSON.stringify(rel)}`, r.status === 400, r.status + " " + r.text);
}

/* 8. 收件箱里不能多出逃逸文件 */
checkLocal("路径守卫没有真的写出文件", () =>
  ["/tmp/逃逸.txt", path.join(DATA, "逃逸.txt")].every((p) => !fs.existsSync(p))
);

/* 收尾：删掉自检写进收件箱的东西 */
for (const b of madeBatches) {
  try {
    fs.rmSync(path.join(DATA, "inbox", b), { recursive: true, force: true });
  } catch (e) {
    console.log(`清理 ${b} 失败: ${e.message}`);
  }
}

console.log(`\n合计 PASS=${pass} FAIL=${fail}` + (skip ? ` SKIP=${skip}` : ""));
if (!LOCAL && skip) console.log("远程模式下跳过的落盘核对，请到对端机器的 inbox/ 目录里手工确认");
process.exit(fail ? 1 : 0);
