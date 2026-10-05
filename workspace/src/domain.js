// domain.js — 核心领域逻辑（无副作用决策层）
// 所有写入均经 decide() 校验后产出「事件」，由 store 追加；状态由事件重放投影而来。
import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const uid = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');
export const r2 = (n) => Math.round(n * 100) / 100;

// 确定性 JSON：键序固定，保证快照哈希跨进程可复算
export function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const need = (cond, code, msg, details) => { if (!cond) fail(422, code, msg, details); };

// ─────────────────────────────────────────────────────────────────────────────
// 作业创建 / 冻结快照
// ─────────────────────────────────────────────────────────────────────────────
export function validateCreate(b = {}) {
  need(b.product && typeof b.product.name === 'string' && b.product.name, 'INVALID_PRODUCT', 'product.name 必填');
  need(b.model && typeof b.model.fileHash === 'string' && /^[a-f0-9]{16,128}$/i.test(b.model.fileHash),
    'INVALID_MODEL', 'model.fileHash 必须为模型文件哈希');
  const model = {
    file: b.model.file || null,
    fileHash: b.model.fileHash.toLowerCase(),
    sourceVersion: b.model.sourceVersion || null,
    checksumAlg: b.model.checksumAlg || 'sha256',
    triangles: b.model.triangles ?? null,
    bboxMm: b.model.bboxMm ?? null,
    digestSummary: b.model.digestSummary || null
  };

  need(b.slice && isNum(b.slice.layerCount) && Number.isInteger(b.slice.layerCount) && b.slice.layerCount > 0,
    'INVALID_SLICE', 'slice.layerCount 必须为正整数');
  const slice = {
    layerCount: b.slice.layerCount,
    layerHeightMm: b.slice.layerHeightMm ?? null,
    profile: b.slice.profile || null,
    infillPct: b.slice.infillPct ?? null,
    nozzleTempC: b.slice.nozzleTempC ?? null,
    bedTempC: b.slice.bedTempC ?? null
  };

  need(b.calibration && b.calibration.calVersion, 'INVALID_CALIBRATION', 'calibration.calVersion 必填');
  const calibration = {
    calVersion: b.calibration.calVersion,
    bedLevel: b.calibration.bedLevel ?? null,
    eSteps: b.calibration.eSteps ?? null,
    calibratedAt: b.calibration.calibratedAt ?? null
  };

  const er = b.envRange || {};
  need(isNum(er.tempMinC) && isNum(er.tempMaxC) && isNum(er.humidityMinPct) && isNum(er.humidityMaxPct),
    'INVALID_ENV_RANGE', 'envRange 需含 tempMinC/tempMaxC/humidityMinPct/humidityMaxPct');
  need(er.tempMinC <= er.tempMaxC && er.humidityMinPct <= er.humidityMaxPct,
    'INVALID_ENV_RANGE', '环境范围最小值不得大于最大值');
  const envRange = {
    tempMinC: er.tempMinC, tempMaxC: er.tempMaxC,
    humidityMinPct: er.humidityMinPct, humidityMaxPct: er.humidityMaxPct
  };

  const arr = b.materials;
  need(Array.isArray(arr) && arr.length >= 1, 'INVALID_MATERIALS', 'materials 至少声明一个材料计划');
  const materials = arr.map((m, i) => {
    need(m && m.spoolId && m.batchNo, 'INVALID_MATERIALS', `materials[${i}] 缺 spoolId/batchNo`);
    need(isNum(m.initialNetG) && m.initialNetG > 0, 'INVALID_MATERIALS', `materials[${i}].initialNetG 必须为正`);
    const fromLayer = m.fromLayer ?? 1;
    need(Number.isInteger(fromLayer) && fromLayer >= 1 && fromLayer <= slice.layerCount,
      'INVALID_MATERIALS', `materials[${i}].fromLayer 超出层范围`);
    return {
      spoolId: String(m.spoolId),
      batchNo: String(m.batchNo),
      material: m.material || null,
      initialNetG: r2(m.initialNetG),
      fromLayer,
      reason: m.reason || null
    };
  });
  const froms = materials.map((m) => m.fromLayer);
  need(new Set(froms).size === froms.length, 'INVALID_MATERIALS', '不允许同一起始层声明两个料卷');
  materials.sort((a, c) => a.fromLayer - c.fromLayer);
  need(materials[0].fromLayer === 1, 'INVALID_MATERIALS', '第一层必须声明起始料卷');

  return {
    product: { sku: b.product.sku || null, name: b.product.name, qty: b.product.qty ?? 1 },
    model, slice, calibration, envRange, materials,
    deviceId: b.deviceId ? String(b.deviceId) : null,
    operator: b.operator || null,
    notes: b.notes || null
  };
}

