const config = require('../config');
const { SELECTORS } = require('./selectors');
const {
  clickVisibleExactText,
  findMailTable,
  extractMailRows,
  robustOpenMailRow,
  getMailRowSnapshot,
  openMailRowWithStrategy,
  waitForMailDetail,
  captureDomFailure,
  summarizeDomFailure,
} = require('./domActions');

const CONFIRM_TEXTS = ['确认', '确定'];

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function senderMatchesHandle(sender, handle) {
  return normalizeKey(sender) === normalizeKey(handle);
}

function normalizeCompactText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function replyLikeText(value) {
  return normalizeCompactText(value).includes(SELECTORS.repliedStatus.fuzzyContains || '回复');
}

async function waitForInboxTable(page, timeout = 30000) {
  return Boolean(await findMailTable(page, { timeout }));
}

async function goToMailModule(page) {
  const clicked = await clickVisibleExactText(page, SELECTORS.mailModule.text, SELECTORS.mailModule.variants);
  if (clicked) await page.waitForTimeout(1800);
  return clicked;
}

async function goToInbox(page) {
  try {
    await page.goto(config.proboostUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout });
  } catch (error) {
    const failure = await captureDomFailure(page, 'mailbox-entry-failed', {
      targetUrl: config.proboostUrl,
      error: String(error.message || error),
    });
    throw new Error(`Inbox navigation failed. ${summarizeDomFailure(failure)}; cause=${String(error.message || error)}`);
  }
  await page.waitForTimeout(1800);
  const loginRequired = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return window.location.href.includes('/login')
      || (text.includes('欢迎使用ProBoost.ai') && text.includes('验证码登录'));
  }).catch(() => false);
  if (loginRequired) {
    throw new Error(`ProBoost login required. Open the CRM login action and complete login for profile: ${config.auth.profilePath}`);
  }
  await goToMailModule(page);

  await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const candidates = Array.from(document.querySelectorAll('button, div, span, a'));
    const back = candidates.find(el => normalize(el.innerText || el.textContent || '') === '返回收件箱');
    if (back) back.click();
  }).catch(() => {});
  await page.waitForTimeout(800);

  let clicked = await clickVisibleExactText(page, SELECTORS.inboxTab.text, SELECTORS.inboxTab.variants);

  if (!clicked) {
    clicked = await clickVisibleExactText(page, '收件箱');
  }

  if (!clicked) {
    const inbox = page.locator('text=收件箱').first();
    if (await inbox.isVisible().catch(() => false)) await inbox.click();
  }

  await page.waitForTimeout(2000);
  const ok = await waitForInboxTable(page);
  if (!ok) {
    const failure = await captureDomFailure(page, 'inbox-table-not-ready');
    throw new Error(`Inbox table not ready. ${summarizeDomFailure(failure)}`);
  }
}

async function goToSent(page) {
  await page.goto(config.sentUrl || config.proboostUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout });
  await page.waitForTimeout(1800);

  const clicked = await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const candidates = Array.from(document.querySelectorAll('.mail-left .main-left-tab, .main-left-tab, [class*="left-tab"], nav button, aside button, button, a, div, span'));
    const target = candidates.find(el => normalize(el.innerText || el.textContent || '') === '已发送');
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }).catch(() => false);

  if (!clicked) {
    const sent = page.locator('text=已发送').first();
    if (await sent.isVisible().catch(() => false)) await sent.click();
  }
  await page.waitForTimeout(2000);
}

async function openMailStatusDropdown(page) {
  const opened = await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const selects = Array.from(document.querySelectorAll('.ant-select')).filter(visible);
    const statusSelect = selects.find(item => normalize(item.innerText || item.textContent || '').includes('邮件状态'))
      || selects.find(item => normalize(item.innerText || item.textContent || '').includes('全部'));
    const trigger = statusSelect?.querySelector('.ant-select-selector') || statusSelect;
    if (!trigger) return false;
    trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
    trigger.click();
    return true;
  }).catch(() => false);

  if (!opened) {
    const status = page.locator('span:has-text("邮件状态"), .ant-select').first();
    if (await status.isVisible().catch(() => false)) await status.click();
  }

  await page.waitForTimeout(800);
  return opened || await page.evaluate(() => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).some(visible);
  }).catch(() => false);
}

async function listMailStatusOptions(page) {
  return await page.evaluate(() => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) [role="option"]'))
      .filter(visible)
      .map((option, index) => ({
        index,
        text: String(option.innerText || option.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter(item => item.text)
      .filter((item, index, list) => list.findIndex(other => other.text === item.text) === index);
  }).catch(() => []);
}

async function selectVisibleStatusOption(page, optionText) {
  const clicked = await page.evaluate((label) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) [role="option"], .ant-select-dropdown:not(.ant-select-dropdown-hidden) *'))
      .filter(visible);
    const target = candidates.find(option => normalize(option.innerText || option.textContent || '') === normalize(label));
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, optionText).catch(() => false);
  if (clicked) await page.waitForTimeout(1800);
  return clicked;
}

async function selectMailStatusByCandidates(page, candidates = []) {
  const opened = await openMailStatusDropdown(page);
  const options = opened ? await listMailStatusOptions(page) : [];
  if (!opened && options.length === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'replied-status-filter-not-found', options };
  }

  const normalizedOptions = options.map(option => ({
    ...option,
    compact: normalizeCompactText(option.text),
  }));
  const exactCandidates = candidates.map(normalizeCompactText).filter(Boolean);
  let selected = normalizedOptions.find(option => exactCandidates.includes(option.compact));
  let matchType = 'exact';

  if (!selected) {
    selected = normalizedOptions.find(option => replyLikeText(option.text));
    matchType = 'fuzzy';
  }

  if (!selected) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'replied-status-option-not-found', options };
  }

  const clicked = await selectVisibleStatusOption(page, selected.text);
  if (!clicked) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'replied-status-option-click-failed', options, selected: selected.text };
  }

  return { ok: true, selected: selected.text, matchType, options };
}

async function selectMailStatus(page, statusText) {
  const result = await selectMailStatusByCandidates(page, [statusText]);
  return result.ok;
}

async function tryKnownMailboxRoute(page, mailbox) {
  if (mailbox !== 'replied' || !config.repliedUrl) return { ok: false, reason: 'no-known-route' };
  try {
    await page.goto(config.repliedUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout });
    await page.waitForTimeout(1800);
    const ok = await waitForInboxTable(page, 12000);
    return ok ? { ok: true, strategy: 'known-route', mailbox } : { ok: false, reason: 'route-table-not-found' };
  } catch (error) {
    return { ok: false, reason: 'route-navigation-failed', error: String(error.message || error) };
  }
}

