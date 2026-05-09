# Importers

Importer modules normalize operator-provided creator lists into SQLite state.

- `importCampaign.js` imports pushed invite-code lists and optional initial
  ready lists for a campaign.
- `importRegistered.js` imports actual registered/activated lists after the
  initial push. It matches by invite code first, then unique handle/name/email
  matches, updates creator/invite activation state, writes
  `creator_activation_events`, and returns unmatched rows for review.

## Current Status

As of 2026-05-09:

- `npm run import` is the campaign/import path for pushed invite-code lists.
- `npm run import-registered` is the activation import path and supports
  `.xlsx`, `.xls`, `.csv`, `.tsv`, and text files.
- Activation imports update `creators.status`, `invite_codes.status`, and the
  activation audit log.
- `/followup` can also mark selected creators/invite codes as activated
  manually through the creator management surface.
- A web upload/control for registered-list import is still pending; the CLI
  path is implemented.
