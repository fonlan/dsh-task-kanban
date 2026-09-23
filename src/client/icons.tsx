import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** Props every shell icon accepts: square edge in px, color rides currentColor. */
export interface IconProps {
  size?: number
  className?: string
}

/** One shell icon component. */
export type IconComponent = (props: IconProps) => JSX.Element

/** The runtime export table, read by capability instead of by one hard-coded name. */
const table = primitives as unknown as Record<string, IconComponent | undefined>

/** First name the runtime actually provides (a missing export is `undefined`). */
function firstDefined(...names: string[]): IconComponent | undefined {
  for (const name of names) {
    let candidate: IconComponent | undefined
    try {
      candidate = table[name]
    } catch {
      // Some module namespaces reject unknown names instead of yielding
      // `undefined`; a rename must never throw on its way to the fallback.
      continue
    }
    if (typeof candidate === 'function') return candidate
  }
  return undefined
}

/**
 * Self-contained 16×16 checklist glyph (the 0.1.7 artwork) used when the shell
 * primitives expose none of the names above: the footer entry must render
 * something even on a runtime whose icon exports we do not know.
 */
function ChecklistFallback({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path d="M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z" stroke="currentColor" />
      <path d="M7.5 4.5H13.5" stroke="currentColor" />
      <path d="M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z" stroke="currentColor" />
      <path d="M7.5 11.5H13.5" stroke="currentColor" />
    </svg>
  )
}

/**
 * The checklist icon used by the sidebar panel row entry.
 *
 * DSH 0.1.7 renamed every size-suffixed shell icon (`IconChecklistOutline14`)
 * into stroke-weight variants (`…Regular` 1px / `…Medium` 1.3px) inside
 * `@deepseek-ai/dsh-client-ui-primitives`. A stale named import resolves to
 * `undefined` and React then throws "Element type is invalid" while rendering
 * the slot entry — the entry is dropped and the button silently disappears
 * (exactly what upgrading to 0.1.7 did to this plugin). Resolve the name at
 * runtime, newest first, so the next rename degrades to another shipped
 * variant instead of taking the button down with it.
 */
export const ChecklistIcon: IconComponent =
  firstDefined(
    'IconChecklistOutlineRegular',
    'IconChecklistOutlineMedium',
    'IconChecklistOutline',
    'IconChecklistOutline14',
  ) ?? ChecklistFallback
