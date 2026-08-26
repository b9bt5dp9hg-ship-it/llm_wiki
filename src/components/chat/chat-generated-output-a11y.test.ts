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
})
