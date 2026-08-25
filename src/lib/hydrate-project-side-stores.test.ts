/**
 * Delayed review/lint hydration must not clobber same-project mutations that
 * landed while disk I/O was in flight (ingest adding items, resolve/dismiss,
 * a lint run). A project-switch guard is not enough: the store can change
 * without the project id changing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { useReviewStore, reviewIdFor, type ReviewItem } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import type { LintResult } from "@/lib/lint"

const { loadReviewItems, loadLintItems } = vi.hoisted(() => ({
  loadReviewItems: vi.fn(),
  loadLintItems: vi.fn(),
}))

vi.mock("./persist", () => ({ loadReviewItems, loadLintItems }))

import {
  hydrateLintItems,
  hydrateProjectSideStores,
  snapshotLintHydration,
  snapshotReviewHydration,
} from "./hydrate-project-side-stores"

const PROJECT: WikiProject = { id: "proj-1", name: "P", path: "/wiki/p1" }
const OTHER: WikiProject = { id: "proj-2", name: "Q", path: "/wiki/p2" }

function review(title: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: reviewIdFor({ type: "missing-page", title }),
    type: "missing-page",
    title,
    description: "",
    options: [],
    resolved: false,
    createdAt: 1,
    ...overrides,
  }
}

function lint(id: string, page: string): LintItem {
  return {
    id,
    type: "orphan",
    severity: "info",
    page,
    detail: `${page} orphan`,
    createdAt: 1,
  }
}

function lintResult(page: string): LintResult {
  return { type: "orphan", severity: "info", page, detail: `${page} orphan` }
}

beforeEach(() => {
  loadReviewItems.mockReset()
  loadLintItems.mockReset()
  loadReviewItems.mockResolvedValue([])
  loadLintItems.mockResolvedValue([])
  useWikiStore.setState({ project: PROJECT })
  useReviewStore.setState({ items: [], generation: 0 })
  useLintStore.setState({ items: [], generation: 0 })
})

describe("hydrateProjectSideStores — delayed same-project mutations", () => {
  it("keeps ingest-added reviews and still applies the disk snapshot", async () => {
    const disk = review("from-disk")
    const reviewLoad = createDeferred<ReviewItem[]>()
    loadReviewItems.mockReturnValueOnce(reviewLoad.promise)

    const baseline = snapshotReviewHydration()
    const pending = hydrateProjectSideStores(PROJECT, { review: baseline })
    await flushMicrotasks()

    useReviewStore.getState().addItem({
      type: "missing-page",
      title: "from-ingest",
      description: "live",
      options: [],
    })
    const liveId = reviewIdFor({ type: "missing-page", title: "from-ingest" })

    reviewLoad.resolve([disk])
    await pending

    const titles = useReviewStore.getState().items.map((item) => item.title).sort()
    expect(titles).toEqual(["from-disk", "from-ingest"])
    expect(useReviewStore.getState().items.some((item) => item.id === liveId)).toBe(true)
  })

  it("does not revert a resolve that landed while review.json was loading", async () => {
    const item = review("Attention")
    useReviewStore.getState().setItems([item])
    const reviewLoad = createDeferred<ReviewItem[]>()
    loadReviewItems.mockReturnValueOnce(reviewLoad.promise)

    const baseline = snapshotReviewHydration()
    const pending = hydrateProjectSideStores(PROJECT, { review: baseline })
    await flushMicrotasks()

    useReviewStore.getState().resolveItem(item.id, "user-resolved")
    reviewLoad.resolve([{ ...item, resolved: false }])
    await pending

    const loaded = useReviewStore.getState().items
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(item.id)
    expect(loaded[0].resolved).toBe(true)
    expect(loaded[0].resolvedAction).toBe("user-resolved")
  })

  it("does not resurrect a review dismissed during load; still adds unseen disk items", async () => {
    const keep = review("keep")
    const gone = review("gone")
    const extra = review("extra")
    useReviewStore.getState().setItems([keep, gone])
    const reviewLoad = createDeferred<ReviewItem[]>()
    loadReviewItems.mockReturnValueOnce(reviewLoad.promise)

    const baseline = snapshotReviewHydration()
    const pending = hydrateProjectSideStores(PROJECT, { review: baseline })
    await flushMicrotasks()

    useReviewStore.getState().dismissItem(gone.id)
    reviewLoad.resolve([keep, gone, extra])
    await pending

    const titles = useReviewStore.getState().items.map((item) => item.title).sort()
    expect(titles).toEqual(["extra", "keep"])
    expect(useReviewStore.getState().items.some((item) => item.id === gone.id)).toBe(false)
  })

  it("keeps lint items added during load and does not restore a removed one", async () => {
    const keep = lint("lint-1", "keep.md")
    const gone = lint("lint-2", "gone.md")
    const extra = lint("lint-80", "extra.md")
    useLintStore.getState().setItems([keep, gone])
    const lintLoad = createDeferred<LintItem[]>()
    loadLintItems.mockReturnValueOnce(lintLoad.promise)

    const baseline = snapshotLintHydration()
    const pending = hydrateLintItems(PROJECT, baseline)
    await flushMicrotasks()

    useLintStore.getState().removeItem(gone.id)
    useLintStore.getState().addItems([lintResult("live.md")])
    lintLoad.resolve([keep, gone, extra])
    await pending

    const pages = useLintStore.getState().items.map((item) => item.page).sort()
    expect(pages).toEqual(["extra.md", "keep.md", "live.md"])
    expect(useLintStore.getState().items.some((item) => item.id === gone.id)).toBe(false)
  })

  it("does not apply a snapshot after the project has changed", async () => {
    const reviewLoad = createDeferred<ReviewItem[]>()
    loadReviewItems.mockReturnValueOnce(reviewLoad.promise)

    const pending = hydrateProjectSideStores(PROJECT, { review: snapshotReviewHydration() })
    await flushMicrotasks()
    useWikiStore.setState({ project: OTHER })
    reviewLoad.resolve([review("stale")])
    await pending

    expect(useReviewStore.getState().items).toEqual([])
  })

  it("replaces the empty post-reset store with the disk snapshot when nothing mutated", async () => {
    const disk = review("only-disk")
    loadReviewItems.mockResolvedValueOnce([disk])

    await hydrateProjectSideStores(PROJECT, { review: snapshotReviewHydration() })

    expect(useReviewStore.getState().items.map((item) => item.title)).toEqual(["only-disk"])
  })
})
