import type { ApiCallInput } from './apiCall.js'

export function newEventNextStep(
  method: string,
  input: ApiCallInput,
  response: { status: number; body: unknown; headers: Record<string, string> }
): string | undefined {
  if (method !== 'POST' || input.service !== 's-events' || input.path.replace(/\/$/, '') !== '/api/events') {
    return undefined
  }
  if (response.status < 200 || response.status >= 300) return undefined
  const id = idOf(response.body) ?? response.headers.Location?.split('/').at(-1)
  if (!id) return undefined
  return (
    `Event ${id} has no departments yet. If the workspace uses org structure (feature toggle modules:organizational-structure), ` +
    'set them now, or users cannot see the event and copying it (POST /api/events/{id}/copies) fails with 502: ' +
    'GET s-orgstructure /api/orgstructure/users/me/departments, then ' +
    `PUT s-orgstructure /api/orgstructure/events/${id}/departments with a JSON array of department ids ` +
    `(for an event of a campaign: /api/orgstructure/campaigns/{campaign_id}/events/${id}/departments). ` +
    'If users/me/departments returns no departments, the workspace has no org structure: skip this step.'
  )
}

function idOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const id = (body as Record<string, unknown>).id
  return typeof id === 'string' && id !== '' ? id : undefined
}
