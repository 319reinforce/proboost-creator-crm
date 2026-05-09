const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'src'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir, '..');
}

const repoRoot = findRepoRoot(__dirname);
const dbPath = path.resolve(repoRoot, process.env.CRM_DB_PATH || 'data/proboost-creator-crm.sqlite');

function normalizeManifestPath(manifestPath) {
  return manifestPath ? path.resolve(manifestPath) : null;
}

function serializeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function timestampForStatus(status, extra) {
  if (status === 'sent') return extra.sentAt || extra.updatedAt || new Date().toISOString();
  if (status === 'failed') return extra.failedAt || extra.updatedAt || new Date().toISOString();
  if (status === 'sending' || status === 'preparing') return extra.startedAt || extra.updatedAt || new Date().toISOString();
  return extra.updatedAt || new Date().toISOString();
}

function statusPatch(status, extra = {}) {
  const now = timestampForStatus(status, extra);
  return {
    status,
    reason: extra.reason || null,
    selected_count: extra.selectedCount == null ? null : Number(extra.selectedCount),
    started_at: status === 'sending' || status === 'preparing' ? now : (extra.startedAt || null),
    sent_at: status === 'sent' ? now : (extra.sentAt || null),
    failed_at: status === 'failed' ? now : (extra.failedAt || null),
    clear_claim: ['sent', 'failed', 'prepared'].includes(status) ? 1 : 0,
    payload_json: serializeJson(extra),
  };
}

function recomputeCampaignStatus(db, campaignId) {
  const batches = db.prepare(`
    SELECT status
    FROM send_mail_batches
    WHERE send_mail_campaign_id = ?
  `).all(campaignId);
  let status = 'empty';
  if (batches.length > 0) {
    if (batches.some(batch => ['sending', 'preparing'].includes(batch.status))) status = 'running';
    else if (batches.some(batch => batch.status === 'failed')) status = 'failed';
    else if (batches.every(batch => batch.status === 'sent')) status = 'sent';
    else if (batches.every(batch => ['sent', 'prepared'].includes(batch.status))) status = 'prepared';
    else status = 'pending';
  }
  db.prepare(`
    UPDATE send_mail_campaigns
    SET status = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, campaignId);
  return status;
}

function updateRuntimeBatchStatus({ manifestPath, batchNumber, status, extra = {} } = {}) {
  const resolvedManifestPath = normalizeManifestPath(manifestPath);
  const numericBatch = Number(batchNumber);
  if (!resolvedManifestPath || !numericBatch || !status) {
    return { updated: false, reason: 'missing-required-fields' };
  }
  if (!fs.existsSync(dbPath)) {
    return { updated: false, reason: 'db-not-found', dbPath };
  }

  const db = new Database(dbPath);
  try {
    const campaign = db.prepare(`
      SELECT *
      FROM send_mail_campaigns
      WHERE manifest_path = ?
    `).get(resolvedManifestPath);
    if (!campaign) return { updated: false, reason: 'campaign-not-found', manifestPath: resolvedManifestPath };

    const patch = statusPatch(status, extra);
    const result = db.prepare(`
      UPDATE send_mail_batches
      SET status = @status,
          reason = COALESCE(@reason, reason),
          selected_count = COALESCE(@selected_count, selected_count),
          started_at = COALESCE(@started_at, started_at),
          sent_at = COALESCE(@sent_at, sent_at),
          failed_at = COALESCE(@failed_at, failed_at),
          task_run_id = CASE WHEN @clear_claim = 1 THEN NULL ELSE task_run_id END,
          claimed_at = CASE WHEN @clear_claim = 1 THEN NULL ELSE claimed_at END,
          claimed_by = CASE WHEN @clear_claim = 1 THEN NULL ELSE claimed_by END,
          last_heartbeat_at = CASE WHEN @clear_claim = 1 THEN NULL ELSE last_heartbeat_at END,
          payload_json = COALESCE(@payload_json, payload_json),
          updated_at = CURRENT_TIMESTAMP
      WHERE send_mail_campaign_id = @campaign_id
        AND batch_number = @batch_number
    `).run({
      ...patch,
      campaign_id: campaign.id,
      batch_number: numericBatch,
    });
    if (result.changes !== 1) {
      return { updated: false, reason: 'batch-not-found', batchNumber: numericBatch };
    }
    return {
      updated: true,
      campaignId: campaign.id,
      batchNumber: numericBatch,
      status,
      campaignStatus: recomputeCampaignStatus(db, campaign.id),
    };
  } finally {
    db.close();
  }
}

module.exports = {
  updateRuntimeBatchStatus,
};