async function enterMailbox(page, options = {}) {
  const mailbox = String(options.mailbox || 'inbox').trim() || 'inbox';
  if (mailbox === 'inbox') {
    await goToInbox(page);
    return { mailbox: 'inbox', strategy: 'inbox' };
  }
  if (mailbox !== 'replied') throw new Error(`unsupported mailbox: ${mailbox}`);

  const route = await tryKnownMailboxRoute(page, mailbox);
  if (route.ok) return route;

  await goToInbox(page);
  const selected = await selectMailStatusByCandidates(page, SELECTORS.repliedStatus.candidates || [SELECTORS.repliedStatus.text]);
  if (!selected.ok) {
    const feature = selected.reason === 'replied-status-filter-not-found'
      ? 'replied-status-filter-not-found'
      : 'replied-status-option-not-found';
    const failure = await captureDomFailure(page, feature, {
      mailbox,
      routeAttempt: route,
      candidates: SELECTORS.repliedStatus.candidates || [SELECTORS.repliedStatus.text],
      options: selected.options || [],
      selected: selected.selected || '',
    });
    if (options.allowFallback !== false) {
      return {
        mailbox: 'inbox',
        requestedMailbox: mailbox,
        mailboxFallback: 'inbox',
        strategy: 'inbox-fallback',
        reason: selected.reason,
        diagnosticPath: failure.jsonPath || '',
        screenshotPath: failure.screenshotPath || '',
        options: selected.options || [],
      };
    }
    throw new Error(`mail status filter failed: ${selected.reason}; ${summarizeDomFailure(failure)}`);
  }

  const ok = await waitForInboxTable(page, 15000);
  if (!ok) {
    const failure = await captureDomFailure(page, 'mail-table-not-found-after-filter', {
      mailbox,
      selected: selected.selected,
      matchType: selected.matchType,
      options: selected.options || [],
    });
    throw new Error(`Replied inbox table not ready. ${summarizeDomFailure(failure)}`);
  }

  return {
    mailbox: 'replied',
    requestedMailbox: mailbox,
    strategy: selected.matchType === 'fuzzy' ? 'status-fuzzy' : 'status-exact',
    selectedStatus: selected.selected,
    statusOptions: selected.options || [],
  };
}

async function enterRepliedInbox(page) {
  return await enterMailbox(page, { mailbox: 'replied' });
}

async function enterInbox(page) {
  await goToInbox(page);
}

async function setPageSize(page, preferredSize = config.pageSize) {
  const changed = await page.evaluate((preferred) => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const trigger = Array.from(document.querySelectorAll('.ant-pagination-options-size-changer .ant-select-selector, .ant-pagination-options-size-changer'))
      .find(visible);
    if (!trigger) return false;
    trigger.click();
    return true;
  }, preferredSize).catch(() => false);

  if (!changed) return null;
  await page.waitForTimeout(500);

  const chosen = await page.evaluate((preferred) => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const options = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'))
      .filter(visible)
      .map(option => {
        const text = (option.innerText || option.textContent || '').replace(/\s+/g, '').trim();
        const match = text.match(/^(\d+)/);
        return match ? { option, size: Number(match[1]) } : null;
      })
      .filter(Boolean);
    if (options.length === 0) return null;
    const candidates = options.filter(item => item.size <= preferred);
    const best = candidates.length > 0
      ? candidates.reduce((a, b) => (a.size >= b.size ? a : b))
      : options[0];
    best.option.click();
    return best.size;
  }, preferredSize).catch(() => null);

  await page.waitForTimeout(1000);
  return chosen;
}

async function goToFirstPage(page) {
  const clicked = await page.evaluate(() => {
    const first = document.querySelector('.ant-pagination-item-1');
    if (!first || first.classList.contains('ant-pagination-item-active')) return false;
    (first.querySelector('a') || first).click();
    return true;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(1200);
  return clicked;
}

async function goToPage(page, targetPage) {
  const pageNumber = Number.parseInt(targetPage, 10) || 1;
  if (pageNumber <= 1) {
    await goToFirstPage(page);
    await waitForInboxTable(page, 10000).catch(() => {});
    return true;
  }

  const clickedNumber = await page.evaluate((target) => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const items = Array.from(document.querySelectorAll('.ant-pagination-item'));
    const item = items.find(node => {
      const title = node.getAttribute('title') || '';
      const text = (node.innerText || node.textContent || '').trim();
      return visible(node) && (title === String(target) || text === String(target));
    });
    if (!item) return false;
    if (item.classList.contains('ant-pagination-item-active')) return true;
    (item.querySelector('a') || item).click();
    return true;
  }, pageNumber).catch(() => false);
  if (clickedNumber) {
    await page.waitForTimeout(1500);
    await waitForInboxTable(page, 10000).catch(() => {});
    return true;
  }

  const jumped = await page.evaluate((target) => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const input = Array.from(document.querySelectorAll('.ant-pagination-options-quick-jumper input, input'))
      .find(node => visible(node) && /页|page|跳至|jump/i.test(node.closest('.ant-pagination')?.innerText || node.placeholder || ''));
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, String(target));
    else input.value = String(target);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  }, pageNumber).catch(() => false);
  if (jumped) {
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1800);
    await waitForInboxTable(page, 10000).catch(() => {});
    return true;
  }

  await goToFirstPage(page);
  for (let i = 1; i < pageNumber; i += 1) {
    const advanced = await goToNextPage(page);
    if (!advanced) return false;
  }
  return true;
}

async function goToNextPage(page) {
  const clicked = await page.evaluate(() => {
    const next = document.querySelector('.ant-pagination-next:not(.ant-pagination-disabled)');
    if (!next) return false;
    (next.querySelector('a') || next).click();
    return true;
  }).catch(() => false);
  if (clicked) {
    await page.waitForTimeout(1500);
    await waitForInboxTable(page, 10000);
  }
  return clicked;
}

