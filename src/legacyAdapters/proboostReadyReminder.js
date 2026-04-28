const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

const LEGACY_ROOT = process.env.PROBOOST_READY_REMINDER_ROOT || '/Users/depp/proboost-ready-reminder';
const runsRoot = path.join(config.reportDir, 'legacy-runs', 'proboost-ready-reminder');
const authRoot = path.join(config.rootDir, '.legacy-auth', 'proboost-ready-reminder');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function scriptPath(name) {
  const filePath = path.join(LEGACY_ROOT, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Legacy script not found: ${filePath}`);
  }
  return filePath;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function listJsonFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const itemPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(itemPath);
      else if (entry.name.endsWith('.json')) found.push(itemPath);
    }
  };
  walk(rootDir);
  return found.sort();
}

function summarizeReports(reportRoot) {
  const jsonFiles = listJsonFiles(reportRoot);
  const summaryPath = jsonFiles.find(file => path.basename(file) === 'summary.json');
  const preflightPath = jsonFiles.find(file => path.basename(file) === 'preflight.json');
  const progressPath = jsonFiles.find(file => path.basename(file) === 'progress.json');
  return {
    reportRoot,
    summary: readJson(summaryPath, null),
    preflight: readJson(preflightPath, null),
    progress: readJson(progressPath, null),
    jsonFiles,
  };
}

function runLegacyScript(scriptName, env = {}, label = 'legacy') {
  ensureDir(runsRoot);
  ensureDir(authRoot);

  const runId = `${timestamp()}-${label}`;
  const reportRoot = path.join(runsRoot, runId, 'reports');
  const logFile = path.join(runsRoot, runId, `${label}.log`);
  ensureDir(reportRoot);
  ensureDir(path.dirname(logFile));

  const childEnv = {
    ...process.env,
    ...env,
    REPORT_DIR: reportRoot,
    PROBOOST_AUTH_ROOT: path.join(authRoot, 'auth'),
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath(scriptName)], {
      cwd: LEGACY_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.on('error', reject);
    child.on('exit', code => {
      stream.end();
      const result = {
        code,
        runId,
        logFile,
        ...summarizeReports(reportRoot),
      };
      if (code === 0) resolve(result);
      else {
        const error = new Error(`${scriptName} exited with code ${code}; log=${logFile}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

function boolEnv(value) {
  return value ? '1' : '0';
}

async function saveLogin() {
  return runLegacyScript('save-proboost-auth.js', {}, 'login');
}

async function runUnusedInviteReminder(options = {}) {
  const env = {
    DRY_RUN: boolEnv(!options.send),
    RESUME_SENT: options.resumeSent === false ? '0' : '1',
  };
  if (options.push) env.PUSH_FILE = path.resolve(options.push);
  if (options.ready) env.READY_FILE = path.resolve(options.ready);
  if (options.template) env.TEMPLATE_NAME = options.template;
  if (options.handles) env.TARGET_HANDLES = options.handles;
  if (options.limit) env.LIMIT = String(options.limit);
  if (options.forceAmbiguous) env.FORCE_AMBIGUOUS = '1';
  if (options.resumeStatuses) env.RESUME_STATUSES = options.resumeStatuses;
  return runLegacyScript('unused-invite-reminder.js', env, options.send ? 'unused-send' : 'unused-dry-run');
}

async function runRepliedReminder(options = {}) {
  if (!options.send) {
    throw new Error('proboost-replied.js sends by design. Re-run with --send to execute it through the CRM adapter.');
  }
  const env = {};
  if (options.whitelist) env.WHITELIST_FILE = path.resolve(options.whitelist);
  if (options.pageSize) env.PAGE_SIZE = String(options.pageSize);
  if (options.maxPages != null) env.MAX_PAGES = String(options.maxPages);
  if (options.templateWhatsapp) env.TEMPLATE_WHATSAPP = options.templateWhatsapp;
  if (options.templateRegister) env.TEMPLATE_REGISTER = options.templateRegister;
  if (options.keepOpen === false) env.KEEP_BROWSER_OPEN = '0';
  return runLegacyScript('proboost-replied.js', env, 'replied-send');
}

module.exports = {
  LEGACY_ROOT,
  runsRoot,
  authRoot,
  saveLogin,
  runUnusedInviteReminder,
  runRepliedReminder,
};
