// 存储适配层入口：为 EdgeOne 环境构造一个「长得像 R2」的对象，挂到 env.R2 上。
//
// 设计原则：让上层业务代码零改动。
//   原项目里 store/r2.js、store/kb.js、kb/registry.js、kb/doc-tools.js、agent/memory.js、
//   agent/resume.js、agent/mode.js、telegram/handler.js 全部直接调用 env.R2.get/put/delete/list，
//   所以这里只要提供一个接口一致的替身，那 8 个文件一行都不用改。
//
// ============ 关于「自动绑定」的现实边界（重要） ============
//   Blob：**完全自动**。调用 getStore(name) 时平台会自动为项目创建该命名空间，
//         控制台无需任何操作。这也是默认后端。
//   KV  ：**无法自动置备**。EdgeOne 没有提供 KV 的 SDK 或管理 API
//         （npm 上只有 @edgeone/pages-blob，没有 @edgeone/pages-kv），
//         命名空间只能在「控制台 → 存储 → KV 存储」里创建并绑定到项目。
//         而且官方明确 KV 当前仅支持在 Edge Functions 中使用，Cloud Functions 不可用。
//         → 因此本层能做的「自动」是：**绑定名自动发现**。
//           你在控制台把命名空间绑成什么变量名都行，代码都能自己认出来，
//           不需要设置 EO_KV_BINDING。绑定一次即可，之后零配置。
//
// 后端选择顺序（可用环境变量 STORAGE_BACKEND 强制指定）：
//   blob  → EdgeOne Blob 存储（推荐，语义最接近 R2，且完全自动置备）
//   kv    → EdgeOne KV 存储（备选，仅 Edge Functions 可用）
//   none  → 不挂载，退化为纯内存（Web 端聊天与 PWA 仍可用，Telegram 机器人与知识库失效）
//   auto（默认）→ 先试 Blob，再试 KV，都不可用则退化
//
// 相关环境变量：
//   STORAGE_BACKEND      blob | kv | none | auto（默认 auto）
//   EO_BLOB_NAMESPACE    Blob 命名空间名，默认 cloudflare-chat
//   EO_KV_BINDING        指定 KV 绑定名（一般不需要——不填会自动发现）
//   STORAGE_DEBUG        设为 1 时，/healthz 会额外输出后端探测详情，便于排障

import { makeBlobBackend } from './blob-backend.js';
import { makeKvBackend } from './kv-backend.js';

const DEFAULT_BLOB_NAMESPACE = 'cloudflare-chat';
// 优先按这些常见名字找，命中即返回，避免全量扫描
const DEFAULT_KV_BINDING_NAMES = ['CHAT_KV', 'KV', 'STORAGE', 'EO_KV', 'EDGEONE_KV', 'CLOUDFLARE_CHAT_KV'];
// 全量扫描时要跳过的全局名，避免误触 getter 或匹配到无关对象。
// 特别注意 'R2'：那是本层自己挂上去的 R2 替身，它同样有 get/put/delete/list，
// 若不排除会被当成 KV 再包一层，造成自我套娃。
const SCAN_SKIP = new Set([
  'R2',
  'globalThis', 'global', 'window', 'self', 'process', 'require', 'module', 'exports',
  'console', 'caches', 'navigator', 'performance', 'crypto', 'fetch', 'Request', 'Response',
  'Headers', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'ReadableStream',
  'WritableStream', 'TransformStream', 'Blob', 'File', 'FormData', 'AbortController',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'atob', 'btoa', 'Buffer', 'localStorage', 'sessionStorage',
]);

// isolate 级缓存：同一实例内只解析一次后端，避免每个请求都做一次 SDK 查找。
// 只缓存「成功」的结果；解析失败走一个短负缓存，避免每请求都重试动态引入。
let cachedStore = null;
let cachedBackendName = '';
let lastFailAt = 0;
const FAIL_RETRY_MS = 15000;

// 最近一次探测的详情，供 /healthz 排障
let lastBlobError = '';
let lastKvFound = '';

// 判断一个对象「像不像 KV 命名空间」。
// KV 的签名是 get / put / delete / list；Blob 的 Store 用的是 set（没有 put），
// caches 是 open/match/delete（没有 put）——所以 put 这个特征足以把两者区分开。
function looksLikeKvNamespace(v) {
  return !!v
    && typeof v === 'object'
    && typeof v.get === 'function'
    && typeof v.put === 'function'
    && typeof v.delete === 'function';
}

function collectSources(context, env) {
  const sources = [];
  if (env) sources.push({ label: 'env', obj: env });
  if (context && context.env && context.env !== env) sources.push({ label: 'context.env', obj: context.env });
  if (context) sources.push({ label: 'context', obj: context });
  try { sources.push({ label: 'globalThis', obj: globalThis }); } catch (e) {}
  return sources;
}