async function setSearchValue(page, value) {
  const filled = await page.evaluate((nextValue) => {
    const matchesSearchInput = input => {
      const placeholder = input.getAttribute('placeholder') || '';
      return placeholder.includes('支持邮件达人') || placeholder.includes('搜索') || placeholder.includes('达人');
    };
    const visibleScore = input => {
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
      return visible ? rect.width * rect.height : 0;
    };
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(matchesSearchInput)
      .sort((a, b) => visibleScore(b) - visibleScore(a));
    const searchInput = inputs[0];
    if (!searchInput) return false;

    searchInput.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(searchInput, nextValue);
    else searchInput.value = nextValue;
    searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue, inputType: 'insertText' }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, value).catch(() => false);

  if (filled) return true;
  const input = page.locator('input[type="search"], input[placeholder*="搜索"], input[placeholder*="达人"]').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(value);
  return true;
}

async function clickSearchButton(page) {
  const clicked = await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };

    const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
    const exact = buttons.find(button => {
      const text = normalize(button.innerText || button.textContent || '');
      return text === '搜索' || text === 'search';
    });
    if (exact) {
      exact.click();
      return true;
    }

    const input = Array.from(document.querySelectorAll('input')).find(item => {
      const placeholder = item.getAttribute('placeholder') || '';
      return placeholder.includes('支持邮件达人') || placeholder.includes('搜索') || placeholder.includes('达人');
    });
    const searchBox = input?.closest('.ant-input-group-wrapper, .ant-input-search, [class*="search"]');
    const nearbyButton = searchBox
      ? Array.from(searchBox.querySelectorAll('button.ant-input-search-button, button')).find(visible)
      : null;
    if (nearbyButton) {
      nearbyButton.click();
      return true;
    }
    return false;
  }).catch(() => false);

  if (clicked) return true;
  await page.keyboard.press('Enter').catch(() => {});
  return true;
}

async function extractInboxRows(page) {
  return await extractMailRows(page);
}

async function searchInboxByHandle(page, handle) {
  await goToInbox(page);
  await setSearchValue(page, '');
  await setSearchValue(page, handle);
  await page.waitForTimeout(200);
  await clickSearchButton(page);
  await page.waitForTimeout(2500);
  await waitForInboxTable(page, 10000);
  const rows = await extractInboxRows(page);
  const exactRows = rows.filter(row => senderMatchesHandle(row.sender, handle));
  return {
    handle,
    rows,
    exactRows,
    resultCount: rows.length,
    exactCount: exactRows.length,
  };
}

async function clickInboxRow(page, rowIndex) {
  return await robustOpenMailRow(page, rowIndex, {
    cellOrders: [[1, 2], [2, 1], [0, 1, 2]],
    waitAfterMs: 1200,
  });
}

async function clickInboxRowInMailTable(page, rowIndex, cellOrder = [1, 2]) {
  return await robustOpenMailRow(page, rowIndex, {
    cellOrders: [cellOrder],
    waitAfterMs: 1500,
  });
}

async function waitForEmailDetail(page, row, timeout = 12000, startUrl = '') {
  return await waitForMailDetail(page, row, { timeout, startUrl });
}

async function openInboxResult(page, row) {
  const beforeUrl = page.url();
  const attempts = [
    { strategy: 'dom-known-cell', cellOrder: [1, 2] },
    { strategy: 'dom-known-cell', cellOrder: [2, 1] },
    { strategy: 'mouse-cell-center', cellOrder: [1, 2] },
    { strategy: 'double-click-row-center', cellOrder: [1, 2] },
    { strategy: 'focus-enter', cellOrder: [1, 2] },
    { strategy: 'click-pointer-ancestor', cellOrder: [1, 2] },
    { strategy: 'href-navigate', cellOrder: [1, 2] },
  ];
  const failures = [];

  for (const attempt of attempts) {
    const opened = await openMailRowWithStrategy(page, row.rowIndex, attempt.strategy, {
      cellOrder: attempt.cellOrder,
      waitAfterMs: 1200,
    });
    const detailReady = opened.ok ? await waitForEmailDetail(page, row, 12000, beforeUrl) : false;
    if (detailReady) {
      return {
        ok: true,
        openStrategy: attempt.strategy,
        urlBefore: beforeUrl,
        urlAfter: page.url(),
      };
    }
    failures.push({
      strategy: attempt.strategy,
      reason: opened.reason || (opened.ok ? 'detail-not-ready' : 'open-failed'),
      urlAfter: page.url(),
    });
    if (page.url() !== beforeUrl) {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout }).catch(() => {});
      await waitForInboxTable(page, 8000).catch(() => {});
    }
  }

  const rowSnapshot = await getMailRowSnapshot(page, row.rowIndex).catch(() => null);
  const failure = await captureDomFailure(page, 'email-detail-open-failed', {
    row,
    rowSnapshot,
    urlBefore: beforeUrl,
    urlAfter: page.url(),
    attempts: failures,
  });
  throw new Error(`email detail did not open; row=${row.rowIndex}; sender=${row.sender || ''}; subject=${row.subject || ''}; ${summarizeDomFailure(failure)}`);
}

async function reopenInboxResult(page, row, pageIndex = 1) {
  try {
    return await openInboxResult(page, row);
  } catch (firstError) {
    await enterRepliedInbox(page);
    await goToPage(page, pageIndex);
    try {
      return await openInboxResult(page, row);
    } catch (secondError) {
      secondError.message = `${secondError.message}; firstAttempt=${firstError.message}`;
      throw secondError;
    }
  }
}

async function extractOpenedThreadText(page) {
  return await page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function fillInviteCodeInput(page, inviteCode) {
  if (!inviteCode) return false;
  return await page.evaluate((code) => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const target = inputs.find(input => {
      const placeholder = input.getAttribute('placeholder') || '';
      const label = input.closest('.ant-form-item')?.innerText || '';
      return /邀请码|invite|code/i.test(`${placeholder} ${label}`);
    }) || inputs[0];
    if (!target) return false;
    target.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(target, code);
    else target.value = code;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, data: code, inputType: 'insertText' }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, inviteCode).catch(() => false);
}

async function clickReplyButton(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const normalize = value => String(value || '').replace(/\s+/g, '').trim();
      const visible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.width > 0
          && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .filter(visible)
        .map(element => ({ element, text: normalize(element.innerText || element.textContent || ''), y: element.getBoundingClientRect().top }))
        .filter(item => item.text === '回复' || item.text === '回复邮件');
      if (candidates.length === 0) return false;
      const target = candidates.sort((a, b) => b.y - a.y)[0].element;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.click();
      return true;
    }).catch(() => false);
    if (clicked) return true;
    await page.mouse.wheel(0, 1000).catch(() => {});
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForReplyForm(page, templateName, timeout = 15000) {
  return await page.waitForFunction((name) => {
    const text = document.body?.innerText || '';
    return text.includes('邮件回复') || (text.includes('模板') && text.includes(name)) || text.includes('立即发送');
  }, templateName, { timeout }).then(() => true).catch(() => false);
}

