const config = require('../config');
const { launchProBoostSession, persistAuthSnapshot } = require('./session');
const {
  enterMailbox,
  goToPage,
  goToNextPage,
  extractInboxRows,
  openInboxResult,
  extractOpenedThreadText,
} = require('./mailClient');
const { createMailApiClient } = require('./mailApiClient');
const { persistThreadRead, persistThreadSyncFailure } = require('./mailSyncPersistence');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function replyLikeRow(row) {
  const text = `${row.status || ''} ${row.text || ''}`;
  return /回复|回信|repl/i.test(text);
}

function mergeApiRowsWithDomFallback(apiRows, domRows) {
  if (apiRows.length !== domRows.length) {
    console.warn(`[mail-sync] API/DOM row count mismatch on fallback merge: api=${apiRows.length}, dom=${domRows.length}. Keeping index-based merge for compatibility.`);
  }
  return apiRows.map((row, index) => ({
    ...row,
    domFallbackRow: domRows[index] || null,
  }));
}

function summarizeMailSyncRun({ runId, mailbox, maxPages, results, pageIndex = 1, scannedRows = 0, note = '', mailboxEntry = null }) {
  return {
    runId,
    mailbox,
    requestedMailbox: mailboxEntry?.requestedMailbox || mailbox,
    mailboxFallback: mailboxEntry?.mailboxFallback || '',
    mailboxEntry,
    maxPages,
    pageSize: config.pageSize,
    pageIndex,
    scannedRows,
    note,
    processed: results.length,
    opened: results.filter(item => item.opened).length,
    apiSynced: results.filter(item => item.openStrategy === 'api-detail').length,
    bodySynced: results.filter(item => item.status === 'body-synced').length,
    failed: results.filter(item => item.status === 'failed').length,
    results,
  };
}

async function listRowsWithApi(apiClient, { mailbox, pageIndex, pageSize }) {
  if (!apiClient) return null;
  try {
    return await apiClient.listMailRows({
      mailbox,
      page: pageIndex,
      pageSize,
    });
  } catch {
    return null;
  }
}

async function syncRowWithApi(db, {
  apiClient,
  row,
  mailbox,
  runId,
}) {
  if (!apiClient || !row.providerMessageId) return null;
  try {
    const apiId = row.providerMessageId.replace(/^api:email\/receive:/, '');
    const detailResponse = await apiClient.getMailDetail({ id: apiId, row });
    const detail = detailResponse.detail;
    if (!detail?.bodyText) return null;
    const mergedRow = {
      ...row,
      sender: detail.sender || row.sender || '',
      subject: detail.subject || row.subject || '',
      time: detail.time || row.time || '',
      providerThreadId: detail.providerThreadId || row.providerThreadId || '',
      providerMessageId: detail.providerMessageId || row.providerMessageId || '',
    };
    const persisted = persistThreadRead(db, {
      row: mergedRow,
      threadText: detail.bodyText,
      bodyHtml: detail.contentHtml,
      mailbox,
      runId,
      openStrategy: 'api-detail',
      providerThreadId: detail.providerThreadId,
      providerMessageId: detail.providerMessageId,
    });
    return {
      ...persisted,
      row: mergedRow,
      bodyChars: detail.bodyText.length,
      detail,
    };
  } catch {
    return null;
  }
}

async function emitMailSyncProgress(options, snapshot) {
  if (typeof options.onProgress !== 'function') return;
  await options.onProgress(snapshot);
}

async function returnToMailboxPage(page, mailbox, pageIndex) {
  const entry = await enterMailbox(page, { mailbox });
  await goToPage(page, pageIndex);
  return entry;
}

