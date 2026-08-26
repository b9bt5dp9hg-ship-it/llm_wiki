import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const section = readFileSync(new URL("./interface-section.tsx", import.meta.url), "utf8")

describe("InterfaceSection accessibility", () => {
  it("exposes UI language buttons as a named single-choice group", () => {
    expect(section).toMatch(/role="radiogroup"[\s\S]*aria-label=\{t\("settings\.sections\.interface\.uiLanguage"\)\}/)
    expect(section).toMatch(/key=\{l\.value\}[\s\S]*role="radio"[\s\S]*aria-checked=\{active\}/)
  })

  it("exposes theme buttons as a named single-choice group", () => {
    expect(section).toMatch(/role="radiogroup"[\s\S]*aria-label=\{t\("settings\.sections\.interface\.theme"\)\}/)
    expect(section).toMatch(/key=\{th\.value\}[\s\S]*role="radio"[\s\S]*aria-checked=\{active\}/)
  })
})
