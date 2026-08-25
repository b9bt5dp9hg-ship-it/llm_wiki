import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type {
  ApiFileNode,
  ApiFilesResponse,
  ApiGraphEdge,
  ApiGraphNode,
  ApiProject,
  ApiReviewItem,
  ApiReviewsResponse,
  ApiReviewStatus,
  ApiSearchResponse,
  ApiSearchResult,
} from "./api-client.js"

/**
 * App-free implementations of the read-only MCP tools, used when the
 * desktop app's local API is unreachable. Mirrors the Rust handlers'
 * behavior (allow-list, roots, response shapes) so callers see the same
 * data shapes either way — just without vector search, chat, or ingest.
 */

const ALLOWED_EXTENSIONS = new Set([
  "md", "mdx", "txt", "csv", "json", "yaml", "yml", "xml", "html", "htm", "log",
])
const ALLOWED_ROOT_FILES = new Set(["purpose.md", "schema.md"])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_FILES = 10_000

export function defaultAppStatePath(): string {
  if (process.env.LLM_WIKI_APP_STATE) return process.env.LLM_WIKI_APP_STATE
  return path.join(os.homedir(), "Library", "Application Support", "com.llmwiki.app", "app-state.json")
}

function normalizeProjectPath(projectPath: string): string {
  return projectPath.replace(/\\/g, "/").replace(/\/+$/, "")
}

function projectDirExists(projectPath: string): boolean {
  try {
    return fs.statSync(projectPath).isDirectory()
  } catch {
    return false
  }
}

function fromPath(projectPath: string, id?: string, name?: string, current = false): ApiProject {
  const normalized = normalizeProjectPath(projectPath)
  return {
    id: id && id.trim() ? id : readProjectId(normalized),
    name: (name && name.trim()) || path.basename(normalized),
    path: projectPath,
    current,
  }
}

/**
 * Resolve a project without the app, matching the desktop API contract:
 * UUID, filesystem path, or "current". An explicit unknown id must not
 * fall through to lastProject / LLM_WIKI_PROJECT_PATH — that would search
 * the wrong wiki. Defaults (omitted / "current") still use env, then
 * lastProject, then the first registry entry.
 */
export function findOfflineProject(requested?: string): ApiProject | null {
  const projects = readProjectsFromAppState()
  const needle = requested?.trim() ?? ""
  const isDefault = needle === "" || needle.toLowerCase() === "current"

  if (!isDefault) {
    const normalizedNeedle = normalizeProjectPath(needle)
    const match = projects.find((project) => (
      project.id === needle
      || project.path === needle
      || normalizeProjectPath(project.path) === normalizedNeedle
    ))
    if (match && projectDirExists(match.path)) return match
    if (path.isAbsolute(needle) && projectDirExists(needle)) {
      return fromPath(needle)
    }
    return null
  }

  const env = process.env.LLM_WIKI_PROJECT_PATH
  if (env && projectDirExists(env)) {
    const normalized = normalizeProjectPath(env)
    return projects.find((project) => normalizeProjectPath(project.path) === normalized)
      ?? fromPath(env)
  }

  const last = projects.find((project) => project.current) ?? projects[0]
  if (last && projectDirExists(last.path)) return last
  return null
}

export function resolveOfflineProjectPath(explicit?: string): string | null {
  return findOfflineProject(explicit)?.path ?? null
}

export function readProjectsFromAppState(): ApiProject[] {
  try {
    const raw = JSON.parse(fs.readFileSync(defaultAppStatePath(), "utf8")) as Record<string, unknown>
    const lastProject = raw.lastProject as { id?: string; name?: string; path?: string } | undefined
    const registry = raw.projectRegistry as Record<string, { id?: string; name?: string; path?: string }> | undefined
    const recents = raw.recentProjects as Array<{ id?: string; name?: string; path?: string }> | undefined
    const byPath = new Map<string, ApiProject>()
    const lastPath = lastProject?.path ? normalizeProjectPath(lastProject.path) : ""

    const add = (id: string, name: string | undefined, projectPath: string) => {
      if (!projectPath) return
      const normalized = normalizeProjectPath(projectPath)
      if (!normalized || byPath.has(normalized)) return
      byPath.set(normalized, fromPath(projectPath, id, name, lastPath === normalized))
    }

    for (const [key, entry] of Object.entries(registry ?? {})) {
      if (!entry?.path) continue
      add(typeof entry.id === "string" && entry.id ? entry.id : key, entry.name, entry.path)
    }
    if (Array.isArray(recents)) {
      for (const entry of recents) {
        if (!entry?.path) continue
        add(typeof entry.id === "string" && entry.id ? entry.id : readProjectId(entry.path), entry.name, entry.path)
      }
    }
    if (lastProject?.path) {
      add(
        typeof lastProject.id === "string" && lastProject.id ? lastProject.id : readProjectId(lastProject.path),
        lastProject.name,
        lastProject.path,
      )
    }
    return [...byPath.values()]
  } catch {
    return []
  }
}