async function runMailSyncBatch(db, options = {}) {
  const mailbox = String(options.mailbox || 'replied').trim() || 'replied';
  const maxPages = parsePositiveInt(options.maxPages, 1);
  const limit = Number.parseInt(options.limit || '0', 10) || 0;
  const runId = `mail-sync_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const results = [];
  let latestScannedRows = 0;
  let latestPageIndex = 1;
  let activeMailbox = mailbox;
  let latestMailboxEntry = null;
  const detailSource = String(options.detailSource || process.env.MAIL_DETAIL_SOURCE || 'auto').trim().toLowerCase();

  const { context, page } = await launchProBoostSession({
    headless: options.headless,
    keepOpen: options.keepOpen,
  });
  const apiClient = detailSource === 'dom'
    ? null
    : createMailApiClient({ context, endpoints: options.endpoints });

  try {
    const mailboxEntry = await returnToMailboxPage(page, mailbox, 1);
    latestMailboxEntry = mailboxEntry;
    activeMailbox = mailboxEntry.mailbox || mailbox;
    await emitMailSyncProgress(options, summarizeMailSyncRun({
      runId,
      mailbox: activeMailbox,
      maxPages,
      results,
      pageIndex: 1,
      scannedRows: 0,
      note: 'entered-mailbox',
      mailboxEntry,
    }));

    let pageIndex = 1;
    let processed = 0;
    while (pageIndex <= maxPages) {
      latestPageIndex = pageIndex;
      const apiList = await listRowsWithApi(apiClient, {
        mailbox: activeMailbox,
        pageIndex,
        pageSize: config.pageSize,
      });
      const listedRows = apiList?.rows?.length
        ? mergeApiRowsWithDomFallback(apiList.rows, pageIndex === 1 ? await extractInboxRows(page).catch(() => []) : [])
        : await extractInboxRows(page);
      const rows = latestMailboxEntry?.mailboxFallback === 'inbox'
        ? listedRows.filter(replyLikeRow)
        : listedRows;
      latestScannedRows = rows.length;
      await emitMailSyncProgress(options, summarizeMailSyncRun({
        runId,
        mailbox: activeMailbox,
        maxPages,
        results,
        pageIndex,
        scannedRows: rows.length,
        note: 'listed-mail-rows',
        mailboxEntry: latestMailboxEntry,
      }));
      if (rows.length === 0) break;

      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (limit > 0 && processed >= limit) break;
        const row = rows[rowIndex];
        const resultItem = {
          page: pageIndex,
          rowIndex,
          sender: row.sender || '',
          subject: row.subject || '',
          time: row.time || '',
          status: 'listed',
          stage: 'listed',
          threadId: null,
          messageId: null,
          providerThreadId: '',
          providerMessageId: '',
          bodyHash: '',
          bodyChars: 0,
          opened: false,
          openStrategy: '',
          detailSource: row.source || 'dom',
          error: '',
        };
        results.push(resultItem);

        try {
          resultItem.status = 'opening';
          resultItem.stage = 'opening';
          await emitMailSyncProgress(options, summarizeMailSyncRun({
            runId,
            mailbox: activeMailbox,
            maxPages,
            results,
            pageIndex,
            scannedRows: latestScannedRows,
            note: 'opening-thread',
          }));

          const apiSynced = await syncRowWithApi(db, {
            apiClient,
            row,
            mailbox: activeMailbox,
            runId,
          });

          let threadRecord;
          let messageRecord;
          let providerThreadId;
          let providerMessageId;
          let bodyHash;
          if (apiSynced) {
            resultItem.opened = false;
            resultItem.openStrategy = 'api-detail';
            resultItem.detailSource = 'api';
            resultItem.bodyChars = apiSynced.bodyChars;
            resultItem.sender = apiSynced.row.sender || resultItem.sender;
            resultItem.subject = apiSynced.row.subject || resultItem.subject;
            resultItem.time = apiSynced.row.time || resultItem.time;
            ({ threadRecord, messageRecord, providerThreadId, providerMessageId, bodyHash } = apiSynced);
          } else {
            if (detailSource === 'api') {
              throw new Error('API detail sync failed and detail-source=api disables DOM fallback');
            }
            const fallbackRow = row.domFallbackRow
              ? {
                ...row.domFallbackRow,
                providerThreadId: row.providerThreadId,
                providerMessageId: row.providerMessageId,
              }
              : row;
            if (row.source === 'api' && !row.domFallbackRow) {
              throw new Error('API detail sync failed and no matching DOM fallback row is available');
            }
            const openResult = await openInboxResult(page, fallbackRow);
            resultItem.opened = true;
            resultItem.openStrategy = openResult.openStrategy || '';
            resultItem.status = 'opened';
            resultItem.stage = 'opened';

            const threadText = await extractOpenedThreadText(page);
            resultItem.bodyChars = threadText.length;
            ({
              threadRecord,
              messageRecord,
              providerThreadId,
              providerMessageId,
              bodyHash,
            } = persistThreadRead(db, {
              page,
              row: fallbackRow,
              threadText,
              mailbox: activeMailbox,
              runId,
              openStrategy: resultItem.openStrategy,
            }));
          }
          resultItem.threadId = threadRecord.id;
          resultItem.messageId = messageRecord.id;
          resultItem.providerThreadId = providerThreadId;
          resultItem.providerMessageId = providerMessageId;
          resultItem.bodyHash = bodyHash;
          resultItem.status = 'body-synced';
          resultItem.stage = 'body-synced';
        } catch (error) {
          resultItem.status = 'failed';
          resultItem.stage = resultItem.stage === 'opening' ? 'open-failed' : 'failed';
          resultItem.error = String(error.message || error);
          try {
            const { threadRecord, providerThreadId } = persistThreadSyncFailure(db, {
              page,
              row,
              mailbox: activeMailbox,
              error,
              openStrategy: resultItem.openStrategy,
            });
            resultItem.threadId = threadRecord.id;
            resultItem.providerThreadId = providerThreadId;
          } catch {
            // Preserve the original sync failure as the row-level error.
          }
        }

        await emitMailSyncProgress(options, summarizeMailSyncRun({
          runId,
          mailbox: activeMailbox,
          maxPages,
          results,
          pageIndex,
          scannedRows: latestScannedRows,
          note: 'row-finished',
        }));

        processed += 1;
        if (limit > 0 && processed >= limit) break;
        if (resultItem.openStrategy !== 'api-detail') {
          latestMailboxEntry = await returnToMailboxPage(page, mailbox, pageIndex);
          activeMailbox = latestMailboxEntry.mailbox || activeMailbox;
        }
      }

      if (limit > 0 && processed >= limit) break;
      if (apiList?.rows?.length) {
        if (apiList.pages && pageIndex >= apiList.pages) break;
        pageIndex += 1;
        continue;
      }
      const advanced = await goToNextPage(page);
      if (!advanced) break;
      pageIndex += 1;
    }

    await persistAuthSnapshot(context);
  } finally {
    if (!options.keepOpen) await context.close();
  }

  return summarizeMailSyncRun({
    runId,
    mailbox: activeMailbox,
    maxPages,
    results,
    pageIndex: latestPageIndex,
    scannedRows: latestScannedRows,
    note: 'finished',
    mailboxEntry: latestMailboxEntry,
  });
}

module.exports = {
  runMailSyncBatch,
  summarizeMailSyncRun,
};
