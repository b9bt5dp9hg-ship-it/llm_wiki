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
})
