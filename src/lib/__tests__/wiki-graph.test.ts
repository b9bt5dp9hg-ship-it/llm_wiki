/**
 * wiki-graph.test.ts — regression tests for frontmatter-scoped title/type extraction
 *
 * extractTitle/extractType previously searched for `title:`/`type:` anywhere in the
 * whole file content, not just inside the `---...---` frontmatter block, because the
 * lazy `[\s\S]*?` in their regexes was never required to stop at the closing `---`.
 * A body line that merely starts with `title:` or `type:` (plain prose, not YAML)
 * could be misread as the frontmatter value.
 */
import { describe, it, expect, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const mockListDirectory = vi.fn()
const mockReadFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

async function loadBuildWikiGraph() {
  const mod = await import("../wiki-graph")
  return mod.buildWikiGraph
}

function mdFile(name: string): FileNode {
  return { name, path: `/project/wiki/${name}`, is_dir: false }
}

describe("buildWikiGraph frontmatter extraction", () => {
  it("links path, filename, Unicode and related references to existing pages once", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    const pages = new Map([
      ["source.md", '---\nrelated: ["target.md", "wiki/concepts/äpfel.md#Details", "query"]\n---\n# Source\n[[concepts/target]] [[target.md|Again]] [[a\u0308pfel]] [[missing/target.md]] [[query]] [[source]]'],
      ["concepts/target.md", "# Target\n[[source]]"],
      ["concepts/äpfel.md", "# Apples"],
      ["query.md", "---\ntype: query\n---\n[[source]]"],
    ])
    mockListDirectory.mockResolvedValue([...pages.keys()].map((path) => ({
      name: path.split("/").pop()!, path: `/project/wiki/${path}`, is_dir: false,
    })))
    mockReadFile.mockImplementation(async (path: string) => pages.get(path.replace("/project/wiki/", ""))!)

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges).toHaveLength(2)
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    expect(byId.get("source")?.linkCount).toBe(2)
    expect(byId.get("target")?.linkCount).toBe(1)
    expect(byId.get("äpfel")?.linkCount).toBe(1)
  })

  it("retains duplicate basenames and resolves only their explicit paths", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    const pages = new Map([
      ["source.md", "# Source\n[[dup]] [[wiki/a/dup.md]] [[b/dup#Details]] [[wrong/dup.md]]"],
      ["a/dup.md", "# First"],
      ["b/dup.md", "# Second"],
    ])
    mockListDirectory.mockResolvedValue([...pages.keys()].map((path) => ({
      name: path.split("/").pop()!, path: `/project/wiki/${path}`, is_dir: false,
    })))
    mockReadFile.mockImplementation(async (path: string) => pages.get(path.replace("/project/wiki/", ""))!)

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["a/dup", "b/dup", "source"])
    expect(graph.edges).toHaveLength(2)
    expect(graph.nodes.find((node) => node.id === "source")?.linkCount).toBe(2)
  })

  it.each(["query", "unreadable"])("keeps reader ambiguity and page identities when a duplicate is %s", async (hiddenKind) => {
    const buildWikiGraph = await loadBuildWikiGraph()
    const pages = new Map([
      ["bare.md", "# Bare\n[[dup]]"],
      ["explicit.md", "# Explicit\n[[concepts/dup]] [[queries/dup]]"],
      ["concepts/dup.md", "# Concept"],
      ["queries/dup.md", "---\ntype: query\n---\n# Query\n[[bare]]"],
    ])
    mockListDirectory.mockResolvedValue([...pages.keys()].map((path) => ({
      name: path.split("/").pop()!, path: `/project/wiki/${path}`, is_dir: false,
    })))
    mockReadFile.mockImplementation(async (path: string) => {
      if (hiddenKind === "unreadable" && path.endsWith("/queries/dup.md")) throw new Error("Cannot read page")
      return pages.get(path.replace("/project/wiki/", ""))!
    })

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["bare", "concepts/dup", "explicit"])
    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "explicit", target: "concepts/dup" }),
    ])
    expect(graph.nodes.find((node) => node.id === "bare")?.linkCount).toBe(0)
  })

  it("preserves related-only relationships without inventing semantic or markdown edges", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    const pages = new Map([
      ["source.md", "---\nrelated:\n  - target\n---\n# Source\n[same theme](unlinked.md)"],
      ["target.md", "# Target"],
      ["unlinked.md", "# Same theme"],
    ])
    mockListDirectory.mockResolvedValue([...pages.keys()].map(mdFile))
    mockReadFile.mockImplementation(async (path: string) => pages.get(path.replace("/project/wiki/", ""))!)

    const graph = await buildWikiGraph("/project")

    expect(graph.edges).toEqual([expect.objectContaining({ source: "source", target: "target" })])
    expect(graph.nodes.find((node) => node.id === "unlinked")?.linkCount).toBe(0)
  })

  it("uses BOM-prefixed related metadata and excludes BOM-prefixed query pages", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    const pages = new Map([
      ["source.md", "\uFEFF---\nrelated: [target]\n---\n# Source"],
      ["target.md", "# Target"],
      ["query.md", "\uFEFF---\r\ntype: query\r\nrelated: [target]\r\n---\r\n# Query"],
    ])
    mockListDirectory.mockResolvedValue([...pages.keys()].map(mdFile))
    mockReadFile.mockImplementation(async (path: string) => pages.get(path.replace("/project/wiki/", ""))!)

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes.map((node) => node.id)).toEqual(["source", "target"])
    expect(graph.edges).toEqual([expect.objectContaining({ source: "source", target: "target" })])
  })

  it("ignores non-string related metadata without discarding quoted numeric slugs", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    const pages = new Map([
      ["source.md", '---\nrelated: [123, true, {target: foo}, "456"]\n---\n# Source'],
      ["123.md", "# Number"], ["true.md", "# Boolean"], ["456.md", "# Quoted slug"],
    ])
    mockListDirectory.mockResolvedValue([...pages.keys()].map(mdFile))
    mockReadFile.mockImplementation(async (path: string) => pages.get(path.replace("/project/wiki/", ""))!)

    const graph = await buildWikiGraph("/project")

    expect(graph.edges).toEqual([expect.objectContaining({ source: "source", target: "456" })])
  })

  it("does not read a title: line from the document body as the frontmatter title", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\ntype: entity\n---\n# Real Heading\n\nSome text.\ntitle: not-frontmatter-at-all\n",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0].label).toBe("Real Heading")
  })

  it("does not read a type: line from the document body as the frontmatter type", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\ntitle: Real Page\n---\n# Real Page\n\nSome text.\ntype: query\nMore text.\n",
    )

    const graph = await buildWikiGraph("/project")

    // A misread type of "query" would match HIDDEN_TYPES and silently drop the page.
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0].type).toBe("other")
  })

  it("parses CRLF frontmatter consistently with the rest of the application", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\r\ntitle: CRLF Page\r\ntype: entity\r\n---\r\n# Fallback Heading\r\n",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ label: "CRLF Page", type: "entity" })
  })

  it("uses YAML parsing for quoted values that contain a colon", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      '---\ntitle: "Attention: Architecture"\ntype: "Concept"\n---\n# Fallback Heading\n',
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ label: "Attention: Architecture", type: "concept" })
  })

  it("resolves case and space variants without dropping links", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([
      mdFile("Source.md"),
      mdFile("target-page.md"),
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.endsWith("Source.md")
        ? "# Source\n\n[[Target Page]]"
        : "# Target",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "Source", target: "target-page" }),
    ])
  })

  it("prefers an exact page id when case-folded aliases collide", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([
      mdFile("source.md"),
      mdFile("Foo.md"),
      mdFile("foo.md"),
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.endsWith("source.md") ? "# Source\n\n[[foo]]" : "# Target",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.edges).toEqual([
      expect.objectContaining({ source: "source", target: "foo" }),
    ])
  })

  it("reuses an unchanged graph by project data version", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockClear()
    mockReadFile.mockClear()
    mockListDirectory.mockResolvedValue([{ name: "cached.md", path: "/cached-project/wiki/cached.md", is_dir: false }])
    mockReadFile.mockResolvedValue("# Cached")

    const first = await buildWikiGraph("/cached-project", 42)
    const second = await buildWikiGraph("/cached-project", 42)

    expect(second).toBe(first)
    expect(mockListDirectory).toHaveBeenCalledTimes(1)
    expect(mockReadFile).toHaveBeenCalledTimes(1)
  })
})
