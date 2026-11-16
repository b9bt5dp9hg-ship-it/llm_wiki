import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { buildRetrievalGraph, calculateRelevance } from "./graph-relevance"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { detectCommunities } from "./wiki-graph-analysis"
import {
  buildWikiLinkIndex,
  resolveWikiLink,
  type WikiLinkIndex,
  type WikiLinkTarget,
} from "./wiki-link-resolver"
import yaml from "js-yaml"

export interface GraphNode {
  id: string
  label: string
  type: string
  path: string
  linkCount: number // inbound + outbound
  community: number // community id from Louvain detection
}

export interface GraphEdge {
  source: string
  target: string
  weight: number // relevance score between source and target
}

export interface CommunityInfo {
  id: number
  nodeCount: number
  cohesion: number // intra-community edge density
  meanIntraDegree: number // average internal links per page; scale-independent
  topNodes: string[] // top nodes by linkCount (labels)
}

export interface WikiGraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  communities: CommunityInfo[]
}

const GRAPH_FILE_READ_CONCURRENCY = 16
const COMMUNITY_WORKER_THRESHOLD = 500
const MAX_CACHED_PROJECT_GRAPHS = 2
const graphCache = new Map<string, { dataVersion: number; result: WikiGraphResult }>()
const graphBuilds = new Map<string, Promise<WikiGraphResult>>()

async function analyzeCommunities(
  nodes: { id: string; label: string; linkCount: number }[],
  edges: GraphEdge[],
): Promise<{ assignments: Map<string, number>; communities: CommunityInfo[] }> {
  if (nodes.length < COMMUNITY_WORKER_THRESHOLD || typeof Worker === "undefined") {
    return detectCommunities(nodes, edges)
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./wiki-graph-analysis.worker.ts", import.meta.url),
      { type: "module" },
    )
    worker.onmessage = (event: MessageEvent<{
      assignments: [string, number][]
      communities: CommunityInfo[]
    }>) => {
      worker.terminate()
      resolve({
        assignments: new Map(event.data.assignments),
        communities: event.data.communities,
      })
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || "Knowledge graph analysis worker failed"))
    }
    worker.postMessage({ nodes, edges })
  })
}

const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  const title = parseFrontmatter(content).frontmatter?.title
  if (typeof title === "string" && title.trim()) return title.trim()

  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

function extractType(content: string): string {
  const type = parseFrontmatter(content).frontmatter?.type
  if (typeof type === "string" && type.trim()) return type.trim().toLowerCase()
  return "other"
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, "g")
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

/**
 * Frontmatter `related:` entries. The display parser stringifies unusual YAML
 * values; graph relationships must only come from actual strings, never a
 * boolean/object coerced to a page name. Reuse its located block while
 * preserving YAML value types (JSON schema keeps `123`/`true` non-strings).
 */
function extractRelated(content: string): string[] {
  const rawBlock = parseFrontmatter(content).rawBlock
  const payload = rawBlock.match(/(?:^\uFEFF?|\n)---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/)?.[1]
  if (payload === undefined) return []
  try {
    const metadata = yaml.load(payload, { schema: yaml.JSON_SCHEMA })
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return []
    const related = (metadata as Record<string, unknown>).related
    if (Array.isArray(related)) {
      return related.filter((value): value is string => typeof value === "string")
    }
    if (typeof related === "string" && related.trim()) return [related]
  } catch {
    // Malformed metadata does not suppress independently valid wikilinks.
  }
  return []
}

/**
 * Resolve a `related:` entry. Explicit paths resolve as paths first (same
 * rules as body wikilinks and the reader). Generated metadata often names a
 * stale folder (`wiki/concepts/x.md` for a page that lives elsewhere), so a
 * related path that does not resolve falls back to its basename — which still
 * only links when that basename is unambiguous in the wiki.
 */