async function getReplyComposerState(page, templateName = '') {
  return await page.evaluate((name) => {
    const compact = value => String(value || '').replace(/\s+/g, '').trim();
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const radioItems = Array.from(document.querySelectorAll('.template-selector-item-label, .ant-radio-label'))
      .filter(visible)
      .map(label => {
        const wrapper = label.closest('label, .ant-radio-wrapper') || label.parentElement;
        const input = wrapper?.querySelector('input[type="radio"]');
        return {
          text: normalize(label.innerText || label.textContent || ''),
          checked: Boolean(input?.checked)
            || Boolean(wrapper?.classList.contains('ant-radio-wrapper-checked'))
            || Boolean(wrapper?.querySelector('.ant-radio-checked')),
          classes: wrapper?.className || '',
        };
      });
    const selectedTemplate = radioItems.find(item => item.checked)?.text || '';
    const targetTemplate = radioItems.find(item => compact(item.text) === compact(name)) || null;
    const subjects = Array.from(document.querySelectorAll('input, textarea'))
      .filter(visible)
      .map(input => normalize(input.value || input.getAttribute('value') || input.placeholder || ''))
      .filter(Boolean)
      .slice(0, 10);
    const editors = Array.from(document.querySelectorAll('.ql-editor, [contenteditable="true"]'))
      .filter(visible)
      .map(element => {
        const quill = element.__quill
          || element.closest('.ql-container')?.__quill
          || (window.Quill?.find ? window.Quill.find(element.closest('.ql-container') || element) : null);
        return normalize(quill?.getText?.() || element.innerText || element.textContent || '');
      })
      .filter(Boolean)
      .slice(0, 6);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map(button => ({
        text: normalize(button.innerText || button.textContent || ''),
        disabled: Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true',
        classes: button.className || '',
      }))
      .filter(item => item.text)
      .slice(0, 80);
    const dialogs = Array.from(document.querySelectorAll('.ant-modal, .ant-popover, .ant-popconfirm, .swal2-popup, .swal-modal, [role="dialog"]'))
      .filter(visible)
      .map(dialog => normalize(dialog.innerText || dialog.textContent || '').slice(0, 400))
      .filter(Boolean)
      .slice(0, 10);
    return {
      targetTemplate: name,
      selectedTemplate,
      targetTemplateState: targetTemplate,
      radioItems,
      subjects,
      editorPreviews: editors.map(text => text.slice(0, 500)),
      buttons,
      dialogs,
      url: window.location.href,
    };
  }, templateName).catch(error => ({ error: String(error.message || error), targetTemplate: templateName }));
}

async function captureReplyCheckpoint(page, feature, metadata = {}) {
  if (!['1', 'true', 'yes', 'on'].includes(String(process.env.AUTOMATION_DEBUG || '').toLowerCase())) return null;
  const state = await getReplyComposerState(page, metadata.templateName || '');
  const capture = await captureDomFailure(page, feature, {
    ...metadata,
    replyComposerState: state,
  });
  console.log(`  🧭 自动化观测: ${feature}; screenshot=${capture.screenshotPath || 'none'}; diagnostic=${capture.jsonPath || 'none'}`);
  return capture;
}

async function selectTemplate(page, templateName, rendered = null) {
  await page.waitForFunction((name) => {
    const text = document.body?.innerText || '';
    return text.includes(name) && (text.includes('模板') || text.includes('立即发送'));
  }, templateName, { timeout: 10000 }).catch(() => {});

  const radioClicked = await clickTemplateRadio(page, templateName);
  if (radioClicked) {
    await page.waitForTimeout(1800);
    if (await waitForTemplateApplied(page, templateName, rendered, 7000)) {
      return { ok: true, strategy: radioClicked };
    }
  }

  const textClicked = await clickTemplateByVisibleText(page, templateName);
  if (textClicked) {
    await page.waitForTimeout(1200);
    if (await waitForTemplateApplied(page, templateName, rendered, 7000)) return { ok: true, strategy: textClicked };
  }

  const dropdownClicked = await clickTemplateFromDropdown(page, templateName);
  if (dropdownClicked) {
    await page.waitForTimeout(1400);
    if (await waitForTemplateApplied(page, templateName, rendered, 7000)) return { ok: true, strategy: dropdownClicked };
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await toggleAwayFromTemplate(page, templateName);
    await page.waitForTimeout(600);
    const retryStrategy = await clickTemplateRadio(page, templateName)
      || await clickTemplateByVisibleText(page, templateName);
    if (!retryStrategy) continue;
    await page.waitForTimeout(1600);
    if (await waitForTemplateApplied(page, templateName, rendered, 9000)) {
      return { ok: true, strategy: `${retryStrategy}-retry-${attempt}` };
    }
  }

  return { ok: false, strategy: '' };
}

async function clickTemplateRadio(page, templateName) {
  const clickPoint = await page.evaluate((name) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const label = Array.from(document.querySelectorAll('.template-selector-item-label, .ant-radio-label'))
      .find(element => visible(element) && normalize(element.innerText || element.textContent || '') === normalize(name));
    if (!label) return null;
    const wrapper = label.closest('label, .ant-radio-wrapper') || label.parentElement;
    const radio = wrapper?.querySelector('.ant-radio-inner, .ant-radio, input[type="radio"]');
    const clickTarget = radio && visible(radio) ? radio : wrapper;
    if (!clickTarget || !visible(clickTarget)) return null;
    clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = clickTarget.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: 'radio-label' };
  }, templateName).catch(() => null);

  if (clickPoint?.x && clickPoint?.y) {
    await page.mouse.click(clickPoint.x, clickPoint.y);
    return clickPoint.strategy;
  }

  const wrapper = page.locator('.ant-radio-wrapper').filter({ hasText: templateName }).first();
  if (!await wrapper.isVisible().catch(() => false)) return '';
  const box = await wrapper.locator('.ant-radio-inner, .ant-radio, input[type="radio"]').first().boundingBox().catch(() => null);
  if (!box) return '';
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return 'radio-locator';
}

