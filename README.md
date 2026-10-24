# 图片对比（image-compare）

一个 macOS / Windows 桌面小工具，三个视图常驻一个窗口，左侧竖排导航或 ⌘1/⌘2/⌘3 切换：

| 视图 | 干什么 |
|---|---|
| **图片对比** `compare` | 最多 4 张图并排，同步缩放/平移、适应窗口、100% 实际像素、网格或单图聚焦。走系统「打开方式」、拖文件进窗口，或**单击空窗直接把剪贴板里的图粘进来**；⌘C 复制当前图，粘进微信/Word 就是图片、粘进 Finder 是文件 |
| **局域网传输** `transfer` | 自己的「文件传输助手」。两台设备之间发文字、文件、文件夹，名字、大小、进度、收发历史都画成气泡；**跟微信一样首屏只看最近 10 条**，滚到顶（或点顶栏）再往前翻页；拖进来或 ⌘V 粘进来的东西即发（多台混用见第五节） |
| **文字收藏** `fav` | 三级树（分类 / 子分类 / 条目）记笔记，可复制全文、发到对端、直接在对比视图里打开；焦点不在输入框时 ⌘V 粘文字会自动开一个条目接住 |

**只绑定两台设备**：一旦绑定了某个 `device_id`，再发现第三台会被拒绝，必须手动解绑才能换。
（三台共用一个口令时的并存做法见第五节：它们可以同时往一台推，只是你只能主动发一台。）
**所有数据只存本机**，不跨设备同步、不上云（设计已确认）。

---

## 一、数据存在哪

数据目录由 Tauri 的 `app_data_dir` 决定，也就是应用标识 `cn.aibbl.image-compare`：

- **macOS**：`~/Library/Application Support/cn.aibbl.image-compare/`
- **Windows**：`%APPDATA%\cn.aibbl.image-compare\`（按标识推导，尚未在 Windows 实机复核）

目录下六个东西：

| 名字 | 是什么 | 写法 |
|---|---|---|
| `device.json` | 本机身份：`id` / `secret` / `name` / `passphrase`。**配对口令是明文存本地**，删掉它就等于换了台新设备 | 原子写（先写 `.xxx.tmp-*` 再 rename） |
| `peers.json` | 绑定的那台对端（名称、IP、端口、在线状态、last_seen）。只有一台，绑定即覆盖 | 原子写 |
| `messages.jsonl` | 聊天历史，**追加式** JSONL：一次状态变化就追加一行。读取时同一 `id` 取**最后**一行的内容、但按**首次出现**的顺序排列（不能因为更新了状态就跳到列表末尾），所以 sending→sent 只会显示最终态；翻页靠 `msg_history(limit, before)`：不传 `before` 给最近一页（默认 10 条），传了就是「这条之前再往前 N 条」，一页上限 500 | 只追加，不重写 |
| `favorites.json` | 三级收藏树，整份存成一个 JSON | 原子写 |
| `inbox/` | 收到的文件与文件夹，见下 | 收完自动摊平 |
| `pastebox/` | 粘进界面但剪贴板里只有位图数据的东西（截图、微信里复制的图）落盘成真实文件的地方 | **只增不删** |

### 收件箱 `inbox/` 的形状（重要）

UUID 批次目录**只是传输途中的工位**：文件先落到 `inbox/<批次ID>/…`，收到最后一个文件（`X-Last`）后立刻把里面唯一的顶层条目挪到收件箱根：

```
inbox/
├── 微信图片_20261024.jpg      ← 单张图、单个文件，平铺在这里
├── 简历 (1).pdf               ← 重名不覆盖，自动加 " (1)"
└── 课程资料/                   ← 整个文件夹保持原来的子树结构
    └── 第一章/讲义.pdf
