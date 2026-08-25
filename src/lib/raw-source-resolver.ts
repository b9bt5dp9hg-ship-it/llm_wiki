/**
 * Map a wiki-side image reference back to its raw source file.
 *
 * Image URLs we generate always live under
 *   `<project>/wiki/media/<slug>/img-N.<ext>`
 * — emitted either ABSOLUTE or WIKI-RELATIVE (`media/<slug>/img-N.png`).
 * The slug is the source-summary slug for the raw source identity. Root
 * sources keep their legacy basename stem slug; nested sources include their
 * `raw/sources` relative path plus a stable hash.
 *
 * Used in two places that want to "open the original document
 * around this image" rather than its LLM summary:
 *   - search-view's lightbox "Jump to source document" button
 *   - chat references panel's image badge (Phase 4 multimodal UI)
 *
 * Returns null when:
 *   - the URL doesn't match the expected media-directory shape, OR
 *   - no file with that stem exists under raw/sources/ (e.g. the
 *     user moved / deleted the original after ingest, leaving only
 *     the wiki summary). Callers fall back gracefully.
 */
import { listDirectory } from "@/commands/fs"
import {
  sourceIdentityForPath,
  sourceSummarySlugCandidatesFromIdentity,
} from "@/lib/source-identity"
import type { FileNode } from "@/types/wiki"
import { filterRawSourceTree } from "@/lib/source-filter"
import { collapsePathSegments, isAbsolutePath } from "@/lib/path-utils"

export async function findRawSourceForImage(
  imageUrl: string,
  projectPath: string,
): Promise<string | null> {
  // Image URLs reach us in TWO shapes:
  //   1. ABSOLUTE: `/Users/.../wiki/media/<slug>/img-N.png`
  //   2. WIKI-RELATIVE: `media/<slug>/img-N.png`
  // Match `media/<slug>/` either at the URL start or after any `/`.
  const m = imageUrl.replace(/\\/g, "/").match(/(?:^|\/)media\/([^/]+)\//)
  if (!m) return null
  const slug = m[1]
  const normalizedProjectPath = projectPath.replace(/\/+$/, "")

  let tree: FileNode[]
  try {
    tree = filterRawSourceTree(await listDirectory(`${normalizedProjectPath}/raw/sources`, true))
  } catch {
    return null
  }

  const findByMediaSlug = (nodes: FileNode[]): string | null => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          const found = findByMediaSlug(node.children)
          if (found) return found
        }
        continue
      }
      const identity = sourceIdentityForPath(normalizedProjectPath, node.path)
      if (sourceSummarySlugCandidatesFromIdentity(identity).includes(slug)) return node.path

      // Backward compatibility for media folders created before nested source
      // identities were encoded into the slug.
      const stem = node.name.replace(/\.[^.]+$/, "")
      if (stem === slug) return node.path
    }
    return null
  }

  return findByMediaSlug(tree)
}

/**
 * Normalize a markdown image URL to the absolute-path form that
 * the unified Rust extractor emits in raw-source previews. Used
 * by jump-to-source code paths that want to set a `<img data-mdsrc>`
 * scroll target on the raw-source preview — the raw side renders
 * absolute URLs, so a wiki-relative URL we got from a wiki page's
 * safety-net section needs to be promoted to absolute first.
 *
 * Idempotent: passing an already-absolute URL returns it unchanged.
 *
 * Nested wiki pages (`wiki/sources/*.md`) persist generated media as
 * `../media/<slug>/img-N.png` so Obsidian can resolve them. Joining
 * that form under `wiki/` without rewriting it would climb to
 * `<project>/media/` and miss the extractor's absolute
 * `<project>/wiki/media/...` `data-mdsrc` attributes.
 */
export function imageUrlToAbsolute(
  imageUrl: string,
  projectPath: string,
): string {
  if (isAbsolutePath(imageUrl)) return imageUrl
  const cleaned = imageUrl.replace(/\\/g, "/").replace(/^\.\//, "")
  const wikiRelative = cleaned.startsWith("../media/")
    ? cleaned.slice("../".length)
    : cleaned
  return collapsePathSegments(
    `${projectPath.replace(/\/+$/, "")}/wiki/${wikiRelative}`,
  )
}
