#!/usr/bin/env node

const { Command } = require('commander');
const config = require('../config');
const { openDb, initDb } = require('../db');
const { importCampaign } = require('../importer/importCampaign');
const { importRegistered } = require('../importer/importRegistered');
const { listUnusedInvites, getCampaignStats } = require('../importer/queries');
const { getActiveTemplate, renderTemplate } = require('../templates/render');
const { exportCampaignReport } = require('../reporting/export');
const { loginInteractively } = require('../automation/session');
const { searchHandle, runReminderBatch, runReadyFollowupBatch } = require('../automation/reminderRunner');
const { runMailSyncBatch } = require('../automation/mailSyncRunner');
const { runMailApiDiscovery } = require('../automation/mailApiDiscovery');
const { runClassificationBatch } = require('../automation/classificationRunner');
const {
  saveLogin: saveLegacyReadyLogin,
  runUnusedInviteReminder,
  runRepliedReminder,
} = require('../legacyAdapters/proboostReadyReminder');

const program = new Command();

async function withDb(fn) {
  const db = openDb();
  try {
    initDb(db);
    return await fn(db);
  } finally {
    db.close();
  }
}

function parseLimit(value) {
  const limit = Number.parseInt(value || '0', 10);
  return Number.isFinite(limit) ? limit : 0;
}

program
  .name('proboost-creator-crm')
  .description('Creator CRM CLI for ProBoost operations')
  .version('0.1.0');

program
  .command('doctor')
  .description('Print current project configuration')
  .action(() => {
    console.log(JSON.stringify({
      rootDir: config.rootDir,
      dbPath: config.dbPath,
      reportDir: config.reportDir,
      proboostUrl: config.proboostUrl,
      authProfile: config.auth.profilePath,
      dryRunDefault: config.dryRunDefault,
    }, null, 2));
  });

program
  .command('login')
  .description('Open headed browser and save ProBoost login state')
  .option('--keep-open', 'keep browser open after state is saved', false)
  .option('--headless', 'run browser headless', false)
  .action(async (options) => {
    await loginInteractively(options);
    console.log('Login state saved.');
  });

