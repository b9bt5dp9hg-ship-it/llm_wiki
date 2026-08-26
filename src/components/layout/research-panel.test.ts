import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panel = readFileSync(new URL("./research-panel.tsx", import.meta.url), "utf8")

describe("ResearchPanel accessibility", () => {
  it("names the topic field plus the close and start icon controls", () => {
    expect(panel).toMatch(/aria-label=\{t\("research\.inputPlaceholder"\)\}[\s\S]*placeholder=\{t\("research\.inputPlaceholder"\)\}/)
    expect(panel).toMatch(/type="button"[\s\S]*aria-label=\{t\("common\.close"\)\}[\s\S]*setPanelOpen\(false\)/)
    expect(panel).toMatch(/aria-label=\{t\("graph\.startResearch"\)\}[\s\S]*onClick=\{handleStartResearch\}/)
  })

  it("exposes each research task's expanded state", () => {
    expect(panel).toMatch(/<button\s+type="button"\s+aria-expanded=\{expanded\}\s+onClick=\{\(\) => setExpanded\(!expanded\)\}/)
  })
})
