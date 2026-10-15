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
//         另外，若你在控制台把 Blob 命名空间绑定成了某个变量（任意名字），
//         本层也能自动识别并优先使用它，避免「控制台绑一个、数据写进另一个」。
//   KV  ：**无法自动置备**。EdgeOne 没有提供 KV 的 SDK 或管理 API
//         （npm 上只有 @edgeone/pages-blob，没有 @edgeone/pages-kv），
//         命名空间只能在「控制台 → 存储 → KV 存储」里创建并绑定到项目。
//         而且官方明确 KV 当前仅支持在 Edge Functions 中使用，Cloud Functions 不可用。
//         → 因此本层能做的「自动」是：**绑定名自动发现**。
//           你在控制台把命名空间绑成什么变量名都行，代码都能自己认出来，
//           不需要设置 EO_KV_BINDING。绑定一次即可，之后零配置。
//
// 后端选择（可用环境变量 STORAGE_BACKEND 覆盖）：
//   blob（默认）→ EdgeOne Blob 存储（@edgeone/pages-blob）。语义最接近 R2、key 无字符集限制、
//                 支持强一致读、命名空间自动创建 —— 本项目唯一推荐的后端。
//                 故意不自动回退到 KV：KV 的语义差异（最终一致、key 长度限制）是隐性的，
//                 静默降级会让问题更难排查。Blob 不可用时直接暴露出来，/healthz 会说明原因。
//   kv          → EdgeOne KV 存储（备选，仅 Edge Functions 可用）。需要显式指定。
//   auto        → 先试 Blob，失败再退 KV（旧行为，保留给确实需要 KV 兜底的场景）
//   none        → 不挂载，退化为纯内存（Web 端聊天与 PWA 仍可用，Telegram 机器人与知识库失效）
//
// 相关环境变量：
//   STORAGE_BACKEND      blob（默认）| kv | auto | none
//   EO_BLOB_NAMESPACE    Blob 命名空间名，默认 cloudflare-chat
//   EO_BLOB_BINDING      指定 Blob 绑定名（一般不需要——不填会自动发现）
//   EO_KV_BINDING        指定 KV 绑定名（一般不需要——不填会自动发现）
//   STORAGE_DEBUG        设为 1 时，/healthz 会额外输出后端探测详情；再加 ?probe=1 会真实读写一次

import { makeBlobBackend } from './blob-backend.js';
import { makeKvBackend } from './kv-backend.js';

const DEFAULT_BLOB_NAMESPACE = 'cloudflare-chat';
// 优先按这些常见名字找，命中即返回，避免全量扫描
const DEFAULT_KV_BINDING_NAMES = ['CHAT_KV', 'KV', 'STORAGE', 'EO_KV', 'EDGEONE_KV', 'CLOUDFLARE_CHAT_KV'];
const DEFAULT_BLOB_BINDING_NAMES = ['BLOB', 'CHAT_BLOB', 'STORAGE_BLOB', 'EO_BLOB', 'EDGEONE_BLOB', 'CLOUDFLARE_CHAT_BLOB'];
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
let lastBlobFound = '';
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

