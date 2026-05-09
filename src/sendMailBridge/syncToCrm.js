const path = require('path');
const { openDb, initDb, upsertExternalSendLog } = require('../db');
const { readManifest } = require('./manifest');

const EXTERNAL_SOURCE = 'sendMailBridge';

function buildExternalId(manifestPath, batch) {
  return [
    path.resolve(manifestPath),
    `batch=${batch.batchNumber || ''}`,
    `file=${batch.file || batch.inputFile || ''}`,
  ].join('|');
}

function normalizeBridgeStatus(batch = {}) {
  const status = String(batch.status || 'pending');
  const reason = String(batch.reason || '');
  const selectedCount = Number(batch.selectedCount || 0);

  if (/processsingleton|singletonlock|profile.*use|profile.*occupied/i.test(reason)) {
    return 'profile-occupied';
  }
  if (reason === 'success-toast-not-found') {
    return 'send-confirmed-verify-missed';
  }
  if (reason === 'import-zero-reachable'
    || reason === 'dedup-zero-remaining'
    || reason === 'send-confirm-zero'
    || (selectedCount === 0 && ['sent', 'failed'].includes(status))) {
    return 'skipped-no-reachable-contact';
  }
  if (status === 'sent') return 'sent';
  if (status === 'failed') return 'failed';
  return null;
}

function batchTimestamp(batch = {}, normalizedStatus) {
  if (normalizedStatus === 'sent' || normalizedStatus === 'send-confirmed-verify-missed') {
    return batch.sentAt || batch.updatedAt || new Date().toISOString();
  }
  return batch.sentAt || null;
}

function buildPayload({ manifestPath, manifest, batch, normalizedStatus, logFile }) {
  return {
    manifestPath: path.resolve(manifestPath),
    campaignName: manifest.campaignName || path.basename(path.dirname(manifestPath)),
    originalUpload: manifest.originalUpload || manifest.inputFile || '',
    batchNumber: batch.batchNumber || null,
    batchFile: batch.file || batch.inputFile || '',
    rowCount: batch.rowCount || 0,
    selectedCount: batch.selectedCount == null ? null : batch.selectedCount,
    bridgeStatus: batch.status || '',
    bridgeReason: batch.reason || '',
    normalizedStatus,
    updatedAt: batch.updatedAt || manifest.updatedAt || '',
    logFile: logFile || '',
  };
}

function syncBatchToCrm(db, { manifestPath, manifest, batch, logFile }) {
  const normalizedStatus = normalizeBridgeStatus(batch);
  if (!normalizedStatus) {
    return { skipped: true, reason: 'non-terminal-status', batchNumber: batch.batchNumber };
  }

  const payload = buildPayload({ manifestPath, manifest, batch, normalizedStatus, logFile });
  const log = upsertExternalSendLog(db, {
    status: normalizedStatus,
    dry_run: false,
    sent_at: batchTimestamp(batch, normalizedStatus),
    error_message: batch.reason || null,
    run_id: `send-mail:${manifest.campaignName || path.basename(path.dirname(manifestPath))}`,
    external_source: EXTERNAL_SOURCE,
    external_id: buildExternalId(manifestPath, batch),
    payload_json: payload,
  });

  return {
    skipped: false,
    batchNumber: batch.batchNumber,
    sendLogId: log.id,
    status: log.status,
  };
}

function syncManifestToCrm(options = {}) {
  const { manifestPath, logFile } = options;
  if (!manifestPath) throw new Error('manifestPath is required');

  const manifest = options.manifest || readManifest(manifestPath);
  if (!manifest) throw new Error(`manifest not found: ${manifestPath}`);

  const ownsDb = !options.db;
  const db = options.db || openDb();
  try {
    if (ownsDb) initDb(db);
    const batches = Array.isArray(manifest.batches) ? manifest.batches : [];
    const results = batches.map(batch => syncBatchToCrm(db, {
      manifestPath,
      manifest,
      batch,
      logFile,
    }));
    return {
      manifestPath,
      synced: results.filter(item => !item.skipped).length,
      skipped: results.filter(item => item.skipped).length,
      results,
    };
  } finally {
    if (ownsDb) db.close();
  }
}

module.exports = {
  EXTERNAL_SOURCE,
  normalizeBridgeStatus,
  syncBatchToCrm,
  syncManifestToCrm,
};
