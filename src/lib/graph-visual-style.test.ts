import { describe, expect, it } from "vitest"
import {
  graphCommunityColor,
  graphEdgeStyle,
  graphNodeColor,
  isNeuralNightRingNode,
  neuralNightBloom,
  neuralNightOverlayBudget,
} from "./graph-visual-style"

describe("graph visual styles", () => {
  it("uses the neural palette without losing stable custom-type colors", () => {
    expect(graphNodeColor("entity", "neural-night")).toBe("#4da6ff")
    expect(graphNodeColor("custom-page", "neural-night")).toBe(graphNodeColor("custom-page", "neural-night"))
    expect(graphNodeColor("entity", "classic")).toBe("#60a5fa")
  })

  it("keeps community colors deterministic", () => {
    expect(graphCommunityColor(2, "neural-night")).toBe("#8b5cf6")
    expect(graphCommunityColor(14, "neural-night")).toBe("#8b5cf6")
  })

  it("renders neural edges in the reference blue, brighter with weight", () => {
    const weak = graphEdgeStyle(0, "neural-night")
    const strong = graphEdgeStyle(1, "neural-night")

    expect(weak.size).toBeLessThan(strong.size)
    expect(weak.color).toContain("rgba(43,111,255")
    expect(weak.color).toContain("0.160")
    expect(strong.color).toContain("0.460")
  })

  it("reduces bloom work for large graphs", () => {
    expect(neuralNightBloom(100).edges).not.toBe("none")
    expect(neuralNightBloom(800).edges).toBe("none")
    expect(neuralNightBloom(2000).nodes).not.toContain("7px")
  })

  it("degrades the overlay budget alongside bloom", () => {
    const full = neuralNightOverlayBudget(300)
    const reduced = neuralNightOverlayBudget(900)
    const off = neuralNightOverlayBudget(2000)

    expect(full.rayHubs).toBeGreaterThan(reduced.rayHubs)
    expect(reduced.sparkles).toBeGreaterThan(0)
    expect(off).toEqual({ haloNodes: 0, rayHubs: 0, raysPerHub: 0, sparkles: 0 })
  })

  it("picks ring nodes deterministically and only among small nodes", () => {
    expect(isNeuralNightRingNode("wiki/some-page.md", 0.9)).toBe(false)
    const small = isNeuralNightRingNode("wiki/some-page.md", 0.1)
    expect(isNeuralNightRingNode("wiki/some-page.md", 0.1)).toBe(small)

    const ids = Array.from({ length: 200 }, (_, i) => `wiki/page-${i}.md`)
    const rings = ids.filter((id) => isNeuralNightRingNode(id, 0.1)).length
    expect(rings).toBeGreaterThan(5)
    expect(rings).toBeLessThan(80)
  })
})
