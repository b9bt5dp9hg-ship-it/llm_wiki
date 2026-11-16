import { describe, expect, it } from "vitest"
import { iconControlAria, withPendingCount } from "./icon-sidebar-a11y"

describe("iconControlAria", () => {
  it("always exposes an accessible name for icon-only controls", () => {
    expect(iconControlAria("Wiki")).toEqual({ "aria-label": "Wiki" })
  })

  it("marks the active view as the current page", () => {
    expect(iconControlAria("Chat", true)).toEqual({
      "aria-label": "Chat",
      "aria-current": "page",
    })
  })
})

describe("withPendingCount", () => {
  it("leaves the label alone when nothing is pending", () => {
    expect(withPendingCount("Review", 0)).toBe("Review")
  })

  it("includes the pending count in the accessible name", () => {
    expect(withPendingCount("Review", 3)).toBe("Review (3)")
    expect(withPendingCount("Review", 120)).toBe("Review (99+)")
  })
})
