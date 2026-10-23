export class ToolError extends Error {}

export class ResponseTooLargeError extends ToolError {}

export const messages = {
  loginOpened: (realm: string, host: string, url: string) =>
    `Login opened in your browser for realm ${realm} on ${host}. Finish it, then call the tool again. If no browser tab opened, open this URL: ${url}`,
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
    `${method} ${path} was refused (${status}): the object changed since you read it. Read it again with api_get and pass the new ETag as If-Match.`,
  ifMatchRequired: (method: string, path: string) =>
    `${method} ${path} was refused (428): this route needs If-Match. Read the object with api_get and pass its ETag as If-Match.`,
  writeUnauthorized: (method: string, path: string) =>
    `${method} ${path} was refused (401): the session token was not accepted. The request was not sent again. Call api_write again; the user approves it again.`,
  tooLarge: (method: string, path: string) =>
    `The response of ${method} ${path} is larger than 500 KB and is not returned. Ask for less: a smaller Range (for example "Range: events 0-20"), a narrower query, or a projection in the path (for example /api/events:(title,start)).`,
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
  personalDataService: (service: string) =>
    `${service} holds personal data and is off. To turn it on, set COLADA_ALLOW_PERSONAL_DATA=true in the MCP config and restart the client.`,
  personalDataRoute: (method: string, path: string) =>
    `${method} ${path} may return personal data and is off. To turn it on, set COLADA_ALLOW_PERSONAL_DATA=true in the MCP config and restart the client.`,
  headerNotAllowed: (name: string) =>
    `Header "${name}" is not allowed. Only Range and If-Match can be passed; the MCP sets Authorization, Accept, Accept-Language and the workspace itself.`,
  keycloakUnreachable: (host: string, status: number | null) =>
    `Keycloak at ${host} is not reachable (HTTP ${status ?? 'no response'}).`,
  keycloakRefused: (host: string, status: number) => `Keycloak at ${host} refused the token request (HTTP ${status}).`,
  logoutFailed: (realms: string[]) =>
    `Could not remove the stored session of realm ${realms.join(', ')} from the OS keyring. Call logout again.`,
  noWorkspace: (realm: string) => `You have no workspace in realm ${realm}.`
}
