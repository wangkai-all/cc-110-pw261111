import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HyperLogLog, SPEC, specDiff, isValidIdentifier } from '../src/hll.js';
import { hashIdentifier } from '../src/hash.js';

test('哈希确定性：同一标识同一摘要规范产出相同哈希', () => {
  const h1 = hashIdentifier('user_000001', SPEC.hashSeed);
  const h2 = hashIdentifier('user_000001', SPEC.hashSeed);
  assert.equal(h1, h2);
  assert.ok(Number.isInteger(h1) && h1 >= 0 && h1 <= 0xffffffff);
});

test('字符串标识不做数字转换："001" 与 "1" 哈希不同', () => {
  assert.notEqual(
    hashIdentifier('001', SPEC.hashSeed),
    hashIdentifier('1', SPEC.hashSeed),
  );
});

test('空标识判定', () => {
  assert.equal(isValidIdentifier(''), false);
  assert.equal(isValidIdentifier(null), false);
  assert.equal(isValidIdentifier(undefined), false);
  assert.equal(isValidIdentifier(123), false);
  assert.equal(isValidIdentifier(' '), true); // 空白字符串是合法非空标识
  assert.equal(isValidIdentifier('user_1'), true);
  assert.throws(() => new HyperLogLog().add(''), /空标识/);
  assert.throws(() => new HyperLogLog().add(42), /字符串标识/);
});

test('HLL 基数估计在大样本上误差在合理范围', () => {
  const hll = new HyperLogLog(SPEC);
  const n = 50000;
  for (let i = 0; i < n; i++) hll.add(`visitor_${i}`);
  const est = hll.estimate();
  const rel = Math.abs(est - n) / n;
  // 理论 SE ≈ 1.625%；测试只要求工程上的宽边界 10%，不断言固定误差承诺
  assert.ok(rel < 0.1, `相对误差过大: ${rel}`);
});

test('重复 add 幂等：重复事件不改变估计', () => {
  const a = new HyperLogLog(SPEC);
  const b = new HyperLogLog(SPEC);
  for (let i = 0; i < 1000; i++) {
    a.add(`id_${i}`);
    b.add(`id_${i}`);
    b.add(`id_${i}`);
    b.add(`id_${i}`);
  }
  assert.deepEqual(Array.from(a.registers), Array.from(b.registers));
  assert.equal(a.estimate(), b.estimate());
});

test('合并 = 并集语义：跨集合重叠访客只算一次', () => {
  const a = new HyperLogLog(SPEC);
  const b = new HyperLogLog(SPEC);
  for (let i = 0; i < 2000; i++) a.add(`shared_${i}`);
  for (let i = 1000; i < 3000; i++) b.add(`shared_${i}`); // 1000 个重叠
  const merged = new HyperLogLog(SPEC).merge(a).merge(b);
  const est = merged.estimate();
  assert.ok(Math.abs(est - 3000) / 3000 < 0.05, `并集估计偏离: ${est}`);
});

test('SPEC 不一致时拒绝合并并指出差异字段', () => {
  const a = new HyperLogLog(SPEC);
  const otherSpec = { ...SPEC, hashSeed: 12345 };
  const b = new HyperLogLog(otherSpec);
  a.add('x'); b.add('x');
  assert.throws(() => a.merge(b), /hashSeed/);
  assert.match(specDiff(SPEC, { ...SPEC, precision: 10 }), /precision/);
  assert.match(specDiff(SPEC, { ...SPEC, idType: 'number' }), /idType/);
  assert.match(specDiff(SPEC, { ...SPEC, hashAlgorithm: 'xxhash' }), /hashAlgorithm/);
});

test('摘要序列化往返一致', () => {
  const hll = new HyperLogLog(SPEC);
  for (let i = 0; i < 500; i++) hll.add(`s_${i}`);
  const json = hll.toJSON();
  const restored = HyperLogLog.fromJSON(json);
  assert.deepEqual(Array.from(restored.registers), Array.from(hll.registers));
  assert.equal(restored.estimate(), hll.estimate());
  assert.equal(restored.spec.hashSeed, SPEC.hashSeed);
});
