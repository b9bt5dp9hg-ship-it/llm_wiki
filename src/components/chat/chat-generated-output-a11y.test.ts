import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panel = readFileSync(new URL("./chat-panel.tsx", import.meta.url), "utf8")
const start = panel.indexOf("function GeneratedOutputPreviewDialog")
const end = panel.indexOf("function ChatReferencePreviewPanel", start)
const dialog = panel.slice(start, end)

describe("generated-output preview dialog accessibility", () => {
  it("exposes a named modal dialog", () => {
    expect(dialog).toMatch(/role="dialog"/)
    expect(dialog).toMatch(/aria-modal="true"/)
    expect(dialog).toMatch(/aria-labelledby="generated-output-preview-title"/)
    expect(dialog).toMatch(/id="generated-output-preview-title"/)
  })

  it("owns focus, traps Tab, closes on Escape, and restores focus", () => {
    expect(dialog).toMatch(/document\.activeElement/)
    expect(dialog).toMatch(/dialogRef\.current\?\.querySelector<HTMLElement>[\s\S]*\.focus\(\)/)
    expect(dialog).toMatch(/trapTabInContainer\(event\.nativeEvent, event\.currentTarget\)/)
    expect(dialog).toMatch(/event\.key === "Escape"[\s\S]*onCloseRef\.current\(\)/)
    expect(dialog).toMatch(/previousFocus\?\.focus\(\)/)
  })
})
