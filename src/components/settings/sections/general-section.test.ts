import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const section = readFileSync(new URL("./general-section.tsx", import.meta.url), "utf8")

describe("GeneralSection accessibility", () => {
  it("exposes close behavior as a named single-choice group", () => {
    expect(section).toMatch(/role="radiogroup"[\s\S]*aria-label=\{t\("settings\.sections\.general\.closeBehavior"/)
    expect(section).toMatch(/key=\{option\.value\}[\s\S]*role="radio"[\s\S]*aria-checked=\{active\}/)
  })
})
