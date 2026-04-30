const fs = require('fs');
const { chromium } = require('playwright');
const config = require('../config');
const { ensureAuthDirs, clearAuthData } = require('../auth-config');

async function getPage(context) {
  const pages = context.pages();
  return pages.length > 0 ? pages[0] : await context.newPage();
}

async function hydrateCookies(context) {
  if (config.skipCookieHydrate) return;
  if (!fs.existsSync(config.auth.cookiePath)) return;
  try {
    const cookies = JSON.parse(fs.readFileSync(config.auth.cookiePath, 'utf8'));
    if (Array.isArray(cookies) && cookies.length > 0) {
      await context.addCookies(cookies);
    }
  } catch {
    // Cookie snapshots are best-effort; persistent profile is the source of truth.
  }
}

async function persistAuthSnapshot(context) {
  ensureAuthDirs(config.auth);
  await context.storageState({ path: config.auth.statePath });
  const cookies = await context.cookies();
  fs.writeFileSync(config.auth.cookiePath, JSON.stringify(cookies, null, 2));
}

async function launchProBoostSession(options = {}) {
  ensureAuthDirs(config.auth);
  if (options.clearAuth || config.auth.clearAuth) {
    clearAuthData(config.auth);
    ensureAuthDirs(config.auth);
  }

  const launchOptions = {
    headless: Boolean(options.headless),
    channel: options.channel || 'msedge',
  };
  if (fs.existsSync(config.auth.statePath)) {
    launchOptions.storageState = config.auth.statePath;
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(config.auth.profilePath, launchOptions);
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes('ProcessSingleton') || message.includes('SingletonLock') || message.includes('profile is already in use')) {
      throw new Error(`ProBoost browser profile is already open. Finish login and close the ProBoost login window before starting inbox checks. profile=${config.auth.profilePath}`);
    }
    throw error;
  }
  const page = await getPage(context);
  await hydrateCookies(context);
  return { context, page };
}

async function loginInteractively(options = {}) {
  const { context, page } = await launchProBoostSession(options);
  await page.goto(config.proboostUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout });
  await page.waitForTimeout(2000);

  console.log('Browser opened. Complete login if needed, then leave the page on ProBoost.');
  console.log(`Waiting up to ${Math.round(config.loginTimeout / 1000)} seconds...`);

  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return text.includes('收件箱') || text.includes('已发送') || text.includes('邮件');
  }, { timeout: config.loginTimeout }).catch(() => {});

  await persistAuthSnapshot(context);
  if (!options.keepOpen) {
    await context.close();
  }
}

module.exports = {
  launchProBoostSession,
  loginInteractively,
  persistAuthSnapshot,
};
