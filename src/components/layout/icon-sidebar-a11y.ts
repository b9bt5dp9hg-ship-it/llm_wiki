/**
 * Accessible names for icon-only sidebar controls. Tooltip content is
 * hover-only and is not a substitute for aria-label / aria-current.
 */

export function iconControlAria(label: string, isCurrent = false): {
  "aria-label": string
  "aria-current"?: "page"
} {
  return isCurrent
    ? { "aria-label": label, "aria-current": "page" }
    : { "aria-label": label }
}

export function withPendingCount(label: string, count: number): string {
  if (count <= 0) return label
  return `${label} (${count > 99 ? "99+" : count})`
}
