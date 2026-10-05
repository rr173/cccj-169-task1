// demo.js — 端到端场景演练（对运行中的服务打真实 HTTP API）
// 用法： npm start  后另开终端  npm run demo
const BASE = process.env.BASE || 'http://localhost:8080';
const call = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await r.json();
  return { status: r.status, j };
};

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✘ ${name} ${extra}\x1b[0m`); }
}
const expectFail = async (name, method, p, body, code) => {
  const r = await call(method, p, body);
  const ok = r.status >= 400 && (code ? r.j.error?.code === code : true);
  check(name, ok, `got ${r.status} ${r.j.error?.code}`);
  return r;
};

// 标准作业模板（12 层，L1-8 用 0042 卷，L9-12 换 0051 卷）
function jobBody(over = {}) {
  return {
    product: { sku: 'BRK-AX-204', name: '航空支架 AX-204', qty: 1 },
    deviceId: 'PRN-METAL-07', operator: '张工',
    model: {
      file: 'ax204_v3.step', fileHash: 'a3f9c1e77b024d8ea41d5f66c90b7e18',
      sourceVersion: 'CAD r2026-09-28/AX204#3', triangles: 184200
    },
    slice: { layerCount: 12, layerHeightMm: 0.06, profile: 'IN718-HIGH-DENSITY', infillPct: 100 },
    calibration: { calVersion: 'CAL-2026-09-30#11', bedLevel: 0.02, eSteps: 412.6 },
    envRange: { tempMinC: 18, tempMaxC: 26, humidityMinPct: 30, humidityMaxPct: 55 },
    materials: [
      { spoolId: 'SP-IN718-0042', batchNo: 'B-IN718-260918-07', material: 'IN718', initialNetG: 1000, fromLayer: 1 },
      { spoolId: 'SP-IN718-0051', batchNo: 'B-IN718-260925-03', material: 'IN718', initialNetG: 600, fromLayer: 9, reason: '计划换料' }
    ],
    ...over
  };
}
const layer = (job, no, over = {}) => {
  const spool = no <= 8 ? 'SP-IN718-0042' : 'SP-IN718-0051';
  const cum = +(no * 12.4).toFixed(2);
  return {
    layerNo: no, snapshotHash: job.snapshotHash, deviceId: 'PRN-METAL-07',
    calVersion: 'CAL-2026-09-30#11', spoolId: spool, consumedG: 12.4,
    extrudedCumG: cum, envTempC: 22 + (no % 3) * 0.4, envHumidityPct: 42,
    ...over
  };
};

async function main() {
  console.log('\n══════════ 0. 重置演示数据 ══════════');
  await call('POST', '/api/v1/admin/reset');
  const health = await call('GET', '/health');
  check('服务在线且事件链完整', health.j.ok === true && health.j.chain.ok === true);

  console.log('\n══════════ 1. 正常全流程：冻结→打印→换料→盘点→质检→放行→证明 ══════════');
  let r = await call('POST', '/api/v1/jobs', jobBody());
  const jid = r.j.jobId;
  check('作业创建成功', !!jid);
  let job = (await call('GET', `/api/v1/jobs/${jid}`)).j;
  check('生成冻结快照哈希', /^[a-f0-9]{64}$/.test(job.snapshotHash), job.snapshotHash);
  const snap1 = job.snapshotHash;

  r = await call('POST', `/api/v1/jobs/${jid}/start`);
  check('作业开始', r.j.job.status === 'PRINTING');

  console.log('\n══════════ 2. 中途换料安全 ══════════');
  // L1 试图使用未声明料卷
  await expectFail('未声明料卷被拒（不得混用未声明材料）', 'POST', `/api/v1/jobs/${jid}/layers`,
    layer(job, 1, { spoolId: 'SP-BLACKMARKET-99' }), 'SPOOL_NOT_DECLARED');

  console.log('\n══════════ 3. 模型版本与快照绑定 ══════════');
  await expectFail('开始后修订模型被拒（模型已冻结）', 'PUT', `/api/v1/jobs/${jid}/model`, jobBody());
  await expectFail('伪造快照哈希的层回执被拒（不同模型版本不得混入）', 'POST', `/api/v1/jobs/${jid}/layers`,
    layer(job, 1, { snapshotHash: 'f'.repeat(64) }), 'SNAPSHOT_MISMATCH');
  await expectFail('校准版本漂移的层回执被拒', 'POST', `/api/v1/jobs/${jid}/layers`,
    layer(job, 1, { calVersion: 'CAL-TAMPERED' }), 'CALIBRATION_CHANGED');

  // 正常上传 L1..L8
  for (let no = 1; no <= 8; no++) {
    const ov = {};
    if (no === 5) Object.assign(ov, { envTempC: 29 }); // 环境超限
    r = await call('POST', `/api/v1/jobs/${jid}/layers`, layer(job, no, ov));
    check(`第 ${no} 层回执接受`, r.status === 200);
  }
  job = (await call('GET', `/api/v1/jobs/${jid}`)).j;
  check('环境超限自动开阻断异常', job.anomalies.some((a) => a.code === 'ENV_OUT_OF_RANGE' && a.status === 'open'));
  const envA = job.anomalies.find((a) => a.code === 'ENV_OUT_OF_RANGE');

  console.log('\n══════════ 4. 重复层回执 ══════════');
  r = await call('POST', `/api/v1/jobs/${jid}/layers`, layer(job, 8));
  check('同层同内容回执幂等（不新增事件）', r.j.idempotent === true);
  await expectFail('同层不同内容回执被拒（重复回执不得覆盖事实）', 'POST', `/api/v1/jobs/${jid}/layers`,
    layer(job, 8, { consumedG: 99 }), 'LAYER_CONFLICT');
  await expectFail('跳层回执被拒（层序必须连续，缺第9层）', 'POST', `/api/v1/jobs/${jid}/layers`,
    layer(job, 10), 'LAYER_GAP');

  console.log('\n══════════ 5. 换料前必须先封存旧卷（余量守恒）══════════');
  await expectFail('未盘点旧卷就切到 L9 新卷被拒', 'POST', `/api/v1/jobs/${jid}/layers`,
    layer(job, 9), 'SWITCH_NOT_CLOSED_OUT');
  await expectFail('未启用的新卷在其层未打完时盘点被拒（L9-12 未上传）', 'POST', `/api/v1/jobs/${jid}/material-closeout`,
    { spoolId: 'SP-IN718-0051', remainingNetG: 600 }, 'CLOSEOUT_EARLY');
  // 先处置环境异常，再模拟真正换料前的盘点：旧卷承担 L1-8 已全部上传
  r = await call('POST', `/api/v1/jobs/${jid}/anomalies/resolve`,
    { anomalyId: envA.anomalyId, decision: 'accepted', reviewer: '李经理', rationale: '短暂温升，层外观与熔合正常' });
  check('环境异常让步接受', r.status === 200);
  r = await call('POST', `/api/v1/jobs/${jid}/material-closeout`,
    { spoolId: 'SP-IN718-0042', remainingNetG: 900.8 }); // 实耗 99.2 vs 申报 99.2
  check('旧卷余量守恒通过', r.j.events.some((e) => e.type === 'material_closed_out'));

  console.log('\n══════════ 6. 断电恢复（校准漂移不得续打）══════════');
  await expectFail('断电后校准版本漂移：拒绝恢复同一快照', 'POST', `/api/v1/jobs/${jid}/power-recovery`,
    { deviceId: 'PRN-METAL-07', calVersion: 'CAL-2026-10-05#NEW' }, 'CALIBRATION_CHANGED');
  r = await call('POST', `/api/v1/jobs/${jid}/power-recovery`,
    { deviceId: 'PRN-METAL-07', calVersion: 'CAL-2026-09-30#11', note: '厂区停电恢复' });
  check('同校准版本断电恢复登记成功（信息性异常，不阻断）', r.j.events.some((e) => e.type === 'power_recovery'));
  job = (await call('GET', `/api/v1/jobs/${jid}`)).j;
  check('恢复记录最后完整层 = 8', job.recoveries.at(-1).lastGoodLayer === 8);

  console.log('\n══════════ 7. 继续打印 L9-12 → 完工 → 质检 ══════════');
  for (let no = 9; no <= 12; no++) {
    r = await call('POST', `/api/v1/jobs/${jid}/layers`, layer(job, no));
    check(`第 ${no} 层（新料卷 0051）回执接受`, r.status === 200);
  }
  // 新卷盘点：申报 49.6g
  r = await call('POST', `/api/v1/jobs/${jid}/material-closeout`,
    { spoolId: 'SP-IN718-0051', remainingNetG: 550.4 });
  check('新卷余量守恒通过', r.j.events.some((e) => e.type === 'material_closed_out'));
  r = await call('POST', `/api/v1/jobs/${jid}/complete`);
  check('作业完工', r.j.job.status === 'COMPLETED');

  await expectFail('未绑质检不能放行', 'POST', `/api/v1/jobs/${jid}/release`, { by: '李经理' }, 'RELEASE_DENIED');
  await expectFail('质检绑定错误快照被拒', 'POST', `/api/v1/jobs/${jid}/qc`,
    { snapshotHash: 'a'.repeat(64), passed: true, inspector: '王工' }, 'SNAPSHOT_MISMATCH');
  r = await call('POST', `/api/v1/jobs/${jid}/qc`,
    { snapshotHash: snap1, passed: true, inspector: '王工', reportId: 'QC-1005-01', method: 'CT+拉伸' });
  check('质检绑定同一快照', r.status === 200);
  await expectFail('质检结果不可重复绑定', 'POST', `/api/v1/jobs/${jid}/qc`,
    { snapshotHash: snap1, passed: false, inspector: '赵工' }, 'QC_EXISTS');

  console.log('\n══════════ 8. 放行 → 成品证明 → 终态唯一 ══════════');
  r = await call('POST', `/api/v1/jobs/${jid}/release`, { by: '质量经理-李工' });
  check('放行成功', r.j.job.status === 'RELEASED');
  const certId = r.j.certificate?.certId;
  check('签发成品证明', !!certId);
  const v = await call('POST', '/api/v1/certificates/verify', { certId });
  check('证明 HMAC 验签通过', v.j.verification.ok === true);
  const cert = (await call('GET', `/api/v1/certificates/${certId}`)).j;
  check('证明绑定 12 层指纹', cert.certificate.layerHashes.length === 12);
  check('证明仅含两个声明批次', cert.certificate.materials.length === 2);
  await expectFail('已放行不可再报废（终态互斥）', 'POST', `/api/v1/jobs/${jid}/scrap`,
    { reason: '反悔' }, 'TERMINAL_CONFLICT');

  console.log('\n══════════ 9. 篡改证明被识破 ══════════');
  const tampered = JSON.parse(JSON.stringify(cert.certificate));
  tampered.materials[0].batchNo = 'B-FORGED-0000';
  const tv = await call('POST', '/api/v1/certificates/verify', { certificate: tampered });
  check('改动材料批次后验签失败', tv.j.verification.ok === false);

  console.log('\n══════════ 10. 事件链防篡改（持久化审计）══════════');
  const chain = await call('GET', '/api/v1/chain');
  check('事件哈希链完整', chain.j.chain.ok === true && chain.j.events > 20, `events=${chain.j.events}`);

  console.log('\n══════════ 11. 报废/放行并发：只留一个终态 ══════════');
  const cid = (await call('POST', '/api/v1/jobs', jobBody({ product: { sku: 'X', name: '并发试验件', qty: 1 } }))).j.jobId;
  await call('POST', `/api/v1/jobs/${cid}/start`);
  const cjob = (await call('GET', `/api/v1/jobs/${cid}`)).j;
  for (let no = 1; no <= 8; no++) await call('POST', `/api/v1/jobs/${cid}/layers`, layer(cjob, no));
  await call('POST', `/api/v1/jobs/${cid}/material-closeout`, { spoolId: 'SP-IN718-0042', remainingNetG: 900.8 });
  for (let no = 9; no <= 12; no++) await call('POST', `/api/v1/jobs/${cid}/layers`, layer(cjob, no));
  await call('POST', `/api/v1/jobs/${cid}/material-closeout`, { spoolId: 'SP-IN718-0051', remainingNetG: 550.4 });
  await call('POST', `/api/v1/jobs/${cid}/complete`);
  await call('POST', `/api/v1/jobs/${cid}/qc`, { snapshotHash: cjob.snapshotHash, passed: true, inspector: '王工' });

  const results = await Promise.all([
    call('POST', `/api/v1/jobs/${cid}/release`, { by: '李经理' }),
    call('POST', `/api/v1/jobs/${cid}/scrap`, { reason: '终态竞争' })
  ]);
  const codes = results.map((x) => x.status);
  const finalJob = (await call('GET', `/api/v1/jobs/${cid}`)).j;
  const oneTerminal = ['RELEASED', 'SCRAPPED'].includes(finalJob.status) &&
    results.filter((x) => x.status === 200).length === 1;
  check(`并发仅一个终态（返回 ${codes.join(' & ')}，最终 ${finalJob.status}）`, oneTerminal);

  console.log('\n══════════ 12. 余量失衡 → 阻断放行 ══════════');
  const bid = (await call('POST', '/api/v1/jobs', jobBody({
    product: { sku: 'Y', name: '守恒失败件', qty: 1 },
    materials: [{ spoolId: 'SP-IN718-0042', batchNo: 'B-IN718-260918-07', material: 'IN718', initialNetG: 1000, fromLayer: 1 }],
    slice: { layerCount: 2, layerHeightMm: 0.06, profile: 'IN718-HIGH-DENSITY' }
  }))).j.jobId;
  await call('POST', `/api/v1/jobs/${bid}/start`);
  let bj = (await call('GET', `/api/v1/jobs/${bid}`)).j;
  await call('POST', `/api/v1/jobs/${bid}/layers`, {
    layerNo: 1, snapshotHash: bj.snapshotHash, deviceId: 'PRN-METAL-07', calVersion: 'CAL-2026-09-30#11',
    spoolId: 'SP-IN718-0042', consumedG: 12.4, extrudedCumG: 12.4, envTempC: 22, envHumidityPct: 42
  });
  await call('POST', `/api/v1/jobs/${bid}/layers`, {
    layerNo: 2, snapshotHash: bj.snapshotHash, deviceId: 'PRN-METAL-07', calVersion: 'CAL-2026-09-30#11',
    spoolId: 'SP-IN718-0042', consumedG: 12.4, extrudedCumG: 24.8, envTempC: 22, envHumidityPct: 42
  });
  // 盘点余量与申报严重不符（少了 200g 去向）
  await call('POST', `/api/v1/jobs/${bid}/material-closeout`, { spoolId: 'SP-IN718-0042', remainingNetG: 775.2 });
  await call('POST', `/api/v1/jobs/${bid}/complete`).catch(() => {});
  bj = (await call('GET', `/api/v1/jobs/${bid}`)).j;
  check('余量失衡自动生成阻断异常', bj.anomalies.some((a) => a.code === 'MATERIAL_BALANCE'));
  const rr = await call('POST', `/api/v1/jobs/${bid}/qc`,
    { snapshotHash: bj.snapshotHash, passed: true, inspector: '王工' }).catch((e) => e);
  const denied = await call('POST', `/api/v1/jobs/${bid}/release`, { by: '李经理' });
  check('余量不守恒时拒绝放行', denied.status === 409 &&
    denied.j.error.details?.some((c) => c.name === 'material_conservation' && !c.ok));

  console.log(`\n══════════ 结果：${pass} 通过，${fail} 失败 ══════════\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
