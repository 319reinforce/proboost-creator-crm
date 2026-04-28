const fs = require('fs');
const path = require('path');

const DEFAULT_USER_ID = 'default';

function toBool(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function sanitizeUserId(rawUser) {
  const normalized = String(rawUser || DEFAULT_USER_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_USER_ID;
}

function pickEnvValue(names = []) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return '';
}

function resolveAuthConfig({
  baseDir,
  appName = 'proboost-creator-crm',
  stateFileName = 'storage-state.json',
  cookieFileName = 'cookies.json',
  userEnvNames = ['PROBOOST_USER', 'MAIL_USER'],
  authRootEnvNames = ['PROBOOST_AUTH_ROOT'],
  profileEnvNames = ['BROWSER_PROFILE_PATH'],
  stateEnvNames = ['STATE_PATH'],
  cookieEnvNames = ['COOKIE_FILE'],
  clearEnvNames = ['CLEAR_AUTH'],
} = {}) {
  const root = baseDir || path.resolve(__dirname, '..');
  const userId = sanitizeUserId(pickEnvValue([...userEnvNames, 'USER_ID']) || DEFAULT_USER_ID);
  const authRoot = pickEnvValue([...authRootEnvNames, 'AUTH_ROOT']) || path.join(root, `.${appName}-auth`);
  const userRoot = path.join(authRoot, userId);

  return {
    appName,
    userId,
    authRoot,
    userRoot,
    profilePath: pickEnvValue(profileEnvNames) || path.join(userRoot, 'edge-profile'),
    statePath: pickEnvValue(stateEnvNames) || path.join(userRoot, stateFileName),
    cookiePath: pickEnvValue(cookieEnvNames) || path.join(userRoot, cookieFileName),
    clearAuth: toBool(pickEnvValue(clearEnvNames)),
  };
}

function ensureAuthDirs(config) {
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
  fs.mkdirSync(path.dirname(config.cookiePath), { recursive: true });
  fs.mkdirSync(config.profilePath, { recursive: true });
}

function clearAuthData(config) {
  fs.rmSync(config.profilePath, { recursive: true, force: true });
  fs.rmSync(config.statePath, { force: true });
  fs.rmSync(config.cookiePath, { force: true });
}

module.exports = {
  DEFAULT_USER_ID,
  resolveAuthConfig,
  ensureAuthDirs,
  clearAuthData,
};
