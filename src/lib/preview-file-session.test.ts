/**
 * PreviewPanel issues a new readFile whenever selectedFile changes, but
 * used to apply whatever read finished last. Switching A → B while A's
 * read was still in flight put A's body into B's editor (and a later
 * auto-save could persist it onto B).
 */
import { describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { createPreviewFileSession } from "./preview-file-session"

describe("createPreviewFileSession", () => {
  it("does not apply a slower older file read after a newer file is selected", async () => {
    const older = createDeferred<string>()
    const readFile = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce("file B")

    const session = createPreviewFileSession(readFile)
    const loadA = session.load("/wiki/a.md")
    await flushMicrotasks()
    const loadB = session.load("/wiki/b.md")

    await expect(loadB).resolves.toMatchObject({
      status: "applied",
      path: "/wiki/b.md",
      content: "file B",
    })

    older.resolve("file A")
    await expect(loadA).resolves.toMatchObject({ status: "stale" })
  })

  it("treats clearing the selection as a newer request so in-flight reads cannot refill the editor", async () => {
    const older = createDeferred<string>()
    const readFile = vi.fn().mockImplementationOnce(() => older.promise)

    const session = createPreviewFileSession(readFile)
    const loadA = session.load("/wiki/a.md")
    await flushMicrotasks()
    const cleared = session.load(null)

    await expect(cleared).resolves.toMatchObject({ status: "cleared" })
    older.resolve("file A")
    await expect(loadA).resolves.toMatchObject({ status: "stale" })
  })

  it("drops in-flight results after invalidate", async () => {
    const older = createDeferred<string>()
    const readFile = vi.fn().mockImplementationOnce(() => older.promise)

    const session = createPreviewFileSession(readFile)
    const loadA = session.load("/wiki/a.md")
    await flushMicrotasks()
    session.invalidate()
    older.resolve("file A")
    await expect(loadA).resolves.toMatchObject({ status: "stale" })
  })

  it("does not surface a failure from a superseded file read", async () => {
    const older = createDeferred<string>()
    const readFile = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce("file B")

    const session = createPreviewFileSession(readFile)
    const loadA = session.load("/wiki/a.md")
    await flushMicrotasks()
    const loadB = session.load("/wiki/b.md")

    await expect(loadB).resolves.toMatchObject({ status: "applied", content: "file B" })
    older.reject(new Error("read timeout"))
    await expect(loadA).resolves.toMatchObject({ status: "stale" })
  })

  it("propagates a failure from the current file read", async () => {
    const readFile = vi.fn().mockRejectedValueOnce(new Error("missing"))
    const session = createPreviewFileSession(readFile)
    await expect(session.load("/wiki/missing.md")).rejects.toThrow("missing")
  })
})
