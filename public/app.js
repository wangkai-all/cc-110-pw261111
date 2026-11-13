// 前端逻辑：原生 JS，无构建步骤。
const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { data: json });
  return json;
};
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(3)}%`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let lastSummary = null;

async function loadSpec() {
  const r = await fetch('/api/spec').then((x) => x.json());
  $('specChip').textContent =
    `标识:${r.spec.idType} · 哈希:${r.spec.hashAlgorithm} · 种子:0x${r.spec.hashSeed.toString(16)} · p=${r.spec.precision} (m=${2 ** r.spec.precision})`;
}

async function refresh() {
  const data = await fetch('/api/partitions').then((r) => r.json());
  renderOverview(data);
  renderTable(data.partitions);
}

function renderOverview(data) {
  const totalExact = data.partitions.reduce((a, p) => a + p.exactCount, 0);
  $('overview').innerHTML = `
    <div class="stat"><b>${data.stats.partitionCount}</b><span>分区数（日期×渠道）</span></div>
    <div class="stat"><b>${data.stats.eventCount}</b><span>原始事件数（含重复）</span></div>
    <div class="stat"><b>${totalExact}</b><span>各分区精确人数之和（未去重）</span></div>
    <div class="stat"><b>${data.stats.droppedEmptyIds}</b><span>被丢弃的空标识事件</span></div>`;
}

function renderTable(partitions) {
  if (partitions.length === 0) {
    $('tableWrap').innerHTML = '<p class="hint">暂无数据，先用上方生成器写入事件。</p>';
    return;
  }
  const byDate = new Map();
  for (const p of partitions) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }
  const rows = [];
  for (const [date, parts] of [...byDate].sort()) {
    rows.push(`<tr class="date-head"><td colspan="8">📅 ${date}</td></tr>`);
    for (const p of parts.sort((a, b) => a.channel.localeCompare(b.channel))) {
      rows.push(`
      <tr>
        <td><input type="checkbox" class="pick" data-key="${esc(p.key)}" /></td>
        <td>${esc(p.channel)}</td>
        <td>${p.eventCount}</td>
        <td class="kpi-exact">${p.exactCount}</td>
        <td class="kpi-hll">${p.hllEstimateRounded} <span class="tag approx">估计</span></td>
        <td class="kpi-err">实测 ${pct(p.observedRelativeError)}</td>
        <td>${p.summaryByteSize} B</td>
        <td><button data-view="${esc(p.key)}">查看合并视图</button></td>
      </tr>`);
    }
  }
  $('tableWrap').innerHTML = `
    <table>
      <thead><tr>
        <th>选择</th><th>渠道</th><th>事件数</th><th>精确独立访客</th>
        <th>HLL 估计</th><th>实测偏差</th><th>摘要大小</th><th></th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;

  document.querySelectorAll('button[data-view]').forEach((btn) =>
    btn.addEventListener('click', () => doMerge([btn.dataset.view])));
}

function selectedKeys() {
  return [...document.querySelectorAll('.pick:checked')].map((el) => el.dataset.key);
}

async function doMerge(keys) {
  if (!keys || keys.length === 0) {
    keys = selectedKeys();
  }
  if (keys.length === 0) return alert('请先勾选至少一个分区');
  const r = await api('/api/merge', { partitionKeys: keys, detailLimit: 50 });
  lastSummary = r.summary;
  renderMerge(r);
}

