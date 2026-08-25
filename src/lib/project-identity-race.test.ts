/**
 * Parallel first-open used to mint two UUIDs for one project: both callers
 * observed a missing `.llm-wiki/project.json`, both wrote, and queues /
 * the global registry could split across the two ids.
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

import { ensureProjectId } from "./project-identity"
import { __resetProjectLocksForTesting } from "./project-mutex"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROJECT = "/tmp/wiki-project"
const IDENTITY = `${PROJECT}/.llm-wiki/project.json`

afterEach(() => {
  __resetProjectLocksForTesting()
  fsMocks.readFile.mockReset()
  fsMocks.writeFile.mockReset()
})

describe("ensureProjectId concurrent first-open", () => {
  it("returns one UUID when two callers observe a missing identity file together", async () => {
    const files = new Map<string, string>()
    const firstReadStarted = createDeferred<void>()
    const releaseFirstRead = createDeferred<void>()
    let identityReads = 0

    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p !== IDENTITY) throw new Error(`unexpected read: ${p}`)
      identityReads += 1
      const snapshot = files.get(p)
      if (identityReads === 1) {
        firstReadStarted.resolve()
        await releaseFirstRead.promise
      }
      if (snapshot === undefined) throw new Error("missing identity")
      return snapshot
    })
    fsMocks.writeFile.mockImplementation(async (p: string, content: string) => {
      files.set(p, content)
    })

    const first = ensureProjectId(PROJECT)
    await firstReadStarted.promise
    const second = ensureProjectId(PROJECT)
    await flushMicrotasks()
    releaseFirstRead.resolve()

    const [idA, idB] = await Promise.all([first, second])
    expect(idA).toBe(idB)
    expect(idA).toMatch(UUID_RE)
    expect(JSON.parse(files.get(IDENTITY)!).id).toBe(idA)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })
})