```

挪不动（权限异常等）就退回工位目录留着，绝不丢文件；多于一个顶层条目（正常不会发生）也原样留在工位目录里。

### 粘贴暂存 `pastebox/`

剪贴板里是**文件**时不往这里写（直接用原路径）；只有是**位图数据**（⌘⇧4 截图、微信里右键复制的图片）
才会落成一个文件，名字 `剪贴板图片-<时间戳>.png`，重名自动加 ` (1)`。
落在这里之后它就是一个普通本地文件：能预览、能发对端、能另存为。

**同一份剪贴板内容反复粘只落一个文件**（按内容 sha256 认，只记最近一份）：
连着点四个空窗不会生四张一模一样的图 —— 以前会，看上去很像“粘不上/显示坏了”。

粘贴这条链路**不在运行时打日志**（排障期加的 `[clip] 剪贴板风味 / 字节数 / 落盘` 已拆掉）。
要看一次粘贴到底拿到了什么，跑只读探针（见第六节），它会把 `paste_paths` 的结果打出来；
要看剪贴板本身有什么类型，用 `osascript -l JavaScript` 列 `NSPasteboard.types`。

判“粘出来的是占位图标而不是图”的口径（手动看剪贴板时用得上）：
没有 `public.file-url`、而且位图尺寸是个整方的数（1024×1024 这类），
基本就是源只给了占位图标；粘十次会得到十张一模一样的图。

为什么不自动清：聊天气泡里的缩略图、`path` 字段指的就是这些文件，清掉就等于把历史消息里的图弄坏。
它们只来自你自己的粘贴，体积可控；真要腾空间就手动删整个目录（退出应用后再删）。

### 备份 / 迁移 / 清空

- **备份**：直接拷上面这六个东西即可，全是明文 JSON / JSONL，SQLite 之类一个都没有。
- **换机器**：拷过去再改 `peers.json` 里的对端地址即可；口令一致就能继续互认。
- **清空**：退出应用后删掉整个目录（下次启动会重新生成 `device.json`）。⚠️ 别在应用运行时删，会边写边丢。

---

## 二、每个文件是干什么的

```
mac-image-compare/
├── js/                     前端：原生 ES Module + DOM，没有框架、没有构建步骤
│   ├── index.html          唯一页面骨架，三个视图 + 抽屉 + 放大层都在这
│   ├── main.js             只做装配：导航、⌘1/⌘2/⌘3、平台文案、全局异常兜底
│   ├── api.js              invoke/listen 封装、视图状态、拖拽与粘贴的路由（drop + 悬停 + ⌘V）、toast
│   ├── view-compare.js     对比视图：图窗、同步缩放平移、键盘（含 ⌘C 复制图片）、原生拖拽落点判定
│   ├── view-transfer.js    传输视图：气泡渲染、图片缩略图与放大、另存为/复制、拖拽遮罩、配对面板
│   ├── view-favorites.js   收藏视图：三级树 CRUD、编辑抽屉、复制到剪贴板
│   └── style.css           全部样式（含 [hidden] 统一规则、CSS 变量主题）
├── src-tauri/              Rust 侧：网络、存储、安全全在这里，前端只发意图
│   ├── src/lib.rs          入口与通用命令：read_image（含魔数认类型）、pick_images、
│   │                       copy_text、单实例交接、命令注册表
│   ├── src/store.rs        device/peers/messages/favorites 读写、sha256 签名与 ±300s 时间窗、
│   │                       safe_rel_join 路径守卫、头值 base64 编解码、原子写
│   ├── src/http.rs         自研极简 HTTP/1.1 客户端（要流式进度回调，所以没用 ureq）
│   ├── src/favorites.rs    收藏树 CRUD 命令（分类最深三级、条目只能是叶子）
│   ├── src/clip.rs         系统剪贴板：paste_paths（粘文件/截图进来，mac 走 NSPasteboard、
│   │                       windows 走 CF_HDROP/CF_DIB）与 copy_as_file（mac 上一次挂
│   │                       「文件 URL + PNG 位图」两味，粘出去既能当文件也能当图片）
│   ├── src/pair.rs         配对命令：口令、本机名、手动 IP 兜底、解绑、心跳自动绑定
│   ├── src/net/mod.rs      Hub = 这块功能的唯一运行时状态（本机身份、端口、对端、
│   │                       候选表、批次累计），以及 save_path_as 等命令
│   ├── src/net/server.rs   接收端：GET /ping、POST /msg、PUT /file；
│   │                       流式落盘边写边算 sha256；批次摊平 flatten_batch
│   ├── src/net/client.rs   发送端：心跳、文件夹递归成逐文件 PUT、整批大小申报
│   ├── src/net/discover.rs mDNS 广播并浏览 _imagecmp._tcp
│   ├── tauri.conf.json     窗口/CSP/文件关联/bundle 目标（版本号在这里）
│   ├── Cargo.toml          crate 版本与依赖（版本号在这里，Cargo.lock 自动跟随）
│   ├── Info.plist          macOS 补充 plist（最低系统版本等）
│   └── capabilities/       权限声明：只有 core 基础四项，网络与文件全走自定义命令
├── tools/
│   ├── net_selftest.mjs    对**运行中的实例**做局域网协议端到端自检（见下）
│   ├── paste_route_check.mjs 粘贴分流的纯逻辑自检（拿真 api.js + 假 DOM 跑，见下）
│   ├── zoom_math_check.js  缩放数学回归：锚点不变性、上下限封顶、双窗同步
│   ├── clip-win-check/     壳工程：在 mac 上给 clip.rs 的 Windows 分支做类型检查（见第七节第 8 条），
│   │                       内含 onlytiff.js（备「剪贴板里只有 TIFF」）、onlyfileurl.js（备「只有
│   │                       file-url 且只给 data」）、restore_clip.js（探针跑完把剪贴板还原给用户）
│   └── make_icon.py        从 assets/app-icon-source.png 生成各尺寸图标
├── assets/                 图标源图
└── .github/workflows/build.yml  CI：macOS(.app) + Windows(.nsis) 矩阵，推 tag 建 Release
```

---

## 三、跑起来 / 打包

```bash
npm install                      # 只装 @tauri-apps/cli

