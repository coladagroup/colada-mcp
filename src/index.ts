#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import open from 'open'
import { App } from './app.js'
import { keyringStore } from './auth/tokenStore.js'
import { fileCallLog } from './callLog.js'
import { type Env, parseEnv } from './config.js'
import { createServer } from './server.js'

const log = (message: string) => process.stderr.write(`${message}\n`)

let env: Env
try {
  env = parseEnv(process.env.COLADA_ENV)
} catch (err) {
  log(`colada-mcp: ${(err as Error).message}`)
  process.exit(1)
}

const app = new App({
  env,
  fetch: globalThis.fetch,
  store: keyringStore,
  now: () => Date.now() / 1000,
  log,
  callLog: fileCallLog(),
  openBrowser: async (url) => {
    const child = await open(url)
    child.on('error', () => undefined)
  }
})

await createServer(app).connect(new StdioServerTransport())
