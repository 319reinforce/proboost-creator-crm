const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { page } = require('./views/layout');
const {
  openDb,
  initDb,
  upsertTaskRun,
  updateTaskRun,
  listTaskRuns,
  recoverStaleSendMailBatches,
} = require('../db');
const { loginInteractively } = require('../automation/session');
const { runReadyFollowupBatch } = require('../automation/reminderRunner');
const { listManifestPaths, readManifest, updateBatchStatus } = require('../sendMailBridge/manifest');
const {
  uploadsDir,
  batchesDir,
  runsDir,
  splitUploadedFile,
  runBatch,
  runPending,
} = require('../sendMailBridge/engine');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

ensureDir(uploadsDir);
ensureDir(batchesDir);
ensureDir(runsDir);
const readyFollowupRunsDir = path.join(config.reportDir, 'ready-followups');
ensureDir(readyFollowupRunsDir);

const upload = multer({
  dest: uploadsDir,
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname) && !file.originalname.startsWith('~$')) cb(null, true);
    else cb(new Error('Only .xlsx files are supported'));
  },
});

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use('/app', express.static(path.join(__dirname, 'public', 'app')));

const webDb = initDb(openDb());
webDb.prepare(`
  UPDATE task_runs
  SET status = 'failed',
      error = COALESCE(NULLIF(error, ''), 'Server restarted before this task finished. Re-run from the UI if needed.'),
      finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
  WHERE status = 'running'
`).run();
function markRecoveredManifestBatches(recovered) {
  const byManifest = new Map();
  for (const batch of recovered) {
    if (!batch.manifestPath) continue;
    if (!byManifest.has(batch.manifestPath)) byManifest.set(batch.manifestPath, []);
    byManifest.get(batch.manifestPath).push(batch.batchNumber);
  }
  for (const [manifestPath, batchNumbers] of byManifest.entries()) {
    const manifest = readManifest(manifestPath);
    if (!manifest) continue;
    let changed = false;
    for (const batchNumber of batchNumbers) {
      const batch = manifest.batches?.find(item => Number(item.batchNumber) === Number(batchNumber));
      if (!batch || !['sending', 'preparing'].includes(batch.status)) continue;
      updateBatchStatus(manifest, batchNumber, 'failed', {
        failedAt: new Date().toISOString(),
        reason: 'runner-heartbeat-timeout',
      });
      changed = true;
    }
    if (changed) writeJson(manifestPath, manifest);
  }
}

const recoveredOnStartup = recoverStaleSendMailBatches(webDb);
markRecoveredManifestBatches(recoveredOnStartup);
if (recoveredOnStartup.length > 0) {
  console.log(`[recovery] marked ${recoveredOnStartup.length} stale send-mail batches as failed`);
}
const activeJobs = new Map();
const eventClients = new Set();

const staleBatchRecovery = setInterval(() => {
  try {
    const recovered = recoverStaleSendMailBatches(webDb);
    markRecoveredManifestBatches(recovered);
    if (recovered.length > 0) {
      console.log(`[recovery] marked ${recovered.length} stale send-mail batches as failed`);
    }
  } catch (error) {
    console.error(`[recovery-error] ${String(error.stack || error.message || error)}`);
  }
}, 60_000);
staleBatchRecovery.unref?.();

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  eventClients.add(res);
  req.on('close', () => {
    eventClients.delete(res);
  });
});

function newJobId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function startJob({ type, manifestPath, batchNumber, templateName, task }) {
  const job = {
    id: newJobId(),
    type,
    manifestPath,
    batchNumber: batchNumber || '',
    templateName,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    error: '',
    result: null,
  };
  activeJobs.set(job.id, job);
  upsertTaskRun(webDb, {
    ...job,
    payload: { manifestPath, batchNumber, templateName },
  });
  broadcastJob(job);
  Promise.resolve()
    .then(() => task(job))
    .then(result => {
      job.status = 'finished';
      job.finishedAt = new Date().toISOString();
      job.result = result || null;
      updateTaskRun(webDb, job.id, {
        status: job.status,
        finishedAt: job.finishedAt,
        result: job.result,
        error: '',
      });
      broadcastJob(job);
    })
    .catch(error => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = String(error.stack || error.message || error);
      updateTaskRun(webDb, job.id, {
        status: job.status,
        finishedAt: job.finishedAt,
        error: job.error,
      });
      broadcastJob(job);
    });
  return job;
}

