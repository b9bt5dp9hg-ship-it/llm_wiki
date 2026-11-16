import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const panel = readFileSync(new URL("./activity-panel.tsx", import.meta.url), "utf8")

describe("ActivityPanel file-sync actions", () => {
  it("routes manual rescans through the project-aware file-sync coordinator", () => {
    expect(panel).toContain("rescanProjectFileSync(project")
    expect(panel).not.toMatch(/\brescanProjectFiles\(project\.id/)
  })
})
