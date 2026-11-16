import { loadReviewItems, loadLintItems } from "@/lib/persist"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export interface SideStoreHydrationBaseline {
  generation: number
  ids: string[]
}

export function snapshotReviewHydration(): SideStoreHydrationBaseline {
  const { items, generation } = useReviewStore.getState()
  return { generation, ids: items.map((item) => item.id) }
}

export function snapshotLintHydration(): SideStoreHydrationBaseline {
  const { items, generation } = useLintStore.getState()
  return { generation, ids: items.map((item) => item.id) }
}

function isCurrentProject(proj: WikiProject): boolean {
  const current = useWikiStore.getState().project
  return current?.id === proj.id && current.path === proj.path
}

/**
 * Current-wins merge when the store mutated during disk I/O:
 * keep every in-memory item, never resurrect ids removed since the
 * baseline snapshot, and append disk items that are still unseen.
 */
function mergeHydratedItems<T extends { id: string }>(
  baselineIds: readonly string[],
  current: T[],
  loaded: T[],
): T[] {
  const currentIds = new Set(current.map((item) => item.id))
  const removed = new Set(baselineIds.filter((id) => !currentIds.has(id)))
  const extras = loaded.filter((item) => !currentIds.has(item.id) && !removed.has(item.id))
  return extras.length === 0 ? current : [...current, ...extras]
}

export async function hydrateReviewItems(
  proj: WikiProject,
  baseline: SideStoreHydrationBaseline = snapshotReviewHydration(),
): Promise<void> {
  try {
    const savedReview = await loadReviewItems(proj.path)
    if (!isCurrentProject(proj)) return
    const state = useReviewStore.getState()
    if (state.generation === baseline.generation) {
      if (savedReview.length > 0) state.setItems(savedReview)
      return
    }
    const merged = mergeHydratedItems<ReviewItem>(baseline.ids, state.items, savedReview)
    if (merged !== state.items) state.setItems(merged)
  } catch (err) {
    console.warn("[startup] failed to load review items:", err)
  }
}

export async function hydrateLintItems(
  proj: WikiProject,
  baseline: SideStoreHydrationBaseline = snapshotLintHydration(),
): Promise<void> {
  try {
    const savedLint = await loadLintItems(proj.path)
    if (!isCurrentProject(proj)) return
    const state = useLintStore.getState()
    if (state.generation === baseline.generation) {
      if (savedLint.length > 0) state.setItems(savedLint)
      return
    }
    const merged = mergeHydratedItems<LintItem>(baseline.ids, state.items, savedLint)
    if (merged !== state.items) state.setItems(merged)
  } catch (err) {
    console.warn("[startup] failed to load lint items:", err)
  }
}

/**
 * Delayed review/lint hydration after a project is opened. Pass the
 * post-reset baselines so ingest (or the user) cannot be overwritten by
 * a snapshot that started loading against empty stores. A stale-project
 * guard still drops the result after a fast project switch.
 */
export async function hydrateProjectSideStores(
  proj: WikiProject,
  baselines?: { review?: SideStoreHydrationBaseline; lint?: SideStoreHydrationBaseline },
): Promise<void> {
  await hydrateReviewItems(proj, baselines?.review)
  await hydrateLintItems(proj, baselines?.lint)
}
