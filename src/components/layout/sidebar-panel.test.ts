import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./sidebar-panel.tsx", import.meta.url), "utf8")

describe("sidebar mode accessibility", () => {
  it("exposes the exclusive mode selector as tabs", () => {
    expect(source).toMatch(/role="tablist"/)
    expect(source.match(/role="tab"/g)).toHaveLength(2)
    expect(source).toMatch(/aria-selected=\{mode === "knowledge"\}/)
    expect(source).toMatch(/aria-selected=\{mode === "files"\}/)
  })
})
