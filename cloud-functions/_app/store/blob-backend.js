// R2 兼容后端 A：EdgeOne Blob 存储（@edgeone/pages-blob，Cloud Functions / Node.js 运行时）
//
// 为什么用 Blob 而不是 KV：
//   1) Blob 的 key 支持 "/" 与中文，本项目的 key 形如 kb/docs/甲骨文ARM.md、kb/mem/web_xxx/1a2b.md，
//      在 KV 上（key 仅允许数字/字母/下划线）会直接非法；
//   2) Blob 支持 prefix 列举与强一致读（consistency: "strong"），与 R2 语义最接近；
//   3) Blob 无 512B key 长度焦虑。
//
// 与 R2 的差异及弥补方式：
//   - store.delete 只接受单个 key → 本适配层对数组做循环删除（与 R2 的批量删除行为对齐）
//   - store.list 不返回 size / uploaded → 返回 size:0、uploaded:undefined。
//     影响面仅限「控制台展示体积」一处：kb/registry.js 里 size 走 `o.size || 0`，
//     updated_at 优先取 frontmatter 的 saved_at，因此文档日期仍然正确。
//   - store.get 不支持 range → 读全量后按 offset/length 切片（本项目仅用于读 frontmatter 前 4096 字节）
//   - store.list 默认自动聚合全部分页 → 本适配层用「聚合后内存切片」模拟 R2 的 cursor/truncated 语义

const LIST_FETCH_CAP = 5000; // 单次 list 聚合的对象上限，防极端情况拖垮函数

function makeBlobBackend(store) {
  // 统一把 value 归一化成字符串：本项目所有持久化数据都是 JSON 或 Markdown 文本
  function toText(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
    return String(value);
  }

  return {
    __backend: 'blob',

    // get(key) | get(key, { range: { offset, length } })
    // 返回 R2Object 的等价物：{ text(), json(), arrayBuffer(), size }
    async get(key, opts) {
      let text;
      try {
        text = await store.get(String(key));
      } catch (e) {
        return null;
      }
      if (text === null || text === undefined) return null;
      const full = toText(text);
      const range = opts && opts.range;
      const sliced = (range && typeof range.offset === 'number')
        ? full.slice(range.offset, range.offset + (typeof range.length === 'number' ? range.length : undefined))
        : full;
      return {
        size: full.length,
        async text() { return sliced; },
        async json() { return JSON.parse(sliced); },
        async arrayBuffer() { return new TextEncoder().encode(sliced).buffer; },
      };
    },

    async put(key, value) {
      await store.set(String(key), toText(value));
    },

    // delete(key) | delete([key, key, ...]) —— 对齐 R2 的批量删除
    async delete(key) {
      if (Array.isArray(key)) {
        for (const k of key) {
          try { await store.delete(String(k)); } catch (e) {}
        }
        return;
      }
      await store.delete(String(key));
    },

    // list({ prefix, limit, cursor }) → { objects: [{ key, size, uploaded }], truncated, cursor }
    async list(opts) {
      opts = opts || {};
      const prefix = opts.prefix ? String(opts.prefix) : '';
      const limit = (typeof opts.limit === 'number' && opts.limit > 0) ? opts.limit : 1000;
      const start = opts.cursor ? (parseInt(String(opts.cursor), 10) || 0) : 0;

      let blobs = [];
      try {
        // 强一致：避免刚写入的知识库文档在列不出来（Blob 默认最终一致，边缘缓存有秒级延迟）
        const r = await store.list({ prefix, consistency: 'strong' });
        blobs = (r && Array.isArray(r.blobs)) ? r.blobs : [];
      } catch (e) {
        blobs = [];
      }

      if (blobs.length > LIST_FETCH_CAP) blobs = blobs.slice(0, LIST_FETCH_CAP);
      // Blob 返回顺序不保证稳定，按 key 字典序排序，保证 cursor 切片在多次调用间一致
      blobs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

      const page = blobs.slice(start, start + limit);
      const next = start + page.length;
      const truncated = next < blobs.length;

      return {
        objects: page.map(b => ({ key: b.key, size: 0, uploaded: undefined, etag: b.etag })),
        truncated,
        cursor: truncated ? String(next) : undefined,
      };
    },

    // 非 R2 标准接口，仅用于健康检查/自检
    async __probe() {
      const k = '__probe__/' + Date.now().toString(36);
      await store.set(k, 'ok');
      const v = await store.get(k);
      await store.delete(k);
      return v === 'ok';
    },
  };
}

export { makeBlobBackend };
