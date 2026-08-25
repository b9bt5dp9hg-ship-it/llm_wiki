import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { ensureProjectId, reissueImportedProjectIdentity } from "./project-identity"

const ORIGINAL_ID = "11111111-1111-4111-8111-111111111111"
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("import-identity")
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("reissueImportedProjectIdentity", () => {
  it("replaces a cloned archive identity instead of reusing the source UUID", async () => {
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/project.json`,
      JSON.stringify({ id: ORIGINAL_ID, createdAt: 123 }, null, 2),
    )
    await writeFileRaw(`${tmp.path}/.llm-wiki/ingest-cache.json`, "{}")

    expect(await ensureProjectId(tmp.path)).toBe(ORIGINAL_ID)

    const issued = await reissueImportedProjectIdentity(tmp.path)
    expect(issued).not.toBe(ORIGINAL_ID)
    expect(issued).toMatch(UUID_RE)

    const onDisk = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/project.json`)) as {
      id: string
      createdAt: number
    }
    expect(onDisk.id).toBe(issued)
    expect(onDisk.createdAt).not.toBe(123)
    expect(await ensureProjectId(tmp.path)).toBe(issued)
    expect(await readFileRaw(`${tmp.path}/.llm-wiki/ingest-cache.json`)).toBe("{}")
  })

  it("rewrites cloned queue project ids so the source UUID does not remain in the copy", async () => {
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/project.json`,
      JSON.stringify({ id: ORIGINAL_ID, createdAt: 123 }, null, 2),
    )
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/ingest-queue.json`,
      JSON.stringify(
        [
          {
            id: "ingest-1",
            projectId: ORIGINAL_ID,
            project_id: ORIGINAL_ID,
            sourcePath: "raw/sources/paper.pdf",
            folderContext: "papers",
            status: "pending",
            addedAt: 1,
            error: null,
            retryCount: 0,
          },
        ],
        null,
        2,
      ),
    )
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/dedup-queue.json`,
      JSON.stringify(
        [
          {
            id: "dedup-1",
            projectId: ORIGINAL_ID,
            group: { slugs: ["a", "b"] },
            canonicalSlug: "a",
            status: "pending",
            addedAt: 2,
            error: null,
            retryCount: 0,
          },
        ],
        null,
        2,
      ),
    )
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/file-change-queue.json`,
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: "change-1",
              projectId: ORIGINAL_ID,
              path: "raw/sources/paper.pdf",
              kind: "created",
              status: "pending",
            },
          ],
        },
        null,
        2,
      ),
    )

    const issued = await reissueImportedProjectIdentity(tmp.path)
    expect(issued).not.toBe(ORIGINAL_ID)

    const ingest = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/ingest-queue.json`)) as Array<{
      id: string
      projectId: string
      sourcePath: string
    }>
    expect(ingest).toEqual([
      expect.objectContaining({
        id: "ingest-1",
        projectId: issued,
        sourcePath: "raw/sources/paper.pdf",
      }),
    ])
    expect(ingest[0]).not.toHaveProperty("project_id")

    const dedup = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/dedup-queue.json`)) as Array<{
      id: string
      projectId: string
      canonicalSlug: string
    }>
    expect(dedup).toEqual([
      expect.objectContaining({
        id: "dedup-1",
        projectId: issued,
        canonicalSlug: "a",
      }),
    ])

    const fileChange = JSON.parse(
      await readFileRaw(`${tmp.path}/.llm-wiki/file-change-queue.json`),
    ) as { version: number; tasks: Array<{ id: string; projectId: string; path: string }> }
    expect(fileChange.version).toBe(1)
    expect(fileChange.tasks).toEqual([
      expect.objectContaining({
        id: "change-1",
        projectId: issued,
        path: "raw/sources/paper.pdf",
      }),
    ])

    const leftover = [
      await readFileRaw(`${tmp.path}/.llm-wiki/ingest-queue.json`),
      await readFileRaw(`${tmp.path}/.llm-wiki/dedup-queue.json`),
      await readFileRaw(`${tmp.path}/.llm-wiki/file-change-queue.json`),
    ].join("\n")
    expect(leftover).not.toContain(ORIGINAL_ID)
  })
})
