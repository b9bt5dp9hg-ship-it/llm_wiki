import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panel = readFileSync(new URL("./chat-panel.tsx", import.meta.url), "utf8")

function block(startText: string, endText: string): string {
  const start = panel.indexOf(startText)
  return panel.slice(start, panel.indexOf(endText, start))
}

describe("generated-output preview request ordering", () => {
  it("guards automatic preview reads by request and conversation", () => {
    const autoOpen = block("const autoOpenSingleGeneratedOutput", "const activeStreaming")
    expect(autoOpen).toMatch(/const requestId = \+\+generatedOutputRequestRef\.current/)
    expect(autoOpen).toMatch(/buildGeneratedOutputPreview[\s\S]*requestId !== generatedOutputRequestRef\.current/)
    expect(autoOpen).toMatch(/useChatStore\.getState\(\)\.activeConversationId !== conversationId/)
  })

  it("guards manually opened preview reads by request", () => {
    const manualOpen = block("const openGeneratedOutputModal", "const closeGeneratedOutputsPanel")
    expect(manualOpen).toMatch(/const requestId = \+\+generatedOutputRequestRef\.current/)
    expect(manualOpen).toMatch(/loadGeneratedOutputPreview[\s\S]*requestId !== generatedOutputRequestRef\.current/)
  })

  it("invalidates pending reads when conversation or project changes", () => {
    expect(panel).toMatch(/generatedOutputRequestRef\.current\+\+[\s\S]*setGeneratedOutputPreview\(null\)[\s\S]*\[activeConversationId, project\?\.id\]/)
  })
})
