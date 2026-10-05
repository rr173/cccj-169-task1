# 工业三维打印批次追溯与放行平台

面向金属/工业增材制造车间的**打印作业批次追溯与成品放行**系统。打印作业在创建时把
**模型摘要、切片参数、设备校准版本、材料批次与环境范围**冻结成带哈希的作业快照；设备逐层
上传进度与异常；成品只有在 **层记录完整、材料余量守恒、质检绑定同一作业快照** 等全部闸门
通过后才能放行。

零第三方依赖：仅使用 Node.js 20 内置模块（`http` / `crypto` / `fs`）。

## 快速开始

```bash
npm start          # 启动服务，默认 http://localhost:8080（PORT 可改）
npm run demo       # 另开终端：对运行中的服务跑 48 项端到端断言
```

- 作业台（层级追踪页面）： http://localhost:8080/
- 成品证明库： http://localhost:8080/certificates.html
- 重置演示数据： `POST /api/v1/admin/reset`（数据位于 `./data/`，删目录同样可重置）

## 核心设计：仅追加事件链 + 状态重放

```
HTTP 命令 ─▶ decide() 纯函数校验 ─▶ 事件(含哈希链) 追加到 data/events.jsonl
                                   │
                                   └▶ 启动/读取时重放投影为作业当前状态
放行成功 ─▶ 绑定快照/层指纹/批次/质检/闸门的 HMAC-SHA256 成品证明
```

- **没有 UPDATE/DELETE**：所有状态变化都是事件（`layer_recorded`、`anomaly_reported`、
  `material_closed_out`、`qc_recorded`、`job_released`、`job_scrapped` …）。
- 每条事件 `hash = sha256(seq | jobId | type | canonical(data) | at | prevHash)`，形成链；
  启动即全链校验，**磁盘篡改一条字段都会拒绝启动**。
- 所有写命令在**作业级串行锁**内裁决：报废与放行即使同时到达，也只有一个能写入终态。
- 业务规则全部集中在 `src/domain.js` 的纯函数里，无 I/O，可独立审计/测试。

## 冻结的作业快照

`POST /api/v1/jobs` 创建即冻结（DRAFT 时可整体替换草案，`PUT .../model`；一旦 start 即拒绝
修订并提示另开新作业）。快照内容：

| 部分 | 字段示例 |
|---|---|
| 模型摘要 | `fileHash`、`sourceVersion`、三角面片数、包围盒 |
| 切片参数 | `layerCount`、层厚、工艺档案、填充率、喷嘴/热床温度 |
| 设备校准 | `calVersion`、床面水平、e-steps、校准日期 |
| 材料批次 | 每卷 `spoolId` + `batchNo` + `initialNetG` + **`fromLayer`**（换料必须预声明）+ 原因 |
| 环境范围 | 温度/湿度上下限 |

`snapshotHash = sha256(canonical(snapshot))`。每层回执、质检都必须携带该哈希，不一致即 409。

## API 一览（前缀 `/api/v1`）

| 方法 路径 | 说明 |
|---|---|
| `POST /jobs` | 创建作业并冻结快照 |
| `GET /jobs` · `GET /jobs/{id}` · `GET /jobs/{id}/gates` | 列表 / 详情（含放行闸门） |
| `PUT /jobs/{id}/model` | 仅 DRAFT 可修订；打印开始后 409 |
| `POST /jobs/{id}/start` | 开始打印 |
| `POST /jobs/{id}/layers` | 设备层回执（层号/快照/料卷/消耗/挤出累计/温湿度） |
| `POST /jobs/{id}/power-recovery` | 断电恢复登记（校准版本必须仍匹配） |
| `POST /jobs/{id}/anomalies` · `/anomalies/resolve` | 异常上报 / 接受或驳回 |
| `POST /jobs/{id}/material-closeout` | 料卷余量盘点（自动守恒核对） |
| `POST /jobs/{id}/complete` | 完工（要求层齐 + 全部料卷盘点） |
| `POST /jobs/{id}/qc` | 绑定质检（同一快照；只能一次） |
| `POST /jobs/{id}/release` · `/scrap` | 放行（过闸门签证明）/ 报废，终态互斥 |
| `GET /jobs/{id}/certificate` | 作业的放行证明 |
| `GET /certificates` · `GET /certificates/{id}` · `POST /certificates/verify` | 证明库 / 验签 |
| `GET /chain` · `GET /health` | 事件链完整性与健康检查 |

错误统一形如 `{ "error": { "code": "SPOOL_NOT_DECLARED", "message": "...", "details": ... } }`。

## 放行闸门（全部满足才放行，证据随证明固化）

1. 作业处于 COMPLETED；2. 层数完整；3. 层序连续；
4. 每个声明料卷均有余量盘点；5. **余量守恒**：`|初始净重 − 盘点余量 − 层申报消耗合计| ≤ max(0.5%投料, 5g)`；
6. 只出现声明过的料卷/批次；7. 全部层回执绑定同一快照哈希；
8. 无未处置阻断异常；9. 无被驳回的异常处置；
10. 已绑定质检；11. 质检合格；12. 质检绑定同一快照。

## 威胁场景 → 控制点

| 需求中的风险 | 系统行为 |
|---|---|
| 混用未声明材料（中途换料） | 层回执料卷必须等于快照中该层 `fromLayer` 计划料卷，否则 `SPOOL_NOT_DECLARED` (422) |
| 换料不留痕 | 换料点必须先对旧卷做余量盘点封口（`SWITCH_NOT_CLOSED_OUT`），新卷同样守恒核对 |
| 设备断电后偷换校准/模型 | 恢复登记核对 `calVersion` 与模型哈希，不一致拒绝在原快照续打；恢复产生信息性可审计事件 |
| 模型修订导致版本混用 | start 后修订 409；层/质检哈希不匹配 409；闸门「单一快照」复核 |
| 重复层回执 | 同层同载荷幂等忽略；**同层不同载荷 409**，事实不可覆盖；层序必须连续 |
| 材料余量对不上 | closeout 自动核对，失衡即生成 `MATERIAL_BALANCE` 阻断异常，闸门拒绝放行 |
| 报废与放行并发 | 每作业命令串行锁 + 终态守卫：已放行报废 409、已报废放行 409，终态唯一 |
| 成品证明被伪造/篡改 | 证明为整包字段 + HMAC-SHA256 签名，改一个批次号验签即失败；事件链本身哈希防篡改 |
| 层环境超标 | 温湿度越界自动开阻断异常，须质量人员让步接受或驳回 |

## 成品证明（Certificate of Release）

放行成功签发，可在 `/c/{certId}` 查看、打印/存 PDF，并通过
`POST /api/v1/certificates/verify` 验签。证明固化：快照与模型哈希、12 项闸门结果、
逐层回执指纹、每卷批次与守恒结论、异常处置汇总、质检结论、放行人与时间、HMAC 签名。

## 目录

```
src/domain.js   冻结快照/全部业务规则/放行闸门/证明签名（纯函数决策层）
src/store.js    仅追加事件日志、哈希链、重放投影、作业级锁
src/server.js   HTTP API 与静态页面
src/demo.js     48 项端到端断言（正常流 + 全部威胁场景 + 并发终态）
web/            作业台、层级追踪、证明库、单张证明页面
data/           events.jsonl（事件链）、certs.json、secret.key（运行时生成）
```
