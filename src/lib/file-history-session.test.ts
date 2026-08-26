import { describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import type { FileHistoryEntry } from "@/commands/fs"
import { createFileHistorySession } from "./file-history-session"

function entry(id: string): FileHistoryEntry {
  return { id, path: `/history/${id}`, timestamp: 1, author: "user", tool: "editor", content: id }
}

describe("createFileHistorySession", () => {
  it("drops a slower history list after a newer file request", async () => {
    const older = createDeferred<FileHistoryEntry[]>()
    const list = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce([entry("b")])
    const session = createFileHistorySession(list)

    const listA = session.list("/project", "/project/wiki/a.md")
    await flushMicrotasks()
    const listB = session.list("/project", "/project/wiki/b.md")
    await expect(listB).resolves.toMatchObject({ status: "applied", entries: [entry("b")] })

    older.resolve([entry("a")])
    await expect(listA).resolves.toMatchObject({ status: "stale" })
  })

  it("does not apply a restore after the active file was replaced", async () => {
    const restore = createDeferred<string>()
    const session = createFileHistorySession(vi.fn(), vi.fn(() => restore.promise))

    const pending = session.restore("/project", "/project/wiki/a.md", "revision-a")
    await flushMicrotasks()
    session.invalidate()
    restore.resolve("old A")

    await expect(pending).resolves.toMatchObject({ status: "stale" })
  })
})
