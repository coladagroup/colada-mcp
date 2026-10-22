export class ToolError extends Error {}

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
  invalidId: (field: string, value: string) => `${field} "${value}" is not a valid Colada id.`,
  forbidden: (path: string) =>
    `GET ${path} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`,
  failed: (path: string, status: number | null) => `GET ${path} failed (${status ?? 'no response'}).`,
  keycloakUnreachable: (host: string, status: number | null) =>
    `Keycloak at ${host} is not reachable (HTTP ${status ?? 'no response'}).`,
  keycloakRefused: (host: string, status: number) => `Keycloak at ${host} refused the token request (HTTP ${status}).`,
  logoutFailed: (realms: string[]) =>
    `Could not remove the stored session of realm ${realms.join(', ')} from the OS keyring. Call logout again.`,
  noWorkspace: (realm: string) => `You have no workspace in realm ${realm}.`
}
