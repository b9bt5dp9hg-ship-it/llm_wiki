import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("agent file activity accessibility", () => {
  const source = readFileSync(new URL("./agent-file-activity.tsx", import.meta.url), "utf8")

  it("names both file and individual-edit disclosure controls", () => {
    const disclosureLabels = source.match(/aria-label=\{[^\n]+collapseDiff[^\n]+expandDiff[^\n]+\}/g) ?? []
    expect(disclosureLabels).toHaveLength(2)
  })
})