export function readProjectId(projectPath: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "project.json"), "utf8"))
    if (typeof meta?.id === "string") return meta.id
  } catch {
    // fall through
  }
  return projectPath
}

function isAllowedExtension(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase()
  return ALLOWED_EXTENSIONS.has(ext)
}

function isAllowedRelPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  if (normalized.includes("..")) return false
  if (ALLOWED_ROOT_FILES.has(normalized)) return true
  return (normalized.startsWith("wiki/") || normalized.startsWith("raw/sources/")) && isAllowedExtension(normalized)
}

function walkDir(base: string, relRoot: string, recursive: boolean, budget: { left: number }): ApiFileNode[] {
  const absRoot = path.join(base, relRoot)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const nodes: ApiFileNode[] = []
  for (const entry of entries) {
    if (budget.left <= 0) break
    if (entry.name.startsWith(".")) continue
    const rel = path.posix.join(relRoot.replace(/\\/g, "/"), entry.name)
    if (entry.isDirectory()) {
      const children = recursive ? walkDir(base, rel, recursive, budget) : undefined
      nodes.push({ name: entry.name, path: rel, isDir: true, ...(children ? { children } : {}) })
    } else if (entry.isFile()) {
      budget.left--
      nodes.push({ name: entry.name, path: rel, isDir: false })
    }
  }
  return nodes
}

export function listFilesOffline(
  projectPath: string,
  options: { root?: "wiki" | "sources" | "all"; recursive?: boolean; maxFiles?: number } = {},
): ApiFilesResponse {
  const root = options.root ?? "wiki"
  const recursive = options.recursive ?? true
  const budget = { left: Math.max(1, Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, DEFAULT_MAX_FILES)) }
  const files: ApiFileNode[] = []
  if (root === "wiki" || root === "all") files.push(...walkDir(projectPath, "wiki", recursive, budget))
  if (root === "sources" || root === "all") files.push(...walkDir(projectPath, "raw/sources", recursive, budget))
  return { files, truncated: budget.left <= 0 }
}

export function readFileOffline(projectPath: string, relPath: string): { path: string; content: string } {
  if (!isAllowedRelPath(relPath)) {
    throw new Error(`Path not allowed by the offline fallback (wiki/, raw/sources/, purpose.md, schema.md): ${relPath}`)
  }
  const abs = path.join(projectPath, relPath)
  const stat = fs.statSync(abs)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File exceeds the 2 MB limit: ${relPath}`)
  }
  return { path: relPath, content: fs.readFileSync(abs, "utf8") }
}

export function readReviewsOffline(
  projectPath: string,
  options: { status?: ApiReviewStatus; type?: string; limit?: number } = {},
): ApiReviewsResponse {
  const status = options.status ?? "unresolved"
  let items: Array<Record<string, unknown>> = []
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "review.json"), "utf8"))
    if (Array.isArray(raw)) items = raw as Array<Record<string, unknown>>
  } catch {
    items = []
  }
  const reviews: ApiReviewItem[] = items.map((item, index) => ({
    id: typeof item.id === "string" ? item.id : `review-${index}`,
    type: typeof item.type === "string" ? item.type : "unknown",
    title: typeof item.title === "string" ? item.title : "",
    description: typeof item.description === "string" ? item.description : "",
    sourcePath: typeof item.sourcePath === "string" ? item.sourcePath : undefined,
    affectedPages: Array.isArray(item.affectedPages) ? item.affectedPages.filter((p): p is string => typeof p === "string") : undefined,
    searchQueries: Array.isArray(item.searchQueries) ? item.searchQueries.filter((q): q is string => typeof q === "string") : undefined,
    options: Array.isArray(item.options)
      ? (item.options as Array<Record<string, unknown>>).map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          action: typeof o.action === "string" ? o.action : "",
        }))
      : [],
    resolved: item.resolved === true,
    resolvedAction: typeof item.resolvedAction === "string" ? item.resolvedAction : undefined,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
  }))
  const filtered = reviews.filter((review) => {
    if (status === "unresolved" && review.resolved) return false
    if (status === "resolved" && !review.resolved) return false
    if (options.type && review.type !== options.type) return false
    return true
  })
  const limited = options.limit ? filtered.slice(0, Math.max(1, options.limit)) : filtered
  return { status, count: limited.length, reviews: limited }
}

function collectWikiMarkdown(projectPath: string): Array<{ rel: string; content: string }> {
  const pages: Array<{ rel: string; content: string }> = []
  const walk = (relDir: string) => {
    const absDir = path.join(projectPath, relDir)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const rel = path.posix.join(relDir.replace(/\\/g, "/"), entry.name)
      if (entry.isDirectory()) {
        walk(rel)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        try {
          const stat = fs.statSync(path.join(projectPath, rel))
          if (stat.size > MAX_FILE_BYTES) continue
          pages.push({ rel, content: fs.readFileSync(path.join(projectPath, rel), "utf8") })
        } catch {
          // unreadable page — skip
        }
      }
    }
  }
  walk("wiki")
  return pages
}

function frontmatterField(content: string, field: string): string | null {
  if (!content.startsWith("---")) return null
  const end = content.indexOf("\n---", 3)
  if (end === -1) return null
  const frontmatter = content.slice(0, end)
  const match = frontmatter.match(new RegExp(`^${field}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m"))
  return match ? match[1].trim() : null
}

