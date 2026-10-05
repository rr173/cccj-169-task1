// server.js — HTTP API + 静态页面（仅 Node 内置模块）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiError
} from './domain.js';
import * as store from './store.js';
import { evalRelease, verifyCertificate } from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 8080);

// ── 路由表 ──
const routes = [];
const R = (method, re, handler) => routes.push({ method, re, handler });

// 作业生命周期
R('POST', /^\/api\/v1\/jobs$/, async (_m, body) =>
  mutate(null, { type: 'create_job', body }));
R('GET', /^\/api\/v1\/jobs$/, () => ({
  jobs: store.listJobs().map(summary)
}));
R('GET', /^\/api\/v1\/jobs\/([^/]+)$/, ([id]) => {
  const job = getOr404(id);
  return { ...job, gates: evalRelease(job) };
});
R('GET', /^\/api\/v1\/jobs\/([^/]+)\/gates$/, ([id]) => evalRelease(getOr404(id)));
R('GET', /^\/api\/v1\/jobs\/([^/]+)\/certificate$/, ([id]) => {
  const certs = store.certByJob(id);
  if (!certs.length) throw new ApiError(404, 'NO_CERTIFICATE', '该作业尚无放行证明');
  return { certificates: certs };
});

R('PUT', /^\/api\/v1\/jobs\/([^/]+)\/model$/, ([id], body) =>
  mutate(id, { type: 'revise_model', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/start$/, ([id]) =>
  mutate(id, { type: 'start_job', jobId: id }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/layers$/, ([id], body) =>
  mutate(id, { type: 'record_layer', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/anomalies$/, ([id], body) =>
  mutate(id, { type: 'report_anomaly', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/anomalies\/resolve$/, ([id], body) =>
  mutate(id, { type: 'resolve_anomaly', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/power-recovery$/, ([id], body) =>
  mutate(id, { type: 'power_recovery', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/material-closeout$/, ([id], body) =>
  mutate(id, { type: 'material_closeout', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/complete$/, ([id]) =>
  mutate(id, { type: 'complete_job', jobId: id }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/qc$/, ([id], body) =>
  mutate(id, { type: 'record_qc', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/scrap$/, ([id], body) =>
  mutate(id, { type: 'scrap_job', jobId: id, body }));
R('POST', /^\/api\/v1\/jobs\/([^/]+)\/release$/, ([id], body) =>
  mutate(id, { type: 'release_job', jobId: id, body }));

// 成品证明
R('GET', /^\/api\/v1\/certificates$/, () => ({ certificates: store.listCerts() }));
R('GET', /^\/api\/v1\/certificates\/([^/]+)$/, ([id]) => {
  const cert = store.getCert(id);
  if (!cert) throw new ApiError(404, 'NOT_FOUND', '证明不存在');
  return { certificate: cert, verification: verifyCertificate(store.certSecret, cert) };
});
R('POST', /^\/api\/v1\/certificates\/verify$/, (_m, body) => {
  if (!body || (!body.certificate && !body.certId))
    throw new ApiError(422, 'VERIFY_FIELDS', '请提供 certificate 对象或 certId');
  const cert = body.certId ? store.getCert(body.certId) : body.certificate;
  if (!cert) throw new ApiError(404, 'NOT_FOUND', '证明不存在');
  return { verification: verifyCertificate(store.certSecret, cert), certId: cert.certId };
});

// 审计链 / 健康
R('GET', /^\/api\/v1\/chain$/, () => ({ chain: store.chainInfo(), events: store.eventCount() }));
R('GET', /^\/health$/, () => ({ ok: true, chain: store.chainInfo() }));
R('POST', /^\/api\/v1\/admin\/reset$/, () => {
  store.resetAll();
  return { reset: true };
});

// 所有改变状态的命令在作业级锁内串行裁决
async function mutate(jobId, cmd) {
  const run = () => {
    const { events, cert } = store.commit(cmd);
    if (cmd.type === 'create_job') {
      const id = events[0].jobId;
      return { jobId: id, job: store.getJob(id), accepted: true };
    }
    return {
      accepted: true,
      idempotent: events.length === 0,
      events: events.map((e) => ({ type: e.type, at: e.at })),
      job: store.getJob(cmd.jobId),
      ...(cert ? { certificate: cert } : {})
    };
  };
  return jobId ? store.withLock(jobId, run) : run();
}

function getOr404(id) {
  const j = store.getJob(id);
  if (!j) throw new ApiError(404, 'NOT_FOUND', `作业 ${id} 不存在`);
  return j;
}
function summary(j) {
  return {
    jobId: j.jobId, status: j.status,
    product: j.product, deviceId: j.snapshot.deviceId,
    snapshotHash: j.snapshotHash,
    layers: `${j.layers.length}/${j.snapshot.slice.layerCount}`,
    materialCloseouts: Object.values(j.materialSegments).filter((s) => s.closedOutAt).length +
      '/' + Object.keys(j.materialSegments).length,
    qcPassed: j.qc ? j.qc.passed : null,
    createdAt: j.createdAt, completedAt: j.completedAt
  };
}

// ── HTTP 传输层 ──
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // API
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new ApiError(404, 'NOT_FOUND', '路由不存在');
      const body = await readJson(req);
      const result = await route.handler(url.pathname.match(route.re).slice(1), body);
      return send(res, 200, result);
    }
    // 静态页面
    return serveStatic(res, url.pathname);
  } catch (err) {
    if (err instanceof ApiError)
      return send(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
    console.error(err);
    return send(res, 500, { error: { code: 'INTERNAL', message: err.message } });
  }
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new ApiError(413, 'TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new ApiError(400, 'BAD_JSON', 'JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}
function serveStatic(res, p) {
  let file = p === '/' ? '/index.html' : p;
  if (file.startsWith('/c/')) file = '/cert.html'; // /c/:certId
  const fp = path.normalize(path.join(PUBLIC, file));
  if (!fp.startsWith(PUBLIC + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

server.listen(PORT, () => {
  console.log(`▸ 三维打印批次追溯与放行平台 http://localhost:${PORT}`);
  console.log(`  数据目录: ${store.DATA_DIR}`);
  console.log(`  事件链 ${store.chainInfo().ok ? '完整' : '异常'}，已记录 ${store.eventCount()} 条事件`);
});
