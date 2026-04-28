const fs = require('fs');
const path = require('path');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readManifest(manifestPath) {
  return readJson(manifestPath, null);
}

function listManifestPaths(rootDir) {
  const manifests = [];
  if (!fs.existsSync(rootDir)) return manifests;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const itemPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(itemPath);
      } else if (entry.name === 'manifest.json') {
        manifests.push(itemPath);
      }
    }
  };

  walk(rootDir);
  return manifests.sort();
}

function updateBatchStatus(manifest, batchNumber, status, extra = {}) {
  if (!manifest || !Array.isArray(manifest.batches)) return manifest;
  manifest.batches = manifest.batches.map(batch => {
    if (batch.batchNumber !== Number(batchNumber)) return batch;
    return {
      ...batch,
      ...extra,
      status,
      updatedAt: new Date().toISOString(),
    };
  });
  manifest.updatedAt = new Date().toISOString();
  return manifest;
}

module.exports = {
  readJson,
  writeJson,
  readManifest,
  listManifestPaths,
  updateBatchStatus,
};
