import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const view = readFileSync(new URL("./graph-view.tsx", import.meta.url), "utf8")

describe("graph node preview request ordering", () => {
  it("discards a slower node read after a newer click", () => {
    const start = view.indexOf("const handleNodeClick")
    const end = view.indexOf("const handleNodeContextMenu", start)
    const handler = view.slice(start, end)
    expect(handler).toMatch(/const requestId = \+\+graphPreviewRequest\.current/)
    expect(handler).toMatch(/await readFile\(node\.path\)[\s\S]*requestId !== graphPreviewRequest\.current/)
  })

  it("invalidates pending node reads when the project changes", () => {
    expect(view).toMatch(/graphPreviewRequest\.current\+\+[\s\S]*setGraphPreview\(null\)[\s\S]*\[project\?\.id\]/)
  })
})
