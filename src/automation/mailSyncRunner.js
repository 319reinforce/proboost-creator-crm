const config = require('../config');
const { launchProBoostSession, persistAuthSnapshot } = require('./session');
const {
  enterMailbox,
  setPageSize,
  goToFirstPage,
  goToNextPage,
  extractInboxRows,
  openInboxResult,
  extractOpenedThreadText,
} = require('./mailClient');
const { persistThreadRead, persistThreadSyncFailure } = require('./mailSyncPersistence');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function replyLikeRow(row) {
  const text = `${row.status || ''} ${row.text || ''}`;
  return /回复|回信|repl/i.test(text);
}

function summarizeMailSyncRun({ runId, mailbox, maxPages, results, pageIndex = 1, scannedRows = 0, note = '', mailboxEntry = null }) {
  return {
    runId,
    mailbox,
    requestedMailbox: mailboxEntry?.requestedMailbox || mailbox,
    mailboxFallback: mailboxEntry?.mailboxFallback || '',
    mailboxEntry,
    maxPages,
    pageIndex,
    scannedRows,
    note,
    processed: results.length,
    opened: results.filter(item => item.opened).length,
    bodySynced: results.filter(item => item.status === 'body-synced').length,
    failed: results.filter(item => item.status === 'failed').length,
    results,
  };
}

async function emitMailSyncProgress(options, snapshot) {
  if (typeof options.onProgress !== 'function') return;
  await options.onProgress(snapshot);
}

async function returnToMailboxPage(page, mailbox, pageIndex) {
  const entry = await enterMailbox(page, { mailbox });
  await setPageSize(page, config.pageSize);
  await goToFirstPage(page);
  for (let i = 1; i < pageIndex; i += 1) {
    const advanced = await goToNextPage(page);
    if (!advanced) break;
  }
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

  const { context, page } = await launchProBoostSession({
    headless: options.headless,
    keepOpen: options.keepOpen,
  });

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
      const listedRows = await extractInboxRows(page);
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

          const openResult = await openInboxResult(page, row);
          resultItem.opened = true;
          resultItem.openStrategy = openResult.openStrategy || '';
          resultItem.status = 'opened';
          resultItem.stage = 'opened';

          const threadText = await extractOpenedThreadText(page);
          resultItem.bodyChars = threadText.length;
          const {
            threadRecord,
            messageRecord,
            providerThreadId,
            providerMessageId,
            bodyHash,
          } = persistThreadRead(db, {
            page,
            row,
            threadText,
            mailbox: activeMailbox,
            runId,
            openStrategy: resultItem.openStrategy,
          });
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
        latestMailboxEntry = await returnToMailboxPage(page, mailbox, pageIndex);
        activeMailbox = latestMailboxEntry.mailbox || activeMailbox;
      }

      if (limit > 0 && processed >= limit) break;
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
