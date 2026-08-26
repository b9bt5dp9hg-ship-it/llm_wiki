import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { clampPdfPage, decodeBase64, parseDelimitedContent } from "./file-preview"

describe("PDF preview helpers", () => {
  it("decodes PDF bytes without depending on asset URLs or platform paths", () => {
    expect([...decodeBase64("JVBERi0=")]).toEqual([37, 80, 68, 70, 45])
  })

  it("keeps requested pages inside the loaded document", () => {
    expect(clampPdfPage(-2, 10)).toBe(1)
    expect(clampPdfPage(6, 10)).toBe(6)
    expect(clampPdfPage(99, 10)).toBe(10)
    expect(clampPdfPage(2, 0)).toBe(1)
  })
})

describe("PDF preview accessibility", () => {
  const source = readFileSync(new URL("./file-preview.tsx", import.meta.url), "utf8")
  const start = source.indexOf("function PdfPreview")
  const end = source.indexOf("const MAX_INLINE_PDF_BYTES", start)
  const preview = source.slice(start, end)

  it("names both icon-only zoom controls", () => {
    expect(preview).toMatch(/aria-label=\{t\("settings\.sections\.interface\.zoomOut"\)\}/)
    expect(preview).toMatch(/aria-label=\{t\("settings\.sections\.interface\.zoomIn"\)\}/)
  })
})

describe("parseDelimitedContent", () => {
  it("preserves delimiters, escaped quotes, and newlines inside quoted cells", () => {
    expect(parseDelimitedContent('name,detail\nA,"one,two"\nB,"line 1\nline 2"\nC,"a""b"', ",")).toEqual([
      ["name", "detail"],
      ["A", "one,two"],
      ["B", "line 1\nline 2"],
      ["C", 'a"b'],
    ])
  })
})

describe("fullscreen image preview semantics", () => {
  const source = readFileSync(new URL("./file-preview.tsx", import.meta.url), "utf8")
  const start = source.indexOf("function ImagePreview")
  const end = source.indexOf("function VideoPreview", start)
  const preview = source.slice(start, end)

  it("exposes a named modal and names every icon-only control", () => {
    expect(preview).toMatch(/role="dialog"/)
    expect(preview).toMatch(/aria-modal="true"/)
    expect(preview).toMatch(/aria-label=\{fileName\}/)
    expect(preview.match(/aria-label=/g)).toHaveLength(4)
  })

  it("owns focus, traps Tab, closes on Escape, and restores focus", () => {
    expect(preview).toMatch(/document\.activeElement/)
    expect(preview).toMatch(/imageDialogRef\.current\?\.querySelector<HTMLElement>[\s\S]*\.focus\(\)/)
    expect(preview).toMatch(/trapTabInContainer\(event\.nativeEvent, event\.currentTarget\)/)
    expect(preview).toMatch(/event\.key === "Escape"[\s\S]*setExpanded\(false\)/)
    expect(preview).toMatch(/previousFocus\?\.focus\(\)/)
  })
})
