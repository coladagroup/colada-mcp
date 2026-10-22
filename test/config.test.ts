import { describe, expect, it } from 'vitest'
import { parseHosts } from '../src/config.js'

describe('config', () => {
  it('AC15: COLADA_HOSTS defaults to admin.colada365.com', () => {
    expect(parseHosts({})).toEqual(['admin.colada365.com'])
    expect(parseHosts({ COLADA_HOSTS: '' })).toEqual(['admin.colada365.com'])
    expect(parseHosts({ COLADA_HOSTS: ' , ' })).toEqual(['admin.colada365.com'])
  })

  it('reads a comma-separated list of host names in order', () => {
    expect(parseHosts({ COLADA_HOSTS: 'stage-admin.colada365.com' })).toEqual(['stage-admin.colada365.com'])
    expect(parseHosts({ COLADA_HOSTS: ' Admin.Colada365.com , client.example.com ' })).toEqual([
      'admin.colada365.com',
      'client.example.com'
    ])
  })

  it.each([
    'https://admin.colada365.com',
    'admin.colada365.com/auth',
    'admin.colada365.com:443',
    'localhost',
    'a b.com'
  ])('rejects %s', (value) => {
    expect(() => parseHosts({ COLADA_HOSTS: value })).toThrow(
      'COLADA_HOSTS must be a comma-separated list of host names'
    )
  })

  it('rejects the same host twice', () => {
    expect(() => parseHosts({ COLADA_HOSTS: 'a.example.com,A.example.com' })).toThrow(
      'COLADA_HOSTS lists the same host twice.'
    )
  })

  it('stops when the old COLADA_ENV is set, so an old stage config does not silently use prod', () => {
    expect(() => parseHosts({ COLADA_ENV: 'stage' })).toThrow('COLADA_ENV is no longer used. Set COLADA_HOSTS instead')
    expect(parseHosts({ COLADA_ENV: '' })).toEqual(['admin.colada365.com'])
  })
})
