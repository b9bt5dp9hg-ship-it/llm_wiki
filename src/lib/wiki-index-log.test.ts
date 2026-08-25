/**
 * Concurrent Save-to-Wiki / review creates used to drop the other page's
 * index link and log line: both callers read the same snapshot, each wrote
 * only its own entry, and the later write replaced the earlier one.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

import { appendWikiIndexAndLog } from "./wiki-index-log"
import { __resetProjectLocksForTesting } from "./project-mutex"

const PROJECT = "/tmp/wiki-project"
const INDEX = `${PROJECT}/wiki/index.md`
const LOG = `${PROJECT}/wiki/log.md`

afterEach(() => {
  __resetProjectLocksForTesting()
  fsMocks.readFile.mockReset()
  fsMocks.writeFile.mockReset()
})

describe("appendWikiIndexAndLog concurrent writes", () => {
  it("keeps both index links and log lines when two saves overlap on a stale snapshot", async () => {
    const files = new Map<string, string>([
      [INDEX, "# Wiki Index\n\n## Queries\n"],
      [LOG, "# Wiki Log\n"],
    ])
    const firstIndexReadStarted = createDeferred<void>()
    const releaseFirstIndexRead = createDeferred<void>()
    let indexReads = 0

    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === INDEX) {
        indexReads += 1
        const snapshot = files.get(path) ?? "# Wiki Index\n"
        if (indexReads === 1) {
          firstIndexReadStarted.resolve()
          await releaseFirstIndexRead.promise
        }
        return snapshot
      }
      if (path === LOG) return files.get(path) ?? "# Wiki Log\n"
      throw new Error(`unexpected read: ${path}`)
    })
    fsMocks.writeFile.mockImplementation(async (path: string, content: string) => {
      files.set(path, content)
    })

    const first = appendWikiIndexAndLog(
      PROJECT,
      [{ sectionHeader: "## Queries", line: "- [[queries/alpha|Alpha]]" }],
      "- 2026-08-25: Saved query page `alpha.md`",
    )
    await firstIndexReadStarted.promise
    const second = appendWikiIndexAndLog(
      PROJECT,
      [{ sectionHeader: "## Queries", line: "- [[queries/beta|Beta]]" }],
      "- 2026-08-25: Saved query page `beta.md`",
    )
    await flushMicrotasks()
    releaseFirstIndexRead.resolve()

    await Promise.all([first, second])

    const index = files.get(INDEX) ?? ""
    expect(index).toContain("- [[queries/alpha|Alpha]]")
    expect(index).toContain("- [[queries/beta|Beta]]")

    const log = files.get(LOG) ?? ""
    expect(log).toContain("Saved query page `alpha.md`")
    expect(log).toContain("Saved query page `beta.md`")
  })

  it("creates missing index and log files and inserts a new section", async () => {
    const files = new Map<string, string>()

    fsMocks.readFile.mockImplementation(async (path: string) => {
      const snapshot = files.get(path)
      if (snapshot === undefined) throw new Error("missing")
      return snapshot
    })
    fsMocks.writeFile.mockImplementation(async (path: string, content: string) => {
      files.set(path, content)
    })

    await appendWikiIndexAndLog(
      PROJECT,
      [{ sectionHeader: "## Entities", line: "- [[entities/widget|Widget]]" }],
      "- 2026-08-25: Created 1 page from review: `widget.md`",
    )

    expect(files.get(INDEX)).toContain("## Entities")
    expect(files.get(INDEX)).toContain("- [[entities/widget|Widget]]")
    expect(files.get(LOG)).toContain("Created 1 page from review: `widget.md`")
  })
})
