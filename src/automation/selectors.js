const SELECTORS = {
  mailModule: {
    text: '邮件',
    variants: [
      'button',
      '[role="button"]',
      'nav *',
      'aside *',
      'div',
      'span',
      'a',
    ],
  },
  inboxTab: {
    text: '收件箱',
    variants: [
      '.mail-left .main-left-tab',
      '.main-left-tab',
      '[class*="left-tab"]',
      'button',
      'a',
      'div',
      'span',
    ],
  },
  mailTable: {
    requiredText: ['发件人', '送达时间'],
    variants: [
      'table',
      '.ant-table',
    ],
  },
  repliedStatus: {
    text: '已回复',
    variants: [
      '.ant-select',
      '.ant-select-selector',
      '.ant-select-item-option',
    ],
  },
  replyButton: {
    texts: ['回复', '回复邮件'],
    variants: [
      'button',
      '[role="button"]',
      'a',
    ],
  },
};

module.exports = { SELECTORS };
