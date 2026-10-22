import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchPage, PAGE_SIZE } from '../api/paging.js'
import type { App } from '../app.js'
import { openRealm, realmShape, runTool, workspaceInput } from './run.js'

const PATH = '/_gw/s-events/api/events:(title,start,end,timeZone,status,isTemplate,archived)'
const DEFAULT_Q = 'status=!FINISHED&archived=!true&isTemplate=!true'

const DESCRIPTION = [
  'Lists events in one workspace, 100 per call, sorted by title. `q` is a Colada filter expression; without `q` the tool lists active events: `status=!FINISHED&archived=!true&isTemplate=!true`.',
  'Grammar: `field=value` equals, `field=!value` not equal, `&` combines conditions, `(...)` groups, `title=*text*` contains text.',
  "Backoffice tabs, for reference: Active `status=!FINISHED&archived=!true`, Finished `status=FINISHED&archived=!true`, Templates `isTemplate=true&archived=!true`, Archived `archived=true`. The backoffice tabs do not exclude templates; this tool's default does.",
  "Date range on `start` or `end`: format `yyyy-MM-ddTHH:mm`, `[` / `]` inclusive, `(` / `)` exclusive, for example `start=[2026-10-01T00:00,2026-11-01T00:00)`. Use an exclusive upper bound for whole days. Do not use seconds, `Z` or time-zone offsets. Times are the event's local time.",
  'All events are listed, including events not in the Guests app, so counts can differ from the backoffice list. When `nextOffset` is present, call again with `offset = nextOffset`.'
].join('\n')

interface EventItem {
  uid?: string
  properties?: Record<string, unknown>
}

function toItem(event: EventItem) {
  const properties = event.properties ?? {}
  return {
    id: event.uid ?? null,
    title: properties.title ?? null,
    start: properties.start ?? null,
    end: properties.end ?? null,
    timeZone: properties.timeZone ?? null,
    status: properties.status ?? null,
    isTemplate: properties.isTemplate ?? false,
    archived: properties.archived ?? false
  }
}

export function registerListEvents(server: McpServer, app: App) {
  server.registerTool(
    'list_events',
    {
      description: DESCRIPTION,
      inputSchema: {
        ...realmShape(app),
        workspace: workspaceInput,
        q: z.string().optional().describe('Colada filter expression. Leave it out for active events.'),
        offset: z.number().int().min(0).optional().describe('Index of the first event. Default: 0.')
      },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      return runTool(app, 'list_events', params, async (ctx) => {
        const { session, directory } = await openRealm(app, ctx, params.realm)
        const offset = params.offset ?? 0
        const workspace = await directory.resolve(params.workspace, ctx.state)
        ctx.workspace = workspace
        const page = await fetchPage(
          app.api,
          session,
          { workspaceId: workspace.id, path: PATH, query: `q=${encodeURIComponent(params.q || DEFAULT_Q)}` },
          'events',
          offset,
          ctx.state
        )
        return {
          total: page.total,
          offset,
          ...(offset + PAGE_SIZE < page.total ? { nextOffset: offset + PAGE_SIZE } : {}),
          items: (page.items as EventItem[]).map(toItem)
        }
      })
    }
  )
}