function renderMerge(r) {
  $('mergeCard').hidden = false;
  $('mergeCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const e = r.errorExplanation;
  const within = r.exactDistinct > 0 &&
    Math.abs(r.hll.estimate - r.exactDistinct) / r.exactDistinct <= e.theoreticalStandardError;
  $('mergeResult').innerHTML = `
    <div class="result-grid">
      <div class="big-kpi exact"><h3>精确独立访客（并集）<span class="tag exact">精确</span></h3>
        <div class="num">${r.exactDistinct}</div></div>
      <div class="big-kpi approx"><h3>HyperLogLog 估计<span class="tag approx">近似</span></h3>
        <div class="num">${r.hllEstimateRounded ?? r.hll.estimateRounded}</div>
        <div class="hint">未取整估计：${r.hll.estimate}</div></div>
      <div class="big-kpi"><h3>理论相对标准误差</h3>
        <div class="num">${e.theoreticalStandardErrorPct}</div>
        <div class="hint">1.04 / √m，分布层面的期望波动</div></div>
      <div class="big-kpi"><h3>本次实测相对偏差</h3>
        <div class="num">${e.observedRelativeErrorPct}</div>
        <div class="hint ${within ? 'badge-ok' : 'badge-bad'}">
          ${within ? '本次落在 1 个理论标准误差内' : '本次超出 1 个理论标准误差（正常，非误差上限）'}</div></div>
      <div class="big-kpi"><h3>摘要大小 / 合并耗时</h3>
        <div class="num" style="font-size:18px">${r.summaryByteSize} B · ${r.mergeDurationMs} ms</div></div>
      <div class="big-kpi"><h3>朴素相加 vs 去重并集</h3>
        <div class="num" style="font-size:18px">${r.naiveSumOfPartitionCounts} → ${r.exactDistinct}</div>
        <div class="hint">重复计次：${r.overlapCount}（同一访客跨分区只算一次）</div></div>
    </div>
    <div class="note-box">
      <b>误差说明</b>
      <ul>
        <li>${esc(e.theoreticalNote)}</li>
        <li>${esc(e.observedNote)}</li>
        <li>${esc(e.guaranteeNote)}</li>
      </ul>
    </div>
    ${r.detailsTruncated ? `<div class="note-box">${esc(r.detailNote)}</div>` : renderDetails(r.visitorDetails)}
    <details><summary>合并后 HLL 摘要 JSON（可复制用于导入）</summary><pre class="json">${esc(JSON.stringify(r.summary, null, 2))}</pre></details>`;
}

function renderDetails(details) {
  if (!details || details.length === 0) return '';
  const rows = details
    .map((d) => `<tr><td><code>${esc(d.id)}</code></td><td>${d.inPartitions.map(esc).join(', ')}</td><td>${d.inPartitions.length}</td></tr>`)
    .join('');
  return `<details open><summary>访客明细（${details.length} 人，小样本自动展开）</summary>
    <table class="visitor-table"><thead><tr><th>访客标识（字符串原样保留）</th><th>出现分区</th><th>出现次数</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
}

// ---------- 事件生成器 ----------
async function generate() {
  // 浏览器内复刻 tools/generate-events.js 的生成逻辑（同参数语义），
  // 生成后通过 /api/events 写入服务端。
  const body = buildEvents({
    dates: $('gDates').value.split(',').map((s) => s.trim()).filter(Boolean),
    channels: $('gChannels').value.split(',').map((s) => s.trim()).filter(Boolean),
    visitors: Number($('gVisitors').value),
    overlap: Number($('gOverlap').value),
    repeatRate: Number($('gRepeat').value),
    emptyRate: Number($('gEmpty').value),
  });
  const r = await api('/api/events', { events: body.events });
  setMsg('genMsg', `写入 ${r.accepted} 个事件，拒绝 ${r.rejected} 个空/非法标识；分区访客分布：${body.plan
    .map((p) => `${p.date}/${p.channel}=${p.distinctVisitors}人`).join('；')}`, r.accepted > 0);
  await refresh();
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildEvents({ dates, channels, visitors, overlap, repeatRate, emptyRate }) {
  const rand = mulberry32(Date.now() >>> 0);
  const poolSize = Math.round(visitors * 1.5);
  const pool = Array.from({ length: poolSize }, (_, i) => `user_${String(i).padStart(6, '0')}`);
  let seq = poolSize;
  const events = [];
  const plan = [];
  for (const date of dates) {
    for (const channel of channels) {
      const nShared = Math.round(visitors * overlap);
      const chosen = new Set();
      while (chosen.size < Math.min(nShared, pool.length)) chosen.add(pool[Math.floor(rand() * pool.length)]);
      const ids = [...chosen];
      while (ids.length < visitors) ids.push(`user_${String(seq++).padStart(6, '0')}`);
      let emptyInjected = 0;
      for (const id of ids) {
        events.push({ id, date, channel });
        while (rand() < repeatRate) events.push({ id, date, channel });
        if (rand() < emptyRate) { events.push({ id: '', date, channel }); emptyInjected++; }
      }
      plan.push({ date, channel, distinctVisitors: ids.length, emptyInjected });
    }
  }
  return { events, plan };
}

// ---------- 导入合并 ----------
async function doImport() {
  let parsed;
  try {
    parsed = JSON.parse($('importText').value);
  } catch (err) {
    return setMsg('importResult', `JSON 解析失败：${err.message}`, false, true);
  }
  const importedSummaries = Array.isArray(parsed) ? parsed : [parsed];
  try {
    const r = await api('/api/import-merge', {
      partitionKeys: selectedKeys(),
      importedSummaries,
    });
    lastSummary = r.summary;
    $('importResult').innerHTML = `<div class="note-box">
      <b>导入合并完成</b>
      <ul>
        <li>接受摘要：${r.acceptedImports.map((a) => esc(a.label)).join(', ') || '无'}</li>
        <li>拒绝摘要：${r.rejectedImports.length === 0 ? '无' : r.rejectedImports.map((x) => `#${x.index} ${esc(x.reason)}`).join('；')}</li>
        <li>HLL 估计（近似）：${r.hll.estimateRounded}（未取整 ${r.hll.estimate}）</li>
        <li>${esc(r.exactNote)}</li>
        <li>理论标准误差 ${r.errorExplanation.theoreticalStandardErrorPct}；
            实测偏差 ${r.errorExplanation.observedRelativeErrorPct ?? '无法计算（无本地精确值）'}</li>
        <li>摘要 ${r.summaryByteSize} B · 合并耗时 ${r.mergeDurationMs} ms</li>
      </ul></div>`;
  } catch (err) {
    const rejected = err.data?.rejected;
    $('importResult').innerHTML = `<div class="note-box err"><b>合并被拒绝</b>：${esc(err.message)}
      ${rejected ? `<ul>${rejected.map((x) => `<li>#${x.index}: ${esc(x.reason)}</li>`).join('')}</ul>` : ''}</div>`;
  }
}

// ---------- 单条写入 / 删除 ----------
async function addEvent(late = false) {
  const body = { id: $('evId').value.trim(), date: $('evDate').value.trim(), channel: $('evChannel').value.trim() };
  try {
    const r = await api('/api/events', { events: [body] });
    const item = r.results[0];
    setMsg('writeMsg', item.accepted
      ? `${late ? '迟到' : ''}事件已写入，${item.isNewVisitor ? '该分区新增 1 名访客' : '访客已存在，摘要幂等更新'}`
      : `被拒绝：${item.reason}`, item.accepted);
    await refresh();
  } catch (err) {
    setMsg('writeMsg', err.message, false);
  }
}

async function removeVisitor() {
  const id = $('evId').value.trim();
  if (!id) return setMsg('writeMsg', '请填写要删除的访客标识', false);
  if (!confirm(`确认删除访客 ${id}？受影响分区将从原始事件重建（HLL 不支持直接减去一个人）。`)) return;
  try {
    const r = await api('/api/visitors/remove', {
      id, date: $('evDate').value.trim(), channel: $('evChannel').value.trim(),
    });
    setMsg('writeMsg', `已重建 ${r.rebuiltPartitions.length} 个分区：${r.rebuiltPartitions.join(', ') || '无（未找到该访客）'}`, true);
    await refresh();
  } catch (err) {
    setMsg('writeMsg', err.message, false);
  }
}

function setMsg(elId, text, ok, rawHtml = false) {
  const el = $(elId);
  el.className = `msg ${ok ? 'ok' : 'err'}`;
  if (rawHtml) el.innerHTML = text; else el.textContent = text;
}

// ---------- 绑定 ----------
$('btnGenerate').addEventListener('click', generate);
$('btnLate').addEventListener('click', () => addEvent(true));
$('btnReset').addEventListener('click', async () => {
  if (!confirm('确认清空全部事件与分区？')) return;
  await api('/api/admin/reset', {});
  await refresh();
  setMsg('genMsg', '已清空全部数据', true);
});
$('btnSelectAll').addEventListener('click', () =>
  document.querySelectorAll('.pick').forEach((el) => (el.checked = true)));
$('btnSelectNone').addEventListener('click', () =>
  document.querySelectorAll('.pick').forEach((el) => (el.checked = false)));
$('btnMergeSelected').addEventListener('click', () => doMerge());
$('btnImport').addEventListener('click', doImport);
$('btnAddEvent').addEventListener('click', () => addEvent(false));
$('btnRemove').addEventListener('click', removeVisitor);
$('btnCopySummary').addEventListener('click', async () => {
  if (!lastSummary) return alert('请先执行一次合并');
  await navigator.clipboard.writeText(JSON.stringify(lastSummary));
  alert('合并摘要已复制到剪贴板');
});

loadSpec().then(refresh).catch((err) => setMsg('genMsg', `初始化失败：${err.message}`, false));