function resolveRelatedTarget(index: WikiLinkIndex, reference: string): WikiLinkTarget | null {
  const exact = resolveWikiLink(index, reference)
  if (exact) return exact
  const target = reference.trim().replace(/^\[\[|\]\]$/g, "").split("|", 1)[0].split("#", 1)[0].replace(/\\/g, "/")
  if (!target.includes("/") || target.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(target)) return null
  const segments = target.split("/")
  if (segments.some((segment) => segment === "..")) return null
  const basename = segments.pop()?.trim()
  return basename ? resolveWikiLink(index, basename) : null
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await mapper(values[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

export async function buildWikiGraph(
  projectPath: string,
  dataVersion?: number,
): Promise<WikiGraphResult> {
  const normalizedProjectPath = normalizePath(projectPath)
  if (dataVersion !== undefined) {
    const cached = graphCache.get(normalizedProjectPath)
    if (cached?.dataVersion === dataVersion) return cached.result
  }

  const buildKey = `${normalizedProjectPath}\u0000${dataVersion ?? "uncached"}`
  const pending = graphBuilds.get(buildKey)
  if (pending) return pending
  const build = buildWikiGraphUncached(normalizedProjectPath)
  graphBuilds.set(buildKey, build)
  let result: WikiGraphResult
  try {
    result = await build
  } finally {
    graphBuilds.delete(buildKey)
  }
  if (dataVersion !== undefined) {
    const cached = graphCache.get(normalizedProjectPath)
    // An older build may finish after a newer dataVersion. Never let it
    // replace the newer cached graph.
    if (!cached || cached.dataVersion <= dataVersion) {
      if (!cached && graphCache.size >= MAX_CACHED_PROJECT_GRAPHS) {
        const oldestProject = graphCache.keys().next().value
        if (oldestProject) graphCache.delete(oldestProject)
      }
      graphCache.set(normalizedProjectPath, { dataVersion, result })
    }
  }
  return result
}

async function buildWikiGraphUncached(projectPath: string): Promise<WikiGraphResult> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return { nodes: [], edges: [], communities: [] }
  }

  const mdFiles = flattenMdFiles(tree)
  if (mdFiles.length === 0) {
    return { nodes: [], edges: [], communities: [] }
  }

  // Build a map of id -> node data
  const nodeMap = new Map<
    string,
    { id: string; label: string; type: string; path: string; links: string[]; related: string[] }
  >()

  const parsedFiles = await mapWithConcurrency(
    mdFiles,
    GRAPH_FILE_READ_CONCURRENCY,
    async (file) => {
      try {
        const content = await readFile(file.path)
        return {
          label: extractTitle(content, file.name),
          type: extractType(content),
          path: file.path,
          links: Array.from(new Set(extractWikilinks(content))),
          related: Array.from(new Set(extractRelated(content))),
        }
      } catch {
        return null
      }
    },
  )
  // Filter out query nodes (research results, saved chat answers) — they are
  // intermediate artifacts, not knowledge structure. The entities/concepts
  // extracted from them via auto-ingest are what belong in the graph.
  const visibleFiles = parsedFiles.filter(
    (file): file is NonNullable<typeof file> => file !== null && file.type !== "query",
  )
  // The reader sees every filename, including queries and unreadable pages.
  // Keep that complete inventory for identity/ambiguity; visibility only
  // controls which resolved pages can become nodes or edge endpoints.
  const targetIndex = buildWikiLinkIndex(mdFiles.map((file) => file.path), wikiRoot)
  const idsByPath = new Map(targetIndex.targets.map((target) => [target.path, target.id]))
  for (const parsed of visibleFiles) {
    const id = idsByPath.get(parsed.path)
    if (id !== undefined) nodeMap.set(id, { ...parsed, id })
  }

  // Count link references
  const linkCounts = new Map<string, number>()
  for (const [id] of nodeMap) {
    linkCounts.set(id, 0)
  }

  const rawEdges: GraphEdge[] = []

  for (const [sourceId, nodeData] of nodeMap) {
    const targetIds = [
      ...nodeData.links.map((targetRaw) => resolveWikiLink(targetIndex, targetRaw)?.id),
      ...nodeData.related.map((targetRaw) => resolveRelatedTarget(targetIndex, targetRaw)?.id),
    ]
    for (const targetId of targetIds) {
      if (targetId === undefined || !nodeMap.has(targetId)) continue
      if (targetId === sourceId) continue

      rawEdges.push({ source: sourceId, target: targetId, weight: 1 })
    }
  }

  // Deduplicate edges
  const seenEdges = new Set<string>()
  const dedupedEdges: { source: string; target: string }[] = []
  for (const edge of rawEdges) {
    const key = JSON.stringify([edge.source, edge.target])
    const reverseKey = JSON.stringify([edge.target, edge.source])
    if (!seenEdges.has(key) && !seenEdges.has(reverseKey)) {
      seenEdges.add(key)
      dedupedEdges.push(edge)
      linkCounts.set(edge.source, (linkCounts.get(edge.source) ?? 0) + 1)
      linkCounts.set(edge.target, (linkCounts.get(edge.target) ?? 0) + 1)
    }
  }

  // Calculate relevance weights using the retrieval graph
  let retrievalGraph: Awaited<ReturnType<typeof buildRetrievalGraph>> | null = null
  try {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const dv = useWikiStore.getState().dataVersion
    retrievalGraph = await buildRetrievalGraph(normalizePath(projectPath), dv)
  } catch {
    // Keep the graph available with neutral weights if relevance enrichment fails.
  }

  const edges: GraphEdge[] = dedupedEdges.map((e) => {
    let weight = 1
    if (retrievalGraph) {
      const nodeA = retrievalGraph.nodes.get(e.source)
      const nodeB = retrievalGraph.nodes.get(e.target)
      if (nodeA && nodeB) {
        weight = calculateRelevance(nodeA, nodeB, retrievalGraph)
      }
    }
    return { source: e.source, target: e.target, weight }
  })

  // Build preliminary nodes for community detection
  const prelimNodes = Array.from(nodeMap.values()).map((n) => ({
    id: n.id,
    label: n.label,
    linkCount: linkCounts.get(n.id) ?? 0,
  }))

  const { assignments, communities } = await analyzeCommunities(prelimNodes, edges).catch(
    () => detectCommunities(prelimNodes, edges),
  )

  const nodes: GraphNode[] = Array.from(nodeMap.values()).map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    path: n.path,
    linkCount: linkCounts.get(n.id) ?? 0,
    community: assignments.get(n.id) ?? 0,
  }))

  return { nodes, edges, communities }
}
