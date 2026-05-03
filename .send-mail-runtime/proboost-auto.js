/**
 * proboost-auto.js
 * Playwright 浏览器自动化 - Proboost 达人导入发送（全自动）
 *
 * 依赖: npm install playwright xlsx
 */

// ========== 配置区 ==========
const path = require('path');
const fs = require('fs');
const { DEFAULT_USER_ID, resolveAuthConfig, ensureAuthDirs, clearAuthData } = require('./auth-config');
const { readManifest, updateBatchStatus, writeManifest } = require('./batch-manifest');

const DEFAULT_XLSX = path.join(__dirname, 'creators', '已建联达人_邮箱_2026-04-13 (2).xlsx');
const authConfig = resolveAuthConfig({ baseDir: __dirname, stateFileName: 'storage-state.json' });

const BROWSER_PROFILE_PATH = authConfig.profilePath;
const PROBOOST_URL = process.env.PROBOOST_URL || 'https://mail.proboost.microdata-inc.com/mail';
const XLSX_FILE = process.env.XLSX_FILE || process.argv[2] || DEFAULT_XLSX;
const INPUT_DIR = process.env.INPUT_DIR || '';
const CREATORS_DIR = process.env.CREATORS_DIR || path.join(__dirname, 'creators');
const ALLOW_OVERWRITE = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_OVERWRITE || '').toLowerCase());
const WAIT_AFTER_IMPORT = Number(process.env.WAIT_AFTER_IMPORT || 12000); // 12秒
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 500);
const STATE_PATH = authConfig.statePath;
const SEND_CONFIRM_TIMEOUT = Number(process.env.SEND_CONFIRM_TIMEOUT || 10000);
const SEND_SUCCESS_TIMEOUT = Number(process.env.SEND_SUCCESS_TIMEOUT || 60000);
const MANUAL_SEND_TIMEOUT = Number(process.env.MANUAL_SEND_TIMEOUT || 1800000);
const MANUAL_UPLOAD_TIMEOUT = Number(process.env.MANUAL_UPLOAD_TIMEOUT || 600000);
const MANUAL_TEMPLATE_TIMEOUT = Number(process.env.MANUAL_TEMPLATE_TIMEOUT || 600000);
const IMPORT_POPUP_TIMEOUT = Number(process.env.IMPORT_POPUP_TIMEOUT || 15000);
const SEND_SUCCESS_TEXT = process.env.SEND_SUCCESS_TEXT || '发送成功';
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || '0414新规模板';
const CONFIRM_TEXTS = (process.env.SEND_CONFIRM_TEXTS || '确认,确定').split(',').map(s => s.trim()).filter(Boolean);
const KEEP_BROWSER_OPEN = ['1', 'true', 'yes'].includes(String(process.env.KEEP_BROWSER_OPEN || '').toLowerCase());
const PREPARE_ONLY = ['1', 'true', 'yes'].includes(String(process.env.PREPARE_ONLY || '').toLowerCase());
const MANUAL_UPLOAD = ['1', 'true', 'yes'].includes(String(process.env.MANUAL_UPLOAD || '').toLowerCase());
const MANUAL_TEMPLATE = ['1', 'true', 'yes'].includes(String(process.env.MANUAL_TEMPLATE || '').toLowerCase());
const COPY_INPUT_TO_CREATORS = ['1', 'true', 'yes'].includes(String(process.env.COPY_INPUT_TO_CREATORS || '').toLowerCase());
const CLEAR_AUTH = authConfig.clearAuth;
const USER_ID = authConfig.userId;
const MANIFEST_PATH = process.env.MANIFEST_PATH || '';
const BATCH_NUMBER = Number(process.env.BATCH_NUMBER || 0);
const CLOSE_AFTER_SEND = ['1', 'true', 'yes'].includes(String(process.env.CLOSE_AFTER_SEND || '').toLowerCase());
const CLOSE_COUNTDOWN_MS = Number(process.env.CLOSE_COUNTDOWN_MS || 5000);
const BATCH_LIST = process.env.BATCH_LIST || '';
/** 与 MANIFEST_PATH 联用：按顺序跑 manifest 中所有 status 为 pending 的批次（同一浏览器会话，批次间点「达人推广」） */
const CHAIN_PENDING = ['1', 'true', 'yes'].includes(String(process.env.CHAIN_PENDING || '').toLowerCase());
const REUSE_CONTEXT = ['1', 'true', 'yes'].includes(String(process.env.REUSE_CONTEXT || '').toLowerCase()) || !!BATCH_LIST || CHAIN_PENDING;
const STOP_ON_FAIL = ['1', 'true', 'yes'].includes(String(process.env.STOP_ON_FAIL || '').toLowerCase());
/** 发送后界面常会跳到「已发送」，在该视图里扫列表校验批量任务不可靠；默认关闭，仅依赖 toast / MutationObserver */
const VERIFY_SEND_RECORD = ['1', 'true', 'yes'].includes(String(process.env.VERIFY_SEND_RECORD || '').toLowerCase());
// ============================

const { chromium } = require('playwright');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getPage(context) {
  const pages = context.pages();
  if (pages.length > 0) {
    return pages[0];
  }
  return await context.newPage();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getRecentTimeTokens(dateInput = new Date()) {
  const base = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(base.getTime())) {
    return [];
  }

  const tokens = new Set(['今天', '刚刚', '分钟前']);
  const minuteOffsets = [-1, 0, 1, 2];
  for (const offset of minuteOffsets) {
    const point = new Date(base.getTime() + offset * 60 * 1000);
    tokens.add(`${pad2(point.getHours())}:${pad2(point.getMinutes())}`);
    tokens.add(`${pad2(point.getMonth() + 1)}-${pad2(point.getDate())}`);
    tokens.add(`${point.getFullYear()}-${pad2(point.getMonth() + 1)}-${pad2(point.getDate())}`);
  }

  return Array.from(tokens).map(normalizeText).filter(Boolean);
}

