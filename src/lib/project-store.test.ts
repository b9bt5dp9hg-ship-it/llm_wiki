import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"

const { memory, save, getHooks } = vi.hoisted(() => {
  const memory = new Map<string, unknown>()
  const save = vi.fn(async () => {})
  const getHooks = {
    afterRecentSnapshot: undefined as undefined | (() => Promise<void>),
  }
  return { memory, save, getHooks }
})

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    async get(key: string) {
      const value = memory.get(key)
      if (key === "recentProjects" && getHooks.afterRecentSnapshot) {
        await getHooks.afterRecentSnapshot()
      }
      return value
    },
    async set(key: string, value: unknown) {
      memory.set(key, value)
    },
    async delete(key: string) {
      memory.delete(key)
    },
    save,
  })),
}))

import {
  __projectStoreTest,
  getLastProject,
  getRecentProjects,
  removeFromRecentProjects,
} from "./project-store"

const KEEP = { id: "keep-id", name: "Keep", path: "/tmp/keep-wiki" }
const GONE = { id: "gone-id", name: "Gone", path: "/tmp/gone-wiki" }

describe("project-store MinerU config normalization", () => {
  it("preserves valid MinerU config values", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: true,
      backend: "local",
      localEndpoint: "http://localhost:9000/mineru",
      localToken: " local-secret ",
      localBackend: "pipeline",
      localEffort: "high",
      localParseMethod: "ocr",
      localLanguage: "korean",
      localFormulaEnabled: false,
      localTableEnabled: true,
      localImageAnalysis: false,
      localServerUrl: "http://localhost:30000",
      token: "token-123",
      modelVersion: "pipeline",
    })).toEqual({
      enabled: true,
      backend: "local",
      localEndpoint: "http://localhost:9000/mineru",
      localToken: "local-secret",
      localBackend: "pipeline",
      localEffort: "high",
      localParseMethod: "ocr",
      localLanguage: "korean",
      localFormulaEnabled: false,
      localTableEnabled: true,
      localImageAnalysis: false,
      localServerUrl: "http://localhost:30000",
      token: "token-123",
      modelVersion: "pipeline",
    })
  })

  it("migrates legacy and malformed MinerU config values to safe defaults", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: "yes" as unknown as boolean,
      token: 123 as unknown as string,
      modelVersion: "mineru-html" as "vlm",
    })).toEqual({
      enabled: false,
      backend: "cloud",
      localEndpoint: "http://127.0.0.1:8000",
      localToken: "",
      localBackend: "hybrid-engine",
      localEffort: "medium",
      localParseMethod: "auto",
      localLanguage: "ch",
      localFormulaEnabled: true,
      localTableEnabled: true,
      localImageAnalysis: true,
      localServerUrl: "",
      token: "",
      modelVersion: "vlm",
    })
  })
})

describe("project-store zoom normalization", () => {
  it("preserves valid zoom values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(0.5)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(1.25)).toBe(1.25)
    expect(__projectStoreTest.normalizeZoomLevel(3)).toBe(3)
  })

  it("clamps finite out-of-range values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(-2)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(0)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(0.49)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(3.01)).toBe(3)
  })

  it("falls back to 100% for malformed values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(undefined)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(null)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(Number.NaN)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(Number.POSITIVE_INFINITY)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel("150")).toBe(1)
  })
})

describe("project-store custom LLM preset normalization", () => {
  it("keeps valid unique presets and bounds labels", () => {
    const longLabel = "x".repeat(100)
    expect(__projectStoreTest.normalizeCustomLlmPresets([
      { id: "custom-one", label: " Team Gateway " },
      { id: "custom-one", label: "duplicate" },
      { id: "custom-two", label: longLabel },
      { id: "openai", label: "collision" },
      { id: "custom-empty", label: " " },
    ])).toEqual([
      { id: "custom-one", label: "Team Gateway" },
      { id: "custom-two", label: "x".repeat(80) },
    ])
  })
})

describe("removeFromRecentProjects durability", () => {
  beforeEach(() => {
    memory.clear()
    save.mockClear()
    getHooks.afterRecentSnapshot = undefined
    memory.set("recentProjects", [GONE, KEEP])
    memory.set("lastProject", GONE)
  })

  it("flushes the removal to disk instead of relying on the 100ms autoSave debounce", async () => {
    await removeFromRecentProjects(GONE.path)

    expect(await getRecentProjects()).toEqual([KEEP])
    expect(await getLastProject()).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("still force-saves when lastProject already points elsewhere", async () => {
    memory.set("lastProject", KEEP)

    await removeFromRecentProjects(GONE.path)

    expect(await getRecentProjects()).toEqual([KEEP])
    expect(await getLastProject()).toEqual(KEEP)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("does not restore a removed project when two removals overlap on a stale snapshot", async () => {
    const ALSO = { id: "also-id", name: "Also", path: "/tmp/also-wiki" }
    memory.set("recentProjects", [GONE, ALSO, KEEP])
    memory.set("lastProject", KEEP)

    const firstGetStarted = createDeferred<void>()
    const releaseFirstGet = createDeferred<void>()
    let recentGets = 0
    getHooks.afterRecentSnapshot = async () => {
      recentGets += 1
      if (recentGets === 1) {
        firstGetStarted.resolve()
        await releaseFirstGet.promise
      }
    }

    const first = removeFromRecentProjects(GONE.path)
    await firstGetStarted.promise
    const second = removeFromRecentProjects(ALSO.path)
    await flushMicrotasks()
    releaseFirstGet.resolve()
    await Promise.all([first, second])
    getHooks.afterRecentSnapshot = undefined

    expect(await getRecentProjects()).toEqual([KEEP])
  })
})