// 自动发现 KV 绑定：显式指定 → 常见名字 → 全量扫描（任意变量名都能认出）
function detectKvBinding(context, env) {
  const sources = collectSources(context, env);

  const explicit = env && env.EO_KV_BINDING ? String(env.EO_KV_BINDING) : '';
  if (explicit) {
    for (const s of sources) {
      let v;
      try { v = s.obj[explicit]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) return { kv: v, name: s.label + '.' + explicit };
    }
  }

  for (const n of DEFAULT_KV_BINDING_NAMES) {
    for (const s of sources) {
      let v;
      try { v = s.obj[n]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) return { kv: v, name: s.label + '.' + n };
    }
  }

  for (const s of sources) {
    let keys;
    try { keys = Object.getOwnPropertyNames(s.obj); } catch (e) { continue; }
    for (const k of keys) {
      if (SCAN_SKIP.has(k)) continue;
      let v;
      try { v = s.obj[k]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) return { kv: v, name: s.label + '.' + k };
    }
  }

  return null;
}

// 列出所有「像 KV」的绑定名，仅用于排障输出
function listKvCandidates(context, env) {
  const out = [];
  for (const s of collectSources(context, env)) {
    let keys;
    try { keys = Object.getOwnPropertyNames(s.obj); } catch (e) { continue; }
    for (const k of keys) {
      if (SCAN_SKIP.has(k)) continue;
      let v;
      try { v = s.obj[k]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) out.push(s.label + '.' + k);
    }
  }
  return out;
}

async function tryCreateBlob(env) {
  let mod;
  try {
    // 动态引入：未安装 @edgeone/pages-blob 时不至于让整个函数加载失败
    mod = await import('@edgeone/pages-blob');
  } catch (e) {
    lastBlobError = 'import 失败：' + (e && e.message ? e.message : String(e));
    return null;
  }
  // 该 SDK 是 CommonJS 产物（module.exports = { getStore, ... }），
  // 在 ESM 下既可能被解析成具名导出，也可能只落在 default 上，两种都兼容。
  const getStore = (mod && typeof mod.getStore === 'function')
    ? mod.getStore
    : (mod && mod.default && typeof mod.default.getStore === 'function' ? mod.default.getStore : null);
  if (!getStore) {
    lastBlobError = '模块已加载但未导出 getStore（请确认依赖版本为 @edgeone/pages-blob）';
    return null;
  }
  try {
    const name = String((env && env.EO_BLOB_NAMESPACE) || DEFAULT_BLOB_NAMESPACE);
    // 首次调用时平台会自动为项目创建该命名空间 —— 这是「零控制台操作」的关键
    const store = getStore(name);
    if (!store || typeof store.set !== 'function' || typeof store.list !== 'function') {
      lastBlobError = 'getStore 返回的对象不是预期的 Store';
      return null;
    }
    lastBlobError = '';
    return { store: makeBlobBackend(store), name: 'blob:' + name };
  } catch (e) {
    lastBlobError = 'getStore 调用失败：' + (e && e.message ? e.message : String(e));
    return null;
  }
}

function tryCreateKv(context, env) {
  const found = detectKvBinding(context, env);
  if (!found) return null;
  lastKvFound = found.name;
  return { store: makeKvBackend(found.kv), name: 'kv(' + found.name + ')' };
}

// 解析并返回 R2 兼容存储；不可用时返回 null（调用方会走纯内存降级）
async function resolveStore(context, env) {
  if (cachedStore) return cachedStore;

  const mode = String((env && env.STORAGE_BACKEND) || 'auto').trim().toLowerCase();
  if (mode === 'none') return null;

  // 短负缓存：刚失败过就别每个请求都重试动态引入
  if (lastFailAt && Date.now() - lastFailAt < FAIL_RETRY_MS) return null;

  let picked = null;
  if (mode === 'blob') {
    picked = await tryCreateBlob(env);
  } else if (mode === 'kv') {
    picked = tryCreateKv(context, env);
  } else {
    picked = await tryCreateBlob(env);
    if (!picked) picked = tryCreateKv(context, env);
  }

  if (!picked) {
    lastFailAt = Date.now();
    return null;
  }

  cachedStore = picked.store;
  cachedBackendName = picked.name;
  lastFailAt = 0;
  return cachedStore;
}

// 当前生效的存储后端名（供 /healthz 显示）
function activeBackendName() {
  return cachedBackendName;
}

// 排障详情：仅在 STORAGE_DEBUG=1 时由 /healthz 输出
function storageDiagnostics(context, env) {
  return {
    backend: cachedBackendName || 'memory',
    blobError: lastBlobError || null,
    kvBindingUsed: lastKvFound || null,
    kvCandidates: listKvCandidates(context, env),
    hint: cachedBackendName
      ? ''
      : 'Blob 会自动创建命名空间、无需控制台操作；KV 需在控制台「存储 → KV 存储」创建命名空间并绑定到项目（绑定名任意，代码会自动发现），且 KV 仅 Edge Functions 支持。',
  };
}

// 仅供自检脚本使用：清空 isolate 级缓存与探测记录
function __resetForTest() {
  cachedStore = null;
  cachedBackendName = '';
  lastFailAt = 0;
  lastBlobError = '';
  lastKvFound = '';
}

export {
  resolveStore,
  activeBackendName,
  storageDiagnostics,
  detectKvBinding,
  listKvCandidates,
  looksLikeKvNamespace,
  __resetForTest,
};
