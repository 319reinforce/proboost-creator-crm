function listUnusedInvites(db, campaignName, limit = 0) {
  const sql = `
    SELECT
      c.id AS creator_id,
      c.handle,
      c.display_name,
      c.status AS creator_status,
      i.id AS invite_code_id,
      i.code,
      i.status AS invite_status,
      i.pushed_at,
      ca.id AS campaign_id,
      ca.name AS campaign
    FROM invite_codes i
    JOIN creators c ON c.id = i.creator_id
    JOIN campaigns ca ON ca.id = i.campaign_id
    WHERE ca.name = ?
      AND i.status != 'used'
      AND c.status != 'do_not_contact'
    ORDER BY c.handle ASC
    ${limit > 0 ? 'LIMIT ?' : ''}
  `;
  return limit > 0
    ? db.prepare(sql).all(campaignName, limit)
    : db.prepare(sql).all(campaignName);
}

function getCampaignStats(db, campaignName) {
  return db.prepare(`
    SELECT
      ca.name AS campaign,
      COUNT(i.id) AS total_invites,
      SUM(CASE WHEN i.status = 'used' THEN 1 ELSE 0 END) AS used_invites,
      SUM(CASE WHEN i.status != 'used' THEN 1 ELSE 0 END) AS unused_invites,
      COUNT(DISTINCT c.id) AS creators
    FROM campaigns ca
    LEFT JOIN invite_codes i ON i.campaign_id = ca.id
    LEFT JOIN creators c ON c.id = i.creator_id
    WHERE ca.name = ?
    GROUP BY ca.id
  `).get(campaignName);
}

module.exports = {
  listUnusedInvites,
  getCampaignStats,
};
