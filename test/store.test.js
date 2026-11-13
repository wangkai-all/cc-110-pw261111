import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, partitionKey } from '../src/store.js';
import { mergePartitions, importAndMerge } from '../src/merge.js';
import { HyperLogLog, SPEC } from '../src/hll.js';

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hll-store-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('事件入库：精确去重、重复事件、空标识丢弃', async () => {
  const store = new EventStore(join(dir, 's1'));
  const r1 = store.addEvent({ id: 'u1', date: '2026-11-10', channel: 'web' });
  assert.equal(r1.isNewVisitor, true);
  const r2 = store.addEvent({ id: 'u1', date: '2026-11-10', channel: 'web' });
  assert.equal(r2.isNewVisitor, false);
  const r3 = store.addEvent({ id: '', date: '2026-11-10', channel: 'web' });
  assert.equal(r3.accepted, false);
  await store.close();

  const view = store.getPartition(partitionKey('2026-11-10', 'web'));
  assert.equal(view.exactCount, 1);
  assert.equal(view.eventCount, 2);
  assert.equal(store.droppedEmptyIds, 1);
});

test('跨日期/渠道合并：并集去重而非每日人数相加', async () => {
  const store = new EventStore(join(dir, 's2'));
  // u1,u2 在 10 号 web；u2,u3 在 10 号 app；u3,u4 在 11 号 web
  const evs = [
    ['u1', '2026-11-10', 'web'], ['u2', '2026-11-10', 'web'],
    ['u2', '2026-11-10', 'app'], ['u3', '2026-11-10', 'app'],
    ['u3', '2026-11-11', 'web'], ['u4', '2026-11-11', 'web'],
  ];
  for (const [id, date, channel] of evs) store.addEvent({ id, date, channel });
  await store.close();

  const keys = store.listPartitions().map((p) => p.key);
  const r = mergePartitions(store, keys, { detailLimit: 100 });
  assert.equal(r.exactDistinct, 4); // u1..u4
  assert.equal(r.naiveSumOfPartitionCounts, 6); // 朴素相加是错的
  assert.equal(r.overlapCount, 2);
  assert.ok(Math.abs(r.hll.estimate - 4) / 4 < 0.2);
  assert.equal(r.visitorDetails.length, 4);
  const u3 = r.visitorDetails.find((v) => v.id === 'u3');
  assert.equal(u3.inPartitions.length, 2); // 同一访客跨两个分区
});

test('迟到事件可以更新已有分区摘要', async () => {
  const store = new EventStore(join(dir, 's3'));
  store.addEvent({ id: 'u1', date: '2026-11-10', channel: 'web' });
  const before = store.getPartition(partitionKey('2026-11-10', 'web')).exactCount;
  // 迟到一天上报的事件，落到原分区
  store.addEvent({ id: 'u9', date: '2026-11-10', channel: 'web' });
  await store.close();
  const after = store.getPartition(partitionKey('2026-11-10', 'web')).exactCount;
  assert.equal(before, 1);
  assert.equal(after, 2);
});

test('删除访客：从原始事件重建分区，而不是 HLL 减法', async () => {
  const store = new EventStore(join(dir, 's4'));
  for (const id of ['u1', 'u2', 'u3']) {
    store.addEvent({ id, date: '2026-11-10', channel: 'web' });
    store.addEvent({ id, date: '2026-11-10', channel: 'web' }); // 重复事件
  }
  const out = await store.removeVisitor('u2', { date: '2026-11-10', channel: 'web' });
  assert.deepEqual(out.rebuiltPartitions, [partitionKey('2026-11-10', 'web')]);
  const view = store.getPartition(partitionKey('2026-11-10', 'web'));
  assert.equal(view.exactCount, 2);
  assert.equal(view.eventCount, 4); // u1/u3 各两条
  // 原始事件文件中确实不再包含 u2
  const raw = await readFile(join(store.eventsDir, `${partitionKey('2026-11-10', 'web')}.jsonl`), 'utf8');
  assert.ok(!raw.includes('"u2"'));
  await store.close();
});

test('重启后从原始事件恢复分区状态', async () => {
  const path = join(dir, 's5');
  const s1 = new EventStore(path);
  s1.addEvent({ id: 'u1', date: '2026-11-10', channel: 'web' });
  s1.addEvent({ id: 'u2', date: '2026-11-10', channel: 'web' });
  await s1.close();

  const s2 = new EventStore(path);
  await s2.load();
  const view = s2.getPartition(partitionKey('2026-11-10', 'web'));
  assert.equal(view.exactCount, 2);
  assert.ok(Math.abs(view.hllEstimate - 2) < 1);
  await s2.close();
});

test('导入摘要：同规范可合并，异规范被拒绝并指出差异', () => {
  const store = new EventStore(join(dir, 's6'));
  for (let i = 0; i < 1000; i++) {
    store.addEvent({ id: `local_${i}`, date: '2026-11-10', channel: 'web' });
  }
  const good = new HyperLogLog(SPEC);
  for (let i = 0; i < 500; i++) good.add(`remote_${i}`);
  const bad = new HyperLogLog({ ...SPEC, precision: 10 });
  bad.add('remote_x');

  const r = importAndMerge(store, {
    partitionKeys: [partitionKey('2026-11-10', 'web')],
    importedSummaries: [
      { ...good.toJSON(), label: 'good' },
      bad.toJSON(),
    ],
  });
  assert.equal(r.acceptedImports.length, 1);
  assert.equal(r.rejectedImports.length, 1);
  assert.match(r.rejectedImports[0].reason, /precision/);
  // 本地精确并集 1000，合并估计应明显大于 1000（加入了 500 个远端访客）
  assert.ok(r.hll.estimate > 1100, `估计值未反映导入访客: ${r.hll.estimate}`);
  assert.equal(r.exactDistinctLocalOnly, 1000);
});

test('全部摘要参数不一致时整体拒绝', () => {
  const store = new EventStore(join(dir, 's7'));
  const bad = new HyperLogLog({ ...SPEC, hashSeed: 1 }).toJSON();
  assert.throws(
    () => importAndMerge(store, { partitionKeys: [], importedSummaries: [bad] }),
    /ALL_SUMMARIES_REJECTED|参数不一致/,
  );
});

test('理论误差与实测偏差分开展示且不做固定承诺', () => {
  const store = new EventStore(join(dir, 's8'));
  for (let i = 0; i < 300; i++) {
    store.addEvent({ id: `v_${i}`, date: 'd1', channel: 'c1' });
  }
  const r = mergePartitions(store, [partitionKey('d1', 'c1')]);
  assert.ok(r.errorExplanation.theoreticalStandardError > 0);
  assert.ok(typeof r.errorExplanation.observedRelativeError === 'number');
  assert.match(r.errorExplanation.guaranteeNote, /无法保证/);
  assert.match(r.hll.note, /概率估计/);
});
