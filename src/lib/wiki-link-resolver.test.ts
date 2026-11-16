import { describe, expect, it } from "vitest"
import { buildWikiLinkIndex, resolveWikiLink } from "./wiki-link-resolver"

describe("shared wiki link index", () => {
  it("rejects paths outside the wiki root and directory-shaped inventory entries", () => {
    const index = buildWikiLinkIndex([
      "/p/wiki/foo.md", "/p/wiki-other/foo.md", "/p/raw/foo.md",
      "/p/wiki/../raw/secret.md", "/p/wiki/foo.md/", "/p/wiki/note.txt",
    ], "/p/wiki")
    expect(index.targets).toEqual([{ id: "foo", path: "/p/wiki/foo.md" }])
    expect(resolveWikiLink(index, "secret")).toBeNull()
  })

  it("keeps canonically equivalent physical files distinct with exact precedence", () => {
    const index = buildWikiLinkIndex([
      "/p/wiki/a/äpfel.md", "/p/wiki/b/a\u0308pfel.md",
    ], "/p/wiki")
    expect(index.targets.map((target) => target.id)).toEqual(["a/äpfel", "b/a\u0308pfel"])
    expect(resolveWikiLink(index, "äpfel")?.path).toBe("/p/wiki/a/äpfel.md")
    expect(resolveWikiLink(index, "a\u0308pfel")?.path).toBe("/p/wiki/b/a\u0308pfel.md")
    expect(resolveWikiLink(index, "ÄPFEL")).toBeNull()
  })

  it("uses aliases, fragments and normalized paths only to select the existing page", () => {
    const index = buildWikiLinkIndex(["/p/wiki/concepts/target-page.md"], "/p/wiki/")
    const path = "/p/wiki/concepts/target-page.md"
    expect(resolveWikiLink(index, "[[wiki/concepts/Target Page.md#Details|Label]]")?.path).toBe(path)
    expect(resolveWikiLink(index, "./concepts/target-page")?.path).toBe(path)
    expect(resolveWikiLink(index, "concepts\\target-page.md")?.path).toBe(path)
    expect(resolveWikiLink(index, "wrong/target-page.md")).toBeNull()
    expect(resolveWikiLink(index, "wiki/../concepts/target-page.md")).toBeNull()
  })
})
