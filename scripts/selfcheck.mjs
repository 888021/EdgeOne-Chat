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

  console.log('\n=== 结果 ===');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) process.exit(1);
}

main().catch(e => {
  console.error('自检脚本自身异常：', e);
  process.exit(1);
});