npm run dev                      # 开发：vite + rust 热重载
RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin npx tauri build --bundles app
```

> **Apple Silicon 必须显式指定 `stable-aarch64-apple-darwin`**，否则可能编出 x86 包、在 M 机上靠 Rosetta 跑或直接白屏。

发版要改**两处版本号**：`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml`（`Cargo.lock` 由 cargo 自动更新）。`package.json` 里的 `version` 只是 npm 元数据，不参与打包，当前仍是 `0.1.0`。

发布流程：

```bash
git tag -a v0.2.1 -m "说明"
git push origin main && git push origin v0.2.1   # tag 触发 CI 出双平台包并建 Release
```

CI 里 `RELEASE_TAG` 非空才创建 Release；只推分支不带 tag 时产物只进 Artifacts。GitHub Actions 之外本机没有别的发版通道（本仓库走 SSH，HTTPS 不可用）。

### 验证手段

```bash
cd src-tauri && RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin cargo test --lib   # 单元测试（含收件箱摊平、剪贴板落盘命名与 file URL 解码）
node tools/zoom_math_check.js                                                   # 对比视图零回归
node tools/paste_route_check.mjs                                                # 粘贴分流：什么时候该抢、抢来交给谁
node tools/net_selftest.mjs                                                     # 端到端协议自检
```

剪贴板这两头都没法在普通单测里跑（要碰真的系统剪贴板），所以另有一个真机探针：

```bash
cd src-tauri && cargo test --lib -- --ignored clip::real_clipboard   # 读一次剪贴板，再把一张真 PNG 写回去
cd src-tauri && cargo test --lib -- --ignored clip::只读剪贴板探针 --nocapture  # 只读：打印 paste_paths 拿到了什么，不碰剪贴板
osascript -e 'set the clipboard to (POSIX file "/某张/图.png")'                  # 备料：当文件复制
osascript -e 'set the clipboard to (read (POSIX file "/某张/图.png") as «class PNGf»)'  # 备料：当位图
```

它会打印读到/写了什么。「只有位图、没有文件」这一岔要单独备料：osascript 往剪贴板放图时会顺手
补上一堆派生类型，public.png 永远存在，试不到 TIFF 分支；用 `onlytiff.js` 直接只声明 TIFF 一种：

```bash
sips -s format tiff 某张.png --out 某张.tiff
osascript -l JavaScript tools/clip-win-check/onlytiff.js 某张.tiff   # 注意：会盖掉用户当前剪贴板
```

探针跑完会把剪贴板换成它自己那张 1x1 图，要还原成用户原来那张：

```bash
osascript -l JavaScript tools/clip-win-check/restore_clip.js 原来那张.png
```

复制出去到底挂上了哪几味，直接列剪贴板看（两味都在才算对）：

```bash
osascript -l JavaScript -e 'ObjC.import("AppKit");var t=$.NSPasteboard.generalPasteboard.types;var o=[];for(var i=0;i<t.count;i++)o.push(ObjC.unwrap(t.objectAtIndex(i)));o.join("\n");'
# 期望看到 public.file-url 与 public.png 同时存在
```

落盘结果用 `file` / `sips` 看一眼是不是张完整 PNG（本次实测 68944 字节的 TIFF 转出了 6803 字节的 128×128 PNG）。

`net_selftest.mjs` 三种用法：

```bash
node tools/net_selftest.mjs                            # 打本机，口令从 device.json 读
node tools/net_selftest.mjs <配对口令>                  # 打本机，显式给口令
node tools/net_selftest.mjs <口令> --host 192.168.1.20  # 打另一台，只看状态码
```

它覆盖：未签名 403、错口令 403、正确签名 200、`/msg` 落库、中文子目录流式 PUT 字节一致、
sha256 不符 422 不留残档、四种路径穿越全 400、单文件摊平成 `inbox/<名字>`、重名加 `(1)`、
文件夹整批大小与子树搬迁。脚本自己登记并清理写进收件箱的测试文件，`messages.jsonl` 不动。

⚠️ **跑之前确认没有任何实例还在跑**：应用启用了单实例插件，第二个进程只会把参数交给已运行的实例然后立刻退出
（还会把对方窗口顶到前台），你的请求实际会打到那台正在运行的实例上，表现为口令不匹配的一堆 FAIL。
**绝不要**为了「干净环境」去删应用数据目录 —— 那里是真实聊天记录与收件箱，删了不可恢复。

---

## 四、局域网这一套的约定

页面 origin 是 `ipc://localhost`，在 webview 里直接 `fetch` 局域网地址会被混合内容策略与 CSP 双重拦掉，
所以**网络全部实现在 Rust 侧**，前端只 `invoke` + `listen`，不新增任何 capability 权限。

