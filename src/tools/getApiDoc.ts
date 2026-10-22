import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { callBackend } from '../api/backend.js'
import type { App } from '../app.js'
import { messages, ResponseTooLargeError, ToolError } from '../errors.js'
import { checkService, MAX_RESPONSE_BYTES } from '../policy/index.js'
import { openRealm, realmShape, runApiTool } from './run.js'

const DOCS_SERVICE = 's-ecosystem'
const CATALOG_PATH = '/api/api-docs'
const DOC_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/

interface ServiceDocs {
  service: string
  docs: Array<{ name: string; path: string }>
}

export function registerGetApiDoc(server: McpServer, app: App) {
  server.registerTool(
    'get_api_doc',
    {
      description:
        'Reads the OpenAPI description of the Colada backoffice API. Without `service` it lists the services and their doc names. With `service` (and `doc` when the service has several) it returns the OpenAPI YAML. Read the doc before you call api_get or api_write on a service.',
      inputSchema: {
        ...realmShape(app),
        service: z
          .string()
          .optional()
          .describe(
            'Service name, for example s-events-resources. Leave it out to list all services that have API docs.'
          ),
        doc: z
          .string()
          .optional()
          .describe('Doc name from the service list. Needed only when the service has several docs.')
      },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const call = { method: 'GET', service: DOCS_SERVICE, path: CATALOG_PATH, query: {}, ifMatch: false }
      return runApiTool(app, 'get_api_doc', params.realm, call, async (ctx) => {
        const { service, doc } = params
        if (service) checkService(service)
        else if (doc) throw new ToolError(messages.apiDocNeedsService())
        if (doc !== undefined && !DOC_NAME.test(doc)) throw new ToolError(messages.apiDocBadName(doc))
        const { session } = await openRealm(app, ctx, params.realm)
        const get = (path: string, notFound?: string) => {
          ctx.call.path = path
          return callBackend(
            app.api,
            session,
            {
              workspaceId: null,
              path: `/_gw/${DOCS_SERVICE}${path}`,
              maxBytes: MAX_RESPONSE_BYTES,
              forbidden: messages.apiDocForbidden(),
              notFound
            },
            ctx.state
          )
        }
        if (!service) return { services: (await get(CATALOG_PATH)).body }
        const name = doc ?? (await singleDoc(service, () => get(CATALOG_PATH)))
        return { service, doc: name, apiDoc: await fetchDoc(service, name, get) }
      })
    }
  )
}

async function singleDoc(service: string, catalog: () => Promise<{ body: unknown }>): Promise<string> {
  const entries = (await catalog()).body
  const entry = Array.isArray(entries) ? (entries as ServiceDocs[]).find((item) => item.service === service) : undefined
  if (!entry) throw new ToolError(messages.apiDocNoService(service))
  const [first, ...rest] = entry.docs
  if (!first) throw new ToolError(messages.apiDocNoService(service))
  if (rest.length > 0)
    throw new ToolError(
      messages.apiDocSeveral(
        service,
        entry.docs.map((item) => item.name)
      )
    )
  return first.name
}

async function fetchDoc(
  service: string,
  doc: string,
  get: (path: string, notFound?: string) => Promise<{ body: unknown }>
): Promise<unknown> {
  const path = `${CATALOG_PATH}/${encodeURIComponent(service)}/${encodeURIComponent(doc)}`
  try {
    return (await get(path, messages.apiDocNotFound(service, doc))).body
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw new ToolError(messages.apiDocTooLarge(service, doc))
    throw err
  }
}
