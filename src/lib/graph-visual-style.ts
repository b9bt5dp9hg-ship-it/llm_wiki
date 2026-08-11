export type GraphVisualStyle = "classic" | "neural-night"

const CLASSIC_NODE_TYPE_COLORS: Record<string, string> = {
  entity: "#60a5fa",
  concept: "#c084fc",
  source: "#fb923c",
  query: "#4ade80",
  synthesis: "#f87171",
  overview: "#facc15",
  comparison: "#2dd4bf",
  finding: "#a855f7",
  thesis: "#f43f5e",
  methodology: "#14b8a6",
  other: "#94a3b8",
}

// Reference image: predominantly bright blue cores (#4da6ff/#66b8ff) with
// sparing violet accent clusters (#8b5cf6/#a78bfa). Types keep distinct hues
// so color coding stays functional, but everything lives in the blue family
// except the two violet accent types.
const NEURAL_NIGHT_NODE_TYPE_COLORS: Record<string, string> = {
  entity: "#4da6ff",
  concept: "#8b5cf6",
  source: "#2979ff",
  query: "#66d9e8",
  synthesis: "#66b8ff",
  overview: "#a78bfa",
  comparison: "#38bdf8",
  finding: "#5c7cfa",
  thesis: "#a78bfa",
  methodology: "#22d3ee",
  other: "#5b7fa6",
}

const CLASSIC_CUSTOM_NODE_COLORS = [
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#a78bfa",
  "#22d3ee",
  "#f97316",
  "#84cc16",
]

const NEURAL_NIGHT_CUSTOM_NODE_COLORS = [
  "#4da6ff",
  "#66b8ff",
  "#2979ff",
  "#38bdf8",
  "#5c7cfa",
  "#8b5cf6",
  "#66d9e8",
  "#22d3ee",
]

const CLASSIC_COMMUNITY_COLORS = [
  "#60a5fa",
  "#4ade80",
  "#fb923c",
  "#c084fc",
  "#f87171",
  "#2dd4bf",
  "#facc15",
  "#f472b6",
  "#a78bfa",
  "#38bdf8",
  "#34d399",
  "#fbbf24",
]

const NEURAL_NIGHT_COMMUNITY_COLORS = [
  "#4da6ff",
  "#2979ff",
  "#8b5cf6",
  "#66b8ff",
  "#5c7cfa",
  "#38bdf8",
  "#a78bfa",
  "#66d9e8",
  "#3b82f6",
  "#22d3ee",
  "#7c3aed",
  "#0ea5e9",
]

// Reference image: very dark navy radial base (#05080f → #0a1428) with an
// ambient glow pulling toward #0d2a55 in the upper right, plus a faint blue
// vignette. The vignette ring itself lives in .neural-night-graph::after.
export const NEURAL_NIGHT_BACKGROUND = [
  "radial-gradient(circle at 72% 22%, rgba(13, 42, 85, 0.55), transparent 46%)",
  "radial-gradient(circle at 24% 80%, rgba(59, 46, 130, 0.22), transparent 38%)",
  "radial-gradient(ellipse at 50% 45%, #0a1428 0%, #05080f 78%)",
].join(", ")

function stableColorIndex(value: string, paletteLength: number): number {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % paletteLength
}

export function graphNodeColor(type: string, style: GraphVisualStyle): string {
  const colors = style === "neural-night" ? NEURAL_NIGHT_NODE_TYPE_COLORS : CLASSIC_NODE_TYPE_COLORS
  if (colors[type]) return colors[type]
  const fallback = style === "neural-night" ? NEURAL_NIGHT_CUSTOM_NODE_COLORS : CLASSIC_CUSTOM_NODE_COLORS
  return fallback[stableColorIndex(type, fallback.length)] ?? colors.other
}

export function graphCommunityColor(community: number, style: GraphVisualStyle): string {
  const colors = style === "neural-night" ? NEURAL_NIGHT_COMMUNITY_COLORS : CLASSIC_COMMUNITY_COLORS
  const index = Math.abs(community) % colors.length
  return colors[index] ?? colors[0]
}

export function graphEdgeStyle(normalizedWeight: number, style: GraphVisualStyle): { color: string; size: number } {
  const weight = Math.max(0, Math.min(1, normalizedWeight))
  if (style === "neural-night") {
    // Reference: thin #2b6fff lines at roughly 25-40% alpha; strong links
    // get brighter and slightly thicker.
    const alpha = 0.16 + weight * 0.3
    return {
      color: `rgba(43,111,255,${alpha.toFixed(3)})`,
      size: 0.3 + weight * 1.8,
    }
  }

  const alpha = Math.round(40 + weight * 180) / 255
  return {
    color: `rgba(100,116,139,${alpha})`,
    size: 0.5 + weight * 3.5,
  }
}

export function neuralNightBloom(nodeCount: number): { nodes: string; edges: string } {
  if (nodeCount > 1800) {
    return {
      nodes: "drop-shadow(0 0 2px rgba(77,166,255,0.52))",
      edges: "none",
    }
  }
  if (nodeCount > 700) {
    return {
      nodes: "drop-shadow(0 0 3px rgba(77,166,255,0.68))",
      edges: "none",
    }
  }
  return {
    nodes: "drop-shadow(0 0 2px rgba(207,234,255,0.9)) drop-shadow(0 0 7px rgba(41,121,255,0.55))",
    edges: "drop-shadow(0 0 2px rgba(43,111,255,0.18))",
  }
}

/**
 * Per-frame drawing budget for the Neural Night overlay (multi-layer halos,
 * starburst rays, ring nodes, sparkles). Degrades with the same thresholds
 * as neuralNightBloom so a large graph never pays for scene dressing.
 */
export function neuralNightOverlayBudget(nodeCount: number): {
  haloNodes: number
  rayHubs: number
  raysPerHub: number
  sparkles: number
} {
  if (nodeCount > 1800) {
    return { haloNodes: 0, rayHubs: 0, raysPerHub: 0, sparkles: 0 }
  }
  if (nodeCount > 700) {
    return { haloNodes: 40, rayHubs: 6, raysPerHub: 20, sparkles: 60 }
  }
  return { haloNodes: 120, rayHubs: 14, raysPerHub: 32, sparkles: 140 }
}

export function neuralNightHash(value: string): number {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/**
 * Reference image shows occasional hollow "ring" nodes among the satellites.
 * Deterministic choice: only small nodes (bottom third by normalized size),
 * roughly one in seven, stable per node id across renders.
 */
export function isNeuralNightRingNode(nodeId: string, sizeNorm: number): boolean {
  if (sizeNorm > 0.34) return false
  return neuralNightHash(nodeId) % 7 === 0
}