- **端口**：默认 `45789`，被占用时依次 +1，最多试 10 个。两台机器各自监听，实际端口在连接面板上显示。
- **发现**：mDNS 广播并浏览 `_imagecmp._tcp.local.`。公司网络 / VPN 常屏蔽 mDNS，看不到设备就用「手动 IP」绑定。
  注意 macOS 上主机名必须以 `.local.` 结尾（带尾点），否则 mdns-sd 注册会失败。
- **鉴权**：请求头 `X-Device` / `X-Ts` / `X-Sig`，签名 = `sha256(口令|设备ID|时间戳|body摘要)`，时间窗 ±300 秒。
  **未设口令时一律 403**，避免误把开放端口当传文件通道。
- **文件头**：`X-Size` / `X-Sha256` / `X-Name` / `X-Rel-Path` / `X-Batch` / `X-Last` / `X-Batch-Size`。
  头值只能 ASCII，所以中文名与相对路径统一 base64；发送前显式拒绝非 ASCII 或含换行的头。
- **校验**：边流式写盘边算 sha256，与 `X-Sha256` 不符就删掉临时文件回 422，不留半成品。
- **路径守卫**：`X-Rel-Path` 只允许 `Component::Normal`，`..` / 绝对路径 / 符号链接组件一律 400。
- **大小上限**：`/msg` 1MB，单文件 8GB。聊天里的图片预览另有口径：≤4MB 自动出图，>40MB 不解图，
  引导用「在对比中打开」。
- **Windows 第一次监听会弹防火墙授权**，不点允许就对端永远发现不了本机（走手动 IP 也一样连不上）。

---

## 五、多台（≥3）怎么凑合用

一句话结论：**三台同时往一台推可以；一台同时给三台推不行。**

为什么能“同时收”：`/ping` `/msg` `/file` 只校验口令签名，**不校验发送方是不是你绑定的那台**
（`X-Device` 只是签名的输入之一）；接收端每个请求一个线程，批次状态按 `batch id` 隔离在
`Hub.batches`，所以多台并发推互不串，传大文件时别人的请求也进得来。

为什么只能“主动发一台”：`peers.json` 存的是单个对象，已绑定时 `bind_peer_addr` 直接报
「本应用只支持两台」，必须先解绑。没有群发，文字消息同样只发给绑定的那一台。

