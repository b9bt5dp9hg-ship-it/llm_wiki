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

  it("exposes the currently previewed file", () => {
    expect(source).toMatch(/aria-current=\{isSelected \? "page" : undefined\}/)
  })

  it("announces lazy folder loading", () => {
    expect(source).toMatch(/<span role="status" className="ml-auto pr-2 text-\[10px\] text-muted-foreground">/)
  })
})
