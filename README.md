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
│   └── selfcheck.mjs             # 本地自检：37 项用例，不需要 EdgeOne 环境
└── cloud-functions/              # EdgeOne Cloud Functions 路由目录
    ├── index.js                  # 路由：/          （聊天页面）
    ├── [[default]].js            # 路由：/*         （兜底，接管 /api/chat、/tg-webhook、/sw.js 等）
    └── _app/                     # 全部业务代码（下划线前缀，不参与路由）
        ├── entry.js              # ★ 入口：把 EdgeOne 的 onRequest(context) 适配成原 routeRequest()
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
- `blob:cloudflare-chat` —— 持久化已接通（Blob 命名空间会在首次写入时自动创建）
- `memory` —— **未接通**，此时 Web 端聊天仍可用，但 Telegram 机器人、知识库、长期记忆会重启即丢

### 5. Telegram Webhook（可选）

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<你的EdgeOne域名>/tg-webhook&secret_token=<SECRET>
```

---

## 五、存储后端配置

| 环境变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `STORAGE_BACKEND` | `auto` / `blob` / `kv` / `none` | `auto` | `auto` 先试 Blob 再试 KV；`none` 强制纯内存 |
| `EO_BLOB_NAMESPACE` | 字符串 | `cloudflare-chat` | Blob 命名空间名，首次使用时平台自动创建 |
| `EO_KV_BINDING` | 字符串 | 依次尝试 `CHAT_KV`/`KV`/`STORAGE` | 仅 `STORAGE_BACKEND=kv` 时有意义 |

KV 后端需要额外一步：在 **存储 → KV 存储** 开通账户、创建命名空间，并在项目里**绑定**该命名空间
（绑定时的「变量名」填 `CHAT_KV`）。

---

## 六、已知限制与取舍

这些都是平台差异导致的、**无法在代码层完全抹平**的点，请知悉：

1. **`list()` 不返回对象体积**。Blob 的 `list` 只给 `key` 和 `etag`，所以知识库文档列表里的
   「大小」一栏会统一显示为 1 KB。**文档日期是正确的**（取自 frontmatter 的 `saved_at`）。
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

---

## 七、本地自检

不需要 EdgeOne 环境，也不需要安装任何依赖：

```bash
node scripts/selfcheck.mjs
```

覆盖 37 项用例，包括：

- 完整模块图能否加载（能捕获所有语法/导入错误）
- R2 契约在两个后端上的一致性：`put`/`get`/`get+range`/批量 `delete`/`list` 的
  `prefix`、`truncated`、`cursor` 语义
- KV 的 key 编码可逆性、前缀性质、超长 key 守卫
- 路由：`/`、`/healthz`、`/sw.js`、`/manifest.webmanifest`、`/icon-192.png`、`/api/chat`、404
- 多通道环境变量能否正确解析出模型下拉框
- **端到端**：挂上存储后端后，长期记忆写入/读回/md 镜像、同主题改口覆盖、
  知识库中文标题保存/列表/精读/删除/分词检索——**两个后端各跑一遍**

本地起服务调试（需先 `npm i -g edgeone`）：

```bash
edgeone pages dev
```

---

## 八、排障

| 现象 | 原因与处理 |
|---|---|
| `/healthz` 里 `storage` 是 `memory` | Blob 未接通。检查 `package.json` 的依赖是否装上了、`STORAGE_BACKEND` 是否被设成了 `none` |
| 页面提示「未配置模型」 | 环境变量没配或配完没重新部署。注意 `MODEL_1` 的格式是 `模型ID:显示名`，多个用英文逗号分隔 |
| 聊天正常，但 Telegram 机器人不响应 | webhook 没设、`TG_ALLOWED_CHAT_IDS` 没加你的 chat id、或 `TG_WEBHOOK_SECRET` 与 `setWebhook` 时不一致 |
| Agent 长任务中途中断 | `maxDuration` 被改小了。保持 `edgeone.json` 里 `cloudFunctions.nodejs.maxDuration = 120`，并确认 `WEB_AGENT_TIMEOUT_MS` ≤ 120000 |
| 知识库文档列表体积都显示 1 KB | 预期行为，见「已知限制」第 1 条 |
| PWA 更新后页面没变 | 确认 `/sw.js` 响应头带 `Cache-Control: no-cache`（函数与 `edgeone.json` 都已设置） |
| `/` 能打开但 `/api/chat`、`/sw.js` 返回 404 | 说明平台没有把根级 `[[default]].js` 当作兜底路由。把 `cloud-functions/[[default]].js` 移到 `cloud-functions/api/[[default]].js`，并在 `edgeone.json` 的 `rewrites` 中把 `/api/*` 之外的路径映射进去；或直接在 Makers 控制台把该函数的路由规则配成 `/*` |

---

## 九、路由约定（部署前请确认）

本项目依赖两条路由，`/` 由 `index.js` 处理、其余全部由根级 `[[default]].js` 兜底。
这是按 EdgeOne 官方文档中 `[[default]].js` 的多级动态路由语义设计的。

部署完成后请依次访问 `/healthz`、`/manifest.webmanifest`、`/icon-192.png` 确认兜底路由生效。
如果其中任何一个返回 404 而 `/` 正常，参考上表最后一行的处理方式。
