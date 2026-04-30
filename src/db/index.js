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
  db.exec(SEED);
  return db;
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
      run_id
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
      @run_id
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
  });
  return db.prepare('SELECT * FROM send_logs WHERE id = ?').get(result.lastInsertRowid);
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
  upsertTaskRun,
  updateTaskRun,
  listTaskRuns,
};