### 拓扑得想清楚（三台两两随时互发做不到）

| 想要的效果 | 怎么绑 | 结果 |
|---|---|---|
| 往主力机汇拢（最常见） | Mac 绑 B；B 绑 Mac；C 绑 Mac | B↔Mac 双向；C 只能推给 Mac，Mac 要主动发给 C 得临时换绑 |
| A、B 常用，C 偶尔 | 同上，需要时 Mac 侧解绑→重绑 C | 换绑约 2 秒，但注意下面“来源标签会串” |
| 三台两两随时互发 | **做不到** | 只能临时换绑 |

### 首次准备清单

1. 三台填**完全相同**的配对口令（≥ 4 字符），设备名改成一眼认得出的（上限 40 字符）。
2. **Windows 第一次监听会弹防火墙授权，必须点「允许」**。不点对端永远发现不了本机，走手动 IP 也一样连不上。
3. 每台的实际监听端口看连接面板。默认 45789，被占自动 +1，**三台端口很可能不一样**，手动 IP 时要填对。
4. 三台系统时间对齐。签名有 ±300 秒时间窗，超窗报的是「配对口令不匹配或时间戳超窗」，极易误判成口令写错。
5. 绑定入口：「已发现」里点一下即可（先发 `/ping` 校口令，一致才绑）；mDNS 被公司网络/VPN 屏蔽时直接走手动 IP。

### 两条纪律

- **别同名同时推。** 重名判定是「先看存在、再改名挪过去」，两台同一瞬间都推 `讲义.pdf`，
  其中一个挪不动会退回工位目录 `inbox/<UUID>/…`（文件不丢，但位置难看）。文件名带上设备前缀最保险。
- **别把气泡上的来源当证据。** 界面显示的「谁发的」取的是**当前绑定的那台**，不是真实发送方，
  而且历史记录也是渲染时现取——一旦解绑重绑，**以前那三台推来的消息全会跟着改标签**。
  要留痕就在文件名或文字里自带（`【C】合同终稿.zip`），或者先发一句文字再发文件，靠时间轴对齐。

### 连不上时的排查顺序

1. 状态条写「接收服务未启动」→ 端口 45789~45798 全被占，或防火墙没放行（原因原文会带在状态条里）。
2. 「已发现设备：无」→ mDNS 被屏蔽（公司网络/VLAN/VPN 的常态），直接走手动 IP，别等。
3. 「对端离线」→ 那台 app 没开，或 DHCP 换了 IP。点「重新探测」，不行就重填 IP 绑定。
4. 「配对口令不匹配」→ 先怀疑系统时间（±300 秒窗），再怀疑某台改了口令忘改其它两台。
5. 另外两台没绑到时，在界面上只是「已发现」候选：不显示在线状态、不会自动重连。

### 要真做成多台，得动哪些地方

`peers.json` 单对象→数组；`Hub.peer` → 多台表 + 按 id 解绑；`send_text`/`send_paths` 加目标参数（选一台或群发）；
**协议里把来源做实**（`/msg`、`/file` 带发送方 id+名字，并真正写进消息）；心跳并发 N 台；前端连接面板变会话列表；
旧 `peers.json` 迁移。其中只有“来源身份”那条是协议 + 存储改动，**已落库的历史没法回溯修正**，要改就得早改。

---

## 六、快捷键

| 作用域 | 键 |
|---|---|
| 全局 | ⌘/Ctrl + 1 / 2 / 3 切视图；Esc 关闭图片放大层；⌘/Ctrl + V 把剪贴板里的图片/文件粘进**当前视图** |
| 传输视图 | Enter 发送、Shift+Enter 换行；**消息流滚到顶自动往前补一页（每页 10 条）**，内容不够一屏滚不动时点流上方的「加载更早的消息」；搜文字/切类型时会先把整份历史逐页拉齐再筛（否则只搜了最近那 10 条会让人误判「没搜到」）；文件气泡上有「另存为 / 复制 / 打开位置 /（图片）在对比中打开」 |
| 对比视图（焦点不在输入框时才生效） | **单击空窗 = 直接粘剪贴板里的图**（没图才退回文件选择框） · `⌘V` 进**你点过的那一格**（选中格会描一圈蓝边；那格已有图就直接换掉），没点过才找第一个空窗 · `⌘O` 打开图片 · `⌘C` 复制当前图（同步模式下是全部已载入的图；**单张图会同时带图片位图**，多张只能以文件形式） · `0`/`F` 适应窗口 · `1` 100% · `2` 单图 · `4` 网格 · `+`/`-` 缩放 · 方向键平移 |