async function persistAuthSnapshot(context) {
  await context.storageState({ path: STATE_PATH });
  const cookies = await context.cookies();
  fs.writeFileSync(authConfig.cookiePath, JSON.stringify(cookies, null, 2));
  console.log(`💾 已后置保存登录状态: ${STATE_PATH}`);
  console.log(`💾 已后置保存 cookies: ${authConfig.cookiePath}`);
}

async function hydrateCookies(context) {
  if (!fs.existsSync(authConfig.cookiePath)) {
    return;
  }
  try {
    const cookies = JSON.parse(fs.readFileSync(authConfig.cookiePath, 'utf8'));
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return;
    }
    await context.addCookies(cookies);
    console.log(`🍪 已加载历史 cookies: ${cookies.length} 条`);
  } catch (error) {
    console.log(`⚠️ cookies 加载失败，忽略并继续: ${error.message}`);
  }
}

function updateManifestStatus(status, extra = {}) {
  if (!MANIFEST_PATH || !BATCH_NUMBER) {
    return;
  }
  const manifest = readManifest(MANIFEST_PATH);
  if (!manifest) {
    return;
  }
  updateBatchStatus(manifest, BATCH_NUMBER, status, extra);
  writeManifest(MANIFEST_PATH, manifest);
}

function updateManifestStatusForBatch(batchNumber, status, extra = {}) {
  if (!MANIFEST_PATH || !batchNumber) {
    return;
  }
  const manifest = readManifest(MANIFEST_PATH);
  if (!manifest) {
    return;
  }
  updateBatchStatus(manifest, batchNumber, status, extra);
  writeManifest(MANIFEST_PATH, manifest);
}

function appendPendingBatchesAfterCurrent(batchNumbers, currentBatch) {
  if (!MANIFEST_PATH || BATCH_LIST || CHAIN_PENDING) {
    return [];
  }

  const manifest = readManifest(MANIFEST_PATH);
  if (!manifest || !Array.isArray(manifest.batches) || manifest.batches.length === 0) {
    return [];
  }

  const currentIndex = manifest.batches.findIndex(batch => batch.batchNumber === Number(currentBatch));
  const trailingBatches = currentIndex >= 0
    ? manifest.batches.slice(currentIndex + 1)
    : manifest.batches;

  const appended = trailingBatches
    .filter(batch => batch.status === 'pending')
    .map(batch => batch.batchNumber)
    .filter(batchNumber => !batchNumbers.includes(batchNumber));

  if (appended.length > 0) {
    batchNumbers.push(...appended);
  }

  return appended;
}

function listXlsxInDir(dirPath) {
  try {
    return fs.readdirSync(dirPath)
      .filter(name => name.toLowerCase().endsWith('.xlsx'))
      .filter(name => !name.startsWith('~$'))
      .map(name => path.join(dirPath, name));
  } catch {
    return [];
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resolveInputFile() {
  if (INPUT_DIR) {
    const files = listXlsxInDir(INPUT_DIR);
    if (files.length === 0) {
      throw new Error(`INPUT_DIR 无可用 .xlsx 文件: ${INPUT_DIR}`);
    }
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0];
  }
  return XLSX_FILE;
}

function prepareInputFile(srcPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`XLSX 文件不存在: ${srcPath}`);
  }
  ensureDir(CREATORS_DIR);
  const base = path.basename(srcPath);
  let dest = path.join(CREATORS_DIR, base);
  if (path.resolve(srcPath) === path.resolve(dest)) {
    return dest;
  }
  if (fs.existsSync(dest) && !ALLOW_OVERWRITE) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(base);
    const name = path.basename(base, ext);
    dest = path.join(CREATORS_DIR, `${name}-${ts}${ext}`);
  }
  fs.copyFileSync(srcPath, dest);
  return dest;
}

async function clickMailLeftTabByText(page, label) {
  const tab = page.locator('.mail-left .main-left-tab', { hasText: label }).first();
  await tab.waitFor({ state: 'visible', timeout: 20000 });
  await tab.click();
  await page.waitForTimeout(1500);
}

