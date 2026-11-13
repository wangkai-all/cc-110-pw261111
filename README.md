# 访问统计：精确去重 + HyperLogLog

零依赖 Node.js（>=20）实现的访问统计服务：每个日期 × 渠道分区同时维护
**精确访客集合**与 **HyperLogLog（HLL）摘要**，支持任意分区合并、摘要导入、
迟到事件更新，以及基于原始事件的删除重建。

## 启动

```bash
npm start                 # 默认 http://localhost:3000，数据在 ./data
PORT=8080 DATA_DIR=/tmp/x npm start
npm test                  # 16 个单元/集成测试
```

## 本地事件生成器

可调访客重叠比例（`--overlap`，0 = 分区访客完全独立，1 = 全部共享）：

```bash
# 直接 POST 到本地服务
node tools/generate-events.js --post \
  --dates 2026-11-10,2026-11-11,2026-11-12 --channels web,app \
  --visitors 300 --overlap 0.6 --repeat-rate 0.2 --empty-id-rate 0.02

# 输出 JSON 文件 / stdout
node tools/generate-events.js --out /tmp/events.json
node tools/generate-events.js --help 2>/dev/null;  # 参数见文件头注释
```

## 页面能力（http://localhost:3000）

1. 事件生成器：重叠比例、重复事件率、空标识注入率可调。
2. 分区明细表：每分区事件数、精确独立访客、HLL 估计、实测偏差、摘要大小。
3. 任意勾选分区合并（跨日期、跨渠道）：
   - 精确并集人数，与“朴素相加”对照（同一访客跨分区只算一次）；
   - HLL 近似估计、摘要大小、合并耗时；
   - 理论标准误差与本次实测偏差**分开展示**；
   - 小样本自动展开访客明细，大样本只展示摘要并提示阈值。
4. 导入外部 HLL 摘要合并：规范不一致的摘要被拒绝并指出差异字段。
5. 单条事件追加（含迟到）与访客删除（触发原始事件重建）。

## 关键设计约束

### 标识规范（SPEC，固定且随摘要携带）

| 字段 | 固定值 |
| --- | --- |
| `idType` | `string`（只接受字符串，**不做数字隐式转换**，`"001"` 与 `"1"` 是不同访客） |
| `hashAlgorithm` | `murmurhash3_x86_32` |
| `hashSeed` | `0x9747b28c` |
| `precision` | `12`（4096 个桶，理论相对标准误差 ≈ 1.625%） |

合并前逐字段比对 SPEC，任一不一致即拒绝合并并指出具体字段与双方取值。
空字符串、`null`、非字符串标识一律丢弃，不计入访客。

### 误差表述

- 理论相对标准误差 `1.04/√m` 是估计量分布层面的期望离散度，**不是单次误差上限**，
  不承诺每次合并都落在固定范围内；
- 实测相对偏差 `|估计−精确|/精确` 只描述当前这一次输入，两者在 API 与页面上分栏展示。

### 迟到事件与删除

- 迟到事件与普通事件走同一条追加路径：HLL 的 `add` 幂等，可直接更新对应分区摘要。
- HLL 寄存器只存最大值，**无法“减去一个人”**。删除访客时先改写该分区的原始事件
  JSONL，再从保留的原始事件整体重建精确集合与 HLL 摘要（`src/store.js` 的
  `removeVisitor` / `_rebuildPartition`）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/spec` | 当前固定 SPEC |
| GET | `/api/partitions` | 分区列表与统计 |
| POST | `/api/events` | 追加事件（数组），空标识返回 `rejected` |
| POST | `/api/merge` | 合并分区，返回精确值 + HLL 估计 + 误差说明 + 摘要 |
| POST | `/api/import-merge` | 导入摘要合并；不兼容返回 409 与逐项拒绝原因 |
| POST | `/api/visitors/details` | 并集访客明细及出现分区 |
| POST | `/api/visitors/remove` | 删除访客并重建受影响分区 |
| POST | `/api/rebuild` | 手动重建指定分区 |
| POST | `/api/admin/reset` | 清空数据（演示用） |

## 目录结构

```
src/hash.js      MurmurHash3 x86_32（固定种子）
src/hll.js       HyperLogLog：add/merge/estimate、SPEC 校验、序列化
src/store.js     原始事件 JSONL 存储、精确集合、迟到更新、删除重建
src/merge.js     合并与导入服务、误差说明组装
src/server.js    零依赖 HTTP 服务与静态页面
public/          前端页面（原生 JS）
tools/           本地事件生成器 CLI
test/            node:test 测试
```
