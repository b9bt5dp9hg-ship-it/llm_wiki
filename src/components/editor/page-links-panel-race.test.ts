import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panel = readFileSync(new URL("./page-links-panel.tsx", import.meta.url), "utf8")

describe("page links async ownership", () => {
  it("aborts an in-flight draft when its project or linking file changes", () => {
    expect(panel).toMatch(
      /useEffect\(\(\) => \{[\s\S]*draftAbortRef\.current\?\.abort\(\)[\s\S]*setCreatingTitle\(""\)[\s\S]*\}, \[filePath, project\?\.id\]\)/,
    )
  })
})
