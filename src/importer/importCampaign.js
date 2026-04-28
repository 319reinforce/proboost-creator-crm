const {
  getOrCreateCampaign,
  upsertCreator,
  upsertInviteCode,
  markInviteUsed,
} = require('../db');
const { loadInviteList, uniqueByCode } = require('./parseInviteList');

function importCampaign(db, options) {
  const campaign = getOrCreateCampaign(db, options.campaign, options.description || '');
  const pushed = uniqueByCode(loadInviteList(options.push));
  const ready = options.ready ? uniqueByCode(loadInviteList(options.ready)) : [];
  const readyCodes = new Set(ready.map(item => item.code).filter(Boolean));

  const importMany = db.transaction(() => {
    for (const item of pushed) {
      const creator = upsertCreator(db, {
        handle: item.handle,
        display_name: item.display_name,
        status: readyCodes.has(item.code) ? 'registered' : 'invited',
        source: `push:${options.campaign}`,
      });

      upsertInviteCode(db, {
        creator_id: creator.id,
        campaign_id: campaign.id,
        code: item.code,
        status: readyCodes.has(item.code) ? 'used' : 'pushed',
        registered_at: readyCodes.has(item.code) ? new Date().toISOString() : null,
        raw_source: item.raw,
      });
    }

    for (const item of ready) {
      const marked = markInviteUsed(db, item.code);
      if (marked) continue;

      const creator = upsertCreator(db, {
        handle: item.handle,
        display_name: item.display_name,
        status: 'registered',
        source: `ready:${options.campaign}`,
      });

      upsertInviteCode(db, {
        creator_id: creator.id,
        campaign_id: campaign.id,
        code: item.code,
        status: 'used',
        registered_at: new Date().toISOString(),
        raw_source: item.raw,
      });
    }
  });

  importMany();

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used,
      SUM(CASE WHEN status != 'used' THEN 1 ELSE 0 END) AS unused
    FROM invite_codes
    WHERE campaign_id = ?
  `).get(campaign.id);

  return {
    campaign,
    pushedCount: pushed.length,
    readyCount: ready.length,
    total: stats.total || 0,
    used: stats.used || 0,
    unused: stats.unused || 0,
  };
}

module.exports = {
  importCampaign,
};