async function waitForTemplateApplied(page, templateName, rendered = null, timeout = 7000) {
  const subject = rendered?.subject || '';
  const body = rendered?.body || '';
  return await page.waitForFunction(({ name, subjectText, bodyText }) => {
    const compact = value => String(value || '').replace(/\s+/g, '').trim();
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const sendButtonReady = Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .some(button => compact(button.innerText || button.textContent || '') === '立即发送' && !button.disabled);
    const labels = Array.from(document.querySelectorAll('.template-selector-item-label, .ant-radio-label'))
      .filter(visible);
    const label = labels.find(element => compact(element.innerText || element.textContent || '') === compact(name));
    const wrapper = label?.closest('label, .ant-radio-wrapper');
    const input = wrapper?.querySelector('input[type="radio"]');
    const selected = Boolean(input?.checked)
      || Boolean(wrapper?.classList.contains('ant-radio-wrapper-checked'))
      || Boolean(wrapper?.querySelector('.ant-radio-checked'));

    const inputTexts = Array.from(document.querySelectorAll('input, textarea'))
      .filter(visible)
      .map(element => normalize(element.value || element.getAttribute('value') || ''));
    const editorTexts = Array.from(document.querySelectorAll('.ql-editor, [contenteditable="true"]'))
      .filter(visible)
      .map(element => {
        const quill = element.__quill
          || element.closest('.ql-container')?.__quill
          || (window.Quill?.find ? window.Quill.find(element.closest('.ql-container') || element) : null);
        return normalize(quill?.getText?.() || element.innerText || element.textContent || '');
      })
      .filter(text => text && text !== '正文');
    const pageText = normalize(document.body?.innerText || '');

    const subjectNeedle = normalize(subjectText);
    const bodyNeedles = normalize(bodyText)
      .split(/\n+/)
      .map(line => line.trim())
      .filter(line => line.length >= 16)
      .slice(0, 4);
    const knownTemplateLoaded = pageText.includes('Just checking in')
      || pageText.includes('activate your Moras access code')
      || pageText.includes('first shoppable video')
      || pageText.includes('Quick reminder')
      || pageText.includes('access code expires soon');
    const subjectLoaded = subjectNeedle
      ? inputTexts.some(text => text.includes(subjectNeedle)) || pageText.includes(subjectNeedle)
      : true;
    const bodyLoaded = bodyNeedles.length > 0
      ? bodyNeedles.some(needle => editorTexts.some(text => text.includes(needle)) || pageText.includes(needle))
      : (editorTexts.length > 0 || knownTemplateLoaded);

    const selectionSettled = label ? selected : true;
    if (subjectText || bodyText) return sendButtonReady && selectionSettled;
    return sendButtonReady && selectionSettled && subjectLoaded && bodyLoaded;
  }, { name: templateName, subjectText: subject, bodyText: body }, { timeout }).then(() => true).catch(() => false);
}

async function toggleAwayFromTemplate(page, templateName) {
  await page.evaluate((name) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const labels = Array.from(document.querySelectorAll('.template-selector-item-label, .ant-radio-label'))
      .filter(visible);
    const other = labels.find(element => normalize(element.innerText || element.textContent || '') !== normalize(name));
    const wrapper = other?.closest('label, .ant-radio-wrapper');
    const radio = wrapper?.querySelector('.ant-radio-inner, .ant-radio, input[type="radio"]');
    const clickTarget = radio && visible(radio) ? radio : wrapper;
    if (clickTarget && visible(clickTarget)) clickTarget.click();
  }, templateName).catch(() => {});
}

async function waitForSendButtonVisible(page, timeout = 7000) {
  return await page.waitForFunction(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .some(button => normalize(button.innerText || button.textContent || '') === '立即发送' && !button.disabled);
  }, { timeout }).then(() => true).catch(() => false);
}

async function clickTemplateByVisibleText(page, templateName) {
  const target = await page.evaluate((name) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], label, .ant-radio-wrapper, .ant-select-item-option, .template-selector-item-label, div, span'))
      .filter(visible)
      .map(element => {
        const text = normalize(element.innerText || element.textContent || '');
        const rect = element.getBoundingClientRect();
        return { element, text, area: rect.width * rect.height, y: rect.top };
      })
      .filter(item => item.text === normalize(name))
      .sort((a, b) => a.area - b.area || b.y - a.y);
    const element = candidates[0]?.element;
    if (!element) return null;
    const clickTarget = element.closest('label, button, [role="button"], .ant-radio-wrapper, .ant-select-item-option') || element;
    clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = clickTarget.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, templateName).catch(() => null);

  if (!target?.x || !target?.y) return '';
  await page.mouse.click(target.x, target.y);
  return 'visible-text';
}

async function clickTemplateFromDropdown(page, templateName) {
  const opened = await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const formItems = Array.from(document.querySelectorAll('.ant-form-item, label, div'))
      .filter(visible)
      .filter(element => normalize(element.innerText || element.textContent || '').includes('模板'));
    for (const item of formItems) {
      const trigger = item.querySelector('.ant-select-selector, .ant-select, input, button');
      if (!trigger || !visible(trigger)) continue;
      trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
      trigger.click();
      return true;
    }
    const fallback = Array.from(document.querySelectorAll('.ant-select-selector, .ant-select')).filter(visible).pop();
    if (!fallback) return false;
    fallback.scrollIntoView({ block: 'center', inline: 'nearest' });
    fallback.click();
    return true;
  }).catch(() => false);

  if (!opened) return '';
  await page.waitForTimeout(700);
  const option = await page.evaluate((name) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) [role="option"], .ant-select-dropdown:not(.ant-select-dropdown-hidden) *'))
      .filter(visible)
      .map(element => {
        const text = normalize(element.innerText || element.textContent || '');
        const rect = element.getBoundingClientRect();
        return { element, text, area: rect.width * rect.height };
      })
      .filter(item => item.text === normalize(name))
      .sort((a, b) => a.area - b.area);
    const element = candidates[0]?.element;
    if (!element) return null;
    const clickTarget = element.closest('.ant-select-item-option, [role="option"]') || element;
    clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = clickTarget.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, templateName).catch(() => null);

  if (!option?.x || !option?.y) {
    await page.keyboard.press('Escape').catch(() => {});
    return '';
  }
  await page.mouse.click(option.x, option.y);
  return 'dropdown-option';
}

