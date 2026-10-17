// 微信 ClawBot（腾讯官方 iLink Bot API / @tencent-weixin/openclaw-weixin 协议）底层通信与消息解析层
// 支持：
// 1) 二维码获取（get_bot_qrcode）与扫码确认状态轮询（get_qrcode_status）；
// 2) 会话生命周期通知（ilink/bot/msg/notifystart & notifystop）；
// 3) 长轮询增量消息拉取（ilink/bot/getupdates，支持 get_updates_buf 游标与 -14 过期检测）；
// 4) 文本消息投递（ilink/bot/sendmessage，完整对齐 client_id / message_type=2 / message_state=2 / context_token / base_info）；
// 5) 原生“对方正在输入…”状态指示器（ilink/bot/getconfig 获取 typing_ticket + ilink/bot/sendtyping 续期/关闭）；
// 6) CDN 媒体 AES-128-ECB 硬件加速解密下载（支持微信发图 Vision 多模态识图与语音转文字提取）。

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_ILINK_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const DEFAULT_ILINK_CHANNEL_VERSION = '2.4.10';
const DEFAULT_BOT_AGENT = 'openclaw-weixin';
const ILINK_BOT_TYPE = 3;

// 将语义化版本号（如 "2.4.10"）编码为 iLink-App-ClientVersion 所需的 uint32 (0x00MMNNPP)
function buildClientVersion(version) {
  const v = String(version || DEFAULT_ILINK_CHANNEL_VERSION).trim();
  const parts = v.split('.').map(p => parseInt(p, 10) || 0);
  const major = (parts[0] || 0) & 0xff;
  const minor = (parts[1] || 0) & 0xff;
  const patch = (parts[2] || 0) & 0xff;
  return (((major << 16) | (minor << 8) | patch) >>> 0);
}

// 每次请求生成新的 X-WECHAT-UIN：随机 uint32 -> 十进制字符串 -> Base64
function randomWechatUin() {
  let u32 = 0;
  try {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    u32 = arr[0] >>> 0;
  } catch (e) {
    u32 = (Math.floor(Math.random() * 0xffffffff) >>> 0);
  }
  return btoa(String(u32));
}

function normalizeBaseUrl(baseUrl) {
  const s = String(baseUrl || DEFAULT_ILINK_BASE_URL).trim().replace(/\/+$/, '');
  return s || DEFAULT_ILINK_BASE_URL;
}

function buildBaseInfo(channelVersion) {
  return {
    channel_version: String(channelVersion || DEFAULT_ILINK_CHANNEL_VERSION).trim() || DEFAULT_ILINK_CHANNEL_VERSION,
    bot_agent: DEFAULT_BOT_AGENT,
  };
}

function buildIlinkHeaders(token, channelVersion) {
  const headers = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-ClientVersion': String(buildClientVersion(channelVersion)),
  };
  if (token) {
    headers['Authorization'] = 'Bearer ' + String(token).trim();
  }
  return headers;
}

