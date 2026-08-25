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
 * the wrong wiki. Defaults (omitted / "current") use the same current
 * marker as `readProjectsFromAppState` (env, then lastProject, then the
 * first registry entry).
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

  const current = projects.find((project) => project.current) ?? projects[0]
  if (current && projectDirExists(current.path)) return current
  return null
}

export function resolveOfflineProjectPath(explicit?: string): string | null {
  return findOfflineProject(explicit)?.path ?? null
}

export function readProjectsFromAppState(): ApiProject[] {
  let lastProject: { id?: string; name?: string; path?: string } | undefined
  let registry: Record<string, { id?: string; name?: string; path?: string }> | undefined
  let recents: Array<{ id?: string; name?: string; path?: string }> | undefined
  try {
    const raw = JSON.parse(fs.readFileSync(defaultAppStatePath(), "utf8")) as Record<string, unknown>
    lastProject = raw.lastProject as { id?: string; name?: string; path?: string } | undefined
    registry = raw.projectRegistry as Record<string, { id?: string; name?: string; path?: string }> | undefined
    recents = raw.recentProjects as Array<{ id?: string; name?: string; path?: string }> | undefined
  } catch {
    // Missing or invalid app-state still allows LLM_WIKI_PROJECT_PATH below.
  }

  const env = process.env.LLM_WIKI_PROJECT_PATH
  const envPath = env && projectDirExists(env) ? normalizeProjectPath(env) : ""
  const lastPath = lastProject?.path ? normalizeProjectPath(lastProject.path) : ""
  // Env is the offline current override; list and resolve must share it.
  const currentPath = envPath || lastPath

  const byPath = new Map<string, ApiProject>()
  const add = (id: string, name: string | undefined, projectPath: string) => {
    if (!projectPath) return
    const normalized = normalizeProjectPath(projectPath)
    if (!normalized || byPath.has(normalized)) return
    byPath.set(normalized, fromPath(projectPath, id, name, currentPath === normalized))
  }

  for (const [key, entry] of Object.entries(registry ?? {})) {
    if (!entry?.path) continue
    // Registry map key is canonical, matching the desktop API. A stale
    // nested entry.id must not remap another project's UUID onto this path.
    add(key, entry.name, entry.path)
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
  if (env && envPath) {
    add(readProjectId(env), undefined, env)
  }
  return [...byPath.values()]
}

export function readProjectId(projectPath: string): string {
  try {
    // Confine before parse: a project.json or .llm-wiki symlink can otherwise
    // steal another project's UUID into this MCP session's project list.
    const metaPath = safeJoinOffline(projectPath, ".llm-wiki/project.json")
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"))
    if (typeof meta?.id === "string") return meta.id
  } catch {
    // fall through
  }
  return projectPath
}

/**
 * Re-read the pinned folder's project.json after the desktop app stops.
 * A remint or folder swap must not keep the session on a stale UUID, and a
 * vanished path must not keep serving the cached pin.
 */
export function refreshOfflineProjectIdentity(project: ApiProject): ApiProject {
  if (!projectDirExists(project.path)) {
    throw new Error(`Pinned project path is no longer available: ${project.path}`)
  }
  const diskId = readProjectId(project.path)
  if (!diskId || diskId === project.id) return project
  return { ...project, id: diskId }
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

function isResolvedInside(rootReal: string, candidateReal: string): boolean {
  if (candidateReal === rootReal) return true
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
  return candidateReal.startsWith(prefix)
}

/**
 * Mirror of the desktop API `safe_join`: lexically reject traversal, then
 * canonicalize so a wiki/sources symlink cannot read a file outside the
 * project. Existing in-project targets stay allowed, matching the API.
 */
function safeJoinOffline(projectPath: string, relPath: string): string {
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalizedRel) {
    throw new Error("Path traversal is not allowed")
  }
  if (path.isAbsolute(normalizedRel) || /^[a-zA-Z]:/.test(normalizedRel)) {
    throw new Error("Absolute paths are not allowed")
  }
  const segments = normalizedRel.split("/").filter((seg) => seg !== ".")
  if (segments.some((seg) => seg === "" || seg === "..")) {
    throw new Error("Path traversal is not allowed")
  }
  const rootReal = fs.realpathSync(projectPath)
  const joined = path.resolve(projectPath, ...segments)
  if (fs.existsSync(joined)) {
    const joinedReal = fs.realpathSync(joined)
    if (!isResolvedInside(rootReal, joinedReal)) {
      throw new Error("Resolved path escapes the project directory")
    }
    return joinedReal
  }
  const parent = path.dirname(joined)
  if (fs.existsSync(parent)) {
    const parentReal = fs.realpathSync(parent)
    if (!isResolvedInside(rootReal, parentReal)) {
      throw new Error("Resolved parent escapes the project directory")
    }
  }
  return joined
}

type FileBudget = { left: number; skipped: boolean }

function remainingHasFiles(
  base: string,
  relRoot: string,
  entries: fs.Dirent[],
  start: number,
  recursive: boolean,
): boolean {
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.name.startsWith(".")) continue
    if (entry.isFile()) return true
    if (entry.isDirectory() && recursive) {
      const rel = path.posix.join(relRoot.replace(/\\/g, "/"), entry.name)
      if (dirContainsListableFiles(base, rel)) return true
    }
  }
  return false
}

