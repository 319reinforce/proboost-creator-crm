const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { SCHEMA, SEED } = require('./schema');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function openDb(dbPath = config.dbPath) {
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb(db = openDb()) {
  db.exec(SCHEMA);
  migrateDb(db);
  db.exec(SEED);
  return db;
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some(column => column.name === columnName);
}

function migrateDb(db) {
  const sendLogColumns = [
    ['external_source', 'TEXT'],
    ['external_id', 'TEXT'],
    ['payload_json', 'TEXT'],
  ];
  for (const [column, type] of sendLogColumns) {
    if (!columnExists(db, 'send_logs', column)) {
      db.prepare(`ALTER TABLE send_logs ADD COLUMN ${column} ${type}`).run();
    }
  }
  const sendMailBatchColumns = [
    ['task_run_id', 'TEXT'],
    ['claimed_at', 'TEXT'],
    ['claimed_by', 'TEXT'],
    ['last_heartbeat_at', 'TEXT'],
    ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [column, type] of sendMailBatchColumns) {
    if (!columnExists(db, 'send_mail_batches', column)) {
      db.prepare(`ALTER TABLE send_mail_batches ADD COLUMN ${column} ${type}`).run();
    }
  }
  const mailThreadColumns = [
    ['sync_status', 'TEXT'],
    ['last_sync_error', 'TEXT'],
    ['last_open_strategy', 'TEXT'],
    ['raw_snapshot_path', 'TEXT'],
  ];
  for (const [column, type] of mailThreadColumns) {
    if (!columnExists(db, 'mail_threads', column)) {
      db.prepare(`ALTER TABLE mail_threads ADD COLUMN ${column} ${type}`).run();
    }
  }
  const mailMessageColumns = [
    ['provider_message_id', 'TEXT'],
    ['body_hash', 'TEXT'],
    ['sync_run_id', 'TEXT'],
  ];
  for (const [column, type] of mailMessageColumns) {
    if (!columnExists(db, 'mail_messages', column)) {
      db.prepare(`ALTER TABLE mail_messages ADD COLUMN ${column} ${type}`).run();
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_send_logs_external_key
    ON send_logs (external_source, external_id)
    WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_send_mail_campaigns_manifest_path
    ON send_mail_campaigns (manifest_path)
    WHERE manifest_path IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_send_mail_batches_status
    ON send_mail_batches (status);

    CREATE INDEX IF NOT EXISTS idx_send_mail_batches_task_run
    ON send_mail_batches (task_run_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_provider_message
    ON mail_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_thread_body_hash
    ON mail_messages (thread_id, body_hash)
    WHERE body_hash IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_mail_threads_sync_status
    ON mail_threads (sync_status);
  `);
}

function getOrCreateCampaign(db, name, description = '') {
  const normalized = String(name || '').trim();
  if (!normalized) throw new Error('campaign name is required');

  db.prepare(`
    INSERT OR IGNORE INTO campaigns (name, description)
    VALUES (?, ?)
  `).run(normalized, description);

  return db.prepare('SELECT * FROM campaigns WHERE name = ?').get(normalized);
}

function upsertCreator(db, creator) {
  const handle = String(creator.handle || '').trim().toLowerCase();
  if (!handle) throw new Error('creator handle is required');

  db.prepare(`
    INSERT INTO creators (handle, display_name, status, source, last_seen_at)
    VALUES (@handle, @display_name, @status, @source, CURRENT_TIMESTAMP)
    ON CONFLICT(handle) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, creators.display_name),
      source = COALESCE(excluded.source, creators.source),
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    handle,
    display_name: creator.display_name || creator.name || handle,
    status: creator.status || 'invited',
    source: creator.source || 'import',
  });

  return db.prepare('SELECT * FROM creators WHERE handle = ?').get(handle);
}

function upsertInviteCode(db, invite) {
  db.prepare(`
    INSERT INTO invite_codes (
      creator_id,
      campaign_id,
      code,
      status,
      pushed_at,
      registered_at,
      raw_source
    )
    VALUES (
      @creator_id,
      @campaign_id,
      @code,
      @status,
      @pushed_at,
      @registered_at,
      @raw_source
    )
    ON CONFLICT(code) DO UPDATE SET
      creator_id = excluded.creator_id,
      campaign_id = excluded.campaign_id,
      status = CASE
        WHEN invite_codes.status = 'used' THEN 'used'
        ELSE excluded.status
      END,
      registered_at = COALESCE(invite_codes.registered_at, excluded.registered_at),
      raw_source = COALESCE(excluded.raw_source, invite_codes.raw_source),
      updated_at = CURRENT_TIMESTAMP
  `).run({
    creator_id: invite.creator_id,
    campaign_id: invite.campaign_id,
    code: invite.code,
    status: invite.status || 'pushed',
    pushed_at: invite.pushed_at || null,
    registered_at: invite.registered_at || null,
    raw_source: invite.raw_source || null,
  });

  return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(invite.code);
}

function markInviteUsed(db, code) {
  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!invite) return null;

  db.prepare(`
    UPDATE invite_codes
    SET status = 'used',
        registered_at = COALESCE(registered_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE code = ?
  `).run(code);

  db.prepare(`
    UPDATE creators
    SET status = 'registered',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(invite.creator_id);

  return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
}

function insertSendLog(db, log) {
  const result = db.prepare(`
    INSERT INTO send_logs (
      creator_id,
      invite_code_id,
      template_id,
      campaign_id,
      subject_rendered,
      body_rendered,
      status,
      dry_run,
      sent_at,
      verified_at,
      error_message,
      screenshot_path,
      run_id,
      external_source,
      external_id,
      payload_json
    )
    VALUES (
      @creator_id,
      @invite_code_id,
      @template_id,
      @campaign_id,
      @subject_rendered,
      @body_rendered,
      @status,
      @dry_run,
      @sent_at,
      @verified_at,
      @error_message,
      @screenshot_path,
      @run_id,
      @external_source,
      @external_id,
      @payload_json
    )
  `).run({
    creator_id: log.creator_id || null,
    invite_code_id: log.invite_code_id || null,
    template_id: log.template_id || null,
    campaign_id: log.campaign_id || null,
    subject_rendered: log.subject_rendered || null,
    body_rendered: log.body_rendered || null,
    status: log.status,
    dry_run: log.dry_run ? 1 : 0,
    sent_at: log.sent_at || null,
    verified_at: log.verified_at || null,
    error_message: log.error_message || null,
    screenshot_path: log.screenshot_path || null,
    run_id: log.run_id || null,
    external_source: log.external_source || null,
    external_id: log.external_id || null,
    payload_json: serializeJson(log.payload_json),
  });
  return db.prepare('SELECT * FROM send_logs WHERE id = ?').get(result.lastInsertRowid);
}

function upsertExternalSendLog(db, log) {
  if (!log.external_source || !log.external_id) {
    return insertSendLog(db, log);
  }

  const payload = {
    creator_id: log.creator_id || null,
    invite_code_id: log.invite_code_id || null,
    template_id: log.template_id || null,
    campaign_id: log.campaign_id || null,
    subject_rendered: log.subject_rendered || null,
    body_rendered: log.body_rendered || null,
    status: log.status,
    dry_run: log.dry_run ? 1 : 0,
    sent_at: log.sent_at || null,
    verified_at: log.verified_at || null,
    error_message: log.error_message || null,
    screenshot_path: log.screenshot_path || null,
    run_id: log.run_id || null,
    external_source: log.external_source,
    external_id: log.external_id,
    payload_json: serializeJson(log.payload_json),
  };

  db.prepare(`
    INSERT INTO send_logs (
      creator_id,
      invite_code_id,
      template_id,
      campaign_id,
      subject_rendered,
      body_rendered,
      status,
      dry_run,
      sent_at,
      verified_at,
      error_message,
      screenshot_path,
      run_id,
      external_source,
      external_id,
      payload_json
    )
    VALUES (
      @creator_id,
      @invite_code_id,
      @template_id,
      @campaign_id,
      @subject_rendered,
      @body_rendered,
      @status,
      @dry_run,
      @sent_at,
      @verified_at,
      @error_message,
      @screenshot_path,
      @run_id,
      @external_source,
      @external_id,
      @payload_json
    )
    ON CONFLICT(external_source, external_id)
    WHERE external_source IS NOT NULL AND external_id IS NOT NULL
    DO UPDATE SET
      status = excluded.status,
      dry_run = excluded.dry_run,
      sent_at = COALESCE(excluded.sent_at, send_logs.sent_at),
      verified_at = COALESCE(excluded.verified_at, send_logs.verified_at),
      error_message = excluded.error_message,
      screenshot_path = COALESCE(excluded.screenshot_path, send_logs.screenshot_path),
      run_id = COALESCE(excluded.run_id, send_logs.run_id),
      payload_json = excluded.payload_json
  `).run(payload);

  return db.prepare(`
    SELECT *
    FROM send_logs
    WHERE external_source = ? AND external_id = ?
  `).get(log.external_source, log.external_id);
}

function normalizeManifestPath(manifestPath) {
  return manifestPath ? path.resolve(manifestPath) : null;
}

function upsertSendMailCampaignFromManifest(db, { manifestPath, manifest, logFile } = {}) {
  if (!manifest) throw new Error('manifest is required');
  const resolvedManifestPath = normalizeManifestPath(manifestPath);
  const campaignName = String(
    manifest.campaignName
      || (resolvedManifestPath ? path.basename(path.dirname(resolvedManifestPath)) : '')
      || 'send-mail-campaign',
  ).trim();
  const crmCampaign = getOrCreateCampaign(db, campaignName, 'send-mail batch campaign');

  db.prepare(`
    INSERT INTO send_mail_campaigns (
      campaign_id,
      name,
      manifest_path,
      input_file,
      output_dir,
      original_upload,
      batch_size,
      total_rows,
      source_total_rows,
      skip_data_rows,
      batch_count,
      split_log,
      status
    )
    VALUES (
      @campaign_id,
      @name,
      @manifest_path,
      @input_file,
      @output_dir,
      @original_upload,
      @batch_size,
      @total_rows,
      @source_total_rows,
      @skip_data_rows,
      @batch_count,
      @split_log,
      @status
    )
    ON CONFLICT(name) DO UPDATE SET
      campaign_id = excluded.campaign_id,
      manifest_path = COALESCE(excluded.manifest_path, send_mail_campaigns.manifest_path),
      input_file = COALESCE(excluded.input_file, send_mail_campaigns.input_file),
      output_dir = COALESCE(excluded.output_dir, send_mail_campaigns.output_dir),
      original_upload = COALESCE(excluded.original_upload, send_mail_campaigns.original_upload),
      batch_size = COALESCE(excluded.batch_size, send_mail_campaigns.batch_size),
      total_rows = excluded.total_rows,
      source_total_rows = COALESCE(excluded.source_total_rows, send_mail_campaigns.source_total_rows),
      skip_data_rows = excluded.skip_data_rows,
      batch_count = excluded.batch_count,
      split_log = COALESCE(excluded.split_log, send_mail_campaigns.split_log),
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    campaign_id: crmCampaign.id,
    name: campaignName,
    manifest_path: resolvedManifestPath,
    input_file: manifest.inputFile || null,
    output_dir: manifest.outputDir || null,
    original_upload: manifest.originalUpload || null,
    batch_size: manifest.batchSize || null,
    total_rows: manifest.totalRows || 0,
    source_total_rows: manifest.sourceTotalRows || null,
    skip_data_rows: manifest.skipDataRows || 0,
    batch_count: manifest.batchCount || (Array.isArray(manifest.batches) ? manifest.batches.length : 0),
    split_log: manifest.splitLog || logFile || null,
    status: summarizeSendMailCampaignStatus(manifest),
  });

  const campaign = db.prepare('SELECT * FROM send_mail_campaigns WHERE name = ?').get(campaignName);
  const batches = Array.isArray(manifest.batches) ? manifest.batches : [];
  const upsertBatch = db.prepare(`
    INSERT INTO send_mail_batches (
      send_mail_campaign_id,
      batch_number,
      file_path,
      row_count,
      selected_count,
      status,
      reason,
      task_run_id,
      claimed_at,
      claimed_by,
      last_heartbeat_at,
      attempt_count,
      started_at,
      sent_at,
      failed_at,
      updated_from_manifest_at,
      payload_json
    )
    VALUES (
      @send_mail_campaign_id,
      @batch_number,
      @file_path,
      @row_count,
      @selected_count,
      @status,
      @reason,
      @task_run_id,
      @claimed_at,
      @claimed_by,
      @last_heartbeat_at,
      @attempt_count,
      @started_at,
      @sent_at,
      @failed_at,
      @updated_from_manifest_at,
      @payload_json
    )
    ON CONFLICT(send_mail_campaign_id, batch_number) DO UPDATE SET
      file_path = excluded.file_path,
      row_count = excluded.row_count,
      selected_count = excluded.selected_count,
      status = CASE
        WHEN send_mail_batches.status IN ('sent', 'failed', 'prepared')
          AND excluded.status IN ('pending', 'sending', 'preparing') THEN send_mail_batches.status
        WHEN send_mail_batches.status IN ('sending', 'preparing')
          AND excluded.status = 'pending' THEN send_mail_batches.status
        ELSE excluded.status
      END,
      reason = CASE
        WHEN send_mail_batches.status IN ('sent', 'failed', 'prepared')
          AND excluded.status IN ('pending', 'sending', 'preparing') THEN send_mail_batches.reason
        WHEN send_mail_batches.status IN ('sending', 'preparing')
          AND excluded.status = 'pending' THEN send_mail_batches.reason
        ELSE excluded.reason
      END,
      task_run_id = CASE
        WHEN excluded.status IN ('sending', 'preparing') THEN COALESCE(send_mail_batches.task_run_id, excluded.task_run_id)
        WHEN excluded.status IN ('sent', 'failed', 'prepared') THEN NULL
        ELSE send_mail_batches.task_run_id
      END,
      claimed_at = CASE
        WHEN excluded.status IN ('sent', 'failed', 'prepared') THEN NULL
        ELSE send_mail_batches.claimed_at
      END,
      claimed_by = CASE
        WHEN excluded.status IN ('sent', 'failed', 'prepared') THEN NULL
        ELSE send_mail_batches.claimed_by
      END,
      last_heartbeat_at = CASE
        WHEN excluded.status IN ('sent', 'failed', 'prepared') THEN NULL
        ELSE send_mail_batches.last_heartbeat_at
      END,
      started_at = COALESCE(excluded.started_at, send_mail_batches.started_at),
      sent_at = COALESCE(excluded.sent_at, send_mail_batches.sent_at),
      failed_at = COALESCE(excluded.failed_at, send_mail_batches.failed_at),
      updated_from_manifest_at = excluded.updated_from_manifest_at,
      payload_json = excluded.payload_json,
      updated_at = CURRENT_TIMESTAMP
  `);

  const syncTime = new Date().toISOString();
  const transaction = db.transaction(() => {
    for (const batch of batches) {
      upsertBatch.run({
        send_mail_campaign_id: campaign.id,
        batch_number: batch.batchNumber,
        file_path: batch.file || batch.inputFile || '',
        row_count: batch.rowCount || 0,
        selected_count: batch.selectedCount == null ? null : batch.selectedCount,
        status: batch.status || 'pending',
        reason: batch.reason || null,
        task_run_id: null,
        claimed_at: null,
        claimed_by: null,
        last_heartbeat_at: null,
        attempt_count: 0,
        started_at: batch.startedAt || null,
        sent_at: batch.sentAt || null,
        failed_at: batch.failedAt || null,
        updated_from_manifest_at: syncTime,
        payload_json: serializeJson(batch),
      });
    }
  });
  transaction();

  return {
    campaign,
    batchCount: batches.length,
  };
}

function parseSendMailBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    sendMailCampaignId: row.send_mail_campaign_id,
    manifestPath: row.manifest_path || '',
    batchNumber: row.batch_number,
    filePath: row.file_path,
    rowCount: row.row_count,
    selectedCount: row.selected_count,
    status: row.status,
    reason: row.reason || '',
    taskRunId: row.task_run_id || '',
    claimedAt: row.claimed_at || '',
    claimedBy: row.claimed_by || '',
    lastHeartbeatAt: row.last_heartbeat_at || '',
    attemptCount: row.attempt_count || 0,
    startedAt: row.started_at || '',
    sentAt: row.sent_at || '',
    failedAt: row.failed_at || '',
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSendMailCampaignByManifest(db, manifestPath) {
  const resolvedManifestPath = normalizeManifestPath(manifestPath);
  if (!resolvedManifestPath) return null;
  return db.prepare(`
    SELECT *
    FROM send_mail_campaigns
    WHERE manifest_path = ?
  `).get(resolvedManifestPath) || null;
}

function claimSendMailBatch(db, { manifestPath, batchNumber, taskRunId, claimedBy, prepareOnly = false } = {}) {
  const campaign = getSendMailCampaignByManifest(db, manifestPath);
  if (!campaign) {
    return { claimed: false, reason: 'campaign-not-found' };
  }
  const status = prepareOnly ? 'preparing' : 'sending';
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE send_mail_batches
    SET status = @status,
        reason = NULL,
        task_run_id = @task_run_id,
        claimed_at = @now,
        claimed_by = @claimed_by,
        last_heartbeat_at = @now,
        attempt_count = attempt_count + 1,
        started_at = @now,
        updated_at = CURRENT_TIMESTAMP
    WHERE send_mail_campaign_id = @campaign_id
      AND batch_number = @batch_number
      AND (
        status = 'pending'
        OR (
          status = 'failed'
          AND COALESCE(reason, '') != 'success-toast-not-found'
        )
      )
  `).run({
    status,
    task_run_id: taskRunId || null,
    now,
    claimed_by: claimedBy || null,
    campaign_id: campaign.id,
    batch_number: Number(batchNumber),
  });

  if (result.changes !== 1) {
    const batch = db.prepare(`
      SELECT *
      FROM send_mail_batches
      WHERE send_mail_campaign_id = ?
        AND batch_number = ?
    `).get(campaign.id, Number(batchNumber));
    return {
      claimed: false,
      reason: batch ? `batch-not-pending:${batch.status}` : 'batch-not-found',
      batch: parseSendMailBatch(batch),
    };
  }

  const batch = db.prepare(`
    SELECT *
    FROM send_mail_batches
    WHERE send_mail_campaign_id = ?
      AND batch_number = ?
  `).get(campaign.id, Number(batchNumber));
  return { claimed: true, campaign, batch: parseSendMailBatch(batch) };
}

function claimPendingSendMailBatches(db, { manifestPath, taskRunId, claimedBy, limit = 1000 } = {}) {
  const campaign = getSendMailCampaignByManifest(db, manifestPath);
  if (!campaign) {
    return { claimed: [], skipped: [], reason: 'campaign-not-found' };
  }
  const pendingRows = db.prepare(`
    SELECT batch_number
    FROM send_mail_batches
    WHERE send_mail_campaign_id = ?
      AND status = 'pending'
    ORDER BY batch_number ASC
    LIMIT ?
  `).all(campaign.id, Number(limit || 1000));

  const claimed = [];
  const skipped = [];
  const transaction = db.transaction(() => {
    for (const row of pendingRows) {
      const result = claimSendMailBatch(db, {
        manifestPath,
        batchNumber: row.batch_number,
        taskRunId,
        claimedBy,
      });
      if (result.claimed) claimed.push(result.batch);
      else skipped.push({ batchNumber: row.batch_number, reason: result.reason });
    }
  });
  transaction();

  return { campaign, claimed, skipped };
}

function heartbeatSendMailBatches(db, { taskRunId, batchNumbers } = {}) {
  if (!taskRunId) return 0;
  const now = new Date().toISOString();
  if (Array.isArray(batchNumbers) && batchNumbers.length > 0) {
    const updateOne = db.prepare(`
      UPDATE send_mail_batches
      SET last_heartbeat_at = @now,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_run_id = @task_run_id
        AND batch_number = @batch_number
        AND status IN ('sending', 'preparing')
    `);
    const transaction = db.transaction(() => {
      let changes = 0;
      for (const batchNumber of batchNumbers) {
        changes += updateOne.run({
          now,
          task_run_id: taskRunId,
          batch_number: Number(batchNumber),
        }).changes;
      }
      return changes;
    });
    return transaction();
  }

  return db.prepare(`
    UPDATE send_mail_batches
    SET last_heartbeat_at = @now,
        updated_at = CURRENT_TIMESTAMP
    WHERE task_run_id = @task_run_id
      AND status IN ('sending', 'preparing')
  `).run({ now, task_run_id: taskRunId }).changes;
}

function failClaimedSendMailBatches(db, { taskRunId, batchNumbers, reason = 'runner-failed' } = {}) {
  if (!taskRunId) return 0;
  const now = new Date().toISOString();
  if (Array.isArray(batchNumbers) && batchNumbers.length > 0) {
    const updateOne = db.prepare(`
      UPDATE send_mail_batches
      SET status = 'failed',
          reason = @reason,
          task_run_id = NULL,
          claimed_at = NULL,
          claimed_by = NULL,
          last_heartbeat_at = NULL,
          failed_at = @now,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_run_id = @task_run_id
        AND batch_number = @batch_number
        AND status IN ('sending', 'preparing')
    `);
    const transaction = db.transaction(() => {
      let changes = 0;
      for (const batchNumber of batchNumbers) {
        changes += updateOne.run({
          reason,
          now,
          task_run_id: taskRunId,
          batch_number: Number(batchNumber),
        }).changes;
      }
      return changes;
    });
    return transaction();
  }

  return db.prepare(`
    UPDATE send_mail_batches
    SET status = 'failed',
        reason = @reason,
        task_run_id = NULL,
        claimed_at = NULL,
        claimed_by = NULL,
        last_heartbeat_at = NULL,
        failed_at = @now,
        updated_at = CURRENT_TIMESTAMP
    WHERE task_run_id = @task_run_id
      AND status IN ('sending', 'preparing')
  `).run({
    reason,
    now,
    task_run_id: taskRunId,
  }).changes;
}

function recoverStaleSendMailBatches(db, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10 * 60 * 1000);
  const staleBefore = new Date(Date.now() - timeoutMs).toISOString();
  const targetStatus = options.targetStatus || 'failed';
  const reason = options.reason || 'runner-heartbeat-timeout';
  const staleRows = db.prepare(`
    SELECT b.*, c.manifest_path
    FROM send_mail_batches b
    JOIN send_mail_campaigns c ON c.id = b.send_mail_campaign_id
    WHERE b.status IN ('sending', 'preparing')
      AND COALESCE(b.last_heartbeat_at, b.claimed_at, b.started_at, b.created_at) < ?
    ORDER BY b.updated_at ASC
  `).all(staleBefore);

  if (staleRows.length === 0) return [];

  const now = new Date().toISOString();
  const updateOne = db.prepare(`
    UPDATE send_mail_batches
    SET status = @status,
        reason = @reason,
        task_run_id = NULL,
        claimed_at = NULL,
        claimed_by = NULL,
        last_heartbeat_at = NULL,
        failed_at = CASE WHEN @status = 'failed' THEN @now ELSE failed_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  const transaction = db.transaction(() => {
    for (const row of staleRows) {
      updateOne.run({
        id: row.id,
        status: targetStatus,
        reason,
        now,
      });
    }
  });
  transaction();

  return staleRows.map(parseSendMailBatch);
}

