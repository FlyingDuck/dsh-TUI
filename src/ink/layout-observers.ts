/**
 * Commit-wide layout observers. onComputeLayout calls notifyLayoutObservers()
 * after every Yoga pass, so an observer sees a subtree's new geometry even
 * when the component that owns the measurement did not re-render (e.g. a
 * child's local state grew it). Observers run inside React's commit, before
 * the deferred paint: a guarded setState there re-renders synchronously and
 * the next frame already uses the corrected value.
 */
const observers = new Set<() => void>()

export function observeLayout(observer: () => void): () => void {
  observers.add(observer)
  return () => {
    observers.delete(observer)
  }
}

export function notifyLayoutObservers(): void {
  for (const observer of observers) observer()
}