// 判断一个对象「像不像 Blob Store」。
// Blob 的签名是 set / get / delete / list，且**没有 put**（put 是 KV 的特征键）。
// 多要求 get 与 delete，是为了避免把某个恰好带 set+list 的无关对象当成存储。
function looksLikeBlobStore(v) {
  return !!v
    && typeof v === 'object'
    && typeof v.set === 'function'
    && typeof v.get === 'function'
    && typeof v.delete === 'function'
    && typeof v.list === 'function'
    && typeof v.put !== 'function';
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

// 自动发现 Blob 绑定：与 KV 同一套策略，让你在控制台把 Blob 命名空间绑成任意变量名都能被接管。
// 注意这只是「锦上添花」——不绑任何变量时，SDK 的 getStore(name) 也能自动创建并使用命名空间。
function detectBlobBinding(context, env) {
  const sources = collectSources(context, env);

  const explicit = env && env.EO_BLOB_BINDING ? String(env.EO_BLOB_BINDING) : '';
  if (explicit) {
    for (const s of sources) {
      let v;
      try { v = s.obj[explicit]; } catch (e) { continue; }
      if (looksLikeBlobStore(v)) return { store: v, name: s.label + '.' + explicit };
    }
  }

  for (const n of DEFAULT_BLOB_BINDING_NAMES) {
    for (const s of sources) {
      let v;
      try { v = s.obj[n]; } catch (e) { continue; }
      if (looksLikeBlobStore(v)) return { store: v, name: s.label + '.' + n };
    }
  }

  for (const s of sources) {
    let keys;
    try { keys = Object.getOwnPropertyNames(s.obj); } catch (e) { continue; }
    for (const k of keys) {
      if (SCAN_SKIP.has(k)) continue;
      let v;
      try { v = s.obj[k]; } catch (e) { continue; }
      if (looksLikeBlobStore(v)) return { store: v, name: s.label + '.' + k };
    }
  }

  return null;
}

async function tryCreateBlob(env, context) {
  // 先看有没有在控制台绑定的 Blob 命名空间。绑定了就优先用它——
  // 否则会退到 SDK 默认命名空间，导致「控制台绑了一个、数据写到另一个」的割裂。
  const bound = detectBlobBinding(context, env);
  if (bound) {
    lastBlobError = '';
    lastBlobFound = bound.name;
    return { store: makeBlobBackend(bound.store), name: 'blob(' + bound.name + ')' };
  }
  lastBlobFound = '';

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

  const rawMode = String((env && env.STORAGE_BACKEND) || 'blob').trim().toLowerCase();
  const mode = rawMode || 'blob';
  if (mode === 'none') return null;

  // 短负缓存：刚失败过就别每个请求都重试动态引入
  if (lastFailAt && Date.now() - lastFailAt < FAIL_RETRY_MS) return null;

  let picked = null;
  if (mode === 'kv') {
    picked = tryCreateKv(context, env);
  } else if (mode === 'auto') {
    picked = await tryCreateBlob(env, context);
    if (!picked) picked = tryCreateKv(context, env);
  } else {
    // blob，以及任何拼错的取值 —— 都按 Blob 处理。
    // 拼错环境变量时静默退化成内存太难排查，这里宁可继续走默认后端，
    // 同时在 /healthz 的排障输出里把原始取值回显出来。
    picked = await tryCreateBlob(env, context);
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
  const mode = String((env && env.STORAGE_BACKEND) || 'blob').trim().toLowerCase() || 'blob';
  const known = mode === 'blob' || mode === 'kv' || mode === 'auto' || mode === 'none';
  return {
    backend: cachedBackendName || 'memory',
    mode: mode,
    namespace: String((env && env.EO_BLOB_NAMESPACE) || DEFAULT_BLOB_NAMESPACE),
    blobError: lastBlobError || null,
    blobBindingUsed: lastBlobFound || null,
    kvBindingUsed: lastKvFound || null,
    blobCandidates: listBlobCandidates(context, env),
    kvCandidates: listKvCandidates(context, env),
    ...(known ? {} : { warning: 'STORAGE_BACKEND 取值无法识别（' + mode + '），已按默认后端 blob 处理' }),
    hint: cachedBackendName
      ? ''
      : 'Blob 会自动创建命名空间、无需控制台操作。若 blobError 提示找不到 @edgeone/pages-blob，'
        + '说明依赖没装上（安装命令需为 npm install）；跑在 Edge Functions 上的话 Blob 的 Node.js SDK 不可用，'
        + '需改用 STORAGE_BACKEND=kv 并在控制台绑定 KV 命名空间。',
  };
}

// 列出所有「像 Blob Store」的绑定名，仅用于排障输出
function listBlobCandidates(context, env) {
  const out = [];
  for (const s of collectSources(context, env)) {
    let keys;
    try { keys = Object.getOwnPropertyNames(s.obj); } catch (e) { continue; }
    for (const k of keys) {
      if (SCAN_SKIP.has(k)) continue;
      let v;
      try { v = s.obj[k]; } catch (e) { continue; }
      if (looksLikeBlobStore(v)) out.push(s.label + '.' + k);
    }
  }
  return out;
}

// 真实读写一次，确认存储不只是「SDK 加载成功」而是「真的能写能读」。
// getStore() 返回对象不代表有权限、有配额，只有写进去再读回来才算数。
async function probeStore() {
  if (!cachedStore) {
    return { ok: false, backend: 'memory', reason: '未接通存储（见 debug.blobError / debug.hint）' };
  }
  if (typeof cachedStore.__probe !== 'function') {
    return { ok: false, backend: cachedBackendName, reason: '该后端不支持自检' };
  }
  try {
    const ok = await cachedStore.__probe();
    return { ok: !!ok, backend: cachedBackendName };
  } catch (e) {
    return { ok: false, backend: cachedBackendName, reason: e && e.message ? e.message : String(e) };
  }
}

// 仅供自检脚本使用：清空 isolate 级缓存与探测记录
function __resetForTest() {
  cachedStore = null;
  cachedBackendName = '';
  lastFailAt = 0;
  lastBlobError = '';
  lastBlobFound = '';
  lastKvFound = '';
}

export {
  resolveStore,
  activeBackendName,
  storageDiagnostics,
  probeStore,
  detectKvBinding,
  detectBlobBinding,
  listKvCandidates,
  listBlobCandidates,
  looksLikeKvNamespace,
  looksLikeBlobStore,
  __resetForTest,
};