function dirContainsListableFiles(base: string, relRoot: string): boolean {
  let absRoot: string
  try {
    absRoot = safeJoinOffline(base, relRoot)
  } catch {
    return false
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true })
  } catch {
    return false
  }
  return remainingHasFiles(base, relRoot, entries, 0, true)
}

function walkDir(base: string, relRoot: string, recursive: boolean, budget: FileBudget): ApiFileNode[] {
  let absRoot: string
  try {
    absRoot = safeJoinOffline(base, relRoot)
  } catch {
    return []
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const nodes: ApiFileNode[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.name.startsWith(".")) continue
    if (budget.left <= 0) {
      if (remainingHasFiles(base, relRoot, entries, i, recursive)) budget.skipped = true
      break
    }
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

/** Same public roots as desktop `list_public_roots`: purpose.md, schema.md, wiki/, raw/sources/. */
function listPublicRootNode(
  projectPath: string,
  rel: string,
  recursive: boolean,
  budget: FileBudget,
): ApiFileNode | null {
  let abs: string
  try {
    abs = safeJoinOffline(projectPath, rel)
  } catch {
    return null
  }
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(abs)
  } catch {
    return null
  }
  if (stat.isSymbolicLink()) return null
  const posix = rel.replace(/\\/g, "/")
  const name = path.posix.basename(posix)
  if (stat.isFile()) {
    if (budget.left <= 0) {
      budget.skipped = true
      return null
    }
    budget.left--
    return { name, path: posix, isDir: false }
  }
  if (stat.isDirectory()) {
    const children = recursive ? walkDir(projectPath, posix, recursive, budget) : undefined
    return { name, path: posix, isDir: true, ...(children ? { children } : {}) }
  }
  return null
}

export function listFilesOffline(
  projectPath: string,
  options: { root?: "wiki" | "sources" | "all"; recursive?: boolean; maxFiles?: number } = {},
): ApiFilesResponse {
  const root = options.root ?? "wiki"
  const recursive = options.recursive ?? true
  const budget: FileBudget = {
    left: Math.max(1, Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, DEFAULT_MAX_FILES)),
    skipped: false,
  }
  const files: ApiFileNode[] = []
  if (root === "all") {
    for (const rel of ["purpose.md", "schema.md", "wiki", "raw/sources"] as const) {
      const node = listPublicRootNode(projectPath, rel, recursive, budget)
      if (node) files.push(node)
    }
  } else {
    files.push(...walkDir(projectPath, root === "sources" ? "raw/sources" : "wiki", recursive, budget))
  }
  // Exhausting the file budget is not truncation unless a remaining file was omitted.
  return { files, truncated: budget.skipped }
}

