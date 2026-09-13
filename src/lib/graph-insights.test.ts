import { describe, expect, it } from "vitest"
import type { GraphEdge, GraphNode } from "./wiki-graph"
import { detectKnowledgeGaps } from "./graph-insights"

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    type: "concept",
    path: `/p/wiki/concepts/${id}.md`,
    linkCount: 0,
    community: 0,
    ...overrides,
  }
}

function isolatedIds(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  return detectKnowledgeGaps(nodes, edges, [])
    .find((gap) => gap.type === "isolated-node")?.nodeIds ?? []
}

describe("isolated knowledge gaps", () => {
  it("does not call either endpoint of a single link isolated", () => {
    const nodes = [node("a", { linkCount: 1 }), node("b", { linkCount: 1 })]

    expect(isolatedIds(nodes, [{ source: "a", target: "b", weight: 1 }])).toEqual([])
  })

  it("uses existing edges instead of stale cached link counts", () => {
    const nodes = [node("a"), node("b"), node("orphan", { linkCount: 12 })]
    const edges = [
      { source: "a", target: "b", weight: 1 },
      { source: "a", target: "b", weight: 1 },
    ]

    expect(isolatedIds(nodes, edges)).toEqual(["orphan"])
  })

  it("does not treat an edge to a missing page as a connection", () => {
    expect(isolatedIds(
      [node("orphan", { linkCount: 4 })],
      [{ source: "orphan", target: "missing", weight: 1 }],
    )).toEqual(["orphan"])
  })

  it("preserves overview/index/log exclusions and includes disconnected queries", () => {
    const nodes = [
      node("index"),
      node("log"),
      node("summary", { type: "overview" }),
      node("question", { type: "query" }),
    ]

    expect(isolatedIds(nodes, [])).toEqual(["question"])
  })
})
