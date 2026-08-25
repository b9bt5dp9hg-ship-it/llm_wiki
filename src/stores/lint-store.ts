import { create } from "zustand"
import type { LintResult } from "@/lib/lint"

export interface LintItem {
  id: string
  type: LintResult["type"]
  severity: LintResult["severity"]
  page: string
  detail: string
  affectedPages?: string[]
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
  createdAt: number
}

const LINT_TYPES = new Set<LintResult["type"]>(["orphan", "broken-link", "no-outlinks", "semantic"])
const LINT_SEVERITIES = new Set<LintResult["severity"]>(["warning", "info"])

/**
 * Coerce persisted lint.json into LintItem[]. A non-array document or a
 * truncated write must not reach the store — lint-view maps/filters
 * `items` and would throw on null entries or a bare object.
 */
export function normalizeLintItems(value: unknown): LintItem[] {
  if (!Array.isArray(value)) return []
  const items: LintItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== "string" || !item.id) continue
    if (typeof item.type !== "string" || !LINT_TYPES.has(item.type as LintResult["type"])) continue
    if (typeof item.severity !== "string" || !LINT_SEVERITIES.has(item.severity as LintResult["severity"])) continue
    if (typeof item.page !== "string" || typeof item.detail !== "string") continue
    if (typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) continue
    const normalized: LintItem = {
      id: item.id,
      type: item.type as LintResult["type"],
      severity: item.severity as LintResult["severity"],
      page: item.page,
      detail: item.detail,
      createdAt: item.createdAt,
    }
    if (Array.isArray(item.affectedPages)) {
      const pages = item.affectedPages.filter((page): page is string => typeof page === "string")
      if (pages.length > 0) normalized.affectedPages = pages
    }
    if (typeof item.brokenTarget === "string") normalized.brokenTarget = item.brokenTarget
    if (typeof item.suggestedTarget === "string") normalized.suggestedTarget = item.suggestedTarget
    if (typeof item.suggestedSource === "string") normalized.suggestedSource = item.suggestedSource
    items.push(normalized)
  }
  return items
}

function lintResultToItem(result: LintResult): LintItem {
  return {
    type: result.type,
    severity: result.severity,
    page: result.page,
    detail: result.detail,
    affectedPages: result.affectedPages,
    brokenTarget: result.brokenTarget,
    suggestedTarget: result.suggestedTarget,
    suggestedSource: result.suggestedSource,
    id: `lint-${++counter}`,
    createdAt: Date.now(),
  }
}

function syncCounterFromItems(items: readonly LintItem[]): void {
  for (const item of items) {
    const match = /^lint-(\d+)$/.exec(item.id)
    if (!match) continue
    const idNumber = Number(match[1])
    if (Number.isFinite(idNumber) && idNumber > counter) {
      counter = idNumber
    }
  }
}

interface LintState {
  items: LintItem[]
  /** Increments on every store mutation so delayed disk loads can detect races. */
  generation: number
  setItems: (items: LintItem[]) => void
  addItems: (results: LintResult[]) => void
  removeItem: (id: string) => void
  removeItems: (ids: string[]) => void
  clearItems: () => void
}

let counter = 0

export const useLintStore = create<LintState>((set) => ({
  items: [],
  generation: 0,

  setItems: (items) => {
    syncCounterFromItems(items)
    set((state) => ({ items, generation: state.generation + 1 }))
  },

  addItems: (results) =>
    set((state) => ({
      items: [...state.items, ...results.map(lintResultToItem)],
      generation: state.generation + 1,
    })),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      generation: state.generation + 1,
    })),

  removeItems: (ids) =>
    set((state) => {
      const remove = new Set(ids)
      return {
        items: state.items.filter((item) => !remove.has(item.id)),
        generation: state.generation + 1,
      }
    }),

  clearItems: () => set((state) => ({ items: [], generation: state.generation + 1 })),
}))
