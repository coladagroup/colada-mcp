import { describe, expect, it } from 'vitest'
import { hostOf, parseEnv } from '../src/config.js'

describe('config', () => {
  it('AC15: COLADA_ENV defaults to stage', () => {
    expect(parseEnv(undefined)).toBe('stage')
    expect(parseEnv('')).toBe('stage')
    expect(hostOf('stage', 'default')).toBe('stage-admin.colada365.com')
  })

  it('rejects other values', () => {
    expect(() => parseEnv('dev')).toThrow('COLADA_ENV must be stage or prod, got "dev".')
  })

  it('uses the fixed realm-host table', () => {
    expect(hostOf('prod', 'default')).toBe('admin.colada365.com')
    expect(hostOf('prod', 'vw')).toBe('vw.colada365.com')
    expect(hostOf('prod', 'abiomed')).toBe('abiomed.colada365.com')
    expect(hostOf('prod', 'lidl')).toBe('lidl-football-hub.com')
    expect(hostOf('stage', 'vw')).toBeUndefined()
    expect(hostOf('stage', 'abiomed')).toBeUndefined()
    expect(hostOf('stage', 'lidl')).toBeUndefined()
  })
})