// 通用 iLink POST JSON 调用封装
async function ilinkPost(baseUrl, endpoint, bodyObj, token, channelVersion, timeoutMs) {
  const base = normalizeBaseUrl(baseUrl);
  const ep = String(endpoint || '').replace(/^\/+/, '');
  const payload = Object.assign({}, bodyObj || {}, {
    base_info: buildBaseInfo(channelVersion),
  });
  const raw = JSON.stringify(payload);
  const headers = buildIlinkHeaders(token, channelVersion);
  const res = await fetch(`${base}/${ep}`, {
    method: 'POST',
    headers,
    body: raw,
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  if (!res.ok) {
    let errBody = '';
    try { errBody = (await res.text()).slice(0, 400); } catch (e) {}
    const err = new Error(`iLink HTTP ${res.status}${errBody ? ': ' + errBody : ''}`);
    err.status = res.status;
    throw err;
  }
  const text = (await res.text()).trim();
  if (!text || text === '{}') return { ret: 0 };
  try {
    return JSON.parse(text);
  } catch (e) {
    return { ret: 0, raw: text };
  }
}

// 1. 获取微信 ClawBot 登录二维码
async function ilinkGetQrCode(baseUrl, channelVersion, timeoutMs) {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}/ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'iLink-App-ClientVersion': String(buildClientVersion(channelVersion)),
      'X-WECHAT-UIN': randomWechatUin(),
    },
    signal: AbortSignal.timeout(timeoutMs || 12000),
  });
  if (!res.ok) {
    throw new Error(`获取二维码失败 (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data || {};
}

// 2. 轮询二维码扫码状态（wait -> scaned -> confirmed | expired）
async function ilinkGetQrStatus(baseUrl, qrcode, channelVersion, timeoutMs) {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(String(qrcode || '').trim())}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'iLink-App-ClientVersion': String(buildClientVersion(channelVersion)),
        'X-WECHAT-UIN': randomWechatUin(),
      },
      signal: AbortSignal.timeout(timeoutMs || 10000),
    });
    if (!res.ok) {
      throw new Error(`查询扫码状态失败 (HTTP ${res.status})`);
    }
    const data = await res.json();
    return data || { status: 'wait' };
  } catch (e) {
    const nm = (e && e.name) ? String(e.name) : '';
    const msg = String((e && e.message) || '');
    if (nm === 'AbortError' || nm === 'TimeoutError' || /abort|timeout/i.test(msg)) {
      return { ret: 0, status: 'wait', timedOut: true };
    }
    throw e;
  }
}

// 3. 会话生命周期通知（notifyStart / notifyStop）
async function ilinkNotifyStart(baseUrl, token, channelVersion, timeoutMs) {
  try {
    return await ilinkPost(baseUrl, 'ilink/bot/msg/notifystart', {}, token, channelVersion, timeoutMs || 8000);
  } catch (e) {
    return { ret: -1, errmsg: e && e.message ? e.message : String(e) };
  }
}

async function ilinkNotifyStop(baseUrl, token, channelVersion, timeoutMs) {
  try {
    return await ilinkPost(baseUrl, 'ilink/bot/msg/notifystop', {}, token, channelVersion, timeoutMs || 6000);
  } catch (e) {
    return { ret: -1, errmsg: e && e.message ? e.message : String(e) };
  }
}

// 4. 长轮询获取新消息（getupdates）
async function ilinkGetUpdates(baseUrl, token, getUpdatesBuf, channelVersion, timeoutMs) {
  try {
    const data = await ilinkPost(
      baseUrl,
      'ilink/bot/getupdates',
      { get_updates_buf: String(getUpdatesBuf || '') },
      token,
      channelVersion,
      timeoutMs || 28000
    );
    return data || { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf || '' };
  } catch (e) {
    const nm = (e && e.name) ? String(e.name) : '';
    const msg = String((e && e.message) || '');
    if (nm === 'AbortError' || nm === 'TimeoutError' || /abort|timeout/i.test(msg)) {
      return { ret: 0, msgs: [], get_updates_buf: String(getUpdatesBuf || ''), timedOut: true };
    }
    throw e;
  }
}

// 5. 获取用户配置（用于提取 typing_ticket）
async function ilinkGetConfig(baseUrl, token, userId, contextToken, channelVersion, timeoutMs) {
  const body = { ilink_user_id: String(userId || '') };
  if (contextToken) body.context_token = String(contextToken);
  return await ilinkPost(baseUrl, 'ilink/bot/getconfig', body, token, channelVersion, timeoutMs || 10000);
}

// 6. 发送/取消“对方正在输入…”状态（status: 1=开始输入, 2=停止输入）
async function ilinkSendTyping(baseUrl, token, userId, typingTicket, status, channelVersion, timeoutMs) {
  const st = status === 2 ? 2 : 1;
  const body = {
    ilink_user_id: String(userId || ''),
    to_user_id: String(userId || ''),
    typing_ticket: String(typingTicket || ''),
    status: st,
    command: st,
  };
  return await ilinkPost(baseUrl, 'ilink/bot/sendtyping', body, token, channelVersion, timeoutMs || 8000);
}

// 7. 发送文本消息（sendmessage）
async function ilinkSendMessage(baseUrl, token, toUserId, text, contextToken, channelVersion, timeoutMs) {
  const clientId = 'eochat-wx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: String(toUserId || ''),
      client_id: clientId,
      message_type: 2, // 2 = BOT 消息
      message_state: 2, // 2 = FINISH
      context_token: String(contextToken || ''),
      item_list: [
        {
          type: 1,
          text_item: { text: String(text || '') },
        },
      ],
    },
  };
  return await ilinkPost(baseUrl, 'ilink/bot/sendmessage', body, token, channelVersion, timeoutMs || 15000);
}

// ================= 微信 CDN 媒体 AES-128-ECB 解密辅助（用于收图多模态 Vision） =================
function parseIlinkAesKey(rawKey) {
  const s = String(rawKey || '').trim();
  if (!s) return null;
  const hexToBytes = (hex) => {
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  if (/^[0-9a-fA-F]{32}$/.test(s)) return hexToBytes(s);
  try {
    const bin = atob(s);
    if (bin.length === 16) {
      const out = new Uint8Array(16);
      for (let i = 0; i < 16; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (bin.length === 32 && /^[0-9a-fA-F]{32}$/.test(bin)) {
      return hexToBytes(bin);
    }
  } catch (e) {}
  return null;
}

// 利用 WebCrypto 原生硬件加速的 AES-CBC 构造零依赖 AES-128-ECB + PKCS#7 解密
async function decryptAes128Ecb(cipherBytes, key16) {
  if (!cipherBytes || cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) return null;
  const n = cipherBytes.length;
  const zeroIv = new Uint8Array(16);
  const cryptoKey = await crypto.subtle.importKey('raw', key16.subarray(0, 16), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);

  const lastBlockXorPad = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    lastBlockXorPad[i] = cipherBytes[n - 16 + i] ^ 16;
  }
  const tailEncBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, cryptoKey, lastBlockXorPad);
  const tailBlock = new Uint8Array(tailEncBuf).subarray(0, 16);

  const extended = new Uint8Array(n + 16);
  extended.set(cipherBytes, 0);
  extended.set(tailBlock, n);

  const cbcDecBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: zeroIv }, cryptoKey, extended);
  const out = new Uint8Array(cbcDecBuf);

  for (let i = 16; i < n; i++) {
    out[i] ^= cipherBytes[i - 16];
  }

  const pad = out[n - 1];
  if (pad >= 1 && pad <= 16) {
    let validPad = true;
    for (let i = n - pad; i < n; i++) {
      if (out[i] !== pad) { validPad = false; break; }
    }
    if (validPad) return out.subarray(0, n - pad);
  }
  return out;
}

// 从微信 CDN 下载并解密媒体文件
async function ilinkDownloadMediaBytes(cdnBaseUrl, encryptQueryParam, rawAesKey, maxBytes, timeoutMs) {
  const cdn = String(cdnBaseUrl || DEFAULT_ILINK_CDN_URL).trim().replace(/\/+$/, '');
  const eqp = String(encryptQueryParam || '').trim();
  if (!eqp) throw new Error('缺少 encrypted_query_param');
  const url = `${cdn}/download?encrypted_query_param=${encodeURIComponent(eqp)}`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  if (!res.ok) throw new Error(`CDN 下载失败 (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  if (maxBytes && buf.byteLength > maxBytes) {
    throw new Error(`媒体文件超过大小限制（最大 ${Math.round(maxBytes / 1024)} KB）`);
  }
  const encrypted = new Uint8Array(buf);
  const key16 = parseIlinkAesKey(rawAesKey);
  if (!key16) return encrypted;
  return (await decryptAes128Ecb(encrypted, key16)) || encrypted;
}

// 解析入站 iLink 消息体：提取文本、语音转写、引用上下文及图片/文件媒体描述
function extractWechatMessageContent(msg) {
  if (!msg || typeof msg !== 'object') {
    return { text: '', isUserMsg: false, fromUserId: '', contextToken: '', msgId: '' };
  }
  const fromUserId = String(msg.from_user_id || msg.user_id || '').trim();
  const contextToken = String(msg.context_token || '').trim();
  const msgType = msg.message_type !== undefined ? Number(msg.message_type) : 1;
  const isUserMsg = msgType === 1 && !!fromUserId;
  const msgId = String(msg.msg_id || msg.message_id || msg.seq || msg.client_id || '').trim();

  if (typeof msg.text === 'string' && msg.text.trim() && !Array.isArray(msg.item_list)) {
    return {
      text: msg.text.trim(),
      isUserMsg,
      fromUserId,
      contextToken,
      msgId,
      imageMedia: null,
      fileMedia: null,
    };
  }

  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const textParts = [];
  let quotePrefix = '';
  let imageMedia = null;
  let fileMedia = null;
  let unsupportedMediaType = '';

  if (msg.ref_msg && (msg.ref_msg.title || msg.ref_msg.content)) {
    const q = String(msg.ref_msg.content || msg.ref_msg.title || '').trim();
    if (q) quotePrefix = `【引用消息：${q.slice(0, 300)}】\n`;
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const t = Number(item.type);
    if (item.ref_msg && !quotePrefix) {
      const q = String(item.ref_msg.content || item.ref_msg.title || '').trim();
      if (q) quotePrefix = `【引用消息：${q.slice(0, 300)}】\n`;
    }
    if (t === 1 && item.text_item && typeof item.text_item.text === 'string') {
      const txt = item.text_item.text.trim();
      if (txt) textParts.push(txt);
    } else if (t === 3 && item.voice_item) {
      const vTxt = String(item.voice_item.text || item.voice_item.transcription || '').trim();
      if (vTxt) {
        textParts.push(vTxt);
      } else {
        unsupportedMediaType = '未包含文字转写的语音消息';
      }
    } else if (t === 2 && item.image_item) {
      const img = item.image_item;
      const media = img.media || {};
      const eqp = media.encrypt_query_param || img.encrypt_query_param || '';
      const aesKey = media.aes_key || img.aeskey || img.aes_key || '';
      const directUrl = img.url || media.url || '';
      if (eqp || directUrl) {
        imageMedia = { encryptQueryParam: eqp, aesKey, url: directUrl };
      } else {
        unsupportedMediaType = '图片消息（缺少媒体参数）';
      }
    } else if ((t === 4 || t === 3) && item.file_item) {
      const fi = item.file_item;
      const media = fi.media || {};
      const fileName = String(fi.file_name || fi.filename || 'document.txt');
      const eqp = media.encrypt_query_param || fi.encrypt_query_param || '';
      const aesKey = media.aes_key || fi.aeskey || fi.aes_key || '';
      if (eqp) {
        fileMedia = { fileName, encryptQueryParam: eqp, aesKey, fileSize: fi.file_size || fi.rawsize || 0 };
      } else {
        unsupportedMediaType = `文件《${fileName}》`;
      }
    } else if (t === 5 || item.video_item) {
      unsupportedMediaType = '视频消息';
    }
  }

  const combinedText = (quotePrefix ? quotePrefix + textParts.join('\n') : textParts.join('\n')).trim();
  return {
    text: combinedText,
    isUserMsg,
    fromUserId,
    contextToken,
    msgId,
    imageMedia,
    fileMedia,
    unsupportedMediaType,
  };
}

export {
  DEFAULT_ILINK_BASE_URL,
  DEFAULT_ILINK_CDN_URL,
  DEFAULT_ILINK_CHANNEL_VERSION,
  DEFAULT_BOT_AGENT,
  ILINK_BOT_TYPE,
  buildClientVersion,
  randomWechatUin,
  normalizeBaseUrl,
  buildBaseInfo,
  buildIlinkHeaders,
  ilinkPost,
  ilinkGetQrCode,
  ilinkGetQrStatus,
  ilinkNotifyStart,
  ilinkNotifyStop,
  ilinkGetUpdates,
  ilinkGetConfig,
  ilinkSendTyping,
  ilinkSendMessage,
  parseIlinkAesKey,
  decryptAes128Ecb,
  ilinkDownloadMediaBytes,
  extractWechatMessageContent,
};
