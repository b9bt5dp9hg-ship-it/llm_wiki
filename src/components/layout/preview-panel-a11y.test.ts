import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./preview-panel.tsx", import.meta.url), "utf8")

describe("preview panel accessibility", () => {
  it("names the icon-only close action", () => {
    expect(source).toMatch(/aria-label=\{t\("common\.close"\)\}/)
    expect(source).toMatch(/type="button"[\s\S]*aria-label=\{t\("common\.close"\)\}/)
  })
})