/** 进入「指定达人」上传流：先进入邮件域并点左侧「达人推广」，再点「指定达人」（首批 goto 后也同样先达人推广） */
async function enterSpecifyCreatorsFlow(page, batchIndex) {
  console.log('[步骤1] 进入「指定达人」页面');
  const goDarenTuiguang = async (afterGotoRecovery) => {
    console.log('  [导航] 点击左侧「达人推广」');
    try {
      await clickMailLeftTabByText(page, '达人推广');
    } catch (err) {
      if (afterGotoRecovery) {
        console.log(`  [提示] 「达人推广」未点到（${err.message}），继续尝试「指定达人」`);
        return;
      }
      console.log(`  [回退] 「达人推广」不可用（${err.message}），改用完整打开邮件页`);
      await page.goto(PROBOOST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(8000);
      await goDarenTuiguang(true);
    }
  };

  if (REUSE_CONTEXT && batchIndex > 0) {
    // 发送后常落在「已发送」等视图；不先回邮件根 URL 时，中心区域可能仍停留在邮件列表，「去发邮件」不出现或一直禁用
    console.log('  [导航] 回到邮件首页（清除「已发送」等视图状态）');
    await page.goto(PROBOOST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await goDarenTuiguang(true);
  } else {
    await page.goto(PROBOOST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    await goDarenTuiguang(true);
  }
  console.log('  [导航] 点击「指定达人」');
  const clickSpecify = async () => {
    await page.waitForFunction(() => {
      const text = document.body?.innerText || '';
      return text.includes('指定达人');
    }, { timeout: 120000 });
    await page.locator('text=指定达人').first().click();
  };
  try {
    await clickSpecify();
  } catch {
    try {
      await page.locator('text=达人广场').first().click({ timeout: 5000 });
      await page.waitForTimeout(1500);
    } catch {
      // ignore
    }
    await clickSpecify();
  }
  await page.waitForTimeout(3000);
}

async function waitForImportReady(page, timeout = 120000) {
  const outcome = await waitForImportOutcome(page, timeout);
  if (outcome === 'ready') return;
  if (outcome === 'zero-reachable') {
    throw new Error('IMPORT_ZERO_REACHABLE');
  }
}

async function waitForImportOutcome(page, timeout = 120000) {
  // 等待页面出现「选择」按钮，或导入弹窗明确提示可触达为 0 位。
  return await page.waitForFunction(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const getReachableCount = (compactText) => {
      const matches = Array.from(compactText.matchAll(/可触达(?:达人)?(?:为|:|：)?(\d+)位/g));
      for (const match of matches) {
        const previous = compactText[match.index - 1] || '';
        if (previous === '不') continue;
        return Number(match[1]);
      }
      return null;
    };
    const text = normalize(document.body?.innerText || '');
    const reachableCount = getReachableCount(text);
    if (reachableCount === 0) {
      return 'zero-reachable';
    }
    if (reachableCount > 0) {
      return 'ready';
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(b => (b.innerText || '').trim() === '选择') ? 'ready' : false;
  }, { timeout }).then(handle => handle.jsonValue());
}

async function uploadFileAutomatically(page, inputFile) {
  const uploadButton = page.locator('button:has-text("上传附件")').first();
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
  await uploadButton.click();
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(inputFile);
    return;
  }

  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count().catch(() => 0);
  if (count === 0) {
    throw new Error('未找到文件上传控件 input[type=file]');
  }
  await fileInputs.nth(count - 1).setInputFiles(inputFile);
}

async function waitForTableStable(page) {
  await page.waitForFunction(() => {
    const spinning = document.querySelector('.ant-spin-spinning');
    if (spinning) return false;
    const rows = document.querySelectorAll('table tbody tr');
    return rows.length > 0;
  }, { timeout: 30000 });
}

async function countSelectableButtons(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button'))
      .filter(button => (button.innerText || '').trim() === '选择')
      .length;
  });
}

