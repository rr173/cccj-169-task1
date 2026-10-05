// app.js — 作业列表 / 作业详情 / 层追踪 / 放行闸门 / 命令控制台
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (h, n = 14) => h ? String(h).slice(0, n) + '…' : '—';

let jobs = [], selected = null, pollTimer = null;

const api = {
  async req(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(url, opt);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error?.message || r.statusText), { status: r.status, data });
    return data;
  },
  get: (u) => api.req('GET', u),
  post: (u, b) => api.req('POST', u, b ?? {})
};

// ── 命令模板（对话框预填）──
const templates = {
  create: {
    title: '新建打印作业（创建即冻结快照）',
    hint: '模型摘要 / 切片参数 / 校准版本 / 材料批次 / 环境范围将在创建时冻结并生成 snapshotHash。中途换料必须在 materials 中以 fromLayer 预声明。',
    body: {
      product: { sku: 'BRK-AX-204', name: '航空支架 AX-204', qty: 1 },
      deviceId: 'PRN-METAL-07', operator: '张工',
      model: {
        file: 'ax204_v3.step', fileHash: 'a3f9c1e77b024d8ea41d5f66c90b7e18',
        sourceVersion: 'CAD r2026-09-28/AX204#3', triangles: 184200,
        bboxMm: { x: 120, y: 88, z: 46 }
      },
      slice: { layerCount: 12, layerHeightMm: 0.06, profile: 'IN718-HIGH-DENSITY', infillPct: 100, nozzleTempC: 1080, bedTempC: 200 },
      calibration: { calVersion: 'CAL-2026-09-30#11', bedLevel: 0.02, eSteps: 412.6, calibratedAt: '2026-09-30' },
      envRange: { tempMinC: 18, tempMaxC: 26, humidityMinPct: 30, humidityMaxPct: 55 },
      materials: [
        { spoolId: 'SP-IN718-0042', batchNo: 'B-IN718-260918-07', material: 'Inconel 718', initialNetG: 1000, fromLayer: 1 },
        { spoolId: 'SP-IN718-0051', batchNo: 'B-IN718-260925-03', material: 'Inconel 718', initialNetG: 600, fromLayer: 9, reason: '计划中途换料：0042 卷预计余量不足' }
      ]
    }
  },
  start: { title: '开始打印', body: {} },
  layer: {
    title: '设备上传层回执',
    hint: '设备逐层 POST。snapshotHash 必须等于作业冻结哈希；spoolId 必须等于该层计划料卷；挤出累计增量必须等于申报消耗。',
    body: {
      layerNo: 1, snapshotHash: '__SNAP__', deviceId: 'PRN-METAL-07', calVersion: 'CAL-2026-09-30#11',
      spoolId: '__SPOOL__', consumedG: 12.4, extrudedCumG: 12.4, envTempC: 22.5, envHumidityPct: 42
    }
  },
  power: {
    title: '登记断电恢复',
    hint: '设备断电后续打：calVersion 必须仍与冻结快照一致，否则拒绝续打。最后完整层自动从层记录推导。',
    body: { deviceId: 'PRN-METAL-07', calVersion: 'CAL-2026-09-30#11', note: '厂区短暂停电后恢复' }
  },
  anomaly: {
    title: '上报过程异常',
    body: { code: 'NOZZLE_PRESSURE_DRIFT', severity: 'warn', blocking: true, layerNo: 4, message: '喷嘴压力出现轻微漂移', evidence: { deltaBar: 0.4 } }
  },
  resolve: {
    title: '处置异常（接受 / 驳回）',
    hint: 'accepted=让步接收并解除阻断；rejected=驳回（继续阻断放行）。',
    body: { anomalyId: '__ANOM__', decision: 'accepted', reviewer: '质量经理-李工', rationale: '漂移在工艺允许窗口内' }
  },
  closeout: {
    title: '料卷余量盘点（守恒核对）',
    hint: '实耗 = initialNetG - remainingNetG，须与层申报消耗合计在容差（0.5%投料或5g取大）内。换料前必须先封存旧卷。',
    body: { spoolId: '__SPOOL__', remainingNetG: 900 }
  },
  complete: { title: '完工（层记录完整 + 全部料卷盘点后）', body: {} },
  qc: {
    title: '绑定质检结果',
    hint: '质检必须声明同一 snapshotHash；不合格可直接报废。',
    body: { snapshotHash: '__SNAP__', passed: true, inspector: '质检-王工', reportId: 'QC-2026-1005-01', method: 'CT+拉伸', measurements: { densityPct: 99.7, raUm: 3.2 } }
  },
  release: { title: '执行放行闸门评估并放行', body: { by: '质量经理-李工' } },
  scrap: { title: '报废（与放行互斥，终态唯一）', body: { reason: '示例：内部缺陷超标', by: '质量经理-李工' } },
  revise: { title: '修订模型（仅 DRAFT 允许，开始打印后冻结）', hint: '提交完整作业定义，相当于替换冻结前草案。', body: {} }
};

