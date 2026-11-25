export type ErrorOutcome = 'login_required' | 'refused' | 'backend_error' | 'conflict'

export class ToolError extends Error {
  constructor(
    message: string,
    readonly outcome: ErrorOutcome = 'backend_error',
    readonly reason = 'error'
  ) {
    super(message)
  }
}

export class ResponseTooLargeError extends ToolError {
  constructor(message: string) {
    super(message, 'refused', 'tooLarge')
  }
}

export const messages = {
  loginOpened: (realm: string, host: string, url: string) =>
    `Login opened in your browser for realm ${realm} on ${host}. Finish it, then call the tool again. If no browser tab opened, open this URL: ${url}`,
  noBrowserLogin: () =>
    'Colada sign-in needed; this server runs without a browser. Sign in from an interactive session first.',
  loginInProgress: () => 'Login is in progress in your browser. Finish it, then call the tool again.',
  loggedOut: () => 'The session ended while this call was running. Call the tool again.',
  noAccess: (workspace: string, realm: string) =>
    `No access to workspace ${workspace} in realm ${realm}. You are not a member of it, it does not exist, or it belongs to another realm (see list_workspaces).`,
  realmUnknown: (host: string, status: number | null) =>
    `Cannot read the Keycloak realm of ${host} (HTTP ${status ?? 'no response'}). Check COLADA_HOSTS.`,
  duplicateRealm: (realm: string) => `Two hosts in COLADA_HOSTS use realm ${realm}. Keep only one of them.`,
  unknownRealm: (value: string) => `Unknown realm "${value}". Leave realm out unless the user names another realm.`,
  forbidden: (method: string, path: string) =>
    `${method} ${path} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`,
  failed: (method: string, path: string, status: number | null) =>
    `${method} ${path} failed (${status ?? 'no response'}).`,
  notFound: (method: string, path: string, workspace: string) =>
    `${method} ${path} returned 404 in workspace ${workspace}: the object or the route does not exist. Check the path with get_api_doc.`,
  conflict: (method: string, path: string, status: number) =>
    `${method} ${path} was refused (${status}): the object changed since you read it, or a business rule refused it. Read it again with api_get and retry once with the new X-ETag value as If-Match; if it is refused again, stop and tell the user.`,
  ifMatchRequired: (method: string, path: string) =>
    `${method} ${path} was refused (428): this route needs If-Match. Read the object with api_get and pass its X-ETag value as If-Match.`,
  writeUnauthorized: (method: string, path: string) =>
    `${method} ${path} was refused (401): the session token was not accepted. The request was not sent again. Call api_write again; the user approves it again.`,
  tooLarge: (method: string, path: string) =>
    `The response of ${method} ${path} is larger than 500 KB and is not returned. Ask for less: "select" with only the paths you need (for example ["id", "status"]), a smaller Range (for example "Range: events 0-20"), a narrower query, or a projection in the path (for example /api/events:(title,start)).`,
  downloadTooLarge: (method: string, path: string) =>
    `The response of ${method} ${path} is larger than 10 MB and was not downloaded. Ask for less: a smaller Range (for example "Range: events 0-20") or a narrower query.`,
  badSelect: (path: string, reason: string) => `select path "${path}": ${reason}.`,
  writeBodyNotReturned: (method: string, path: string, status: number, reason: string) =>
    `${method} ${path} succeeded (${status}), but its response body is not returned: ${reason}. The change was applied: do not send it again. Read the object with api_get if you need it.`,
  writeBudget: (method: string, path: string, limit: number) =>
    `${method} ${path} was not sent: this server allows at most ${limit} writes per minute. Nothing was changed. Wait a minute and send it again, or split the job into smaller parts.`,
  writeNoResponse: (method: string, path: string) =>
    `${method} ${path} got no response (timeout or network error). The change may have been applied: read the object with api_get before you send it again.`,
  invalidJson: (method: string, path: string, status: number) => `${method} ${path} returned invalid JSON (${status}).`,
  notJson: (method: string, path: string, contentType: string) =>
    `${method} ${path} returned ${contentType}, not JSON. File downloads are not supported.`,
  apiDocNeedsService: () => 'Pass "service" together with "doc".',
  apiDocBadName: (doc: string) =>
    `Doc name "${doc}" is not allowed: use a name from the service list (letters, digits, "-", "_", ".").`,
  apiDocNoService: (service: string) =>
    `No API docs for service "${service}". Call get_api_doc without service for the list.`,
  apiDocSeveral: (service: string, docs: string[]) =>
    `Service ${service} has several API docs: ${docs.join(', ')}. Pass "doc".`,
  apiDocNotFound: (service: string, doc: string) =>
    `No API doc "${doc}" for service "${service}". Call get_api_doc with only the service to see its docs.`,
  apiDocForbidden: () =>
    'get_api_doc was refused (403): your role lacks the permission api:api-doc:view. Ask an admin.',
  apiDocTooLarge: (service: string, doc: string) =>
    `The API doc ${service}/${doc} is larger than 500 KB and is not returned.`,
  serviceNotAllowed: (service: string) =>
    `Service "${service}" is not allowed. Pass a backoffice service name like s-events (lower case). CONSR services (s-consr-*) cannot be called with this token.`,
  pathNotAllowed: (path: string, reason: string) =>
    `Path "${path}" is not allowed: ${reason}. Put query parameters in "query".`,
  methodNotAllowed: (method: string) =>
    `Method "${method}" is not supported by api_write. Use POST, PUT or PATCH; use api_get for GET.`,
  deleteNotAllowed: (path: string) =>
    `DELETE ${path} is blocked: only DELETE routes on the MCP allowlist are sent, and this route is not on it. Delete data in the backoffice.`,
  deleteRoute: (method: string, path: string) =>
    `${method} ${path} is blocked: this route deletes data (MCP delete denylist). Delete data in the backoffice.`,
  secretRoute: (method: string, path: string) =>
    `${method} ${path} is blocked: this route reads or changes secrets (SMTP, Stripe, tokens, passwords, OTP). It is always blocked.`,
  personalData: (method: string, path: string) =>
    `${method} ${path} may return personal data and is off. To turn it on, set COLADA_ALLOW_PERSONAL_DATA=true in the MCP config and restart the client.`,
  headerNotAllowed: (name: string) =>
    `Header "${name}" is not allowed. Only Range and If-Match can be passed; the MCP sets Authorization, Accept, Accept-Language and the workspace itself.`,
  keycloakUnreachable: (host: string, status: number | null) =>
    `Keycloak at ${host} is not reachable (HTTP ${status ?? 'no response'}).`,
  keycloakRefused: (host: string, status: number) => `Keycloak at ${host} refused the token request (HTTP ${status}).`,
  logoutFailed: (realms: string[]) =>
    `Could not remove the stored session of realm ${realms.join(', ')} from the OS keyring. Call logout again.`,
  noWorkspace: (realm: string) => `You have no workspace in realm ${realm}.`,
  firebaseOtherWorkspace: () => 'The Firebase token is for another workspace. Nothing was read.',
  firebaseBadConfig: (workspace: string, field: string, value: string) =>
    `The Campaigns config of workspace ${workspace} has an invalid ${field} ("${value}"). Nothing was read.`,
  firebaseNoAccess: (workspace: string) =>
    `You have no Campaigns access in workspace ${workspace} (campaigns_app:view).`,
  firebaseNotSetUp: (workspace: string) => `Campaigns is not set up for workspace ${workspace}.`,
  firebaseSignInFailed: (status: number | null, code: string | null) =>
    `Firebase sign-in failed (${status ?? 'no response'}${code ? `, ${code}` : ''}). Nothing was read.`,
  firebasePermissionsUnreadable: (workspace: string) =>
    `Cannot read your Campaigns permissions in workspace ${workspace}. Nothing was read.`,
  firebaseRefused: (path: string) => `Firebase refused the read of ${path} (expired token or a rules violation).`,
  firebaseTooLarge: (store: string, path: string, indexes: string) =>
    `${store} ${path} is larger than 10 MB. Narrow it with orderBy on an indexed child (${indexes}), limitToFirst / limitToLast, or shallow.`,
  firebaseFailed: (store: string, path: string, status: number | null) =>
    `${store} ${path} failed (${status ?? 'no response'}).`,
  firebasePath: (path: string, reason: string) =>
    `Path "${path}" is not allowed: ${reason}. Paths are relative to the workspace, for example "timesheet" or "projects/<id>".`,
  firebaseNotFound: (store: string, path: string) => `Nothing found at ${store} ${path}.`,
  firebasePersonalNode: (node: string) =>
    `${node} holds personal data. It is off; COLADA_ALLOW_PERSONAL_DATA=true turns it on.`,
  firebaseMissingPermission: (permissions: readonly string[], workspace: string, node: string) =>
    `You lack ${permissions.length === 1 ? permissions[0] : `one of ${permissions.join(', ')}`} in workspace ${workspace}, so ${node} cannot be read.`,
  firebaseHiddenField: (field: string, option: string) =>
    `"${field}" is personal data and is hidden, so it cannot be used in ${option}. COLADA_ALLOW_PERSONAL_DATA=true shows it.`,
  firebaseQuery: (reason: string) => `The query options are not valid: ${reason}.`,
  firebaseNoIndex: (child: string, node: string, indexes: string) =>
    `RTDB has no index on "${child}" for ${node}. Use an indexed child (${indexes}) or "where" (filters after a full download).`,
  firebaseResultTooLarge: () =>
    'The result is larger than 500 KB and is not returned. Use "select", "fields", "where", "groupBy" or a narrower path.',
  firebaseNotRecords: (option: string, path: string) =>
    `"${option}" works on a list of records, but ${path} is one record.`,
  firebaseOwnRowsOnly: () =>
    'With only "own timesheet" access the MCP filters by your rows; orderBy, equalTo, startAt, endAt, limits and shallow cannot be set.',
  firebaseNoShallow: (node: string) =>
    `shallow is not available for ${node}: its records are filtered by project. Use "fields" to get small records.`,
  firebaseHiddenSetTooLarge: (kind: string, node: string) =>
    `${kind} of this workspace is larger than 10 MB. The MCP reads it to hide projects you may not see, so ${node} cannot be read.`,
  firebaseEntityKeyed: (node: string) =>
    `${node} cannot be read: it is keyed by budget rows, activities and other entities, so the MCP cannot hide ${node} of projects you may not see.`,
  firebaseAccessChanged: () =>
    'Your Campaigns access changed while this call was running. Nothing was returned; call the tool again.',
  firebaseSecretField: (field: string, option: string) =>
    `"${field}" is a secret and is never returned, so it cannot be used in ${option}.`,
  writeConflict: (path: string, tries: number) =>
    `${path} changed ${tries} times while the MCP wrote it, so the change was not saved. Nothing more was written. Try the call again.`,
  writeMissingPermission: (permission: string, workspace: string, tool: string) =>
    `You lack ${permission} in workspace ${workspace}, so ${tool} cannot write.`,
  writeHidden: (kind: string, id: string) => `${kind} ${id} is not found or is hidden from you. Nothing was written.`,
  writeForeignEntry: (key: string) =>
    `Timesheet entry ${key} is not yours. Only your own entries can be changed. Nothing was written.`,
  writeEntryMoved: (key: string) =>
    `Timesheet entry ${key} was moved (project, row or date) while this call ran. Nothing was written. Read it again and retry.`,
  writePersonalField: (field: string) =>
    `"${field}" is personal data. Writing it needs COLADA_ALLOW_PERSONAL_DATA=true. Nothing was written.`,
  writeMissingReference: (kind: string, id: string, workspace: string) =>
    `${kind} "${id}" does not exist in workspace ${workspace}. Nothing was written.`,
  writeUnknownCostCenter: (id: string, workspace: string, known: string[], more: number) =>
    `Cost center "${id}" does not exist in workspace ${workspace}. Nothing was written. ${
      known.length === 0
        ? 'The workspace has no cost centers.'
        : `Cost centers (uid: name): ${known.join('; ')}${more > 0 ? `; and ${more} more (rtdb_get costCenters/list)` : ''}.`
    }`,
  writeUnknownUser: (field: string, workspace: string) =>
    `${field}: no Campaigns user of workspace ${workspace} has this uid or email. Nothing was written.`,
  usersListForbidden: (field: string) =>
    `${field} can only be your own uid: your role lacks api:users:list, so the MCP cannot check other users. Nothing was written.`,
  sessionEndsSoon: (endsAt: string, minutes: number) =>
    `Your Colada login ends at ${endsAt} (in about ${minutes} min). After that the next call opens the browser login. Finish open writes first.`,
  previewRequired: (tool: string, host: string) =>
    `${tool} on ${host} (a prod host) needs a preview first. Call it with preview: true and the same input, check the writes with the user, then call it again with the previewId from that answer within 10 minutes. Nothing was read or written.`,
  badUpdatePath: (path: string, reason: string) => `Path "${path}": ${reason}. Nothing was sent.`,
  updateNoChange: () => 'set and remove are both empty. Pass at least one path to change.',
  updateNotRecord: () =>
    'The GET did not return a JSON object or array, so api_update cannot change it. Use api_write. Nothing was written.',
  updateNoRevision: (method: string, path: string) =>
    `${method} ${path} needs If-Match, but the GET returned no revision (no X-ETag or ETag). Nothing was written.`,
  batchItemRefused: (index: number, reason: string) => `Item ${index}: ${reason} Nothing was sent.`,
  batchBudget: (items: number, remaining: number, limit: number) =>
    `The batch has ${items} writes, but only ${remaining} of ${limit} writes per minute are left. Nothing was sent. Wait a minute or send fewer items.`,
  writeBadDate: (reason: string) => `${reason}.`,
  writePartial: (tool: string, saved: string[], notSaved: string[], state: string) =>
    `${tool} stopped after a partial write. Saved: ${saved.join(', ')}. Not saved: ${notSaved.join(', ')}. ${state}`,
  writePathNotAllowed: (method: string, path: string, tool: string) =>
    `${method} ${path} is not allowed for ${tool}. Nothing was written.`,
  writeRefused: (path: string) =>
    `Firebase refused the write to ${path} (expired token or a rules violation). Nothing was written by this request.`,
  writeArchived: (id: string) => `Offer ${id} is archived and cannot be changed.`,
  writeLeadHasOffer: (id: string) => `Lead ${id} already has an offer (planner/${id}).`,
  writeBadParentRow: (uid: string, offer: string) => `parentRow "${uid}" is not in the budget of offer ${offer}.`,
  writeUnknownRow: (uid: string, offer: string) =>
    `Row "${uid}" is not in the budget of offer ${offer}. Nothing was written.`,
  writeBadMove: (uid: string) => `Row "${uid}" cannot be moved into itself or its own sub-rows. Nothing was written.`,
  writeRowHasSubRows: (uid: string) =>
    `Row "${uid}" has sub-rows. Pass withSubRows: true to remove it together with its sub-rows. Nothing was written.`,
  writeRowHasReports: (uid: string, name: string, copies: number) =>
    `Row "${uid}" (${name}) or its sub-rows have ${copies} timesheet copies. Move or change those timesheet entries first, so no copy is left without its row. Nothing was written.`,
  writeLastRow: (offer: string) =>
    `The budget of offer ${offer} would have no rows left, and a budget needs at least one row. Add the new rows first (campaigns_add_budget_rows with replaceBlankRow: true replaces the blank row). Nothing was written.`,
  writeNoBlankRow: (offer: string) =>
    `replaceBlankRow: the budget of offer ${offer} has no blank row (empty name, no price, no sub-rows, no timesheet copies). Nothing was written.`,
  writeLeadArchived: (id: string) => `Lead ${id} is archived and cannot be changed.`,
  writeBadPosition: (position: number, length: number) => `position ${position} is outside 0..${length}.`,
  writeTicketEntity: (ticket: string) =>
    `entity cannot be set for service ticket ${ticket}: service-ticket entries have no budget copy. Nothing was written.`,
  writeNoFields: (idField: string) => `Pass at least one field to change besides ${idField}.`,
  writeMissingField: (field: string) => `"${field}" is required (from the input or the lead). Nothing was written.`,
  writeIdentityField: (field: string) => `"${field}" cannot be set. The MCP sets it from your login.`,
  writeUnknownField: (field: string) => `"${field}" is not an input of this tool.`,
  writeFailed: (method: string, path: string, status: number, reason: string | null) =>
    `${method} ${path} failed (${status})${reason ? `: ${reason}` : ''}. Nothing was written by this request.`
}

