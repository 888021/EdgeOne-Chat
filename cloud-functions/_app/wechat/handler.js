// EdgeOne-Chat 微信 ClawBot（iLink Bot API / openclaw-weixin）通道处理器：
// 支持：
// 1) 四重防盗绑安全机制：
//    - 强制管理鉴权：未配置 WX_ADMIN_SECRET 且未配置 ACCESS_PASSWORD 时严禁网页端扫码/解绑，杜绝公开网址被路人盗绑；
//    - 独立管理员密钥：支持配置专属 WX_ADMIN_SECRET（与普通访客的 ACCESS_PASSWORD 分离），未通过管理员鉴权时 /api/wx/status 隐藏一切敏感信息；
//    - 已绑定防覆盖锁：已处于有效连接状态时禁止直接生成新二维码覆盖，需管理员显式解锁/解绑；
//    - 绑定人自动白名单锁：扫码确认时自动绑定扫码人的 ilink_user_id，默认仅允许绑定人自身（及 WX_ALLOWED_USERS）对话与读写知识库；
// 2) 网页实时轮询、外部定时触发器（GET/POST /api/wx/poll?key=...）与 Webhook 推送（/wx-webhook）三栖接入；
// 3) 完整复用 EdgeOne-Chat ReAct Agent 引擎（19 项零密钥工具 + 多密钥轮换池 + Blob/KV 长期记忆与知识库读写 + 断点「继续」续做）；
// 4) 微信端斜杠命令（/start, /model [序号/名称], /agent, /clear, /new, /memory, /forget, /kb, /help）；
// 5) 原生“对方正在输入…”状态指示器、语音自动转文字对话、发图 Vision 多模态识图与文本文件上传分析。

import { APP_VERSION, CORS_HEADERS } from '../constants.js';
import { mapSetBounded, mapGetBounded, parseCommaSeparated, safeEqual } from '../utils.js';
import { storeGet, storePut, storePutChecked, storeDelete } from '../store/r2.js';
import { getChannelConfig, buildAIRequest, fetchWithKeyRotation, authHeaders } from '../channel.js';
import { tgTrimHistory, tgGetHistory, tgSaveHistory, tgClearHistory } from '../tg-history.js';
import { agentGetMemories, agentForgetMemory } from '../agent/memory.js';
import { agentGetMode, agentSetMode } from '../agent/mode.js';
import { agentLoadResumeState, agentClearResumeState, tgAgentResumeKey } from '../agent/resume.js';
import { tgAgentChat, tgAgentResume } from '../agent/loop.js';
import { readErrorBody } from '../agent/stability.js';
import { toolListDocs } from '../kb/doc-tools.js';
import {
  DEFAULT_ILINK_BASE_URL,
  DEFAULT_ILINK_CDN_URL,
  DEFAULT_ILINK_CHANNEL_VERSION,
  normalizeBaseUrl,
  ilinkGetQrCode,
  ilinkGetQrStatus,
  ilinkNotifyStart,
  ilinkNotifyStop,
  ilinkGetUpdates,
  ilinkGetConfig,
  ilinkSendTyping,
  ilinkSendMessage,
  ilinkDownloadMediaBytes,
  extractWechatMessageContent,
} from './ilink.js';

// ================= 存储键名与 L1 内存缓存 =================
const WX_CREDS_KEY = 'wx_clawbot_creds';
const WX_DEDUP_KEY = 'wx_updates_dedup';
const WX_POLL_LOCK_KEY = 'wx_poll_lock';
const WX_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const WX_DEDUP_MAX = 200;

let cachedWxCreds = null;
let cachedWxCredsExp = 0;

const wxUserModels = new Map();
const wxUserModelsExp = new Map();

const wxContextTokens = new Map();
const wxContextTokensExp = new Map();

const wxTypingTickets = new Map();
const wxTypingTicketsExp = new Map();

const wxCursors = new Map();
const wxCursorsExp = new Map();

const seenWxMsgIds = new Map();
let activePollInIsolate = false;

function wxSafeId(id) {
  return String(id == null ? '' : id).replace(/[^a-zA-Z0-9_@.-]/g, '_').slice(0, 96);
}

// 为微信用户生成与 Telegram / Web 隔离的会话 ID（复用 tg-history / memory / mode / resume）
function wxSessionChatId(userId) {
  return 'wx_' + String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
}

