const fs = require('fs');
const path = require('path');
const config = require('../config');
const { SELECTORS } = require('./selectors');

function visible(element) {
  if (!element || typeof window === 'undefined') return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
    && rect.width > 0
    && rect.height > 0;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCompact(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function selectorList(selectors) {
  if (Array.isArray(selectors)) return selectors.join(', ');
  return selectors || 'button, [role="button"], a, div, span';
}

function summarizeDomFailure(payload) {
  const text = normalizeText(payload.bodyTextPreview).slice(0, 260);
  return `feature=${payload.feature}; url=${payload.url || ''}; screenshot=${payload.screenshotPath || 'none'}; text=${text}`;
}

async function clickVisibleExactText(page, label, selectors = 'button, [role="button"], a, div, span') {
  return await page.evaluate(({ label, selectors }) => {
    const normalize = value => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll(selectors))
      .filter(isVisible)
      .filter(element => normalize(element.innerText || element.textContent || '') === normalize(label))
      .map(element => {
        const rect = element.getBoundingClientRect();
        return { element, area: rect.width * rect.height, y: rect.top };
      })
      .sort((a, b) => a.area - b.area || a.y - b.y);
    const target = candidates[0]?.element;
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, { label, selectors: selectorList(selectors) }).catch(() => false);
}

async function findMailTable(page, options = {}) {
  const requiredText = options.requiredText || SELECTORS.mailTable.requiredText;
  const selectors = selectorList(options.selectors || SELECTORS.mailTable.variants);
  const timeout = options.timeout || 30000;

  const found = await page.waitForFunction(({ requiredText, selectors }) => {
    const spinning = document.querySelector('.ant-spin-spinning');
    if (spinning) return false;
    const tables = Array.from(document.querySelectorAll(selectors));
    return tables.some(table => {
      const text = table.innerText || table.textContent || '';
      return requiredText.every(item => text.includes(item));
    });
  }, { requiredText, selectors }, { timeout }).then(() => true).catch(() => false);

  if (!found) return null;

  return await page.evaluate(({ requiredText, selectors }) => {
    const tables = Array.from(document.querySelectorAll(selectors));
    const table = tables.find(item => {
      const text = item.innerText || item.textContent || '';
      return requiredText.every(label => text.includes(label));
    });
    if (!table) return null;
    const rect = table.getBoundingClientRect();
    return {
      text: (table.innerText || table.textContent || '').slice(0, 500),
      rowCount: table.querySelectorAll('tbody tr, .ant-table-tbody .ant-table-row').length,
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
    };
  }, { requiredText, selectors }).catch(() => null);
}

async function extractMailRows(page) {
  return await page.evaluate(({ requiredText, selectors }) => {
    const isVisible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const tables = Array.from(document.querySelectorAll(selectors));
    const table = tables.find(item => {
      const text = item.innerText || item.textContent || '';
      return requiredText.every(label => text.includes(label));
    });
    if (!table) return [];

    const rowNodes = Array.from(table.querySelectorAll('tbody tr, .ant-table-tbody .ant-table-row'))
      .filter(row => !row.classList.contains('ant-table-placeholder') && isVisible(row));

    return rowNodes.map((row, index) => {
      const cells = Array.from(row.querySelectorAll('td, .ant-table-cell'));
      if (cells.length >= 4) {
        return {
          rowIndex: index,
          sender: (cells[1]?.innerText || cells[1]?.textContent || '').trim(),
          subject: (cells[2]?.innerText || cells[2]?.textContent || '').trim(),
          time: (cells[3]?.innerText || cells[3]?.textContent || '').trim(),
        };
      }
      return null;
    }).filter(Boolean).filter(row => row.sender || row.subject);
  }, {
    requiredText: SELECTORS.mailTable.requiredText,
    selectors: selectorList(SELECTORS.mailTable.variants),
  }).catch(() => []);
}

async function robustClick(page, feature, options = {}) {
  if (options.label) {
    const clicked = await clickVisibleExactText(page, options.label, options.selectors);
    if (clicked) {
      if (options.waitAfterMs) await page.waitForTimeout(options.waitAfterMs);
      return true;
    }
  }

  if (typeof options.evaluate === 'function') {
    const clicked = await options.evaluate();
    if (clicked) {
      if (options.waitAfterMs) await page.waitForTimeout(options.waitAfterMs);
      return true;
    }
  }

  if (options.throwOnFailure) {
    const failure = await captureDomFailure(page, feature, options.metadata);
    throw new Error(`DOM click failed: ${summarizeDomFailure(failure)}`);
  }

  return false;
}

async function robustOpenMailRow(page, rowIndex, options = {}) {
  const cellOrders = options.cellOrders || [[1, 2], [2, 1], [0, 1, 2]];
  for (const cellOrder of cellOrders) {
    const clicked = await page.evaluate(({ idx, cellOrder, requiredText, selectors }) => {
      const isVisible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && rect.width > 0
          && rect.height > 0;
      };
      const tables = Array.from(document.querySelectorAll(selectors));
      const table = tables.find(item => {
        const text = item.innerText || item.textContent || '';
        return requiredText.every(label => text.includes(label));
      });
      if (!table) return false;
      const rows = Array.from(table.querySelectorAll('tbody tr, .ant-table-tbody .ant-table-row'))
        .filter(row => !row.classList.contains('ant-table-placeholder') && isVisible(row));
      const row = rows[idx];
      if (!row) return false;
      const cells = row.querySelectorAll('td, .ant-table-cell');

      let target = null;
      for (const cellIndex of cellOrder) {
        const cell = cells[cellIndex];
        if (!cell) continue;
        target = cell.querySelector('.cursor-pointer, .inbox-mail-receiving-tit, span, div') || cell;
        if (target && isVisible(target)) break;
      }
      target = target || row;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = target.getBoundingClientRect();
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, eventOptions));
      }
      return true;
    }, {
      idx: rowIndex,
      cellOrder,
      requiredText: SELECTORS.mailTable.requiredText,
      selectors: selectorList(SELECTORS.mailTable.variants),
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(options.waitAfterMs || 1500);
      return true;
    }
  }

  const clicked = await page.evaluate((idx) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr, .ant-table-tbody .ant-table-row'))
      .filter(row => !row.classList.contains('ant-table-placeholder'));
    const row = rows[idx];
    if (!row) return false;
    const cells = row.querySelectorAll('td, .ant-table-cell');
    const target = cells[1]?.querySelector('.cursor-pointer, .inbox-mail-receiving-tit, span, div')
      || cells[2]?.querySelector('.cursor-pointer, .inbox-mail-receiving-tit, span, div')
      || cells[1]
      || cells[2]
      || row;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, rowIndex).catch(() => false);

  if (clicked) await page.waitForTimeout(options.waitAfterMs || 1500);
  return clicked;
}

