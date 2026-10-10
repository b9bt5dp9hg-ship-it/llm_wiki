import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { queueResearchBatch } from "./deep-research"
import { useResearchStore } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"

const search = vi.hoisted(() => vi.fn())
vi.mock("./web-search", async (original) => ({
  ...await original<typeof import("./web-search")>(), webSearch: search,
}))

beforeEach(() => {
  vi.useFakeTimers()
  useResearchStore.setState({ ...useResearchStore.getInitialState(), tasks: [] })
  useWikiStore.setState({ project: { id: "test", name: "Test", path: "/project" } })
  search.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  useResearchStore.setState({ tasks: [] })
  useWikiStore.setState({ project: null })
})

it("keeps a burst queued and advances in order after each research finishes", async () => {
  let release!: () => void
  const first = new Promise<void>((resolve) => { release = resolve })
  search.mockImplementation(async (query: string) => {
    if (query === "first") await first
    return []
  })
  const ids = queueResearchBatch("/project", [
    { topic: "first" }, { topic: "second" }, { topic: "third" },
  ], useWikiStore.getState().llmConfig, {
    provider: "searxng", apiKey: "", searXngUrl: "http://localhost:19829",
  })
  await vi.advanceTimersByTimeAsync(50)
  expect(useResearchStore.getState().tasks.map((t) => t.status))
    .toEqual(["searching", "queued", "queued"])
  expect(search.mock.calls.map((args) => args[0])).toEqual(["first"])
  release()
  await vi.runAllTimersAsync()
  expect(search.mock.calls.map((args) => args[0])).toEqual(["first", "second", "third"])
  expect(useResearchStore.getState().tasks.filter((t) => ids.includes(t.id)).every((t) => t.status === "done")).toBe(true)
})
