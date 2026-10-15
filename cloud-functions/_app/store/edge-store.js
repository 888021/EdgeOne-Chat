// 存储适配层入口：为 EdgeOne 环境构造一个「长得像 R2」的对象，挂到 env.R2 上。
//
// 设计原则：让上层业务代码零改动。
//   原项目里 store/r2.js、store/kb.js、kb/registry.js、kb/doc-tools.js、agent/memory.js、
//   agent/resume.js、agent/mode.js、telegram/handler.js 全部直接调用 env.R2.get/put/delete/list，
//   所以这里只要提供一个接口一致的替身，那 8 个文件一行都不用改。
//
// 后端选择顺序（可用环境变量 STORAGE_BACKEND 强制指定）：
//   blob  → EdgeOne Blob 存储（@edgeone/pages-blob，推荐，语义最接近 R2）
//   kv    → EdgeOne KV 存储（备选，仅 Edge Functions 可用，key 有字符集限制）
//   none  → 不挂载，退化为纯内存（Web 端聊天与 PWA 仍可用，Telegram 机器人与知识库失效）
//   auto（默认）→ 先试 Blob，再试 KV，都不可用则退化
//
// 相关环境变量：
//   STORAGE_BACKEND      blob | kv | none | auto（默认 auto）
//   EO_BLOB_NAMESPACE    Blob 命名空间名，默认 cloudflare-chat
//   EO_KV_BINDING        KV 绑定时的运行时变量名（默认依次尝试 CHAT_KV / KV / STORAGE）

import { makeBlobBackend } from './blob-backend.js';
import { makeKvBackend } from './kv-backend.js';

const DEFAULT_BLOB_NAMESPACE = 'cloudflare-chat';
const DEFAULT_KV_BINDING_NAMES = ['CHAT_KV', 'KV', 'STORAGE'];

// isolate 级缓存：同一实例内只解析一次后端，避免每个请求都做一次 SDK 查找。
// 只缓存「成功」的结果；解析失败不缓存，便于配置修正后立即生效。
let cachedStore = null;
let cachedBackendName = '';

function pickKvBinding(env) {
  const names = [];
  if (env && env.EO_KV_BINDING) names.push(String(env.EO_KV_BINDING));
  for (const n of DEFAULT_KV_BINDING_NAMES) names.push(n);
  for (const n of names) {
    if (!n) continue;
    if (env && env[n] && typeof env[n].get === 'function' && typeof env[n].put === 'function') return env[n];
    try {
      const g = globalThis[n];
      if (g && typeof g.get === 'function' && typeof g.put === 'function') return g;
    } catch (e) {}
  }
  return null;
}

async function tryCreateBlob(env) {
  let mod;
  try {
    // 动态引入：未安装 @edgeone/pages-blob 时不至于让整个函数加载失败
    mod = await import('@edgeone/pages-blob');
  } catch (e) {
    return null;
  }
  // 该 SDK 是 CommonJS 产物（module.exports = { getStore, ... }），
  // 在 ESM 下既可能被解析成具名导出，也可能只落在 default 上，两种都兼容。
  const getStore = (mod && typeof mod.getStore === 'function')
    ? mod.getStore
    : (mod && mod.default && typeof mod.default.getStore === 'function' ? mod.default.getStore : null);
  if (!getStore) return null;
  try {
    const name = String((env && env.EO_BLOB_NAMESPACE) || DEFAULT_BLOB_NAMESPACE);
    const store = getStore(name);
    if (!store || typeof store.set !== 'function' || typeof store.list !== 'function') return null;
    return { store: makeBlobBackend(store), name: 'blob:' + name };
  } catch (e) {
    return null;
  }
}

function tryCreateKv(env) {
  const kv = pickKvBinding(env);
  if (!kv) return null;
  return { store: makeKvBackend(kv), name: 'kv' };
}

// 解析并返回 R2 兼容存储；不可用时返回 null（调用方会走纯内存降级）
async function resolveStore(env) {
  if (cachedStore) return cachedStore;

  const mode = String((env && env.STORAGE_BACKEND) || 'auto').trim().toLowerCase();

  if (mode === 'none') return null;

  let picked = null;
  if (mode === 'blob') {
    picked = await tryCreateBlob(env);
  } else if (mode === 'kv') {
    picked = tryCreateKv(env);
  } else {
    picked = await tryCreateBlob(env);
    if (!picked) picked = tryCreateKv(env);
  }

  if (!picked) return null;

  cachedStore = picked.store;
  cachedBackendName = picked.name;
  return cachedStore;
}

// 当前生效的存储后端名（供 /healthz 与前端排障显示）
function activeBackendName() {
  return cachedBackendName;
}

export { resolveStore, activeBackendName };