type MessageKey = keyof typeof messages

const OUTCOMES: Partial<Record<MessageKey, ErrorOutcome>> = {
  loginOpened: 'login_required',
  noBrowserLogin: 'login_required',
  loginInProgress: 'login_required',
  loggedOut: 'login_required',
  realmUnknown: 'backend_error',
  failed: 'backend_error',
  writeUnauthorized: 'backend_error',
  writeNoResponse: 'backend_error',
  invalidJson: 'backend_error',
  notJson: 'backend_error',
  keycloakUnreachable: 'backend_error',
  keycloakRefused: 'backend_error',
  logoutFailed: 'backend_error',
  firebaseSignInFailed: 'backend_error',
  firebasePermissionsUnreadable: 'backend_error',
  firebaseFailed: 'backend_error',
  writePartial: 'backend_error',
  writeFailed: 'backend_error',
  conflict: 'conflict',
  writeConflict: 'conflict',
  writeEntryMoved: 'conflict',
  firebaseAccessChanged: 'conflict'
}

type Failures = { [K in MessageKey]: (...args: Parameters<(typeof messages)[K]>) => ToolError }

export const fail = Object.fromEntries(
  Object.entries(messages).map(([key, format]) => [
    key,
    (...args: unknown[]) =>
      new ToolError((format as (...a: unknown[]) => string)(...args), OUTCOMES[key as MessageKey] ?? 'refused', key)
  ])
) as Failures