---

## 七、几个反复踩过的点（改代码前先看）

1. **serde 字段一律 snake_case，不加 `rename_all`**。曾用 camelCase 序列化出 `dataUrl`，前端读 `data_url`
   拿到 `undefined`，表现是「图片解码失败」，排查成本极高。
2. **`input[type=file]` 在 WKWebView 里递出的 File 是 0 字节**（只能拿到名字/类型），所以选文件必须走 Rust 侧对话框。
   **paste 事件一样**：剪贴板里的文件/位图在 JS 里读不到内容，所以粘贴也只能在 Rust 侧读（clip.rs）；
   好处是拿到的是真路径，连文件夹都能粘。粘完把路径交给 `routeDrop`，跟拖拽走同一条下游。
3. **`hidden` 属性能不能生效取决于有没有 `.xxx { display: ... }` 盖住它**，style.css 里有一条
   `[hidden] { display: none !important }` 的统一规则，新增覆盖层时别再写高优先级的 display。
4. **拖拽遮罩必须 `pointer-events: none`**，否则会把 Tauri 原生 drag-drop 的 `drop` 事件吃掉。
5. **切视图时的 `clientWidth` 是 0**，隐藏期间不能做 fit 计算，要等 `onViewChange` 回来再重量一次。
6. 界面异常优先看日志：Rust 侧统一 `eprintln!`（`[net]` / `[xfer]` 前缀），前端 `console` 带 `[view]` 前缀。
7. 收到消息的 `peer` 字段存的是**接收那一刻本机绑定的对端 id**，不是真实发送方；多台混用时它不可信（见第五节）。
8. **clip.rs 的 Windows 分支在 mac 上只能靠壳工程做类型检查**：正式工程的 build.rs（tauri-build → winres）
   交叉到 windows 时要资源编译器（llvm-rc），本机没有，直接 `cargo check --target x86_64-pc-windows-msvc`
   会在 build script 里 panic。`tools/clip-win-check/` 就是为了绕过这一层：它用 `#[path]` 把 clip.rs 原样
   include 进来，再补 store / net::server 几个最小桩，依赖版本与正式工程一致：

   ```bash
   rustup target add x86_64-pc-windows-msvc
   cd tools/clip-win-check
   CARGO_TARGET_DIR=../../src-tauri/target cargo check --target x86_64-pc-windows-msvc --lib
   ```

   （共享 target 目录是为了重用已编好的 tauri 依赖，否则一次要重编几分钟）。
   这一步只保证能过类型检查，真正装包仍然只能靠 CI 的 windows 产物与实机验证。
9. **粘进来的图“显示不正常”，先查剪贴板再查代码**：源程序往剪贴板里放的可能就是它给这个文件画的
   **占位图标**（实测过一张 1024×1024 的“JPG 文档图标”位图，微信未下载完的图、云盘在线文件、
   网页里加载失败的 img 都是这个形状）。我们原样存进 pastebox，看上去就是“图错了”，其实链路全对。
   排查时靠只读探针（第六节）或 `osascript -l JavaScript` 列 `NSPasteboard.types` 看剪贴板内容，
   只看到 `public.png`/`public.tiff`、没有 `public.file-url`，
   说明源既没给路径也没给真图，改代码救不回来。
10. **Windows 的复制出口只挂了 CF_HDROP（文件），没挂图片位图**：mac 那份 PNG 是 NSBitmapImageRep
    现算的，Windows 要 CF_DIB 得走 WIC 解码，目前没有实机可验所以没写。
    影响：从我们 app ⌘C 出去再粘到 Windows 侧某些只收位图的目标会拿不到图（微信 Windows 版粘图文件会当文件发）。
11. **`public.file-url` 有两种给法**：有的来源只把它当**数据**写（`stringForType:` 返回 nil）。
    只读 string 的写法会把这种剪贴板误判成「没有文件」，退回去存那张**文件图标位图**，
    症状就是“粘出来的图永远是一个 JPG 文档图标”。现在 string 拿不到就按 UTF-8 解 data，
    两条路都空再兜一次 pasteboard 级的 `public.file-url`；备料用 `onlyfileurl.js`。
