import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { useTooltip } from '../Tooltip.js'

export type PanelBadgeLevel = 'info' | 'warning' | 'error'

export interface PanelBarTab {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly badge?: { readonly level: PanelBadgeLevel; readonly unread: number } | null
}

export interface PanelBarProps {
  readonly tabs: readonly PanelBarTab[]
  readonly activeId: string | undefined
  readonly width: number
  readonly focused: boolean
  readonly canExpand?: boolean
  readonly onExpand?: () => void
  readonly onSelect?: (id: string) => void
}

function badgeColor(level: PanelBadgeLevel): 'warning' | 'error' | 'accent' {
  if (level === 'warning') return 'warning'
  if (level === 'error') return 'error'
  return 'accent'
}

function badgeLabel(tab: PanelBarTab): string {
  if (tab.badge == null) return ''
  return tab.badge.unread > 0 ? ` ${tab.badge.unread}` : ' •'
}

function tabTitle(tab: PanelBarTab): string {
  return tab.title.replace(/\s+/gu, ' ')
}

function truncateCells(text: string, maxCells: number): string {
  if (maxCells < 1) return ''
  if (stringWidth(text) <= maxCells) return text
  let out = ''
  let cells = 0
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const width = stringWidth(segment)
    if (cells + width > maxCells - 1) break
    out += segment
    cells += width
  }
  return out + '…'
}

const TAB_GAP = 2

/** Keep a contiguous window stable while fitting the active tab and available width. */
function tabWindow(widths: readonly number[], activeIndex: number, startHint: number, width: number): {
  start: number
  end: number
  arrowWidth: number
} {
  const count = widths.length
  if (count === 0 || width < 1) return { start: 0, end: 0, arrowWidth: 0 }
  const prefix = [0]
  for (const cells of widths) prefix.push(prefix[prefix.length - 1]! + cells)
  const arrowWidth = (start: number, end: number): number => {
    const hiddenSides = Number(start > 0) + Number(end < count)
    // At extreme widths keep at least one cell for the selected text.
    return hiddenSides === 0 ? 0 : Math.min(2, Math.floor((width - 1) / hiddenSides))
  }
  const measured = (start: number, end: number): number => prefix[end]! - prefix[start]!
    + Math.max(0, end - start - 1) * TAB_GAP
    + (Number(start > 0) + Number(end < count)) * arrowWidth(start, end)
  if (measured(0, count) <= width) return { start: 0, end: count, arrowWidth: 0 }
  let start = Math.max(0, Math.min(startHint, activeIndex))
  let end = activeIndex + 1
  while (start < activeIndex && measured(start, end) > width) start += 1
  if (measured(start, end) <= width) {
    while (end < count && measured(start, end + 1) <= width) end += 1
    while (start > 0 && measured(start - 1, end) <= width) start -= 1
  }
  return { start, end, arrowWidth: arrowWidth(start, end) }
}

function PanelTab({ tab, left, width, active, hovered, onHover, onSelect }: {
  tab: PanelBarTab
  left: number
  width: number
  active: boolean
  hovered: boolean
  onHover: (id: string | null) => void
  onSelect?: (id: string) => void
}): React.ReactNode {
  const tooltip = useTooltip(tab.title)
  const title = tabTitle(tab)
  const badge = badgeLabel(tab)
  const showBadge = stringWidth(badge) < width
  const titleWidth = width - (showBadge ? stringWidth(badge) : 0)
  const clipped = stringWidth(title) > titleWidth
  return (
    <Box
      position="absolute"
      left={left}
      top={0}
      width={width}
      height={1}
      flexShrink={0}
      overflow="hidden"
      onMouseEnter={event => {
        if (clipped) tooltip.onMouseEnter(event)
        onHover(tab.id)
      }}
      onMouseLeave={() => { tooltip.onMouseLeave(); onHover(null) }}
      onClick={onSelect === undefined ? undefined : event => {
        event.stopImmediatePropagation()
        onSelect(tab.id)
      }}
    >
      <Text bold={active} dimColor={!active && !hovered} color={active ? 'accent' : undefined} wrap="truncate-end">
        {truncateCells(title, titleWidth)}
      </Text>
      {showBadge && tab.badge != null && <Text color={badgeColor(tab.badge.level)} bold>{badge}</Text>}
    </Box>
  )
}

export function PanelBar({ tabs, activeId, width, focused, canExpand, onExpand, onSelect }: PanelBarProps): React.ReactNode {
  const [expandHovered, setExpandHovered] = React.useState(false)
  const [hoveredTab, setHoveredTab] = React.useState<string | null>(null)
  const startRef = React.useRef(0)
  const activeIndex = Math.max(0, tabs.findIndex(tab => tab.id === activeId))
  const contentWidth = Math.max(0, Math.floor(width) - 2)
  const expandWidth = canExpand === true ? Math.max(0, Math.min(2, contentWidth - 1)) : 0
  const tabWidth = contentWidth - expandWidth
  const widths = tabs.map(tab => Math.max(1, stringWidth(tabTitle(tab) + badgeLabel(tab))))
  const window = tabWindow(widths, activeIndex, startRef.current, tabWidth)
  React.useLayoutEffect(() => { startRef.current = window.start }, [window.start])
  const hiddenLeft = window.start > 0
  const hiddenRight = window.end < tabs.length
  const labelBudget = tabWidth - (Number(hiddenLeft) + Number(hiddenRight)) * window.arrowWidth
  let left = hiddenLeft ? window.arrowWidth : 0
  const visibleTabs = tabs.slice(window.start, window.end).map((tab, index) => {
    const cells = Math.min(widths[window.start + index]!, labelBudget)
    const position = { tab, left, width: cells }
    left += cells + TAB_GAP
    return position
  })
  return (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Box width={contentWidth} height={1} position="relative" overflow="hidden" flexShrink={0}>
        {visibleTabs.map(position => (
          <PanelTab
            key={position.tab.id}
            {...position}
            active={position.tab.id === tabs[activeIndex]?.id}
            hovered={hoveredTab === position.tab.id}
            onHover={setHoveredTab}
            onSelect={onSelect}
          />
        ))}
        {hiddenLeft && window.arrowWidth > 0 && (
          <Box
            position="absolute" left={0} top={0} width={window.arrowWidth} height={1}
            onClick={event => { event.stopImmediatePropagation(); onSelect?.(tabs[window.start - 1]!.id) }}
          >
            <Text color={focused ? 'accent' : 'inactive'}>◀</Text>
          </Box>
        )}
        {hiddenRight && window.arrowWidth > 0 && (
          <Box
            position="absolute" left={tabWidth - window.arrowWidth} top={0} width={window.arrowWidth} height={1} justifyContent="flex-end"
            onClick={event => { event.stopImmediatePropagation(); onSelect?.(tabs[window.end]!.id) }}
          >
            <Text color={focused ? 'accent' : 'inactive'}>▶</Text>
          </Box>
        )}
        {expandWidth > 0 && (
          <Box
            position="absolute"
            left={contentWidth - 1}
            top={0}
            width={1}
            height={1}
            onMouseEnter={() => { setExpandHovered(true) }}
            onMouseLeave={() => { setExpandHovered(false) }}
            onClick={event => { event.stopImmediatePropagation(); onExpand?.() }}
          >
            <Text bold={expandHovered} color={expandHovered || focused ? 'accent' : 'inactive'}>⤢</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
