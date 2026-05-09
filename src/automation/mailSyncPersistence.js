const crypto = require('crypto');
const {
  upsertMailThread,
  insertMailMessage,
} = require('../db');

function stableHash(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map(item => String(item || '').trim()).join('\n'))
    .digest('hex')
    .slice(0, 32);
}

function normalizeBodyForHash(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function deriveThreadKey({ page, row, threadText, providerThreadId }) {
  if (providerThreadId) return providerThreadId;
  if (row?.providerThreadId) return row.providerThreadId;

  const currentUrl = page?.url?.() || '';
  try {
    const parsed = new URL(currentUrl);
    const stableKeys = ['threadId', 'thread_id', 'mailId', 'mail_id', 'messageId', 'message_id', 'id'];
    for (const key of stableKeys) {
      const value = parsed.searchParams.get(key);
      if (value) return `url:${parsed.origin}${parsed.pathname}?${key}=${value}`;
    }
    if (parsed.hash && /id|thread|mail|message/i.test(parsed.hash)) {
      return `url:${parsed.origin}${parsed.pathname}${parsed.hash}`;
    }
  } catch {
    // Fall through to deterministic row/thread hashes.
  }

  if (threadText) {
    return `text:${stableHash([row?.sender, row?.subject, normalizeBodyForHash(threadText).slice(0, 2000)])}`;
  }
  if (row?.sender || row?.subject || row?.time) {
    return `row:${stableHash([row.sender, row.subject, row.time])}`;
  }
  return `row:${stableHash([row?.sender, row?.subject, row?.text])}`;
}

function deriveMessageIdentity({ providerThreadId, row, threadText, providerMessageId }) {
  const bodyHash = stableHash([normalizeBodyForHash(threadText)]);
  const resolvedProviderMessageId = providerMessageId || row?.providerMessageId || `dom:${stableHash([
    providerThreadId,
    row?.sender,
    row?.subject,
    row?.time,
    bodyHash,
  ])}`;
  return { bodyHash, providerMessageId: resolvedProviderMessageId };
}

function persistThreadRead(db, {
  page,
  row,
  threadText,
  mailbox = 'inbox',
  runId = null,
  openStrategy = null,
  rawSnapshotPath = null,
  providerThreadId = null,
  providerMessageId = null,
  bodyHtml = null,
}) {
  const resolvedProviderThreadId = deriveThreadKey({ page, row, threadText, providerThreadId });
  const now = new Date().toISOString();
  const threadRecord = upsertMailThread(db, {
    provider_thread_id: resolvedProviderThreadId,
    mailbox,
    sender: row.sender,
    subject: row.subject,
    first_message_at: row.time,
    last_message_at: now,
    last_synced_at: now,
    sync_status: 'body-synced',
    last_sync_error: null,
    last_open_strategy: openStrategy,
    raw_snapshot_path: rawSnapshotPath,
    status: 'open',
  });
  const {
    bodyHash,
    providerMessageId: resolvedProviderMessageId,
  } = deriveMessageIdentity({
    providerThreadId: resolvedProviderThreadId,
    row,
    threadText,
    providerMessageId,
  });
  const messageRecord = insertMailMessage(db, {
    thread_id: threadRecord.id,
    direction: 'inbound',
    subject: row.subject,
    sender: row.sender,
    body_text: threadText,
    body_html: bodyHtml,
    received_at: row.time,
    raw_snapshot_path: rawSnapshotPath,
    provider_message_id: resolvedProviderMessageId,
    body_hash: bodyHash,
    sync_run_id: runId,
  });
  return {
    threadRecord,
    messageRecord,
    providerThreadId: resolvedProviderThreadId,
    providerMessageId: resolvedProviderMessageId,
    bodyHash,
  };
}

function persistThreadSyncFailure(db, {
  page,
  row,
  mailbox = 'inbox',
  error,
  openStrategy = null,
  rawSnapshotPath = null,
}) {
  const providerThreadId = deriveThreadKey({ page, row, threadText: '' });
  const now = new Date().toISOString();
  const threadRecord = upsertMailThread(db, {
    provider_thread_id: providerThreadId,
    mailbox,
    sender: row.sender,
    subject: row.subject,
    first_message_at: row.time,
    last_message_at: now,
    last_synced_at: now,
    sync_status: 'failed',
    last_sync_error: String(error?.message || error || ''),
    last_open_strategy: openStrategy,
    raw_snapshot_path: rawSnapshotPath,
    status: 'open',
  });
  return { threadRecord, providerThreadId };
}

module.exports = {
  deriveThreadKey,
  deriveMessageIdentity,
  persistThreadRead,
  persistThreadSyncFailure,
  stableHash,
};
