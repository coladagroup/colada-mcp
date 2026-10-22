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
      "args": ["-y", "@colada-ag/mcp@0.2.0"]
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add colada -- npx -y @colada-ag/mcp@0.2.0
```

### Cursor

Open Cursor Settings → MCP → Add new global MCP server, or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "colada": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@colada-ag/mcp@0.2.0"]
    }
  }
}
```

Use the global `~/.cursor/mcp.json`, not a project `.cursor/mcp.json`. In Cursor Settings → MCP, `colada` must be enabled and show 7 tools. If it fails with `spawn npx ENOENT`, Cursor does not find `npx` (for example with nvm): put the full path from `which npx` into `command`.

Keep Privacy Mode on (Settings → General → Privacy) and do not turn on auto-run for these tools.

## Hosts and realms

`COLADA_HOSTS` is a comma-separated list of backoffice host names, without `https://`. The default is `admin.colada365.com`. Add it to `env` in the config above, for example for stage:

```json
"env": { "COLADA_HOSTS": "stage-admin.colada365.com" }
```

In Claude Code:

```bash
claude mcp add colada --env COLADA_HOSTS=stage-admin.colada365.com -- npx -y @colada-ag/mcp@0.2.0
```

The server reads the Keycloak realm of each host from that host's public backoffice config. Tokens of a realm go only to its own host.

With one host, the tools have no realm parameter. With several hosts, for example `admin.colada365.com,<customer host>`, the tools get a `realm` parameter. Without it, they use the realm of the first host. Each host must have its own realm.

The old `COLADA_ENV` setting is no longer used. If it is set, the server stops with an error.

## Login

The first tool call opens the Colada login in your browser. Log in, then ask Claude to retry. The session is kept in the OS keychain (service `colada-mcp`) and lasts about one working day, also after a restart.

Each realm has its own login. The first call with another realm opens a second browser login on that realm's host. Log in there with your own user of that realm.

To end the session, ask Claude to call `logout`. With several hosts and no realm, it logs out from all realms.

## Call log

Every tool call writes one line to `~/.colada-mcp/calls.log`: time, realm, user, workspace, tool, parameters and HTTP status. The log never holds tokens or response data.

## Data and privacy

The server only reads data that your Colada user can see. But every tool answer becomes part of the AI chat and is sent to Anthropic (in Cursor: to Cursor and the model provider selected there). Ask only for the customer data you need.

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
