import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

export interface RankedTask {
  uid?: unknown
  rank?: unknown
}

function rankOf(task: RankedTask): string | null {
  return typeof task.rank === 'string' && task.rank !== '' ? task.rank : null
}

export function taskList(tasks: unknown): RankedTask[] {
  if (tasks === null || typeof tasks !== 'object') return []
  return Object.values(tasks).filter(
    (item): item is RankedTask => item !== null && typeof item === 'object' && !Array.isArray(item)
  )
}

function byRank(a: { rank: string | null; uid: string }, b: { rank: string | null; uid: string }): number {
  const x = a.rank ?? ''
  const y = b.rank ?? ''
  if (x !== y) return x < y ? -1 : 1
  return a.uid.localeCompare(b.uid)
}

function rankBetween(prev: string | null, next: string | null): string {
  try {
    if (prev && next && prev >= next) return generateKeyBetween(prev, null)
    return generateKeyBetween(prev, next)
  } catch {
    return generateKeyBetween(null, null)
  }
}

function effectiveRanks(tasks: unknown): Array<{ rank: string | null; uid: string }> {
  const list = taskList(tasks).map((task) => ({
    rank: rankOf(task),
    uid: typeof task.uid === 'string' ? task.uid : ''
  }))
  let index = 0
  while (index < list.length) {
    if (list[index]?.rank) {
      index += 1
      continue
    }
    const start = index
    while (index < list.length && !list[index]?.rank) index += 1
    const prev = start > 0 ? (list[start - 1]?.rank ?? null) : null
    const next = index < list.length ? (list[index]?.rank ?? null) : null
    let keys: string[]
    try {
      keys = generateNKeysBetween(prev, next, index - start)
    } catch {
      keys = generateNKeysBetween(null, null, index - start)
    }
    keys.forEach((key, offset) => {
      const item = list[start + offset]
      if (item) item.rank = key
    })
  }
  return list.sort(byRank)
}

export function rankAtEnd(tasks: unknown): string {
  return rankBetween(effectiveRanks(tasks).at(-1)?.rank ?? null, null)
}
