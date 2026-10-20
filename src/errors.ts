export class ToolError extends Error {}

export const messages = {
  loginOpened: (realm: string, host: string, url: string) =>
    `Login opened in your browser for realm ${realm} on ${host}. Finish it, then call the tool again. If no browser tab opened, open this URL: ${url}`,
  loginInProgress: () => 'Login is in progress in your browser. Finish it, then call the tool again.',
  loggedOut: () => 'The session ended while this call was running. Call the tool again.',
  noAccess: (workspace: string, realm: string) =>
    `No access to workspace ${workspace} in realm ${realm}. You are not a member of it, it does not exist, or it belongs to another realm (see list_workspaces).`,
  realmNotAvailable: (realm: string, env: string) =>
    `Realm ${realm} is not available on ${env}. Use default, or run with COLADA_ENV=prod.`,
  unknownRealm: (value: string) => `Unknown realm "${value}". Use default unless the user names another realm.`,
  invalidId: (field: string, value: string) => `${field} "${value}" is not a valid Colada id.`,
  forbidden: (path: string) =>
    `GET ${path} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`,
  failed: (path: string, status: number | null) => `GET ${path} failed (${status ?? 'no response'}).`,
  keycloakUnreachable: (host: string, status: number | null) =>
    `Keycloak at ${host} is not reachable (HTTP ${status ?? 'no response'}).`,
  noWorkspace: (realm: string) => `You have no workspace in realm ${realm}.`
}
