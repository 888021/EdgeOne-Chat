# Cloudflare-Chat · EdgeOne 移植版

把原版 `cloudflare-chat v7.0.0`（Cloudflare Workers + R2）完整移植到**腾讯云 EdgeOne Makers**：
运行时用 **Cloud Functions (Node.js 20)**，持久化用 **Blob 存储**。

功能与 v7.0.0 对齐：多通道 AI 对话前端、PWA、语音朗读、Agent 模式（13 个零密钥工具）、
知识库 2.0（长期记忆 + 文档分页精读 + 分词全文检索）、Telegram 机器人。

---

## 一、为什么选 Cloud Functions + Blob，而不是 Edge Functions + KV

| 维度 | Cloud Functions + Blob（本方案） | Edge Functions + KV（备选） |
|---|---|---|
| 存储语义 | `set/get/delete/list(prefix)` 与 R2 几乎一一对应 | KV 的 key **只允许数字/字母/下划线** |
| 中文/斜杠 key | 原生支持 `kb/docs/甲骨文云ARM.md` | 必须十六进制转义，key 长度膨胀 2 倍且上限 512B |
| 一致性 | 支持 `consistency: "strong"` 强一致读 | 最终一致，跨节点最长 60s 脏读 |
| 执行时长 | 最长 **120s**（已配 `maxDuration: 120`） | CPU 时间 **200ms/次**，Agent 全文检索有超限风险 |
| 请求体上限 | 6 MB | 1 MB |
| 开通成本 | **零控制台操作**，命名空间自动创建 | 需手动开通 + 建命名空间 + 绑定项目 |

项目里 Agent 单轮预算默认 90 秒（`WEB_AGENT_TIMEOUT_MS`）、知识库要按标题存中文文件名、
记忆写完要立刻能检索——这三条都只有 Cloud Functions + Blob 能满足。

> KV 后端也一并实现了（`STORAGE_BACKEND=kv`），供你想切到 Edge Functions 时使用。

---

## 二、目录结构

```
cloudflare-chat-edgeone/
├── edgeone.json                  # EdgeOne 项目配置（构建/函数时长/响应头）
├── package.json                  # 依赖：@edgeone/pages-blob
├── tts-demo.html                 # 静态演示页（原样保留）
├── scripts/
│   └── selfcheck.mjs             # 本地自检：77 项用例，不需要 EdgeOne 环境
└── cloud-functions/              # EdgeOne Cloud Functions 路由目录
    ├── index.js                  # 路由：/          （聊天页面）
    ├── [[default]].js            # 路由：/*         （兜底，接管 /api/chat、/tg-webhook、/sw.js 等）
    └── _app/                     # 全部业务代码（下划线前缀，不参与路由）
        ├── entry.js              # ★ 入口：把 EdgeOne 的 onRequest(context) 适配成原 routeRequest()
        ├── images.js             # ★ 生图链路：图片转存 + /api/img/<id> 长期链接
        ├── store/
        │   ├── r2.js             # 原样保留：上层统一从这里读写
        │   ├── edge-store.js     # ★ 后端解析：为 env 注入 R2 兼容替身
        │   ├── blob-backend.js   # ★ R2 API → EdgeOne Blob
        │   └── kv-backend.js     # ★ R2 API → EdgeOne KV（备选）
        ├── agent/ kb/ net/ pwa/ telegram/ ui/ …   # 与原版逐文件对应
        └── constants.js auth.js channel.js rate-limit.js utils.js web-agent.js
```

**移植的核心思路**：原项目有 8 个文件直接调用 `env.R2.get/put/delete/list`。
与其逐个改造它们，不如提供一个**接口一致的 R2 替身**挂到 `env.R2` 上——
于是那 8 个文件（`store/kb.js`、`kb/registry.js`、`kb/doc-tools.js`、`agent/memory.js`、
`agent/resume.js`、`agent/mode.js`、`telegram/handler.js`、`store/r2.js`）**一行都没改**。

---

## 三、与原版的实际差异（全部改动清单）

