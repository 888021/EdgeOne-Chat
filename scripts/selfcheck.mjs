// 移植自检脚本：不需要 EdgeOne 环境，纯本地验证「模块图能加载 + 存储适配层契约正确 + 路由可用」。
// 运行：node scripts/selfcheck.mjs

import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message ? e.message : String(e)));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message ? e.message : String(e)));
  }
}

// ---------- 内存版 Blob / KV 假实现，用于验证适配层契约 ----------
function fakeBlobStore() {
  const m = new Map();
  return {
    async set(k, v) { m.set(String(k), typeof v === 'string' ? v : String(v)); },
    async get(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    async delete(k) { m.delete(String(k)); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || '';
      const blobs = [...m.keys()].filter(k => k.startsWith(prefix)).map(k => ({ key: k, etag: 'e' + k.length }));
      return { blobs };
    },
  };
}

function fakeKvNamespace() {
  const m = new Map();
  return {
    async put(k, v) { m.set(String(k), String(v)); },
    async get(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    async delete(k) { m.delete(String(k)); },
    async list(opts) {
      opts = opts || {};
      const prefix = opts.prefix || '';
      const limit = opts.limit || 256;
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = opts.cursor ? (parseInt(String(opts.cursor), 10) || 0) : 0;
      const page = all.slice(start, start + limit);
      const next = start + page.length;
      const complete = next >= all.length;
      return { complete, cursor: complete ? null : String(next), keys: page.map(k => ({ key: k })) };
    },
  };
}

// 用同一套 R2 契约用例同时打两个后端
async function runR2Contract(label, store) {
  console.log('\n[' + label + '] R2 契约');

  await checkAsync('put / get 文本往返', async () => {
    await store.put('kb/docs/测试文档.md', '---\ntitle: "测试"\n---\n\n正文内容');
    const obj = await store.get('kb/docs/测试文档.md');
    assert.ok(obj, 'get 应返回对象');
    assert.equal(await obj.text(), '---\ntitle: "测试"\n---\n\n正文内容');
  });

  await checkAsync('get 不存在的 key 返回 null', async () => {
    assert.equal(await store.get('不存在/key.md'), null);
  });

  await checkAsync('get 的 range 选项按 offset/length 切片', async () => {
    await store.put('range.txt', '0123456789ABCDEF');
    const obj = await store.get('range.txt', { range: { offset: 4, length: 6 } });
    assert.equal(await obj.text(), '456789');
  });

  await checkAsync('delete 支持字符串数组（对齐 R2 批量删除）', async () => {
    await store.put('bulk/a', '1');
    await store.put('bulk/b', '2');
    await store.put('bulk/c', '3');
    await store.delete(['bulk/a', 'bulk/b', 'bulk/c']);
    assert.equal(await store.get('bulk/a'), null);
    assert.equal(await store.get('bulk/b'), null);
    assert.equal(await store.get('bulk/c'), null);
  });

  await checkAsync('list 的 prefix / objects[].key / truncated / cursor 语义正确', async () => {
    for (let i = 0; i < 5; i++) await store.put('page/doc' + i + '.md', 'v' + i);
    const first = await store.list({ prefix: 'page/', limit: 2 });
    assert.equal(first.objects.length, 2, 'limit 应生效');
    assert.equal(first.truncated, true, '还有剩余时应 truncated=true');
    assert.ok(first.objects.every(o => o.key.startsWith('page/')), 'prefix 应生效');
    assert.equal(typeof first.cursor, 'string');
    const second = await store.list({ prefix: 'page/', limit: 2, cursor: first.cursor });
    assert.equal(second.objects.length, 2);
    const third = await store.list({ prefix: 'page/', limit: 2, cursor: second.cursor });
    assert.equal(third.objects.length, 1);
    assert.equal(third.truncated, false);
    const seen = new Set([...first.objects, ...second.objects, ...third.objects].map(o => o.key));
    assert.equal(seen.size, 5, '三页合起来应覆盖全部 5 个对象且不重复');
  });

  await checkAsync('list 结果对应用层字段 size / uploaded 不抛错', async () => {
    const r = await store.list({ prefix: 'page/', limit: 1 });
    const o = r.objects[0];
    assert.ok('size' in o && 'uploaded' in o);
    assert.equal(typeof o.size, 'number');
  });
}

async function main() {
  console.log('=== 1. 模块图加载 ===');
  let mod;
  await checkAsync('cloud-functions/_app/entry.js 可被完整加载', async () => {
    mod = await import('../cloud-functions/_app/entry.js');
    assert.equal(typeof mod.handle, 'function');
  });

  let blobBackend;
  let kvBackend;
  await checkAsync('适配层模块可加载', async () => {
    blobBackend = await import('../cloud-functions/_app/store/blob-backend.js');
    kvBackend = await import('../cloud-functions/_app/store/kv-backend.js');
    assert.equal(typeof blobBackend.makeBlobBackend, 'function');
    assert.equal(typeof kvBackend.makeKvBackend, 'function');
  });

  console.log('\n=== 2. 存储适配层 ===');
  await runR2Contract('Blob 后端', blobBackend.makeBlobBackend(fakeBlobStore()));
  await runR2Contract('KV 后端', kvBackend.makeKvBackend(fakeKvNamespace()));

  console.log('\n[KV 后端] 专属行为');
  await checkAsync('key 编码可逆（含中文与斜杠）', () => {
    const raw = 'kb/docs/甲骨文云ARM.md';
    const enc = kvBackend.encKey(raw);
    assert.match(enc, /^[0-9a-f]+$/, '编码后应只含 [0-9a-f]');
    assert.equal(kvBackend.decKey(enc), raw);
  });
  await checkAsync('编码保持前缀性质（list prefix 才可用）', () => {
    const p = kvBackend.encKey('kb/docs/');
    const k = kvBackend.encKey('kb/docs/甲骨文.md');
    assert.ok(k.startsWith(p));
  });
  await checkAsync('超长 key 写入时抛出明确错误（而不是静默写坏数据）', async () => {
    const kv = kvBackend.makeKvBackend(fakeKvNamespace());
    await assert.rejects(() => kv.put('x'.repeat(300), 'v'), /超长/);
  });
  await checkAsync('超长 key 读取时安静返回 null（此类 key 不可能存在）', async () => {
    const kv = kvBackend.makeKvBackend(fakeKvNamespace());
    assert.equal(await kv.get('x'.repeat(300)), null);
  });

  console.log('\n=== 3. 路由与降级（STORAGE_BACKEND=none 走纯内存） ===');
  const baseEnv = { STORAGE_BACKEND: 'none' };
  const call = (path, init) => mod.handle({
    request: new Request('https://example.com' + path, init),
    env: baseEnv,
    waitUntil: () => {},
  });

  await checkAsync('GET /healthz 返回 200 且标明 storage=memory', async () => {
    const res = await call('/healthz');
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.runtime, 'edgeone');
    assert.equal(j.storage, 'memory');
  });

  await checkAsync('GET / 返回聊天页面（未配置模型时给出明确提示）', async () => {
    const res = await call('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /未配置模型/);
  });

  await checkAsync('GET /sw.js 返回 200 且已替换版本占位符', async () => {
    const res = await call('/sw.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Service-Worker-Allowed'), '/');
    const js = await res.text();
    assert.ok(!js.includes('{{PWA_VERSION}}'), '版本占位符应已被替换');
  });

  await checkAsync('GET /manifest.webmanifest 返回 200', async () => {
    const res = await call('/manifest.webmanifest');
    assert.equal(res.status, 200);
  });

  await checkAsync('GET /icon-192.png 返回 PNG', async () => {
    const res = await call('/icon-192.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
  });

  await checkAsync('POST /api/chat 非法 JSON 返回 400', async () => {
    const res = await call('/api/chat', { method: 'POST', body: 'not-json' });
    assert.equal(res.status, 400);
  });

  await checkAsync('POST /api/chat 未配置模型返回 500 且提示检查环境变量', async () => {
    const res = await call('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 500);
    const j = await res.json();
    assert.match(j.error, /未配置任何可用模型/);
  });

  await checkAsync('未知路径返回 404', async () => {
    const res = await call('/definitely-not-a-route');
    assert.equal(res.status, 404);
  });

  console.log('\n=== 4. 环境变量解析（多通道模型列表） ===');
  await checkAsync('API_URL_1/API_KEY_1/MODEL_1 能解析出模型下拉框', async () => {
    const env = {
      STORAGE_BACKEND: 'none',
      API_URL_1: 'https://api.example.com/v1/chat/completions',
      API_KEY_1: 'sk-test',
      MODEL_1: 'gpt-4o:GPT-4o, qwen-plus:通义千问 Plus',
    };
    const res = await mod.handle({ request: new Request('https://example.com/'), env, waitUntil: () => {} });
    const html = await res.text();
    assert.match(html, /gpt-4o/);
    assert.match(html, /通义千问 Plus/);
  });

  console.log('\n=== 5. 端到端：挂上存储后端后，知识库与长期记忆真的落盘并能读回 ===');
  // 这一段验证的是「原项目那 8 个直接调用 env.R2 的文件一行都没改，也能正常工作」
  const r2 = await import('../cloud-functions/_app/store/r2.js');
  const memory = await import('../cloud-functions/_app/agent/memory.js');
  const docTools = await import('../cloud-functions/_app/kb/doc-tools.js');

  for (const [label, makeStore] of [
    ['Blob 后端', () => blobBackend.makeBlobBackend(fakeBlobStore())],
    ['KV 后端', () => kvBackend.makeKvBackend(fakeKvNamespace())],
  ]) {
    const env = { R2: makeStore() };
    const chatId = 'web_e2e_' + (label === 'Blob 后端' ? 'blob' : 'kv');

    await checkAsync('[' + label + '] storePut / storeGet / storeDelete 往返', async () => {
      await r2.storePut(env, 'tg_user_1', 'gpt-4o');
      assert.equal(await r2.storeGet(env, 'tg_user_1'), 'gpt-4o');
      await r2.storeDelete(env, 'tg_user_1');
      assert.equal(await r2.storeGet(env, 'tg_user_1'), null);
    });

    await checkAsync('[' + label + '] 长期记忆写入 → 读回 → md 镜像存在', async () => {
      const msg = await memory.agentSaveMemory(env, chatId, '我养了一只猫叫汤圆');
      assert.match(msg, /已记住/);
      const arr = await memory.agentGetMemories(env, chatId);
      assert.equal(arr.length, 1);
      assert.equal(arr[0].fact, '我养了一只猫叫汤圆');
      const mirror = await r2.storeGet(env, 'kb/mem/' + chatId + '/' + arr[0].file);
      assert.ok(mirror, 'md 镜像应存在');
      assert.match(mirror, /我养了一只猫叫汤圆/);
    });

    await checkAsync('[' + label + '] 同主题改口自动覆盖旧记忆（"X是Y" 句式）', async () => {
      const cid = chatId + '_sub';
      assert.match(await memory.agentSaveMemory(env, cid, '我的手机号是13800000000'), /已记住/);
      assert.match(await memory.agentSaveMemory(env, cid, '我的手机号是13900000000'), /已自动更新记忆/);
      const arr = await memory.agentGetMemories(env, cid);
      assert.equal(arr.length, 1);
      assert.equal(arr[0].fact, '我的手机号是13900000000');
    });

    await checkAsync('[' + label + '] 知识库文档：中文标题保存 → 列表 → 精读 → 删除', async () => {
      const saveMsg = await docTools.toolSaveDoc(env, chatId, {
        title: '甲骨文云 ARM 实例',
        content: '正文：ARM 实例的免费额度与网络说明。'.repeat(20),
      });
      assert.match(saveMsg, /已保存为知识库文档/);

      const listMsg = await docTools.toolListDocs(env);
      assert.match(listMsg, /甲骨文云 ARM 实例/);

      const readMsg = await docTools.toolReadDoc(env, { query: '甲骨文云 ARM 实例' });
      assert.match(readMsg, /ARM 实例的免费额度/);

      const delMsg = await docTools.toolDeleteDoc(env, { query: '甲骨文云 ARM 实例' });
      assert.match(delMsg, /已删除知识库文档/);
      assert.match(await docTools.toolListDocs(env), /知识库文档为空/);
    });

    await checkAsync('[' + label + '] 知识库正文分词检索能命中（多关键词相关性排序）', async () => {
      await docTools.toolSaveDoc(env, chatId, {
        title: '网络配置笔记',
        content: '这一段讲的是边缘节点的回源超时配置与重试策略，和前面的内容无关。',
      });
      const hit = await docTools.toolReadDoc(env, { query: '回源超时' });
      assert.match(hit, /命中/, '标题未命中时应回落到正文检索并给出命中片段');
    });
  }

  console.log('\n=== 6. KV 绑定自动发现（"自动绑定"能自动到哪一步） ===');
  const edgeStore = await import('../cloud-functions/_app/store/edge-store.js');

  await checkAsync('识别规则：KV（有 put）为真，Blob Store（用 set）为假', () => {
    assert.equal(edgeStore.looksLikeKvNamespace(fakeKvNamespace()), true);
    assert.equal(edgeStore.looksLikeKvNamespace(fakeBlobStore()), false);
    assert.equal(edgeStore.looksLikeKvNamespace(null), false);
  });

  await checkAsync('任意变量名绑定的 KV 都能被自动发现（无需 EO_KV_BINDING）', () => {
    globalThis.MY_WEIRD_NAME_KV = fakeKvNamespace();
    try {
      const found = edgeStore.detectKvBinding({}, {});
      assert.ok(found, '应发现 KV 绑定');
      assert.equal(found.name, 'globalThis.MY_WEIRD_NAME_KV');
    } finally {
      delete globalThis.MY_WEIRD_NAME_KV;
    }
  });

  await checkAsync('EO_KV_BINDING 显式指定时优先命中该名字', () => {
    globalThis.KV_ALPHA = fakeKvNamespace();
    globalThis.KV_BETA = fakeKvNamespace();
    try {
      const found = edgeStore.detectKvBinding({}, { EO_KV_BINDING: 'KV_BETA' });
      assert.equal(found.name, 'globalThis.KV_BETA');
    } finally {
      delete globalThis.KV_ALPHA;
      delete globalThis.KV_BETA;
    }
  });

  await checkAsync('常见默认名 CHAT_KV 无需配置即可命中', () => {
    globalThis.CHAT_KV = fakeKvNamespace();
    try {
      const found = edgeStore.detectKvBinding({}, {});
      assert.equal(found.name, 'globalThis.CHAT_KV');
    } finally {
      delete globalThis.CHAT_KV;
    }
  });

  await checkAsync('env.R2（本层挂载的替身）不会被误判成 KV 绑定', () => {
    const env = { R2: blobBackend.makeBlobBackend(fakeBlobStore()) };
    assert.equal(edgeStore.detectKvBinding({}, env), null);
    assert.deepEqual(edgeStore.listKvCandidates({}, env), []);
  });

  await checkAsync('端到端：globalThis 上任意名字的 KV 被自动接管为 env.R2', async () => {
    globalThis.SOME_RANDOM_KV_NAME = fakeKvNamespace();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_BACKEND: 'kv' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'kv(globalThis.SOME_RANDOM_KV_NAME)');
    } finally {
      delete globalThis.SOME_RANDOM_KV_NAME;
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('端到端：auto 模式下没有后端时退化为 memory（不抛错）', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_BACKEND: 'auto' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'memory');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 6b. Blob 默认后端（"使用 Blob 存储"） ===');

  await checkAsync('识别规则：Blob Store（用 set，无 put）为真，KV 为假', () => {
    assert.equal(edgeStore.looksLikeBlobStore(fakeBlobStore()), true);
    assert.equal(edgeStore.looksLikeBlobStore(fakeKvNamespace()), false);
    assert.equal(edgeStore.looksLikeBlobStore(null), false);
    // 本层自己挂载的 env.R2 替身同样带 list/delete，但它有 put，不能被当成 Blob Store
    assert.equal(edgeStore.looksLikeBlobStore(blobBackend.makeBlobBackend(fakeBlobStore())), false);
  });

  await checkAsync('未设置 STORAGE_BACKEND 时默认走 Blob，绝不静默降级到 KV', async () => {
    // 故意在 globalThis 上放一个可用的 KV：旧行为（auto）会用它兜底，
    // 新行为必须无视它 —— Blob 不可用就如实报 memory，而不是偷偷换后端。
    globalThis.CHAT_KV = fakeKvNamespace();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: {},
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'memory', '默认后端是 Blob；Blob 不可用时应暴露为 memory');
    } finally {
      delete globalThis.CHAT_KV;
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('任意变量名绑定的 Blob 都能被自动发现（无需 EO_BLOB_BINDING）', () => {
    globalThis.MY_WEIRD_BLOB = fakeBlobStore();
    try {
      const found = edgeStore.detectBlobBinding({}, {});
      assert.ok(found, '应发现 Blob 绑定');
      assert.equal(found.name, 'globalThis.MY_WEIRD_BLOB');
    } finally {
      delete globalThis.MY_WEIRD_BLOB;
    }
  });

  await checkAsync('EO_BLOB_BINDING 显式指定时优先命中该名字', () => {
    globalThis.BLOB_ALPHA = fakeBlobStore();
    globalThis.BLOB_BETA = fakeBlobStore();
    try {
      const found = edgeStore.detectBlobBinding({}, { EO_BLOB_BINDING: 'BLOB_BETA' });
      assert.equal(found.name, 'globalThis.BLOB_BETA');
    } finally {
      delete globalThis.BLOB_ALPHA;
      delete globalThis.BLOB_BETA;
    }
  });

  await checkAsync('端到端：控制台绑定的 Blob 被接管为 env.R2，且真的能写能读', async () => {
    const bound = fakeBlobStore();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        // ?probe=1 会真实写入并读回一个临时对象 —— 这一步才证明存储「能用」而不只是「能加载」
        request: new Request('https://example.com/healthz?probe=1'),
        env: { BLOB: bound, STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'blob(env.BLOB)', '应优先使用控制台绑定的那个命名空间');
      assert.equal(j.debug.blobBindingUsed, 'env.BLOB');
      assert.equal(j.debug.probe.ok, true, '真实读写应成功');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 7. /healthz 排障输出 ===');
  await checkAsync('STORAGE_DEBUG=1 时输出后端探测详情', async () => {
    const res = await mod.handle({
      request: new Request('https://example.com/healthz'),
      env: { STORAGE_BACKEND: 'none', STORAGE_DEBUG: '1' },
      waitUntil: () => {},
    });
    const j = await res.json();
    assert.ok(j.debug, '应包含 debug 字段');
    assert.equal(j.debug.backend, 'memory');
    assert.ok(Array.isArray(j.debug.kvCandidates));
    assert.ok(j.debug.hint.length > 0, '未接通时应给出提示');
  });

  await checkAsync('默认不输出排障详情（不对外暴露内部绑定名）', async () => {
    const res = await call('/healthz');
    const j = await res.json();
    assert.equal(j.debug, undefined);
  });

  await checkAsync('排障输出回显后端模式与命名空间（默认 blob）', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.mode, 'blob', '未设置 STORAGE_BACKEND 时应回显默认值 blob');
      assert.equal(j.debug.namespace, 'cloudflare-chat');
      assert.equal(j.debug.blobBindingUsed, null);
      assert.ok(Array.isArray(j.debug.blobCandidates));
      assert.equal(j.debug.warning, undefined, '合法取值不应有 warning');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('STORAGE_BACKEND 拼错时按 blob 处理并明确给出 warning', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_BACKEND: 'bolb', STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.mode, 'bolb', '应原样回显，方便发现拼写错误');
      assert.match(j.debug.warning, /无法识别/);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('?probe=1 在存储未接通时明确报 ok:false 并给出原因', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz?probe=1'),
        env: { STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.probe.ok, false);
      assert.match(j.debug.probe.reason, /未接通/);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('不加 ?probe=1 时不会做真实读写（避免每次探针都产生写操作）', async () => {
    const bound = fakeBlobStore();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { BLOB: bound, STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.probe, undefined);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 8. 生图链路（SenseNova 日日新等图像接口） ===');
  const images = await import('../cloud-functions/_app/images.js');
  const channelMod = await import('../cloud-functions/_app/channel.js');
  const IMG_BASE = '/api/img/';

  async function sseTextOf(res) {
    const txt = await res.text();
    const m = txt.match(/^data: (.*)$/m);
    assert.ok(m, 'SSE 里应有 data: 行');
    return JSON.parse(m[1]).choices[0].delta.content;
  }

  await checkAsync('SenseNova 图像地址被判为图像接口，且默认显式要 url', () => {
    const env = {
      API_URL_1: 'https://token.sensenova.cn/v1/images/generations',
      API_KEY_1: 'sk-test',
      MODEL_1: 'sensenova-u1.5-fast:日日新 U1.5 Fast',
    };
    const cfg = channelMod.buildAIRequest(env, 'sensenova-u1.5-fast',
      [{ role: 'user', content: '一只白色海豹宝宝' }], false);
    assert.equal(cfg.isImageAPI, true);
    assert.equal(cfg.payload.response_format, 'url', '必须显式要 url —— 上游默认 b64_json 就是丢图的根因');
    assert.equal(cfg.payload.prompt, '一只白色海豹宝宝');
    assert.equal(cfg.payload.n, 1);
    assert.equal(cfg.payload.size, undefined, '未配置的可选参数不应发送');
    assert.equal(cfg.payload.watermark, undefined);
  });

  await checkAsync('图像接口可选参数按环境变量透传', () => {
    const env = {
      API_URL_1: 'https://token.sensenova.cn/v1/images/generations',
      API_KEY_1: 'sk-test',
      MODEL_1: 'sensenova-u1.5-fast:日日新',
      IMAGE_SIZE: '2048x2048',
      IMAGE_OUTPUT_FORMAT: 'webp',
      IMAGE_WATERMARK: 'false',
      IMAGE_PROMPT_EXTEND: '0',
      IMAGE_RESPONSE_FORMAT: 'b64_json',
    };
    const cfg = channelMod.buildAIRequest(env, 'sensenova-u1.5-fast', [{ role: 'user', content: 'x' }], false);
    assert.equal(cfg.payload.size, '2048x2048');
    assert.equal(cfg.payload.output_format, 'webp');
    assert.equal(cfg.payload.watermark, false);
    assert.equal(cfg.payload.prompt_extend, false);
    assert.equal(cfg.payload.response_format, 'b64_json');
  });

  await checkAsync('普通 chat 通道不会被误判为图像接口', () => {
    const env = {
      API_URL_1: 'https://api.deepseek.com/v1/chat/completions',
      API_KEY_1: 'sk-test',
      MODEL_1: 'deepseek-chat:DeepSeek Chat',
    };
    const cfg = channelMod.buildAIRequest(env, 'deepseek-chat', [{ role: 'user', content: 'hi' }], true);
    assert.equal(cfg.isImageAPI, false);
    assert.equal(cfg.payload.prompt, undefined);
    assert.equal(cfg.payload.response_format, undefined);
  });

  await checkAsync('base64 编解码往返（含非 ASCII 字节）', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255, 89, 137, 80, 78, 71]);
    assert.deepEqual(Array.from(images.base64ToBytes(images.bytesToBase64(bytes))), Array.from(bytes));
    assert.equal(images.bytesToBase64(new Uint8Array([0])), 'AA==');
    assert.equal(images.bytesToBase64(new Uint8Array([255, 255, 255])), '////');
    assert.equal(images.base64ToBytes('').length, 0);
  });

  const imgEnv = { R2: blobBackend.makeBlobBackend(fakeBlobStore()) };

  await checkAsync('base64 图片转存后可读回（字节与 content-type 都正确）', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const path = await images.persistBase64Image(imgEnv, images.bytesToBase64(bytes), 'image/png');
    assert.ok(path && path.indexOf(IMG_BASE) === 0, '应返回 /api/img/<id>');
    const got = await images.loadStoredImage(imgEnv, path.slice(IMG_BASE.length));
    assert.ok(got, '应能读回');
    assert.equal(got.contentType, 'image/png');
    assert.deepEqual(Array.from(got.bytes), Array.from(bytes));
  });

  await checkAsync('未绑定存储时转存返回 null（调用方回退，不抛错）', async () => {
    assert.equal(await images.persistBase64Image({}, 'AAAA', 'image/png'), null);
    assert.equal(await images.persistRemoteImage({}, 'https://cdn.example.com/a.png', 1000), null);
  });

  await checkAsync('图片 id 路径穿越与非法形态被拒绝', async () => {
    assert.equal(await images.loadStoredImage(imgEnv, '../../etc/passwd'), null);
    assert.equal(await images.loadStoredImage(imgEnv, 'a.png'), null);
    assert.equal(await images.loadStoredImage(imgEnv, 'aa-11.png/../../x'), null);
  });

  await checkAsync('上游 URL 图片会被下载转存', async () => {
    const realFetch = globalThis.fetch;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
    globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } });
    try {
      const path = await images.persistRemoteImage(imgEnv, 'https://cdn.example.com/a.png', 5000);
      assert.ok(path && path.indexOf(IMG_BASE) === 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('非图片内容类型拒收（避免把错误页当图片存下来）', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>err</html>', { headers: { 'content-type': 'text/html' } });
    try {
      assert.equal(await images.persistRemoteImage(imgEnv, 'https://cdn.example.com/err.html', 5000), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('内网 / 云元数据图片地址被 SSRF 拦截且不发起请求', async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('x'); };
    try {
      assert.equal(await images.persistRemoteImage(imgEnv, 'http://127.0.0.1/a.png', 5000), null);
      assert.equal(await images.persistRemoteImage(imgEnv, 'http://169.254.169.254/latest/meta-data/', 5000), null);
      assert.equal(await images.persistRemoteImage(imgEnv, 'file:///etc/passwd', 5000), null);
      assert.equal(called, false, '被拦截的地址不应真的发起请求');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('b64_json 响应能解析成图片（原实现正是在这里丢图）', async () => {
    const b64 = images.bytesToBase64(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]));
    const upstream = new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }),
      { headers: { 'content-type': 'application/json' } });
    const content = await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream));
    assert.match(content, /!\[生成结果\]\(\/api\/img\//, '应转存并给出 /api/img 链接');
  });

  await checkAsync('url 响应会被下载转存成自有长期链接', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71, 5, 6]),
      { headers: { 'content-type': 'image/png' } });
    try {
      const upstream = new Response(JSON.stringify({ data: [{ url: 'https://cdn.sensenova.dev/gen/x.png' }] }),
        { headers: { 'content-type': 'application/json' } });
      const content = await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream));
      assert.match(content, /\(\/api\/img\//);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('IMAGE_PERSIST=0 时保留上游链接并明确提示 24 小时失效', async () => {
    const env = { R2: imgEnv.R2, IMAGE_PERSIST: '0' };
    const upstream = new Response(JSON.stringify({ data: [{ url: 'https://cdn.sensenova.dev/gen/y.png' }] }),
      { headers: { 'content-type': 'application/json' } });
    const content = await sseTextOf(await images.buildImageSseResponse(env, upstream));
    assert.match(content, /https:\/\/cdn\.sensenova\.dev\/gen\/y\.png/);
    assert.match(content, /24 小时/);
  });

  await checkAsync('多张图片逐个转存并带序号', async () => {
    const b64a = images.bytesToBase64(new Uint8Array([1, 2, 3]));
    const b64b = images.bytesToBase64(new Uint8Array([4, 5, 6]));
    const upstream = new Response(JSON.stringify({ data: [{ b64_json: b64a }, { b64_json: b64b }] }),
      { headers: { 'content-type': 'application/json' } });
    const content = await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream));
    assert.match(content, /生成结果 1/);
    assert.match(content, /生成结果 2/);
  });

  await checkAsync('图像接口报错时把上游原因透传给用户', async () => {
    const upstream = new Response(JSON.stringify({ error: { message: 'quota exceeded' } }),
      { headers: { 'content-type': 'application/json' } });
    assert.match(await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream)), /quota exceeded/);
  });

  await checkAsync('返回里既无 url 也无 b64_json 时给出原始响应片段', async () => {
    const upstream = new Response(JSON.stringify({ data: [{ revised_prompt: 'x' }] }),
      { headers: { 'content-type': 'application/json' } });
    assert.match(await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream)), /未返回任何图片/);
  });

  await checkAsync('上游返回非 JSON 时给出可读错误而不是崩掉', async () => {
    const upstream = new Response('<html>502 Bad Gateway</html>', { headers: { 'content-type': 'text/html' } });
    assert.match(await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream)), /不是合法 JSON/);
  });

  await checkAsync('端到端：GET /api/img/<id> 经完整路由取回图片字节', async () => {
    globalThis.E2E_IMG_KV = fakeKvNamespace();
    edgeStore.__resetForTest();
    try {
      const backend = kvBackend.makeKvBackend(globalThis.E2E_IMG_KV);
      const bytes = new Uint8Array([137, 80, 78, 71, 99, 100, 101]);
      const path = await images.persistBase64Image({ R2: backend }, images.bytesToBase64(bytes), 'image/png');
      assert.ok(path, '应先转存成功');
      const res = await mod.handle({
        request: new Request('https://example.com' + path),
        env: { STORAGE_BACKEND: 'kv' },
        waitUntil: () => {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'image/png');
      assert.match(res.headers.get('Cache-Control'), /immutable/);
      assert.deepEqual(Array.from(new Uint8Array(await res.arrayBuffer())), Array.from(bytes));
    } finally {
      delete globalThis.E2E_IMG_KV;
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('GET /api/img/<不存在的 id> 返回 404', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/api/img/abcdefgh-12345678.png'),
        env: { STORAGE_BACKEND: 'none' },
        waitUntil: () => {},
      });
      assert.equal(res.status, 404);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 9. 生成页面本身的合法性 ===');
  // ui/*.js 导出的都是模板字符串，改动很容易因为两层转义把页面脚本写坏，
  // 而那种错误在服务端完全看不出来（只有浏览器打开才炸）。这里把内联脚本抽出来单独 parse。
  const uiMod = await import('../cloud-functions/_app/ui/index.js');
  const pageHtml = uiMod.HTML_CONTENT;

  await checkAsync('页面 HTML 能生成且包含模型下拉框占位符', () => {
    assert.ok(pageHtml.length > 50000, 'HTML 长度异常');
    assert.match(pageHtml, /\{\{MODEL_OPTIONS\}\}/);
  });

  await checkAsync('页面内联脚本块全部语法合法（两层转义没写坏）', () => {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    let n = 0;
    while ((m = re.exec(pageHtml)) !== null) {
      const code = m[1];
      if (!code.trim()) continue;
      n++;
      // new Function 只做解析不执行，足以抓出语法/转义错误
      // eslint-disable-next-line no-new-func
      new Function(code);
    }
    assert.ok(n > 0, '应至少有一个内联脚本块');
  });

  await checkAsync('生图相关的前端改动都已生效', () => {
    assert.match(pageHtml, /renderer\.image\s*=\s*function/, '缺少图片渲染器');
    assert.match(pageHtml, /\.md-img-link/, '缺少图片链接样式');
    assert.match(pageHtml, /内联图片过大，已省略/, '缺少 localStorage 配额兜底');
  });

  console.log('\n=== 结果 ===');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) process.exit(1);
}

main().catch(e => {
  console.error('自检脚本自身异常：', e);
  process.exit(1);
});
