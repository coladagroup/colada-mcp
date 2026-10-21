# colada-mcp

Local, read-only MCP server for Colada support (VFIVE-5977). It runs on your laptop next to Claude Desktop or Claude Code and reads Colada data with your own Colada login.

Tools: `list_workspaces`, `list_events`, `get_event`, `get_registration_form`, `list_email_templates`, `get_email_template`, `logout`.

## Install

You only need Node.js 20 or later. Always use an exact version, as below. To update, change the version in your config on purpose.

### Claude Desktop

Open Settings → Developer → Edit Config and add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "colada": {
      "command": "npx",
      "args": ["-y", "@colada/mcp@0.1.0"],
      "env": { "COLADA_ENV": "stage" }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add colada --env COLADA_ENV=stage -- npx -y @colada/mcp@0.1.0
```

On a Colada developer laptop, `~/.npmrc` may send the `@colada` scope to the internal Artifact Registry. Then `npx` cannot find the package. Add the public registry for this command:

```bash
claude mcp add colada --env COLADA_ENV=stage -- npx -y --@colada:registry=https://registry.npmjs.org @colada/mcp@0.1.0
```

## Environment and realms

`COLADA_ENV` is `stage` (the default, also when empty) or `prod`. Any other value stops the server with an error.

Each realm has its own host:

| Realm | stage | prod |
|---|---|---|
| `default` | `stage-admin.colada365.com` | `admin.colada365.com` |
| `vw` | — | `vw.colada365.com` |
| `abiomed` | — | `abiomed.colada365.com` |
| `lidl` | — | `lidl-football-hub.com` |

The dedicated realms `vw`, `abiomed` and `lidl` work only on prod. On stage, a call with one of them fails with an error.

## Login

The first tool call opens the Colada login in your browser. Log in, then ask Claude to retry. The session is kept in the OS keychain (service `colada-mcp`) and lasts about one working day, also after a restart.

Each realm has its own login. The first call with a dedicated realm opens a second browser login on that realm's host. Log in there with your own user of that realm.

To end the session, ask Claude to call `logout`. Without a realm it logs out from all realms.

## Call log

Every tool call writes one line to `~/.colada-mcp/calls.log`: time, realm, user, workspace, tool, parameters and HTTP status. The log never holds tokens or response data.

## Data and privacy

The server only reads data that your Colada user can see. But every tool answer becomes part of the AI chat and is sent to Anthropic. Ask only for the customer data you need.

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