// 快照只覆盖「随打印冻结」的要素；作业 id/状态/进度不进入哈希
export function buildSnapshot(v) {
  return {
    product: v.product, model: v.model, slice: v.slice,
    calibration: v.calibration, envRange: v.envRange,
    materials: v.materials.map(({ spoolId, batchNo, material, initialNetG, fromLayer, reason }) =>
      ({ spoolId, batchNo, material, initialNetG, fromLayer, reason })),
    deviceId: v.deviceId
  };
}
export const snapshotHashOf = (snap) => sha256(canon(snap));

// 当前层生效的材料计划
export const activeMaterialAt = (materials, layerNo) =>
  materials.filter((m) => m.fromLayer <= layerNo).sort((a, b) => b.fromLayer - a.fromLayer)[0] || null;

// ─────────────────────────────────────────────────────────────────────────────
// 决策：命令 -> 事件[]
// ─────────────────────────────────────────────────────────────────────────────
export function decide(store, cmd) {
  const t = nowIso();
  switch (cmd.type) {
    case 'create_job': {
      const v = validateCreate(cmd.body || {});
      const snapshot = buildSnapshot(v);
      const snapshotHash = snapshotHashOf(snapshot);
      const jobId = uid('JOB');
      return [{
        type: 'job_created', at: t, jobId,
        data: { ...v, snapshot, snapshotHash }
      }];
    }

    case 'revise_model': {
      const job = must(store, cmd.jobId);
      if (job.status !== 'DRAFT')
        fail(409, 'JOB_FROZEN', '作业已开始打印，模型已随快照冻结；禁止就地修订，请基于新模型创建新作业');
      const v = validateCreate({ ...snapshotView(job), ...(cmd.body || {}) });
      const snapshot = buildSnapshot(v);
      const snapshotHash = snapshotHashOf(snapshot);
      return [{ type: 'model_revised', at: t, jobId: job.jobId, data: { ...v, snapshot, snapshotHash } }];
    }

    case 'start_job': {
      const job = must(store, cmd.jobId);
      if (job.status !== 'DRAFT') fail(409, 'INVALID_STATE', `当前状态 ${job.status} 不可开始`);
      return [{ type: 'job_started', at: t, jobId: job.jobId, data: {} }];
    }

    case 'record_layer': {
      const job = must(store, cmd.jobId);
      const p = cmd.body || {};
      if (job.status !== 'PRINTING' && job.status !== 'RECOVERING')
        fail(409, 'INVALID_STATE', `当前状态 ${job.status} 不接受层回执`);

      need(isNum(p.layerNo) && Number.isInteger(p.layerNo) && p.layerNo >= 1 && p.layerNo <= job.snapshot.slice.layerCount,
        'LAYER_OUT_OF_RANGE', 'layerNo 超出切片层数');
      need(p.snapshotHash, 'SNAPSHOT_MISMATCH', '回执必须携带 snapshotHash');
      if (p.snapshotHash.toLowerCase() !== job.snapshotHash)
        fail(409, 'SNAPSHOT_MISMATCH', '回执快照哈希与作业冻结快照不一致（不同模型/参数版本的回执被拒绝）',
          { expected: job.snapshotHash, received: String(p.snapshotHash).toLowerCase() });
      if (p.deviceId && job.snapshot.deviceId && String(p.deviceId) !== String(job.snapshot.deviceId))
        fail(409, 'DEVICE_MISMATCH', '回执设备与作业冻结设备不一致');
      if (p.calVersion && p.calVersion !== job.snapshot.calibration.calVersion)
        fail(409, 'CALIBRATION_CHANGED', '设备校准版本与冻结版本不一致，须走断电/校准恢复流程',
          { expected: job.snapshot.calibration.calVersion, received: p.calVersion });

      // 重复层回执：同层同载荷幂等接受，同层不同载荷拒绝（重复回执不得覆盖事实）
      const existing = job.layers.find((l) => l.layerNo === p.layerNo);
      const payloadSig = sha256(canon({
        snapshotHash: p.snapshotHash, deviceId: p.deviceId ?? null, calVersion: p.calVersion ?? null,
        spoolId: p.spoolId, consumedG: p.consumedG, extrudedCumG: p.extrudedCumG,
        envTempC: p.envTempC, envHumidityPct: p.envHumidityPct
      }));
      if (existing) {
        if (existing.payloadSig === payloadSig)
          return []; // 幂等：不产生新事件
        fail(409, 'LAYER_CONFLICT', `第 ${p.layerNo} 层已有不同内容的回执，禁止覆盖`);
      }

      const expected = job.layers.length ? job.layers[job.layers.length - 1].layerNo + 1 : 1;
      if (p.layerNo !== expected)
        fail(409, 'LAYER_GAP', `层序不连续：下一个应为第 ${expected} 层，收到第 ${p.layerNo} 层`);

      need(p.spoolId, 'SPOOL_REQUIRED', '回执必须携带 spoolId');
      const plan = activeMaterialAt(job.snapshot.materials, p.layerNo);
      if (p.spoolId !== plan.spoolId)
        fail(422, 'SPOOL_NOT_DECLARED',
          `第 ${p.layerNo} 层使用了未在作业快照中声明的料卷 ${p.spoolId}（应为 ${plan.spoolId}）；中途换料必须在创建时声明 fromLayer`,
          { activeSpool: plan.spoolId, activeBatch: plan.batchNo });

      const seg = job.materialSegments[plan.spoolId];
      if (seg.closedOutAt)
        fail(409, 'SPOOL_CLOSED', `料卷 ${plan.spoolId} 已盘点封口，不能再产生层消耗`);
      // 换料点：新料卷的第一层，必须已对旧料卷做余量封口，且声明起始层匹配
      if (plan.fromLayer === p.layerNo && p.layerNo > 1) {
        const prev = activeMaterialAt(job.snapshot.materials, p.layerNo - 1);
        if (!job.materialSegments[prev.spoolId].closedOutAt)
          fail(409, 'SWITCH_NOT_CLOSED_OUT',
            `切换到 ${plan.spoolId} 前必须先提交旧料卷 ${prev.spoolId} 的余量盘点（material_closeout）`);
      }

      need(isNum(p.consumedG) && p.consumedG > 0, 'INVALID_CONSUMPTION', 'consumedG 必须为正');
      need(isNum(p.extrudedCumG) && p.extrudedCumG >= 0, 'INVALID_EXTRUSION', 'extrudedCumG 必须为非负');
      if (p.layerNo > 1) {
        const prevLayer = job.layers[job.layers.length - 1];
        if (plan.spoolId === prevLayer.spoolId) {
          const delta = r2(p.extrudedCumG - prevLayer.extrudedCumG);
          if (Math.abs(delta - r2(p.consumedG)) > 0.01)
            fail(422, 'EXTRUSION_MISMATCH',
              `挤出增量 ${delta}g 与申报消耗 ${p.consumedG}g 不一致`, { delta, consumedG: p.consumedG });
          if (p.extrudedCumG < prevLayer.extrudedCumG)
            fail(422, 'EXTRUSION_REGRESSED', '挤出机累计读数不得回退');
        }
      }

      // 环境范围
      need(isNum(p.envTempC) && isNum(p.envHumidityPct), 'ENV_REQUIRED', '回执必须含 envTempC/envHumidityPct');
      const er = job.snapshot.envRange;
      const envOutOfRange = p.envTempC < er.tempMinC || p.envTempC > er.tempMaxC ||
        p.envHumidityPct < er.humidityMinPct || p.envHumidityPct > er.humidityMaxPct;

      const evs = [{
        type: 'layer_recorded', at: t, jobId: job.jobId,
        data: {
          layerNo: p.layerNo, at: p.at || t,
          snapshotHash: p.snapshotHash.toLowerCase(),
          deviceId: p.deviceId ?? null, calVersion: p.calVersion ?? null,
          spoolId: plan.spoolId, batchNo: plan.batchNo,
          consumedG: r2(p.consumedG), extrudedCumG: r2(p.extrudedCumG),
          envTempC: p.envTempC, envHumidityPct: p.envHumidityPct,
          envOutOfRange, payloadSig
        }
      }];
      if (envOutOfRange)
        evs.push(anomaly(t, job.jobId, {
          code: 'ENV_OUT_OF_RANGE', severity: 'warn', blocking: true,
          layerNo: p.layerNo,
          message: `第 ${p.layerNo} 层环境超出冻结范围（${p.envTempC}°C / ${p.envHumidityPct}%）`,
          evidence: { envTempC: p.envTempC, envHumidityPct: p.envHumidityPct, range: er }
        }));
      return evs;
    }

    case 'report_anomaly': {
      const job = must(store, cmd.jobId);
      if (!['PRINTING', 'RECOVERING'].includes(job.status))
        fail(409, 'INVALID_STATE', `当前状态 ${job.status} 不上报过程异常`);
      const p = cmd.body || {};
      need(p.code && p.message, 'ANOMALY_FIELDS', 'code/message 必填');
      return [anomaly(t, job.jobId, {
        code: p.code,
        severity: p.severity || 'warn',
        blocking: p.blocking !== false,
        layerNo: p.layerNo ?? null,
        message: p.message,
        evidence: p.evidence ?? null
      })];
    }

    case 'power_recovery': {
      const job = must(store, cmd.jobId);
      if (!['PRINTING', 'RECOVERING'].includes(job.status))
        fail(409, 'INVALID_STATE', `当前状态 ${job.status} 不允许断电恢复登记`);
      const p = cmd.body || {};
      if (p.calVersion && p.calVersion !== job.snapshot.calibration.calVersion)
        fail(409, 'CALIBRATION_CHANGED',
          '断电后设备校准版本与冻结版本不一致：不得继续原快照，须重新校准后创建新作业',
          { expected: job.snapshot.calibration.calVersion, received: p.calVersion });
      if (p.modelFileHash && p.modelFileHash.toLowerCase() !== job.snapshot.model.fileHash)
        fail(409, 'MODEL_CHANGED', '断电恢复检测到模型文件变化，禁止在同一作业混用模型版本');
      const last = job.layers.length ? job.layers[job.layers.length - 1].layerNo : 0;
      const resumedAtLayer = p.resumedAtLayer ?? last + 1;
      need(Number.isInteger(resumedAtLayer) && resumedAtLayer >= 1 && resumedAtLayer <= job.snapshot.slice.layerCount + 1,
        'INVALID_LAYER', 'resumedAtLayer 非法');
      return [
        { type: 'power_recovery', at: t, jobId: job.jobId, data: {
          deviceId: p.deviceId ?? null, calVersion: p.calVersion ?? null,
          lastGoodLayer: last, resumedAtLayer,
          note: p.note || '设备断电后恢复，校准版本与快照一致'
        } },
        anomaly(t, job.jobId, {
          code: 'POWER_LOSS_RESUMED', severity: 'info', blocking: false,
          layerNo: resumedAtLayer,
          message: `断电恢复：最后完整层=${last}，自第 ${resumedAtLayer} 层续打（校准 ${p.calVersion ?? 'n/a'} 与快照一致）`,
          evidence: { lastGoodLayer: last, resumedAtLayer }
        })
      ];
    }

    case 'resolve_anomaly': {
      const job = must(store, cmd.jobId);
      const p = cmd.body || {};
      const a = job.anomalies.find((x) => x.anomalyId === p.anomalyId);
      if (!a) fail(404, 'NOT_FOUND', '异常不存在');
      if (a.status !== 'open') fail(409, 'ANOMALY_CLOSED', '异常已处置');
      need(p.decision === 'accepted' || p.decision === 'rejected', 'INVALID_DECISION', 'decision 必须为 accepted/rejected');
      return [{ type: 'anomaly_resolved', at: t, jobId: job.jobId, data: {
        anomalyId: p.anomalyId, decision: p.decision,
        reviewer: p.reviewer || null, rationale: p.rationale || null
      } }];
    }

    case 'material_closeout': {
      const job = must(store, cmd.jobId);
      if (!['PRINTING', 'RECOVERING'].includes(job.status))
        fail(409, 'INVALID_STATE', `当前状态 ${job.status} 不接受料卷盘点`);
      const p = cmd.body || {};
      need(p.spoolId && isNum(p.remainingNetG) && p.remainingNetG >= 0,
        'INVALID_CLOSEOUT', 'spoolId 与非负 remainingNetG 必填');
      const seg = job.materialSegments[p.spoolId];
      if (!seg) fail(404, 'SPOOL_UNKNOWN', `料卷 ${p.spoolId} 未在作业快照中声明`);
      if (seg.closedOutAt) fail(409, 'SPOOL_CLOSED', `料卷 ${p.spoolId} 已盘点封口`);
      const plan = job.snapshot.materials.find((m) => m.spoolId === p.spoolId);
      // 计划内该料卷承担的层必须都已上传，才允许封口
      const nextPlans = job.snapshot.materials.filter((m) => m.fromLayer > plan.fromLayer).sort((a, b) => a.fromLayer - b.fromLayer);
      const lastExpected = nextPlans.length ? nextPlans[0].fromLayer - 1 : job.snapshot.slice.layerCount;
      if (job.layers.length < lastExpected)
        fail(409, 'CLOSEOUT_EARLY', `该料卷承担至第 ${lastExpected} 层，当前仅上传到第 ${job.layers.length} 层`);
      if (p.remainingNetG > seg.initialNetG + 1e-9)
        fail(422, 'BALANCE_IMPOSSIBLE', '余量不得大于投料净重');

      const consumedMeasured = r2(seg.initialNetG - p.remainingNetG);
      const declared = r2(seg.layers.reduce((s, l) => s + l.consumedG, 0));
      const tolerance = Math.max(5, r2(0.005 * seg.initialNetG)); // 0.5% 投料或 5g 取大者
      const variance = r2(consumedMeasured - declared);
      const balanced = Math.abs(variance) <= tolerance;
      const evs = [{ type: 'material_closed_out', at: t, jobId: job.jobId, data: {
        spoolId: p.spoolId, batchNo: seg.batchNo,
        initialNetG: seg.initialNetG, remainingNetG: r2(p.remainingNetG),
        consumedMeasured, declaredConsumedG: declared, varianceG: variance, toleranceG: tolerance, balanced
      } }];
      if (!balanced)
        evs.push(anomaly(t, job.jobId, {
          code: 'MATERIAL_BALANCE', severity: 'error', blocking: true,
          message: `料卷 ${p.spoolId}（批次 ${seg.batchNo}）余量不守恒：实耗 ${consumedMeasured}g 与申报 ${declared}g 偏差 ${variance}g，容差 ±${tolerance}g`,
          evidence: { consumedMeasured, declaredConsumedG: declared, varianceG: variance, toleranceG: tolerance }
        }));
      return evs;
    }

    case 'complete_job': {
      const job = must(store, cmd.jobId);
      if (job.status !== 'PRINTING' && job.status !== 'RECOVERING')
        fail(409, 'INVALID_STATE', `当前状态 ${job.status} 不可完工`);
      if (job.layers.length !== job.snapshot.slice.layerCount)
        fail(409, 'LAYERS_INCOMPLETE',
          `层记录不完整：${job.layers.length}/${job.snapshot.slice.layerCount}`);
      const unclosed = Object.values(job.materialSegments).filter((s) => !s.closedOutAt);
      if (unclosed.length)
        fail(409, 'CLOSEOUT_MISSING',
          `尚有料卷未做余量盘点封口：${unclosed.map((s) => s.spoolId).join(', ')}`);
      return [{ type: 'job_completed', at: t, jobId: job.jobId, data: {} }];
    }

    case 'record_qc': {
      const job = must(store, cmd.jobId);
      if (job.status === 'SCRAPPED' || job.status === 'RELEASED')
        fail(409, 'TERMINAL_STATE', `作业已处于终态 ${job.status}`);
      if (job.status !== 'COMPLETED')
        fail(409, 'INVALID_STATE', '仅 COMPLETED 作业可绑定质检结果');
      if (job.qc) fail(409, 'QC_EXISTS', '质检结果已绑定，不可重复绑定');
      const p = cmd.body || {};
      need(p.snapshotHash, 'SNAPSHOT_MISMATCH', '质检必须声明所检作业快照哈希');
      if (p.snapshotHash.toLowerCase() !== job.snapshotHash)
        fail(409, 'SNAPSHOT_MISMATCH', '质检绑定的快照哈希与作业不一致');
      need(typeof p.passed === 'boolean', 'QC_FIELDS', 'passed(boolean) 必填');
      need(p.inspector, 'QC_FIELDS', 'inspector 必填');
      return [{ type: 'qc_recorded', at: t, jobId: job.jobId, data: {
        passed: p.passed, inspector: p.inspector, snapshotHash: p.snapshotHash.toLowerCase(),
        reportId: p.reportId || null, method: p.method || null,
        measurements: p.measurements ?? null, notes: p.notes || null
      } }];
    }

    case 'scrap_job': {
      const job = must(store, cmd.jobId);
      if (job.status === 'RELEASED') fail(409, 'TERMINAL_CONFLICT', '已放行的成品不可报废：报废与放行只能留下一个终态');
      if (job.status === 'SCRAPPED') fail(409, 'TERMINAL_STATE', '作业已是报废终态');
      const p = cmd.body || {};
      need(p.reason, 'SCRAP_REASON', '报废原因必填');
      return [{ type: 'job_scrapped', at: t, jobId: job.jobId, data: { reason: p.reason, by: p.by || null } }];
    }

    case 'release_job': {
      const job = must(store, cmd.jobId);
      const g = evalRelease(job);
      if (!g.allowed) fail(409, 'RELEASE_DENIED', g.reason, g.checks);
      return [{ type: 'job_released', at: t, jobId: job.jobId, data: { by: cmd.body?.by || null } }];
    }

    default:
      fail(400, 'UNKNOWN_COMMAND', `未知命令 ${cmd.type}`);
  }
}

