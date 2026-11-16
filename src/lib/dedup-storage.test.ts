/**
 * Concurrent "not duplicates" whitelist updates used to drop the other
 * group: both callers read the same snapshot, each wrote only its own
 * pair, and the later write replaced the earlier one.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

import { addNotDuplicate } from "./dedup-storage"
import { __resetProjectLocksForTesting } from "./project-mutex"

const PROJECT = "/tmp/wiki-dedup"
const FILE = `${PROJECT}/.llm-wiki/dedup-not-duplicates.json`

afterEach(() => {
  __resetProjectLocksForTesting()
  fsMocks.fileExists.mockReset()
  fsMocks.readFile.mockReset()
  fsMocks.writeFile.mockReset()
})

describe("addNotDuplicate concurrent whitelist writes", () => {
  it("keeps both groups when two decisions overlap on a stale snapshot", async () => {
    const files = new Map<string, string>()
    const firstExistsStarted = createDeferred<void>()
    const releaseFirstExists = createDeferred<void>()
    let existsCalls = 0

    fsMocks.fileExists.mockImplementation(async (path: string) => {
      existsCalls += 1
      const exists = files.has(path)
      if (existsCalls === 1) {
        firstExistsStarted.resolve()
        await releaseFirstExists.promise
      }
      return exists
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const snapshot = files.get(path)
      if (snapshot === undefined) throw new Error(`missing: ${path}`)
      return snapshot
    })
    fsMocks.writeFile.mockImplementation(async (path: string, content: string) => {
      files.set(path, content)
    })

    const first = addNotDuplicate(PROJECT, ["alpha", "beta"])
    await firstExistsStarted.promise
    const second = addNotDuplicate(PROJECT, ["gamma", "delta"])
    await flushMicrotasks()
    releaseFirstExists.resolve()

    await Promise.all([first, second])

    const parsed = JSON.parse(files.get(FILE) ?? "[]") as string[][]
    const keys = parsed.map((group) =>
      [...group].map((s) => s.toLowerCase()).sort().join(","),
    )
    expect(keys).toEqual(expect.arrayContaining(["alpha,beta", "delta,gamma"]))
    expect(keys).toHaveLength(2)
  })
})
