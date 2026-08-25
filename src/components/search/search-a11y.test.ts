import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  lightboxDialogAria,
  searchFieldAria,
  wrapTabStops,
} from "./search-a11y"

const here = dirname(fileURLToPath(import.meta.url))

function source(relative: string): string {
  return readFileSync(join(here, relative), "utf8")
}

function lightboxSource(view: string): string {
  const start = view.indexOf("function Lightbox")
  const end = view.indexOf("\nfunction ", start + 1)
  return view.slice(start, end === -1 ? undefined : end)
}

function searchInputSource(view: string): string {
  const start = view.indexOf("<input")
  const end = view.indexOf("/>", start)
  return view.slice(start, end === -1 ? undefined : end + 2)
}

function tabEvent(shiftKey = false): { key: string; shiftKey: boolean; preventDefault(): void; prevented: boolean } {
  return {
    key: "Tab",
    shiftKey,
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
}

describe("search field accessible name", () => {
  const view = source("search-view.tsx")
  const input = searchInputSource(view)

  it("does not rely on placeholder alone for the search field name", () => {
    expect(input).toMatch(/searchFieldAria\(t\("search\.(title|placeholder)"\)\)/)
  })
})

describe("search image lightbox keyboard access", () => {
  const lightbox = lightboxSource(source("search-view.tsx"))

  it("names the dialog from the caption instead of an unlabeled overlay", () => {
    expect(lightbox).toMatch(/lightboxDialogAria\(/)
    expect(lightbox).not.toMatch(/role="dialog"/)
  })

  it("moves focus into the dialog and restores it on close", () => {
    expect(lightbox).toMatch(/activeElement/)
    expect(lightbox).toMatch(/\.focus\(/)
  })

  it("keeps Tab inside the dialog", () => {
    expect(lightbox).toMatch(/trapTabInContainer\(/)
  })
})

describe("search a11y helpers", () => {
  it("names the search field", () => {
    expect(searchFieldAria("Search")).toEqual({ "aria-label": "Search" })
  })

  it("labels the lightbox from the caption id", () => {
    expect(lightboxDialogAria("search-lightbox-title")).toEqual({
      role: "dialog",
      "aria-modal": true,
      "aria-labelledby": "search-lightbox-title",
    })
  })

  it("wraps Tab from the last dialog control back to the first", () => {
    const focused: string[] = []
    const stops = [
      { focus: () => focused.push("close") },
      { focus: () => focused.push("jump") },
    ]
    const event = tabEvent()
    expect(wrapTabStops(event, stops, stops[1])).toBe(true)
    expect(event.prevented).toBe(true)
    expect(focused).toEqual(["close"])
  })

  it("wraps Shift+Tab from the first dialog control to the last", () => {
    const focused: string[] = []
    const stops = [
      { focus: () => focused.push("close") },
      { focus: () => focused.push("jump") },
    ]
    const event = tabEvent(true)
    expect(wrapTabStops(event, stops, stops[0])).toBe(true)
    expect(event.prevented).toBe(true)
    expect(focused).toEqual(["jump"])
  })

  it("leaves mid-cycle Tab to the browser", () => {
    const focused: string[] = []
    const stops = [
      { focus: () => focused.push("close") },
      { focus: () => focused.push("jump") },
    ]
    const event = tabEvent()
    expect(wrapTabStops(event, stops, stops[0])).toBe(false)
    expect(event.prevented).toBe(false)
    expect(focused).toEqual([])
  })
})