function broadcastJob(job) {
  const payload = JSON.stringify({
    id: job.id,
    type: job.type,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  });
  for (const res of eventClients) {
    res.write(`event: job\ndata: ${payload}\n\n`);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function fixMojibake(value) {
  const text = String(value || '');
  if (!/[ÃÂäåæçèé]/.test(text)) return text;
  try {
    const fixed = Buffer.from(text, 'latin1').toString('utf8');
    return fixed.includes('�') ? text : fixed;
  } catch {
    return text;
  }
}

function displayPath(value) {
  const fixed = fixMojibake(value);
  return fixed.replace(config.rootDir, '.');
}

function readTail(filePath, maxLines = 18) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listReadyFollowupReports() {
  if (!fs.existsSync(readyFollowupRunsDir)) return [];
  return fs.readdirSync(readyFollowupRunsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const filePath = path.join(readyFollowupRunsDir, name);
      return { filePath, payload: readJson(filePath), mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .filter(item => item.payload)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function recentTaskRuns(type, limit = 8) {
  const persisted = listTaskRuns(webDb, { type, limit });
  const running = [...activeJobs.values()].filter(job => !type || job.type === type);
  const byId = new Map();
  for (const job of [...running, ...persisted]) byId.set(job.id, job);
  return [...byId.values()]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

function hasRunningJob(type) {
  return [...activeJobs.values()].some(job => job.type === type && job.status === 'running');
}

function summarizeLog(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '还没有进程输出。';
  const name = path.basename(filePath);
  if (name.includes('-split.log')) return '拆分工单已完成，等待创建发送工单。';
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const keep = lines.filter(line => {
    if (!line.trim()) return false;
    if (/\|\s*[^@\s]+@/.test(line)) return false;
    return /批次|步骤|上传文件|选中了|已点击|已自动确认|未检测|执行出错|可触达|跳过|完成|登录状态|cookies/.test(line);
  });
  return keep.slice(-8).join('\n') || readTail(filePath, 6);
}

function findLatestLog(campaignName) {
  if (!campaignName || !fs.existsSync(runsDir)) return null;
  const prefix = `${campaignName}-`;
  return fs.readdirSync(runsDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.log'))
    .map(name => {
      const filePath = path.join(runsDir, name);
      return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

function summarizeManifest(manifest) {
  const batches = manifest.batches || [];
  const counts = batches.reduce((acc, batch) => {
    const status = batch.status || 'pending';
    acc[status] = (acc[status] || 0) + 1;
    if (batch.reason === 'success-toast-not-found') acc.confirmedButUnverified += 1;
    if (Number(batch.selectedCount || 0) > 0) acc.selected += Number(batch.selectedCount || 0);
    return acc;
  }, { pending: 0, sent: 0, failed: 0, sending: 0, prepared: 0, preparing: 0, confirmedButUnverified: 0, selected: 0 });
  return {
    total: batches.length,
    totalRows: batches.reduce((sum, batch) => sum + Number(batch.rowCount || 0), 0),
    ...counts,
  };
}

function summarizeSendMailBatchRows(rows) {
  const counts = rows.reduce((acc, batch) => {
    const status = batch.status || 'pending';
    acc[status] = (acc[status] || 0) + 1;
    if (batch.reason === 'success-toast-not-found') acc.confirmedButUnverified += 1;
    if (Number(batch.selected_count || 0) > 0) acc.selected += Number(batch.selected_count || 0);
    return acc;
  }, { pending: 0, sent: 0, failed: 0, sending: 0, prepared: 0, preparing: 0, confirmedButUnverified: 0, selected: 0 });
  return {
    total: rows.length,
    totalRows: rows.reduce((sum, batch) => sum + Number(batch.row_count || 0), 0),
    ...counts,
  };
}

function sendMailSummaryFromSqlite() {
  const campaignCount = webDb.prepare('SELECT COUNT(*) AS count FROM send_mail_campaigns').get();
  const row = webDb.prepare(`
    SELECT
      COUNT(*) AS batches,
      COALESCE(SUM(row_count), 0) AS rows,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'prepared' THEN 1 ELSE 0 END), 0) AS prepared,
      COALESCE(SUM(CASE WHEN status IN ('sending', 'preparing') THEN 1 ELSE 0 END), 0) AS sending,
      COALESCE(SUM(CASE WHEN reason = 'success-toast-not-found' THEN 1 ELSE 0 END), 0) AS unverified,
      COALESCE(SUM(COALESCE(selected_count, 0)), 0) AS selected
    FROM send_mail_batches
  `).get();
  return {
    workOrders: Number(campaignCount?.count || 0),
    batches: Number(row?.batches || 0),
    rows: Number(row?.rows || 0),
    pending: Number(row?.pending || 0),
    sent: Number(row?.sent || 0),
    failed: Number(row?.failed || 0),
    prepared: Number(row?.prepared || 0),
    sending: Number(row?.sending || 0),
    unverified: Number(row?.unverified || 0),
    selected: Number(row?.selected || 0),
  };
}

function sendWorkOrdersPayload(pageNumber = 1) {
  const pageSize = 2;
  const totalRow = webDb.prepare('SELECT COUNT(*) AS count FROM send_mail_campaigns').get();
  const totalItems = Number(totalRow?.count || 0);
  const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
  const currentPage = clampPage(pageNumber, totalPages);
  const campaigns = webDb.prepare(`
    SELECT *
    FROM send_mail_campaigns
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, (currentPage - 1) * pageSize);
  const batchesForCampaign = webDb.prepare(`
    SELECT *
    FROM send_mail_batches
    WHERE send_mail_campaign_id = ?
    ORDER BY batch_number ASC
  `);
  const jobs = recentTaskRuns(null, 50);
  const workOrders = campaigns.map(campaign => {
    const batches = batchesForCampaign.all(campaign.id);
    const summary = summarizeSendMailBatchRows(batches);
    const active = jobs.filter(job => job.manifestPath === campaign.manifest_path && job.status === 'running');
    const latestLog = findLatestLog(campaign.name);
    return {
      id: campaign.id,
      campaignName: fixMojibake(campaign.name),
      sourceFile: displayPath(campaign.input_file || campaign.original_upload || ''),
      manifestPath: displayPath(campaign.manifest_path || ''),
      rawManifestPath: campaign.manifest_path || '',
      status: campaign.status || 'pending',
      summary,
      activeJobs: active.map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
        startedAt: job.startedAt,
      })),
      latestLog: latestLog ? {
        name: fixMojibake(latestLog.name),
        href: `/logs/${encodeURIComponent(latestLog.name)}`,
        summary: summarizeLog(latestLog.filePath),
      } : null,
      batches: batches.map(batch => ({
        id: batch.id,
        batchNumber: batch.batch_number,
        fileName: path.basename(fixMojibake(batch.file_path || '')),
        rowCount: batch.row_count || 0,
        selectedCount: batch.selected_count,
        status: batch.status || 'pending',
        label: statusLabel(batch),
        reason: batch.reason || '',
        attemptCount: batch.attempt_count || 0,
        claimedBy: batch.claimed_by || '',
        lastHeartbeatAt: batch.last_heartbeat_at || '',
      })),
    };
  });
  return {
    page: currentPage,
    pageSize,
    totalItems,
    totalPages,
    summary: sendMailSummaryFromSqlite(),
    workOrders,
  };
}

function statusLabel(batch) {
  const status = batch.status || 'pending';
  if (batch.reason === 'success-toast-not-found') return '已确认待复核';
  if (status === 'pending') return '待发送';
  if (status === 'sending') return '发送中';
  if (status === 'sent') return '已发送';
  if (status === 'failed') return '失败';
  if (status === 'prepared') return '已准备';
  if (status === 'preparing') return '准备中';
  return status;
}

function clampPage(value, totalPages) {
  const page = Number.parseInt(value || '1', 10);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(page, Math.max(totalPages, 1));
}

function renderPagination({ pageNumber, totalPages, totalItems, basePath = '/send' }) {
  if (totalItems <= 2) return '';
  const pages = [];
  for (let page = 1; page <= totalPages; page += 1) {
    pages.push(`<a class="el-pager ${page === pageNumber ? 'is-active' : ''}" href="${basePath}?page=${page}">${page}</a>`);
  }
  const prevClass = pageNumber <= 1 ? 'is-disabled' : '';
  const nextClass = pageNumber >= totalPages ? 'is-disabled' : '';
  const prevHref = pageNumber <= 1 ? `${basePath}?page=${pageNumber}` : `${basePath}?page=${pageNumber - 1}`;
  const nextHref = pageNumber >= totalPages ? `${basePath}?page=${pageNumber}` : `${basePath}?page=${pageNumber + 1}`;
  return `<nav class="el-pagination" aria-label="工单分页">
    <span class="el-pagination__total">共 ${totalItems} 个工单</span>
    <a class="el-page-btn ${prevClass}" href="${prevHref}">上一页</a>
    ${pages.join('')}
    <a class="el-page-btn ${nextClass}" href="${nextHref}">下一页</a>
  </nav>`;
}

function renderWorkOrders(pageNumber = 1) {
  const manifests = listManifestPaths(batchesDir).map(manifestPath => ({
    manifestPath,
    manifest: readManifest(manifestPath),
    mtimeMs: fs.statSync(manifestPath).mtimeMs,
  })).filter(item => item.manifest)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (manifests.length === 0) {
    return '<section><p class="muted">还没有上传和拆分过的 xlsx。</p></section>';
  }

  const pageSize = 2;
  const totalPages = Math.ceil(manifests.length / pageSize);
  const currentPage = clampPage(pageNumber, totalPages);
  const visibleManifests = manifests.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pagination = renderPagination({ pageNumber: currentPage, totalPages, totalItems: manifests.length, basePath: '/send' });

  return `${pagination}${visibleManifests.map(({ manifestPath, manifest }) => {
    const campaignName = manifest.campaignName || path.basename(path.dirname(manifestPath));
    const summary = summarizeManifest(manifest);
    const latestLog = findLatestLog(campaignName);
    const fixedTitle = fixMojibake(campaignName);
    const sourceFile = manifest.inputFile || manifest.originalUpload || '';
    const unverified = summary.confirmedButUnverified;
    const active = recentTaskRuns(null, 50).filter(job => job.manifestPath === manifestPath && job.status === 'running');
    const rows = (manifest.batches || []).map(batch => `
      <tr>
        <td>${escapeHtml(batch.batchNumber)}</td>
        <td>${escapeHtml(path.basename(fixMojibake(batch.file || '')))}</td>
        <td>${escapeHtml(batch.rowCount || 0)}</td>
        <td>${escapeHtml(batch.selectedCount ?? '-')}</td>
        <td><span class="status ${batch.reason === 'success-toast-not-found' ? 'prepared' : escapeHtml(batch.status || '')}">${escapeHtml(statusLabel(batch))}</span></td>
        <td>${escapeHtml(batch.reason || '')}</td>
      </tr>`).join('');

    return `<section class="work-order el-card">
      <div class="work-head">
        <div>
          <h2 class="work-title">${escapeHtml(fixedTitle)}</h2>
          <div class="path">源文件：${escapeHtml(displayPath(sourceFile))}</div>
          <div class="path">Manifest：${escapeHtml(displayPath(manifestPath))}</div>
          <div class="stats">
            <span class="metric"><strong>${summary.total}</strong> 批</span>
            <span class="metric"><strong>${summary.totalRows}</strong> 行</span>
            <span class="metric"><strong>${summary.pending}</strong> 待发送</span>
            <span class="metric"><strong>${summary.sent}</strong> 已发送</span>
            <span class="metric"><strong>${unverified}</strong> 已确认待复核</span>
            <span class="metric"><strong>${summary.selected}</strong> 已选达人</span>
            ${active.length ? `<span class="metric"><strong>${active.length}</strong> 运行中</span>` : ''}
          </div>
        </div>
        <div class="work-actions">
          <form method="post" action="/batch/send-pending">
            <input type="hidden" name="manifestPath" value="${escapeHtml(manifestPath)}" />
            <label style="margin:0 0 8px">
              <span class="muted">模板名</span>
              <input name="templateName" list="template-options" value="0414新规模板" />
            </label>
            <button class="danger" type="submit">创建发送工单</button>
          </form>
        </div>
      </div>
      <div class="work-body">
        ${active.length ? `<div class="status">后台工单运行中，页面会自动刷新。</div>` : ''}
        ${latestLog ? `<div class="muted" style="margin-top:10px">最近进程：<a href="/logs/${encodeURIComponent(latestLog.name)}">${escapeHtml(fixMojibake(latestLog.name))}</a></div>
          <div class="log-tail">${escapeHtml(summarizeLog(latestLog.filePath))}</div>
          <details>
            <summary>查看进程尾部</summary>
            <div class="log-tail">${escapeHtml(readTail(latestLog.filePath, 24))}</div>
          </details>` : '<div class="muted">还没有发送进程日志。</div>'}
        <details>
          <summary>查看批次明细</summary>
          <div class="batch-box">
            <table>
              <thead><tr><th>批次</th><th>文件</th><th>行数</th><th>已选</th><th>状态</th><th>原因</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </details>
      </div>
    </section>`;
  }).join('')}${pagination}`;
}

function actionLabel(action) {
  if (action === 'send_whatsapp_followup') return '有联系方式，发 WhatsApp 跟进模板';
  if (action === 'send_register_followup') return '无联系方式，发注册提醒模板';
  if (action === 'skip_registered') return '已注册，跳过';
  if (action === 'ignore') return '未识别 ready，忽略';
  return action || '-';
}

function renderInboxClassification() {
  const jobs = recentTaskRuns('ready-followup', 5);

  const reports = listReadyFollowupReports().slice(0, 5);
  const latestJob = jobs[0];
  const latestReport = reports[0]?.payload;
  const latest = latestJob?.status === 'running' ? latestJob : latestReport;
  const result = latest?.result || latest;
  const rows = (result?.results || []).slice(0, 40).map(item => {
    const classification = item.classification || {};
    const statusClass = item.status === 'failed' ? 'hard-failed'
      : item.status === 'dry-run' ? 'prepared'
        : item.status === 'ignore' || item.status === 'skip_registered' ? ''
          : item.status;
    return `<tr>
      <td>${escapeHtml(item.sender || '-')}</td>
      <td>${escapeHtml(item.subject || '-')}</td>
      <td><span class="status ${escapeHtml(statusClass)}">${escapeHtml(classification.intent || item.status || '-')}</span></td>
      <td>${escapeHtml(actionLabel(classification.recommendedAction))}</td>
      <td>${escapeHtml((classification.phoneNumbers || []).join(', ') || '-')}</td>
      <td>${escapeHtml((classification.inviteCodes || []).join(', ') || '-')}</td>
      <td>${escapeHtml(item.template || '-')}</td>
      <td>${escapeHtml(item.stage || '-')}</td>
      <td>${escapeHtml(item.threadChars || 0)}</td>
      <td>${escapeHtml(item.error || '-')}</td>
    </tr>`;
  }).join('');

  const summary = result ? `<div class="stats">
    <span class="metric"><strong data-followup-metric="scannedRows">${result.scannedRows || 0}</strong> 列表行</span>
    <span class="metric"><strong data-followup-metric="processed">${result.processed || 0}</strong> 已检查</span>
    <span class="metric"><strong data-followup-metric="opened">${result.opened || 0}</strong> 已点开</span>
    <span class="metric"><strong data-followup-metric="threadRead">${result.threadRead || 0}</strong> 已读正文</span>
    <span class="metric"><strong data-followup-metric="openFailed">${result.openFailed || 0}</strong> 点开失败</span>
    <span class="metric"><strong data-followup-metric="readyCount">${result.readyCount || 0}</strong> ready</span>
    <span class="metric"><strong data-followup-metric="whatsappFollowups">${result.whatsappFollowups || 0}</strong> 联系方式跟进</span>
    <span class="metric"><strong data-followup-metric="registerFollowups">${result.registerFollowups || 0}</strong> 注册提醒</span>
    <span class="metric"><strong data-followup-metric="skippedRegistered">${result.skippedRegistered || 0}</strong> 已注册跳过</span>
  </div>` : '';

  const jobRows = [
    ...jobs,
    ...reports.map(item => item.payload),
  ].slice(0, 8).map(job => `<tr>
    <td>${escapeHtml(job.startedAt)}</td>
    <td><span class="status ${job.status === 'failed' ? 'hard-failed' : job.status === 'finished' ? 'sent' : 'prepared'}">${escapeHtml(job.status)}</span></td>
    <td>${escapeHtml(job.templateName || '-')}</td>
    <td>${escapeHtml(job.finishedAt || '-')}</td>
    <td>${job.error ? `<details><summary>错误</summary><pre>${escapeHtml(job.error)}</pre></details>` : escapeHtml(job.result?.runId || job.runId || '-')}</td>
  </tr>`).join('');

  return `<section id="inbox-classifier">
    <h2>收件箱分类与二次触达</h2>
    <form method="post" action="/inbox/ready-followup">
      <div class="grid">
        <div>
          <label>扫描页数</label>
          <input name="maxPages" type="number" min="1" value="1" />
        </div>
        <div>
          <label>检查封数上限</label>
          <input name="limit" type="number" min="0" value="10" />
        </div>
        <div>
          <label>Ready 关键词</label>
          <input name="readyKeywords" value="ready" />
        </div>
        <div>
          <label>有联系方式模板</label>
          <input name="templateWhatsapp" value="感谢发送联系方式" />
        </div>
        <div>
          <label>无联系方式模板</label>
          <input name="templateRegister" value="督促产品使用" />
        </div>
        <div>
          <label>已注册名单补充</label>
          <input name="registeredNames" placeholder="逗号分隔 handle 或名字" />
        </div>
      </div>
      <p class="muted">默认只 dry-run：打开已回复收件箱、逐封读取正文、判断 ready/联系方式/邀请码，并记录推荐动作。勾选真实发送才会回复邮件。</p>
      <p class="muted">当前登录态：${escapeHtml(config.auth.profilePath)}。如果需要登录，先打开登录窗口，完成登录后窗口会自动关闭并保存登录态。</p>
      <label class="row" style="display:inline-flex; margin:0 12px 0 0">
        <input name="send" type="checkbox" value="1" style="width:auto" />
        真实发送二次触达
      </label>
      <button type="submit">开始检查收件箱</button>
    </form>
    <form method="post" action="/auth/login" style="margin-top:10px">
      <button class="secondary" type="submit">登录并保存 ProBoost 状态</button>
    </form>
    ${latest ? `<details open style="margin-top:16px">
      <summary>最近一次分类结果</summary>
      <div id="followup-summary">${summary}</div>
      <p id="followup-running" class="muted" ${latest.status === 'running' ? '' : 'hidden'}>后台正在检查收件箱，等待实时结果。</p>
      <pre id="followup-error" ${latest.error ? '' : 'hidden'}>${escapeHtml(latest.error || '')}</pre>
      ${rows ? `<div class="batch-box"><table>
        <thead><tr><th>发件人</th><th>主题</th><th>意图</th><th>推荐动作</th><th>联系方式</th><th>邀请码</th><th>模板</th><th>阶段</th><th>正文字符</th><th>错误</th></tr></thead>
        <tbody id="followup-result-rows">${rows}</tbody>
      </table></div>` : '<p class="muted">还没有分类结果。</p>'}
    </details>` : '<p class="muted">还没有运行过收件箱分类。</p>'}
    ${jobRows ? `<details>
      <summary>最近二次触达任务</summary>
      <div class="batch-box"><table>
        <thead><tr><th>开始时间</th><th>状态</th><th>模板</th><th>结束时间</th><th>运行ID/错误</th></tr></thead>
        <tbody id="followup-task-rows">${jobRows}</tbody>
      </table></div>
    </details>` : ''}
  </section>`;
}

function renderSendPage(pageNumber) {
  const dashboardBundle = path.join(__dirname, 'public', 'app', 'assets', 'main.js');
  if (fs.existsSync(dashboardBundle)) {
    return `
      <section>
        <h2>上传并拆分 xlsx</h2>
        <datalist id="template-options">
          <option value="0414新规模板"></option>
          <option value="0421三图模板"></option>
        </datalist>
        <form method="post" action="/upload" enctype="multipart/form-data">
          <div class="grid">
            <div>
              <label>本地 xlsx 文件，可多选</label>
              <input name="files" type="file" accept=".xlsx" multiple required />
            </div>
            <div>
              <label>每批人数</label>
              <input name="batchSize" type="number" min="1" value="200" />
            </div>
            <div>
              <label>任务名前缀</label>
              <input name="campaignPrefix" value="proboost" />
            </div>
          </div>
          <p class="muted">上传后只生成批次和 manifest；不会发送。发送动作需要在下方逐批点击。</p>
          <button type="submit">上传拆分</button>
        </form>
      </section>
      <link rel="stylesheet" href="/app/assets/main.css" />
      <div id="send-root" data-page="${escapeHtml(pageNumber || 1)}"></div>
      <script type="module" src="/app/assets/main.js"></script>
    `;
  }
  return `
    <section>
      <h2>上传并拆分 xlsx</h2>
      <datalist id="template-options">
        <option value="0414新规模板"></option>
        <option value="0421三图模板"></option>
      </datalist>
      <form method="post" action="/upload" enctype="multipart/form-data">
        <div class="grid">
          <div>
            <label>本地 xlsx 文件，可多选</label>
            <input name="files" type="file" accept=".xlsx" multiple required />
          </div>
          <div>
            <label>每批人数</label>
            <input name="batchSize" type="number" min="1" value="200" />
          </div>
          <div>
            <label>任务名前缀</label>
            <input name="campaignPrefix" value="proboost" />
          </div>
        </div>
        <p class="muted">上传后只生成批次和 manifest；不会发送。发送动作需要在下方逐批点击。</p>
        <button type="submit">上传拆分</button>
      </form>
    </section>
    ${renderWorkOrders(pageNumber)}
  `;
}

function renderDashboard() {
  const dashboardBundle = path.join(__dirname, 'public', 'app', 'assets', 'main.js');
  if (!fs.existsSync(dashboardBundle)) {
    return `<section>
      <h2>数据看板前端应用尚未构建</h2>
      <p class="muted">Dashboard 已迁移为 React/Vite 应用。安装前端依赖后运行 <code>npm run web:build</code>，刷新本页即可加载新版看板。</p>
      <pre>${escapeHtml(JSON.stringify(dashboardPayload(), null, 2))}</pre>
    </section>`;
  }
  return `<link rel="stylesheet" href="/app/assets/main.css" />
    <div id="dashboard-root"></div>
    <script type="module" src="/app/assets/main.js"></script>`;
}

function dashboardPayload() {
  const sendSummary = sendMailSummaryFromSqlite();
  const bridgeRows = webDb.prepare(`
    SELECT status, COUNT(*) AS count
    FROM send_logs
    WHERE external_source = 'sendMailBridge'
    GROUP BY status
  `).all();
  const bridgeSummary = bridgeRows.reduce((acc, row) => {
    acc.total += Number(row.count || 0);
    acc[row.status] = Number(row.count || 0);
    return acc;
  }, { total: 0 });
  const sqliteCampaigns = webDb.prepare('SELECT COUNT(*) AS count FROM send_mail_campaigns').get();
  const sqliteBatches = webDb.prepare(`
    SELECT status, COUNT(*) AS count
    FROM send_mail_batches
    GROUP BY status
  `).all();
  const sqliteSummary = sqliteBatches.reduce((acc, row) => {
    acc.batches += Number(row.count || 0);
    acc[row.status] = Number(row.count || 0);
    return acc;
  }, { campaigns: Number(sqliteCampaigns?.count || 0), batches: 0 });
  const reports = listReadyFollowupReports();
  const latest = reports[0]?.payload;
  return {
    sendSummary,
    bridgeSummary,
    bridgeRows: bridgeRows
      .map(row => ({
        status: row.status,
        label: row.status || '-',
        count: Number(row.count || 0),
      }))
      .sort((a, b) => b.count - a.count),
    sqliteSummary,
    latestFollowup: latest ? {
      id: latest.id || '',
      status: latest.status || '',
      startedAt: latest.startedAt || '',
      finishedAt: latest.finishedAt || '',
      error: latest.error || '',
      result: latest.result || null,
    } : null,
    followupRuns: reports.length,
  };
}

function followupSummaryPayload() {
  const jobs = recentTaskRuns('ready-followup', 5);
  const reports = listReadyFollowupReports().slice(0, 5);
  const latestJob = jobs[0];
  const latestReport = reports[0]?.payload;
  const latest = latestJob?.status === 'running' ? latestJob : latestReport;
  const result = latest?.result || null;
  return {
    latest: latest ? {
      id: latest.id || '',
      status: latest.status || '',
      startedAt: latest.startedAt || '',
      finishedAt: latest.finishedAt || '',
      error: latest.error || '',
      templateName: latest.templateName || '',
    } : null,
    result: result ? {
      scannedRows: result.scannedRows || 0,
      processed: result.processed || 0,
      opened: result.opened || 0,
      threadRead: result.threadRead || 0,
      openFailed: result.openFailed || 0,
      readyCount: result.readyCount || 0,
      whatsappFollowups: result.whatsappFollowups || 0,
      registerFollowups: result.registerFollowups || 0,
      skippedRegistered: result.skippedRegistered || 0,
      runId: result.runId || '',
    } : {
      scannedRows: 0,
      processed: 0,
      opened: 0,
      threadRead: 0,
      openFailed: 0,
      readyCount: 0,
      whatsappFollowups: 0,
      registerFollowups: 0,
      skippedRegistered: 0,
      runId: '',
    },
    rows: (result?.results || []).slice(0, 40).map(item => ({
      sender: item.sender || '',
      subject: item.subject || '',
      status: item.status || '',
      stage: item.stage || '',
      template: item.template || '',
      threadChars: item.threadChars || 0,
      error: item.error || '',
      classification: item.classification || {},
    })),
    tasks: [
      ...jobs,
      ...reports.map(item => item.payload),
    ].slice(0, 8).map(job => ({
      id: job.id || '',
      status: job.status || '',
      startedAt: job.startedAt || '',
      finishedAt: job.finishedAt || '',
      templateName: job.templateName || '',
      runId: job.result?.runId || job.runId || '',
      error: job.error || '',
    })),
  };
}

app.get('/', (_req, res) => {
  res.redirect(302, '/send');
});

app.get('/api/followup-summary', (_req, res) => {
  res.json(followupSummaryPayload());
});

app.get('/api/dashboard', (_req, res) => {
  res.json(dashboardPayload());
});

app.get('/api/send-work-orders', (req, res) => {
  const pageNumber = Number.parseInt(req.query.page || '1', 10);
  res.json(sendWorkOrdersPayload(pageNumber));
});

app.get('/send', (req, res) => {
  const pageNumber = Number.parseInt(req.query.page || '1', 10);
  res.send(page('发信 - ProBoost Creator CRM', renderSendPage(pageNumber), 'send'));
});

app.get('/followup', (_req, res) => {
  res.send(page('二次触达 - ProBoost Creator CRM', renderInboxClassification(), 'followup'));
});

app.get('/dashboard', (_req, res) => {
  res.send(page('数据看板 - ProBoost Creator CRM', renderDashboard(), 'dashboard'));
});

app.post('/upload', upload.array('files', 20), async (req, res, next) => {
  try {
    const files = req.files || [];
    const prefix = String(req.body.campaignPrefix || 'proboost').trim();
    const batchSize = Number(req.body.batchSize || 200);
    const results = [];
    for (const file of files) {
      const originalName = fixMojibake(file.originalname);
      const original = path.join(uploadsDir, `${Date.now()}-${originalName}`);
      fs.renameSync(file.path, original);
      const campaignName = `${prefix}_${Date.now()}_${path.basename(originalName, '.xlsx')}`;
      results.push(await splitUploadedFile(original, { batchSize, campaignName }));
    }
    res.send(page('上传完成', `
      <section>
        <h2>上传拆分完成</h2>
        <pre>${JSON.stringify(results.map(item => ({
          campaignName: fixMojibake(item.campaignName),
          batchCount: item.manifest.batchCount,
          totalRows: item.manifest.totalRows,
          manifestPath: item.manifestPath,
        })), null, 2)}</pre>
        <a class="button" href="/send">返回发信</a>
      </section>
    `));
  } catch (error) {
    next(error);
  }
});

function readyFollowupOptionsFromBody(body) {
  return {
    maxPages: body.maxPages || '1',
    limit: body.limit || '10',
    readyKeywords: body.readyKeywords || 'ready',
    registeredNames: body.registeredNames || '',
    templateWhatsapp: body.templateWhatsapp || '感谢发送联系方式',
    templateRegister: body.templateRegister || '督促产品使用',
    send: body.send === '1' || body.send === 'on',
    keepOpen: false,
    headless: false,
    signupLink: body.signupLink || config.defaultSignupLink,
    expiresIn: body.expiresIn || config.defaultExpiresIn,
    bonusAmount: body.bonusAmount || config.defaultBonusAmount,
  };
}

app.post('/inbox/ready-followup', async (req, res, next) => {
  try {
    const options = readyFollowupOptionsFromBody(req.body);
    const reportOptions = { ...options, send: Boolean(options.send) };
    const reportId = `ready-followup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const reportPath = path.join(readyFollowupRunsDir, `${reportId}.json`);
    if (hasRunningJob('auth-login')) {
      writeJson(reportPath, {
        id: reportId,
        status: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        templateName: `${options.templateWhatsapp} / ${options.templateRegister}`,
        options: reportOptions,
        result: null,
        error: 'ProBoost 登录窗口仍在运行。请先在打开的窗口完成登录，等窗口自动关闭并保存登录态后，再开始检查收件箱。',
      });
      res.redirect(303, '/followup#inbox-classifier');
      return;
    }
    startJob({
      type: 'ready-followup',
      templateName: `${options.templateWhatsapp} / ${options.templateRegister}`,
      task: async () => {
        const startedAt = new Date().toISOString();
        const writeReport = (payload) => writeJson(reportPath, {
          id: reportId,
          status: payload.status,
          startedAt,
          finishedAt: payload.finishedAt || '',
          templateName: `${options.templateWhatsapp} / ${options.templateRegister}`,
          options: reportOptions,
          result: payload.result || null,
          error: payload.error || '',
        });
        writeReport({ status: 'running' });
        const db = openDb();
        let lastProgress = null;
        try {
          initDb(db);
          const result = await runReadyFollowupBatch(db, {
            ...options,
            onProgress: progress => {
              lastProgress = progress;
              writeReport({
                status: 'running',
                result: progress,
              });
            },
          });
          writeReport({
            status: 'finished',
            finishedAt: new Date().toISOString(),
            result,
            error: '',
          });
          return result;
        } catch (error) {
          writeReport({
            status: 'failed',
            finishedAt: new Date().toISOString(),
            result: lastProgress,
            error: String(error.stack || error.message || error),
          });
          throw error;
        } finally {
          db.close();
        }
      },
    });
    res.redirect(303, '/followup#inbox-classifier');
  } catch (error) {
    next(error);
  }
});

app.post('/auth/login', async (_req, res, next) => {
  try {
    if (hasRunningJob('auth-login')) {
      res.redirect(303, '/followup#inbox-classifier');
      return;
    }
    startJob({
      type: 'auth-login',
      templateName: 'ProBoost login',
      task: () => loginInteractively({ keepOpen: false, headless: false }),
    });
    res.redirect(303, '/followup#inbox-classifier');
  } catch (error) {
    next(error);
  }
});

function runOptionsFromBody(body, prepareOnly) {
  return {
    prepareOnly,
    templateName: body.templateName || process.env.TEMPLATE_NAME || '0414新规模板',
    keepOpen: Boolean(prepareOnly),
    closeAfterSend: false,
    verifySendRecord: false,
  };
}

app.post('/batch/prepare', async (req, res, next) => {
  try {
    const options = runOptionsFromBody(req.body, true);
    startJob({
      type: 'prepare',
      manifestPath: req.body.manifestPath,
      batchNumber: req.body.batchNumber,
      templateName: options.templateName,
      task: job => runBatch(req.body.manifestPath, req.body.batchNumber, {
        ...options,
        taskRunId: job.id,
        claimedBy: `web:${job.id}`,
      }),
    });
    res.redirect(303, '/send');
  } catch (error) {
    next(error);
  }
});

app.post('/batch/send', async (req, res, next) => {
  try {
    const options = runOptionsFromBody(req.body, false);
    startJob({
      type: 'send-one',
      manifestPath: req.body.manifestPath,
      batchNumber: req.body.batchNumber,
      templateName: options.templateName,
      task: job => runBatch(req.body.manifestPath, req.body.batchNumber, {
        ...options,
        taskRunId: job.id,
        claimedBy: `web:${job.id}`,
      }),
    });
    res.redirect(303, '/send');
  } catch (error) {
    next(error);
  }
});

app.post('/batch/send-pending', async (req, res, next) => {
  try {
    const options = runOptionsFromBody(req.body, false);
    startJob({
      type: 'send-pending',
      manifestPath: req.body.manifestPath,
      templateName: options.templateName,
      task: job => runPending(req.body.manifestPath, {
        ...options,
        taskRunId: job.id,
        claimedBy: `web:${job.id}`,
      }),
    });
    res.redirect(303, '/send');
  } catch (error) {
    next(error);
  }
});

app.get('/logs', (_req, res) => {
  const logs = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter(name => name.endsWith('.log')).sort().reverse()
    : [];
  const list = logs.slice(0, 80).map(name => `<tr><td>${escapeHtml(fixMojibake(name))}</td><td><a class="button secondary" href="/logs/${encodeURIComponent(name)}">查看</a></td></tr>`).join('');
  res.send(page('日志', `<section><h2>运行日志</h2><table><tbody>${list}</tbody></table></section>`, ''));
});

app.get('/logs/:name', (req, res) => {
  const logPath = path.join(runsDir, req.params.name);
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'log not found';
  res.send(page('日志详情', `<section><h2>${escapeHtml(fixMojibake(req.params.name))}</h2><pre>${escapeHtml(text)}</pre></section>`, ''));
});

app.use((error, _req, res, _next) => {
  res.status(500).send(page('错误', `
    <section>
      <h2>执行出错</h2>
      <pre>${String(error.stack || error.message).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>
      <a class="button" href="/send">返回发信</a>
    </section>
  `));
});

const port = Number(process.env.PORT || 8794);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`ProBoost Creator CRM review UI: http://127.0.0.1:${port}`);
});
server.on('error', error => {
  console.error(error.stack || error.message || error);
});