function summarizeSendMailCampaignStatus(manifest) {
  const batches = Array.isArray(manifest.batches) ? manifest.batches : [];
  if (batches.length === 0) return 'empty';
  if (batches.some(batch => ['sending', 'preparing'].includes(batch.status))) return 'running';
  if (batches.some(batch => batch.status === 'failed')) return 'failed';
  if (batches.every(batch => ['sent', 'prepared'].includes(batch.status))) return 'completed';
  return 'pending';
}

function upsertMailThread(db, payload) {
  const providerThreadId = String(payload.provider_thread_id || '').trim();
  if (!providerThreadId) throw new Error('provider_thread_id is required');

  const existing = db.prepare(`
    SELECT *
    FROM mail_threads
    WHERE provider_thread_id = ?
      AND COALESCE(mailbox, '') = COALESCE(?, '')
    ORDER BY id DESC
    LIMIT 1
  `).get(providerThreadId, payload.mailbox || null);

  if (existing) {
    db.prepare(`
      UPDATE mail_threads
      SET creator_id = COALESCE(@creator_id, creator_id),
          mailbox = COALESCE(@mailbox, mailbox),
          subject = COALESCE(@subject, subject),
          sender = COALESCE(@sender, sender),
          recipient = COALESCE(@recipient, recipient),
          first_message_at = COALESCE(first_message_at, @first_message_at),
          last_message_at = COALESCE(@last_message_at, last_message_at),
          last_synced_at = COALESCE(@last_synced_at, CURRENT_TIMESTAMP),
          sync_status = COALESCE(@sync_status, sync_status),
          last_sync_error = @last_sync_error,
          last_open_strategy = COALESCE(@last_open_strategy, last_open_strategy),
          raw_snapshot_path = COALESCE(@raw_snapshot_path, raw_snapshot_path),
          status = COALESCE(@status, status),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id: existing.id,
      creator_id: payload.creator_id || null,
      mailbox: payload.mailbox || null,
      subject: payload.subject || null,
      sender: payload.sender || null,
      recipient: payload.recipient || null,
      first_message_at: payload.first_message_at || null,
      last_message_at: payload.last_message_at || null,
      last_synced_at: payload.last_synced_at || null,
      sync_status: payload.sync_status || null,
      last_sync_error: payload.last_sync_error || null,
      last_open_strategy: payload.last_open_strategy || null,
      raw_snapshot_path: payload.raw_snapshot_path || null,
      status: payload.status || null,
    });
    return db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO mail_threads (
      creator_id,
      provider_thread_id,
      mailbox,
      subject,
      sender,
      recipient,
      first_message_at,
      last_message_at,
      last_synced_at,
      sync_status,
      last_sync_error,
      last_open_strategy,
      raw_snapshot_path,
      status
    )
    VALUES (
      @creator_id,
      @provider_thread_id,
      @mailbox,
      @subject,
      @sender,
      @recipient,
      @first_message_at,
      @last_message_at,
      @last_synced_at,
      @sync_status,
      @last_sync_error,
      @last_open_strategy,
      @raw_snapshot_path,
      @status
    )
  `).run({
    creator_id: payload.creator_id || null,
    provider_thread_id: providerThreadId,
    mailbox: payload.mailbox || null,
    subject: payload.subject || null,
    sender: payload.sender || null,
    recipient: payload.recipient || null,
    first_message_at: payload.first_message_at || null,
    last_message_at: payload.last_message_at || null,
    last_synced_at: payload.last_synced_at || new Date().toISOString(),
    sync_status: payload.sync_status || null,
    last_sync_error: payload.last_sync_error || null,
    last_open_strategy: payload.last_open_strategy || null,
    raw_snapshot_path: payload.raw_snapshot_path || null,
    status: payload.status || 'open',
  });

  return db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(result.lastInsertRowid);
}

function insertMailMessage(db, payload) {
  const providerMessageId = String(payload.provider_message_id || '').trim() || null;
  const bodyHash = String(payload.body_hash || '').trim() || null;
  const existing = providerMessageId
    ? db.prepare(`
      SELECT *
      FROM mail_messages
      WHERE provider_message_id = ?
      LIMIT 1
    `).get(providerMessageId)
    : bodyHash && payload.thread_id
      ? db.prepare(`
        SELECT *
        FROM mail_messages
        WHERE thread_id = ?
          AND body_hash = ?
        LIMIT 1
      `).get(payload.thread_id, bodyHash)
      : null;

  if (existing) {
    db.prepare(`
      UPDATE mail_messages
      SET thread_id = COALESCE(@thread_id, thread_id),
          creator_id = COALESCE(@creator_id, creator_id),
          direction = COALESCE(@direction, direction),
          subject = COALESCE(@subject, subject),
          sender = COALESCE(@sender, sender),
          recipient = COALESCE(@recipient, recipient),
          body_text = COALESCE(@body_text, body_text),
          body_html = COALESCE(@body_html, body_html),
          sent_at = COALESCE(@sent_at, sent_at),
          received_at = COALESCE(@received_at, received_at),
          raw_snapshot_path = COALESCE(@raw_snapshot_path, raw_snapshot_path),
          provider_message_id = COALESCE(@provider_message_id, provider_message_id),
          body_hash = COALESCE(@body_hash, body_hash),
          sync_run_id = COALESCE(@sync_run_id, sync_run_id)
      WHERE id = @id
    `).run({
      id: existing.id,
      thread_id: payload.thread_id || null,
      creator_id: payload.creator_id || null,
      direction: payload.direction || null,
      subject: payload.subject || null,
      sender: payload.sender || null,
      recipient: payload.recipient || null,
      body_text: payload.body_text || null,
      body_html: payload.body_html || null,
      sent_at: payload.sent_at || null,
      received_at: payload.received_at || null,
      raw_snapshot_path: payload.raw_snapshot_path || null,
      provider_message_id: providerMessageId,
      body_hash: bodyHash,
      sync_run_id: payload.sync_run_id || null,
    });
    return db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO mail_messages (
      thread_id,
      creator_id,
      direction,
      subject,
      sender,
      recipient,
      body_text,
      body_html,
      sent_at,
      received_at,
      raw_snapshot_path,
      provider_message_id,
      body_hash,
      sync_run_id
    )
    VALUES (
      @thread_id,
      @creator_id,
      @direction,
      @subject,
      @sender,
      @recipient,
      @body_text,
      @body_html,
      @sent_at,
      @received_at,
      @raw_snapshot_path,
      @provider_message_id,
      @body_hash,
      @sync_run_id
    )
  `).run({
    thread_id: payload.thread_id || null,
    creator_id: payload.creator_id || null,
    direction: payload.direction,
    subject: payload.subject || null,
    sender: payload.sender || null,
    recipient: payload.recipient || null,
    body_text: payload.body_text || null,
    body_html: payload.body_html || null,
    sent_at: payload.sent_at || null,
    received_at: payload.received_at || null,
    raw_snapshot_path: payload.raw_snapshot_path || null,
    provider_message_id: providerMessageId,
    body_hash: bodyHash,
    sync_run_id: payload.sync_run_id || null,
  });

  return db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(result.lastInsertRowid);
}

function insertAnalysisResult(db, payload) {
  const result = db.prepare(`
    INSERT INTO analysis_results (
      message_id,
      creator_id,
      intent,
      confidence,
      sentiment,
      needs_invite_code,
      has_contact,
      contact_type,
      contact_value,
      recommended_action,
      reason,
      model,
      prompt_version,
      raw_json
    )
    VALUES (
      @message_id,
      @creator_id,
      @intent,
      @confidence,
      @sentiment,
      @needs_invite_code,
      @has_contact,
      @contact_type,
      @contact_value,
      @recommended_action,
      @reason,
      @model,
      @prompt_version,
      @raw_json
    )
  `).run({
    message_id: payload.message_id || null,
    creator_id: payload.creator_id || null,
    intent: payload.intent || null,
    confidence: payload.confidence == null ? null : payload.confidence,
    sentiment: payload.sentiment || null,
    needs_invite_code: payload.needs_invite_code == null ? null : (payload.needs_invite_code ? 1 : 0),
    has_contact: payload.has_contact == null ? null : (payload.has_contact ? 1 : 0),
    contact_type: payload.contact_type || null,
    contact_value: payload.contact_value || null,
    recommended_action: payload.recommended_action || null,
    reason: payload.reason || null,
    model: payload.model || null,
    prompt_version: payload.prompt_version || null,
    raw_json: serializeJson(payload.raw_json),
  });

  return db.prepare('SELECT * FROM analysis_results WHERE id = ?').get(result.lastInsertRowid);
}

function serializeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseTaskRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    manifestPath: row.manifest_path,
    batchNumber: row.batch_number,
    templateName: row.template_name,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertTaskRun(db, task) {
  db.prepare(`
    INSERT INTO task_runs (
      id,
      type,
      status,
      manifest_path,
      batch_number,
      template_name,
      payload_json,
      result_json,
      error,
      started_at,
      finished_at
    )
    VALUES (
      @id,
      @type,
      @status,
      @manifest_path,
      @batch_number,
      @template_name,
      @payload_json,
      @result_json,
      @error,
      @started_at,
      @finished_at
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      manifest_path = excluded.manifest_path,
      batch_number = excluded.batch_number,
      template_name = excluded.template_name,
      payload_json = excluded.payload_json,
      result_json = excluded.result_json,
      error = excluded.error,
      finished_at = excluded.finished_at,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id: task.id,
    type: task.type,
    status: task.status,
    manifest_path: task.manifestPath || null,
    batch_number: task.batchNumber || null,
    template_name: task.templateName || null,
    payload_json: serializeJson(task.payload),
    result_json: serializeJson(task.result),
    error: task.error || null,
    started_at: task.startedAt,
    finished_at: task.finishedAt || null,
  });

  return parseTaskRun(db.prepare('SELECT * FROM task_runs WHERE id = ?').get(task.id));
}

function updateTaskRun(db, id, patch) {
  const current = parseTaskRun(db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id));
  if (!current) return null;
  return upsertTaskRun(db, { ...current, ...patch, id });
}

function listTaskRuns(db, { type, limit = 20 } = {}) {
  const rows = type
    ? db.prepare(`
      SELECT *
      FROM task_runs
      WHERE type = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(type, limit)
    : db.prepare(`
      SELECT *
      FROM task_runs
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit);
  return rows.map(parseTaskRun);
}

module.exports = {
  openDb,
  initDb,
  getOrCreateCampaign,
  upsertCreator,
  upsertInviteCode,
  markInviteUsed,
  insertSendLog,
  upsertExternalSendLog,
  upsertSendMailCampaignFromManifest,
  claimSendMailBatch,
  claimPendingSendMailBatches,
  heartbeatSendMailBatches,
  failClaimedSendMailBatches,
  recoverStaleSendMailBatches,
  upsertMailThread,
  insertMailMessage,
  insertAnalysisResult,
  upsertTaskRun,
  updateTaskRun,
  listTaskRuns,
};