| # | 位置 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `cloud-functions/index.js`、`[[default]].js` | 新增 | EdgeOne 用文件路由 + `onRequest(context)`，原版是 `export default { fetch }` |
| 2 | `_app/entry.js` | 新增（由 `_worker.js` 改造） | 把 `context.request/env/waitUntil` 适配成 `(request, env, ctx)`；`/healthz` 增加 `runtime`/`storage` 字段便于排障 |
| 3 | `_app/store/edge-store.js` 等 3 个文件 | 新增 | R2 → Blob / KV 适配层 |
| 4 | `_app/rate-limit.js` | 客户端 IP 头增加 `EO-Connecting-IP`、`X-Real-IP` | EdgeOne 不注入 `CF-Connecting-IP`（原头名仍保留，可双向迁移） |
| 5 | `_app/channel.js` | 模型配置缓存增加「配置签名」校验 | Cloud Functions 存在实例复用，改了环境变量后旧实例可能仍持旧配置 |
| 6 | `wrangler.toml` | 删除，改为 `edgeone.json` | `keep_vars`、R2 自动置备是 Cloudflare 专有概念 |
| 7 | `package.json` | 去掉 `wrangler`，加入 `@edgeone/pages-blob` | — |
| 8 | `_app/images.js` | **新增** | 生图链路重写：转存图片 + `/api/img/<id>` 长期链接（见第六节） |
| 9 | `_app/channel.js`、`_app/entry.js`、`_app/constants.js` | 图像请求体与响应解析重写 | 原实现只认 `data[0].url`，上游默认返回 `b64_json` 时必然丢图 |
| 10 | `_app/ui/app-core.js`、`styles.js`、`app-state.js` | 图片渲染器 + 样式 + localStorage 配额兜底 | 让生图结果能正常显示，且内联大图不会写挂整份会话 |
| 11 | `_app/store/edge-store.js`、`_app/entry.js` | 存储后端**定死 Blob**（`STORAGE_BACKEND` 默认 `blob`，不再自动回退 KV）；新增 Blob 绑定名自动发现与 `/healthz?probe=1` 真实读写自检 | 见第五节 |

**其余 40 个文件（UI、PWA、SSRF 防护、Agent 循环、工具链、Telegram 处理器）均为原样复制。**

---

## 四、部署

### 1. 推送代码到 Git 仓库

```bash
git init && git add -A && git commit -m "EdgeOne port"
git remote add origin <你的仓库地址> && git push -u origin main
```

### 2. 在 EdgeOne Makers 创建项目

