# colada-mcp

Local MCP server for Colada support (VFIVE-5977). It runs on your laptop next to Claude Desktop, Claude Code or Cursor and calls the Colada backoffice API with your own Colada login and roles.

Tools:

| Tool | What it does |
|---|---|
| `list_workspaces` | Lists the workspaces you can open. |
| `get_conventions` | Returns the Colada API conventions the model should read before a write: paging, filters, revisions and update rules. No backend call. |
| `get_api_doc` | Lists the backoffice services with API docs and a one-line description of each doc, or returns the OpenAPI YAML of one service. The descriptions come from the backend at run time (`s-ecosystem`); the package holds none. |
| `api_get` | Sends one GET to a backoffice service (`s-*`) in one workspace. Returns the status, the JSON body and the headers `Content-Range`, `ETag`, `X-ETag`, `Location`. |
| `api_write` | Sends one POST, PUT or PATCH with a JSON body. **It changes data.** |
| `rtdb_get` | Reads one node of the Campaigns Realtime Database in one workspace. Optional `where`, `fields`, `groupBy` and `sum` run in the MCP, for exact totals. Read only. |
| `firestore_get` | Reads one document or one page of a collection of the Campaigns Firestore. Read only. |
| `campaigns_budget` | Computes the budget of one Campaigns project or offer with the app's rules (reserve fees, options, VAT, exchange rates). Read only. |
| `logout` | Ends the stored session. |

> **Breaking change in 0.3.0.** The typed read tools `list_events`, `get_event`, `list_email_templates`, `get_email_template` and `get_registration_form` are removed. Use `api_get` instead (read the service doc with `get_api_doc` first). The server is no longer read-only.

## Install

You only need Node.js 20 or later. Always use an exact version, as below. To update, change the version in your config on purpose.

### Claude Desktop

Open Settings → Developer → Edit Config and add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "colada": {
      "command": "npx",
      "args": ["-y", "@colada-ag/mcp@0.3.0"]
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add colada -- npx -y @colada-ag/mcp@0.3.0
```

### Cursor

Open Cursor Settings → MCP → Add new global MCP server, or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "colada": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@colada-ag/mcp@0.3.0"]
    }
  }
}
```

Use the global `~/.cursor/mcp.json`, not a project `.cursor/mcp.json`. In Cursor Settings → MCP, `colada` must be enabled and show 5 tools. If it fails with `spawn npx ENOENT`, Cursor does not find `npx` (for example with nvm): put the full path from `which npx` into `command`.

Keep Privacy Mode on (Settings → General → Privacy) and do not turn on auto-run for these tools.

## Hosts and realms

`COLADA_HOSTS` is a comma-separated list of backoffice host names, without `https://`. The default is `admin.colada365.com`. Add it to `env` in the config above, for example for stage:

```json
"env": { "COLADA_HOSTS": "stage-admin.colada365.com" }
```

In Claude Code:

```bash
claude mcp add colada --env COLADA_HOSTS=stage-admin.colada365.com -- npx -y @colada-ag/mcp@0.3.0
```

The server reads the Keycloak realm of each host from that host's public backoffice config. Tokens of a realm go only to its own host.

With one host, the tools have no realm parameter. With several hosts, for example `admin.colada365.com,<customer host>`, the tools get a `realm` parameter. Without it, they use the realm of the first host. Each host must have its own realm.

The old `COLADA_ENV` setting is no longer used. If it is set, the server stops with an error.

## Writes and approval

`api_write` is marked as a destructive tool, so the client asks you before each call. Read the request (method, path, body) before you approve it.

> **Do not choose "Always allow" for `api_write`.** After that the client sends every write without asking you, also writes the model made up or got wrong. You are the only check between the model and the customer's data.

The MCP refuses some requests before anything is sent, whatever your roles allow:

- every HTTP `DELETE`, and a fixed list of routes that delete data (bulk PATCH and delete jobs); deleting data stays a manual backoffice action;
- routes that read or change secrets (SMTP, Stripe, Firebase tokens, password and OTP reset);
- CONSR services (`s-consr-*`), paths outside `/api/`, and headers other than `Range` and `If-Match`.

## Personal data

Services that hold personal data (guests, contacts, users, speakers, invoices, payments, emails and others) are off by default; a few routes of mixed services stay open (for example workspace settings and document templates). To turn them on, set `COLADA_ALLOW_PERSONAL_DATA=true` in `env` and restart the client:

```json
"env": { "COLADA_ALLOW_PERSONAL_DATA": "true" }
```

Only the exact value `true` turns it on. Turn it on only when the task needs personal data, and turn it off again afterwards.

## Campaigns (Firebase)

Campaigns data is not in the backoffice API but in Firebase. The Firebase tools only read; they never write and never call Cloud Functions.

- The server gets a Firebase token with your own Colada login for the workspace of the call. The token stays in memory and is not stored; Firebase access ends with your Colada session.
- You see what the Campaigns app shows you: the MCP checks your Campaigns permissions per data node, keeps only your own timesheet rows when you have only "own timesheet" access, and leaves out projects you may not see.
- Personal data (for example timesheet descriptions, people on projects, contacts, chats, accounts) is removed unless `COLADA_ALLOW_PERSONAL_DATA=true`. Secrets are never returned.

## Login

The first tool call opens the Colada login in your browser. Log in, then ask Claude to retry. The session is kept in the OS keychain (service `colada-mcp`) and lasts about one working day, also after a restart.

Each realm has its own login. The first call with another realm opens a second browser login on that realm's host. Log in there with your own user of that realm.

To end the session, ask Claude to call `logout`. With several hosts and no realm, it logs out from all realms.

## Call log

Every tool call writes one line to `~/.colada-mcp/calls.log`: time, realm, user, workspace, tool, HTTP status, and for `get_api_doc`, `api_get` and `api_write` also method, service, path, query and whether `If-Match` was sent. For the Firebase tools it holds app, store, path and the query options; `where` is logged without its values. The log never holds tokens, request or response bodies, or header values. Query values are logged as given, so a filter on a person's email appears there.

## Data and privacy

The server can only read and change what your Colada user may read and change. But every tool answer becomes part of the AI chat and is sent to Anthropic (in Cursor: to Cursor and the model provider selected there). Ask only for the customer data you need.

## Local development

```bash
npm ci
npm run build
npm test
npx biome check .
```

Add the local build to Claude Code:

```bash
claude mcp add colada -- node /path/to/colada-mcp/dist/index.js
```

## Release

Releases are published to npm only by the `publish.yml` workflow, through npm trusted publishing (no npm token). Set the new version in `package.json`, merge to `master`, then push the tag `v<version>`.