async function fillRenderedTemplate(page, rendered) {
  if (!rendered?.body) return false;
  const domFilled = await page.evaluate(({ subject, body }) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
    const bodyHtml = String(body || '')
      .split(/\n/)
      .map(line => line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>')
      .join('');
    const setInputValue = (input, value) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const subjectInputs = Array.from(document.querySelectorAll('input'))
      .filter(input => normalize(input.value || input.getAttribute('value') || '').includes('Quick reminder')
        || input.closest('.ant-form-item')?.innerText?.includes('主题'));
    if (subject && subjectInputs[0]) setInputValue(subjectInputs[0], subject);

    const editor = document.querySelector('.ql-editor, [contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    const quill = editor.__quill
      || editor.closest('.ql-container')?.__quill
      || (window.Quill?.find ? window.Quill.find(editor.closest('.ql-container') || editor) : null);
    if (quill?.clipboard?.dangerouslyPasteHTML) {
      quill.setText('');
      quill.clipboard.dangerouslyPasteHTML(0, bodyHtml, 'api');
      quill.setSelection?.(Math.max(quill.getLength() - 1, 0), 0, 'api');
      quill.root?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: body }));
      quill.root?.dispatchEvent(new Event('change', { bubbles: true }));
      return normalize(quill.getText?.() || quill.root?.innerText || '').length > 0;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand?.('insertHTML', false, bodyHtml);
    if (!inserted) editor.innerHTML = bodyHtml;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertHTML', data: body }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return normalize(editor.innerText || editor.textContent || '').length > 0;
  }, rendered).catch(() => false);
  if (domFilled && await replyEditorMatchesRendered(page, rendered, 1200)) return true;
  const pasteFilled = await fillRenderedTemplateByPasteEvent(page, rendered);
  if (pasteFilled && await replyEditorMatchesRendered(page, rendered, 5000)) return true;
  const slateDomFilled = await fillRenderedTemplateBySlateDom(page, rendered);
  if (slateDomFilled && await replyEditorMatchesRendered(page, rendered, 5000)) return true;
  return await fillRenderedTemplateByKeyboard(page, rendered);
}

async function waitForReplyEditorContent(page, timeout = 10000) {
  return await page.waitForFunction(() => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const editor = Array.from(document.querySelectorAll('.ql-editor, [contenteditable="true"], [data-slate-editor="true"]'))
      .find(visible);
    if (!editor) return false;
    const quill = editor.__quill
      || editor.closest('.ql-container')?.__quill
      || (window.Quill?.find ? window.Quill.find(editor.closest('.ql-container') || editor) : null);
    const text = normalize(quill?.getText?.() || editor.innerText || editor.textContent || '');
    return text.length > 0 && text !== '正文';
  }, { timeout }).then(() => true).catch(() => false);
}

function renderedNeedles(rendered) {
  return String(rendered?.body || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 8)
    .slice(0, 5);
}

async function replyEditorMatchesRendered(page, rendered, timeout = 5000) {
  const needles = renderedNeedles(rendered);
  if (needles.length === 0) return false;
  return await page.waitForFunction((expected) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const editorText = Array.from(document.querySelectorAll('.ql-editor, [contenteditable="true"], [data-slate-editor="true"]'))
      .filter(visible)
      .map(element => {
        const quill = element.__quill
          || element.closest('.ql-container')?.__quill
          || (window.Quill?.find ? window.Quill.find(element.closest('.ql-container') || element) : null);
        return normalize(quill?.getText?.() || element.innerText || element.textContent || '');
      })
      .join(' ');
    return expected.every(needle => editorText.includes(normalize(needle)));
  }, needles, { timeout }).then(() => true).catch(() => false);
}

async function fillRenderedTemplateByKeyboard(page, rendered) {
  const editorTarget = await page.evaluate(() => {
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const editors = Array.from(document.querySelectorAll('[data-slate-editor="true"], .w-e-text-container [contenteditable="true"], .ql-editor, [contenteditable="true"]'))
      .filter(visible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + Math.min(Math.max(rect.width / 2, 20), rect.width - 10),
          y: rect.top + Math.min(Math.max(rect.height / 2, 20), rect.height - 10),
          area: rect.width * rect.height,
        };
      })
      .sort((a, b) => b.area - a.area);
    return editors[0] || null;
  }).catch(() => null);
  if (!editorTarget?.x || !editorTarget?.y) return false;

  await page.mouse.click(editorTarget.x, editorTarget.y);
  await page.waitForTimeout(200);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.waitForTimeout(100);
  await page.keyboard.press('Backspace').catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.insertText(String(rendered.body || '')).catch(async () => {
    await page.keyboard.type(String(rendered.body || ''), { delay: 1 });
  });
  await page.waitForTimeout(500);
  if (rendered.subject) {
    await page.evaluate((subject) => {
      const normalize = value => String(value || '').replace(/\s+/g, '').trim();
      const visible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.width > 0
          && rect.height > 0;
      };
      const input = Array.from(document.querySelectorAll('input'))
        .filter(visible)
        .find(element => normalize(element.closest('.ant-form-item')?.innerText || '').includes('主题')
          || normalize(element.value || element.getAttribute('value') || '').includes('Quickreminder'));
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, subject);
      else input.value = subject;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: subject, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, rendered.subject).catch(() => false);
  }
  return await replyEditorMatchesRendered(page, rendered, 5000);
}

async function fillRenderedTemplateByPasteEvent(page, rendered) {
  return await page.evaluate(({ subject, body }) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const setInputValue = (input, value) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (subject) {
      const subjectInput = Array.from(document.querySelectorAll('input'))
        .filter(visible)
        .find(input => normalize(input.closest('.ant-form-item')?.innerText || '').includes('主题')
          || normalize(input.value || input.getAttribute('value') || '').includes('Quick reminder'));
      if (subjectInput) setInputValue(subjectInput, subject);
    }

    const editor = Array.from(document.querySelectorAll('[data-slate-editor="true"], .w-e-text-container [contenteditable="true"], .ql-editor, [contenteditable="true"]'))
      .filter(visible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0];
    if (!editor) return false;
    editor.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand?.('delete', false);

    const data = new DataTransfer();
    data.setData('text/plain', String(body || ''));
    data.setData('text/html', String(body || '')
      .split(/\n/)
      .map(line => line ? `<p>${line.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char]))}</p>` : '<p><br></p>')
      .join(''));
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    const accepted = editor.dispatchEvent(event);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(body || ''), inputType: 'insertFromPaste' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return accepted || normalize(editor.innerText || editor.textContent || '').length > 0;
  }, rendered).catch(() => false);
}

