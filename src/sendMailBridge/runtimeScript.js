const fs = require('fs');
const path = require('path');
const config = require('../config');

const ownedRuntimeRoot = path.join(__dirname, 'runtime');
const ownedAutoScript = path.join(ownedRuntimeRoot, 'proboost-auto.js');

function writeRuntimeSqliteBridge() {
  const source = path.join(__dirname, 'runtimeSqliteBridge.js');
  const target = path.join(ownedRuntimeRoot, 'runtime-sqlite-bridge.js');
  fs.copyFileSync(source, target);
}

function patchRuntimeSqliteBridge(source) {
  let patched = source;

  if (!patched.includes("require('./runtime-sqlite-bridge')")) {
    patched = patched.replace(
      "const { readManifest, updateBatchStatus, writeManifest } = require('./batch-manifest');",
      "const { readManifest, updateBatchStatus, writeManifest } = require('./batch-manifest');\nconst { updateRuntimeBatchStatus } = require('./runtime-sqlite-bridge');",
    );
  }

  patched = patched.replace(
    `function updateManifestStatus(status, extra = {}) {
  if (!MANIFEST_PATH || !BATCH_NUMBER) {
    return;
  }
  const manifest = readManifest(MANIFEST_PATH);
  if (!manifest) {
    return;
  }
  updateBatchStatus(manifest, BATCH_NUMBER, status, extra);
  writeManifest(MANIFEST_PATH, manifest);
}`,
    `function updateManifestStatus(status, extra = {}) {
  updateManifestStatusForBatch(BATCH_NUMBER, status, extra);
}`,
  );

  patched = patched.replace(
    `function updateManifestStatusForBatch(batchNumber, status, extra = {}) {
  if (!MANIFEST_PATH || !batchNumber) {
    return;
  }
  const manifest = readManifest(MANIFEST_PATH);
  if (!manifest) {
    return;
  }
  updateBatchStatus(manifest, batchNumber, status, extra);
  writeManifest(MANIFEST_PATH, manifest);
}`,
    `function updateManifestStatusForBatch(batchNumber, status, extra = {}) {
  if (!MANIFEST_PATH || !batchNumber) {
    return;
  }
  const manifest = readManifest(MANIFEST_PATH);
  if (manifest) {
    updateBatchStatus(manifest, batchNumber, status, extra);
    writeManifest(MANIFEST_PATH, manifest);
  }
  try {
    const sqliteResult = updateRuntimeBatchStatus({
      manifestPath: MANIFEST_PATH,
      batchNumber,
      status,
      extra,
    });
    if (sqliteResult && sqliteResult.updated) {
      console.log(\`  🗄️ SQLite 批次状态已更新: batch=\${batchNumber}, status=\${status}\`);
    } else if (sqliteResult) {
      console.log(\`  ⚠️ SQLite 批次状态未更新: batch=\${batchNumber}, status=\${status}, reason=\${sqliteResult.reason || 'unknown'}\`);
    }
  } catch (error) {
    console.log(\`  ⚠️ SQLite 批次状态更新失败: \${error.message}\`);
  }
}`,
  );

  return patched;
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
  fs.mkdirSync(ownedRuntimeRoot, { recursive: true });
  writeRuntimeSqliteBridge();

  const target = sourceScript || ownedAutoScript;
  const source = fs.readFileSync(target, 'utf8');
  const patched = patchZeroSendConfirm(patchRuntimeSqliteBridge(source));
  if (patched !== source) fs.writeFileSync(target, patched);
  return target;
}

module.exports = {
  ownedRuntimeRoot,
  ownedAutoScript,
  patchRuntimeSqliteBridge,
  patchZeroSendConfirm,
  prepareRuntimeAutoScript,
};
