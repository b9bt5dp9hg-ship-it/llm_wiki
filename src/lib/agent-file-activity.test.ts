import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockReadFile, mockWriteFile, mockDeleteFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockDeleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
}))

import {
  groupAgentFileChanges,
  mergeAgentFileChange,
  summarizeAgentFileChange,
  undoAgentFileChange,
} from "@/lib/agent-file-activity"
import type { ChatAgentFileChange } from "@/lib/chat-agent-types"

const here = dirname(fileURLToPath(import.meta.url))
const PROJECT = "/Users/me/MyWiki"

function change(overrides: Partial<ChatAgentFileChange> = {}): ChatAgentFileChange {
  return {
    id: "run:file",
    path: `${PROJECT}/wiki/page.md`,
    tool: "wiki.write_page",
    operation: "modified",
    additions: 1,
    deletions: 1,
    diff: "-old\n+new",
    timestamp: 1,
    beforeContent: "old",
    afterContent: "new",
    ...overrides,
  }
}

describe("agent file activity", () => {
  it("summarizes a created file", () => {
    const change = summarizeAgentFileChange({
      id: "run:file",
      path: "/project/agent-workspace/file.md",
      tool: "workspace.write_file",
      beforeContent: null,
      afterContent: "one\ntwo",
      timestamp: 1,
    })
    expect(change.operation).toBe("created")
    expect(change.additions).toBe(2)
    expect(change.deletions).toBe(0)
    expect(change.diff).toContain("+one")
  })

  it("keeps unchanged prefix and suffix outside the displayed hunk", () => {
    const change = summarizeAgentFileChange({
      id: "run:file",
      path: "/project/wiki/page.md",
      tool: "wiki.write_page",
      beforeContent: "head\nold\ntail",
      afterContent: "head\nnew\ntail",
    })
    expect(change.additions).toBe(1)
    expect(change.deletions).toBe(1)
    expect(change.diff).toContain("-old\n+new")
    expect(change.diff).not.toContain(" head")
  })

  it("preserves the first rollback snapshot when writes are coalesced", () => {
    const first = summarizeAgentFileChange({
      id: "first",
      path: "/project/file",
      tool: "workspace.write_file",
      beforeContent: "original",
      afterContent: "middle",
    })
    const second = summarizeAgentFileChange({
      id: "second",
      path: "/project/file",
      tool: "workspace.append_file",
      beforeContent: "middle",
      afterContent: "middle\nend",
    })
    const merged = mergeAgentFileChange(first, second)
    expect(merged.id).toBe("first")
    expect(merged.beforeContent).toBe("original")
    expect(merged.afterContent).toBe("middle\nend")
  })

  it("groups repeated edits by file while preserving execution order", () => {
    const first = summarizeAgentFileChange({
      id: "1",
      path: "/project/wiki/a.md",
      tool: "wiki.write_page",
      beforeContent: "old",
      afterContent: "new",
      timestamp: 1,
    })
    const second = summarizeAgentFileChange({
      id: "2",
      path: "/project/wiki/b.md",
      tool: "workspace.write_file",
      beforeContent: null,
      afterContent: "b",
      timestamp: 2,
    })
    const third = summarizeAgentFileChange({
      id: "3",
      path: "/project/wiki/a.md",
      tool: "wiki.write_page",
      beforeContent: "new",
      afterContent: "newer\nline",
      timestamp: 3,
    })

    const groups = groupAgentFileChanges([first, second, third])

    expect(groups.map((group) => group.path)).toEqual([
      "/project/wiki/a.md",
      "/project/wiki/b.md",
    ])
    expect(groups[0].edits.map((edit) => edit.id)).toEqual(["1", "3"])
    expect(groups[0].additions).toBe(first.additions + third.additions)
    expect(groups[0].deletions).toBe(first.deletions + third.deletions)
  })
})

describe("undoAgentFileChange path confinement", () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockDeleteFile.mockReset()
    mockReadFile.mockResolvedValue("new")
    mockWriteFile.mockResolvedValue(undefined)
    mockDeleteFile.mockResolvedValue(undefined)
  })

  it("does not write or delete a path outside the project", async () => {
    await expect(
      undoAgentFileChange(PROJECT, change({ path: "/etc/passwd" })),
    ).rejects.toThrow(/outside the project/i)

    expect(mockReadFile).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })

  it("does not follow .. into .llm-wiki or a sibling of the project", async () => {
    await expect(
      undoAgentFileChange(
        PROJECT,
        change({ path: `${PROJECT}/wiki/../.llm-wiki/project.json` }),
      ),
    ).rejects.toThrow(/outside the project/i)
    await expect(
      undoAgentFileChange(
        PROJECT,
        change({ path: `${PROJECT}/../OtherWiki/wiki/page.md` }),
      ),
    ).rejects.toThrow(/outside the project/i)

    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })

  it("restores an in-project wiki page through the confined path", async () => {
    mockReadFile.mockResolvedValueOnce("new")

    await undoAgentFileChange(PROJECT, change({ path: "wiki/page.md" }))

    expect(mockReadFile).toHaveBeenCalledWith(`${PROJECT}/wiki/page.md`)
    expect(mockWriteFile).toHaveBeenCalledWith(`${PROJECT}/wiki/page.md`, "old")
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })

  it("deletes an in-project created file through the confined path", async () => {
    mockReadFile.mockResolvedValueOnce("created")

    await undoAgentFileChange(
      PROJECT,
      change({
        path: `${PROJECT}/agent-workspace/note.md`,
        operation: "created",
        beforeContent: null,
        afterContent: "created",
      }),
    )

    expect(mockDeleteFile).toHaveBeenCalledWith(`${PROJECT}/agent-workspace/note.md`)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it("does not write when the on-disk snapshot no longer matches", async () => {
    mockReadFile.mockResolvedValueOnce("changed-since-agent-wrote")

    await expect(undoAgentFileChange(PROJECT, change())).rejects.toThrow(/conflict/i)

    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })
})

describe("agent file activity UI path confinement", () => {
  it("undoes and opens files only after confineProjectFilePath", () => {
    const source = readFileSync(join(here, "../components/chat/agent-file-activity.tsx"), "utf8")
    expect(source).toMatch(/undoAgentFileChange\(/)
    expect(source).toMatch(/confineProjectFilePath\(/)
    expect(source).not.toMatch(/await deleteFile\(change\.path\)/)
    expect(source).not.toMatch(/await writeFile\(change\.path,/)
    expect(source).not.toMatch(/void readFile\(group\.path\)/)
  })
})