// ── 对话框状态机 ──
let dlgCtx = null;
const ui = {
  async load() {
    const [jl, chain] = await Promise.all([api.get('/api/v1/jobs'), api.get('/api/v1/chain')]);
    jobs = jl.jobs;
    $('#chainState').textContent = chain.chain.ok ? '完整 ✓' : '断裂 ✗';
    $('#chainState').style.color = chain.chain.ok ? 'var(--ok)' : 'var(--err)';
    $('#chainCount').textContent = chain.events;
    renderList();
    if (selected) await renderDetail(selected);
  },
  openDlg(kind, extra) {
    const t = templates[kind];
    dlgCtx = { kind, ...extra };
    $('#dlgTitle').textContent = t.title;
    $('#dlgHint').textContent = t.hint || '';
    let body = JSON.parse(JSON.stringify(t.body));
    if (extra?.job) {
      const j = extra.job;
      body = JSON.parse(JSON.stringify(t.body), (k, v) => {
        if (v === '__SNAP__') return j.snapshotHash;
        if (v === '__SPOOL__') return j._nextSpool || j.snapshot.materials[0].spoolId;
        return v;
      });
      if (kind === 'layer') {
        body.layerNo = j.layers.length + 1;
        const active = j.snapshot.materials.filter((m) => m.fromLayer <= body.layerNo).pop();
        body.spoolId = active.spoolId;
        body.extrudedCumG = j.layers.length ? +(j.layers[j.layers.length - 1].extrudedCumG + body.consumedG).toFixed(2) : body.consumedG;
      }
      if (kind === 'resolve' && extra.anomalyId) body.anomalyId = extra.anomalyId;
    }
    if (kind === 'revise' && extra?.job) body = { /* 提示走新作业 */ };
    $('#dlgBody').value = JSON.stringify(body, null, 2);
    $('#dlg').showModal();
  },
  closeDlg() { $('#dlg').close(); },
  async sendDlg() {
    const { kind, jobId } = dlgCtx;
    let body;
    try { body = JSON.parse($('#dlgBody').value); }
    catch { return toast('JSON 格式错误', false); }
    try {
      const map = {
        create: ['POST', '/api/v1/jobs'],
        start: ['POST', `/api/v1/jobs/${jobId}/start`],
        layer: ['POST', `/api/v1/jobs/${jobId}/layers`],
        power: ['POST', `/api/v1/jobs/${jobId}/power-recovery`],
        anomaly: ['POST', `/api/v1/jobs/${jobId}/anomalies`],
        resolve: ['POST', `/api/v1/jobs/${jobId}/anomalies/resolve`],
        closeout: ['POST', `/api/v1/jobs/${jobId}/material-closeout`],
        complete: ['POST', `/api/v1/jobs/${jobId}/complete`],
        qc: ['POST', `/api/v1/jobs/${jobId}/qc`],
        release: ['POST', `/api/v1/jobs/${jobId}/release`],
        scrap: ['POST', `/api/v1/jobs/${jobId}/scrap`]
      };
      if (kind === 'revise') return toast('作业一旦开始打印即冻结；请基于新模型创建新作业（新建作业按钮）。', false);
      const [method, url] = map[kind];
      const out = await api.req(method, url, body);
      this.closeDlg();
      if (out.jobId && kind === 'create') selected = out.jobId;
      toast(kind === 'release' && out.certificate
        ? `✅ 已放行，证明编号 ${out.certificate.certId}`
        : out.idempotent ? '重复回执：内容一致，幂等忽略（未产生新事件）' : '命令已接受并写入事件链', true);
      await this.load();
    } catch (e) {
      toast(`[${e.status}] ${e.message}${e.data?.error?.details ? '\n' + JSON.stringify(e.data.error.details) : ''}`, false);
    }
  }
};