function anomaly(at, jobId, d) {
  return { type: 'anomaly_reported', at, jobId, data: { anomalyId: uid('AN'), at, ...d, status: 'open' } };
}
function must(store, jobId) {
  const job = store.getJob(jobId);
  if (!job) fail(404, 'NOT_FOUND', `作业 ${jobId} 不存在`);
  return job;
}
function snapshotView(job) {
  const s = job.snapshot;
  return {
    product: s.product, model: s.model, slice: s.slice, calibration: s.calibration,
    envRange: s.envRange, materials: s.materials, deviceId: s.deviceId,
    operator: job.operator || null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 放行闸门
// ─────────────────────────────────────────────────────────────────────────────
export function evalRelease(job) {
  const checks = [];
  const add = (name, ok, reason) => checks.push({ name, ok, reason });
  const n = job.snapshot.slice.layerCount;

  add('state_completed', job.status === 'COMPLETED', `状态为 ${job.status}，须先完工`);
  add('layers_complete',
    job.layers.length === n,
    job.layers.length === n ? null : `层记录 ${job.layers.length}/${n} 不完整`);
  const contiguous = job.layers.every((l, i) => l.layerNo === i + 1);
  add('layers_contiguous', contiguous, '层序不连续');

  const spools = Object.values(job.materialSegments);
  add('all_closeout', spools.every((s) => s.closedOutAt),
    spools.every((s) => s.closedOutAt) ? null : '存在未盘点封口的料卷');
  const imbalanced = spools.filter((s) => s.balanced === false).map((s) => s.spoolId);
  add('material_conservation', imbalanced.length === 0,
    imbalanced.length ? `料卷余量不守恒：${imbalanced.join(', ')}` : null);

  const undeclared = job.layers.some((l) =>
    !job.snapshot.materials.some((m) => m.spoolId === l.spoolId && m.batchNo === l.batchNo));
  add('declared_materials_only', !undeclared, '出现未声明材料/批次');
  const sameSnap = job.layers.every((l) => l.snapshotHash === job.snapshotHash);
  add('single_snapshot', sameSnap, '层回执混用了不同快照（不同模型/参数版本）');

  const open = job.anomalies.filter((a) => a.status === 'open' && a.blocking);
  add('no_open_blocking_anomaly', open.length === 0,
    open.length ? `存在未处置阻断异常：${open.map((a) => a.code).join(', ')}` : null);
  const rejected = job.anomalies.filter((a) => a.status === 'rejected');
  add('no_rejected_anomaly', rejected.length === 0,
    rejected.length ? `存在被驳回的异常处置：${rejected.map((a) => a.code).join(', ')}` : null);

  add('qc_bound', !!job.qc, '尚未绑定质检结果');
  add('qc_passed', !!(job.qc && job.qc.passed), job.qc && !job.qc.passed ? '质检不合格' : null);
  if (job.qc)
    add('qc_same_snapshot', job.qc.snapshotHash === job.snapshotHash, '质检绑定的快照与作业不一致');

  const allowed = checks.every((c) => c.ok);
  return { allowed, reason: allowed ? null : '放行闸门未通过', checks };
}

// ─────────────────────────────────────────────────────────────────────────────
// 事件链完整性（防篡改）
// ─────────────────────────────────────────────────────────────────────────────
export function verifyEventChain(events) {
  let prev = 'GENESIS';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const body = `${e.seq}|${e.jobId}|${e.type}|${canon(e.data)}|${e.at}|${prev}`;
    if (e.hash !== sha256(body))
      return { ok: false, at: i, reason: `第 ${i} 条事件哈希不匹配（日志被篡改或损坏）` };
    if (e.prevHash !== prev)
      return { ok: false, at: i, reason: `第 ${i} 条事件前链断裂` };
    prev = e.hash;
  }
  return { ok: true, count: events.length, head: prev };
}

// ─────────────────────────────────────────────────────────────────────────────
// 成品证明
// ─────────────────────────────────────────────────────────────────────────────
export function buildCertificate(job, gates) {
  return {
    certId: uid('CRT'),
    issuedAt: nowIso(),
    jobId: job.jobId,
    product: job.snapshot.product,
    deviceId: job.snapshot.deviceId,
    snapshotHash: job.snapshotHash,
    modelFileHash: job.snapshot.model.fileHash,
    sourceVersion: job.snapshot.model.sourceVersion,
    sliceProfile: job.snapshot.slice.profile,
    layerCount: job.snapshot.slice.layerCount,
    calVersion: job.snapshot.calibration.calVersion,
    materials: Object.values(job.materialSegments).map((s) => ({
      spoolId: s.spoolId, batchNo: s.batchNo,
      initialNetG: s.initialNetG, remainingNetG: s.remainingNetG,
      declaredConsumedG: r2(s.layers.reduce((x, l) => x + l.consumedG, 0)),
      balanced: s.balanced
    })),
    layerHashes: job.layers.map((l) => ({ layerNo: l.layerNo, hash: l.payloadSig, spoolId: l.spoolId, batchNo: l.batchNo })),
    anomalySummary: {
      total: job.anomalies.length,
      accepted: job.anomalies.filter((a) => a.status === 'accepted').length,
      info: job.anomalies.filter((a) => a.severity === 'info').length
    },
    qc: job.qc ? {
      passed: job.qc.passed, inspector: job.qc.inspector, reportId: job.qc.reportId, at: job.qc.at
    } : null,
    releasedAt: job.releasedAt,
    releaseBy: job.releaseBy || null,
    gates: gates.checks
  };
}
export const signCertificate = (secret, cert) => hmac(secret, canon(withoutSig(cert)));
export function verifyCertificate(secret, cert) {
  if (!cert || !cert.signature) return { ok: false, reason: '缺少签名' };
  const expect = hmac(secret, canon(withoutSig(cert)));
  return expect === cert.signature ? { ok: true } : { ok: false, reason: '签名无效：证明内容与签发时不一致' };
}
const withoutSig = (c) => {
  const { signature, ...rest } = c;
  return rest;
};
