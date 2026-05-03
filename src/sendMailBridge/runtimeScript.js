const fs = require('fs');
const path = require('path');
const config = require('../config');
const { SEND_MAIL_ROOT } = require('./paths');

const runtimeRoot = path.join(config.rootDir, '.send-mail-runtime');

function copyRuntimeDependency(fileName) {
  const source = path.join(SEND_MAIL_ROOT, fileName);
  const target = path.join(runtimeRoot, fileName);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}

function patchZeroSendConfirm(source) {
  let patched = source;

  const zeroSendGuard = `
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
`;

  patched = patched.replace(
    "        if (!isSendConfirmModal) continue;\n\n        const buttons = Array.from(modal.querySelectorAll('.ant-modal-footer button')).filter(isVisible);",
    "        if (!isSendConfirmModal) continue;\n\n        const buttons = Array.from(modal.querySelectorAll('.ant-modal-footer button')).filter(isVisible);\n" + zeroSendGuard,
  );

  patched = patched.replace(
    "      if (confirmed) {\n        console.log('  ✅ 已自动确认发送');\n      }\n      const toastOk = await waitForFreshSendSuccess(page);",
    `      if (confirmed === 'zero-send') {
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
          console.log(\`ℹ️ 当前批次已跳过，自动继续后续待处理批次: [\${appended.join(', ')}]\`);
        }
        continue;
      }
      if (confirmed) {
        console.log('  ✅ 已自动确认发送');
      }
      const toastOk = await waitForFreshSendSuccess(page);`,
  );

  return patched;
}

function prepareRuntimeAutoScript(sourceScript) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  for (const fileName of ['auth-config.js', 'batch-manifest.js']) {
    copyRuntimeDependency(fileName);
  }

  const source = fs.readFileSync(sourceScript, 'utf8');
  const patched = patchZeroSendConfirm(source);
  const target = path.join(runtimeRoot, 'proboost-auto.js');
  fs.writeFileSync(target, patched);
  return target;
}

module.exports = {
  runtimeRoot,
  patchZeroSendConfirm,
  prepareRuntimeAutoScript,
};