async function waitForMailDetail(page, row = {}, options = {}) {
  const timeout = options.timeout || 12000;
  return await page.waitForFunction(({ expected, replyTexts }) => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const text = document.body?.innerText || '';
    const hasDetailChrome = text.includes('邮件详情')
      || text.includes('返回收件箱')
      || Array.from(document.querySelectorAll('button, [role="button"], a')).some(element => {
        const label = normalize(element.innerText || element.textContent || '');
        return replyTexts.includes(label);
      });
    const senderOk = !expected.sender || text.includes(expected.sender);
    const subjectOk = !expected.subject || text.includes(String(expected.subject).slice(0, 20));
    return hasDetailChrome && senderOk && subjectOk;
  }, {
    expected: row,
    replyTexts: SELECTORS.replyButton.texts,
  }, { timeout }).then(() => true).catch(() => false);
}

async function captureDomFailure(page, feature, metadata = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeFeature = String(feature || 'unknown').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'unknown';
  const dir = path.join(config.reportDir, 'dom-failures');
  fs.mkdirSync(dir, { recursive: true });

  const screenshotPath = path.join(dir, `${timestamp}-${safeFeature}.png`);
  let savedScreenshotPath = '';
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    savedScreenshotPath = screenshotPath;
  } catch {
    savedScreenshotPath = '';
  }

  const preview = await page.evaluate(() => ({
    url: window.location.href,
    bodyTextPreview: (document.body?.innerText || '').slice(0, 1200),
  })).catch(error => ({
    url: '',
    bodyTextPreview: error.message,
  }));

  const payload = {
    feature,
    url: preview.url,
    bodyTextPreview: preview.bodyTextPreview,
    screenshotPath: savedScreenshotPath,
    metadata: metadata || {},
    capturedAt: new Date().toISOString(),
  };

  const jsonPath = path.join(dir, `${timestamp}-${safeFeature}.json`);
  try {
    fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    payload.jsonPath = jsonPath;
  } catch {
    payload.jsonPath = '';
  }

  return payload;
}

module.exports = {
  visible,
  normalizeText,
  clickVisibleExactText,
  findMailTable,
  extractMailRows,
  robustClick,
  robustOpenMailRow,
  waitForMailDetail,
  captureDomFailure,
  summarizeDomFailure,
};
