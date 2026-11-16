/**
 * Shared a11y helpers for selectable rows with an icon-only sibling
 * action (chat conversations, recent projects).
 *
 * Rows must be real <button> elements — a clickable <div> is not
 * keyboard reachable. The sibling action must stay in the DOM (not
 * hover-gated) and become visible on hover or keyboard focus.
 */

export function selectRowProps(isCurrent: boolean): {
  type: "button"
  "aria-current"?: "true"
} {
  return isCurrent
    ? { type: "button", "aria-current": "true" }
    : { type: "button" }
}

export function namedIconButtonProps(label: string): {
  type: "button"
  "aria-label": string
} {
  return { type: "button", "aria-label": label }
}

export const revealOnHoverOrFocusClass =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
