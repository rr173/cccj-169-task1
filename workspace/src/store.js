// store.js — 仅追加事件日志、哈希链、状态重放投影与作业级串行锁
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, sha256, decide, verifyEventChain, evalRelease, buildCertificate, signCertificate } from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const CERTS_FILE = path.join(DATA_DIR, 'certs.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '');

// ── 签名密钥（部署后应通过 KMS/环境变量注入；此处首次启动生成）──
let secret = process.env.CERT_SECRET;
if (!secret) {
  if (fs.existsSync(SECRET_FILE)) {
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    secret = sha256(`am-cert-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  }
}

// ── 载入事件链并校验完整性 ──
let events = [];
function load() {
  const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
  events = lines.map((l) => JSON.parse(l));
  if (events.length) {
    const v = verifyEventChain(events);
    if (!v.ok) throw new Error(`事件链校验失败：${v.reason}`);
  }
}
load();

let certs = [];
if (fs.existsSync(CERTS_FILE)) certs = JSON.parse(fs.readFileSync(CERTS_FILE, 'utf8'));

// ── 投影：事件 -> 作业当前状态 ──
function project(evs) {
  const jobs = new Map();
  for (const e of evs) {
    const d = e.data || {};
    switch (e.type) {
      case 'job_created': {
        const segments = {};
        for (const m of d.snapshot.materials)
          segments[m.spoolId] = {
            spoolId: m.spoolId, batchNo: m.batchNo, material: m.material,
            initialNetG: m.initialNetG, fromLayer: m.fromLayer,
            layers: [], closedOutAt: null, remainingNetG: null,
            consumedMeasured: null, declaredConsumedG: null,
            varianceG: null, toleranceG: null, balanced: null
          };
        jobs.set(e.jobId, {
          jobId: e.jobId,
          status: 'DRAFT',
          product: d.product, operator: d.operator, notes: d.notes,
          snapshot: d.snapshot, snapshotHash: d.snapshotHash,
          modelRevisions: [],
          createdAt: e.at, startedAt: null, completedAt: null,
          layers: [], materialSegments: segments, anomalies: [],
          recoveries: [], qc: null,
          releasedAt: null, releaseBy: null, scrappedAt: null, scrapReason: null
        });
        break;
      }
      case 'model_revised': {
        const j = jobs.get(e.jobId);
        j.modelRevisions.push({ at: e.at, oldHash: j.snapshotHash, newHash: d.snapshotHash });
        Object.assign(j, {
          product: d.product, operator: d.operator ?? j.operator, notes: d.notes ?? j.notes
        });
        j.snapshot = d.snapshot;
        j.snapshotHash = d.snapshotHash;
        break;
      }
      case 'job_started': {
        const j = jobs.get(e.jobId);
        j.status = 'PRINTING';
        j.startedAt = e.at;
        break;
      }
      case 'layer_recorded': {
        const j = jobs.get(e.jobId);
        j.layers.push({ ...d });
        j.materialSegments[d.spoolId].layers.push({ ...d });
        break;
      }
      case 'anomaly_reported':
        jobs.get(e.jobId).anomalies.push({ ...d });
        break;
      case 'power_recovery': {
        const j = jobs.get(e.jobId);
        j.status = 'RECOVERING';
        j.recoveries.push({ at: e.at, ...d });
        break;
      }
      case 'anomaly_resolved': {
        const a = jobs.get(e.jobId).anomalies.find((x) => x.anomalyId === d.anomalyId);
        a.status = d.decision === 'accepted' ? 'accepted' : 'rejected';
        a.resolvedAt = e.at;
        a.resolution = { reviewer: d.reviewer, rationale: d.rationale };
        break;
      }
      case 'material_closed_out': {
        const s = jobs.get(e.jobId).materialSegments[d.spoolId];
        Object.assign(s, {
          closedOutAt: e.at, remainingNetG: d.remainingNetG,
          consumedMeasured: d.consumedMeasured, declaredConsumedG: d.declaredConsumedG,
          varianceG: d.varianceG, toleranceG: d.toleranceG, balanced: d.balanced
        });
        break;
      }
      case 'job_completed': {
        const j = jobs.get(e.jobId);
        j.status = 'COMPLETED';
        j.completedAt = e.at;
        break;
      }
      case 'qc_recorded': {
        const j = jobs.get(e.jobId);
        j.qc = { at: e.at, ...d };
        break;
      }
      case 'job_released': {
        const j = jobs.get(e.jobId);
        j.status = 'RELEASED';
        j.releasedAt = e.at;
        j.releaseBy = d.by || null;
        break;
      }
      case 'job_scrapped': {
        const j = jobs.get(e.jobId);
        j.status = 'SCRAPPED';
        j.scrappedAt = e.at;
        j.scrapReason = d.reason;
        break;
      }
    }
  }
  return jobs;
}

// ── 持久化追加（哈希链）──
function append(evs) {
  let prev = events.length ? events[events.length - 1].hash : 'GENESIS';
  let seq = events.length;
  const lines = [];
  for (const ev of evs) {
    const hash = sha256(`${seq}|${ev.jobId}|${ev.type}|${canon(ev.data)}|${ev.at}|${prev}`);
    const full = { seq, ...ev, prevHash: prev, hash };
    events.push(full);
    lines.push(JSON.stringify(full));
    prev = hash;
    seq++;
  }
  fs.appendFileSync(EVENTS_FILE, lines.join('\n') + '\n');
}

function saveCerts() {
  const tmp = `${CERTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(certs, null, 2));
  fs.renameSync(tmp, CERTS_FILE);
}

// ── 每作业串行锁：报废与放行在同一队列里裁决，终态只可能有一个 ──
const chains = new Map();
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  chains.set(key, run.catch(() => {})); // 队列不因拒绝而断裂
  return run;
}

export function commit(cmd) {
  const evs = decide({ getJob }, cmd);
  let cert = null;
  if (cmd.type === 'release_job' && evs.length) {
    const jobBefore = getJob(cmd.jobId);
    const gates = evalRelease(jobBefore);
    cert = buildCertificate(jobBefore, gates);
    cert.releaseBy = cmd.body?.by || null;
    cert.signature = signCertificate(secret, cert);
  }
  if (evs.length) append(evs);
  if (cert) {
    certs.push(cert);
    saveCerts();
  }
  return { events: evs, cert };
}

export function getJob(jobId) {
  return project(events).get(jobId) || null;
}
export function listJobs() {
  return [...project(events).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function getCert(certId) {
  return certs.find((c) => c.certId === certId) || null;
}
export function certByJob(jobId) {
  return certs.filter((c) => c.jobId === jobId);
}
export function listCerts() {
  return [...certs].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}
export { secret as certSecret };
export function chainInfo() {
  return verifyEventChain(events);
}
export function eventCount() {
  return events.length;
}

// 演示/测试用：清空全部持久化状态
export function resetAll() {
  events = [];
  certs = [];
  fs.writeFileSync(EVENTS_FILE, '');
  saveCerts();
}
