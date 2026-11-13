// HyperLogLog 摘要实现。
//
// 固定标识规范（SPEC）——所有摘要必须携带，合并时逐项比对，不一致即拒绝：
//   idType: 标识符类型。本实现只接受字符串标识（"string"）。
//            字符串标识不会被转换为数字："001" 与 "1" 是不同访客。
//   hashAlgorithm: 哈希算法名（"murmurhash3_x86_32"）。
//   hashSeed: 哈希种子（无符号 32 位整数）。
//   precision: 桶数量 m = 2^precision，每个桶一个 6 位寄存器（值 0..63）。
//
// 空标识（null/undefined/""）一律不计入访客，由调用方先过滤。

import { hashIdentifier } from './hash.js';

export const SPEC = Object.freeze({
  idType: 'string',
  hashAlgorithm: 'murmurhash3_x86_32',
  hashSeed: 0x9747b28c,
  precision: 12, // m = 4096 个桶，理论标准误差 ≈ 1.04/sqrt(4096) ≈ 1.625%
});

export const MIN_PRECISION = 4;
export const MAX_PRECISION = 24;

function alphaFor(m) {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

// 寄存器用普通数组保存（0..63），便于序列化与审查。
export class HyperLogLog {
  constructor(spec = SPEC, registers = null) {
    const p = spec.precision;
    if (!Number.isInteger(p) || p < MIN_PRECISION || p > MAX_PRECISION) {
      throw new Error(`precision 必须是 [${MIN_PRECISION},${MAX_PRECISION}] 内的整数，收到: ${p}`);
    }
    this.spec = { ...spec };
    this.m = 2 ** p;
    this.registers = registers
      ? Uint8Array.from(registers)
      : new Uint8Array(this.m);
    if (this.registers.length !== this.m) {
      throw new Error(`寄存器数量 ${this.registers.length} 与 precision=${p} 期望的 ${this.m} 不一致`);
    }
  }

  // 加入一个字符串标识。空标识抛错，由上层过滤后再调用更安全；
  // 这里也做一次防御：非字符串直接拒绝（绝不做隐式数字转换）。
  add(id) {
    if (typeof id !== 'string') {
      throw new Error(`只接受字符串标识，收到类型: ${typeof id}`);
    }
    if (id === '') {
      throw new Error('空标识不计入访客');
    }
    const h = hashIdentifier(id, this.spec.hashSeed);
    const p = this.spec.precision;
    const idx = h >>> (32 - p); // 高 p 位定桶
    // 剩余 32-p 位上的前导零数 +1，最大为 32-p，天然 <= 28 < 64
    const w = (h << p) >>> 0;
    const rank = Math.clz32(w) + 1;
    if (rank > this.registers[idx]) {
      this.registers[idx] = rank;
    }
  }

  // 合并另一个 HLL 到自身。SPEC 不一致时拒绝合并并指出具体差异。
  merge(other) {
    const diff = specDiff(this.spec, other.spec);
    if (diff) {
      const err = new Error(`摘要参数不一致，拒绝合并：${diff}`);
      err.code = 'SPEC_MISMATCH';
      err.diff = diff;
      throw err;
    }
    for (let i = 0; i < this.m; i++) {
      if (other.registers[i] > this.registers[i]) {
        this.registers[i] = other.registers[i];
      }
    }
    return this;
  }

  // HLL 基数估计，含小范围线性计数修正与大范围修正。
  estimate() {
    const m = this.m;
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < m; i++) {
      sum += 2 ** -this.registers[i];
      if (this.registers[i] === 0) zeros++;
    }
    const alpha = alphaFor(m);
    let e = (alpha * m * m) / sum;

    // 小范围修正：空桶较多时用线性计数
    if (e <= (5 / 2) * m && zeros > 0) {
      e = m * Math.log(m / zeros);
    } else if (e > (1 / 30) * 2 ** 32) {
      // 大范围修正（本实现 32 位哈希，实际几乎不会触发）
      e = -(2 ** 32) * Math.log(1 - e / 2 ** 32);
    }
    return e;
  }

  // 理论相对标准误差（标准差 / 均值），这是分布层面的期望指标，
  // 不是对单次估计结果的误差承诺。
  theoreticalStandardError() {
    return 1.04 / Math.sqrt(this.m);
  }

  toJSON() {
    return {
      type: 'HyperLogLog',
      spec: { ...this.spec },
      m: this.m,
      // base64 编码寄存器，每个寄存器 1 字节（值 <= 28）
      registersBase64: Buffer.from(this.registers).toString('base64'),
    };
  }

  static fromJSON(obj) {
    if (!obj || obj.type !== 'HyperLogLog' || !obj.spec) {
      throw new Error('不是合法的 HyperLogLog 摘要');
    }
    const registers = Buffer.from(obj.registersBase64 || '', 'base64');
    return new HyperLogLog(obj.spec, registers);
  }

  // 摘要序列化后的字节大小（近似，用于页面展示摘要体积）
  serializedByteSize() {
    return Buffer.byteLength(JSON.stringify(this.toJSON()));
  }
}

export function specDiff(a, b) {
  const fields = ['idType', 'hashAlgorithm', 'hashSeed', 'precision'];
  for (const f of fields) {
    if (a[f] !== b[f]) {
      return `字段 ${f}: ${JSON.stringify(a[f])} vs ${JSON.stringify(b[f])}`;
    }
  }
  return null;
}

// 判断标识是否应计入：必须是非空字符串。
// 注意：空白字符串 " " 是非空字符串，属于合法标识；数字不做隐式转换。
export function isValidIdentifier(id) {
  return typeof id === 'string' && id.length > 0;
}