function pageStem(relOrLink: string): string {
  const base = relOrLink.split("/").pop() ?? relOrLink
  return base.replace(/\.md$/i, "").toLowerCase()
}

export function buildGraphOffline(
  projectPath: string,
  options: { q?: string; nodeType?: string; limit?: number } = {},
): { nodes: ApiGraphNode[]; edges: ApiGraphEdge[] } {
  const pages = collectWikiMarkdown(projectPath)
  const byStem = new Map<string, string>()
  for (const page of pages) byStem.set(pageStem(page.rel), page.rel)

  const linkCounts = new Map<string, number>()
  const edges: ApiGraphEdge[] = []
  const seenEdges = new Set<string>()
  for (const page of pages) {
    for (const match of page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = byStem.get(pageStem(match[1].trim()))
      if (!target || target === page.rel) continue
      const key = page.rel < target ? `${page.rel}\0${target}` : `${target}\0${page.rel}`
      linkCounts.set(page.rel, (linkCounts.get(page.rel) ?? 0) + 1)
      linkCounts.set(target, (linkCounts.get(target) ?? 0) + 1)
      if (!seenEdges.has(key)) {
        seenEdges.add(key)
        edges.push({ source: page.rel, target, weight: 1 })
      }
    }
  }

  let nodes: ApiGraphNode[] = pages.map((page) => ({
    id: page.rel,
    label: frontmatterField(page.content, "title") ?? pageStem(page.rel),
    type: frontmatterField(page.content, "type") ?? "other",
    path: page.rel,
    linkCount: linkCounts.get(page.rel) ?? 0,
  }))

  if (options.nodeType) nodes = nodes.filter((node) => node.type === options.nodeType)
  if (options.q) {
    const needle = options.q.toLowerCase()
    nodes = nodes.filter((node) => node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle))
  }
  if (options.limit && nodes.length > options.limit) {
    nodes = [...nodes].sort((a, b) => (b.linkCount ?? 0) - (a.linkCount ?? 0)).slice(0, options.limit)
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  return { nodes, edges: edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) }
}

const SEARCH_STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

/**
 * Same tokenizer as the desktop/Rust keyword search: split on
 * punctuation, drop short/stop tokens, then expand CJK into bigrams
 * and characters so a query like 默会知识 still hits pages that never
 * contain that exact four-character span.
 */
export function tokenizeOfflineQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((token) => token.length > 1)
    .filter((token) => !SEARCH_STOP_WORDS.has(token))

  const tokens: string[] = []
  for (const token of rawTokens) {
    const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
    if (hasCjk && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1])
      for (const ch of chars) {
        if (!SEARCH_STOP_WORDS.has(ch)) tokens.push(ch)
      }
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }
  return [...new Set(tokens)]
}

export function searchOffline(
  projectPath: string,
  query: string,
  options: { topK?: number } = {},
): ApiSearchResponse {
  const terms = tokenizeOfflineQuery(query)
  const pages = collectWikiMarkdown(projectPath)
  const results: ApiSearchResult[] = []
  let tokenHits = 0
  for (const page of pages) {
    const title = frontmatterField(page.content, "title") ?? pageStem(page.rel)
    const lowerTitle = title.toLowerCase()
    const lowerContent = page.content.toLowerCase()
    let score = 0
    let firstIndex = -1
    for (const term of terms) {
      let occurrences = 0
      let cursor = lowerContent.indexOf(term)
      if (cursor !== -1 && firstIndex === -1) firstIndex = cursor
      while (cursor !== -1 && occurrences < 50) {
        occurrences++
        cursor = lowerContent.indexOf(term, cursor + term.length)
      }
      score += occurrences
      if (lowerTitle.includes(term)) score += 10
    }
    if (score <= 0) continue
    tokenHits++
    const snippetStart = Math.max(0, (firstIndex === -1 ? 0 : firstIndex) - 80)
    const snippet = page.content.slice(snippetStart, snippetStart + 240).replace(/\s+/g, " ").trim()
    results.push({
      path: page.rel,
      title,
      snippet,
      score,
      titleMatch: terms.some((term) => lowerTitle.includes(term)),
    })
  }
  results.sort((a, b) => b.score - a.score)
  return {
    results: results.slice(0, Math.max(1, options.topK ?? 10)),
    mode: "offline-keyword",
    tokenHits,
    vectorHits: 0,
  }
}
