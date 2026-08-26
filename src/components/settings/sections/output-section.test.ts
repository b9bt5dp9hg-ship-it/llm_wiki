import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const section = readFileSync(new URL("./output-section.tsx", import.meta.url), "utf8")

describe("OutputSection accessibility", () => {
  it("exposes history length as a named single-choice group", () => {
    expect(section).toMatch(/role="radiogroup"[\s\S]*aria-label=\{t\("settings\.sections\.output\.historyLength"\)\}/)
    expect(section).toMatch(/key=\{n\}[\s\S]*role="radio"[\s\S]*aria-checked=\{active\}/)
  })
})
