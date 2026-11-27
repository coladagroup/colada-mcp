# Changelog

## 0.8.2

### Changes
- Firebase reads keep the `token` parameter of Firebase Storage links when `COLADA_ALLOW_PERSONAL_DATA=true`, so snapshot PDFs can be downloaded from the `pdf` link. With personal data off the token is still removed.

## 0.8.1

### Changes
- s-notifications rule routes work without personal data: read, create, update and copy of `/api/notification-rules`, plus `available-actions` and `available-entities`. The notification feed (`/api/notifications`) stays personal data.

## 0.8.0

### New tools
- `api_update`: changes a few fields of one record without sending the whole record yourself. It reads the record, applies `set` and `remove` at dot paths and sends the full record with `If-Match` from the GET. The answer lists only the changed paths. `preview: true` sends only the GET. The guest schema PUT is refused (use `api_write` with the list of property names).
- `campaigns_update_project`: sets the status and/or type of a Campaigns project. Nothing else of the project is written.
- `campaigns_create_task`: creates a task on the task boards of a project, offer or lead, as the app does: next task number with the board prefix, at the end of the board, optional link to an invoice.
- `campaigns_update_task`: changes the title, description, due date, priority, assignees and board of a task. A move to a final board sets `finishedAt`. No task is archived or deleted.
- The task tools write no notification, email or file: tell assignees yourself. They need the task permission of the source (projects, offers or leads tasks, or `campaigns_app/tasks:manage`), and archived sources are read-only.

### Changes
- `list_workspaces` returns `version` and, when the session is shorter than 9.5 h because it reuses the browser sign-in, a `sessionNote` with how to get a full 10 h session.
- `COLADA_NO_BROWSER=1` (or `true`): a call that needs a sign-in answers `login_required` at once, without a browser or a local listener. A valid stored session still works.
- DELETE of one s-staffing requirement and one event resource (UUID paths only). All other DELETE routes stay blocked.
- The whole s-staffing service is personal data.
- Firebase reads remove the `token` parameter from Firebase Storage links, also inside HTML.
- A workspace error lists at most 10 workspaces and points to `list_workspaces`.
- An error with an empty backend body says that the backend gave no reason.
- New conventions, each checked on stage: s-staffing routes and strict mode, projections that answer 404/403, contact and account POST and search, guest schema field removal, form structure PUT sets PENDING, email template `name` is fixed, `select` on knowledgeBase.
- README: version 0.8.0 in the examples, how to update, a stage server entry, session length and no-browser mode.

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
