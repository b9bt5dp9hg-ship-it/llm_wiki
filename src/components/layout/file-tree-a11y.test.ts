import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./file-tree.tsx", import.meta.url), "utf8")

describe("file tree accessibility", () => {
  it("exposes folder disclosure state", () => {
    const start = source.indexOf("if (node.is_dir)")
    const end = source.indexOf("return (", source.indexOf("if (!project)"))
    const treeNode = source.slice(start, end)
    expect(treeNode).toMatch(/aria-expanded=\{expanded\}/)
    expect(treeNode).toMatch(/type="button"/)
  })
})