async function fillRenderedTemplateBySlateDom(page, rendered) {
  return await page.evaluate(({ subject, body }) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const editor = Array.from(document.querySelectorAll('[data-slate-editor="true"], .w-e-text-container [contenteditable="true"], [contenteditable="true"]'))
      .filter(visible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0];
    if (!editor) return false;
    const lines = String(body || '').split(/\n/);
    editor.innerHTML = lines.map(line => {
      const text = line ? escapeHtml(line) : '<br>';
      return `<p data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-string="true">${text}</span></span></span></p>`;
    }).join('');
    editor.focus();
    editor.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: String(body || ''),
      inputType: 'insertText',
    }));
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: String(body || ''),
      inputType: 'insertText',
    }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new Event('blur', { bubbles: true }));
    editor.dispatchEvent(new Event('focus', { bubbles: true }));

    if (subject) {
      const subjectInput = Array.from(document.querySelectorAll('input'))
        .filter(visible)
        .find(input => normalize(input.closest('.ant-form-item')?.innerText || '').includes('主题')
          || normalize(input.value || input.getAttribute('value') || '').includes('Quick reminder'));
      if (subjectInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(subjectInput, subject);
        else subjectInput.value = subject;
        subjectInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: subject, inputType: 'insertText' }));
        subjectInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return normalize(editor.innerText || editor.textContent || '').includes(normalize(lines.find(line => line.trim()) || ''));
  }, rendered).catch(() => false);
}

async function getReplyEditorContent(page) {
  return await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const editor = document.querySelector('.ql-editor, [contenteditable="true"], [data-slate-editor="true"]');
    const quill = editor?.__quill
      || editor?.closest('.ql-container')?.__quill
      || (window.Quill?.find && editor ? window.Quill.find(editor.closest('.ql-container') || editor) : null);
    return normalize(quill?.getText?.() || editor?.innerText || editor?.textContent || '');
  }).catch(() => '');
}

async function clickImmediateSendButton(page) {
  const target = await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .map(element => ({ element, rect: element.getBoundingClientRect(), text: normalize(element.innerText || element.textContent || '') }))
      .filter(item => ['立即发送', '发送'].includes(item.text) && !item.element.disabled && item.element.getAttribute('aria-disabled') !== 'true');
    if (buttons.length === 0) return null;
    const target = buttons
      .sort((a, b) => (a.text === '立即发送' ? -1 : 1) - (b.text === '立即发送' ? -1 : 1) || b.rect.top - a.rect.top)[0].element;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }).catch(() => null);
  if (!target?.x || !target?.y) return false;
  await page.mouse.click(target.x, target.y);
  return true;
}

