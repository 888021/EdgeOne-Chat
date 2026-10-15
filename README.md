# EdgeOne-Chat

多通道 AI 对话前端，跑在**腾讯云 EdgeOne Makers** 上：运行时用 **Cloud Functions (Node.js 20)**，
持久化用 **Blob 存储**。由上游原版 v7.0.0（跑在 Cloudflare Workers + R2 上）完整移植而来。

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
| 开通成本 | **零控制台操作**，命名空间自动创建（控制台对 Blob 只读，没有「绑定」这一步） | 需手动开通 + 建命名空间 + 绑定项目 |

项目里 Agent 单轮预算默认 90 秒（`WEB_AGENT_TIMEOUT_MS`）、知识库要按标题存中文文件名、
记忆写完要立刻能检索——这三条都只有 Cloud Functions + Blob 能满足。

> KV 后端也一并实现了（`STORAGE_BACKEND=kv`），供你想切到 Edge Functions 时使用。

---

## 二、目录结构

```
edgeone-chat/
├── edgeone.json                  # EdgeOne 项目配置（构建/函数时长/响应头）
├── package.json                  # 依赖：@edgeone/pages-blob
├── tts-demo.html                 # 静态演示页（原样保留）
├── scripts/
│   ├── selfcheck.mjs             # 本地自检：104 项用例，不需要 EdgeOne 环境
│   └── bootstrap-blob.mjs        # ★ 部署前预创建 Blob 命名空间（token 模式，可进 CI）
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
| 11 | `_app/store/edge-store.js`、`_app/entry.js` | 存储后端**定死 Blob**（`STORAGE_BACKEND` 默认 `blob`，不再自动回退 KV）；首个请求时**自动创建并校验命名空间**；`/healthz?probe=1` 真实读写自检 | 见第五节 |
| 12 | `_app/store/blob-backend.js` | 读操作**显式传 `consistency: "strong"`**（SDK 默认是 `eventual`）；错误码记录 + 中文提示映射；写失败不再静默 | SDK 默认最终一致会导致「刚写完读不到」和「刚转存的图片 404」——这是个真 bug |
| 13 | `scripts/bootstrap-blob.mjs` | **新增**：用 SDK 的 token 模式在部署前预创建命名空间并验证 | 把命名空间创建从「首个用户请求里」提前到部署时 |
| 14 | `package.json` | `dev` 脚本改为 `edgeone makers dev`（CLI 命名空间已从 `edgeone pages` 迁移）；新增 `bootstrap:blob` | — |
| 15 | 全局 | 项目更名 **`cloudflare-chat` → `edgeone-chat`**：包名、`edgeone.json`、页面标题、品牌名、PWA manifest/缓存名、Agent 系统提示、对外 User-Agent、Telegram 日志前缀、Blob 默认命名空间、KV 常见绑定名 | 见第五节「关于改名」。唯一保留的兼容层是**浏览器旧存储键的自动搬迁**（不搬会丢用户聊天记录）。其余旧名兼容（旧 PWA 缓存前缀、旧 KV 绑定名、旧命名空间提示）**均已按要求移除**；`CF-Connecting-IP` 保留，因为那是协议头名不是品牌名 |

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

> 存储相关**不需要配置任何环境变量**：Blob 命名空间默认叫 `edgeone-chat`，会自动创建。
> 唯一建议保持默认的是 `BLOB_CONSISTENCY=strong`（原因见第五节）。

### 3.5 预创建 Blob 命名空间（可选，推荐）

不跑这一步也能用 —— 函数在首个请求时会自动创建并校验命名空间。
但跑一下可以让线上第一个请求面对一个**已存在**的命名空间，而不是把创建耗时放在关键路径上：

```bash
# 控制台「API Token」页面生成 token，项目概览里复制 projectId
EO_PROJECT_ID=pages-xxxxxxxx EO_API_TOKEN=xxx npm run bootstrap:blob
```

成功时输出 `✓ 命名空间「edgeone-chat」已就绪`，退出码 0；
失败会给出错误码与处理建议，退出码 1，可以直接接进 CI 做就绪门禁（配 `--json` 更好解析）。

### 4. 验证

打开站点，访问 `/healthz`，应看到：

```json
{ "ok": true, "t": 1750000000000, "runtime": "edgeone", "storage": "blob:edgeone-chat" }
```

`storage` 字段是关键：
- `blob:edgeone-chat` —— 持久化已接通（Blob 命名空间会在首次写入时**自动创建**）
- `memory` —— **未接通**，此时 Web 端聊天仍可用，但 Telegram 机器人、知识库、长期记忆会重启即丢

再加 `STORAGE_DEBUG=1` 重新部署，`/healthz` 会多出一整块排障信息，重点看两个字段：

- `debug.provision.state` 应为 `ready` —— 表示命名空间已**自动创建并通过读写校验**；
  若是 `failed`，`debug.provision.error` 会说明原因（配额、凭证、命名空间名非法等）。
- `debug.lastStorageError` 应为 `null` —— 非空说明最近的存储读写出过错。
  这个字段很重要：上层大多把存储异常当成「读不到」处理，于是「配额满了」会伪装成
  「知识库是空的」，有了它才能一眼分辨。

还想确认存储「真的能写能读」，再加 `?probe=1`（即 `/healthz?probe=1`）—— 详见第五节。

> 可选但推荐：部署前先跑一次 `npm run bootstrap:blob` 把命名空间建好（第五节），
> 这样线上第一个请求面对的是已存在的命名空间，而不是让创建耗时落在关键路径上。

### 5. Telegram Webhook（可选）

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<你的EdgeOne域名>/tg-webhook&secret_token=<SECRET>
```

