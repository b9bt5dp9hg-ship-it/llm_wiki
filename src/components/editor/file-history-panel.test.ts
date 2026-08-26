import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panel = readFileSync(new URL("./file-history-panel.tsx", import.meta.url), "utf8")

describe("file history panel accessibility", () => {
  it("names the trigger and exposes a named modal with a named close button", () => {
    expect(panel).toMatch(/aria-label=\{t\("preview\.history"\)\}/)
    expect(panel).toMatch(/role="dialog"/)
    expect(panel).toMatch(/aria-modal="true"/)
    expect(panel).toMatch(/aria-labelledby="file-history-title"/)
    expect(panel).toMatch(/id="file-history-title"/)
    expect(panel).toMatch(/aria-label=\{t\("common\.close"\)\}/)
  })
})
