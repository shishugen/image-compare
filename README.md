# 图片对比（image-compare）

一个 macOS / Windows 桌面小工具，三个视图常驻一个窗口，左侧竖排导航或 ⌘1/⌘2/⌘3 切换：

| 视图 | 干什么 |
|---|---|
| **图片对比** `compare` | 最多 4 张图并排，同步缩放/平移、适应窗口、100% 实际像素、网格或单图聚焦。走系统「打开方式」或拖文件进窗口即可载入 |
| **局域网传输** `transfer` | 自己的「文件传输助手」。两台设备之间发文字、文件、文件夹，名字、大小、进度、收发历史都画成气泡（多台混用见第五节） |
| **文字收藏** `fav` | 三级树（分类 / 子分类 / 条目）记笔记，可复制全文、发到对端、直接在对比视图里打开 |

**只绑定两台设备**：一旦绑定了某个 `device_id`，再发现第三台会被拒绝，必须手动解绑才能换。
（三台共用一个口令时的并存做法见第五节：它们可以同时往一台推，只是你只能主动发一台。）
**所有数据只存本机**，不跨设备同步、不上云（设计已确认）。

---

## 一、数据存在哪

数据目录由 Tauri 的 `app_data_dir` 决定，也就是应用标识 `cn.aibbl.image-compare`：

- **macOS**：`~/Library/Application Support/cn.aibbl.image-compare/`
- **Windows**：`%APPDATA%\cn.aibbl.image-compare\`（按标识推导，尚未在 Windows 实机复核）

目录下五个东西：

| 名字 | 是什么 | 写法 |
|---|---|---|
| `device.json` | 本机身份：`id` / `secret` / `name` / `passphrase`。**配对口令是明文存本地**，删掉它就等于换了台新设备 | 原子写（先写 `.xxx.tmp-*` 再 rename） |
| `peers.json` | 绑定的那台对端（名称、IP、端口、在线状态、last_seen）。只有一台，绑定即覆盖 | 原子写 |
| `messages.jsonl` | 聊天历史，**追加式** JSONL：一次状态变化就追加一行。读取时同一 `id` 取**最后**一行的内容、但按**首次出现**的顺序排列（不能因为更新了状态就跳到列表末尾），所以 sending→sent 只会显示最终态；默认只回最近 500 条 | 只追加，不重写 |
| `favorites.json` | 三级收藏树，整份存成一个 JSON | 原子写 |
| `inbox/` | 收到的文件与文件夹，见下 | 收完自动摊平 |

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

### 备份 / 迁移 / 清空

- **备份**：直接拷上面这五个东西即可，全是明文 JSON / JSONL，SQLite 之类一个都没有。
- **换机器**：拷过去再改 `peers.json` 里的对端地址即可；口令一致就能继续互认。
- **清空**：退出应用后删掉整个目录（下次启动会重新生成 `device.json`）。⚠️ 别在应用运行时删，会边写边丢。

---

## 二、每个文件是干什么的

```
mac-image-compare/
├── js/                     前端：原生 ES Module + DOM，没有框架、没有构建步骤
│   ├── index.html          唯一页面骨架，三个视图 + 抽屉 + 放大层都在这
│   ├── main.js             只做装配：导航、⌘1/⌘2/⌘3、平台文案、全局异常兜底
│   ├── api.js              invoke/listen 封装、视图状态、拖拽路由（drop + 悬停）、toast
│   ├── view-compare.js     对比视图：图窗、同步缩放平移、键盘、原生拖拽落点判定
│   ├── view-transfer.js    传输视图：气泡渲染、图片缩略图与放大、另存为、拖拽遮罩、配对面板
│   ├── view-favorites.js   收藏视图：三级树 CRUD、编辑抽屉、复制到剪贴板
│   └── style.css           全部样式（含 [hidden] 统一规则、CSS 变量主题）
├── src-tauri/              Rust 侧：网络、存储、安全全在这里，前端只发意图
│   ├── src/lib.rs          入口与通用命令：read_image（含魔数认类型）、pick_images、
│   │                       copy_text、单实例交接、命令注册表
│   ├── src/store.rs        device/peers/messages/favorites 读写、sha256 签名与 ±300s 时间窗、
│   │                       safe_rel_join 路径守卫、头值 base64 编解码、原子写
│   ├── src/http.rs         自研极简 HTTP/1.1 客户端（要流式进度回调，所以没用 ureq）
│   ├── src/favorites.rs    收藏树 CRUD 命令（分类最深三级、条目只能是叶子）
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
│   ├── zoom_math_check.js  缩放数学回归：锚点不变性、上下限封顶、双窗同步
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
cd src-tauri && RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin cargo test --lib   # 单元测试（含收件箱摊平用例）
node tools/zoom_math_check.js                                                   # 对比视图零回归
node tools/net_selftest.mjs                                                     # 端到端协议自检
```

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
| 全局 | ⌘/Ctrl + 1 / 2 / 3 切视图；Esc 关闭图片放大层 |
| 传输视图 | Enter 发送、Shift+Enter 换行 |
| 对比视图（焦点不在输入框时才生效） | `⌘O` 打开图片 · `0`/`F` 适应窗口 · `1` 100% · `2` 单图 · `4` 网格 · `+`/`-` 缩放 · 方向键平移 |

---

## 七、几个反复踩过的点（改代码前先看）

1. **serde 字段一律 snake_case，不加 `rename_all`**。曾用 camelCase 序列化出 `dataUrl`，前端读 `data_url`
   拿到 `undefined`，表现是「图片解码失败」，排查成本极高。
2. **`input[type=file]` 在 WKWebView 里递出的 File 是 0 字节**（只能拿到名字/类型），所以选文件必须走 Rust 侧对话框。
3. **`hidden` 属性能不能生效取决于有没有 `.xxx { display: ... }` 盖住它**，style.css 里有一条
   `[hidden] { display: none !important }` 的统一规则，新增覆盖层时别再写高优先级的 display。
4. **拖拽遮罩必须 `pointer-events: none`**，否则会把 Tauri 原生 drag-drop 的 `drop` 事件吃掉。
5. **切视图时的 `clientWidth` 是 0**，隐藏期间不能做 fit 计算，要等 `onViewChange` 回来再重量一次。
6. 界面异常优先看日志：Rust 侧统一 `eprintln!`（`[net]` / `[xfer]` 前缀），前端 `console` 带 `[view]` 前缀。
7. 收到消息的 `peer` 字段存的是**接收那一刻本机绑定的对端 id**，不是真实发送方；多台混用时它不可信（见第五节）。