// ── 列表 ──
function renderList() {
  if (!jobs.length) { $('#jobList').innerHTML = '<div class="dim">暂无作业，点击「新建冻结作业」</div>'; return; }
  $('#jobList').innerHTML = jobs.map((j) => `
    <div class="jobrow ${j.jobId === selected ? 'sel' : ''}" onclick="selectJob('${j.jobId}')">
      <div class="top">
        <div>
          <div class="name">${esc(j.product.name)}</div>
          <div class="pid">${j.jobId}</div>
        </div>
        <span class="badge b-${j.status}">${j.status}</span>
      </div>
      <div class="meta">层 ${j.layers} · 料卷 ${j.materialCloseouts} · 质检 ${j.qcPassed === null ? '未绑定' : j.qcPassed ? '合格' : '不合格'}</div>
    </div>`).join('');
}
async function selectJob(id) { selected = id; await ui.load(); }

// ── 详情 ──
async function renderDetail(id) {
  let job;
  try { job = (await api.get(`/api/v1/jobs/${id}`)); }
  catch { $('#detail').innerHTML = '<div class="panel dim">作业不存在</div>'; return; }
  const s = job.snapshot;
  const pct = Math.round(job.layers.length / s.slice.layerCount * 100);
  const activeLayer = job.layers.length + 1;
  const nextSpool = s.materials.filter((m) => m.fromLayer <= activeLayer).pop()?.spoolId || s.materials[0].spoolId;
  job._nextSpool = nextSpool;
  window.__job = job;

  const running = ['PRINTING', 'RECOVERING'].includes(job.status);
  const certs = await api.get(`/api/v1/jobs/${job.jobId}/certificate`).catch(() => ({ certificates: [] }));

  $('#detail').innerHTML = `
    <div class="panel">
      <h2>作业概览 — ${esc(s.product.name)} <span class="badge b-${job.status}">${job.status}</span></h2>
      <div class="grid2">
        <div class="kv"><span class="k">作业号</span><span class="v">${job.jobId}</span></div>
        <div class="kv"><span class="k">设备</span><span class="v">${esc(s.deviceId)}</span></div>
        <div class="kv"><span class="k">快照哈希</span><span class="v" style="color:var(--acc)">${job.snapshotHash}</span></div>
        <div class="kv"><span class="k">模型版本</span><span class="v">${esc(s.model.sourceVersion)}</span></div>
        <div class="kv"><span class="k">模型哈希</span><span class="v">${short(s.model.fileHash, 22)}</span></div>
        <div class="kv"><span class="k">校准版本</span><span class="v">${esc(s.calibration.calVersion)}</span></div>
        <div class="kv"><span class="k">切片档案</span><span class="v">${esc(s.slice.profile)} · ${s.slice.layerCount} 层 @ ${s.slice.layerHeightMm}mm</span></div>
        <div class="kv"><span class="k">环境范围</span><span class="v">${s.envRange.tempMinC}-${s.envRange.tempMaxC}°C / ${s.envRange.humidityMinPct}-${s.envRange.humidityMaxPct}%</span></div>
      </div>
      ${job.modelRevisions?.length ? `<div class="dim" style="margin-top:6px">打印前模型修订 ${job.modelRevisions.length} 次（开始后冻结）</div>` : ''}
    </div>

    <div class="panel">
      <h2>放行闸门（${job.gates.allowed ? '<span class="ok">全部通过</span>' : '<span class="bad">未通过</span>'}）</h2>
      ${job.gates.checks.map((c) => `
        <div class="gate">
          <span class="ico ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✔' : '✘'}</span>
          <span>${gateName(c.name)}</span>
          ${c.reason ? `<span class="why">— ${esc(c.reason)}</span>` : ''}
        </div>`).join('')}
    </div>

    <div class="panel">
      <h2>命令控制台</h2>
      <div class="toolbar">
        ${job.status === 'DRAFT' ? `
          <button class="primary" onclick="ui.openDlg('start',{jobId,job})">▶ 开始打印</button>
          <button onclick="ui.openDlg('revise',{jobId,job})">修订模型(仅开始前)</button>` : ''}
        ${running ? `
          <button onclick="ui.openDlg('layer',{jobId,job})">上传层回执 (下一层 #${job.layers.length + 1}, 料卷 ${nextSpool})</button>
          <button onclick="ui.openDlg('power',{jobId,job})">⚡ 断电恢复</button>
          <button onclick="ui.openDlg('anomaly',{jobId,job})">上报异常</button>
          <button onclick="ui.openDlg('closeout',{jobId,job})">料卷盘点</button>
          <button class="primary" onclick="ui.openDlg('complete',{jobId,job})">完工</button>` : ''}
        ${job.status === 'COMPLETED' && !job.qc ? `<button onclick="ui.openDlg('qc',{jobId,job})">绑定质检</button>` : ''}
        ${job.status === 'COMPLETED' ? `<button class="primary" onclick="ui.openDlg('release',{jobId,job})">✔ 评估并放行</button>` : ''}
        ${!['RELEASED', 'SCRAPPED'].includes(job.status) ? `<button class="danger" onclick="ui.openDlg('scrap',{jobId,job})">报废</button>` : ''}
      </div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="dim">层进度 ${job.layers.length}/${s.slice.layerCount}（${pct}%）· 断电恢复 ${job.recoveries.length} 次</div>
    </div>

    <div class="panel">
      <h2>层记录（设备按层上传）</h2>
      <div class="layers"><table>
        <thead><tr><th>#</th><th>料卷 / 批次</th><th>申报消耗g</th><th>挤出累计g</th><th>温度°C</th><th>湿度%</th><th>环境</th><th>回执指纹</th></tr></thead>
        <tbody>${renderLayers(job)}</tbody>
      </table></div>
    </div>

    <div class="panel">
      <h2>材料批次与余量守恒</h2>
      <table><thead><tr><th>料卷</th><th>批次</th><th>起始层</th><th>投料g</th><th>盘点余量g</th><th>申报消耗g</th><th>实耗g</th><th>偏差g</th><th>守恒</th></tr></thead>
      <tbody>${Object.values(job.materialSegments).map((m) => `
        <tr>
          <td class="mono">${m.spoolId}</td><td class="mono">${m.batchNo}</td><td>${m.fromLayer}</td>
          <td>${m.initialNetG}</td>
          <td>${m.remainingNetG ?? '—'}</td>
          <td>${m.declaredConsumedG ?? m.layers.reduce((x, l) => x + l.consumedG, 0).toFixed(2)}</td>
          <td>${m.consumedMeasured ?? '—'}</td>
          <td class="${m.varianceG == null ? 'dim' : Math.abs(m.varianceG) <= m.toleranceG ? 'ok' : 'bad'}">${m.varianceG ?? '—'}${m.toleranceG != null ? ` /±${m.toleranceG}` : ''}</td>
          <td>${m.closedOutAt ? (m.balanced ? '<span class="pill p-ok">守恒</span>' : '<span class="pill p-bad">失衡</span>') : '<span class="dim">未盘点</span>'}</td>
        </tr>`).join('')}</tbody></table>
    </div>

    <div class="panel">
      <h2>异常与处置（${job.anomalies.length}）</h2>
      ${job.anomalies.length ? job.anomalies.map((a) => `
        <div class="gate">
          <span class="pill p-${a.severity}">${a.severity}</span>
          <span class="pill p-${a.status}">${a.status === 'open' ? (a.blocking ? '待处置·阻断' : '待处置') : a.status === 'accepted' ? '让步接受' : '驳回'}</span>
          <span><b>${esc(a.code)}</b> ${a.layerNo ? `@L${a.layerNo}` : ''} — ${esc(a.message)}</span>
          ${a.status === 'open' ? `<button style="margin-left:auto" onclick="ui.openDlg('resolve',{jobId,job,anomalyId:'${a.anomalyId}'})">处置</button>` : ''}
        </div>`).join('') : '<div class="dim">无异常</div>'}
      ${job.qc ? `<div class="gate" style="margin-top:8px"><span class="pill p-${job.qc.passed ? 'ok' : 'bad'}">质检${job.qc.passed ? '合格' : '不合格'}</span><span>${esc(job.qc.inspector)} · ${esc(job.qc.reportId || '')} · 快照 ${short(job.qc.snapshotHash)}</span></div>` : ''}
    </div>

    ${certs.certificates?.length ? `<div class="panel"><h2>成品证明</h2>${certs.certificates.map((c) => `
      <div class="certbox">
        <div class="kv"><span class="k">证明编号</span><span class="v"><a href="/c/${c.certId}">${c.certId}</a></span></div>
        <div class="kv"><span class="k">签发时间</span><span class="v">${c.issuedAt}</span></div>
        <div class="kv"><span class="k">签名</span><span class="v">${short(c.signature, 30)}</span></div>
        <div class="dim">证明与层指纹、材料批次、质检、放行闸门结果绑定，HMAC-SHA256 防篡改。</div>
      </div>`).join('')}</div>` : ''}
  `;
}

function renderLayers(job) {
  return job.layers.map((l) => `
    <tr>
      <td>${l.layerNo}</td>
      <td class="mono">${l.spoolId}<br><span class="dim">${l.batchNo}</span></td>
      <td>${l.consumedG}</td><td>${l.extrudedCumG}</td>
      <td>${l.envTempC}</td><td>${l.envHumidityPct}</td>
      <td>${l.envOutOfRange ? '<span class="pill p-bad">超限</span>' : '<span class="pill p-ok">范围内</span>'}</td>
      <td class="mono dim">${short(l.payloadSig, 12)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="dim">尚无层记录</td></tr>';
}
function gateName(n) {
  return {
    state_completed: '作业已完工', layers_complete: '层记录完整', layers_contiguous: '层序连续',
    all_closeout: '全部料卷已余量盘点', material_conservation: '材料余量守恒',
    declared_materials_only: '仅使用声明材料/批次', single_snapshot: '层记录绑定同一作业快照',
    no_open_blocking_anomaly: '无未处置阻断异常', no_rejected_anomaly: '无被驳回异常',
    qc_bound: '质检结果已绑定', qc_passed: '质检合格', qc_same_snapshot: '质检绑定同一快照'
  }[n] || n;
}

function toast(msg, ok) {
  const el = document.createElement('div');
  el.className = `toast ${ok ? 'ok' : 'err'}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// 初始化 + 2 秒轮询
ui.load();
pollTimer = setInterval(() => { if (!$('#dlg').open) ui.load(); }, 2000);
