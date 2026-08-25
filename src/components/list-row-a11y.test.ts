import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

function source(relative: string): string {
  return readFileSync(join(here, relative), "utf8")
}

function conversationSidebarSource(panel: string): string {
  const start = panel.indexOf("function ConversationSidebar")
  const end = panel.indexOf("\nfunction ", start + 1)
  return panel.slice(start, end === -1 ? undefined : end)
}

describe("chat conversation list keyboard access", () => {
  const panel = conversationSidebarSource(source("chat/chat-panel.tsx"))

  it("does not select conversations from a clickable div", () => {
    expect(panel).not.toMatch(/cursor-pointer/)
    expect(panel).toMatch(/selectRowProps\(/)
  })

  it("does not hide conversation delete behind mouse hover state", () => {
    expect(panel).not.toMatch(/\bhoveredId\b/)
    expect(panel).not.toMatch(/onMouseEnter=\{\(\) => setHoveredId/)
  })

  it("keeps a named delete button in the tree", () => {
    expect(panel).toMatch(/namedIconButtonProps\(|chat\.deleteConversation/)
  })
})

describe("recent project controls keyboard access", () => {
  const welcome = source("project/welcome-screen.tsx")

  it("does not nest an inner role=button inside the recent-project row", () => {
    expect(welcome).not.toMatch(/role="button"/)
    expect(welcome).not.toMatch(/as unknown as React\.MouseEvent/)
  })

  it("names the remove control for assistive tech", () => {
    expect(welcome).toMatch(/namedIconButtonProps\(|welcome\.removeRecent/)
  })
})

describe("list-row-a11y helpers", () => {
  it("uses a real button and marks the current row", async () => {
    const { selectRowProps } = await import("./list-row-a11y")
    expect(selectRowProps(true)).toEqual({ type: "button", "aria-current": "true" })
    expect(selectRowProps(false)).toEqual({ type: "button" })
  })

  it("gives icon-only controls an accessible name", async () => {
    const { namedIconButtonProps } = await import("./list-row-a11y")
    expect(namedIconButtonProps("Delete conversation Notes")).toEqual({
      type: "button",
      "aria-label": "Delete conversation Notes",
    })
  })

  it("reveals hover-only icon controls on keyboard focus as well", async () => {
    const { revealOnHoverOrFocusClass } = await import("./list-row-a11y")
    expect(revealOnHoverOrFocusClass).toContain("group-focus-within:opacity-100")
    expect(revealOnHoverOrFocusClass).toContain("focus-visible:opacity-100")
  })
})