1. 进入 [Makers 控制台](https://console.cloud.tencent.com/edgeone/pages) → **创建项目** → 选择该 Git 仓库。
2. **构建命令**留空，**输出目录**留空（本项目没有前端构建步骤，页面 HTML 由函数动态生成）。
   若控制台强制要求填写输出目录，填 `/`（即仓库根目录）。
3. **安装命令**保持默认 `npm install`（`edgeone.json` 已声明，用于安装 `@edgeone/pages-blob`）。
4. 点击部署。

> 部署后可在 `cloud-functions/_app/` 下看到所有函数代码；`edgeone.json` 已把 Cloud Functions
> 的 `maxDuration` 设为 120 秒，这是 Agent 长任务能跑完的前提。

### 3. 配置环境变量

项目 **设置 → 环境变量**，填入至少一个 AI 通道（格式与原版完全一致）：

```
API_URL_1 = https://api.deepseek.com/v1/chat/completions
API_KEY_1 = sk-xxxxxx
MODEL_1   = deepseek-chat:DeepSeek Chat, deepseek-reasoner:DeepSeek R1
```

可选（建议至少配上访问口令）：

```
ACCESS_PASSWORD    = 你的访问口令
RATE_LIMIT_PER_MIN = 60
MAX_TOKENS         = 4096
```

Telegram 机器人（可选）：

```
TG_BOT_TOKEN         = 从 @BotFather 拿到的 token
TG_WEBHOOK_SECRET    = openssl rand -hex 24 生成
TG_ALLOWED_CHAT_IDS  = 你自己的 chat id
```

设置完成后**重新部署一次**才会生效。完整变量表见原版 README 的「环境变量一览」。

### 4. 验证

打开站点，访问 `/healthz`，应看到：

```json
{ "ok": true, "t": 1750000000000, "runtime": "edgeone", "storage": "blob:cloudflare-chat" }
```

`storage` 字段是关键：
- `blob:cloudflare-chat` —— 持久化已接通（Blob 命名空间会在首次写入时**自动创建**）
- `blob(env.BLOB)` —— 用的是你在控制台绑定的那个 Blob 命名空间（绑定名会自动发现）
- `kv(globalThis.XXX_KV)` —— 走的是 KV 后端，括号内是自动发现的绑定名
- `memory` —— **未接通**，此时 Web 端聊天仍可用，但 Telegram 机器人、知识库、长期记忆会重启即丢

需要更多细节时，加一个环境变量 `STORAGE_DEBUG=1` 再重新部署，`/healthz` 会多出
`debug.blobError`（Blob 为什么没接上）、`debug.blobCandidates` / `debug.kvCandidates`
（扫描到的绑定名）。想确认存储「真的能写能读」而不只是「SDK 加载成功」，再加一个
`?probe=1`（即 `/healthz?probe=1`），它会真实写入并读回一个临时对象 —— 详见第五节。

### 5. Telegram Webhook（可选）

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<你的EdgeOne域名>/tg-webhook&secret_token=<SECRET>
```

---

## 五、存储配置与「自动绑定」的真实边界

先说结论：**Blob 是零控制台操作的；KV 无法自动置备，但绑定名可以自动发现。**

本项目**定死用 Blob**（`STORAGE_BACKEND` 默认 `blob`，取值拼错也按 Blob 处理）。
Blob 不可用时如实报 `memory`，**不会**悄悄换成 KV —— KV 的最终一致性与 key 字符集限制
是隐性差异，静默降级只会让问题更难排查。

| 环节 | Blob（默认） | KV（备选） |
|---|---|---|
| 开通存储账户 | 不需要，`getStore()` 首次调用时平台自动处理 | 需在控制台点一次「立即申请」 |
| 创建命名空间 | **自动**（首次 `getStore("cloudflare-chat")` 时平台自动创建） | 只能控制台手动创建（无 SDK / 无管理 API） |
| 绑定到项目 | **自动** | 只能控制台手动绑定 |
| 绑定名配置 | 不需要（`EO_BLOB_NAMESPACE` 可选；手动绑定也能被自动发现） | **不需要——代码会自动发现任意绑定名** |
| 可运行于 | Cloud Functions 与 Edge Functions | **仅 Edge Functions** |

> KV 之所以不能自动，是因为 EdgeOne 没有提供 KV 的 SDK 或管理 API：npm 上只有
> `@edgeone/pages-blob`，没有 `@edgeone/pages-kv`；API Token 只用于部署（CLI / MCP），
> 不含 KV 命名空间的创建与绑定能力。命名空间与项目的绑定关系是控制台操作。

### 代码层的自动发现

**Blob**：`store/edge-store.js` 的 `detectBlobBinding()` 会依次尝试 ——

1. `EO_BLOB_BINDING` 显式指定的名字（一般不需要填）
2. 常见默认名：`BLOB`、`CHAT_BLOB`、`STORAGE_BLOB`、`EO_BLOB`、`EDGEONE_BLOB`、`CLOUDFLARE_CHAT_BLOB`
3. 全量扫描 `env` / `context` / `globalThis` 的所有属性，按特征识别：
   带 `set` + `get` + `delete` + `list` 且**没有** `put` 即判定为 Blob Store

命中后优先使用**你绑定的**命名空间，避免出现「控制台绑了一个、数据写进另一个」的割裂。
都没命中才回落到 SDK 的 `getStore(EO_BLOB_NAMESPACE)`（默认 `cloudflare-chat`，自动创建）。
识别用「有没有 `put`」区分 Blob 与 KV，并显式排除本层自己挂载的 `env.R2`，避免自我套娃。

**KV**：`detectKvBinding()` 用同一套三层策略，特征键是 `get` + `put` + `delete`，
**绑定成什么变量名都能认出来**（`my_random_name` 也行）。第 3 层是真正的"自动"。

### 环境变量

| 环境变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `STORAGE_BACKEND` | `blob` / `kv` / `auto` / `none` | **`blob`** | 本项目定死 Blob。拼错取值也按 `blob` 处理（并在 `/healthz` 回显原始值 + warning）；`kv` 仅供 Edge Functions；`auto` 是旧的「先 Blob 再 KV」；`none` 强制纯内存 |
| `EO_BLOB_NAMESPACE` | 字符串 | `cloudflare-chat` | 未手动绑定时使用的 Blob 命名空间名，首次使用时平台自动创建 |
| `EO_BLOB_BINDING` | 字符串 | 不填即自动发现 | 手动指定 Blob 绑定名（一般不需要） |
| `EO_KV_BINDING` | 字符串 | 不填即自动发现 | 仅 `STORAGE_BACKEND=kv` 时有意义 |
| `STORAGE_DEBUG` | `1` | 不输出 | 设为 `1` 后 `/healthz` 附带后端探测详情；再加 `?probe=1` 会真实读写一次 |

### 排障：`STORAGE_DEBUG=1` 时 `/healthz` 的额外输出

```json
{
  "ok": true, "runtime": "edgeone", "storage": "memory",
  "debug": {
    "backend": "memory",
    "mode": "blob",
    "namespace": "cloudflare-chat",
    "blobError": "import 失败：Cannot find package '@edgeone/pages-blob'",
    "blobBindingUsed": null,
    "kvBindingUsed": null,
    "blobCandidates": [],
    "kvCandidates": [],
    "hint": "Blob 会自动创建命名空间、无需控制台操作；…"
  }
}
```

`blobError` 直接告诉你 Blob 为什么没接上（最常见就是依赖没装上），
`blobCandidates` / `kvCandidates` 列出扫描到的所有绑定名，
`mode` 回显 `STORAGE_BACKEND` 的原始取值（拼错时还会多一个 `warning` 字段）。
**默认关闭**，避免对外暴露内部绑定名。

### 验证存储是否「真的能用」：`?probe=1`

`/healthz` 的 `storage` 字段只说明后端**加载**成功。`getStore()` 返回对象不代表有权限、
有配额。要确认端到端可用，加 `?probe=1`：

```
https://<你的域名>/healthz?probe=1     # 需同时设置 STORAGE_DEBUG=1
```

它会真实写入、读回、再删除一个临时对象，输出：

```json
"debug": { "probe": { "ok": true, "backend": "blob:cloudflare-chat" } }
```

`ok:false` 时会带 `reason`。不加 `?probe=1` 时**不会**产生任何写操作，
所以把它当作常驻探针也不会污染存储。

---

## 六、生图（图像接口）配置

支持任何 OpenAI 风格的 `…/images/generations` 接口，例如 SenseNova 日日新：

```
API_URL_1 = https://token.sensenova.cn/v1/images/generations
API_KEY_1 = sk-xxxxxx
MODEL_1   = sensenova-u1.5-fast:日日新 U1.5 Fast
```

### 修复了什么

原实现在生图链路有三个问题，合起来表现为「图片生成不出来」：

| 问题 | 后果 | 现在 |
|---|---|---|
| 只读 `data[0].url` | 上游 `response_format` **默认是 `b64_json`**，响应里根本没有 `url` → 永远提示「图片生成失败或未返回格式」 | 显式声明 `response_format: "url"`，并同时兼容 `url` / `b64_json` / `choices[].message.content` 三种返回形态 |
| base64 只能内联进 Markdown | 聊天记录存在 localStorage（约 5MB 配额），一张 2K 图的 base64 就能把整份会话写挂；而 `saveSessions` 是静默吞错的，用户只会看到「历史记录莫名其妙没了」 | 转存到 Blob/KV，返回 `/api/img/<id>` 稳定链接；前端另加配额兜底，写不进去时降级为占位说明而不是整份丢失 |
| 直接使用上游 URL | 图像接口的 URL 是 **24 小时临时链接**，第二天回来图片全裂 | 默认把图片下载转存到自己域名，永久有效 |

### 新增接口

`GET /api/img/<id>` —— 读取转存后的图片。公开访问（`<img src>` 没法带自定义头），
靠随机且不可枚举的 id 保护，并严格校验 id 形态杜绝路径穿越。响应带
`Cache-Control: public, max-age=31536000, immutable`。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `IMAGE_PERSIST` | `1` | 是否把图片转存到自己存储。设 `0` 则直接用上游临时链接（省存储，但 24 小时后失效） |
| `IMAGE_MAX_MB` | `8` | 单张转存上限，超过则退回上游链接 |
| `IMAGE_TIMEOUT_MS` | `20000` | 下载上游图片的超时 |
| `IMAGE_RESPONSE_FORMAT` | `url` | 请求上游时的 `response_format` |
| `IMAGE_SIZE` | 不发送 | 如 `2048x2048`。需为 32 的倍数，512~4096，比例不超过 3:1 |
| `IMAGE_OUTPUT_FORMAT` | 不发送 | `png` / `jpeg` / `webp` |
| `IMAGE_WATERMARK` | 不发送 | 设 `false` 去掉日日新官方水印（公测期免费）。**不设则用上游默认值，即带水印** |
| `IMAGE_PROMPT_EXTEND` | 不发送 | 设 `false` 关闭提示词自动润色 |

推荐的 SenseNova 配置：

```
IMAGE_SIZE = 2048x2048
IMAGE_OUTPUT_FORMAT = png
IMAGE_WATERMARK = false
```

> `IMAGE_WATERMARK` / `IMAGE_PROMPT_EXTEND` 不配置时**不会出现在请求体里**，
> 这样对参数校验严格的其它图像接口，不会被多出来的字段打成 400。

### 几点提示

- 图像接口是**同步**的，生成期间前端会一直显示「正在生成」，属正常现象。
- 转存会占用存储（免费 1GB）。按 2K PNG 约 3MB 估算约可存 300 张；
  存储紧张时调小 `IMAGE_MAX_MB`，或用 `IMAGE_PERSIST=0` 关闭转存。
- 转存时会做 SSRF 校验（拦截内网 / 本机 / 云元数据地址），并要求响应
  `Content-Type` 必须是 `image/*`，避免把错误页当成图片存下来。
- 未绑定存储时会退回内联 base64 展示，并在图片下方明确提示「刷新后可能无法恢复」。

---

## 七、已知限制与取舍

这些都是平台差异导致的、**无法在代码层完全抹平**的点，请知悉：

1. **`list()` 不返回对象体积**。Blob 的 `list({ consistency: "strong" })` 只给 `key` 和 `etag`，
   所以知识库文档列表里的「大小」一栏会统一显示为 1 KB。**文档日期是正确的**（取自 frontmatter 的 `saved_at`）。
   这一条**没法修**：要拿到体积只能对每个 key 再发一次 `get`（或 stat），
   一个 50 篇文档的知识库就会从 1 次请求变成 51 次，得不偿失。如果你更在意体积显示，
   可以把 `kb/registry.js` 里的 `size` 改为在保存时把字节数写进 frontmatter，列的时候直接读 frontmatter。
2. **KV 后端的 key 长度上限**。KV key 上限 512 字节，本适配层用十六进制转义，
   相当于原始 key 最长约 256 字节。纯中文标题超过约 80 个汉字时会写入失败并抛出明确错误
   （而不是静默丢数据）。**Blob 后端没有这个限制。**
3. **KV 后端最终一致**。跨边缘节点最长 60 秒脏读，刚存的知识库文档可能短暂「列不出来」。
   **Blob 后端已默认走 `consistency: "strong"`，没有这个问题。**
4. **`get` 的 `range` 选项是模拟的**。Blob/KV 都不支持范围读取，适配层读全量后切片。
   本项目仅用于读 frontmatter 前 4096 字节，代价可接受。
5. **Cloud Functions 跑在云端地域而非边缘节点**（默认广州）。对本项目影响很小——
   瓶颈在上游大模型 API，不在这一段。
6. **`_app/` 目录不参与路由**依赖平台对下划线前缀的忽略规则。即使平台为它生成了路由，
   也只会让 `/_app/xxx` 这类路径返回错误，不影响正常功能。
7. **生图转存会占用存储**。默认 `IMAGE_PERSIST=1`，每张图约占 1~3 MB（取决于分辨率），
   免费 1GB 额度大约能存 300~800 张。存储紧张时把 `IMAGE_MAX_MB` 调小，
   或设 `IMAGE_PERSIST=0` 退回上游临时链接（代价是 24 小时后失效）。
8. **图像接口是同步的**，且本项目对图片只做「转存 + 渲染」，没有做缩略图或压缩。
   4K 图（`4096x4096`）单张可能超过 `IMAGE_MAX_MB` 上限而不被转存。

---

## 八、本地自检

不需要 EdgeOne 环境，也不需要安装任何依赖：

```bash
node scripts/selfcheck.mjs
```

覆盖 68 项用例，包括：

- 完整模块图能否加载（能捕获所有语法/导入错误）
- R2 契约在两个后端上的一致性：`put`/`get`/`get+range`/批量 `delete`/`list` 的
  `prefix`、`truncated`、`cursor` 语义
- KV 的 key 编码可逆性、前缀性质、超长 key 守卫
- 路由：`/`、`/healthz`、`/sw.js`、`/manifest.webmanifest`、`/icon-192.png`、`/api/chat`、404
- 多通道环境变量能否正确解析出模型下拉框
- **Blob 默认后端**：识别规则（有 `set` 无 `put`）、未设 `STORAGE_BACKEND` 时默认 Blob
  且**绝不静默降级到 KV**、任意绑定名自动发现、`EO_BLOB_BINDING` 优先、
  端到端接管为 `env.R2` 并真实读写成功
- **KV 绑定自动发现**：任意变量名可被识别、`EO_KV_BINDING` 优先、`CHAT_KV` 默认命中、
  `env.R2` 不被误判、无后端时安静退化为 memory
- `/healthz` 排障输出：`STORAGE_DEBUG=1` 时给出详情、`mode`/`namespace` 回显、
  拼错取值给 warning、`?probe=1` 的成败两条路径、默认不外泄
- **生图链路**：图像接口判定、`response_format` 默认值、可选参数透传、base64 编解码往返、
  转存与读回、路径穿越拦截、SSRF 拦截、非图片内容类型拒收、
  `b64_json`/`url`/多图/报错/非 JSON 五种响应形态、
  `GET /api/img/<id>` 经完整路由取回字节
- **生成页面本身的合法性**：把页面内联脚本抽出来单独 parse，
  防止模板字符串两层转义把前端写坏（这类错误服务端完全看不出来）
- **端到端**：挂上存储后端后，长期记忆写入/读回/md 镜像、同主题改口覆盖、
  知识库中文标题保存/列表/精读/删除/分词检索——**两个后端各跑一遍**

本地起服务调试（需先 `npm i -g edgeone`）：

```bash
edgeone pages dev
```

---

## 九、排障

| 现象 | 原因与处理 |
|---|---|
| `/healthz` 里 `storage` 是 `memory` | 持久化未接通。先设 `STORAGE_DEBUG=1` 看 `debug.blobError`：若是 `Cannot find package '@edgeone/pages-blob'`，说明依赖没装上，检查安装命令是否为 `npm install`；再确认 `STORAGE_BACKEND` 没被设成 `none`，也没拼错（拼错会原样回显在 `debug.mode` 并给出 `warning`） |
| `storage` 显示已接通，但重启后数据还是丢 | 用 `/healthz?probe=1`（需 `STORAGE_DEBUG=1`）做一次真实读写。`probe.ok:false` 说明 SDK 加载了但没权限/没配额，看 `probe.reason` |
| 在控制台绑了 Blob，但数据写到了别的命名空间 | 设 `STORAGE_DEBUG=1` 看 `debug.blobBindingUsed`：为 `null` 说明绑定没被识别。确认绑定的是 Blob 命名空间（不是 KV），或用 `EO_BLOB_BINDING` 显式指定变量名 |
| 想用 KV 但 `storage` 一直是 `memory` | KV 需要三步且都不可省：控制台开通 KV 账户 → 创建命名空间 → 绑定到项目。另注意 **KV 仅 Edge Functions 可用**，跑在 Cloud Functions 上的项目用不了 KV（本项目默认就是 Cloud Functions，建议直接用 Blob）。另外默认后端是 Blob，**不会自动退到 KV**，要显式设 `STORAGE_BACKEND=kv` |
| KV 绑定名不想用 `CHAT_KV` | 不用改，任意绑定名都能被自动发现。设 `STORAGE_DEBUG=1` 后看 `debug.kvCandidates` 确认是否扫到了 |
| 页面提示「未配置模型」 | 环境变量没配或配完没重新部署。注意 `MODEL_1` 的格式是 `模型ID:显示名`，多个用英文逗号分隔 |
| 聊天正常，但 Telegram 机器人不响应 | webhook 没设、`TG_ALLOWED_CHAT_IDS` 没加你的 chat id、或 `TG_WEBHOOK_SECRET` 与 `setWebhook` 时不一致 |
| Agent 长任务中途中断 | `maxDuration` 被改小了。保持 `edgeone.json` 里 `cloudFunctions.nodejs.maxDuration = 120`，并确认 `WEB_AGENT_TIMEOUT_MS` ≤ 120000 |
| 知识库文档列表体积都显示 1 KB | 预期行为，见「已知限制」第 1 条 |
| 生图提示「图像接口未返回任何图片。原始响应：…」 | 上游返回结构不在兼容范围内。看提示里的原始响应片段，若图片藏在别的字段，按第六节的三种形态补一条分支 |
| 生图提示「未能转存（存储未绑定或图片过大）」 | `/healthz` 看 `storage` 是否为 `memory`；或图片超过 `IMAGE_MAX_MB`。可调大上限，或接受上游 24 小时临时链接 |
| 生成的图第二天全裂了 | 说明走的是上游临时链接。确认 `IMAGE_PERSIST` 没被设成 `0`，且存储已接通 |
| 生图结果里有水印 | 设 `IMAGE_WATERMARK=false` 重新部署（日日新公测期去水印免费） |
| 发完图后历史记录整段消失 | 已修。原因见第六节：内联 base64 撑爆 localStorage。若仍复现，检查 `IMAGE_PERSIST` 是否被关闭且存储未接通 |
| PWA 更新后页面没变 | 确认 `/sw.js` 响应头带 `Cache-Control: no-cache`（函数与 `edgeone.json` 都已设置） |
| `/` 能打开但 `/api/chat`、`/sw.js` 返回 404 | 说明平台没有把根级 `[[default]].js` 当作兜底路由。把 `cloud-functions/[[default]].js` 移到 `cloud-functions/api/[[default]].js`，并在 `edgeone.json` 的 `rewrites` 中把 `/api/*` 之外的路径映射进去；或直接在 Makers 控制台把该函数的路由规则配成 `/*` |

---

## 十、路由约定（部署前请确认）

本项目依赖两条路由，`/` 由 `index.js` 处理、其余全部由根级 `[[default]].js` 兜底。
这是按 EdgeOne 官方文档中 `[[default]].js` 的多级动态路由语义设计的。

部署完成后请依次访问 `/healthz`、`/manifest.webmanifest`、`/icon-192.png` 确认兜底路由生效。
如果其中任何一个返回 404 而 `/` 正常，参考上表最后一行的处理方式。
