// 事件存储：保留全部原始事件（JSONL），按 (date, channel) 分区维护
// 精确访客集合与 HLL 摘要。
//
// 关键设计：
//  - 迟到事件可以直接追加并更新对应分区摘要（HLL 天然支持增量 add）。
//  - 删除访客不能从 HLL 里"减一个人"——HLL 寄存器只存最大值，不可逆。
//    因此删除时从保留的原始事件重建受影响分区的精确集合与摘要。
//  - 原始事件文件用 append 方式写入；删除时重写该分区事件文件。

import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { HyperLogLog, SPEC, isValidIdentifier } from './hll.js';

export function partitionKey(date, channel) {
  return `${date}__${channel}`;
}

export class EventStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.eventsDir = join(dataDir, 'events');
    this.metaPath = join(dataDir, 'meta.json');
    mkdirSync(this.eventsDir, { recursive: true });
    // partitions: key -> { date, channel, exact: Set<string>, hll: HyperLogLog }
    this.partitions = new Map();
    this.globalEventCount = 0;
    this.ingestedEventCount = 0; // 实际计入（非空标识）的事件数
    this.droppedEmptyIds = 0;
    this.writers = new Map(); // 每个分区一个 append stream
  }

  _part(key) {
    let part = this.partitions.get(key);
    if (!part) {
      part = {
        key,
        date: key.split('__')[0],
        channel: key.split('__').slice(1).join('__'),
        exact: new Set(),
        hll: new HyperLogLog(SPEC),
        eventCount: 0,
      };
      this.partitions.set(key, part);
    }
    return part;
  }

  _writer(key) {
    let w = this.writers.get(key);
    if (!w) {
      w = createWriteStream(join(this.eventsDir, `${key}.jsonl`), { flags: 'a' });
      this.writers.set(key, w);
    }
    return w;
  }

  // 追加单个事件。返回 {accepted: boolean, reason?: string}
  addEvent({ id, date, channel }) {
    if (!isValidIdentifier(id)) {
      this.droppedEmptyIds++;
      return { accepted: false, reason: '空标识或非字符串标识，已丢弃（不计入访客）' };
    }
    if (!date || !channel) {
      return { accepted: false, reason: '缺少 date 或 channel' };
    }
    const key = partitionKey(date, channel);
    const part = this._part(key);

    // 原始事件落盘（迟到事件走同一条路径）
    this._writer(key).write(JSON.stringify({ id, date, channel, ts: Date.now() }) + '\n');
    this.globalEventCount++;
    part.eventCount++;

    const isNew = !part.exact.has(id);
    part.exact.add(id);
    part.hll.add(id); // 重复 add 对 HLL 幂等
    if (isNew) this.ingestedEventCount++;
    return { accepted: true, isNewVisitor: isNew };
  }

  // 删除某访客在指定分区（或全部分区）的出现。
  // 先从原始事件文件移除，再整体重建受影响分区——不做 HLL 减法。
  async removeVisitor(id, { date, channel } = {}) {
    if (!isValidIdentifier(id)) {
      throw new Error('空标识或非字符串标识，无法删除');
    }
    const affected = [];
    for (const part of this.partitions.values()) {
      if (!part.exact.has(id)) continue;
      if (date && part.date !== date) continue;
      if (channel && part.channel !== channel) continue;
      affected.push(part);
    }
    if (affected.length === 0) {
      return { rebuiltPartitions: [], removedFrom: 0 };
    }

    // 关闭写入流，重写事件文件
    for (const part of affected) {
      const w = this.writers.get(part.key);
      if (w) {
        await new Promise((res) => w.end(res));
        this.writers.delete(part.key);
      }
      const path = join(this.eventsDir, `${part.key}.jsonl`);
      const tmp = path + '.tmp';
      const out = createWriteStream(tmp);
      const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      let removed = 0;
      for await (const line of rl) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.id === id) {
          removed++;
          continue;
        }
        out.write(line + '\n');
      }
      await new Promise((res) => out.end(res));
      renameSync(tmp, path);
      await this._rebuildPartition(part);
      part.removedEvents = removed;
    }
    return {
      rebuiltPartitions: affected.map((p) => p.key),
      removedFrom: affected.length,
    };
  }

  // 从该分区保留的原始事件重建精确集合与 HLL 摘要
  async _rebuildPartition(part) {
    const exact = new Set();
    const hll = new HyperLogLog(SPEC);
    let eventCount = 0;
    const path = join(this.eventsDir, `${part.key}.jsonl`);
    if (existsSync(path)) {
      const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (!isValidIdentifier(ev.id)) continue;
        eventCount++;
        if (!exact.has(ev.id)) {
          exact.add(ev.id);
          hll.add(ev.id);
        }
      }
    }
    part.exact = exact;
    part.hll = hll;
    part.eventCount = eventCount;
  }

  // 启动时从磁盘恢复全部分区
  async load() {
    if (!existsSync(this.eventsDir)) return;
    const names = await readdir(this.eventsDir);
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const key = name.slice(0, -'.jsonl'.length);
      const [date, ...rest] = key.split('__');
      const part = this._part(key);
      part.date = date;
      part.channel = rest.join('__');
      await this._rebuildPartition(part);
      this.globalEventCount += part.eventCount;
      this.ingestedEventCount += part.exact.size;
    }
  }

  listPartitions() {
    return [...this.partitions.values()].map((p) => this._view(p));
  }

  _view(part) {
    const exact = part.exact.size;
    const estimate = part.hll.estimate();
    return {
      key: part.key,
      date: part.date,
      channel: part.channel,
      exactCount: exact,
      hllEstimate: Math.round(estimate * 100) / 100,
      hllEstimateRounded: Math.round(estimate),
      eventCount: part.eventCount,
      theoreticalSE: part.hll.theoreticalStandardError(),
      observedRelativeError: exact > 0 ? Math.abs(estimate - exact) / exact : 0,
      summaryByteSize: part.hll.serializedByteSize(),
      spec: part.hll.spec,
    };
  }

  getPartition(key) {
    const part = this.partitions.get(key);
    return part ? this._view(part) : null;
  }

  // 精确合并：跨分区取并集（同一访客只算一次，绝不是每日人数相加）
  exactUnion(keys) {
    const union = new Set();
    for (const k of keys) {
      const part = this.partitions.get(k);
      if (!part) throw Object.assign(new Error(`分区不存在: ${k}`), { code: 'NO_PARTITION' });
      for (const id of part.exact) union.add(id);
    }
    return union;
  }

  // HLL 合并：SPEC 不一致时拒绝并指出差异
  hllUnion(keys) {
    const merged = new HyperLogLog(SPEC);
    for (const k of keys) {
      const part = this.partitions.get(k);
      if (!part) throw Object.assign(new Error(`分区不存在: ${k}`), { code: 'NO_PARTITION' });
      merged.merge(part.hll); // 参数不一致会抛 SPEC_MISMATCH
    }
    return merged;
  }

  visitorDetails(keys) {
    // 返回并集中每个访客出现在哪些分区
    const map = new Map();
    for (const k of keys) {
      const part = this.partitions.get(k);
      if (!part) continue;
      for (const id of part.exact) {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(k);
      }
    }
    return [...map.entries()]
      .map(([id, inPartitions]) => ({ id, inPartitions }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async close() {
    await Promise.all([...this.writers.values()].map((w) => new Promise((r) => w.end(r))));
    this.writers.clear();
  }
}
