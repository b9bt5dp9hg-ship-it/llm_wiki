import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./activity-panel.tsx", import.meta.url), "utf8")

describe("activity panel accessibility", () => {
  it("exposes the panel disclosure state", () => {
    const start = source.indexOf('<div className="border-t bg-muted/30">')
    const end = source.indexOf("{expanded &&", start)
    const trigger = source.slice(start, end)
    expect(trigger).toMatch(/type="button"/)
    expect(trigger).toMatch(/aria-expanded=\{expanded\}/)
  })

  it("names every icon-only queue-row action", () => {
    const start = source.indexOf("function QueueRow")
    const end = source.indexOf("function FileSyncRow", start)
    const row = source.slice(start, end)
    expect(row).toMatch(/aria-label=\{t\("common\.retry"\)\}/)
    expect(row).toMatch(/aria-label=\{t\("activity\.moveUp"\)\}/)
    expect(row).toMatch(/aria-label=\{t\("activity\.moveDown"\)\}/)
    expect(row).toMatch(/aria-label=\{t\("common\.cancel"\)\}/)
  })

  it("names both icon-only file-sync actions", () => {
    const start = source.indexOf("function FileSyncRow")
    const end = source.indexOf("function ActivityRow", start)
    const row = source.slice(start, end)
    expect(row).toMatch(/aria-label=\{t\("common\.retry"\)\}/)
    expect(row).toMatch(/aria-label=\{t\("common\.ignore"\)\}/)
  })
})
