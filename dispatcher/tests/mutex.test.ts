import { describe, test, expect } from 'bun:test'
import { Mutex } from '../src/utils/mutex.js'

describe('Mutex', () => {
  test('single acquire/release works', async () => {
    const m = new Mutex()
    await m.acquire()
    // Should be held — release should not throw
    m.release()
  })

  test('multiple concurrent acquires are serialized in FIFO order', async () => {
    const m = new Mutex()
    const order: number[] = []

    // First acquirer grabs the lock
    await m.acquire()

    // Queue up 3 more acquirers
    const p1 = m.acquire().then(() => { order.push(1) })
    const p2 = m.acquire().then(() => { order.push(2) })
    const p3 = m.acquire().then(() => { order.push(3) })

    // None should have run yet
    expect(order).toEqual([])

    // Release the first hold — should unblock p1
    m.release()
    await p1
    expect(order).toEqual([1])

    // Release for p2
    m.release()
    await p2
    expect(order).toEqual([1, 2])

    // Release for p3
    m.release()
    await p3
    expect(order).toEqual([1, 2, 3])

    // Final release to leave mutex unheld
    m.release()
  })

  test('release unblocks next waiter', async () => {
    const m = new Mutex()
    let unblocked = false

    await m.acquire()

    const waiter = m.acquire().then(() => { unblocked = true })

    // Give microtask queue a chance — waiter should still be blocked
    await new Promise(r => setTimeout(r, 10))
    expect(unblocked).toBe(false)

    // Release should unblock the waiter
    m.release()
    await waiter
    expect(unblocked).toBe(true)

    m.release()
  })

  test('mutex can be reacquired after full release', async () => {
    const m = new Mutex()
    await m.acquire()
    m.release()
    // Should be able to acquire again
    await m.acquire()
    m.release()
  })
})
