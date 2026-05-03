const config = require('../config');
const { SELECTORS } = require('./selectors');
const {
  clickVisibleExactText,
  findMailTable,
  extractMailRows,
  robustOpenMailRow,
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

async function waitForInboxTable(page, timeout = 30000) {
  return Boolean(await findMailTable(page, { timeout }));
}

async function goToMailModule(page) {
  const clicked = await clickVisibleExactText(page, SELECTORS.mailModule.text, SELECTORS.mailModule.variants);
  if (clicked) await page.waitForTimeout(1800);
  return clicked;
}

async function goToInbox(page) {
  await page.goto(config.proboostUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeout });
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

async function selectMailStatus(page, statusText) {
  const selected = await page.evaluate((label) => {
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
  }, statusText).catch(() => false);

  if (!selected) {
    const status = page.locator('span:has-text("邮件状态"), .ant-select').first();
    if (await status.isVisible().catch(() => false)) await status.click();
  }

  await page.waitForTimeout(800);

  const optionClicked = await page.evaluate((label) => {
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
    const options = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) *'))
      .filter(visible);
    const target = options.find(option => normalize(option.innerText || option.textContent || '') === normalize(label));
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, statusText).catch(() => false);

  if (!optionClicked) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await page.waitForTimeout(1800);
  return true;
}

async function enterRepliedInbox(page) {
  await goToInbox(page);
  const selected = await selectMailStatus(page, '已回复');
  if (!selected) throw new Error('mail status filter "已回复" not found');
  const ok = await waitForInboxTable(page, 15000);
  if (!ok) {
    const failure = await captureDomFailure(page, 'replied-inbox-table-not-ready', { statusText: '已回复' });
    throw new Error(`Replied inbox table not ready. ${summarizeDomFailure(failure)}`);
  }
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

async function waitForEmailDetail(page, row, timeout = 12000) {
  return await waitForMailDetail(page, row, { timeout });
}

async function openInboxResult(page, row) {
  const attempts = [
    () => clickInboxRowInMailTable(page, row.rowIndex, [1, 2]),
    () => clickInboxRowInMailTable(page, row.rowIndex, [2, 1]),
    () => clickInboxRow(page, row.rowIndex),
  ];

  for (const attempt of attempts) {
    const opened = await attempt();
    const detailReady = opened ? await waitForEmailDetail(page, row) : false;
    if (detailReady) return true;
  }

  const failure = await captureDomFailure(page, 'email-detail-open-failed', { row });
  throw new Error(`email detail did not open; row=${row.rowIndex}; sender=${row.sender || ''}; subject=${row.subject || ''}; ${summarizeDomFailure(failure)}`);
}

async function reopenInboxResult(page, row, pageIndex = 1) {
  try {
    return await openInboxResult(page, row);
  } catch (firstError) {
    await enterRepliedInbox(page);
    await setPageSize(page, config.pageSize);
    await goToFirstPage(page);
    for (let i = 1; i < pageIndex; i += 1) {
      const advanced = await goToNextPage(page);
      if (!advanced) break;
    }
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

async function selectTemplate(page, templateName) {
  await page.waitForFunction((name) => {
    const text = document.body?.innerText || '';
    return text.includes(name) && (text.includes('模板') || text.includes('立即发送'));
  }, templateName, { timeout: 10000 }).catch(() => {});

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
    const label = Array.from(document.querySelectorAll('.template-selector-item-label, .ant-radio-label'))
      .find(element => visible(element) && normalize(element.innerText || element.textContent || '') === normalize(name));
    if (!label) return null;
    const wrapper = label.closest('label, .ant-radio-wrapper') || label.parentElement;
    const radio = wrapper?.querySelector('.ant-radio-inner, .ant-radio, input[type="radio"]');
    const clickTarget = radio && visible(radio) ? radio : wrapper;
    if (!clickTarget || !visible(clickTarget)) return null;
    clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = clickTarget.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, templateName).catch(() => null);

  if (!target?.x || !target?.y) return false;
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(1800);
  return true;
}

async function fillRenderedTemplate(page, rendered) {
  if (!rendered?.body) return false;
  return await page.evaluate(({ subject, body }) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
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
    editor.innerHTML = body.split(/\n/).map(line => line ? `<p>${line}</p>` : '<p><br></p>').join('');
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: body }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, rendered).catch(() => false);
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
      .filter(item => item.text === '立即发送' && !item.element.disabled && item.element.getAttribute('aria-disabled') !== 'true');
    if (buttons.length === 0) return null;
    const target = buttons.sort((a, b) => b.rect.top - a.rect.top)[0].element;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }).catch(() => null);
  if (!target?.x || !target?.y) return false;
  await page.mouse.click(target.x, target.y);
  return true;
}

async function tryConfirmSend(page) {
  const deadline = Date.now() + config.sendConfirmTimeout;
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
      const popups = Array.from(document.querySelectorAll('.ant-modal, .ant-popover, .ant-popconfirm')).filter(visible).reverse();
      for (const popup of popups) {
        const buttons = Array.from(popup.querySelectorAll('button')).filter(visible);
        const primary = buttons.find(button => button.classList.contains('ant-btn-primary') && !button.disabled)
          || buttons.find(button => {
            const text = normalize(button.innerText || button.textContent || '');
            return !button.disabled && texts.some(item => text.includes(normalize(item)));
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

  const templateSelected = await selectTemplate(page, templateName);
  if (!templateSelected) return { status: 'template-not-found' };

  if (rendered) {
    const filled = await fillRenderedTemplate(page, rendered);
    if (!filled) return { status: 'template-fill-failed' };
  }

  if (inviteCode) {
    await fillInviteCodeInput(page, inviteCode);
  }

  if (dryRun) return { status: 'dry-run' };

  const sendClicked = await clickImmediateSendButton(page);
  if (!sendClicked) return { status: 'send-button-not-found' };
  const confirmed = await tryConfirmSend(page);
  return { status: confirmed ? 'sent-unverified' : 'confirm-not-found' };
}

module.exports = {
  searchInboxByHandle,
  openInboxResult,
  reopenInboxResult,
  replyToOpenedThread,
  verifySentRecord,
  senderMatchesHandle,
  enterRepliedInbox,
  setPageSize,
  goToFirstPage,
  goToNextPage,
  extractInboxRows,
  extractOpenedThreadText,
};
