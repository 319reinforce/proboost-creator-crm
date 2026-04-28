const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { listManifestPaths, readManifest } = require('../sendMailBridge/manifest');
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

const activeJobs = new Map();

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
  };
  activeJobs.set(job.id, job);
  Promise.resolve()
    .then(task)
    .then(() => {
      job.status = 'finished';
      job.finishedAt = new Date().toISOString();
    })
    .catch(error => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = String(error.stack || error.message || error);
    });
  return job;
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

function renderPagination({ pageNumber, totalPages, totalItems }) {
  if (totalItems <= 2) return '';
  const pages = [];
  for (let page = 1; page <= totalPages; page += 1) {
    pages.push(`<a class="el-pager ${page === pageNumber ? 'is-active' : ''}" href="/?page=${page}">${page}</a>`);
  }
  const prevClass = pageNumber <= 1 ? 'is-disabled' : '';
  const nextClass = pageNumber >= totalPages ? 'is-disabled' : '';
  const prevHref = pageNumber <= 1 ? `/?page=${pageNumber}` : `/?page=${pageNumber - 1}`;
  const nextHref = pageNumber >= totalPages ? `/?page=${pageNumber}` : `/?page=${pageNumber + 1}`;
  return `<nav class="el-pagination" aria-label="工单分页">
    <span class="el-pagination__total">共 ${totalItems} 个工单</span>
    <a class="el-page-btn ${prevClass}" href="${prevHref}">上一页</a>
    ${pages.join('')}
    <a class="el-page-btn ${nextClass}" href="${nextHref}">下一页</a>
  </nav>`;
}

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="20" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --el-color-primary:#409eff; --el-color-primary-dark-2:#337ecc; --el-color-danger:#f56c6c; --el-color-success:#67c23a; --el-color-warning:#e6a23c; --el-color-info:#909399; --el-text-color-primary:#303133; --el-text-color-regular:#606266; --el-text-color-secondary:#909399; --el-border-color:#dcdfe6; --el-border-color-light:#e4e7ed; --el-fill-color-blank:#fff; --el-fill-color-light:#f5f7fa; --el-bg-color-page:#f2f3f5; --el-border-radius-base:4px; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Helvetica Neue, Helvetica, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif; color:var(--el-text-color-primary); background:var(--el-bg-color-page); font-size:14px; }
    header { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 24px; background:var(--el-fill-color-blank); border-bottom:1px solid var(--el-border-color-light); }
    h1 { margin:0; font-size:18px; font-weight:600; }
    main { max-width:1160px; margin:0 auto; padding:20px 24px 32px; }
    section, .el-card { background:var(--el-fill-color-blank); border:1px solid var(--el-border-color-light); border-radius:var(--el-border-radius-base); box-shadow:0 1px 2px rgba(0,0,0,.04); margin-bottom:16px; }
    section { padding:18px; }
    h2 { margin:0 0 16px; font-size:15px; font-weight:600; }
    label { display:block; font-size:13px; color:var(--el-text-color-regular); margin:8px 0 6px; }
    input, select { width:100%; border:1px solid var(--el-border-color); border-radius:var(--el-border-radius-base); padding:8px 11px; font-size:14px; line-height:20px; background:#fff; color:var(--el-text-color-primary); outline:none; transition:border-color .2s; }
    input:focus, select:focus { border-color:var(--el-color-primary); }
    input[type=file] { padding:8px; }
    button, .button { display:inline-flex; align-items:center; justify-content:center; min-height:32px; padding:8px 15px; border:1px solid var(--el-color-primary); border-radius:var(--el-border-radius-base); background:var(--el-color-primary); color:#fff; font-weight:500; text-decoration:none; cursor:pointer; line-height:1; }
    button.secondary, .button.secondary { background:#fff; color:var(--el-color-primary); }
    button.danger { background:var(--el-color-danger); border-color:var(--el-color-danger); }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { text-align:left; border-bottom:1px solid var(--el-border-color-light); padding:10px 8px; vertical-align:top; }
    th { color:var(--el-text-color-regular); font-weight:600; background:var(--el-fill-color-light); }
    .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:16px; }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .muted { color:var(--el-text-color-secondary); }
    .work-order { padding:0; overflow:hidden; }
    .work-head { display:grid; grid-template-columns: minmax(0, 1fr) 260px; gap:16px; padding:18px 20px; background:#fff; border-bottom:1px solid var(--el-border-color-light); }
    .work-title { margin:0; font-size:15px; font-weight:600; overflow-wrap:anywhere; }
    .path { margin-top:6px; color:var(--el-text-color-secondary); font-size:12px; overflow-wrap:anywhere; }
    .stats { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    .metric, .el-tag { display:inline-flex; align-items:center; height:28px; padding:0 9px; border:1px solid #d9ecff; border-radius:4px; background:#ecf5ff; color:#409eff; font-size:12px; }
    .metric strong { font-size:13px; color:#337ecc; margin-right:4px; }
    .work-actions { min-width:260px; }
    .work-body { padding:16px 20px 18px; background:#fff; }
    details { border-top:1px solid var(--el-border-color-light); margin-top:12px; padding-top:12px; }
    summary { cursor:pointer; color:var(--el-color-primary); font-weight:500; list-style:none; }
    summary::before { content:"▶"; margin-right:6px; font-size:10px; }
    details[open] summary::before { content:"▼"; }
    .batch-box { max-height:300px; overflow:auto; border:1px solid var(--el-border-color-light); border-radius:4px; margin-top:10px; }
    .log-tail { margin-top:10px; background:#111827; color:#e5e7eb; border-radius:4px; padding:12px; max-height:180px; overflow:auto; font-size:12px; white-space:pre-wrap; }
    .status { display:inline-flex; align-items:center; height:24px; padding:0 8px; border-radius:4px; background:#ecf5ff; color:#409eff; font-size:12px; }
    .status.sent { background:#f0f9eb; color:var(--el-color-success); }
    .status.failed { background:#fdf6ec; color:var(--el-color-warning); }
    .status.hard-failed { background:#fef0f0; color:var(--el-color-danger); }
    .status.prepared { background:#fdf6ec; color:var(--el-color-warning); }
    .el-pagination { display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:4px 0 20px; color:var(--el-text-color-regular); }
    .el-pagination__total { margin-right:8px; color:var(--el-text-color-regular); }
    .el-page-btn, .el-pager { min-width:32px; height:32px; display:inline-flex; align-items:center; justify-content:center; padding:0 8px; border-radius:4px; color:var(--el-text-color-primary); text-decoration:none; background:transparent; font-weight:500; }
    .el-pager.is-active { color:var(--el-color-primary); }
    .el-page-btn.is-disabled { color:#c0c4cc; pointer-events:none; }
    pre { white-space:pre-wrap; background:#0f172a; color:#e5e7eb; padding:14px; border-radius:8px; overflow:auto; max-height:520px; }
    @media (max-width: 760px) {
      header { padding:0 16px; }
      main { padding:14px; }
      .grid, .work-head { grid-template-columns:1fr; }
      .work-actions { min-width:0; }
    }
  </style>
</head>
<body>
  <header>
    <h1>ProBoost Creator CRM</h1>
    <nav class="row">
      <a class="button secondary" href="/">审核台</a>
      <a class="button secondary" href="/logs">日志</a>
    </nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
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
  const pagination = renderPagination({ pageNumber: currentPage, totalPages, totalItems: manifests.length });

  return `${pagination}${visibleManifests.map(({ manifestPath, manifest }) => {
    const campaignName = manifest.campaignName || path.basename(path.dirname(manifestPath));
    const summary = summarizeManifest(manifest);
    const latestLog = findLatestLog(campaignName);
    const fixedTitle = fixMojibake(campaignName);
    const sourceFile = manifest.inputFile || manifest.originalUpload || '';
    const unverified = summary.confirmedButUnverified;
    const active = [...activeJobs.values()].filter(job => job.manifestPath === manifestPath && job.status === 'running');
    const rows = (manifest.batches || []).map(batch => `
      <tr>
        <td>${escapeHtml(batch.batchNumber)}</td>
        <td>${escapeHtml(path.basename(fixMojibake(batch.file || '')))}</td>
        <td>${escapeHtml(batch.rowCount || 0)}</td>
        <td>${escapeHtml(batch.selectedCount ?? '-')}</td>
        <td><span class="status ${batch.reason === 'success-toast-not-found' ? 'failed' : escapeHtml(batch.status || '')}">${escapeHtml(statusLabel(batch))}</span></td>
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

app.get('/', (req, res) => {
  const pageNumber = Number.parseInt(req.query.page || '1', 10);
  res.send(page('ProBoost Creator CRM', `
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
  `));
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
        <a class="button" href="/">返回审核台</a>
      </section>
    `));
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
      task: () => runBatch(req.body.manifestPath, req.body.batchNumber, options),
    });
    res.redirect(303, '/');
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
      task: () => runBatch(req.body.manifestPath, req.body.batchNumber, options),
    });
    res.redirect(303, '/');
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
      task: () => runPending(req.body.manifestPath, options),
    });
    res.redirect(303, '/');
  } catch (error) {
    next(error);
  }
});

app.get('/logs', (_req, res) => {
  const logs = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter(name => name.endsWith('.log')).sort().reverse()
    : [];
  const list = logs.slice(0, 80).map(name => `<tr><td>${escapeHtml(fixMojibake(name))}</td><td><a class="button secondary" href="/logs/${encodeURIComponent(name)}">查看</a></td></tr>`).join('');
  res.send(page('日志', `<section><h2>运行日志</h2><table><tbody>${list}</tbody></table></section>`));
});

app.get('/logs/:name', (req, res) => {
  const logPath = path.join(runsDir, req.params.name);
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'log not found';
  res.send(page('日志详情', `<section><h2>${escapeHtml(fixMojibake(req.params.name))}</h2><pre>${escapeHtml(text)}</pre></section>`));
});

app.use((error, _req, res, _next) => {
  res.status(500).send(page('错误', `
    <section>
      <h2>执行出错</h2>
      <pre>${String(error.stack || error.message).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>
      <a class="button" href="/">返回审核台</a>
    </section>
  `));
});

const port = Number(process.env.PORT || 8787);
app.listen(port, '127.0.0.1', () => {
  console.log(`ProBoost Creator CRM review UI: http://127.0.0.1:${port}`);
});
