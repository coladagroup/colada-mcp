import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import { CHANCES, CURRENCIES, OFFER_STATUSES } from '../firebase/campaigns/writes/offer.js'
import {
  CREATE_LEAD,
  CREATE_OFFER,
  createLead,
  createOffer,
  UPDATE_OFFER,
  updateOffer
} from '../firebase/campaigns/writes/offers.js'
import { pushKey } from '../firebase/campaigns/writes/pushKey.js'
import { realmShape, runFirebaseWriteTool, WRITE_TOOL_ANNOTATIONS, workspaceInput, writeInput } from './run.js'

const id = (what: string) => z.string().min(1).max(200).describe(what)
const text = (what: string, max = 500) => z.string().max(max).optional().describe(what)
const eventTime = (what: string) => z.string().optional().describe(`${what}, yyyy-MM-ddTHH:mm (local time).`)
const PERSONAL = 'Personal data: needs COLADA_ALLOW_PERSONAL_DATA=true.'

const offerFields = {
  name: text('Offer name.'),
  status: z.enum(OFFER_STATUSES).optional(),
  client: text('Directory account id.', 200),
  person: text(`Directory contact id. ${PERSONAL}`, 200),
  country: text('Country.'),
  postcode: text('Postcode.'),
  place: text('Place.'),
  address: text('Address.'),
  po: text('Purchase order number.'),
  eventsNum: z.number().int().min(1).optional().describe('Number of events. Default 1.'),
  startDate: eventTime('Start'),
  endDate: eventTime('End, not before the start'),
  x_setup_start: eventTime('Setup start'),
  x_setup_end: eventTime('Setup end'),
  x_setdown_start: eventTime('Setdown start'),
  x_setdown_end: eventTime('Setdown end'),
  location: text('Directory location id.', 200),
  rooms: z.array(z.string().min(1).max(200)).max(100).optional().describe('Room ids of the location.'),
  guests: z.number().int().min(0).optional().describe('Default 10.'),
  costCenter: text('Uid of a node in costCenters.', 200),
  currency: z.enum(CURRENCIES).optional().describe('Default CHF.'),
  notes: text(`Free text. ${PERSONAL}`, 10000),
  projectManager: text('Project manager email.', 320),
  participants: z.array(z.email()).max(200).optional().describe(`Participant emails. ${PERSONAL}`)
}

const prefix = text('Task board prefix. Default: the first letters of the name.', 50)

const WRITTEN_NOTE =
  'The output lists every write in "written". There is no undo and no dry run: check the values with the user first.'

function firstWrite(method: 'PUT' | 'PATCH', path: string) {
  return {
    app: 'campaigns' as const,
    store: 'rtdb' as const,
    method,
    path,
    paths: null,
    ifMatch: method === 'PUT',
    retries: 0
  }
}

export function registerOfferTools(server: McpServer, app: App) {
  server.registerTool(
    CREATE_OFFER,
    {
      description: `Creates a Campaigns offer (planner) in one workspace, as the Planner "new offer" dialog does: the next offer number, one empty budget row and the task boards. With "lead" the offer gets the lead's id and email address and takes name, client, contact (as person) and status from the lead unless given. name, client, startDate and endDate are required. owner is always you. ${WRITTEN_NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        lead: id('Key of a lead in deals that has no offer yet.').optional(),
        prefix,
        ...offerFields
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) => {
      const now = app.deps.now() * 1000
      const fresh = { id: pushKey(now), externalId: pushKey(now) }
      return runFirebaseWriteTool(app, CREATE_OFFER, params.realm, firstWrite('PUT', 'projectCounter'), (ctx) =>
        createOffer(app, ctx, params, fresh)
      )
    }
  )
  server.registerTool(
    UPDATE_OFFER,
    {
      description: `Changes settings of one Campaigns offer, as the offer Settings dialog does. Only the given fields change. A new client clears person and a new location clears rooms, unless they are given too. name and status are copied to the lead of the offer. Archived offers cannot be changed. ${WRITTEN_NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        offer: id('Key of the offer in planner.'),
        ...offerFields
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) =>
      runFirebaseWriteTool(app, UPDATE_OFFER, params.realm, firstWrite('PATCH', '/'), (ctx) =>
        updateOffer(app, ctx, params)
      )
  )
  server.registerTool(
    CREATE_LEAD,
    {
      description: `Creates a Campaigns lead (deals) in the Pipeline of one workspace, as the Pipeline "new lead" dialog does, with its task boards and email address. No account manager is set. name is personal data, so this tool needs COLADA_ALLOW_PERSONAL_DATA=true. owner is always you. ${WRITTEN_NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        name: z.string().min(1).max(500).describe(`Lead name. ${PERSONAL}`),
        client: text('Directory account id.', 200),
        contact: text(`Directory contact id. ${PERSONAL}`, 200),
        summary: text(`Free text. ${PERSONAL}`, 10000),
        status: z.enum(OFFER_STATUSES).optional().describe('Default qualified.'),
        chance: z.enum(CHANCES).optional().describe('Default 25%.'),
        closeDate: z.iso.datetime().optional().describe('ISO date-time, for example 2027-04-01T00:00:00.000Z.'),
        prefix
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) => {
      const now = app.deps.now() * 1000
      const fresh = { id: pushKey(now), externalId: pushKey(now) }
      return runFirebaseWriteTool(app, CREATE_LEAD, params.realm, firstWrite('PATCH', '/'), (ctx) =>
        createLead(app, ctx, params, fresh)
      )
    }
  )
}
