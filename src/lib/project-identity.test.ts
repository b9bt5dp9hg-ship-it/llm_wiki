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
})
