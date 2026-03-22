/** Creates a debounced flush function that waits `ms` before executing. */
export function createDebouncedFlush(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }
}
