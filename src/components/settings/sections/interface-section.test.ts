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

  it("connects the zoom label and keeps its icon controls non-submitting", () => {
    expect(section).toMatch(/<Label htmlFor="interface-zoom">/)
    expect(section).toMatch(/id="interface-zoom"/)
    expect(section).toMatch(/<button\s+type="button"[\s\S]*aria-label=\{t\("settings\.sections\.interface\.zoomOut"\)\}/)
    expect(section).toMatch(/<button\s+type="button"[\s\S]*aria-label=\{t\("settings\.sections\.interface\.zoomIn"\)\}/)
  })
})