12. **微信网页版里“以文件形式发送的 JPG”，复制到的就是那张占位卡片**（实测）：
    浏览器里那张卡片本身就是一张 1024×1024 的图，⌘C 出去的就是它，
    跟本应用无关。判据：收到的文件名长成
    `_cgi-bin_mmwebwx-bin_webwxgetmsgimg__&MsgID=…&skey=…&mmweb_appid=wx_webfilehelper.jpg`。
    正确做法：先把文件**下载到本地**，再拖文件进窗口（或选中文件 ⌘C 后粘，走 file-url 分支拿原路径）。
    人肉判断口径：文档图标是“正方形 + 带 alpha + 四角全透明”，真照片与截图四角不会透明
    （实测：占位图 1024×1024 四角 alpha 全 0；真图 1234×1062 与截图 1059×549 四角均不透明）。
    程序里不再做这个自动识别（排障期加的 `looks_like_file_icon()` 与 `clip-note` 提示已拆）。
    **但先按 #14 排除“我们自己把有效 file-url 丢掉了”的情况** —— 四角透明的图标
    并不一定就是源的锅。
13. **早期版本会把收件箱消息的 `path` 按名字长度硬截**（还会削掉 `.jpg`），
    文件其实就在同一个目录里、只是名字更长，于是前端每次展开都报“缩略图读取失败”。
    现在启动时会跑一次 `Store::repair_inbox_paths()`：只认“名字≥ 100 字符 且
    同目录下恰好只有一个文件以它为前缀”这一种窄情形，找回就补写一条修正记录
    （JSONL 后写覆盖前写），幂等、不会把历史堆长。
14. **Finder 复制的文件，`public.file-url` 可能不是路径而是「文件 ID」**（本条才是“粘出来
    总是那张文档图标”的真凶）：长这样的 URL 直接取 path 会得到一个不存在的位置，
    于是被误判成“剪贴板里没有文件”，退回去存了随附的 `com.apple.icns` 图标：

    ```
    file:///.file/id=6571367.105483633
    ```

    认这种来源的特征：剪贴板类型里同时有 `com.apple.finder.noderef` / `fndf` / `com.apple.icns`。
    两层修法（`clip.rs`）：`resolve_id_url()` 走 `NSURL.filePathURL` 把 ID URL 转成真实路径；
    转不动再兜一层 `nsfilenames_paths()` —— 把已废弃但 Finder 仍在写的 `NSFilenamesPboardType`
    （一份字符串数组 plist）用 `NSPropertyListSerialization` 解出来。
    验证：只读探针在真实现场上拿到了完整中文长路径（`/Users/…/详情_13_副本2.jpg`）。
    注意：转完就是现成的文件系统路径，**不能再走一遍百分号解码**，否则中文会被拆坏。
15. **“点了 B 却粘进 A”：两层叠加的坑，只修一层不够**。
    第一层：单击空窗那条传了 `pane.key`，进的是点的那个窗；而全局 `⌘V` 走
    `routeDrop(paths)`，**不携带落点**，`registerDropHandler("compare", …)` 拿到
    `paneKey === undefined` 就退回 `fillPanes(paths, null)` —— 而它从第一个空窗开始铺，于是永远就是 A。
    第二层（只修第一层时会残留）：空窗单击处理里 `if (pane.loaded) return;` 写在最前面，
    **点一个已有图的窗格时连“选了哪格”都没记**，于是 ⌘V 依旧拿不到目标。
    定稿（`view-compare.js`）：`panePicked` 与 `activePane` **分开记**（`assign()` 也会改
    `activePane`，光靠它分不清“用户选的”还是“刚被自动铺上的”）；单击先 `setPicked(pane)`
    再判断是否空窗；`pasteTargetKey()` 优先给 `panePicked`（**已有图也照换**，换掉就是点的意图），
    被布局切走或从未点过才退回“第一个空窗”；拖拽有真实落点时仍按落点。
    选中格描一圈蓝边（`.viewport.is-picked`），否则“下一次粘贴会进哪儿”根本看不出来。
