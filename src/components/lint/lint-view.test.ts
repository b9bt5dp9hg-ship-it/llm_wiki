import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { groupLintResultsForDisplay, resolveLintWikiFilePath, shouldShowLintResults } from "./lint-view"
import type { LintItem } from "@/stores/lint-store"

const lintViewSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "lint-view.tsx"),
  "utf8",
)

function makeLintItem(
  page: string,
  severity: "warning" | "info",
  index: number,
): LintItem {
  return {
    id: `lint-${index}`,
    type: severity === "warning" ? "broken-link" : "orphan",
    severity,
    page,
    detail: `${page} detail`,
    createdAt: Date.now(),
  }
}

describe("groupLintResultsForDisplay", () => {
  it("groups warnings and infos separately", () => {
    const items: LintItem[] = [
      makeLintItem("info-a.md", "info", 0),
      makeLintItem("warning-b.md", "warning", 1),
      makeLintItem("info-c.md", "info", 2),
      makeLintItem("warning-d.md", "warning", 3),
    ]

    const grouped = groupLintResultsForDisplay(items)

    expect(grouped.warnings.map((item) => item.page)).toEqual([
      "warning-b.md",
      "warning-d.md",
    ])
    expect(grouped.infos.map((item) => item.page)).toEqual([
      "info-a.md",
      "info-c.md",
    ])
  })
})

describe("shouldShowLintResults", () => {
  it("shows restored persisted lint items before a new run in the current view", () => {
    expect(shouldShowLintResults(false, 2)).toBe(true)
  })

  it("keeps the first-run empty prompt when no run has happened and nothing was restored", () => {
    expect(shouldShowLintResults(false, 0)).toBe(false)
  })

  it("shows the all-clear state after a run with no items", () => {
    expect(shouldShowLintResults(true, 0)).toBe(true)
  })
})

describe("resolveLintWikiFilePath", () => {
  const PROJECT = "/Users/me/MyWiki"

  it("accepts an in-wiki markdown page, relative or already absolute", () => {
    expect(resolveLintWikiFilePath(PROJECT, "entities/transformer.md")).toBe(
      `${PROJECT}/wiki/entities/transformer.md`,
    )
    expect(resolveLintWikiFilePath(PROJECT, `${PROJECT}/wiki/queries/saved.md`)).toBe(
      `${PROJECT}/wiki/queries/saved.md`,
    )
  })

  it("rejects a poisoned lint.json page that leaves wiki/", () => {
    expect(resolveLintWikiFilePath(PROJECT, "../.llm-wiki/project.json")).toBeNull()
    expect(resolveLintWikiFilePath(PROJECT, "../.llm-wiki/secret.md")).toBeNull()
    expect(resolveLintWikiFilePath(PROJECT, "/etc/passwd.md")).toBeNull()
    expect(resolveLintWikiFilePath(PROJECT, "../../etc/passwd.md")).toBeNull()
    expect(resolveLintWikiFilePath(PROJECT, "../raw/sources/paper.md")).toBeNull()
  })

  it("rejects non-string page fields", () => {
    expect(resolveLintWikiFilePath(PROJECT, null)).toBeNull()
    expect(resolveLintWikiFilePath(PROJECT, 1)).toBeNull()
  })
})

describe("lint-view file actions confine wiki paths", () => {
  it("does not join lint page fields under wiki/ without confinement", () => {
    expect(lintViewSource).not.toMatch(/\$\{pp\}\/wiki\/\$\{item\.(page|suggestedSource)\}/)
    expect(lintViewSource).toMatch(/resolveLintWikiFilePath\(/)
  })
})
