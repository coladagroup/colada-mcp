# Changelog

## 0.7.0

### New tools
- `api_write_batch`: up to 25 `api_write` requests in one workspace with one approval. All items are checked before the first request; the batch stops at the first failure and lists each item as done, failed or not run.
- `campaigns_update_lead`: changes the fields of one lead. A name or status change is copied to the offer of the lead.
- `campaigns_update_budget_row`: changes or moves one row of an offer budget.
- `campaigns_remove_budget_rows`: removes rows from an offer budget. Rows with timesheet copies and the last row are refused. No Firebase node is deleted.
- `campaigns_kb_search`: finds knowledge base items by a part of the name, at any depth.

### Changes
- Preview: every write tool takes `preview: true`. It runs all checks and reads and returns the writes without sending them.
- On prod hosts (every host whose name does not start with `stage-`), a real `campaigns_*` write needs the `previewId` of a preview of the same tool with the same input. It is valid for 10 minutes and works once.
- `select` on `api_get` and `rtdb_get` keeps only the named paths of the answer. `api_get` now downloads up to 10 MB; the answer limit stays 500 KB.
- `campaigns_add_budget_rows` takes `replaceBlankRow: true` to replace the blank row of a new offer.
- `projectManager` (offers) and `accountManager` (leads) take the uid or email of a Campaigns user of the workspace and store the uid. A new lead gets you as account manager unless another user is given.
- `campaigns_update_offer` returns `deal: {exists, synced}`.
- `list_workspaces` returns `sessionEndsAt`. In the last 30 minutes before it, every answer has a `notice`.
- Call log lines have `pid`, `client`, `outcome` and `reason`. A write tool that sent nothing logs `method: null`. `get_conventions` is logged.
- New conventions, each checked on stage: contact lists need Range; the guest list projection is ignored (use `select`); resource `rn_<name>` and PUT by id; email-logger filter by `emailTemplate._id`; which email template fields a PATCH keeps or clears; timesheet entries belong to the logged-in user.

### Fixes
- A cost center at any depth of the tree is accepted; an unknown one is refused with the list of known cost centers.
