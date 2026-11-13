// 零依赖 HTTP 服务：REST API + 静态页面。
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './store.js';
import { mergePartitions, importAndMerge } from './merge.js';
import { SPEC } from './hll.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);

const store = new EventStore(DATA_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req, limit = 10 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error('请求体超过 10MB 限制'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) return await serveStatic(req, res);

    // ---- 查询类 ----
    if (req.method === 'GET' && p === '/api/spec') {
      return sendJson(res, 200, { spec: SPEC });
    }

    if (req.method === 'GET' && p === '/api/partitions') {
      return sendJson(res, 200, {
        partitions: store.listPartitions(),
        stats: {
          partitionCount: store.partitions.size,
          eventCount: store.globalEventCount,
          droppedEmptyIds: store.droppedEmptyIds,
        },
      });
    }

    if (req.method === 'POST' && p === '/api/merge') {
      const body = await readBody(req);
      const result = mergePartitions(store, body.partitionKeys, {
        includeDetails: !!body.includeDetails,
        detailLimit: Number(body.detailLimit) || 200,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && p === '/api/import-merge') {
      const body = await readBody(req);
      return sendJson(res, 200, importAndMerge(store, body));
    }

    if (req.method === 'POST' && p === '/api/visitors/details') {
      const body = await readBody(req);
      if (!Array.isArray(body.partitionKeys) || body.partitionKeys.length === 0) {
        return sendJson(res, 400, { error: 'partitionKeys 不能为空' });
      }
      return sendJson(res, 200, { visitorDetails: store.visitorDetails(body.partitionKeys) });
    }

    // ---- 写入类 ----
    if (req.method === 'POST' && p === '/api/events') {
      const body = await readBody(req);
      const events = Array.isArray(body.events) ? body.events : [body];
      const results = events.map((ev) => store.addEvent(ev));
      const accepted = results.filter((r) => r.accepted).length;
      return sendJson(res, 200, {
        received: events.length,
        accepted,
        rejected: events.length - accepted,
        results,
      });
    }

    if (req.method === 'POST' && p === '/api/visitors/remove') {
      const body = await readBody(req);
      const out = await store.removeVisitor(body.id, { date: body.date, channel: body.channel });
      return sendJson(res, 200, { ok: true, ...out });
    }

    if (req.method === 'POST' && p === '/api/admin/reset') {
      await store.close();
      await rm(store.eventsDir, { recursive: true, force: true });
      store.partitions.clear();
      store.globalEventCount = 0;
      store.ingestedEventCount = 0;
      store.droppedEmptyIds = 0;
      mkdirSync(store.eventsDir, { recursive: true });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/rebuild') {
      const body = await readBody(req);
      const key = body.partitionKey;
      const part = store.partitions.get(key);
      if (!part) return sendJson(res, 404, { error: `分区不存在: ${key}` });
      await store._rebuildPartition(part);
      return sendJson(res, 200, { ok: true, partition: store.getPartition(key) });
    }

    return sendJson(res, 404, { error: 'unknown api route' });
  } catch (err) {
    const status =
      err.code === 'SPEC_MISMATCH' || err.code === 'ALL_SUMMARIES_REJECTED'
        ? 409
        : err.code === 'NO_PARTITION' || err.code === 'BODY_TOO_LARGE'
          ? 400
          : 500;
    return sendJson(res, status, {
      error: err.message,
      code: err.code || null,
      ...(err.rejected ? { rejected: err.rejected } : {}),
      ...(err.diff ? { diff: err.diff } : {}),
    });
  }
});

await store.load();
server.listen(PORT, () => {
  console.log(`访问统计服务已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`HLL 规范: ${JSON.stringify(SPEC)}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await store.close();
    server.close(() => process.exit(0));
  });
}
