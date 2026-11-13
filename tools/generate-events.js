#!/usr/bin/env node
// 本地事件生成器（零依赖）。
//
// 生成若干 (date, channel) 分区的访客事件，访客重叠比例可调：
//   --overlap 0   每个分区的访客完全独立（并集人数 = 各分区人数之和）
//   --overlap 0.5 每个分区约 50% 的访客来自共享访客池（跨分区重复出现）
//   --overlap 1   所有分区使用同一批访客（并集人数 = 单分区人数）
//
// 用法示例：
//   node tools/generate-events.js --dates 2026-11-10,2026-11-11,2026-11-12 \
//     --channels web,app --visitors 300 --overlap 0.6 --post
//
// 默认把事件打印为 JSON 到 stdout；加 --post 则 POST 到本地服务。

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  return args[i + 1];
}
function flag(name) {
  return args.includes(`--${name}`);
}

// 确定性 PRNG（mulberry32），默认种子保证可复现
const seed = Number(opt('seed', 20261113)) >>> 0;
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const dates = (opt('dates', '2026-11-10,2026-11-11,2026-11-12') || '').split(',').filter(Boolean);
const channels = (opt('channels', 'web,app') || '').split(',').filter(Boolean);
const visitorsPerPartition = Number(opt('visitors', 300));
const overlap = Math.min(1, Math.max(0, Number(opt('overlap', 0.5))));
const repeatRate = Math.min(1, Math.max(0, Number(opt('repeat-rate', 0.2)))); // 同分区内重复事件比例
const emptyIdRate = Math.min(1, Math.max(0, Number(opt('empty-id-rate', 0)))); // 注入空标识的比例
const baseUrl = opt('base-url', 'http://localhost:3000');
const poolSize = Number(opt('pool-size', Math.round(visitorsPerPartition * 1.5)));
const outFile = opt('out', '');

// 共享访客池：标识统一为字符串，保留前导零，绝不转数字
const sharedPool = Array.from({ length: poolSize }, (_, i) => `user_${String(i).padStart(6, '0')}`);

let seq = poolSize;
const freshId = () => `user_${String(seq++).padStart(6, '0')}`;

const events = [];
const plan = [];
for (const date of dates) {
  for (const channel of channels) {
    const nShared = Math.round(visitorsPerPartition * overlap);
    const nFresh = visitorsPerPartition - nShared;

    // 从共享池无放回抽样
    const poolCopy = [...sharedPool];
    const chosen = new Set();
    while (chosen.size < Math.min(nShared, poolCopy.length)) chosen.add(pick(poolCopy));
    const ids = [...chosen];
    for (let i = 0; i < nFresh; i++) ids.push(freshId());

    let localEvents = 0;
    let emptyInjected = 0;
    for (const id of ids) {
      events.push({ id, date, channel });
      localEvents++;
      // 同一访客在本分区重复出现（重复事件，去重后仍是 1 人）
      while (rand() < repeatRate) {
        events.push({ id, date, channel });
        localEvents++;
      }
      // 注入空标识事件，服务端应丢弃且不计入访客
      if (rand() < emptyIdRate) {
        events.push({ id: '', date, channel });
        localEvents++;
        emptyInjected++;
      }
    }
    plan.push({ date, channel, distinctVisitors: ids.length, events: localEvents, emptyInjected });
  }
}

// 可选：生成迟到事件（昨天的访客今天才上报），验证迟到更新
if (flag('late')) {
  const lateDate = dates[0];
  const lateChannel = channels[0];
  const lateId = sharedPool[0];
  events.push({ id: lateId, date: lateDate, channel: lateChannel, late: true });
  plan.push({ date: lateDate, channel: lateChannel, lateEvent: lateId });
}

const payload = { generatedAt: new Date().toISOString(), params: {
  dates, channels, visitorsPerPartition, overlap, repeatRate, emptyIdRate, seed,
}, plan, events };

if (flag('post')) {
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  const json = await res.json();
  console.log(`POST ${baseUrl}/api/events -> ${res.status}`);
  console.log(JSON.stringify({ plan: payload.plan, serverResponse: json }, null, 2));
  if (!res.ok) process.exit(1);
} else if (outFile) {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(payload, null, 2));
  console.log(`已写入 ${outFile}，共 ${events.length} 个事件`);
  console.log(JSON.stringify(plan, null, 2));
} else {
  process.stdout.write(JSON.stringify(payload, null, 2));
}