function wxChannelVersion(env) {
  return String((env && env.WX_CHANNEL_VERSION) || DEFAULT_ILINK_CHANNEL_VERSION).trim() || DEFAULT_ILINK_CHANNEL_VERSION;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ================= 0. 微信通道管理员鉴权（防路人盗绑核心防线） =================
// 规则：
// 1) 若配置了 WX_ADMIN_SECRET，则必须提供匹配的 X-Wx-Admin-Token（或 X-Access-Token / URL ?key=）；
// 2) 若未配置 WX_ADMIN_SECRET 但配置了 ACCESS_PASSWORD，则必须提供匹配的口令；
// 3) 若服务端既未配置 WX_ADMIN_SECRET 也未配置 ACCESS_PASSWORD（完全公开站点），
//    则严禁通过网页端接口发起扫码绑定、解绑或主动发消息，彻底杜绝知道网址就能盗绑！
function checkWxAdminAuth(env, request, url) {
  const adminSecret = String((env && env.WX_ADMIN_SECRET) || '').trim();
  const accessPwd = String((env && env.ACCESS_PASSWORD) || '').trim();
  const requiredSecret = adminSecret || accessPwd;

  if (!requiredSecret) {
    return {
      authorized: false,
      noSecretConfigured: true,
      reason: '安全锁定：当前未配置 WX_ADMIN_SECRET 或 ACCESS_PASSWORD，为防止公开网址被他人恶意扫码绑定，已禁止网页端绑定操作。请在 EdgeOne 环境变量中设置 WX_ADMIN_SECRET（或使用 Telegram 机器人发送 /wxlogin 绑定）。',
    };
  }

  const providedAdmin = (request && request.headers && request.headers.get('X-Wx-Admin-Token')) || '';
  const providedAccess = (request && request.headers && request.headers.get('X-Access-Token')) || '';
  const authHeader = ((request && request.headers && request.headers.get('Authorization')) || '').replace(/^Bearer\s+/i, '').trim();
  const queryKey = (url && url.searchParams && url.searchParams.get('key')) || '';

  if (
    (providedAdmin && safeEqual(providedAdmin, requiredSecret)) ||
    (providedAccess && safeEqual(providedAccess, requiredSecret)) ||
    (authHeader && safeEqual(authHeader, requiredSecret)) ||
    (queryKey && safeEqual(queryKey, requiredSecret))
  ) {
    return { authorized: true, noSecretConfigured: false };
  }

  return {
    authorized: false,
    noSecretConfigured: false,
    reason: adminSecret
      ? '需要微信管理员密钥（WX_ADMIN_SECRET）才能执行此操作'
      : '需要访问口令（ACCESS_PASSWORD）才能执行此操作',
  };
}

// ================= 1. 微信 ClawBot 凭证存取（支持扫码持久化 + 环境变量兜底） =================
async function getWxCredentials(env, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cachedWxCreds && now < cachedWxCredsExp) {
    return cachedWxCreds;
  }

  // 优先级 1：环境变量固定绑定（WX_BOT_TOKEN），一旦配置不可被网页覆盖
  if (env && env.WX_BOT_TOKEN) {
    const token = String(env.WX_BOT_TOKEN).trim();
    const botIdFromToken = token.includes(':') ? token.split(':')[0] : 'env_bot';
    cachedWxCreds = {
      bot_token: token,
      ilink_bot_id: String(env.WX_BOT_ID || botIdFromToken).trim(),
      ilink_user_id: String(env.WX_USER_ID || '').trim(),
      baseurl: normalizeBaseUrl(env.WX_BASE_URL || DEFAULT_ILINK_BASE_URL),
      cdn_url: String(env.WX_CDN_BASE_URL || DEFAULT_ILINK_CDN_URL).trim(),
      expired: false,
      errmsg: '',
      updated_at: '',
      source: 'env',
    };
    cachedWxCredsExp = Date.now() + 30 * 1000;
    return cachedWxCreds;
  }

  // 优先级 2：Blob / KV (env.R2) 扫码持久化凭证
  if (env && env.R2) {
    try {
      const raw = await storeGet(env, WX_CREDS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.bot_token) {
          cachedWxCreds = {
            bot_token: String(parsed.bot_token).trim(),
            ilink_bot_id: String(parsed.ilink_bot_id || 'default_bot').trim(),
            ilink_user_id: String(parsed.ilink_user_id || '').trim(),
            baseurl: normalizeBaseUrl(parsed.baseurl || (env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL),
            cdn_url: String(parsed.cdn_url || (env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
            expired: !!parsed.expired,
            errmsg: parsed.errmsg || '',
            updated_at: parsed.updated_at || '',
            source: 'r2',
          };
          cachedWxCredsExp = Date.now() + 30 * 1000;
          return cachedWxCreds;
        }
      }
    } catch (e) {}
  }

  return null;
}

async function saveWxCredentials(env, creds) {
  const clean = {
    bot_token: String(creds.bot_token || '').trim(),
    ilink_bot_id: String(creds.ilink_bot_id || 'default_bot').trim(),
    ilink_user_id: String(creds.ilink_user_id || '').trim(),
    baseurl: normalizeBaseUrl(creds.baseurl || (env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL),
    cdn_url: String(creds.cdn_url || (env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
    expired: !!creds.expired,
    errmsg: String(creds.errmsg || ''),
    updated_at: creds.updated_at || new Date().toISOString(),
    source: 'r2',
  };
  cachedWxCreds = clean;
  cachedWxCredsExp = Date.now() + 30 * 1000;
  if (env && env.R2) {
    return await storePutChecked(env, WX_CREDS_KEY, JSON.stringify(clean));
  }
  return true;
}

async function markWxSessionExpired(env, creds, errmsg) {
  if (!creds) return;
  const updated = Object.assign({}, creds, {
    expired: true,
    errmsg: String(errmsg || '会话已过期 (ret=-14)，请重新扫码绑定'),
    updated_at: new Date().toISOString(),
  });
  cachedWxCreds = updated;
  cachedWxCredsExp = Date.now() + 30 * 1000;
  if (env && env.R2 && creds.source !== 'env') {
    await storePut(env, WX_CREDS_KEY, JSON.stringify(updated));
  }
  if (creds.ilink_bot_id) {
    wxCursors.delete(creds.ilink_bot_id);
    wxCursorsExp.delete(creds.ilink_bot_id);
    await storeDelete(env, 'wx_cursor_' + wxSafeId(creds.ilink_bot_id));
  }
}

async function clearWxCredentials(env) {
  const prev = await getWxCredentials(env);
  cachedWxCreds = null;
  cachedWxCredsExp = 0;
  if (prev && prev.ilink_bot_id) {
    wxCursors.delete(prev.ilink_bot_id);
    wxCursorsExp.delete(prev.ilink_bot_id);
    await storeDelete(env, 'wx_cursor_' + wxSafeId(prev.ilink_bot_id));
  }
  await storeDelete(env, WX_CREDS_KEY);
}

// ================= 2. 游标 (get_updates_buf) 与 Context Token 持久化 =================
async function getWxCursor(env, botId) {
  const key = wxSafeId(botId || 'default_bot');
  const cached = mapGetBounded(wxCursors, key, env && env.R2 ? wxCursorsExp : null);
  if (typeof cached === 'string') return cached;
  const raw = await storeGet(env, 'wx_cursor_' + key);
  const val = typeof raw === 'string' ? raw : '';
  mapSetBounded(wxCursors, key, val, 100, wxCursorsExp, 60 * 1000);
  return val;
}

async function saveWxCursor(env, botId, buf) {
  if (buf === undefined || buf === null) return;
  const key = wxSafeId(botId || 'default_bot');
  const s = String(buf);
  const prev = mapGetBounded(wxCursors, key);
  mapSetBounded(wxCursors, key, s, 100, wxCursorsExp, 60 * 1000);
  if (s !== prev) {
    await storePut(env, 'wx_cursor_' + key, s);
  }
}

async function getWxContextToken(env, userId) {
  const key = wxSafeId(userId || 'default_user');
  const cached = mapGetBounded(wxContextTokens, key, env && env.R2 ? wxContextTokensExp : null);
  if (typeof cached === 'string' && cached) return cached;
  const raw = await storeGet(env, 'wx_ctx_' + key);
  if (raw) {
    mapSetBounded(wxContextTokens, key, raw, 500, wxContextTokensExp, 5 * 60 * 1000);
    return raw;
  }
  return '';
}

async function saveWxContextToken(env, userId, contextToken) {
  if (!userId || !contextToken) return;
  const key = wxSafeId(userId);
  const ct = String(contextToken).trim();
  if (!ct) return;
  const prev = mapGetBounded(wxContextTokens, key);
  mapSetBounded(wxContextTokens, key, ct, 500, wxContextTokensExp, 5 * 60 * 1000);
  if (ct !== prev) {
    await storePut(env, 'wx_ctx_' + key, ct);
    await storePut(env, 'wx_last_peer', JSON.stringify({
      user_id: String(userId),
      context_token: ct,
      ts: Date.now(),
    }));
  }
}

async function getWxLastPeer(env) {
  try {
    const raw = await storeGet(env, 'wx_last_peer');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

// ================= 3. 入站消息去重（L1 内存 + L2 Blob/KV 滚动窗口） =================
async function loadWxDedupWindow(env) {
  try {
    const raw = await storeGet(env, WX_DEDUP_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}
  return [];
}

async function markWxMsgSeen(env, msgKey) {
  if (!msgKey) return false;
  const now = Date.now();
  if (seenWxMsgIds.has(msgKey)) return true;
  const win = await loadWxDedupWindow(env);
  const fresh = win.filter(e => e && e.id && now - (e.ts || 0) < WX_DEDUP_WINDOW_MS);
  if (fresh.some(e => e.id === msgKey)) {
    seenWxMsgIds.set(msgKey, now);
    return true;
  }
  fresh.push({ id: msgKey, ts: now });
  if (fresh.length > WX_DEDUP_MAX) fresh.splice(0, fresh.length - WX_DEDUP_MAX);
  try { await storePutChecked(env, WX_DEDUP_KEY, JSON.stringify(fresh)); } catch (e) {}
  seenWxMsgIds.set(msgKey, now);
  for (const [k, t] of seenWxMsgIds) {
    if (now - t > WX_DEDUP_WINDOW_MS) seenWxMsgIds.delete(k);
  }
  return false;
}

async function releaseWxMsgForRetry(env, msgKey) {
  if (!msgKey) return;
  seenWxMsgIds.delete(msgKey);
  try {
    const win = await loadWxDedupWindow(env);
    const fresh = win.filter(e => !(e && e.id === msgKey));
    if (fresh.length !== win.length) await storePutChecked(env, WX_DEDUP_KEY, JSON.stringify(fresh));
  } catch (e) {}
}

// ================= 4. “对方正在输入…” 状态管理 =================
async function getOrFetchTypingTicket(env, creds, userId, contextToken) {
  const key = wxSafeId(userId);
  const cached = mapGetBounded(wxTypingTickets, key, wxTypingTicketsExp);
  if (typeof cached === 'string' && cached) return cached;
  try {
    const r = await ilinkGetConfig(creds.baseurl, creds.bot_token, userId, contextToken, wxChannelVersion(env), 8000);
    if (r && r.typing_ticket) {
      mapSetBounded(wxTypingTickets, key, r.typing_ticket, 500, wxTypingTicketsExp, 18 * 3600 * 1000);
      return r.typing_ticket;
    }
  } catch (e) {}
  return '';
}

async function sendWxTypingStatus(env, creds, userId, contextToken, status) {
  try {
    const ticket = await getOrFetchTypingTicket(env, creds, userId, contextToken);
    if (!ticket) return;
    await ilinkSendTyping(creds.baseurl, creds.bot_token, userId, ticket, status, wxChannelVersion(env), 6000);
  } catch (e) {}
}

// ================= 5. 微信文本分段辅助（兼顾可读性与 10 条配额保护） =================
function splitWechatText(text, maxLength = 3800, maxChunks = 5) {
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxLength || chunks.length >= maxChunks - 1) {
      if (remaining.length > maxLength * 2) {
        chunks.push(remaining.slice(0, maxLength * 2) + '\n\n…（内容过长，已截断显示）');
      } else {
        chunks.push(remaining);
      }
      break;
    }
    let sliceLength = maxLength;
    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    if (lastNewline > Math.floor(maxLength * 0.7)) {
      sliceLength = lastNewline;
    }
    const chunk = remaining.slice(0, sliceLength).trim();
    remaining = remaining.slice(sliceLength).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length ? chunks : [''];
}

function parseWxCommand(text) {
  const m = /^(\/[a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), rest: (m[2] || '').trim() };
}

const SUPPORTED_DOC_EXT_RE = /\.(md|markdown|txt|csv|tsv|json|jsonl|log|py|js|mjs|ts|tsx|jsx|html|htm|css|xml|yaml|yml|toml|ini|conf|sh|bash|sql|go|rs|java|c|cpp|h)$/i;

// ================= 6. 单条微信入站消息核心处理（命令 + 多模态 + Agent 循环） =================
async function processWechatMessage(env, creds, rawMsg) {
  const parsed = extractWechatMessageContent(rawMsg);
  if (!parsed.isUserMsg || !parsed.fromUserId) return { skipped: true, reason: 'not_user_msg' };

  const userId = parsed.fromUserId;
  const allowedUsers = parseCommaSeparated(env.WX_ALLOWED_USERS);
  // 自动归属人保护：如果配置了 WX_ALLOWED_USERS 则按白名单校验；
  // 如果未配置 WX_ALLOWED_USERS 但扫码凭证中已记录绑定人 ilink_user_id，则默认只允许该绑定人本人使用！
  if (allowedUsers.length > 0) {
    if (allowedUsers.indexOf(userId) === -1) {
      return { skipped: true, reason: 'user_not_in_whitelist' };
    }
  } else if (creds && creds.ilink_user_id && creds.ilink_user_id !== userId) {
    return { skipped: true, reason: 'not_bound_owner' };
  }

  let contextToken = parsed.contextToken;
  if (contextToken) {
    await saveWxContextToken(env, userId, contextToken);
  } else {
    contextToken = await getWxContextToken(env, userId);
  }
  if (!contextToken) {
    return { skipped: true, reason: 'missing_context_token' };
  }

  const dedupKey = parsed.msgId
    ? `id:${parsed.msgId}`
    : `hash:${userId}:${contextToken.slice(-24)}:${(parsed.text || '').slice(0, 48)}`;
  if (await markWxMsgSeen(env, dedupKey)) {
    return { skipped: true, reason: 'duplicate' };
  }

  const chatId = wxSessionChatId(userId);
  const chanVer = wxChannelVersion(env);
  const sendReply = async (replyText) => {
    const chunks = splitWechatText(replyText, 3800, 5);
    for (const chunk of chunks) {
      if (!chunk) continue;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await ilinkSendMessage(creds.baseurl, creds.bot_token, userId, chunk, contextToken, chanVer, 15000);
          if (r && (r.ret === -14 || r.errcode === -14)) {
            await markWxSessionExpired(env, creds, r.errmsg);
            return;
          }
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          await new Promise(r => setTimeout(r, 800));
        }
      }
    }
  };

  try {
    const { models: modelObjList } = getChannelConfig(env);
    if (modelObjList.length === 0) {
      await sendReply('⚠️ 尚未配置任何 AI 模型，请在环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1。');
      return { processed: true };
    }

    let userText = parsed.text || '';
    let historyUserText = userText;
    let multimodalContent = null;

    if (!userText && parsed.imageMedia) {
      try {
        await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        let imgBytes = null;
        if (parsed.imageMedia.encryptQueryParam) {
          imgBytes = await ilinkDownloadMediaBytes(
            creds.cdn_url,
            parsed.imageMedia.encryptQueryParam,
            parsed.imageMedia.aesKey,
            2 * 1024 * 1024,
            15000
          );
        } else if (parsed.imageMedia.url) {
          const r = await fetch(parsed.imageMedia.url, { signal: AbortSignal.timeout(15000) });
          if (r.ok) imgBytes = new Uint8Array(await r.arrayBuffer());
        }
        if (imgBytes && imgBytes.byteLength > 0) {
          const dataUrl = 'data:image/jpeg;base64,' + uint8ToBase64(imgBytes);
          userText = '请详细查看并分析这张图片的内容。';
          historyUserText = '[微信图片] ' + userText;
          multimodalContent = [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: dataUrl } },
          ];
        } else {
          await sendReply('⚠️ 暂无法读取该微信图片内容，请附带文字描述或稍后重试。');
          return { processed: true };
        }
      } catch (e) {
        await sendReply('⚠️ 读取微信图片失败：' + (e && e.message ? e.message : String(e)));
        return { processed: true };
      }
    } else if (!userText && parsed.fileMedia) {
      const fm = parsed.fileMedia;
      if (!SUPPORTED_DOC_EXT_RE.test(fm.fileName)) {
        await sendReply('⚠️ 暂仅支持文本与代码类文档（如 .md / .txt / .csv / .json / .py / .js），当前文件：' + fm.fileName);
        return { processed: true };
      }
      try {
        await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        const bytes = await ilinkDownloadMediaBytes(creds.cdn_url, fm.encryptQueryParam, fm.aesKey, 512 * 1024, 15000);
        let docText = new TextDecoder('utf-8').decode(bytes);
        if (docText.length > 60000) {
          docText = docText.slice(0, 60000) + '\n\n…（文件较长，已截取前 60000 字符）';
        }
        userText = `【上传文件：《${fm.fileName}》】\n用户说明：请阅读并总结这份文档的核心内容；如果我要求保存到知识库，请调用 save_doc 工具。\n\n文件内容如下：\n\`\`\`\n${docText}\n\`\`\``;
        historyUserText = `【上传文件：《${fm.fileName}》】`;
      } catch (e) {
        await sendReply('⚠️ 读取微信上传文件失败：' + (e && e.message ? e.message : String(e)));
        return { processed: true };
      }
    } else if (!userText && parsed.unsupportedMediaType) {
      await sendReply(`⚠️ 收到${parsed.unsupportedMediaType}，当前通道支持文字、语音转文字、图片识图及文本类文档（.md/.txt/.csv/.json/代码）。`);
      return { processed: true };
    }

    if (!userText) return { skipped: true, reason: 'empty_text' };

    let targetModelId = mapGetBounded(wxUserModels, chatId, env && env.R2 ? wxUserModelsExp : null);
    if (!targetModelId) {
      targetModelId = await storeGet(env, `tg_user_${chatId}`);
      if (targetModelId) mapSetBounded(wxUserModels, chatId, targetModelId, undefined, wxUserModelsExp);
    }
    const activeModelId = (targetModelId && modelObjList.some(m => m.id === targetModelId))
      ? targetModelId
      : modelObjList[0].id;

    const cmd = !multimodalContent ? parseWxCommand(userText) : null;

    if (cmd && (cmd.cmd === '/start' || cmd.cmd === '/model')) {
      const arg = cmd.rest.trim();
      if (cmd.cmd === '/model' && arg) {
        let picked = null;
        const idx = parseInt(arg, 10);
        if (String(idx) === arg && idx >= 1 && idx <= modelObjList.length) {
          picked = modelObjList[idx - 1];
        } else {
          const q = arg.toLowerCase();
          picked = modelObjList.find(m => m.id.toLowerCase() === q || m.name.toLowerCase() === q)
            || modelObjList.find(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        }
        if (!picked) {
          await sendReply(`⚠️ 未找到匹配的模型「${arg}」。请发送 /model 查看可用模型列表与编号。`);
          return { processed: true };
        }
        mapSetBounded(wxUserModels, chatId, picked.id, undefined, wxUserModelsExp);
        await storePut(env, `tg_user_${chatId}`, picked.id);
        await sendReply(`✅ 已切换模型为：${picked.name} (${picked.id})`);
        return { processed: true };
      }

      const useAgentNow = await agentGetMode(env, chatId);
      const listLines = modelObjList.map((m, i) => {
        const mark = m.id === activeModelId ? ' ✅ [当前]' : '';
        return `${i + 1}. ${m.name} (${m.id})${mark}`;
      }).join('\n');

      await sendReply(
        `⚡ 欢迎使用 EdgeOne-Chat 微信 ClawBot 通道 (v${APP_VERSION})\n\n`
        + `🤖 当前模式：${useAgentNow ? 'Agent 智能体模式（已开启 19 项工具 + 长期记忆 + 知识库）' : '普通对话模式'}\n`
        + `🎯 可用模型列表：\n${listLines}\n\n`
        + `💡 切换模型请发送：/model 序号（例如：/model 1）\n`
        + `📚 常用命令：/agent 切换模式 | /clear 清空上下文 | /memory 查看记忆 | /kb 查看知识库 | /help 查看帮助`
      );
      return { processed: true };
    }

    if (cmd && (cmd.cmd === '/clear' || cmd.cmd === '/new')) {
      await tgClearHistory(env, chatId);
      await agentClearResumeState(env, chatId);
      await sendReply('🧹 当前微信会话上下文已清空，可以开始新的话题了。');
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/help') {
      await sendReply(
        `🤖 微信 ClawBot 命令与功能指南：\n\n`
        + `• /model —— 查看模型列表；发「/model 序号」切换模型\n`
        + `• /agent —— 切换 🤖 Agent 模式 / 💬 普通对话模式\n`
        + `• /clear 或 /new —— 清空多轮对话上下文与断点存档\n`
        + `• /memory —— 查看全部长期记忆（平时直接说「记住…」即可保存）\n`
        + `• /forget 关键词 —— 删除包含指定关键词的记忆\n`
        + `• /kb —— 查看知识库总览（长期记忆 + 知识库文档）\n`
        + `• 发送「继续」—— 当长任务超时暂停时，接着完成剩余推理\n\n`
        + `✨ 特色支持：直接发语音（自动识别转文字回答）、发图片（Vision 识图）、上传文本/代码文件分析或存入知识库。\n`
        + `📌 版本：v${APP_VERSION} | 微信 ID：${userId}`
      );
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/memory') {
      const mems = await agentGetMemories(env, chatId);
      if (!mems.length) {
        await sendReply('🧠 暂无长期记忆。\n\n直接对我说「记住xxx」即可保存，例如：记住，我喜欢简洁的代码风格');
      } else {
        let text = `🧠 长期记忆（共 ${mems.length} 条）：\n`;
        mems.forEach((mm, i) => { text += `${i + 1}. ${mm.fact}\n`; });
        text += '\n发送「/forget 关键词」可删除记忆，或直接对我说「忘掉关于xxx的记忆」。';
        await sendReply(text);
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/kb') {
      const mems = await agentGetMemories(env, chatId);
      let text = '📚 知识库总览\n\n';
      text += `🧠 长期记忆：共 ${mems.length} 条（/memory 查看，/forget 关键词 删除）\n\n`;
      text += await toolListDocs(env);
      text += '\n\n💾 保存文档：对我说「把…存成知识库文档」；🗑️ 删文档：说「删除知识库文档《标题》」';
      await sendReply(text);
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/forget') {
      const kw = cmd.rest;
      if (!kw) {
        await sendReply('用法：/forget 关键词\n例如：/forget 猫 —— 删除所有包含「猫」的记忆');
      } else {
        const rr = await agentForgetMemory(env, chatId, kw);
        await sendReply(rr.persistError ? '⚠️ ' + rr.persistError : (rr.removed > 0 ? `🗑 已删除 ${rr.removed} 条包含「${kw}」的记忆。` : `没有找到包含「${kw}」的记忆。`));
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/agent') {
      const cur = await agentGetMode(env, chatId);
      await agentSetMode(env, chatId, !cur);
      await sendReply(
        !cur
          ? '🤖 Agent 模式已开启\n\n我会自主规划并调用 19 项工具（🔍 联网搜索、📄 网页抓取、🌐 维基百科、🐙 GitHub、🎓 arXiv、🔥 热榜、💱 汇率/币价、🖧 DNS/IP、🧮 计算、📏 换算、🔤 编码、🌤 天气、🕐 时间），并支持 🧠 长期记忆与 📚 知识库文档读写。'
          : '💬 已切换为普通对话模式\n\n单轮直接问答，不调用工具、不使用长期记忆。如需 Agent 能力请再发 /agent 切回。'
      );
      return { processed: true };
    }

    await sendWxTypingStatus(env, creds, userId, contextToken, 1);

    const useAgent = await agentGetMode(env, chatId);
    const wantResume = useAgent && !multimodalContent && userText.trim() === '继续';
    let resumeState = null;
    if (wantResume) resumeState = await agentLoadResumeState(env, chatId);
    if (useAgent && !resumeState) await agentClearResumeState(env, chatId);

    const baseHistory = await tgGetHistory(env, chatId);
    let history = baseHistory.slice();
    if (!resumeState) {
      history.push({ role: 'user', content: multimodalContent || userText });
      history = tgTrimHistory(history, env);
    }

    let replyText = null;
    let agentErr = null;

    let wxBudgetMs = parseInt(env.WX_WEBHOOK_BUDGET_MS || env.TG_WEBHOOK_BUDGET_MS || '55000', 10);
    if (!(wxBudgetMs >= 10000)) wxBudgetMs = 55000;
    if (wxBudgetMs > 240000) wxBudgetMs = 240000;

    let lastTypingSent = Date.now();
    const wxCompatApi = async (method) => {
      if (method === 'sendChatAction') {
        const now = Date.now();
        if (now - lastTypingSent >= 5000) {
          lastTypingSent = now;
          await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        }
      }
      return { ok: true };
    };

    if (useAgent && !multimodalContent) {
      const onProgress = async () => {
        const now = Date.now();
        if (now - lastTypingSent >= 5500) {
          lastTypingSent = now;
          await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        }
      };
      const agentOpts = {
        maxRuntimeMs: wxBudgetMs,
        resumeKey: tgAgentResumeKey(chatId),
        origUserText: historyUserText,
      };
      const runAgentTurn = (allowTools) => {
        if (resumeState) {
          return tgAgentResume(env, wxCompatApi, chatId, {
            targetModelId: resumeState.targetModelId || activeModelId,
            allowTools,
            messages: resumeState.messages,
            loopStartIdx: resumeState.loopStartIdx,
            origUserText: resumeState.origUserText || '',
          }, onProgress, agentOpts);
        }
        return tgAgentChat(env, wxCompatApi, chatId, activeModelId, history, allowTools, onProgress, agentOpts);
      };

      let r;
      try {
        r = await runAgentTurn(true);
        if (r.fallback) r = await runAgentTurn(false);
      } catch (e) {
        r = { error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) };
      }

      if (r.error) {
        agentErr = r.error;
      } else {
        replyText = r.text;
        if (!r.paused) {
          if (!r.isImage && replyText) {
            let finalHist = baseHistory.slice();
            const qToSave = resumeState ? (resumeState.origUserText || '') : historyUserText;
            if (qToSave) finalHist.push({ role: 'user', content: qToSave });
            finalHist.push({ role: 'assistant', content: replyText });
            finalHist = tgTrimHistory(finalHist, env);
            await tgSaveHistory(env, chatId, finalHist);
          }
          await agentClearResumeState(env, chatId);
        }
      }
    } else {
      // 普通非 Agent 对话或多模态图片问答（复用 EdgeOne-Chat 多密钥轮换池）
      const aiConfig = buildAIRequest(env, activeModelId, history, false);
      if (aiConfig.error) {
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);
        await sendReply('⚠️ ' + aiConfig.error);
        return { processed: true };
      }
      const { payload } = aiConfig;
      let aiResponse = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await fetchWithKeyRotation(aiConfig, (key) => ({
            method: 'POST',
            headers: authHeaders(key),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(60000),
          }));
          aiResponse = r.resp;
          break;
        } catch (e) {
          aiResponse = null;
          if (attempt >= 2) {
            agentErr = '⚠️ 上游接口请求失败，请稍后再试。';
            break;
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!agentErr) {
        if (aiResponse && aiResponse.ok) {
          const aiData = await aiResponse.json();
          if (aiData.choices && aiData.choices[0]?.message) {
            replyText = aiData.choices[0].message.content;
          } else if (aiData.data && aiData.data[0]?.url) {
            replyText = `🖼️ 生成的图片链接：\n${aiData.data[0].url}`;
          } else {
            replyText = 'AI 没有返回有效内容。';
          }
          if (aiData.choices && aiData.choices[0]?.message && replyText) {
            let finalHist = baseHistory.slice();
            finalHist.push({ role: 'user', content: historyUserText });
            finalHist.push({ role: 'assistant', content: replyText });
            finalHist = tgTrimHistory(finalHist, env);
            await tgSaveHistory(env, chatId, finalHist);
          }
        } else {
          let diag = '';
          if (aiResponse) {
            try {
              diag = `（HTTP ${aiResponse.status}：${await readErrorBody(aiResponse, 300)}）`;
            } catch (e) {}
          }
          agentErr = (multimodalContent ? '⚠️ 当前模型可能不支持图片识别（请用 /model 切换多模态模型）。' : '⚠️ AI 接口请求失败，请稍后再试。') + diag;
        }
      }
    }

    await sendWxTypingStatus(env, creds, userId, contextToken, 2);

    if (agentErr) {
      await sendReply(agentErr);
      return { processed: true };
    }
    if (replyText) {
      await sendReply(replyText);
    }
    return { processed: true };
  } catch (err) {
    await releaseWxMsgForRetry(env, dedupKey);
    await sendWxTypingStatus(env, creds, userId, contextToken, 2);
    throw err;
  }
}

// ================= 7. 长轮询引擎（支持网页实时轮询与外部定时触发器） =================
async function acquirePollLock(env, ttlMs) {
  if (activePollInIsolate) return false;
  activePollInIsolate = true;
  if (!env || !env.R2) return true;
  try {
    const raw = await storeGet(env, WX_POLL_LOCK_KEY);
    const now = Date.now();
    if (raw) {
      const lock = JSON.parse(raw);
      if (lock && lock.exp > now) {
        activePollInIsolate = false;
        return false;
      }
    }
    await storePut(env, WX_POLL_LOCK_KEY, JSON.stringify({ exp: now + (ttlMs || 35000) }));
  } catch (e) {}
  return true;
}

async function releasePollLock(env) {
  activePollInIsolate = false;
  if (env && env.R2) {
    try { await storeDelete(env, WX_POLL_LOCK_KEY); } catch (e) {}
  }
}

async function runWechatPollCycle(env, opts) {
  opts = opts || {};
  const creds = await getWxCredentials(env);
  if (!creds || !creds.bot_token) {
    return { ok: false, reason: 'not_configured', message: '尚未绑定微信 ClawBot，请先扫码绑定或配置 WX_BOT_TOKEN' };
  }
  if (creds.expired) {
    return { ok: false, reason: 'session_expired', expired: true, message: creds.errmsg || '微信 ClawBot 会话已过期 (ret=-14)，请重新扫码绑定' };
  }

  // EdgeOne Cloud Functions 支持最高 120s maxDuration
  const maxRuntimeMs = Math.min(Math.max(parseInt(opts.maxRuntimeMs || env.WX_POLL_BUDGET_MS || '25000', 10) || 25000, 3000), 90000);
  const longPollTimeoutMs = Math.min(Math.max(parseInt(opts.longPollTimeoutMs || '20000', 10) || 20000, 3000), 35000);
  const maxRounds = Math.min(Math.max(parseInt(opts.maxRounds || '4', 10) || 4, 1), 10);

  if (!(await acquirePollLock(env, maxRuntimeMs + 5000))) {
    return { ok: true, locked: true, received: 0, processed: 0, message: '已有另一个轮询实例正在运行' };
  }

  const deadline = Date.now() + maxRuntimeMs;
  let totalReceived = 0;
  let totalProcessed = 0;
  let cursor = await getWxCursor(env, creds.ilink_bot_id);
  const chanVer = wxChannelVersion(env);

  try {
    for (let round = 0; round < maxRounds; round++) {
      const remainMs = deadline - Date.now();
      if (remainMs < 2500) break;
      const pollTimeout = Math.min(longPollTimeoutMs, Math.max(2500, remainMs - 500));

      const resp = await ilinkGetUpdates(creds.baseurl, creds.bot_token, cursor, chanVer, pollTimeout);
      if (resp && (resp.ret === -14 || resp.errcode === -14)) {
        await markWxSessionExpired(env, creds, resp.errmsg);
        return {
          ok: false,
          reason: 'session_expired',
          expired: true,
          received: totalReceived,
          processed: totalProcessed,
          message: '微信 ClawBot 会话已过期 (ret=-14)，请重新扫码绑定',
        };
      }

      if (resp && typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) {
        cursor = resp.get_updates_buf;
        await saveWxCursor(env, creds.ilink_bot_id, cursor);
      }

      const msgs = (resp && Array.isArray(resp.msgs)) ? resp.msgs : [];
      totalReceived += msgs.length;

      for (const m of msgs) {
        try {
          const r = await processWechatMessage(env, creds, m);
          if (r && r.processed) totalProcessed += 1;
        } catch (err) {
          console.log('处理微信 ClawBot 消息异常:', err);
        }
      }

      if (opts.singleShot || resp.timedOut) break;
    }

    return {
      ok: true,
      received: totalReceived,
      processed: totalProcessed,
      botId: creds.ilink_bot_id,
      userId: creds.ilink_user_id,
    };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      received: totalReceived,
      processed: totalProcessed,
    };
  } finally {
    await releasePollLock(env);
  }
}

// ================= 8. Webhook 接收器（POST /wx-webhook） =================
async function handleWxWebhook(request, env) {
  if (env.WX_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Wechat-Webhook-Secret')
      || request.headers.get('X-Webhook-Secret')
      || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
      || '';
    if (!safeEqual(got, env.WX_WEBHOOK_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  try {
    const payload = await request.json();
    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token) {
      return new Response(JSON.stringify({ ok: false, error: 'WX_BOT_TOKEN or QR login not configured' }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    if (payload && typeof payload.get_updates_buf === 'string' && payload.get_updates_buf) {
      await saveWxCursor(env, creds.ilink_bot_id, payload.get_updates_buf);
    }

    const msgs = Array.isArray(payload && payload.msgs)
      ? payload.msgs
      : (payload && (payload.from_user_id || payload.user_id || payload.msg) ? [payload.msg || payload] : []);

    let processed = 0;
    for (const m of msgs) {
      try {
        const r = await processWechatMessage(env, creds, m);
        if (r && r.processed) processed += 1;
      } catch (e) {
        console.log('Webhook 处理微信消息异常:', e);
      }
    }

    return new Response(JSON.stringify({ ok: true, received: msgs.length, processed }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
}

// ================= 9. Web 管理端接口（/api/wx/*，带强制防盗绑鉴权） =================
function maskToken(token) {
  const s = String(token || '');
  if (s.length <= 12) return s ? '***' : '';
  return s.slice(0, 6) + '…' + s.slice(-6);
}

async function handleWxApi(request, env, url) {
  const path = url.pathname;
  const chanVer = wxChannelVersion(env);
  const defaultBase = normalizeBaseUrl((env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL);
  const auth = checkWxAdminAuth(env, request, url);

  // 1) 查询状态：未通过管理员口令校验时，只返回脱敏的布尔状态与鉴权提示，不暴露任何 userId / botId
  if (request.method === 'GET' && path === '/api/wx/status') {
    const creds = await getWxCredentials(env, true);
    const connected = !!(creds && creds.bot_token && !creds.expired);
    if (!auth.authorized) {
      return new Response(JSON.stringify({
        ok: true,
        adminAuthorized: false,
        noSecretConfigured: auth.noSecretConfigured,
        authReason: auth.reason,
        connected,
        expired: !!(creds && creds.expired),
        r2Bound: !!(env && env.R2),
        channelVersion: chanVer,
      }), { status: 200, headers: CORS_HEADERS });
    }
    const lastPeer = await getWxLastPeer(env);
    const cursor = creds ? await getWxCursor(env, creds.ilink_bot_id) : '';
    return new Response(JSON.stringify({
      ok: true,
      adminAuthorized: true,
      noSecretConfigured: false,
      connected,
      expired: !!(creds && creds.expired),
      errmsg: (creds && creds.errmsg) || '',
      source: (creds && creds.source) || null,
      botId: (creds && creds.ilink_bot_id) || '',
      userId: (creds && creds.ilink_user_id) || (lastPeer && lastPeer.user_id) || '',
      baseUrl: (creds && creds.baseurl) || defaultBase,
      maskedToken: creds ? maskToken(creds.bot_token) : '',
      hasCursor: !!cursor,
      updatedAt: (creds && creds.updated_at) || '',
      r2Bound: !!(env && env.R2),
      channelVersion: chanVer,
    }), { status: 200, headers: CORS_HEADERS });
  }

  // 其余所有操作均要求通过管理员鉴权！
  if (!auth.authorized) {
    return new Response(JSON.stringify({
      ok: false,
      code: auth.noSecretConfigured ? 'NO_SECRET_CONFIGURED' : 'WX_ADMIN_UNAUTHORIZED',
      error: auth.reason,
    }), { status: auth.noSecretConfigured ? 403 : 401, headers: CORS_HEADERS });
  }

  // 2) 获取微信 ClawBot 扫码绑定二维码（带防覆盖锁）
  if (request.method === 'POST' && path === '/api/wx/qrcode') {
    const existing = await getWxCredentials(env, true);
    if (existing && existing.source === 'env') {
      return new Response(JSON.stringify({
        ok: false,
        error: '当前已通过环境变量 WX_BOT_TOKEN 固定绑定，Web 端扫码已锁定，无法覆盖。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    if (existing && existing.bot_token && !existing.expired && !body.force) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'ALREADY_BOUND',
        error: '当前已绑定微信账号（' + (existing.ilink_user_id || existing.ilink_bot_id) + '）。为防误覆盖，请先点击「解绑」后再重新扫码。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    try {
      const qrData = await ilinkGetQrCode(defaultBase, chanVer, 12000);
      if (!qrData || !qrData.qrcode) {
        return new Response(JSON.stringify({
          ok: false,
          error: '微信 iLink 未返回有效二维码：' + JSON.stringify(qrData || {}),
        }), { status: 502, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify({
        ok: true,
        qrcode: qrData.qrcode,
        qrcode_img_content: qrData.qrcode_img_content || '',
        ret: qrData.ret ?? 0,
      }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: e && e.message ? e.message : String(e),
      }), { status: 500, headers: CORS_HEADERS });
    }
  }

  // 3) 轮询扫码状态，确认后自动保存凭证到 Blob/KV 并调用 notifystart
  if (request.method === 'GET' && path === '/api/wx/qrcode-status') {
    const qrcode = (url.searchParams.get('qrcode') || '').trim();
    if (!qrcode) {
      return new Response(JSON.stringify({ ok: false, error: '缺少 qrcode 参数' }), { status: 400, headers: CORS_HEADERS });
    }
    try {
      const st = await ilinkGetQrStatus(defaultBase, qrcode, chanVer, 8000);
      const status = st.status || 'wait';
      if (status === 'confirmed' && st.bot_token) {
        const allowedUsers = parseCommaSeparated(env.WX_ALLOWED_USERS);
        if (allowedUsers.length > 0 && st.ilink_user_id && allowedUsers.indexOf(st.ilink_user_id) === -1) {
          return new Response(JSON.stringify({
            ok: false,
            status: 'rejected',
            error: `扫码微信号 (${st.ilink_user_id}) 不在 WX_ALLOWED_USERS 白名单中，已拒绝绑定。`,
          }), { status: 403, headers: CORS_HEADERS });
        }

        const newCreds = {
          bot_token: st.bot_token,
          ilink_bot_id: st.ilink_bot_id || (st.bot_token.includes(':') ? st.bot_token.split(':')[0] : 'wx_bot'),
          ilink_user_id: st.ilink_user_id || '',
          baseurl: normalizeBaseUrl(st.baseurl || defaultBase),
          cdn_url: String((env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
          expired: false,
          errmsg: '',
          updated_at: new Date().toISOString(),
        };
        const savedOk = await saveWxCredentials(env, newCreds);
        await saveWxCursor(env, newCreds.ilink_bot_id, '');
        await ilinkNotifyStart(newCreds.baseurl, newCreds.bot_token, chanVer, 6000);
        return new Response(JSON.stringify({
          ok: true,
          status: 'confirmed',
          persisted: savedOk,
          r2Bound: !!(env && env.R2),
          botId: newCreds.ilink_bot_id,
          userId: newCreds.ilink_user_id,
          baseUrl: newCreds.baseurl,
          maskedToken: maskToken(newCreds.bot_token),
        }), { status: 200, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify({
        ok: true,
        status,
        ret: st.ret ?? 0,
      }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: e && e.message ? e.message : String(e),
      }), { status: 500, headers: CORS_HEADERS });
    }
  }

  // 4) 手动、前端或外部定时触发器触发微信消息长轮询（支持 ?key=<WX_ADMIN_SECRET>&timeout_ms=50000）
  if ((request.method === 'POST' || request.method === 'GET') && path === '/api/wx/poll') {
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) { body = {}; }
    }
    const maxRuntimeMs = parseInt(body.timeout_ms || url.searchParams.get('timeout_ms') || '20000', 10) || 20000;
    const singleShot = body.single_shot !== undefined
      ? !!body.single_shot
      : (url.searchParams.get('single_shot') !== '0');
    const result = await runWechatPollCycle(env, {
      maxRuntimeMs: Math.min(Math.max(maxRuntimeMs, 3000), 85000),
      longPollTimeoutMs: Math.min(Math.max(maxRuntimeMs - 1000, 3000), 28000),
      maxRounds: singleShot ? 1 : 4,
      singleShot,
    });
    return new Response(JSON.stringify(result), { status: 200, headers: CORS_HEADERS });
  }

  // 5) 主动向微信用户发送消息
  if (request.method === 'POST' && path === '/api/wx/send') {
    let body = {};
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: '无效的 JSON 请求体' }), { status: 400, headers: CORS_HEADERS });
    }
    const text = String(body.text || '').trim();
    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: '消息内容 text 不能为空' }), { status: 400, headers: CORS_HEADERS });
    }
    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token) {
      return new Response(JSON.stringify({ ok: false, error: '微信 ClawBot 尚未绑定' }), { status: 400, headers: CORS_HEADERS });
    }
    const lastPeer = await getWxLastPeer(env);
    const toUserId = String(body.to_user_id || creds.ilink_user_id || (lastPeer && lastPeer.user_id) || '').trim();
    if (!toUserId) {
      return new Response(JSON.stringify({
        ok: false,
        error: '未知的目标微信用户 ID，请先在手机微信向 ClawBot 发送一条消息以激活会话',
      }), { status: 400, headers: CORS_HEADERS });
    }
    const contextToken = String(
      body.context_token
      || (await getWxContextToken(env, toUserId))
      || (lastPeer && lastPeer.context_token)
      || ''
    ).trim();
    if (!contextToken) {
      return new Response(JSON.stringify({
        ok: false,
        error: '缺少 context_token，请先在手机微信向 ClawBot 发送一条消息以获取上下文令牌',
      }), { status: 400, headers: CORS_HEADERS });
    }
    try {
      const r = await ilinkSendMessage(creds.baseurl, creds.bot_token, toUserId, text, contextToken, chanVer, 15000);
      if (r && (r.ret === -14 || r.errcode === -14)) {
        await markWxSessionExpired(env, creds, r.errmsg);
        return new Response(JSON.stringify({ ok: false, expired: true, error: '会话已过期 (ret=-14)，请重新扫码绑定' }), {
          status: 401,
          headers: CORS_HEADERS,
        });
      }
      return new Response(JSON.stringify({ ok: true, to_user_id: toUserId, result: r }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  }

  // 6) 解绑 / 退出当前微信 ClawBot 登录凭证
  if (request.method === 'POST' && path === '/api/wx/logout') {
    const creds = await getWxCredentials(env);
    if (creds && creds.source === 'env') {
      return new Response(JSON.stringify({
        ok: false,
        error: '当前通过环境变量 WX_BOT_TOKEN 绑定，请在控制台移除该变量以解绑。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    if (creds && creds.bot_token) {
      await ilinkNotifyStop(creds.baseurl, creds.bot_token, chanVer, 5000);
    }
    await clearWxCredentials(env);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: CORS_HEADERS });
}

export {
  wxSessionChatId,
  checkWxAdminAuth,
  getWxCredentials,
  saveWxCredentials,
  clearWxCredentials,
  getWxContextToken,
  saveWxContextToken,
  getWxCursor,
  saveWxCursor,
  splitWechatText,
  parseWxCommand,
  processWechatMessage,
  runWechatPollCycle,
  handleWxWebhook,
  handleWxApi,
};
