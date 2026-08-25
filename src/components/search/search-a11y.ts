/**
 * Accessible names and keyboard containment for wiki search.
 * Placeholder text is not a name. A clickable overlay with
 * role=dialog still needs a labelled title, initial focus,
 * restore-on-close, and a Tab cycle.
 */

export function searchFieldAria(label: string): { "aria-label": string } {
  return { "aria-label": label }
}

export function lightboxDialogAria(labelledBy: string): {
  role: "dialog"
  "aria-modal": true
  "aria-labelledby": string
} {
  return {
    role: "dialog",
    "aria-modal": true,
    "aria-labelledby": labelledBy,
  }
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

export function focusableDialogControls(container: ParentNode): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getAttribute("aria-hidden") !== "true",
  )
}

export function wrapTabStops(
  event: { key: string; shiftKey: boolean; preventDefault(): void },
  stops: Array<{ focus(): void }>,
  active: { focus(): void } | null,
): boolean {
  if (event.key !== "Tab") return false
  if (stops.length === 0) {
    event.preventDefault()
    return true
  }
  const index = active ? stops.indexOf(active) : -1
  if (event.shiftKey) {
    if (index <= 0) {
      event.preventDefault()
      stops[stops.length - 1].focus()
      return true
    }
    return false
  }
  if (index === -1 || index === stops.length - 1) {
    event.preventDefault()
    stops[0].focus()
    return true
  }
  return false
}

export function trapTabInContainer(event: KeyboardEvent, container: HTMLElement): boolean {
  const active = document.activeElement
  return wrapTabStops(
    event,
    focusableDialogControls(container),
    active instanceof HTMLElement ? active : null,
  )
}