async function armFreshSuccessSignal(page, successText = SEND_SUCCESS_TEXT) {
  await page.evaluate((expectedText) => {
    const key = '__proboostSendSignal';
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const matchesText = (text, scopedText) => {
      const normalized = normalize(text);
      if (!normalized) return false;
      return normalized.includes(scopedText) || normalized.includes('发送成功');
    };
    const countMatches = (scopedText) => {
      return Array.from(document.querySelectorAll('.ant-message-success, .ant-notification-notice-success'))
        .filter(node => matchesText(node.innerText || node.textContent || '', scopedText))
        .length;
    };
    const scopedText = normalize(expectedText);

    if (window[key]?.observer) {
      window[key].observer.disconnect();
    }

    const state = {
      armedAt: Date.now(),
      baselineCount: countMatches(scopedText),
      triggeredAt: 0,
      reason: '',
      text: '',
      successText: scopedText,
      observer: null,
    };

    const markTriggered = (reason, text = '') => {
      if (state.triggeredAt) return;
      state.triggeredAt = Date.now();
      state.reason = reason;
      state.text = normalize(text);
    };

    const observer = new MutationObserver((mutations) => {
      if (state.triggeredAt) return;

      const nextCount = countMatches(state.successText);
      if (nextCount > state.baselineCount) {
        markTriggered('count-increase');
        return;
      }

      for (const mutation of mutations) {
        const nodes = [];
        if (mutation.type === 'childList') {
          nodes.push(...mutation.addedNodes);
        } else if (mutation.target) {
          nodes.push(mutation.target);
        }

        for (const node of nodes) {
          if (!node) continue;

          if (node.nodeType === Node.TEXT_NODE) {
            if (matchesText(node.textContent || '', state.successText)) {
              markTriggered('text-node', node.textContent || '');
              return;
            }
            continue;
          }

          if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
          }

          const text = node.innerText || node.textContent || '';
          if (matchesText(text, state.successText)) {
            markTriggered('element-text', text);
            return;
          }

          if (typeof node.querySelectorAll === 'function') {
            const successNode = Array.from(
              node.querySelectorAll('.ant-message-success, .ant-notification-notice-success')
            ).find(item => matchesText(item.innerText || item.textContent || '', state.successText));
            if (successNode) {
              markTriggered('success-node', successNode.innerText || successNode.textContent || '');
              return;
            }
          }
        }
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    state.observer = observer;
    window[key] = state;
  }, successText);
}

async function clearFreshSuccessSignal(page) {
  await page.evaluate(() => {
    const key = '__proboostSendSignal';
    if (window[key]?.observer) {
      window[key].observer.disconnect();
    }
    delete window[key];
  }).catch(() => {});
}

async function waitForFreshSendSuccess(page, timeout = SEND_SUCCESS_TIMEOUT) {
  try {
    await page.waitForFunction(() => {
      return Boolean(window.__proboostSendSignal?.triggeredAt);
    }, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function getTotalCount(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('.ant-pagination-total-text');
    if (!el) return null;
    const text = el.innerText || '';
    const m = text.match(/共\s*(\d+)\s*条/);
    if (m && m[1]) return parseInt(m[1], 10);
    const fallback = text.match(/(\d+)/);
    if (!fallback || !fallback[1]) return null;
    return parseInt(fallback[1], 10);
  });
}

async function goToFirstPage(page) {
  await page.evaluate(() => {
    const first = document.querySelector('.ant-pagination-item-1');
    if (first && !first.classList.contains('ant-pagination-item-active')) {
      const target = first.querySelector('a') || first;
      target.click();
    }
  });
  await page.waitForTimeout(1200);
}

/**
 * 打开分页尺寸下拉，读出全部可见选项，选最接近 preferredSize 且 <= preferredSize 的最大值。
 * 避免"逐个候选试到能命中就返回"导致 fallback 到 10 的问题。
 */
async function setPageSize(page, preferredSize = PAGE_SIZE) {
  const triggerSelectors = [
    '.ant-pagination-options-size-changer .ant-select-selector',
    '.ant-pagination-options-size-changer',
    '.ant-pagination-options .ant-select-selector',
  ];

  for (const selector of triggerSelectors) {
    const trigger = page.locator(selector).first();
    const visible = await trigger.isVisible().catch(() => false);
    if (!visible) continue;

    // 检查当前已选值，如果已经是 preferredSize 就直接返回
    const currentText = await trigger.evaluate(el => {
      const item = el.querySelector('.ant-select-selection-item') || el;
      return (item.innerText || item.textContent || '').replace(/\s+/g, '').trim();
    }).catch(() => '');
    if (currentText && currentText.includes(String(preferredSize))) {
      return preferredSize;
    }

    // 打开下拉
    await trigger.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);

    // 读出全部可见选项，解析出数字
    const chosen = await page.evaluate((preferred) => {
      const normalize = (v) => String(v || '').replace(/\s+/g, '').trim();
      const dropdowns = Array.from(document.querySelectorAll(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden)'
      ));
      const allOptions = dropdowns.flatMap(d =>
        Array.from(d.querySelectorAll('.ant-select-item-option'))
      );
      if (allOptions.length === 0) return null;

      // 解析每个选项的数值
      const parsed = allOptions.map(opt => {
        const text = normalize(opt.innerText || opt.textContent || opt.getAttribute('title') || '');
        const m = text.match(/^(\d+)/);
        return m ? { num: parseInt(m[1], 10), el: opt } : null;
      }).filter(Boolean);
      if (parsed.length === 0) return null;

      // 找 <= preferred 中最大的；若没有则取所有选项中最大的
      const candidates = parsed.filter(x => x.num <= preferred);
      const best = candidates.length > 0
        ? candidates.reduce((a, b) => (a.num >= b.num ? a : b))
        : parsed.reduce((a, b) => (a.num >= b.num ? a : b));

      best.el.scrollIntoView({ block: 'center', inline: 'nearest' });
      best.el.click();
      return best.num;
    }, preferredSize).catch(() => null);

    if (chosen) {
      await page.waitForTimeout(800);
      return chosen;
    }

    // 如果下拉未弹出，按 Escape 关掉并换下一个 selector
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  return null;
}

async function probeGoSendMailButton(page) {
  return page.evaluate(() => {
    const normalize = (t) => String(t || "").replace(/\s+/g, "").trim();
    const isDisabledLike = (el) => {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute("aria-disabled") === "true") return true;
      if (el.classList.contains("ant-btn-disabled")) return true;
      return false;
    };
    const buttons = Array.from(document.querySelectorAll("button"));
    const match = buttons.find((b) => normalize(b.innerText || b.textContent || "").includes("去发邮件"));
    if (!match) return "missing";
    return isDisabledLike(match) ? "disabled" : "ready";
  });
}

/**
 * 全选后「去发邮件」可能在视口外，或文案含空白；严格 innerText=== 会导致点不到且无日志
 */
async function waitAndClickGoSendMail(page, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let lastProbe = "missing";
  while (Date.now() < deadline) {
    lastProbe = await probeGoSendMailButton(page).catch(() => "missing");
    const clickedEval = await page.evaluate(() => {
      const normalize = (t) => String(t || "").replace(/\s+/g, "").trim();
      const isDisabledLike = (el) => {
        if (!el) return true;
        if (el.disabled) return true;
        if (el.getAttribute("aria-disabled") === "true") return true;
        if (el.classList.contains("ant-btn-disabled")) return true;
        return false;
      };
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) => normalize(b.innerText || b.textContent || "").includes("去发邮件"));
      if (!target || isDisabledLike(target)) return false;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.click();
      return true;
    }).catch(() => false);
    if (clickedEval) {
      console.log("  ✅ 已点击「去发邮件」");
      return;
    }
    const loc = page.getByRole("button", { name: /去\s*发\s*邮\s*件/ }).first();
    const vis = await loc.isVisible().catch(() => false);
    if (vis) {
      const disabled = await loc.isDisabled().catch(() => true);
      if (!disabled) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 5000 }).catch(() => {});
        console.log("  ✅ 已通过无障碍角色点击「去发邮件」");
        return;
      }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`「去发邮件」在 ${timeout}ms 内不可点（最后探测: ${lastProbe}）`);
}

