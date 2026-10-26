import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { DOMElement } from '../dom.js'
import { observeLayout } from '../layout-observers.js'

/**
 * Track a box's laid-out height in rows across every commit.
 *
 * A plain useLayoutEffect only re-measures when its own component renders,
 * which misses a subtree that grows from a descendant's local state (a
 * multi-line draft, a questionnaire switching pages). This hook re-reads the
 * computed height after every Yoga pass and sets state only when the row
 * count changes, so unchanged commits never enqueue an update (React's
 * nested-update limit).
 *
 * @returns a ref callback for the measured box and its height in rows
 *   (0 until the first layout).
 */
export function useCommittedHeight(): [ref: (element: DOMElement | null) => void, rows: number] {
  const elementRef = useRef<DOMElement | null>(null)
  const reportedRef = useRef(0)
  const [rows, setRows] = useState(0)
  const measure = useCallback(() => {
    const height = elementRef.current?.yogaNode?.getComputedHeight()
    if (height === undefined) return
    const next = Math.max(0, Math.ceil(height))
    if (next === reportedRef.current) return
    reportedRef.current = next
    setRows(next)
  }, [])
  useLayoutEffect(() => {
    measure()
    return observeLayout(measure)
  }, [measure])
  const ref = useCallback((element: DOMElement | null) => {
    elementRef.current = element
  }, [])
  return [ref, rows]
}
