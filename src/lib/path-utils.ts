/**
 * Normalize a path to use forward slashes (works on both macOS and Windows).
 * Windows APIs accept forward slashes, so normalizing to / is safe everywhere.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/**
 * Join path segments with forward slashes.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, "/"))
    .join("/")
    .replace(/\/+/g, "/")
}

/**
 * Get the filename from a path (handles both / and \).
 */
export function getFileName(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

/**
 * Get the file stem (filename without extension).
 */
export function getFileStem(p: string): string {
  const name = getFileName(p)
  const lastDot = name.lastIndexOf(".")
  return lastDot > 0 ? name.slice(0, lastDot) : name
}

// Windows drive-letter and UNC paths are case-insensitive; fold them for
// comparison purposes only (never for the paths actually returned/written).
function caseFoldPath(normalized: string): string {
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized
}

/**
 * Get relative path from base.
 */
export function getRelativePath(fullPath: string, basePath: string): string {
  const normalFull = normalizePath(fullPath)
  const normalBase = normalizePath(basePath).replace(/\/$/, "")
  const fullKey = caseFoldPath(normalFull)
  const baseKey = caseFoldPath(normalBase)
  if (fullKey.startsWith(baseKey + "/")) {
    // Slice by path segments rather than the original string length. Unicode
    // case folding can change UTF-16 length, so an offset derived from the
    // differently-cased base can split the returned relative path incorrectly.
    return normalFull.split("/").slice(normalBase.split("/").length).join("/")
  }
  return normalFull
}

/**
 * Cross-platform absolute-path detection.
 *
 * Unix:     "/foo/bar"
 * Windows:  "C:\foo", "C:/foo", "\\server\share", "//server/share"
 *
 * A bare `.startsWith("/")` check wrongly treats Windows paths like
 * "C:/project/file.pdf" as relative, which produced double-joined
 * garbage like "C:/project/C:/project/file.pdf" in the ingest queue.
 */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith("\\\\") || p.startsWith("//")) return true
  return false
}

/**
 * Collapse `.` and `..` lexically without touching the filesystem.
 * Absolute paths clamp at the root; relative paths may keep a leading `..`.
 */
export function collapsePathSegments(p: string): string {
  const normalized = normalizePath(p)
  if (!normalized) return ""
  const drive = /^[A-Za-z]:/.exec(normalized)?.[0] ?? ""
  const body = drive ? normalized.slice(drive.length) : normalized
  const isAbsolute = body.startsWith("/") || normalized.startsWith("//")
  const out: string[] = []
  for (const seg of body.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (out.length > 0) out.pop()
      else if (!isAbsolute) out.push("..")
    } else {
      out.push(seg)
    }
  }
  const joined = out.join("/")
  if (drive) return `${drive}/${joined}`
  if (normalized.startsWith("//")) return `//${joined}`
  if (body.startsWith("/")) return `/${joined}`
  return joined
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const collapsedCandidate = collapsePathSegments(candidate)
  const collapsedRoot = collapsePathSegments(root).replace(/\/+$/, "")
  const candidateKey = caseFoldPath(collapsedCandidate)
  const rootKey = caseFoldPath(collapsedRoot)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}/`)
}

/**
 * Resolve a wiki file path so review/lint actions cannot leave `<project>/wiki/`.
 * Relative targets are joined under `wiki/`. After collapsing `..`, the result
 * must be a markdown file strictly inside that directory — not the wiki root
 * and not an extension-less directory that `delete_file` would remove recursively.
 */
export function confineWikiFilePath(projectPath: string, targetPath: string): string | null {
  if (typeof targetPath !== "string") return null
  const trimmed = targetPath.trim()
  if (!trimmed || /[\x00-\x1f]/.test(trimmed)) return null
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  if (!project) return null
  const wikiRoot = `${project}/wiki`
  const raw = normalizePath(trimmed)
  const absolute = isAbsolutePath(raw) ? raw : `${wikiRoot}/${raw}`
  const collapsed = collapsePathSegments(absolute)
  if (!isPathInsideRoot(collapsed, wikiRoot)) return null
  if (caseFoldPath(collapsePathSegments(wikiRoot)) === caseFoldPath(collapsed)) return null
  const name = getFileName(collapsed)
  if (!name || name === "." || name === ".." || !/\.md$/i.test(name)) return null
  return collapsed
}

function previewRootForRelativePath(project: string, raw: string): string {
  if (raw.startsWith("wiki/") || raw.startsWith("raw/")) {
    return `${project}/${raw}`
  }
  return `${project}/wiki/${raw}`
}

/**
 * Resolve a review/lint preview path so `open:` cannot read outside
 * `<project>/wiki/` or `<project>/raw/`. Relative targets join under `wiki/`
 * unless they already start with `wiki/` or `raw/`. After collapsing `..`,
 * `.llm-wiki` and other project-root files stay unreachable.
 */
export function confinePreviewFilePath(projectPath: string, targetPath: string): string | null {
  if (typeof targetPath !== "string") return null
  const trimmed = targetPath.trim()
  if (!trimmed || /[\x00-\x1f]/.test(trimmed)) return null
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  if (!project) return null
  const raw = normalizePath(trimmed)
  const absolute = isAbsolutePath(raw) ? raw : previewRootForRelativePath(project, raw)
  const collapsed = collapsePathSegments(absolute)
  const wikiRoot = `${project}/wiki`
  const rawRoot = `${project}/raw`
  if (!isPathInsideRoot(collapsed, wikiRoot) && !isPathInsideRoot(collapsed, rawRoot)) {
    return null
  }
  if (caseFoldPath(collapsePathSegments(wikiRoot)) === caseFoldPath(collapsed)) return null
  if (caseFoldPath(collapsePathSegments(rawRoot)) === caseFoldPath(collapsed)) return null
  const name = getFileName(collapsed)
  if (!name || name === "." || name === "..") return null
  return collapsed
}

/**
 * Resolve a chat/workspace file so citations, generated outputs, and attached
 * context files cannot read outside `<project>/`. Relative targets join at the
 * project root (wiki, raw, agent-workspace, schema). After collapsing `..`,
 * `.llm-wiki` stays unreachable.
 */
export function confineProjectFilePath(projectPath: string, targetPath: string): string | null {
  if (typeof targetPath !== "string") return null
  const trimmed = targetPath.trim()
  if (!trimmed || /[\x00-\x1f]/.test(trimmed)) return null
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  if (!project) return null
  const raw = normalizePath(trimmed)
  const absolute = isAbsolutePath(raw) ? raw : `${project}/${raw.replace(/^\/+/, "")}`
  const collapsed = collapsePathSegments(absolute)
  if (!isPathInsideRoot(collapsed, project)) return null
  if (caseFoldPath(collapsePathSegments(project)) === caseFoldPath(collapsed)) return null
  const relative = getRelativePath(collapsed, project)
  if (
    relative.split("/").some(
      (part) => !part || part === "." || part === ".." || part.toLowerCase() === ".llm-wiki",
    )
  ) {
    return null
  }
  const name = getFileName(collapsed)
  if (!name || name === "." || name === "..") return null
  return collapsed
}

/** Confined preview path plus an optional `.md` sibling, matching prior open: lookup. */
export function previewFilePathCandidates(projectPath: string, targetPath: string): string[] {
  const confined = confinePreviewFilePath(projectPath, targetPath)
  if (!confined) return []
  if (/\.md$/i.test(confined)) return [confined]
  return [confined, `${confined}.md`]
}