async function tryConfirmSend(page) {
  const deadline = Date.now() + SEND_CONFIRM_TIMEOUT;
  while (Date.now() < deadline) {
    // 直接在页面里优先匹配“确认发送”弹窗，兼容「确 定」这种带空格按钮文案
    const clickedInPage = await page.evaluate((texts) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const wraps = Array.from(document.querySelectorAll('.ant-modal-wrap'))
        .filter(wrap => !wrap.classList.contains('ant-modal-wrap-hidden') && isVisible(wrap));
      wraps.reverse(); // 优先最上层弹窗

      for (const wrap of wraps) {
        const modal = wrap.querySelector('.ant-modal');
        if (!modal) continue;
        const modalText = normalize(modal.innerText || modal.textContent || '');
        const isSendConfirmModal = modalText.includes('确认发送') || modalText.includes('是否确认发送邮件');
        if (!isSendConfirmModal) continue;

        const buttons = Array.from(modal.querySelectorAll('.ant-modal-footer button')).filter(isVisible);

        if (isSendConfirmModal && /本次操作将发送0封邮件|发送0封邮件|将发送0封邮件/.test(modalText)) {
          const cancelBtn = buttons.find(button => {
            const text = normalize(button.innerText || button.textContent || '');
            const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
            return !disabled && (text.includes('取消') || text.includes('关闭'));
          });
          const closeBtn = modal.querySelector('.ant-modal-close');
          if (cancelBtn) cancelBtn.click();
          else if (closeBtn) closeBtn.click();
          return 'zero-send';
        }

        const primaryBtn = buttons.find(button =>
          button.classList.contains('ant-btn-primary')
          && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true'
        );
        if (primaryBtn) {
          primaryBtn.click();
          return true;
        }

        const textBtn = buttons.find(button => {
          const text = normalize(button.innerText || button.textContent || '');
          if (!text) return false;
          const textMatch = text.includes('确定') || texts.some(item => text.includes(normalize(item)));
          const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
          return textMatch && !disabled;
        });
        if (textBtn) {
          textBtn.click();
          return true;
        }
      }

      return false;
    }, CONFIRM_TEXTS).catch(() => false);
    if (clickedInPage) {
      return true;
    }

    const modalWrap = page.locator('.ant-modal-wrap:not(.ant-modal-wrap-hidden)').last();
    const modalVisible = await modalWrap.isVisible().catch(() => false);
    if (!modalVisible) {
      await page.waitForTimeout(300);
      continue;
    }

    const modal = modalWrap.locator('.ant-modal').first();
    const primaryBtn = modal.locator('button.ant-btn-primary:not(.ant-btn-disabled)');
    if (await primaryBtn.count().catch(() => 0)) {
      await primaryBtn.first().click({ timeout: 3000 }).catch(() => {});
      return true;
    }

    for (const text of CONFIRM_TEXTS) {
      const btn = modal.locator(`button:has-text("${text}")`).first();
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const disabled = await btn.isDisabled().catch(() => true);
      if (disabled) continue;
      await btn.click({ timeout: 3000 }).catch(() => {});
      return true;
    }

    const fallback = modal.getByRole('button', { name: /确\s*定/i }).first();
    const okVisible = await fallback.isVisible().catch(() => false);
    if (okVisible && !(await fallback.isDisabled().catch(() => true))) {
      await fallback.click({ timeout: 3000 }).catch(() => {});
      return true;
    }

    await page.waitForTimeout(300);
  }

  return false;
}

async function waitForSendSuccess(page, timeout = SEND_SUCCESS_TIMEOUT) {
  try {
    await page.waitForFunction((successText) => {
      const body = document.body;
      if (!body) return false;
      const text = body.innerText || '';
      const hasToast = !!document.querySelector('.ant-message-success, .ant-notification-notice-success');
      return hasToast || text.includes(successText);
    }, { timeout }, SEND_SUCCESS_TEXT);
    return true;
  } catch {
    return false;
  }
}

async function showCloseCountdownNotice(page, milliseconds) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  await page.evaluate((countdownSeconds) => {
    const id = 'proboost-close-countdown-notice';
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const box = document.createElement('div');
    box.id = id;
    box.style.position = 'fixed';
    box.style.right = '20px';
    box.style.bottom = '20px';
    box.style.zIndex = '999999';
    box.style.padding = '12px 16px';
    box.style.borderRadius = '10px';
    box.style.background = 'rgba(0,0,0,0.85)';
    box.style.color = '#fff';
    box.style.fontSize = '14px';
    box.style.lineHeight = '1.4';
    box.style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
    box.innerText = `✅ 已发送完成，进程将在 ${countdownSeconds} 秒后自动关闭`;
    document.body.appendChild(box);
  }, seconds).catch(() => {});
}

async function dismissModalIfPresent(page) {
  const modalWrap = page.locator('.ant-modal-wrap');
  const visible = await modalWrap.first().isVisible().catch(() => false);
  if (!visible) return false;

  const closeBtn = page.locator('.ant-modal-close').first();
  if (await closeBtn.count().catch(() => 0)) {
    await closeBtn.click().catch(() => {});
    return true;
  }

  const texts = ['确定', '知道了', '关闭', '取消'];
  for (const t of texts) {
    const btn = page.locator(`.ant-modal button:has-text("${t}")`).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click().catch(() => {});
      return true;
    }
  }
  return false;
}

async function closeImportSuccessPopup(page) {
  const hasImportSuccess = await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return text.includes('导入成功') || text.includes('上传成功') || text.includes('导入完成');
  }, { timeout: IMPORT_POPUP_TIMEOUT }).then(() => true).catch(() => false);

  if (!hasImportSuccess) {
    return false;
  }

  const clickedComplete = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    const modals = Array.from(document.querySelectorAll('.ant-modal'));
    for (const modal of modals) {
      const titleText = normalize(modal.querySelector('.ant-modal-body')?.innerText || '');
      if (!titleText.includes('导入完成') && !titleText.includes('列表已实时更新')) {
        continue;
      }
      const buttons = Array.from(modal.querySelectorAll('.ant-modal-footer button'));
      for (const button of buttons) {
        const text = normalize(button.innerText || button.textContent || '');
        if (text === '完成') {
          button.click();
          return true;
        }
      }
    }
    return false;
  }).catch(() => false);
  if (clickedComplete) {
    await page.waitForTimeout(800);
    await page.waitForFunction(() => {
      const wrap = document.querySelector('.ant-modal-wrap');
      return !wrap || wrap.classList.contains('ant-modal-wrap-hidden');
    }, { timeout: 15000 }).catch(() => {});
    await waitForTableStable(page).catch(() => {});
    console.log('✅ 已点击导入成功弹窗「完 成」进入下一页');
    return true;
  }

  for (let i = 0; i < 3; i += 1) {
    const closed = await dismissModalIfPresent(page);
    if (!closed) break;
    await page.waitForTimeout(600);
  }
  console.log('✅ 已自动关闭导入成功弹窗');
  return true;
}

async function isZeroRemainingAfterImport(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (!text) return false;
  const compact = text.replace(/\s+/g, '');
  const matches = Array.from(compact.matchAll(/可触达(?:达人)?(?:为|:|：)?(\d+)位/g));
  for (const match of matches) {
    const previous = compact[match.index - 1] || '';
    if (previous === '不') continue;
    const reachableCount = Number(match[1]);
    if (reachableCount > 0) return false;
    if (reachableCount === 0) return true;
  }
  return false;
}

