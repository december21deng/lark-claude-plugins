const DEDUP_TTL = 24 * 60 * 60 * 1000
const DEDUP_MAX = 1000

const seen = new Map<string, number>()

/** Returns true if the id is new (marks it as seen). */
export function markSeen(id: string): boolean {
  const now = Date.now()
  // Periodic cleanup
  if (seen.size > DEDUP_MAX / 2) {
    for (const [k, ts] of seen) {
      if (now - ts > DEDUP_TTL) seen.delete(k)
    }
  }
  if (seen.has(id)) return false
  if (seen.size >= DEDUP_MAX) {
    const oldest = seen.keys().next().value
    if (oldest) seen.delete(oldest)
  }
  seen.set(id, now)
  return true
}
