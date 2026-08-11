import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import './shell.css'

export interface VirtualListProps<T> {
  items: readonly T[]
  renderRow: (item: T, index: number) => ReactNode
  /** Height guess in px. Only affects scrollbar accuracy until a row is measured. */
  estimateSize?: number
  overscan?: number
  /** Deep-link target (`?record=`). Scrolled to once per distinct value. */
  scrollToIndex?: number
  /** Defaults to the item's index, which is what `ParsedRecord.index` already is. */
  getKey?: (item: T, index: number) => string | number
  empty?: ReactNode
  className?: string
  label?: string
}

export function VirtualList<T>({
  items,
  renderRow,
  estimateSize = 96,
  overscan = 8,
  scrollToIndex,
  getKey,
  empty = 'Nothing to show.',
  className,
  label,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const count = items.length

  // The virtualizer memoises measurements against its option identities, so
  // these must not be re-created on every render of a 3k-row list.
  const getKeyRef = useRef(getKey)
  useEffect(() => {
    getKeyRef.current = getKey
  })

  const estimate = useCallback(() => estimateSize, [estimateSize])
  const getItemKey = useCallback(
    (index: number) => {
      const fn = getKeyRef.current
      return fn ? fn(items[index], index) : index
    },
    [items],
  )

  // Start the window where the deep link points instead of scrolling there after
  // mount. Scrolling after mount leaves the two out of step — the element ends up
  // at the right scrollTop while the rendered range is still the one from offset
  // 0, so the row is never in the DOM and the reader sees blank space until they
  // touch the wheel. Read once, on the first render, which is when it applies.
  const initialOffset = useRef(
    scrollToIndex != null && scrollToIndex > 0 ? scrollToIndex * estimateSize : 0,
  ).current

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    overscan,
    getItemKey,
    initialOffset,
  })

  const lastTarget = useRef<number | null>(null)
  useEffect(() => {
    // An out-of-range target is not dropped: records stream in, so the index may
    // only become reachable on a later batch.
    if (scrollToIndex == null || scrollToIndex < 0 || scrollToIndex >= count) return
    if (lastTarget.current === scrollToIndex) return
    lastTarget.current = scrollToIndex
    virtualizer.scrollToIndex(scrollToIndex, { align: 'start' })
    // Rows are measured after that first jump, so the offset it landed on was
    // still an estimate. One more pass once the real heights are in.
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(scrollToIndex, { align: 'start' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [scrollToIndex, count, virtualizer])

  if (count === 0) {
    return <div className={['vlist-empty', className].filter(Boolean).join(' ')}>{empty}</div>
  }

  return (
    <div
      ref={scrollRef}
      className={['vlist', className].filter(Boolean).join(' ')}
      role="list"
      aria-label={label}
      tabIndex={0}
    >
      {/* presentation: keeps the rows direct ARIA children of the list */}
      <div
        className="vlist-canvas"
        role="presentation"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="vlist-row"
            role="listitem"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderRow(items[row.index], row.index)}
          </div>
        ))}
      </div>
    </div>
  )
}