async function openSendRecordsIfAvailable(page) {
  const candidates = ['发送记录', '邮件记录', '发送历史', '发送列表'];
  for (const label of candidates) {
    const locator = page.locator(`text=${label}`).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    await locator.click().catch(() => {});
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

async function waitForSendButtonToDisappear(page, timeout = 10000) {
  try {
    await page.waitForFunction(() => {
      const isVisibleButton = (button) => {
        if (!button) return false;
        const style = window.getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const buttons = Array.from(document.querySelectorAll('button'));
      return !buttons.some(button => {
        const text = (button.innerText || '').trim();
        return text === '立即发送' && isVisibleButton(button);
      });
    }, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function verifySendRecord(page, { selectedCount = 0, templateName = '', sentAfter = new Date() } = {}) {
  const opened = await openSendRecordsIfAvailable(page);
  if (!opened) return false;

  const scopedTemplateName = normalizeText(templateName);
  const countTokens = selectedCount > 0
    ? [`${selectedCount}`, `${selectedCount}位`, `${selectedCount} 个`, `${selectedCount}人`]
    : [];
  const recentTimeTokens = getRecentTimeTokens(sentAfter);

  const ok = await page.waitForFunction(({ template, counts, timeTokens }) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const hasRecentTime = (text) => {
      return timeTokens.some(token => token && text.includes(token)) || /刚刚|分钟前|今天/.test(text);
    };
    const matchesRecord = (text) => {
      const normalized = normalize(text);
      if (!normalized) return false;

      const hasSuccess = normalized.includes('发送成功') || normalized.includes('发送完成');
      if (!hasSuccess) return false;

      const hasTemplate = template && normalized.includes(template);
      const hasCount = counts.some(token => normalized.includes(normalize(token)));
      if (!hasTemplate && !hasCount) return false;

      return hasRecentTime(normalized);
    };

    const selectors = ['tr', '.ant-table-row', 'li', '.ant-list-item', '.record-item', '.ant-card'];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    return nodes.some(node => matchesRecord(node.innerText || node.textContent || ''));
  }, {
    timeout: 15000,
  }, {
    template: scopedTemplateName,
    counts: countTokens,
    timeTokens: recentTimeTokens,
  }).then(() => true).catch(() => false);
  return ok;
}

async function waitForSendButtonReady(page, timeout = MANUAL_TEMPLATE_TIMEOUT) {
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(button => {
      const text = (button.innerText || '').trim();
      return text === '立即发送' && !button.disabled;
    });
  }, { timeout });
}

async function autoSelectTemplate(page, templateName) {
  const exact = page.locator(`text=${templateName}`).first();
  if (await exact.count().catch(() => 0)) {
    await exact.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const ready = await page.locator('button:has-text("立即发送")').first().isVisible().catch(() => false);
    if (ready) return true;
  }

  const candidates = page.locator(`*:has-text("${templateName}")`);
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 20); i += 1) {
    const item = candidates.nth(i);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) continue;
    await item.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(800);
    const ready = await page.locator('button:has-text("立即发送")').first().isVisible().catch(() => false);
    if (ready) return true;
  }
  return false;
}

async function selectAllAcrossPages(page) {
  await dismissModalIfPresent(page);
  await waitForTableStable(page);
  await goToFirstPage(page);
  await waitForTableStable(page);

  const clickAllSelect = async () => {
    return await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.trim() === '选择');
      btns.forEach(b => b.click());
      return btns.length;
    });
  };

  let pageIndex = 1;
  let total = 0;

  const selectOnPage = async () => {
    await dismissModalIfPresent(page);
    await waitForTableStable(page);
    const before = await countSelectableButtons(page);
    if (before === 0) {
      console.log(`  ℹ️ 第${pageIndex}页没有可选达人`);
      return;
    }
    await clickAllSelect();
    await page.waitForTimeout(800);
    await waitForTableStable(page);
    const after = await countSelectableButtons(page);
    const selected = Math.max(before - after, 0);
    console.log(`  ✅ 第${pageIndex}页选中了 ${selected} 个（点击前 ${before}，剩余 ${after}）`);
    total += selected;
  };

  await selectOnPage();

  while (true) {
    await dismissModalIfPresent(page);
    const nextBtn = page.locator('.ant-pagination-next:not(.ant-pagination-disabled)');
    const hasNext = await nextBtn.count().catch(() => 0);
    if (!hasNext) break;
    await page.evaluate(() => {
      const next = document.querySelector('.ant-pagination-next:not(.ant-pagination-disabled)');
      if (next) {
        const target = next.querySelector('a') || next;
        target.click();
      }
    });
    pageIndex += 1;
    await page.waitForTimeout(1200);
    await selectOnPage();
  }

  await goToFirstPage(page);
  await waitForTableStable(page);
  return total;
}

