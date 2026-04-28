const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const { splitScript, autoScript } = require('./paths');
const { readManifest, writeJson, updateBatchStatus } = require('./manifest');

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

function runNode(script, env, logFile) {
  ensureDir(path.dirname(logFile));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      cwd: path.dirname(script),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.on('error', reject);
    child.on('exit', code => {
      stream.end();
      if (code === 0) resolve({ code, logFile });
      else reject(new Error(`${path.basename(script)} exited with code ${code}; log=${logFile}`));
    });
  });
}

async function splitUploadedFile(filePath, options = {}) {
  ensureDir(batchesDir);
  const batchSize = Number(options.batchSize || 200);
  const campaignName = options.campaignName || `${timestamp()}_${slugify(path.basename(filePath))}`;
  const outputDir = path.join(batchesDir, campaignName);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const logFile = path.join(runsDir, `${campaignName}-split.log`);

  await runNode(splitScript, {
    INPUT_FILE: filePath,
    OUTPUT_DIR: outputDir,
    BATCH_SIZE: String(batchSize),
    MANIFEST_PATH: manifestPath,
  }, logFile);

  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`manifest not found after split: ${manifestPath}`);
  manifest.campaignName = campaignName;
  manifest.originalUpload = filePath;
  manifest.splitLog = logFile;
  writeJson(manifestPath, manifest);

  return { campaignName, outputDir, manifestPath, manifest, logFile };
}

async function runBatch(manifestPath, batchNumber, options = {}) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`manifest not found: ${manifestPath}`);
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

  await runNode(autoScript, env, logFile);
  return {
    manifestPath,
    batchNumber: Number(batchNumber),
    manifest: readManifest(manifestPath),
    logFile,
  };
}

async function runPending(manifestPath, options = {}) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`manifest not found: ${manifestPath}`);
  const pending = manifest.batches
    .filter(batch => batch.status === 'pending')
    .sort((a, b) => a.batchNumber - b.batchNumber);
  if (pending.length === 0) return [];

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

  await runNode(autoScript, env, logFile);
  const latest = readManifest(manifestPath);
  return pending.map(batch => ({
    manifestPath,
    batchNumber: batch.batchNumber,
    logFile,
    manifest: latest,
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