program
  .command('search')
  .description('Search ProBoost inbox by creator handle')
  .requiredOption('--handle <handle>', 'creator handle')
  .option('--keep-open', 'keep browser open after search', false)
  .option('--headless', 'run browser headless', false)
  .action(async (options) => {
    const result = await searchHandle(options);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('remind')
  .description('Search inbox and prepare/send reminder replies for unused invite creators')
  .requiredOption('--campaign <name>', 'campaign name')
  .option('--handles <handles>', 'comma-separated handles to process')
  .option('--template <name>', 'template name', '督促产品使用')
  .option('--limit <n>', 'limit targets', '0')
  .option('--send', 'actually send emails; omitted means dry-run', false)
  .option('--force-ambiguous', 'select first candidate when multiple rows match', false)
  .option('--keep-open', 'keep browser open after run', false)
  .option('--headless', 'run browser headless', false)
  .option('--signup-link <url>', 'signup link', config.defaultSignupLink)
  .option('--expires-in <text>', 'expiration text', config.defaultExpiresIn)
  .option('--bonus-amount <text>', 'bonus amount', config.defaultBonusAmount)
  .action(async (options) => {
    await withDb(async (db) => {
      const result = await runReminderBatch(db, options);
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command('mail-sync')
  .description('Sync ProBoost mail bodies into SQLite without classifying or sending')
  .option('--mailbox <name>', 'mailbox to sync: replied or inbox', 'replied')
  .option('--max-pages <n>', 'max mailbox pages to scan', '1')
  .option('--limit <n>', 'limit messages to inspect', '0')
  .option('--detail-source <mode>', 'detail source: auto, api, or dom', 'auto')
  .option('--keep-open', 'keep browser open after run', false)
  .option('--headless', 'run browser headless', false)
  .action(async (options) => {
    await withDb(async (db) => {
      const result = await runMailSyncBatch(db, options);
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command('mail-debug')
  .description('Discover likely ProBoost mail list/detail/reply APIs from an authenticated browser session')
  .option('--mailbox <name>', 'mailbox to open while recording: replied or inbox', 'replied')
  .option('--duration <ms>', 'recording duration in milliseconds', '45000')
  .option('--open-first-row', 'open the first listed row to capture detail API candidates', false)
  .option('--keep-open', 'keep browser open after recording', false)
  .option('--headless', 'run browser headless', false)
  .action(async (options) => {
    const result = await runMailApiDiscovery(options);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('classify-mail')
  .description('Classify already-synced inbound mail from SQLite without opening a browser or sending')
  .option('--limit <n>', 'limit messages to classify', '50')
  .option('--thread-id <id>', 'classify messages from one mail thread')
  .option('--message-id <id>', 'classify one mail message')
  .option('--ready-keywords <items>', 'comma-separated ready keywords', 'ready')
  .option('--registered-names <items>', 'comma-separated names/handles to treat as already registered')
  .option('--prompt-version <name>', 'classifier prompt/rules version')
  .action(async (options) => {
    await withDb(async (db) => {
      const result = await runClassificationBatch(db, options);
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command('ready-followup')
  .description('Scan replied inbox mail, classify ready replies, and prepare/send second-touch followups')
  .option('--sync-mode <mode>', 'backfill scans history; incremental stops at the first already-synced message', 'backfill')
  .option('--max-pages <n>', 'max replied inbox pages to scan', '1')
  .option('--limit <n>', 'limit messages to inspect', '0')
  .option('--ready-keywords <items>', 'comma-separated ready keywords', 'ready')
  .option('--registered-names <items>', 'comma-separated names/handles to treat as already registered')
  .option('--template-whatsapp <name>', 'template for ready replies with phone/contact', '感谢发送联系方式')
  .option('--template-register <name>', 'template for ready replies without phone/contact', '督促产品使用')
  .option('--send', 'actually send emails; omitted means dry-run', false)
  .option('--keep-open', 'keep browser open after run', false)
  .option('--headless', 'run browser headless', false)
  .option('--signup-link <url>', 'signup link', config.defaultSignupLink)
  .option('--expires-in <text>', 'expiration text', config.defaultExpiresIn)
  .option('--bonus-amount <text>', 'bonus amount', config.defaultBonusAmount)
  .action(async (options) => {
    await withDb(async (db) => {
      const result = await runReadyFollowupBatch(db, options);
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command('init')
  .description('Initialize the SQLite database')
  .action(async () => {
    await withDb(() => {});
    console.log(`Initialized database: ${config.dbPath}`);
  });

program
  .command('import')
  .description('Import pushed invite list and ready/registered list')
  .requiredOption('--push <path>', 'pushed invite-code file')
  .option('--ready <path>', 'ready/registered file')
  .requiredOption('--campaign <name>', 'campaign name, for example 2026-04-28')
  .option('--description <text>', 'campaign description', '')
  .action(async (options) => {
    await withDb((db) => {
      const result = importCampaign(db, options);
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command('import-registered')
  .description('Import an actual activated/registered creator list and mark matched invite codes used')
  .requiredOption('--file <path>', 'registered/activated list file (.xlsx, .xls, .csv, or text)')
  .option('--campaign <name>', 'optional campaign filter for matching')
  .option('--source <name>', 'activation source label', 'activation-import')
  .option('--note <text>', 'operator note for activation audit rows', '')
  .option('--activated-at <iso>', 'activation timestamp to write; defaults to now')
  .action(async (options) => {
    await withDb((db) => {
      const result = importRegistered(db, options);
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command('list-unused')
  .description('List creators who have unused invite codes')
  .requiredOption('--campaign <name>', 'campaign name')
  .option('--limit <n>', 'limit rows', '0')
  .action(async (options) => {
    await withDb((db) => {
      const rows = listUnusedInvites(db, options.campaign, parseLimit(options.limit));
      console.log(JSON.stringify(rows, null, 2));
    });
  });

program
  .command('render-template')
  .description('Render active template for unused invite creators')
  .requiredOption('--campaign <name>', 'campaign name')
  .option('--template <name>', 'template name', '督促产品使用')
  .option('--limit <n>', 'limit rows', '5')
  .option('--signup-link <url>', 'signup link', config.defaultSignupLink)
  .option('--expires-in <text>', 'expiration text', config.defaultExpiresIn)
  .option('--bonus-amount <text>', 'bonus amount', config.defaultBonusAmount)
  .action(async (options) => {
    await withDb((db) => {
      const template = getActiveTemplate(db, options.template);
      if (!template) {
        throw new Error(`template not found: ${options.template}`);
      }

      const rows = listUnusedInvites(db, options.campaign, parseLimit(options.limit));
      const rendered = rows.map(row => {
        const variables = {
          creator_name: row.display_name || row.handle,
          handle: row.handle,
          invite_code: row.code,
          signup_link: options.signupLink,
          expires_in: options.expiresIn,
          bonus_amount: options.bonusAmount,
          last_subject: '',
        };
        return {
          handle: row.handle,
          code: row.code,
          ...renderTemplate(template, variables),
        };
      });

      console.log(JSON.stringify(rendered, null, 2));
    });
  });

program
  .command('report')
  .description('Export campaign report')
  .requiredOption('--campaign <name>', 'campaign name')
  .action(async (options) => {
    await withDb((db) => {
      const result = exportCampaignReport(db, options.campaign);
      console.log(JSON.stringify({
        outDir: result.outDir,
        unusedPath: result.unusedPath,
        summary: result.summary,
      }, null, 2));
    });
  });

program
  .command('stats')
  .description('Print campaign stats')
  .requiredOption('--campaign <name>', 'campaign name')
  .action(async (options) => {
    await withDb((db) => {
      console.log(JSON.stringify(getCampaignStats(db, options.campaign), null, 2));
    });
  });

const legacy = program
  .command('legacy')
  .description('Run legacy engines through CRM-owned adapters without modifying legacy source projects');

legacy
  .command('ready-login')
  .description('Open ProBoost login for the proboost-ready-reminder compatibility adapter')
  .action(async () => {
    const result = await saveLegacyReadyLogin();
    console.log(JSON.stringify(result, null, 2));
  });

legacy
  .command('unused')
  .description('Run proboost-ready-reminder unused invite flow through the CRM adapter; dry-run by default')
  .option('--push <path>', 'pushed invite-code file')
  .option('--ready <path>', 'ready/registered file')
  .option('--template <name>', 'ProBoost template name', '督促产品使用')
  .option('--handles <handles>', 'comma-separated handles')
  .option('--limit <n>', 'limit targets')
  .option('--send', 'actually send; omitted means DRY_RUN=1', false)
  .option('--force-ambiguous', 'select first candidate when multiple exact results match', false)
  .option('--no-resume-sent', 'do not skip statuses already recorded in progress.json')
  .option('--resume-statuses <statuses>', 'comma-separated statuses to skip when resuming')
  .action(async (options) => {
    const result = await runUnusedInviteReminder(options);
    console.log(JSON.stringify(result, null, 2));
  });

legacy
  .command('replied')
  .description('Run proboost-ready-reminder replied flow through the CRM adapter; requires --send')
  .option('--send', 'required because the legacy replied script sends by design', false)
  .option('--whitelist <path>', 'registered whitelist xlsx')
  .option('--page-size <n>', 'page size')
  .option('--max-pages <n>', 'max pages to scan')
  .option('--template-whatsapp <name>', 'template for creators with phone numbers')
  .option('--template-register <name>', 'template for creators without phone numbers')
  .option('--no-keep-open', 'close browser after run where supported')
  .action(async (options) => {
    const result = await runRepliedReminder(options);
    console.log(JSON.stringify(result, null, 2));
  });

program.parseAsync(process.argv).catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
