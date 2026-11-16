import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createTempProject,
  fileExists,
  readFileRaw,
  realFs,
  writeFileRaw,
} from "@/test-helpers/fs-temp"
import { createDeferred, flushIO, waitFor } from "@/test-helpers/deferred"
import { __resetProjectLocksForTesting } from "@/lib/project-mutex"

vi.mock("@/commands/fs", () => realFs)

vi.mock("./ingest", () => ({
  autoIngest: vi.fn(),
}))

vi.mock("./sweep-reviews", () => ({
  sweepResolvedReviews: vi.fn().mockResolvedValue(0),
}))

vi.mock("@/lib/embedding", () => ({
  removePageEmbedding: vi.fn().mockResolvedValue(undefined),
}))

const TEST_ID = "source-lifecycle-delete-project"
const pathByIdRef: { map: Record<string, string> } = { map: {} }
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => pathByIdRef.map[id] ?? null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import { deleteSourceFiles } from "./source-lifecycle"
import { autoIngest } from "./ingest"
import {
  checkIngestCache,
  saveIngestCache,
} from "./ingest-cache"
import {
  clearQueueState,
  enqueueIngest,
  getQueue,
  restoreQueue,
} from "./ingest-queue"
import { useWikiStore } from "@/stores/wiki-store"

const mockAutoIngest = vi.mocked(autoIngest)

describe("source lifecycle source deletion", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    clearQueueState()
    mockAutoIngest.mockReset()
    __resetProjectLocksForTesting()
    tmp = await createTempProject("source-lifecycle-delete")
    pathByIdRef.map = { [TEST_ID]: tmp.path }
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.yaml`, "name: alpha\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-b/config.yaml`, "name: beta\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/shared.md`,
      [
        "---",
        'sources: ["project-a/config.yaml", "project-b/config.yaml"]',
        "---",
        "# Shared",
      ].join("\n"),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/project-b-only.md`,
      [
        "---",
        'sources: ["project-b/config.yaml"]',
        "---",
        "# Project B",
      ].join("\n"),
    )
  })

  afterEach(async () => {
    clearQueueState()
    await flushIO(20)
    await tmp?.cleanup()
    tmp = undefined
  })

  it("does not remove path-aware source references that only share a basename", async () => {
    if (!tmp) throw new Error("missing temp project")

    const result = await deleteSourceFiles(
      tmp.path,
      [`${tmp.path}/raw/sources/project-a/config.yaml`],
      { fileAlreadyDeleted: true },
    )

    await expect(readFileRaw(`${tmp.path}/wiki/concepts/shared.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    await expect(readFileRaw(`${tmp.path}/wiki/concepts/project-b-only.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    expect(result.deletedWikiPaths).toEqual([])
    expect(result.rewrittenSourcePages).toBe(1)
  })

  it("does not let an in-flight ingest restore deleted wiki pages or cache", async () => {
    if (!tmp) throw new Error("missing temp project")
    const projectPath = tmp.path

    const resurrectedPage = "wiki/sources/resurrected.md"
    const sourcePath = `${projectPath}/raw/sources/project-a/config.yaml`
    await saveIngestCache(projectPath, "project-a/config.yaml", "name: alpha\n", [
      "wiki/concepts/shared.md",
    ])

    const ingest = createDeferred<string[]>()
    mockAutoIngest.mockImplementation(async (projectPath: string) => {
      const files = await ingest.promise
      for (const relativePath of files) {
        await writeFileRaw(
          `${projectPath}/${relativePath}`,
          "---\nsources: [\"project-a/config.yaml\"]\n---\n# Resurrected\n",
        )
      }
      await saveIngestCache(projectPath, "project-a/config.yaml", "name: alpha\n", files)
      return files
    })

    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    await restoreQueue(TEST_ID, projectPath)
    await enqueueIngest(TEST_ID, "raw/sources/project-a/config.yaml")
    await waitFor(() => getQueue().some((task) => task.status === "processing"))

    await deleteSourceFiles(projectPath, [sourcePath])

    expect(getQueue().some((task) => task.sourcePath.includes("project-a/config.yaml"))).toBe(false)
    expect(await fileExists(sourcePath)).toBe(false)
    expect(
      await checkIngestCache(projectPath, "project-a/config.yaml", "name: alpha\n"),
    ).toBeNull()

    ingest.resolve([resurrectedPage])
    const autoIngestResult = mockAutoIngest.mock.results[0]
    expect(autoIngestResult?.type).toBe("return")
    await autoIngestResult.value
    await waitFor(
      async () => !(await fileExists(`${projectPath}/${resurrectedPage}`)),
      400,
    )

    expect(
      await checkIngestCache(projectPath, "project-a/config.yaml", "name: alpha\n"),
    ).toBeNull()
    await expect(readFileRaw(`${projectPath}/wiki/concepts/shared.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    await expect(readFileRaw(`${projectPath}/wiki/concepts/shared.md`)).resolves.not.toContain(
      "project-a/config.yaml",
    )
    await flushIO(20)
  })
})
