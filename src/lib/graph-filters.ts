import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { shouldHideNodeType } from "@/lib/graph-visibility"

export interface GraphFilterState {
  hiddenTypes: ReadonlySet<string>
  hiddenNodeIds: ReadonlySet<string>
  hideStructural: boolean
  hideIsolated: boolean
  minLinks?: number
  maxLinks?: number
}

export interface FilteredGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  hiddenNodeIds: Set<string>
}

export const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  hiddenTypes: new Set(),
  hiddenNodeIds: new Set(),
  hideStructural: true,
  hideIsolated: false,
  minLinks: undefined,
  maxLinks: undefined,
}

const STRUCTURAL_IDS = new Set(["index", "overview", "log", "schema", "purpose"])

export function isStructuralGraphNode(node: Pick<GraphNode, "id" | "path" | "type">): boolean {
  const id = node.id.toLowerCase()
  if (STRUCTURAL_IDS.has(id)) return true
  if (node.type === "overview") return true

  const normalizedPath = node.path.replace(/\\/g, "/").toLowerCase()
  return (
    normalizedPath.endsWith("/wiki/index.md") ||
    normalizedPath.endsWith("/wiki/overview.md") ||
    normalizedPath.endsWith("/wiki/log.md") ||
    normalizedPath.endsWith("/purpose.md") ||
    normalizedPath.endsWith("/schema.md")
  )
}

export function applyGraphFilters(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  filters: GraphFilterState,
): FilteredGraph {
  const hiddenNodeIds = new Set<string>()

  for (const node of nodes) {
    if (filters.hiddenNodeIds.has(node.id)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (shouldHideNodeType(node.type, filters.hiddenTypes)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.hideStructural && isStructuralGraphNode(node)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.minLinks !== undefined && node.linkCount < filters.minLinks) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.maxLinks !== undefined && node.linkCount > filters.maxLinks) {
      hiddenNodeIds.add(node.id)
    }
  }

  const eligibleNodes = nodes.filter((node) => !hiddenNodeIds.has(node.id))
  const eligibleNodeIds = new Set(eligibleNodes.map((node) => node.id))
  const visibleEdges = edges.filter(
    (edge) => eligibleNodeIds.has(edge.source) && eligibleNodeIds.has(edge.target),
  )

  if (filters.hideIsolated) {
    // Isolation belongs to the visible graph after all other filters. Removing
    // zero-degree nodes cannot remove another node's edge, so one pass suffices.
    const connectedNodeIds = new Set<string>()
    for (const edge of visibleEdges) {
      connectedNodeIds.add(edge.source)
      connectedNodeIds.add(edge.target)
    }
    for (const node of eligibleNodes) {
      if (!connectedNodeIds.has(node.id)) hiddenNodeIds.add(node.id)
    }
  }
  const visibleNodes = eligibleNodes.filter((node) => !hiddenNodeIds.has(node.id))

  return { nodes: visibleNodes, edges: visibleEdges, hiddenNodeIds }
}

export function hasActiveGraphFilters(filters: GraphFilterState): boolean {
  return (
    filters.hideStructural ||
    filters.hideIsolated ||
    filters.hiddenTypes.size > 0 ||
    filters.hiddenNodeIds.size > 0 ||
    filters.minLinks !== undefined ||
    filters.maxLinks !== undefined
  )
}
