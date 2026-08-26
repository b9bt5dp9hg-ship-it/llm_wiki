import { createElement, isValidElement } from "react"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { MermaidDiagram, unwrapMermaidPre } from "./mermaid-diagram"

describe("unwrapMermaidPre", () => {
  it("returns a MermaidDiagram element so markdown renderers can avoid nesting it in pre", () => {
    const mermaid = createElement(MermaidDiagram, { code: "graph TD; A-->B;" })

    const unwrapped = unwrapMermaidPre(mermaid)
    expect(isValidElement(unwrapped)).toBe(true)
    expect(isValidElement(unwrapped) ? unwrapped.type : null).toBe(MermaidDiagram)
  })

  it("leaves normal code children wrapped in pre", () => {
    const code = createElement("code", { className: "language-ts" }, "const x = 1")

    expect(unwrapMermaidPre(code)).toBeNull()
  })

  it("does not unwrap multiple children", () => {
    const mermaid = createElement(MermaidDiagram, { code: "graph TD; A-->B;" })

    expect(unwrapMermaidPre([mermaid, "extra"])).toBeNull()
  })
})

describe("fullscreen Mermaid semantics", () => {
  const source = readFileSync(new URL("./mermaid-diagram.tsx", import.meta.url), "utf8")

  it("exposes a named modal and names enlarge, zoom, and close controls", () => {
    expect(source).toMatch(/aria-label=\{t\("mermaid\.enlarge"\)\}/)
    expect(source).toMatch(/role="dialog"/)
    expect(source).toMatch(/aria-modal="true"/)
    expect(source).toMatch(/aria-label=\{t\("mermaid\.diagram"\)\}/)
    expect(source.match(/aria-label=\{t\("settings\.sections\.interface\.zoom(In|Out)"\)\}/g)).toHaveLength(2)
    expect(source).toMatch(/aria-label=\{t\("common\.close"\)\}/)
  })

  it("lets keyboard users enlarge the inline diagram and reveal its control", () => {
    expect(source).toMatch(/role="button"/)
    expect(source).toMatch(/tabIndex=\{0\}/)
    expect(source).toMatch(/event\.key === "Enter" \|\| event\.key === " "/)
    expect(source).toMatch(/group-focus-within\/diagram:opacity-100/)
  })
})