---

## 五、存储配置与「自动创建 / 自动绑定」的真实边界

先说结论，这三句话把官方文档没直说、但踩过才知道的事讲清楚：

1. **Blob 的创建是完全自动的**，而且本项目把它从「首次写入时顺带发生」提前到了**首个请求时主动确认**。
2. **Blob 没有「绑定」这一步**。官方文档明确：Blob 在控制台**仅支持只读浏览**（查看命名空间列表、
   浏览对象目录），命名空间的创建与所有数据操作都走 SDK。所以「把 Blob 绑定到某个变量名」
   在 EdgeOne 上根本没有入口 —— 代码里也就不需要认绑定名。
3. **KV 才是需要「绑定」的那个**：创建和绑定都只能控制台手动完成，但**绑定名**可以自动发现。

本项目**定死用 Blob**（`STORAGE_BACKEND` 默认 `blob`，取值拼错也按 Blob 处理）。
Blob 不可用时如实报 `memory`，**不会**悄悄换成 KV —— KV 的最终一致性与 key 字符集限制
是隐性差异，静默降级只会让问题更难排查。

| 环节 | Blob（本项目在用） | KV（备选） |
|---|---|---|
| 开通存储账户 | 不需要，首次 `getStore()` 时平台自动处理 | 需在控制台点一次「立即申请」 |
| 创建命名空间 | **自动**（首次 `getStore("edgeone-chat")` 时平台创建；本项目还会在首个请求时主动确认） | 只能控制台手动创建（无 SDK / 无管理 API） |
| 绑定到项目 / 绑定名 | **不存在这一步**（控制台对 Blob 只读） | 只能控制台手动绑定，但**绑定名可自动发现** |
| 提前创建（部署前） | **可以**——用 SDK 的 token 模式，见下方 `bootstrap-blob.mjs` | 不可以 |
| 控制台能做什么 | 只读：看命名空间列表、浏览对象目录 | 创建命名空间、绑定到项目 |
| 可运行于 | Cloud Functions 与 Edge Functions | **仅 Edge Functions** |

> 顺带纠正一个网上流传的说法：官方「概览」页的示例里写的是 `@tencent/pages-blob`，
> 但 **npm 上没有这个包**（`404 Not Found`）。真实的包名是 `@edgeone/pages-blob`
> （当前最新 `0.0.18`，2026-09-25 发布），以 Blob 详情页的文档为准。

### 自动创建：两段式，部署前 + 启动时

