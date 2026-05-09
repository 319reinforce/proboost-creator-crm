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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readManifest(manifestPath) {
  return readJson(manifestPath, null);
}

function writeManifest(manifestPath, manifest) {
  writeJson(manifestPath, manifest);
}

function getManifestPath(outputDir) {
  return path.join(outputDir, 'manifest.json');
}

function listManifestPaths(rootDir) {
  const manifests = [];
  const batchesRoot = path.join(rootDir, 'batches');
  if (!fs.existsSync(batchesRoot)) {
    return manifests;
  }

  for (const name of fs.readdirSync(batchesRoot, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const manifestPath = getManifestPath(path.join(batchesRoot, name.name));
    if (fs.existsSync(manifestPath)) {
      manifests.push(manifestPath);
    }
  }
  return manifests;
}

function updateBatchStatus(manifest, batchNumber, status, extra = {}) {
  if (!manifest || !Array.isArray(manifest.batches)) {
    return manifest;
  }
  manifest.batches = manifest.batches.map(batch => {
    if (batch.batchNumber !== Number(batchNumber)) {
      return batch;
    }
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

function findNextBatch(manifest, statuses = ['pending']) {
  if (!manifest || !Array.isArray(manifest.batches)) {
    return null;
  }
  return manifest.batches.find(batch => statuses.includes(batch.status)) || null;
}

function findBatchesByStatus(manifest, status) {
  if (!manifest || !Array.isArray(manifest.batches)) {
    return [];
  }
  return manifest.batches.filter(batch => batch.status === status);
}

module.exports = {
  findBatchesByStatus,
  findNextBatch,
  getManifestPath,
  listManifestPaths,
  readManifest,
  updateBatchStatus,
  writeManifest,
};
