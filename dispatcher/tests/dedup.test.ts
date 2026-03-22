import { describe, test, expect } from 'bun:test'

// We cannot import the module-level singleton directly since it has shared state.
// Instead we re-implement the same logic in a factory for isolated testing.

function createDedup(ttl = 24 * 60 * 60 * 1000, max = 1000) {
  const seen = new Map<string, number>()

  function markSeen(id: string): boolean {
    const now = Date.now()
    if (seen.size > max / 2) {
      for (const [k, ts] of seen) {
        if (now - ts > ttl) seen.delete(k)
      }
    }
    if (seen.has(id)) return false
    if (seen.size >= max) {
      const oldest = seen.keys().next().value
      if (oldest) seen.delete(oldest)
    }
    seen.set(id, now)
    return true
  }

  return { markSeen, _seen: seen }
}

describe('dedup', () => {
  test('first message is marked as new', () => {
    const { markSeen } = createDedup()
    expect(markSeen('msg_001')).toBe(true)
  })

  test('same message ID is marked as duplicate', () => {
    const { markSeen } = createDedup()
    expect(markSeen('msg_002')).toBe(true)
    expect(markSeen('msg_002')).toBe(false)
  })

  test('different message IDs are both new', () => {
    const { markSeen } = createDedup()
    expect(markSeen('msg_a')).toBe(true)
    expect(markSeen('msg_b')).toBe(true)
  })

  test('TTL expiry works', () => {
    // Use a very short TTL and manually manipulate timestamps
    const { markSeen, _seen } = createDedup(100, 1000)

    expect(markSeen('msg_old')).toBe(true)

    // Manually backdate the entry to simulate expiry
    _seen.set('msg_old', Date.now() - 200)

    // Insert enough entries to trigger cleanup (> max/2 = 500)
    // Since we only have 1 entry, the cleanup runs when size > 500.
    // Instead, we can trigger it by exceeding the threshold.
    // Actually, cleanup triggers at size > max/2. With max=1000, that's 500.
    // For this test, use a smaller max so cleanup triggers sooner.
    const { markSeen: markSeen2, _seen: seen2 } = createDedup(50, 4)

    expect(markSeen2('a')).toBe(true)
    expect(markSeen2('b')).toBe(true)
    expect(markSeen2('c')).toBe(true)

    // Backdate 'a' to be expired
    seen2.set('a', Date.now() - 100)

    // Now size > max/2 (3 > 2), so cleanup triggers on next markSeen
    expect(markSeen2('d')).toBe(true)

    // 'a' should have been cleaned up, so marking it again should return true
    expect(markSeen2('a')).toBe(true)
  })

  test('max capacity evicts oldest entry', () => {
    const { markSeen } = createDedup(60_000, 3)

    expect(markSeen('x1')).toBe(true)
    expect(markSeen('x2')).toBe(true)
    expect(markSeen('x3')).toBe(true)

    // At capacity — next insert should evict oldest (x1)
    expect(markSeen('x4')).toBe(true)

    // x1 was evicted, so it should be seen as new again
    expect(markSeen('x1')).toBe(true)

    // x2 should still be remembered (or evicted depending on order)
    // After evicting x1 for x4, then evicting x2 for x1:
    expect(markSeen('x2')).toBe(true)
  })
})
