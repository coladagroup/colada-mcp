import { randomInt } from 'node:crypto'

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'

export function pushKey(nowMs: number): string {
  let time = Math.floor(nowMs)
  let stamp = ''
  for (let i = 0; i < 8; i++) {
    stamp = PUSH_CHARS.charAt(time % 64) + stamp
    time = Math.floor(time / 64)
  }
  let random = ''
  for (let i = 0; i < 12; i++) random += PUSH_CHARS.charAt(randomInt(64))
  return stamp + random
}