**第一段（可选，但推荐）：部署前预创建。** `scripts/bootstrap-blob.mjs` 用 SDK 的
token 模式（`{ projectId, token }`）在**函数之外**把命名空间建好并验证：

```bash
# 控制台「API Token」页面生成 token，项目概览里复制 projectId
EO_PROJECT_ID=pages-xxxxxxxx EO_API_TOKEN=xxx npm run bootstrap:blob

# 只检查，不创建（CI 里做就绪门禁）
npm run bootstrap:blob:check
```

它做的事：`listStores()` 看是否存在 → 不存在就写入一个标记对象触发创建 → 读回校验 →
再列一次确认命名空间真的出现了。任何一步失败都会给出错误码与处理建议，退出码 1。

这样线上第一个请求面对的是一个**已存在**的命名空间，而不是让创建耗时落在关键路径上。

**第二段：启动时主动确认。** 函数在**首个请求**时会异步跑一次「写标记 → 读回校验」，
写入 `__meta__/provision.json`：

- 不阻塞本次响应（交给 `waitUntil` 托管）
- 结果缓存在 isolate 里，`/healthz` 的 `debug.provision` 直接能看到
- 写进去的标记对象在控制台可见，等于给命名空间盖了个「本项目在用」的戳
- 失败会重试（60 秒后），并如实记录而不是假装成功

不想让冷启动产生任何写操作，设 `BLOB_AUTOPROVISION=0` 关掉。

### 「自动绑定」的准确说法

**Blob：不存在绑定，所以代码里不做绑定名发现。**
`detectBlobBinding()` 只认显式指定的 `EO_BLOB_BINDING`，作为逃生口保留
（本地自检、或你自己构造了一个 Store 实例想注入时才会用到）。
之所以不做全量扫描：Blob 既然没有绑定机制，扫出来的任何东西都只可能是误判 ——
比如某个恰好带 `set`/`get`/`list` 的无关对象。

**KV：三层自动发现，绑定成什么变量名都能认出来。**
`detectKvBinding()` 依次尝试 `EO_KV_BINDING` 显式指定 →
常见默认名（`CHAT_KV`、`KV`、`STORAGE`、`EO_KV`、`EDGEONE_KV`、`EDGEONE_CHAT_KV`）→
全量扫描 `env` / `context` / `globalThis`，特征键是 `get` + `put` + `delete`。
第 3 层是真正的"自动"（`my_random_name` 也行）。识别用「有没有 `put`」把 KV 与
Blob Store（用 `set`）区分开，并显式排除本层自己挂载的 `env.R2`，避免自我套娃。

> 第 2 层是「少扫一圈」的快捷路径，不是白名单 —— 名字不在里面也一样能被第 3 层找到。

### 环境变量

| 环境变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `STORAGE_BACKEND` | `blob` / `kv` / `auto` / `none` | **`blob`** | 本项目定死 Blob。拼错取值也按 `blob` 处理（并在 `/healthz` 回显原始值 + warning）；`kv` 仅供 Edge Functions；`auto` 是旧的「先 Blob 再 KV」；`none` 强制纯内存 |
| `EO_BLOB_NAMESPACE` | 字符串 | `edgeone-chat` | Blob 命名空间名，首次使用时平台自动创建（名称只允许字母/数字/下划线/连字符，UTF-8 ≤ 64 字节） |
| `BLOB_CONSISTENCY` | `strong` / `eventual` | **`strong`** | 读取一致性。**建议别动**，见下方说明 |
| `BLOB_AUTOPROVISION` | `1` / `0` | `1` | 是否在首个请求时自动创建并校验命名空间 |
| `EO_BLOB_BINDING` | 字符串 | 不填 | 逃生口：注入自建 Store 实例（一般不需要） |
| `EO_KV_BINDING` | 字符串 | 不填即自动发现 | 仅 `STORAGE_BACKEND=kv` 时有意义 |
| `STORAGE_DEBUG` | `1` | 不输出 | 设为 `1` 后 `/healthz` 附带后端探测详情；再加 `?probe=1` 会真实读写一次 |

### 为什么 `BLOB_CONSISTENCY` 默认是 `strong`

