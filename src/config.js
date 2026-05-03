const path = require('path');
const fs = require('fs');
const { resolveAuthConfig } = require('./auth-config');

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const rootDir = path.resolve(__dirname, '..');
const sharedAuthRoots = [
  '/Users/depp/proboost-ready-reminder/.proboost-reply-auth',
  '/Users/depp/send-mail/.proboost-auth',
];
const auth = resolveAuthConfig({ baseDir: rootDir, appName: 'proboost-creator-crm' });
const sharedAuthRoot = sharedAuthRoots.find(item => fs.existsSync(item));
if (boolEnv('PROBOOST_USE_SHARED_AUTH', false) && !process.env.PROBOOST_AUTH_ROOT && sharedAuthRoot) {
  auth.authRoot = sharedAuthRoot;
  auth.userRoot = path.join(sharedAuthRoot, auth.userId);
  auth.profilePath = path.join(auth.userRoot, 'edge-profile');
  auth.statePath = path.join(auth.userRoot, 'storage-state.json');
  auth.cookiePath = path.join(auth.userRoot, 'cookies.json');
}

module.exports = {
  rootDir,
  dbPath: path.resolve(rootDir, process.env.CRM_DB_PATH || 'data/proboost-creator-crm.sqlite'),
  reportDir: path.resolve(rootDir, process.env.REPORT_DIR || 'reports'),
  proboostUrl: process.env.PROBOOST_URL || 'https://mail.proboost.microdata-inc.com/mail',
  sentUrl: process.env.SENT_URL || 'https://mail.proboost.microdata-inc.com/mail/sent',
  auth,
  pageSize: Number(process.env.PAGE_SIZE || 100),
  loginTimeout: Number(process.env.LOGIN_TIMEOUT || 300000),
  pageLoadTimeout: Number(process.env.PAGE_LOAD_TIMEOUT || 60000),
  sendConfirmTimeout: Number(process.env.SEND_CONFIRM_TIMEOUT || 10000),
  sendSuccessTimeout: Number(process.env.SEND_SUCCESS_TIMEOUT || 60000),
  defaultSignupLink: process.env.DEFAULT_SIGNUP_LINK || 'https://moras.ai/',
  defaultBonusAmount: process.env.DEFAULT_BONUS_AMOUNT || '$200',
  defaultExpiresIn: process.env.DEFAULT_EXPIRES_IN || '48 hours',
  dryRunDefault: boolEnv('DRY_RUN', true),
  keepBrowserOpen: boolEnv('KEEP_BROWSER_OPEN', false),
  skipCookieHydrate: boolEnv('SKIP_COOKIE_HYDRATE', false),
};
