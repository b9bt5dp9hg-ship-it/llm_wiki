import { invoke } from "@tauri-apps/api/core"
import { confinePreviewFilePath, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

export interface ImageRef {
  url: string
  alt: string
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
  vectorScore?: number
  images: ImageRef[]
}

interface BackendSearchResponse {
  // Reserved for result badges/debug UI. The backend already returns these
  // signals so API and WebView search share the same retrieval contract.
  mode: "keyword" | "vector" | "hybrid"
  results: SearchResult[]
  tokenHits: number
  vectorHits: number
  graphHits?: number
}

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

export function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
    if (hasCJK && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1])
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) tokens.push(ch)
      }
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }
  return [...new Set(tokens)]
}

export async function searchWiki(
  projectPath: string,
  query: string,
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const pp = normalizePath(projectPath)
  const embCfg = useWikiStore.getState().embeddingConfig

  const response = await invoke<BackendSearchResponse>("search_project", {
    projectPath: pp,
    query,
    topK: 20,
    includeContent: false,
    queryEmbedding: null,
    embeddingConfig: embCfg,
  })

  const results: SearchResult[] = []
  for (const result of response.results) {
    const confined = confinePreviewFilePath(pp, result.path)
    if (!confined) continue
    results.push({ ...result, path: confined })
  }
  return results
}

export type SearchSessionOutcome =
  | { status: "applied"; results: SearchResult[]; token: number }
  | { status: "stale"; token: number }

/**
 * Latest-wins guard for overlapping `searchWiki` calls. A slower older
 * query must not replace a newer result list (or refill it after clear).
 */
export function createSearchSession() {
  let generation = 0

  return {
    get generation() {
      return generation
    },
    invalidate() {
      generation += 1
    },
    isCurrent(token: number) {
      return token === generation
    },
    async run(projectPath: string, query: string): Promise<SearchSessionOutcome> {
      const token = ++generation
      if (!query.trim()) {
        return token === generation
          ? { status: "applied", results: [], token }
          : { status: "stale", token }
      }
      try {
        const results = await searchWiki(projectPath, query)
        return token === generation
          ? { status: "applied", results, token }
          : { status: "stale", token }
      } catch (error) {
        if (token !== generation) return { status: "stale", token }
        throw error
      }
    },
  }
}