SDK 的 `Store` 默认一致性是 **`eventual`**（走 CDN 缓存域），写入后要「通常秒级」
才能在所有节点读到。对本项目这意味着两处用户可见的故障：

- 刚写进长期记忆 / 知识库的内容，**紧接着的检索查不到**（表现为随机「失忆」）；
- 生图转存后返回 `/api/img/<id>`，浏览器**立刻去取时可能 404**（表现为图片裂开）。

所以本层在 `get` / `list` 上显式传 `consistency: "strong"`（跳过缓存直读主存储，略慢但可预期），
并把它设成整个 Store 的默认值。想用延迟换速度、且能容忍短暂不一致时，才设 `BLOB_CONSISTENCY=eventual`。

### 排障：`STORAGE_DEBUG=1` 时 `/healthz` 的额外输出

```json
{
  "ok": true, "runtime": "edgeone", "storage": "blob:edgeone-chat",
  "debug": {
    "backend": "blob:edgeone-chat",
    "mode": "blob",
    "namespace": "edgeone-chat",
    "consistency": "strong",
    "provision": { "state": "ready", "ok": true, "at": 1750000000000,
                   "namespace": "edgeone-chat", "error": null },
    "blobError": null,
    "blobBindingUsed": null,
    "kvBindingUsed": null,
    "lastStorageError": null,
    "kvCandidates": [],
    "hint": ""
  }
}
```

| 字段 | 用途 |
|---|---|
| `provision.state` | `ready` 已创建并校验 / `pending` 进行中 / `failed` 失败（看 `error`）/ `disabled` 被 `BLOB_AUTOPROVISION=0` 关掉 / `unavailable` 存储未接通，无从创建 |
| `blobError` | Blob 为什么没接上（最常见是依赖没装上） |
| `lastStorageError` | 最近一次读写错误的 `op` / `code` / `message` / `hint`。**这个字段很关键**：上层大多把异常当成「读不到」处理，于是「配额满了」会伪装成「知识库是空的」——这里把它摊开 |
| `mode` | 回显 `STORAGE_BACKEND` 原始取值（拼错时额外给 `warning`） |

**默认关闭**，避免对外暴露内部绑定名。

### 关于改名：`cloudflare-chat` → `edgeone-chat`

本项目原名 `cloudflare-chat`，已整体更名为 **`edgeone-chat`**。涉及到的几处需要你知情：

| 位置 | 变化 | 影响 |
|---|---|---|
| Blob 命名空间 | 默认名从 `cloudflare-chat` 改为 **`edgeone-chat`** | 命名空间就是数据边界：**换名等于换一个空库**。旧命名空间里的数据不会自动搬过来，也不会自动删掉（在控制台还能看到）。本项目不再内置「切回旧命名空间」的提示或常量 |
| PWA 缓存 | `edgeone-chat-<版本>` | 旧前缀 `cloudflare-chat-*` 的兼容已移除。若你曾部署过改名前的版本，老访客浏览器里的旧缓存**不会再被自动清掉**（不影响功能，只是白占几十 KB~几 MB，直到用户自己清浏览器缓存） |
| PWA 名称 / 页面标题 / 品牌名 | `EdgeOne-Chat`（简称 `EO-Chat`） | 需要重新安装 PWA 才会更新桌面图标名 |
| User-Agent | `EdgeOne-Chat/7.0` | 工具调用（网页抓取、维基百科、汇率）对外标识 |
| KV 绑定名候选 | 只剩 `CHAT_KV` / `KV` / `STORAGE` / `EO_KV` / `EDGEONE_KV` / `EDGEONE_CHAT_KV` | 旧名 `CLOUDFLARE_CHAT_KV` 已从常见名列表移除。注意这只是**源码里不再出现旧名**：KV 发现的第三层是全量扫描，任意变量名都能被认出，所以你在控制台绑成旧名也照样能用 |
| 浏览器本地存储键名 | `cfchat_sessions` → **`eochat_sessions`**、`cfchat_agent_mode` → **`eochat_agent_mode`** | **已配自动迁移**：读到旧键就搬到新键再清掉，老用户聊天记录与开关状态都不会丢。迁移是幂等的，且更老的 `nvidia_ai_sessions` 也会一路搬到新键 |
| `CF-Connecting-IP` 请求头 | **未改动** | 这是 Cloudflare 的协议头名（客户端 IP 来源之一），不是品牌名，改了 IP 限流会失效 |
| 项目目录名 | `cloudflare-chat-edgeone/` → **`edgeone-chat/`** | 仅影响磁盘路径，与运行时无关。之前分享过的路径需要更新 |

