export const DEFAULT_HOST = 'admin.colada365.com'

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function parseHosts(env: Record<string, string | undefined>): string[] {
  if (env.COLADA_ENV) {
    throw new Error(
      'COLADA_ENV is no longer used. Set COLADA_HOSTS instead, for example COLADA_HOSTS=stage-admin.colada365.com for stage.'
    )
  }
  const hosts = (env.COLADA_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '')
  if (hosts.length === 0) return [DEFAULT_HOST]
  const invalid = hosts.find((host) => !HOST_NAME.test(host))
  if (invalid !== undefined) {
    throw new Error(`COLADA_HOSTS must be a comma-separated list of host names, got "${invalid}".`)
  }
  if (new Set(hosts).size !== hosts.length) throw new Error('COLADA_HOSTS lists the same host twice.')
  return hosts
}
