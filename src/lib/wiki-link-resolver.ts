/** Shared page identity and link resolution for the reader and knowledge graph. */
export interface WikiLinkTarget {
  id: string
  path: string
}

type TargetLookup = Map<string, WikiLinkTarget[]>

export interface WikiLinkIndex {
  targets: readonly WikiLinkTarget[]
  basenames: readonly TargetLookup[]
  relativePaths: readonly TargetLookup[]
}

const LINK_NORMALIZERS = [
  (value: string) => value,
  (value: string) => value.normalize("NFC"),
  (value: string) => value.normalize("NFC").toLowerCase(),
  (value: string) => value.normalize("NFC").toLowerCase().replace(/\s+/g, "-"),
]

function withoutMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "")
}

function addLookup(
  lookups: TargetLookup[],
  value: string,
  target: WikiLinkTarget,
): void {
  LINK_NORMALIZERS.forEach((normalize, rank) => {
    const key = normalize(value)
    const matches = lookups[rank].get(key)
    if (matches) matches.push(target)
    else lookups[rank].set(key, [target])
  })
}

export function buildWikiLinkIndex(paths: Iterable<string>, wikiRoot: string): WikiLinkIndex {
  const root = wikiRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  const candidates = new Map<string, { path: string; relative: string; stem: string }>()
  const stemCounts = new Map<string, number>()
  for (const path of paths) {
    const normalizedPath = path.replace(/\\/g, "/")
    if (!normalizedPath.startsWith(`${root}/`) || !/\.md$/i.test(normalizedPath)) continue
    const relative = normalizedPath.slice(root.length + 1)
    // Never allow a caller's malformed path inventory to escape the wiki root.
    if (relative.split("/").some((part) => !part || part === "." || part === "..")) continue
    if (candidates.has(normalizedPath)) continue
    const stem = withoutMarkdownExtension(relative.split("/").pop()!)
    candidates.set(normalizedPath, { path, relative: withoutMarkdownExtension(relative), stem })
    const key = stem.normalize("NFC")
    stemCounts.set(key, (stemCounts.get(key) ?? 0) + 1)
  }

  const basenames = LINK_NORMALIZERS.map(() => new Map<string, WikiLinkTarget[]>())
  const relativePaths = LINK_NORMALIZERS.map(() => new Map<string, WikiLinkTarget[]>())
  const targets = [...candidates.values()].map(({ path, relative, stem }) => {
    // Preserve existing ids for unique names. Path ids keep same-named pages
    // in different folders distinct without rewriting any wiki files.
    const id = stemCounts.get(stem.normalize("NFC")) === 1 ? stem : relative
    const target = { id, path }
    addLookup(basenames, stem, target)
    addLookup(relativePaths, relative, target)
    return target
  })
  return { targets, basenames, relativePaths }
}

export function resolveWikiLink(index: WikiLinkIndex, reference: string): WikiLinkTarget | null {
  let target = reference.trim()
  const wrapped = target.match(/^\[\[([\s\S]*?)\]\]$/)
  if (wrapped) target = wrapped[1]
  target = target.split("|", 1)[0].split("#", 1)[0].trim().replace(/\\/g, "/")
  if (!target || target.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(target)) return null
  if (target.includes("\0")) return null

  const pathLike = target.includes("/")
  const segments = target.split("/")
  if (segments.some((segment) => segment === "..")) return null
  target = segments.filter((segment) => segment && segment !== ".").join("/")
  if (/^wiki\//i.test(target)) target = target.slice(5)
  target = withoutMarkdownExtension(target)
  if (!target) return null

  // An explicit path must resolve as a path. Falling back to a basename
  // would invent a relationship when a stale or incorrect folder is given.
  const lookups = pathLike ? index.relativePaths : index.basenames
  for (let rank = 0; rank < LINK_NORMALIZERS.length; rank += 1) {
    const matches = lookups[rank].get(LINK_NORMALIZERS[rank](target))
    if (matches) return matches.length === 1 ? matches[0] : null
  }
  return null
}