export function readFileOffline(projectPath: string, relPath: string): { path: string; content: string } {
  if (!isAllowedRelPath(relPath)) {
    throw new Error(`Path not allowed by the offline fallback (wiki/, raw/sources/, purpose.md, schema.md): ${relPath}`)
  }
  const abs = safeJoinOffline(projectPath, relPath)
  const stat = fs.statSync(abs)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File exceeds the 2 MB limit: ${relPath}`)
  }
  return { path: relPath, content: fs.readFileSync(abs, "utf8") }
}

const REVIEW_TITLE_PREFIXES = [
  "missing page",
  "missing-page",
  "missingpage",
  "duplicate page",
  "duplicate-page",
  "duplicatepage",
  "possible duplicate",
  "possible-duplicate",
  "possibleduplicate",
  "缺失页面",
  "缺少页面",
  "重复页面",
  "疑似重复",
] as const

type SanitizedReview = {
  id?: string
  type?: string
  title?: string
  description?: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ApiReviewItem["options"]
  resolved: boolean
  resolvedAction?: string
  createdAt?: number
}

/** Same prefix-stripping contract as the desktop `/reviews` handler. */
function normalizeReviewTitle(title: string): string {
  const trimmed = title.trimStart()
  const lower = trimmed.toLowerCase()
  let rest = trimmed
  for (const prefix of REVIEW_TITLE_PREFIXES) {
    if (!lower.startsWith(prefix)) continue
    const suffix = trimmed.slice(prefix.length)
    const delimiter = suffix.charAt(0)
    if (delimiter === ":" || delimiter === "：") {
      rest = suffix.slice(delimiter.length).trimStart()
      break
    }
  }
  return rest.trim().split(/\s+/).join(" ").toLowerCase()
}

/** FNV-1a 32-bit over UTF-16 units, matching `review_id_for_parts` in the API. */
function reviewIdForParts(itemType: string, title: string): string {
  const key = `${itemType}::${normalizeReviewTitle(title)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `review-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string")
}

function sanitizeReviewItem(item: Record<string, unknown>): SanitizedReview {
  const id = typeof item.type === "string" && typeof item.title === "string"
    ? reviewIdForParts(item.type, item.title)
    : (typeof item.id === "string" ? item.id : undefined)
  const options = Array.isArray(item.options)
    ? item.options.flatMap((option) => {
        if (!option || typeof option !== "object") return []
        const record = option as Record<string, unknown>
        const label = typeof record.label === "string" ? record.label : ""
        const action = typeof record.action === "string" ? record.action : ""
        if (!label && !action) return []
        return [{ label, action }]
      })
    : []
  const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
    ? item.createdAt
    : undefined
  return {
    id,
    type: typeof item.type === "string" ? item.type : undefined,
    title: typeof item.title === "string" ? item.title : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    sourcePath: typeof item.sourcePath === "string" ? item.sourcePath : undefined,
    affectedPages: stringList(item.affectedPages),
    searchQueries: stringList(item.searchQueries),
    options,
    resolved: item.resolved === true,
    resolvedAction: typeof item.resolvedAction === "string" ? item.resolvedAction : undefined,
    createdAt,
  }
}

function mergeStringList(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  const values = [...(existing ?? [])]
  for (const value of incoming ?? []) {
    if (!values.includes(value)) values.push(value)
  }
  return values.length > 0 ? values : undefined
}

function mergeSanitizedReview(existing: SanitizedReview, incoming: SanitizedReview): SanitizedReview {
  const resolved = existing.resolved || incoming.resolved
  const resolvedAction = resolved
    ? (existing.resolvedAction ?? incoming.resolvedAction)
    : undefined
  const createdAt = existing.createdAt !== undefined && incoming.createdAt !== undefined
    ? Math.min(existing.createdAt, incoming.createdAt)
    : (existing.createdAt ?? incoming.createdAt)
  const options = [...existing.options]
  for (const option of incoming.options) {
    if (!options.some((seen) => seen.action === option.action)) {
      options.push(option)
    }
  }
  return {
    ...existing,
    resolved,
    resolvedAction,
    description: existing.description ? existing.description : incoming.description,
    sourcePath: existing.sourcePath ? existing.sourcePath : incoming.sourcePath,
    affectedPages: mergeStringList(existing.affectedPages, incoming.affectedPages),
    searchQueries: mergeStringList(existing.searchQueries, incoming.searchQueries),
    options,
    createdAt,
  }
}

function toApiReviewItem(item: SanitizedReview): ApiReviewItem {
  return {
    id: item.id ?? "",
    type: item.type ?? "unknown",
    title: item.title ?? "",
    description: item.description ?? "",
    sourcePath: item.sourcePath,
    affectedPages: item.affectedPages,
    searchQueries: item.searchQueries,
    options: item.options,
    resolved: item.resolved,
    resolvedAction: item.resolvedAction,
    createdAt: item.createdAt ?? 0,
  }
}

export function readReviewsOffline(
  projectPath: string,
  options: { status?: ApiReviewStatus; type?: string; limit?: number } = {},
): ApiReviewsResponse {
  const status = options.status ?? "unresolved"
  // Confine before parse: a review.json or .llm-wiki symlink can otherwise
  // leak another project's queue into this MCP session.
  const reviewPath = safeJoinOffline(projectPath, ".llm-wiki/review.json")
  let rawText: string
  try {
    rawText = fs.readFileSync(reviewPath, "utf8")
  } catch (err) {
    // Missing file is an empty queue, matching the desktop API.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status, count: 0, reviews: [] }
    }
    throw err
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid review state JSON: ${detail}`)
  }
  if (!Array.isArray(raw)) {
    throw new Error("Invalid review state JSON: expected an array")
  }
  const items = raw as Array<Record<string, unknown>>
  const normalized: SanitizedReview[] = []
  const indexById = new Map<string, number>()
  for (const item of items) {
    const sanitized = sanitizeReviewItem(item)
    if (sanitized.id !== undefined) {
      const existingIdx = indexById.get(sanitized.id)
      if (existingIdx !== undefined) {
        normalized[existingIdx] = mergeSanitizedReview(normalized[existingIdx], sanitized)
        continue
      }
      indexById.set(sanitized.id, normalized.length)
    }
    normalized.push(sanitized)
  }
  const filtered = normalized.filter((review) => {
    if (status === "unresolved" && review.resolved) return false
    if (status === "resolved" && !review.resolved) return false
    if (options.type && review.type !== options.type) return false
    return true
  }).map(toApiReviewItem)
  const limited = options.limit ? filtered.slice(0, Math.max(1, options.limit)) : filtered
  return { status, count: limited.length, reviews: limited }
}

