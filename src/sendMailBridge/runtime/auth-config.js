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
    if (process.env[name]) {
      return process.env[name];
    }
  }
  return '';
}

function resolveAuthConfig({
  baseDir = __dirname,
  appName = 'proboost',
  stateFileName = 'storage-state.json',
  cookieFileName = 'cookies.json',
  userEnvNames = ['PROBOOST_USER', 'MAIL_USER'],
  authRootEnvNames = ['PROBOOST_AUTH_ROOT'],
  profileEnvNames = ['BROWSER_PROFILE_PATH'],
  stateEnvNames = ['STATE_PATH'],
  cookieEnvNames = ['COOKIE_FILE'],
  clearEnvNames = ['CLEAR_AUTH'],
} = {}) {
  const userId = sanitizeUserId(pickEnvValue([...userEnvNames, 'USER_ID']) || DEFAULT_USER_ID);
  const authRoot = pickEnvValue([...authRootEnvNames, 'AUTH_ROOT']) || path.join(baseDir, `.${appName}-auth`);
  const userRoot = path.join(authRoot, userId);

  const profilePath = pickEnvValue(profileEnvNames) || path.join(userRoot, 'edge-profile');
  const statePath = pickEnvValue(stateEnvNames) || path.join(userRoot, stateFileName);
  const cookiePath = pickEnvValue(cookieEnvNames) || path.join(userRoot, cookieFileName);

  return {
    appName,
    userId,
    authRoot,
    userRoot,
    profilePath,
    statePath,
    cookiePath,
    clearAuth: toBool(pickEnvValue(clearEnvNames)),
    legacyStatePath: path.join(baseDir, appName === 'proboost' ? 'proboost-auth.json' : `${appName}-auth.json`),
    legacyCookiePath: path.join(baseDir, appName === 'proboost' ? 'session-cookies.json' : `${appName}-cookies.json`),
  };
}

function ensureAuthDirs(config) {
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
  fs.mkdirSync(path.dirname(config.cookiePath), { recursive: true });
  fs.mkdirSync(config.profilePath, { recursive: true });
}

function clearAuthData(config, { includeLegacy = false } = {}) {
  fs.rmSync(config.profilePath, { recursive: true, force: true });
  fs.rmSync(config.statePath, { force: true });
  fs.rmSync(config.cookiePath, { force: true });
  if (includeLegacy) {
    fs.rmSync(config.legacyStatePath, { force: true });
    fs.rmSync(config.legacyCookiePath, { force: true });
  }
}

module.exports = {
  DEFAULT_USER_ID,
  resolveAuthConfig,
  ensureAuthDirs,
  clearAuthData,
};