### 验证存储是否「真的能用」：`?probe=1`

`/healthz` 的 `storage` 字段只说明后端**加载**成功；`debug.provision.state=ready` 说明
命名空间已创建且启动时的读写校验通过。`getStore()` 返回对象本身不代表有权限、有配额。
要独立地再确认一次端到端可用，加 `?probe=1`：

```
https://<你的域名>/healthz?probe=1     # 需同时设置 STORAGE_DEBUG=1
```

它会真实写入、读回、再删除一个临时对象，输出：

```json
"debug": { "probe": { "ok": true, "backend": "blob:edgeone-chat" } }
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
- 存储未接通时会退回内联 base64 展示，并在图片下方明确提示「刷新后可能无法恢复」。

---

## 七、已知限制与取舍

这些都是平台差异导致的、**无法在代码层完全抹平**的点，请知悉：

1. **`list()` 不返回对象体积**。Blob 的 `list()` 返回值只有 `{ blobs: [{ key, etag }] }`，
   所以知识库文档列表里的「大小」一栏会统一显示为 1 KB。**文档日期是正确的**（取自 frontmatter 的 `saved_at`）。
   准确地说，这条**不值得修**：SDK 提供了 `store.getMetadata(key)`，它不下载正文、只取响应头，
   是拿体积的正确方式 —— 但仍是**每个 key 一次请求**，50 篇文档就从 1 次请求变成 51 次。
   如果你确实在意体积显示，更好的做法是在保存时把字节数写进 frontmatter，
   列的时候直接读 frontmatter（零额外请求）。
2. **KV 后端的 key 长度上限**。KV key 上限 512 字节，本适配层用十六进制转义，
   相当于原始 key 最长约 256 字节。纯中文标题超过约 80 个汉字时会写入失败并抛出明确错误
   （而不是静默丢数据）。**Blob 后端没有这个限制。**
3. **一致性需要显式指定**。Blob 的**默认**读取一致性是 `eventual`（走 CDN 缓存域，秒级延迟），
   这意味着「刚写进去的内容紧接着读不到」。本项目已在 `get` / `list` 上显式传
   `consistency: "strong"`（可用 `BLOB_CONSISTENCY=eventual` 换回速度），
   所以实际不会有这个问题 —— 但代价是每次读都直连主存储，**读延迟略高于纯缓存读**。
   这是本项目主动选择的取舍：宁可慢一点，也不要随机失忆。
4. **`get` 的 `range` 选项是模拟的**。Blob/KV 都不支持范围读取，适配层读全量后切片。
   本项目仅用于读 frontmatter 前 4096 字节，代价可接受。
5. **Cloud Functions 跑在云端地域而非边缘节点**（默认广州）。对本项目影响很小——
   瓶颈在上游大模型 API，不在这一段。
6. **Blob 官方不建议当公网图床或 CDN 用**。文档原文：「Blob 面向 Makers Functions 的运行时数据需要
   （例如读写、查询、加工），不建议作为公网图床或 CDN 使用。」
   本项目的 `GET /api/img/<id>` 是**每次请求都经函数中转**读 Blob 再返回，
   属于「运行时取用」而非「图床分发」，但请知悉：图片量大了之后这条路会成为带宽与函数耗时的瓶颈。
   真要大规模分发，应把图片另存到对象存储 / CDN，而不是走这个接口。
7. **免费版单账户 Blob 容量 1GB**。按 2K PNG 约 3MB 估算约 300 张图，或约 100 万字的 Markdown。
   超限时 SDK 抛 `QUOTA_EXCEEDED`，本项目会把它记录到 `/healthz` 的
   `debug.lastStorageError`（否则会伪装成「知识库是空的」）。
6. **`_app/` 目录不参与路由**依赖平台对下划线前缀的忽略规则。即使平台为它生成了路由，
   也只会让 `/_app/xxx` 这类路径返回错误，不影响正常功能。
7. **生图转存会占用存储**。默认 `IMAGE_PERSIST=1`，每张图约占 1~3 MB（取决于分辨率），
   免费 1GB 额度大约能存 300~800 张。存储紧张时把 `IMAGE_MAX_MB` 调小，
   或设 `IMAGE_PERSIST=0` 退回上游临时链接（代价是 24 小时后失效）。
8. **图像接口是同步的**，且本项目对图片只做「转存 + 渲染」，没有做缩略图或压缩。
   4K 图（`4096x4096`）单张可能超过 `IMAGE_MAX_MB` 上限而不被转存。

---

## 八、本地自检

不需要 EdgeOne 环境，也不需要安装任何依赖（装了依赖会额外走一遍真实 SDK 路径）：

```bash
node scripts/selfcheck.mjs      # 或 npm run selfcheck
```

覆盖 104 项用例，包括：

- 完整模块图能否加载（能捕获所有语法/导入错误）
- R2 契约在两个后端上的一致性：`put`/`get`/`get+range`/批量 `delete`/`list` 的
  `prefix`、`truncated`、`cursor` 语义
- **一致性**：`get`/`list` 是否真的带上了 `consistency: "strong"`（这是防「刚写完读不到」的关键）、
  `BLOB_CONSISTENCY=eventual` 能否生效、非法取值不会静默变成 `eventual`
- **错误可见性**：底层抛 `QUOTA_EXCEEDED` 时读操作仍返回 null（不破坏上层行为）
  但错误码被记录；写失败必须抛出（丢数据比报错严重）
- KV 的 key 编码可逆性、前缀性质、超长 key 守卫
- 路由：`/`、`/healthz`、`/sw.js`、`/manifest.webmanifest`、`/icon-192.png`、`/api/chat`、404
- 多通道环境变量能否正确解析出模型下拉框
- **Blob 默认后端**：识别规则（有 `set` 无 `put`）、未设 `STORAGE_BACKEND` 时默认 Blob
  且**绝不静默降级到 KV**、不做绑定名全量扫描（Blob 没有绑定机制）、
  `EO_BLOB_BINDING` 逃生口、端到端接管为 `env.R2` 并真实读写成功
- **命名空间自动创建**：首个请求会写入并读回 `__meta__/provision.json`、
  `debug.provision` 从 `pending` 变 `ready`、`BLOB_AUTOPROVISION=0` 时零写入、
  失败时如实记录（不假装成功）
- **KV 绑定自动发现**：任意变量名可被识别、`EO_KV_BINDING` 优先、`CHAT_KV` 默认命中、
  `env.R2` 不被误判、无后端时安静退化为 memory
- `/healthz` 排障输出：`STORAGE_DEBUG=1` 时给出详情、`mode`/`namespace`/`consistency` 回显、
  拼错取值给 warning、`?probe=1` 的成败两条路径、默认不外泄
- **真实 SDK 接入路径**：本地无 Makers 凭证时是否优雅降级为 memory 并说明缺什么
  （装了依赖走真 SDK，没装则验证「依赖缺失」的提示）
- **生图链路**：图像接口判定、`response_format` 默认值、可选参数透传、base64 编解码往返、
  转存与读回、路径穿越拦截、SSRF 拦截、非图片内容类型拒收、
  `b64_json`/`url`/多图/报错/非 JSON 五种响应形态、
  `GET /api/img/<id>` 经完整路由取回字节
- **生成页面本身的合法性**：把页面内联脚本抽出来单独 parse，
  防止模板字符串两层转义把前端写坏（这类错误服务端完全看不出来）
- **品牌名改名**：页面标题/品牌名/PWA meta/manifest 都已是 `EdgeOne-Chat`、
  Service Worker 用新缓存名、Agent 系统提示与对外 User-Agent 已改名、
  存储默认命名空间已切换。另有一条**源码级兜底断言**：13 个关键文件里都不允许再出现
  `cloudflare`（不分大小写），防止以后手滑把旧名带回来
- **浏览器端键名迁移（行为级测试）**：从渲染出的页面里**切出真实代码片段**跑，
  不复制逻辑。覆盖 `cfchat_sessions` / `nvidia_ai_sessions` → `eochat_sessions` 的两级搬迁、
  新旧键并存时以新键为准、全新用户不凭空写入、旧键内容损坏时降级为空而非崩溃、
  Agent 开关的继承与优先级
- **端到端**：挂上存储后端后，长期记忆写入/读回/md 镜像、同主题改口覆盖、
  知识库中文标题保存/列表/精读/删除/分词检索——**两个后端各跑一遍**

`scripts/bootstrap-blob.mjs` 也有自解释的用法与退出码（`--help`），
可以用 `--json` 输出接进 CI 做就绪门禁。

本地起服务调试（需先 `npm i -g edgeone`）：

```bash
edgeone makers dev
```

---

## 九、排障

| 现象 | 原因与处理 |
|---|---|
| `/healthz` 里 `storage` 是 `memory` | 持久化未接通。先设 `STORAGE_DEBUG=1` 看 `debug.blobError`：若是 `import 失败：Cannot find package '@edgeone/pages-blob'`，说明依赖没装上，检查安装命令是否为 `npm install`；若是 `getStore 调用失败 … Missing: deployCredential`，说明函数不在 Makers 环境里跑。再确认 `STORAGE_BACKEND` 没被设成 `none`，也没拼错（拼错会原样回显在 `debug.mode` 并给出 `warning`） |
| `debug.provision.state` 是 `failed` | 命名空间没能自动创建。看 `debug.provision.error`：`QUOTA_EXCEEDED` 是 1GB 额度满了；`INVALID_STORE_NAME` 是 `EO_BLOB_NAMESPACE` 名字非法（只允许字母/数字/下划线/连字符，UTF-8 ≤ 64 字节）；`CREDENTIAL_ERROR` 是平台注入的部署凭证有问题，重新部署一次 |
| `storage` 显示已接通，但重启后数据还是丢 | 用 `/healthz?probe=1`（需 `STORAGE_DEBUG=1`）做一次真实读写。`probe.ok:false` 说明 SDK 加载了但没权限/没配额，看 `probe.reason` |
| 知识库突然「空了」，但之前明明有文档 | 看 `/healthz` 的 `debug.lastStorageError`。上层把存储异常当成「读不到」处理，所以配额满 / 被限流都会伪装成「空」。非 `null` 时 `hint` 字段会告诉你怎么办 |
| 刚存的知识库文档搜不到 / 刚生成的图裂开 | 读取一致性被改成了 `eventual`。删掉 `BLOB_CONSISTENCY` 或设为 `strong`。默认就是 `strong`，出现这个问题通常是被手动改过 |
| 改名后知识库/记忆/图片全都不见了 | 命名空间跟着换了（`cloudflare-chat` → `edgeone-chat`），新命名空间是空的。旧数据没有被删，仍在旧命名空间里。本项目不再内置「切回旧命名空间」的开关 —— 需要时自己设 `EO_BLOB_NAMESPACE=cloudflare-chat` 重新部署（`EO_BLOB_NAMESPACE` 是通用变量，接受任意合法命名空间名） |
| 改名后浏览器里历史对话没了 | 理论上不该发生（有自动迁移）。确认页面已更新到新版（旧 SW 缓存的旧页面读的是旧键）。若仍复现，看浏览器 localStorage 里 `eochat_sessions` 是否有值、`cfchat_sessions` 是否残留 |
| 改名后 PWA 图标名还是旧的 | 桌面图标名来自 manifest，需要重新「添加到主屏幕」才会更新。当前版本的缓存会被 SW 的 activate 逻辑自动清理；但如果你曾部署过改名前的版本，那些旧前缀缓存不会再被自动清（见第五节「关于改名」），可在浏览器设置里手动清一次 |
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
