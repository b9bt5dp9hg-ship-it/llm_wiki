import assert from "node:assert/strict"
import { test } from "node:test"
import type { ApiPageEmbeddingResult } from "../src/api-client.js"
import { EmbeddingJobStore } from "../src/embedding-jobs.js"

const result: ApiPageEmbeddingResult = {
  path: "wiki/codex-worklog.md",
  pageId: "codex-worklog",
  revision: "sha256:abc",
  chunks: 400,
  vectorsWritten: 400,
  status: "indexed",
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test("embedding jobs return immediately and expose the completed result by polling", async () => {
  let resolveRun!: (value: ApiPageEmbeddingResult) => void
  const run = new Promise<ApiPageEmbeddingResult>((resolve) => {
    resolveRun = resolve
  })
  const store = new EmbeddingJobStore(() => "job-1", () => new Date("2026-08-31T20:00:00.000Z"))

  const started = store.start("project-a", result.path, false, () => run)
  assert.equal(started.status, "running")
  assert.equal(started.jobId, "job-1")
  assert.equal(started.result, undefined)

  resolveRun(result)
  await nextTurn()

  const completed = store.get("job-1")
  assert.equal(completed?.status, "completed")
  assert.deepEqual(completed?.result, result)
  assert.equal(completed?.completedAt, "2026-08-31T20:00:00.000Z")
})

test("embedding jobs coalesce concurrent requests for the same project and path", () => {
  let ids = 0
  let runs = 0
  const pending = new Promise<ApiPageEmbeddingResult>(() => {})
  const store = new EmbeddingJobStore(
    () => `job-${++ids}`,
    () => new Date("2026-08-31T20:00:00.000Z"),
  )
  const run = () => {
    runs++
    return pending
  }

  const first = store.start("project-a", result.path, false, run)
  // A force request cannot safely overtake an active non-force write for the
  // same page. It deliberately joins that job; force applies to the next job.
  const second = store.start("project-a", result.path, true, run)

  assert.equal(first.jobId, "job-1")
  assert.equal(second.jobId, first.jobId)
  assert.equal(second.force, false)
  assert.equal(ids, 1)
  assert.equal(runs, 1)
})

test("embedding job failures remain pollable instead of becoming unhandled rejections", async () => {
  const store = new EmbeddingJobStore(() => "job-failed")
  store.start("project-a", result.path, false, async () => {
    throw new Error("provider unavailable")
  })

  await nextTurn()

  const failed = store.get("job-failed")
  assert.equal(failed?.status, "failed")
  assert.equal(failed?.error, "provider unavailable")
})

test("embedding jobs prune the oldest completed snapshot at the retention bound", async () => {
  let ids = 0
  let clock = 0
  const store = new EmbeddingJobStore(
    () => `job-${++ids}`,
    () => new Date(Date.UTC(2026, 7, 31, 20, 0, clock++)),
    2,
  )

  store.start("project-a", "wiki/one.md", false, async () => ({ ...result, path: "wiki/one.md" }))
  await nextTurn()
  store.start("project-a", "wiki/two.md", false, async () => ({ ...result, path: "wiki/two.md" }))
  await nextTurn()
  store.start("project-a", "wiki/three.md", false, async () => ({ ...result, path: "wiki/three.md" }))

  assert.equal(store.get("job-1"), undefined)
  assert.equal(store.get("job-2")?.status, "completed")
  assert.equal(store.get("job-3")?.status, "running")
})
