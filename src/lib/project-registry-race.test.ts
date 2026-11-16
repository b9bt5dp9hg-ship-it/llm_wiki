/**
 * Concurrent open/create used to drop the other project's registry entry:
 * both callers read `projectRegistry`, each wrote only its own id, and the
 * later set replaced the earlier one.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"

const storeState = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
  getCount: 0,
  delayFirstGet: false,
  firstGetStarted: {
    resolve: () => {},
    promise: Promise.resolve(),
  },
  releaseFirstGet: {
    resolve: () => {},
    promise: Promise.resolve(),
  },
}))

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    async get(key: string) {
      storeState.getCount += 1
      if (storeState.delayFirstGet && storeState.getCount === 1) {
        storeState.firstGetStarted.resolve()
        await storeState.releaseFirstGet.promise
      }
      const value = storeState.memory.get(key)
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    },
    async set(key: string, value: unknown) {
      storeState.memory.set(key, value)
    },
  })),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

import { upsertProjectInfo } from "./project-identity"
import { __resetProjectLocksForTesting } from "./project-mutex"

afterEach(() => {
  __resetProjectLocksForTesting()
  storeState.memory.clear()
  storeState.getCount = 0
  storeState.delayFirstGet = false
})

describe("upsertProjectInfo concurrent registry writes", () => {
  it("keeps both project entries when two opens overlap on a stale snapshot", async () => {
    const firstGetStarted = createDeferred<void>()
    const releaseFirstGet = createDeferred<void>()
    storeState.firstGetStarted = firstGetStarted
    storeState.releaseFirstGet = releaseFirstGet
    storeState.delayFirstGet = true

    const first = upsertProjectInfo("id-a", "/tmp/wiki-a", "Alpha")
    await firstGetStarted.promise
    const second = upsertProjectInfo("id-b", "/tmp/wiki-b", "Beta")
    await flushMicrotasks()
    releaseFirstGet.resolve()

    await Promise.all([first, second])

    const registry = storeState.memory.get("projectRegistry") as Record<string, {
      id: string
      path: string
      name: string
    }>
    expect(registry["id-a"]).toMatchObject({
      id: "id-a",
      path: "/tmp/wiki-a",
      name: "Alpha",
    })
    expect(registry["id-b"]).toMatchObject({
      id: "id-b",
      path: "/tmp/wiki-b",
      name: "Beta",
    })
  })
})
