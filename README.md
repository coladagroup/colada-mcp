# colada-mcp

Local, read-only MCP server for Colada support (VFIVE-5977).

## Local development

```bash
npm ci
npm run build
npm test
npx biome check .
```

Add the local build to Claude Code (stage is the default; set `COLADA_ENV=prod` for prod):

```bash
claude mcp add colada -- node /path/to/colada-mcp/dist/index.js
```

The refresh token of each realm is kept in the OS keyring (service `colada-mcp`, account = realm host). The call log is `~/.colada-mcp/calls.log`.
