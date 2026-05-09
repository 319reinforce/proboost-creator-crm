const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const {
  openDb,
  initDb,
  upsertSendMailCampaignFromManifest,
  claimSendMailBatch,
  claimPendingSendMailBatches,
  heartbeatSendMailBatches,
  failClaimedSendMailBatches,
} = require('../db');
const { readManifest, writeJson, updateBatchStatus } = require('./manifest');
const { syncManifestToCrm } = require('./syncToCrm');
const { ownedAutoScript, prepareRuntimeAutoScript } = require('./runtimeScript');
const { splitCreators } = require('./splitCreators');

const uploadsDir = path.join(config.rootDir, 'data', 'uploads');
const batchesDir = path.join(config.rootDir, 'data', 'send-mail-batches');
const runsDir = path.join(config.rootDir, 'reports', 'send-mail-runs');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function slugify(value) {
  return String(value || 'campaign')
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'campaign';
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function fallbackTaskRunId(type) {
  return `${type}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function runNode(script, env, logFile, options = {}) {
  ensureDir(path.dirname(logFile));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      cwd: path.dirname(script),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    const heartbeat = typeof options.onHeartbeat === 'function'
      ? setInterval(() => {
        try {
          options.onHeartbeat();
        } catch (error) {
          fs.appendFileSync(logFile, `\n[heartbeat-error] ${String(error.stack || error.message || error)}\n`);
        }
      }, Number(options.heartbeatIntervalMs || 60_000))
      : null;
    if (heartbeat) {
      heartbeat.unref?.();
      options.onHeartbeat();
    }
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.on('error', error => {
      if (heartbeat) clearInterval(heartbeat);
      reject(error);
    });
    child.on('exit', code => {
      if (heartbeat) clearInterval(heartbeat);
      stream.end();
      if (code === 0) resolve({ code, logFile });
      else reject(new Error(`${path.basename(script)} exited with code ${code}; log=${logFile}`));
    });
  });
}

function withDb(callback) {
  const db = openDb();
  try {
    initDb(db);
    return callback(db);
  } finally {
    db.close();
  }
}

function trySyncManifest(manifestPath, logFile) {
  try {
    const result = syncManifestToCrm({ manifestPath, logFile });
    fs.appendFileSync(logFile, `\n[crm-sync] ${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const message = String(error.stack || error.message || error);
    fs.appendFileSync(logFile, `\n[crm-sync-error] ${message}\n`);
    return { error: message };
  }
}

function tryUpsertManifestState(manifestPath, manifest, logFile) {
  try {
    const result = withDb(db => upsertSendMailCampaignFromManifest(db, { manifestPath, manifest, logFile }));
    if (logFile) fs.appendFileSync(logFile, `\n[db-sync] ${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const message = String(error.stack || error.message || error);
    if (logFile) fs.appendFileSync(logFile, `\n[db-sync-error] ${message}\n`);
    return { error: message };
  }
}

function markManifestBatchesFailed(manifestPath, batchNumbers, reason) {
  const manifest = readManifest(manifestPath);
  if (!manifest || !Array.isArray(manifest.batches)) return manifest;
  const numbers = new Set(batchNumbers.map(Number));
  let changed = false;
  for (const batch of manifest.batches) {
    if (!numbers.has(Number(batch.batchNumber))) continue;
    if (!['sending', 'preparing'].includes(batch.status)) continue;
    updateBatchStatus(manifest, batch.batchNumber, 'failed', {
      failedAt: new Date().toISOString(),
      reason,
    });
    changed = true;
  }
  if (changed) writeJson(manifestPath, manifest);
  return manifest;
}

async function splitUploadedFile(filePath, options = {}) {
  ensureDir(batchesDir);
  const batchSize = Number(options.batchSize || 200);
  const campaignName = options.campaignName || `${timestamp()}_${slugify(path.basename(filePath))}`;
  const outputDir = path.join(batchesDir, campaignName);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const logFile = path.join(runsDir, `${campaignName}-split.log`);

  ensureDir(runsDir);
  const splitResult = splitCreators({
    inputFile: filePath,
    outputDir,
    batchSize,
    manifestPath,
  });
  fs.writeFileSync(logFile, `${splitResult.log}\n`);

  const manifest = splitResult.manifest;
  manifest.campaignName = campaignName;
  manifest.originalUpload = filePath;
  manifest.splitLog = logFile;
  writeJson(manifestPath, manifest);
  tryUpsertManifestState(manifestPath, manifest, logFile);

  return { campaignName, outputDir, manifestPath, manifest, logFile };
}

async function runBatch(manifestPath, batchNumber, options = {}) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`manifest not found: ${manifestPath}`);
  tryUpsertManifestState(manifestPath, manifest, null);
  const taskRunId = options.taskRunId || fallbackTaskRunId('send-mail-batch');
  const claimedBy = options.claimedBy || `pid:${process.pid}`;
  const claim = withDb(db => claimSendMailBatch(db, {
    manifestPath,
    batchNumber,
    taskRunId,
    claimedBy,
    prepareOnly: options.prepareOnly,
  }));
  if (!claim.claimed) {
    throw new Error(`batch ${batchNumber} was not claimed: ${claim.reason}`);
  }
  const batch = manifest.batches.find(item => item.batchNumber === Number(batchNumber));
  if (!batch) throw new Error(`batch not found: ${batchNumber}`);

  updateBatchStatus(manifest, batchNumber, options.prepareOnly ? 'preparing' : 'sending', {
    startedAt: new Date().toISOString(),
  });
  writeJson(manifestPath, manifest);

  const runName = `${path.basename(path.dirname(manifestPath))}-batch-${batchNumber}-${options.prepareOnly ? 'prepare' : 'send'}-${timestamp()}`;
  const logFile = path.join(runsDir, `${runName}.log`);

  const env = {
    XLSX_FILE: batch.file,
    TEMPLATE_NAME: options.templateName || '0414新规模板',
    PREPARE_ONLY: options.prepareOnly ? '1' : '0',
    KEEP_BROWSER_OPEN: options.keepOpen ? '1' : '0',
    MANIFEST_PATH: manifestPath,
    BATCH_NUMBER: String(batchNumber),
    CLOSE_AFTER_SEND: options.closeAfterSend ? '1' : '0',
    VERIFY_SEND_RECORD: options.verifySendRecord ? '1' : '0',
    WAIT_AFTER_IMPORT: String(options.waitAfterImport || 12000),
    PAGE_SIZE: String(options.pageSize || 500),
  };

  const runnableAutoScript = prepareRuntimeAutoScript(ownedAutoScript);
  const heartbeat = () => withDb(db => heartbeatSendMailBatches(db, {
    taskRunId,
    batchNumbers: [Number(batchNumber)],
  }));
  try {
    await runNode(runnableAutoScript, env, logFile, { onHeartbeat: heartbeat });
  } catch (error) {
    const latestAfterFailure = markManifestBatchesFailed(manifestPath, [Number(batchNumber)], 'runner-exited-nonzero');
    if (latestAfterFailure) tryUpsertManifestState(manifestPath, latestAfterFailure, logFile);
    withDb(db => failClaimedSendMailBatches(db, {
      taskRunId,
      batchNumbers: [Number(batchNumber)],
      reason: 'runner-exited-nonzero',
    }));
    throw error;
  }
  const crmSync = trySyncManifest(manifestPath, logFile);
  const latest = readManifest(manifestPath);
  const dbSync = latest ? tryUpsertManifestState(manifestPath, latest, logFile) : null;
  return {
    manifestPath,
    batchNumber: Number(batchNumber),
    manifest: latest,
    logFile,
    crmSync,
    dbSync,
  };
}

async function runPending(manifestPath, options = {}) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`manifest not found: ${manifestPath}`);
  tryUpsertManifestState(manifestPath, manifest, null);
  const taskRunId = options.taskRunId || fallbackTaskRunId('send-mail-pending');
  const claimedBy = options.claimedBy || `pid:${process.pid}`;
  const claim = withDb(db => claimPendingSendMailBatches(db, {
    manifestPath,
    taskRunId,
    claimedBy,
  }));
  const claimedNumbers = claim.claimed.map(batch => batch.batchNumber);
  if (claimedNumbers.length === 0) {
    if (claim.reason) throw new Error(`pending batches were not claimed: ${claim.reason}`);
    return [];
  }
  const pending = manifest.batches
    .filter(batch => claimedNumbers.includes(Number(batch.batchNumber)))
    .sort((a, b) => a.batchNumber - b.batchNumber);

  const runName = `${path.basename(path.dirname(manifestPath))}-pending-${timestamp()}`;
  const logFile = path.join(runsDir, `${runName}.log`);
  const batchList = pending.map(batch => batch.batchNumber).join(',');

  const env = {
    XLSX_FILE: pending[0].file,
    TEMPLATE_NAME: options.templateName || '0414新规模板',
    BATCH_LIST: batchList,
    MANIFEST_PATH: manifestPath,
    KEEP_BROWSER_OPEN: options.keepOpen ? '1' : '0',
    CLOSE_AFTER_SEND: options.closeAfterSend ? '1' : '0',
    VERIFY_SEND_RECORD: options.verifySendRecord ? '1' : '0',
    WAIT_AFTER_IMPORT: String(options.waitAfterImport || 12000),
    PAGE_SIZE: String(options.pageSize || 500),
  };

  const runnableAutoScript = prepareRuntimeAutoScript(ownedAutoScript);
  const heartbeat = () => withDb(db => heartbeatSendMailBatches(db, {
    taskRunId,
    batchNumbers: claimedNumbers,
  }));
  try {
    await runNode(runnableAutoScript, env, logFile, { onHeartbeat: heartbeat });
  } catch (error) {
    const latestAfterFailure = markManifestBatchesFailed(manifestPath, claimedNumbers, 'runner-exited-nonzero');
    if (latestAfterFailure) tryUpsertManifestState(manifestPath, latestAfterFailure, logFile);
    withDb(db => failClaimedSendMailBatches(db, {
      taskRunId,
      batchNumbers: claimedNumbers,
      reason: 'runner-exited-nonzero',
    }));
    throw error;
  }
  const crmSync = trySyncManifest(manifestPath, logFile);
  const latest = readManifest(manifestPath);
  const dbSync = latest ? tryUpsertManifestState(manifestPath, latest, logFile) : null;
  return pending.map(batch => ({
    manifestPath,
    batchNumber: batch.batchNumber,
    logFile,
    manifest: latest,
    crmSync,
    dbSync,
  }));
}

module.exports = {
  uploadsDir,
  batchesDir,
  runsDir,
  splitUploadedFile,
  runBatch,
  runPending,
};