async function main() {
  console.log('🚀 启动 Proboost 全自动发送...\n');
  console.log(`👤 当前用户: ${USER_ID}`);

  if (CLEAR_AUTH) {
    clearAuthData(authConfig, { includeLegacy: USER_ID === DEFAULT_USER_ID });
    console.log('🧹 已清除该用户本地登录态（profile/state/cookie）');
  }
  ensureAuthDirs(authConfig);

  let context;
  console.log(`ℹ️ 使用独立 profile（后置固化）: ${BROWSER_PROFILE_PATH}`);
  context = await chromium.launchPersistentContext(BROWSER_PROFILE_PATH, {
    headless: false,
    channel: 'msedge',
  });

  const page = await getPage(context);
  let shouldForceClose = false;
  await hydrateCookies(context);

  try {
    const manifest = MANIFEST_PATH ? readManifest(MANIFEST_PATH) : null;
    const batchNumbers = [];
    if (BATCH_LIST) {
      BATCH_LIST.split(',').map(v => v.trim()).filter(Boolean).forEach(v => {
        const n = Number(v);
        if (Number.isFinite(n)) batchNumbers.push(n);
      });
    } else if (CHAIN_PENDING && manifest?.batches?.length) {
      manifest.batches
        .filter(b => b.status === 'pending')
        .sort((a, b) => a.batchNumber - b.batchNumber)
        .forEach(b => batchNumbers.push(b.batchNumber));
      if (batchNumbers.length > 0) {
        console.log(`🔗 CHAIN_PENDING: 将连续处理 ${batchNumbers.length} 个待发送批次 → [${batchNumbers.join(', ')}]`);
      }
    } else if (BATCH_NUMBER) {
      batchNumbers.push(BATCH_NUMBER);
    }
    if (batchNumbers.length === 0) {
      throw new Error('未指定批次（BATCH_NUMBER、BATCH_LIST 或 CHAIN_PENDING+MANIFEST_PATH）');
    }

    for (let idx = 0; idx < batchNumbers.length; idx += 1) {
      const currentBatch = batchNumbers[idx];
      const manifestItem = manifest?.batches?.find(b => b.batchNumber === currentBatch);
      const inputSourceFile = manifestItem?.file || resolveInputFile();
    const inputFile = (MANUAL_UPLOAD || !COPY_INPUT_TO_CREATORS)
      ? inputSourceFile
      : prepareInputFile(inputSourceFile);
    await enterSpecifyCreatorsFlow(page, idx);

    // 2. 上传 xlsx
    console.log('📍 步骤2: 上传达人列表');
    let importZeroReachable = false;
    try {
      if (MANUAL_UPLOAD) {
        console.log('  🖱️ 点击「上传附件」');
        await page.locator('button:has-text("上传附件")').click();
        console.log(`  👆 请手动在文件选择器中打开 creators 并选择文件（建议: ${inputSourceFile}）`);
        console.log(`  ⏳ 等待你完成手动上传（最长 ${Math.ceil(MANUAL_UPLOAD_TIMEOUT / 1000)}s）...`);
        await waitForImportReady(page, MANUAL_UPLOAD_TIMEOUT);
      } else {
        await page.waitForTimeout(1000);
        console.log(`  📤 上传文件: ${inputFile}`);
        await uploadFileAutomatically(page, inputFile);
        console.log(`  ⏳ 等待导入完成（先等待 ${Math.ceil(WAIT_AFTER_IMPORT / 1000)}s，再最多等待 120s）...`);
        // 先按配置等待，再等待「选择」按钮出现（作为导入完成信号）
        await sleep(WAIT_AFTER_IMPORT);
        await waitForImportReady(page);
      }
    } catch (error) {
      if (error.message === 'IMPORT_ZERO_REACHABLE') {
        importZeroReachable = true;
      } else {
        throw error;
      }
    }
  await closeImportSuccessPopup(page);
  const zeroRemaining = importZeroReachable || await isZeroRemainingAfterImport(page);
  if (zeroRemaining) {
    console.log('ℹ️ 导入提示可触达/去重后剩余 0 位，跳过本批次。');
    updateManifestStatusForBatch(currentBatch, 'sent', {
      inputFile,
      sentAt: new Date().toISOString(),
      selectedCount: 0,
      skipped: true,
      reason: importZeroReachable ? 'import-zero-reachable' : 'dedup-zero-remaining',
    });
    const appended = appendPendingBatchesAfterCurrent(batchNumbers, currentBatch);
    if (appended.length > 0) {
      console.log(`ℹ️ 当前批次已跳过，自动继续后续待处理批次: [${appended.join(', ')}]`);
    }
    continue;
  }

    // 3. 尝试设置每页 200（若有）
    const pageSizeSet = await setPageSize(page, PAGE_SIZE);
    if (pageSizeSet) {
      console.log(`  ✅ 已设置每页 ${pageSizeSet} 条`);
      await page.waitForTimeout(1500);
    } else {
      console.log(`  ℹ️ 未找到每页 ${PAGE_SIZE} 相关选项，保持当前分页`);
    }

    // 4. JS 点击所有「选择」按钮（翻页直到最后一页）
    console.log('📍 步骤3: 全选达人');
    const totalExpected = await getTotalCount(page);
    if (totalExpected) {
      console.log(`  📌 列表显示总数: ${totalExpected}`);
    }

    let total = await selectAllAcrossPages(page);
    console.log(`  📊 首轮共选了 ${total} 个达人`);

    // 若未达到总数，强制回到第一页再跑一遍
    if (totalExpected && total < totalExpected) {
      console.log('  ⚠️ 选中数不足，强制回到第一页重新核对...');
      total = await selectAllAcrossPages(page);
      console.log(`  📊 复核后共选了 ${total} 个达人`);
    }

    if (totalExpected && total < totalExpected) {
      updateManifestStatusForBatch(currentBatch, 'failed', {
        inputFile,
        failedAt: new Date().toISOString(),
        selectedCount: total,
        expectedCount: totalExpected,
        reason: 'selected-count-mismatch',
      });
      throw new Error(`选中数不足：期望 ${totalExpected}，实际 ${total}`);
    }

    // 4. 点击「去发邮件」进入编辑器
    console.log('📍 步骤4: 进入邮件编辑器');
    console.log('  🖱️ 等待并点击「去发邮件」');
    await waitAndClickGoSendMail(page);
    await page.waitForTimeout(3000);

    // 5. 选择模板
    console.log('📍 步骤5: 选择模板');
    if (MANUAL_TEMPLATE) {
      console.log(`  👆 请手动选择模板（建议: ${TEMPLATE_NAME}）`);
      console.log(`  ⏳ 等待你完成模板选择（最长 ${Math.ceil(MANUAL_TEMPLATE_TIMEOUT / 1000)}s）...`);
      await waitForSendButtonReady(page, MANUAL_TEMPLATE_TIMEOUT);
      console.log('  ✅ 检测到「立即发送」可点击，模板选择完成');
    } else {
      console.log(`  🖱️ 点击模板「${TEMPLATE_NAME}」`);
      const templateClicked = await autoSelectTemplate(page, TEMPLATE_NAME);
      if (!templateClicked) {
        throw new Error(`未找到模板: ${TEMPLATE_NAME}`);
      }
      await page.waitForTimeout(2000);
    }

    if (PREPARE_ONLY) {
      updateManifestStatusForBatch(currentBatch, 'prepared', { inputFile });
      console.log('📍 步骤6: 准备完成（等待人工发送）');
      console.log('  ⚠️ 请在页面上手动点击「立即发送」并完成确认');
      const manualSendStartedAt = new Date();
      await armFreshSuccessSignal(page);
      const manualToastOk = await waitForFreshSendSuccess(page, MANUAL_SEND_TIMEOUT);
      const manualButtonGone = manualToastOk ? true : await waitForSendButtonToDisappear(page, 10000);
      const manualRecordOk = (!manualToastOk && manualButtonGone && VERIFY_SEND_RECORD)
        ? await verifySendRecord(page, {
          selectedCount: total,
          templateName: TEMPLATE_NAME,
          sentAfter: manualSendStartedAt,
        })
        : false;
      await clearFreshSuccessSignal(page);

      if (manualToastOk || manualRecordOk) {
        updateManifestStatusForBatch(currentBatch, 'sent', {
          inputFile,
          sentAt: new Date().toISOString(),
          selectedCount: total,
          mode: 'manual-confirmed',
          toastOk: manualToastOk,
          recordOk: manualRecordOk,
        });
        console.log(`  ✅ 已检测到人工发送成功（toast=${manualToastOk}, record=${manualRecordOk})`);
      } else {
        console.log('  ⚠️ 在等待窗口内未检测到人工发送成功提示，批次保持 prepared 状态');
      }
    } else {
      // 6. 点击「立即发送」
      console.log('📍 步骤6: 发送邮件');
      console.log('  🖱️ 点击「立即发送」');
      const sendStartedAt = new Date();
      await armFreshSuccessSignal(page);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => (b.innerText || '').trim() === '立即发送');
        if (btns[0]) btns[0].click();
      });
      let confirmed = await tryConfirmSend(page);
      if (!confirmed) {
        // 某些场景确认弹窗会延后渲染，这里再补一次重试
        await page.waitForTimeout(1200);
        confirmed = await tryConfirmSend(page);
      }
      if (confirmed === 'zero-send') {
        console.log('  ℹ️ 确认发送弹窗显示本次将发送 0 封邮件，已关闭弹窗并跳过本批次。');
        await clearFreshSuccessSignal(page);
        updateManifestStatusForBatch(currentBatch, 'sent', {
          inputFile,
          sentAt: new Date().toISOString(),
          selectedCount: 0,
          skipped: true,
          reason: 'send-confirm-zero',
        });
        const appended = appendPendingBatchesAfterCurrent(batchNumbers, currentBatch);
        if (appended.length > 0) {
          console.log(`ℹ️ 当前批次已跳过，自动继续后续待处理批次: [${appended.join(', ')}]`);
        }
        continue;
      }
      if (confirmed) {
        console.log('  ✅ 已自动确认发送');
      }
      const toastOk = await waitForFreshSendSuccess(page);
      const sendButtonGone = toastOk ? true : await waitForSendButtonToDisappear(page, 10000);
      const recordOk = (!toastOk && sendButtonGone && VERIFY_SEND_RECORD)
        ? await verifySendRecord(page, {
          selectedCount: total,
          templateName: TEMPLATE_NAME,
          sentAfter: sendStartedAt,
        })
        : false;
      await clearFreshSuccessSignal(page);
      if (toastOk || recordOk) {
        updateManifestStatusForBatch(currentBatch, 'sent', {
          inputFile,
          sentAt: new Date().toISOString(),
          selectedCount: total,
          toastOk,
          recordOk,
        });
        console.log(`  ✅ 发送判定通过（toast=${toastOk}, record=${recordOk})`);
        if (CLOSE_AFTER_SEND && (!REUSE_CONTEXT || idx === batchNumbers.length - 1)) {
          await showCloseCountdownNotice(page, CLOSE_COUNTDOWN_MS);
          console.log(`  ℹ️ 已弹出关闭提示，${Math.ceil(CLOSE_COUNTDOWN_MS / 1000)} 秒后关闭进程`);
          await page.waitForTimeout(CLOSE_COUNTDOWN_MS);
          shouldForceClose = true;
        }
      } else {
        updateManifestStatusForBatch(currentBatch, 'failed', {
          inputFile,
          failedAt: new Date().toISOString(),
          selectedCount: total,
          reason: 'success-toast-not-found',
        });
        console.log('  ⚠️ 未检测到发送成功提示或记录，可能需要手动确认或查看发送记录');
      }
      await page.waitForTimeout(3000);
    }
    console.log(`\n[批次] ${currentBatch} 完成（进度 ${idx + 1}/${batchNumbers.length}）`);
    if (STOP_ON_FAIL && MANIFEST_PATH) {
      const latest = readManifest(MANIFEST_PATH);
      const batch = latest?.batches?.find(b => b.batchNumber === currentBatch);
      if (batch && batch.status === 'failed') {
        console.log(`[停止] 批次 ${currentBatch} 失败，停止后续批次`);
        break;
      }
    }
    }
    console.log('\n[完成] 全部批次处理结束');
  } catch (error) {
    console.error('❌ 执行出错:', error.message);
    throw error;
  } finally {
    try {
      await persistAuthSnapshot(context);
    } catch (persistError) {
      console.log(`⚠️ 登录状态保存失败: ${persistError.message}`);
    }
    if (shouldForceClose) {
      await context.close();
    } else if (KEEP_BROWSER_OPEN || PREPARE_ONLY) {
      console.log('🔎 保持浏览器打开以便人工确认（KEEP_BROWSER_OPEN=1）');
    } else {
      await context.close();
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
