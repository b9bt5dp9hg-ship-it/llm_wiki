import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const view = readFileSync(new URL("./graph-view.tsx", import.meta.url), "utf8")
const start = view.indexOf("{/* Research Topic Confirmation Dialog */}")
const end = view.indexOf("</div>\n  )\n}", start)
const dialog = view.slice(start, end)

describe("graph research dialog semantics", () => {
  it("exposes a named modal and named close control", () => {
    expect(dialog).toMatch(/role="dialog"/)
    expect(dialog).toMatch(/aria-modal="true"/)
    expect(dialog).toMatch(/aria-labelledby="graph-research-dialog-title"/)
    expect(dialog).toMatch(/id="graph-research-dialog-title"/)
    expect(dialog).toMatch(/aria-label=\{t\("common\.close"\)\}/)
  })

  it("associates topic and query labels with their fields", () => {
    expect(dialog).toMatch(/htmlFor="graph-research-topic"/)
    expect(dialog).toMatch(/id="graph-research-topic"/)
    expect(dialog).toMatch(/htmlFor=\{`graph-research-query-\$\{idx\}`\}/)
    expect(dialog).toMatch(/id=\{`graph-research-query-\$\{idx\}`\}/)
  })

  it("moves focus inside, traps Tab, closes on Escape, and restores focus", () => {
    expect(view).toMatch(/document\.activeElement/)
    expect(view).toMatch(/researchDialogRef\.current\?\.querySelector<HTMLElement>[\s\S]*\.focus\(\)/)
    expect(dialog).toMatch(/trapTabInContainer\(event\.nativeEvent, event\.currentTarget\)/)
    expect(dialog).toMatch(/event\.key === "Escape"[\s\S]*closeResearchDialog\(\)/)
    expect(view).toMatch(/previousFocus\?\.focus\(\)/)
  })
})