async function armFreshSendSuccessSignal(page) {
  await page.evaluate(() => {
    const key = '__crmReplySendSignal';
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const matches = text => normalize(text).includes('发送成功');

    if (window[key]?.observer) window[key].observer.disconnect();
    const state = { triggeredAt: 0, text: '', observer: null };
    const mark = text => {
      if (state.triggeredAt) return;
      state.triggeredAt = Date.now();
      state.text = normalize(text);
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const nodes = [];
        if (mutation.type === 'childList') nodes.push(...mutation.addedNodes);
        if (mutation.target) nodes.push(mutation.target);
        for (const node of nodes) {
          if (!node) continue;
          const text = node.nodeType === Node.TEXT_NODE
            ? node.textContent
            : (node.innerText || node.textContent || '');
          if (matches(text)) {
            mark(text);
            return;
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
  }).catch(() => {});
}

async function waitForFreshSendSuccess(page, timeout = config.sendSuccessTimeout) {
  return await page.waitForFunction(() => Boolean(window.__crmReplySendSignal?.triggeredAt), { timeout })
    .then(() => true)
    .catch(() => false);
}

async function clearFreshSendSuccessSignal(page) {
  await page.evaluate(() => {
    if (window.__crmReplySendSignal?.observer) window.__crmReplySendSignal.observer.disconnect();
    delete window.__crmReplySendSignal;
  }).catch(() => {});
}

async function getSendFeedback(page) {
  return await page.evaluate(() => {
    const selectors = [
      '.ant-message',
      '.ant-notification',
      '.ant-alert',
      '.ant-form-item-explain-error',
    ];
    return selectors
      .flatMap(selector => Array.from(document.querySelectorAll(selector)))
      .map(element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' | ');
  }).catch(() => '');
}

async function tryConfirmSend(page, timeout = config.sendConfirmTimeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const target = await page.evaluate((texts) => {
      const normalize = value => String(value || '').replace(/\s+/g, '').trim();
      const visible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.width > 0
          && rect.height > 0;
      };
      const center = element => {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };

      const modalWraps = Array.from(document.querySelectorAll('.ant-modal-wrap'))
        .filter(wrap => !wrap.classList.contains('ant-modal-wrap-hidden') && visible(wrap))
        .reverse();
      for (const wrap of modalWraps) {
        const modal = wrap.querySelector('.ant-modal');
        if (!modal || !visible(modal)) continue;
        const modalText = normalize(modal.innerText || modal.textContent || '');
        if (!modalText.includes('发送') && !modalText.includes('确认')) continue;
        const buttons = Array.from(modal.querySelectorAll('button')).filter(visible);
        const primary = buttons.find(button =>
          button.classList.contains('ant-btn-primary')
          && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true'
        );
        if (primary) return center(primary);
        const fallback = buttons.find(button => {
          const text = normalize(button.innerText || button.textContent || '');
          return !button.disabled
            && button.getAttribute('aria-disabled') !== 'true'
            && texts.some(item => text.includes(normalize(item)));
        });
        if (fallback) return center(fallback);
      }

      const dialogs = Array.from(document.querySelectorAll('.swal2-popup, .swal-modal, [role="dialog"]'))
        .filter(dialog => visible(dialog) && !dialog.closest('.ant-modal-wrap'))
        .reverse();
      for (const dialog of dialogs) {
        const dialogText = normalize(dialog.innerText || dialog.textContent || '');
        if (!dialogText.includes('发送') && !dialogText.includes('确认')) continue;
        const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(visible);
        const primary = buttons.find(button =>
          (button.classList.contains('swal2-confirm')
            || button.classList.contains('swal-button--confirm')
            || button.classList.contains('btn-primary')
            || button.classList.contains('ant-btn-primary'))
          && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true'
        ) || buttons.find(button => {
          const text = normalize(button.innerText || button.textContent || '');
          return !button.disabled
            && button.getAttribute('aria-disabled') !== 'true'
            && texts.some(item => text.includes(normalize(item)));
        });
        if (primary) return center(primary);
      }

      const popups = Array.from(document.querySelectorAll('.ant-popover, .ant-popconfirm'))
        .filter(visible)
        .reverse();
      for (const popup of popups) {
        const popupText = normalize(popup.innerText || popup.textContent || '');
        if (!popupText.includes('发送') && !popupText.includes('确认')) continue;
        const buttons = Array.from(popup.querySelectorAll('button')).filter(visible);
        const primary = buttons.find(button =>
          button.classList.contains('ant-btn-primary')
          && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true'
        )
          || buttons.find(button => {
            const text = normalize(button.innerText || button.textContent || '');
            return !button.disabled
              && button.getAttribute('aria-disabled') !== 'true'
              && (texts.some(item => text.includes(normalize(item))) || text.includes('发送'));
          });
        if (primary) return center(primary);
      }
      return null;
    }, CONFIRM_TEXTS).catch(() => null);
    if (target?.x && target?.y) {
      await page.mouse.click(target.x, target.y);
      return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function confirmSendPopups(page) {
  let confirmed = false;
  const deadline = Date.now() + config.sendConfirmTimeout;
  while (Date.now() < deadline) {
    if (await waitForFreshSendSuccess(page, 500).catch(() => false)) return true;
    const clicked = await tryConfirmSend(page, confirmed ? 1800 : 3500);
    if (!clicked) {
      await page.waitForTimeout(500);
      continue;
    }
    confirmed = true;
    await page.waitForTimeout(700);
  }
  return confirmed;
}

async function verifySentRecord(page, handle) {
  await goToSent(page);
  await setSearchValue(page, handle);
  await clickSearchButton(page);
  await page.waitForTimeout(3000);
  return await page.evaluate((name) => {
    const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
    return text.includes(String(name || '').toLowerCase()) && text.includes('quick reminder');
  }, handle).catch(() => false);
}

async function replyToOpenedThread(page, { templateName, rendered, dryRun, inviteCode }) {
  const replyClicked = await clickReplyButton(page);
  if (!replyClicked) return { status: 'reply-not-found' };
  const replyReady = await waitForReplyForm(page, templateName);
  if (!replyReady) return { status: 'reply-form-not-ready' };

  const templateSelected = await selectTemplate(page, templateName, rendered);
  if (!templateSelected.ok) {
    const failure = await captureDomFailure(page, 'reply-template-not-found', {
      templateName,
      replyComposerState: await getReplyComposerState(page, templateName),
    });
    return {
      status: 'template-not-found',
      error: summarizeDomFailure(failure),
    };
  }
  await captureReplyCheckpoint(page, 'reply-template-selected', {
    templateName,
    templateStrategy: templateSelected.strategy,
  });

  if (rendered) {
    const filled = await fillRenderedTemplate(page, rendered);
    if (!filled) {
      const failure = await captureDomFailure(page, 'reply-template-fill-failed', {
        templateName,
        templateStrategy: templateSelected.strategy,
        replyComposerState: await getReplyComposerState(page, templateName),
      });
      return { status: 'template-fill-failed', error: summarizeDomFailure(failure) };
    }
    const contentReady = await waitForReplyEditorContent(page, 8000);
    if (!contentReady) return { status: 'template-fill-failed', error: 'reply editor stayed empty after filling template' };
    await captureReplyCheckpoint(page, 'reply-template-filled', {
      templateName,
      templateStrategy: templateSelected.strategy,
    });
  } else {
    const contentReady = await waitForReplyEditorContent(page, 12000);
    if (!contentReady) return { status: 'template-content-not-ready' };
  }

  if (inviteCode) {
    await fillInviteCodeInput(page, inviteCode);
  }

  if (dryRun) return { status: 'dry-run', templateStrategy: templateSelected.strategy };

  const editorContent = await getReplyEditorContent(page);
  if (!editorContent) {
    const failure = await captureDomFailure(page, 'reply-editor-empty-before-send', {
      templateName,
      replyComposerState: await getReplyComposerState(page, templateName),
    });
    return {
      status: 'content-empty',
      error: summarizeDomFailure(failure),
      templateStrategy: templateSelected.strategy,
    };
  }

  await captureReplyCheckpoint(page, 'reply-before-send-click', {
    templateName,
    templateStrategy: templateSelected.strategy,
  });
  await armFreshSendSuccessSignal(page);
  const sendClicked = await clickImmediateSendButton(page);
  if (!sendClicked) {
    await clearFreshSendSuccessSignal(page);
    const failure = await captureDomFailure(page, 'reply-send-button-not-found', {
      templateName,
      replyComposerState: await getReplyComposerState(page, templateName),
    });
    return {
      status: 'send-button-not-found',
      error: summarizeDomFailure(failure),
    };
  }
  const confirmed = await confirmSendPopups(page);

  const success = await waitForFreshSendSuccess(page);
  const feedback = success ? '' : await getSendFeedback(page);
  await clearFreshSendSuccessSignal(page);
  if (success || feedback.includes('发送成功')) {
    return { status: 'sent-unverified', templateStrategy: templateSelected.strategy };
  }
  if (feedback.includes('请填写邮件内容')) {
    return { status: 'content-empty', error: feedback, templateStrategy: templateSelected.strategy };
  }
  if (!success && !feedback) {
    await captureReplyCheckpoint(page, 'reply-confirm-not-successful', {
      templateName,
      templateStrategy: templateSelected.strategy,
      confirmed,
    });
  }
  return {
    status: confirmed ? 'sent-unverified' : 'confirm-not-found',
    error: feedback || '',
    templateStrategy: templateSelected.strategy,
  };
}

module.exports = {
  searchInboxByHandle,
  openInboxResult,
  reopenInboxResult,
  replyToOpenedThread,
  verifySentRecord,
  senderMatchesHandle,
  enterInbox,
  enterMailbox,
  enterRepliedInbox,
  openMailStatusDropdown,
  listMailStatusOptions,
  selectMailStatusByCandidates,
  setPageSize,
  goToFirstPage,
  goToPage,
  goToNextPage,
  extractInboxRows,
  extractOpenedThreadText,
};
