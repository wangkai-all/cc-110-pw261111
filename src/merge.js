// 合并服务：处理多分区合并、外部摘要导入，统一输出精确值与 HLL 估计值的对照，
// 以及理论误差与实测偏差的分离展示。

import { HyperLogLog, SPEC, specDiff } from './hll.js';

export function mergePartitions(store, keys, { includeDetails = false, detailLimit = 200 } = {}) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw Object.assign(new Error('至少选择一个分区'), { code: 'BAD_REQUEST' });
  }
  const t0 = process.hrtime.bigint();

  // 精确并集
  const exactSet = store.exactUnion(keys);
  const exact = exactSet.size;

  // HLL 合并（SPEC 不一致会抛 SPEC_MISMATCH）
  const merged = store.hllUnion(keys);
  const estimate = merged.estimate();

  const t1 = process.hrtime.bigint();
  const mergeMs = Number(t1 - t0) / 1e6;

  const theoreticalSE = merged.theoreticalStandardError();
  const observedRelativeError = exact > 0 ? Math.abs(estimate - exact) / exact : 0;

  // 每日人数之和——仅用于在页面上对照展示"直接相加"为什么是错的
  const sumOfDaily = keys.reduce((acc, k) => {
    const v = store.getPartition(k);
    return acc + (v ? v.exactCount : 0);
  }, 0);

  const result = {
    mergedKeys: keys,
    partitionCount: keys.length,
    exactDistinct: exact,
    hll: {
      estimate: Math.round(estimate * 100) / 100,
      estimateRounded: Math.round(estimate),
      kind: 'approximate',
      note: 'HyperLogLog 概率估计值，不是精确计数；不同输入会产生不同的随机偏差。',
    },
    errorExplanation: {
      theoreticalStandardError: theoreticalSE,
      theoreticalStandardErrorPct: `${(theoreticalSE * 100).toFixed(3)}%`,
      theoreticalNote:
        '1.04/sqrt(m) 是估计量的相对标准误差（分布层面的期望波动），' +
        '描述长期平均的离散程度，不承诺任意一次合并都落在该范围内，也不是误差上限。',
      observedRelativeError: observedRelativeError,
      observedRelativeErrorPct: `${(observedRelativeError * 100).toFixed(3)}%`,
      observedNote: '本次数据上估计值与精确值的实测相对偏差，只反映这一次输入。',
      guaranteeNote: '概率结构无法保证每次结果都落在固定误差内，实测偏差可能大于理论标准误差。',
    },
    summary: merged.toJSON(),
    summaryByteSize: merged.serializedByteSize(),
    mergeDurationMs: Math.round(mergeMs * 1000) / 1000,
    naiveSumOfPartitionCounts: sumOfDaily,
    overlapCount: sumOfDaily - exact, // 跨分区重复出现的访客次数（>=0）
  };

  if (includeDetails || exact <= detailLimit) {
    result.visitorDetails = store.visitorDetails(keys);
    result.detailsTruncated = false;
  } else {
    result.visitorDetails = [];
    result.detailsTruncated = true;
    result.detailNote = `并集访客 ${exact} 人超过展开阈值 ${detailLimit}，仅展示摘要；需要明细可调高阈值后重试。`;
  }
  return result;
}

// 导入一个或多个外部摘要，与本地分区（可选）一起合并，并与精确结果对照。
export function importAndMerge(store, payload) {
  const imported = payload.importedSummaries;
  if (!Array.isArray(imported) || imported.length === 0) {
    throw Object.assign(new Error('importedSummaries 必须是非空数组'), { code: 'BAD_REQUEST' });
  }

  const t0 = process.hrtime.bigint();
  const localKeys = Array.isArray(payload.partitionKeys) ? payload.partitionKeys : [];
  const merged = new HyperLogLog(SPEC);

  // 先合并本地分区
  if (localKeys.length > 0) {
    merged.merge(store.hllUnion(localKeys));
  }

  // 再逐个合并导入摘要；SPEC 不一致时拒绝并指出差异
  const accepted = [];
  const rejected = [];
  for (const [i, raw] of imported.entries()) {
    try {
      const other = HyperLogLog.fromJSON(raw);
      const diff = specDiff(SPEC, other.spec);
      if (diff) {
        rejected.push({ index: i, reason: `参数不一致，拒绝合并：${diff}` });
        continue;
      }
      merged.merge(other);
      accepted.push({
        index: i,
        label: raw.label || `imported[${i}]`,
        summaryByteSize: other.serializedByteSize(),
      });
    } catch (err) {
      rejected.push({ index: i, reason: err.message });
    }
  }

  if (accepted.length === 0) {
    throw Object.assign(new Error('没有可合并的导入摘要（全部因参数不一致或格式错误被拒绝）'), {
      code: 'ALL_SUMMARIES_REJECTED',
      rejected,
    });
  }

  const t1 = process.hrtime.bigint();
  const estimate = merged.estimate();

  // 若同时选择了本地分区，给出本地精确并集作对照；纯导入摘要没有精确值可比
  let exact = null;
  let observedRelativeError = null;
  if (localKeys.length > 0) {
    exact = store.exactUnion(localKeys).size;
    observedRelativeError = exact > 0 ? Math.abs(estimate - exact) / exact : null;
  }

  return {
    acceptedImports: accepted,
    rejectedImports: rejected,
    localPartitionKeys: localKeys,
    exactDistinctLocalOnly: exact,
    exactNote:
      exact === null
        ? '导入的外部摘要不含原始访客标识，无法给出精确去重值，页面仅展示 HLL 估计。'
        : '精确值只覆盖本地分区的访客并集；导入摘要带来的访客无法精确核对。',
    hll: {
      estimate: Math.round(estimate * 100) / 100,
      estimateRounded: Math.round(estimate),
      kind: 'approximate',
    },
    errorExplanation: {
      theoreticalStandardError: merged.theoreticalStandardError(),
      theoreticalStandardErrorPct: `${(merged.theoreticalStandardError() * 100).toFixed(3)}%`,
      observedRelativeError,
      observedRelativeErrorPct:
        observedRelativeError === null ? null : `${(observedRelativeError * 100).toFixed(3)}%`,
      guaranteeNote: '理论标准误差不是单次误差承诺；实测偏差可能大于该值。',
    },
    summary: merged.toJSON(),
    summaryByteSize: merged.serializedByteSize(),
    mergeDurationMs: Math.round((Number(t1 - t0) / 1e6) * 1000) / 1000,
  };
}