function collectWikiMarkdown(projectPath: string): Array<{ rel: string; content: string }> {
  const pages: Array<{ rel: string; content: string }> = []
  const walk = (relDir: string) => {
    let absDir: string
    try {
      absDir = safeJoinOffline(projectPath, relDir)
    } catch {
      return
    }
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
          const abs = safeJoinOffline(projectPath, rel)
          const stat = fs.statSync(abs)
          if (stat.size > MAX_FILE_BYTES) continue
          pages.push({ rel, content: fs.readFileSync(abs, "utf8") })
        } catch {
          // unreadable or escaped page — skip
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

function fileStem(relOrLink: string): string {
  const base = relOrLink.split("/").pop() ?? relOrLink
  return base.replace(/\.md$/i, "")
}

export function buildGraphOffline(
  projectPath: string,
  options: { q?: string; nodeType?: string; limit?: number } = {},
): { nodes: ApiGraphNode[]; edges: ApiGraphEdge[] } {
  const pages = collectWikiMarkdown(projectPath)
  // Live API keys nodes by file stem (BTreeMap last-write wins on collisions).
  const raw = new Map<string, { rel: string; content: string }>()
  for (const page of pages) {
    const id = fileStem(page.rel)
    if (!id) continue
    raw.set(id, { rel: page.rel, content: page.content })
  }
  const byLower = new Map<string, string>()
  for (const id of raw.keys()) byLower.set(id.toLowerCase(), id)

  const resolveLink = (rawLink: string): string | undefined => {
    const trimmed = rawLink.trim()
    if (!trimmed) return undefined
    if (raw.has(trimmed)) return trimmed
    const lower = pageStem(trimmed)
    return byLower.get(lower) ?? byLower.get(lower.replace(/ /g, "-"))
  }

  const linkCounts = new Map<string, number>()
  const edges: ApiGraphEdge[] = []
  const seenEdges = new Set<string>()
  for (const [source, page] of raw) {
    for (const match of page.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = resolveLink(match[1])
      if (!target || target === source) continue
      const key = source < target ? `${source}\0${target}` : `${target}\0${source}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      linkCounts.set(source, (linkCounts.get(source) ?? 0) + 1)
      linkCounts.set(target, (linkCounts.get(target) ?? 0) + 1)
      edges.push({ source, target, weight: 1 })
    }
  }

  let nodes: ApiGraphNode[] = [...raw.entries()].map(([id, page]) => ({
    id,
    label: frontmatterField(page.content, "title") ?? pageStem(page.rel),
    type: (frontmatterField(page.content, "type") ?? "other").toLowerCase(),
    path: page.rel,
    linkCount: linkCounts.get(id) ?? 0,
  }))
    .filter((node) => node.type !== "query")

  if (options.nodeType) {
    const nodeType = options.nodeType.toLowerCase()
    nodes = nodes.filter((node) => node.type === nodeType)
  }
  if (options.q) {
    const needle = options.q.toLowerCase()
    nodes = nodes.filter((node) => node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle))
  }
  // Live API walks a BTreeMap of stems then truncates; default limit 200, clamp 1..=1000.
  const limit = Math.min(1000, Math.max(1, options.limit ?? 200))
  nodes = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (nodes.length > limit) nodes = nodes.slice(0, limit)
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
    .split(/[\s,，。！？、；：""''“”‘’（）()\-_/\\·~～…]+/)
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
