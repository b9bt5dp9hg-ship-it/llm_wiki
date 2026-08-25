/**
 * PreviewPanel issues a new readFile whenever selectedFile changes, but
 * used to apply whatever read finished last. Switching A → B while A's
 * read was still in flight put A's body into B's editor (and a later
 * auto-save could persist it onto B).
 *
 * Writes had the complementary race: a debounced V1 writeFile could still
 * be in flight when an immediate V2 save started. If V1 finished last it
 * rolled disk (and lastLoadedRef / fileContent) back to V1.
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

  it("does not let a slower older write persist after a newer save of the same file", async () => {
    const older = createDeferred<void>()
    let disk = "base"
    const writeFile = vi.fn((_path: string, content: string) => {
      if (content === "V1") {
        return older.promise.then(() => {
          disk = content
        })
      }
      disk = content
      return Promise.resolve()
    })

    const session = createPreviewFileSession(vi.fn(), writeFile)
    session.activate("/wiki/a.md")
    const writeV1 = session.write("/wiki/a.md", "V1")
    await flushMicrotasks()
    const writeV2 = session.write("/wiki/a.md", "V2")

    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(disk).toBe("base")

    older.resolve()
    await expect(writeV1).resolves.toMatchObject({ status: "stale" })
    await expect(writeV2).resolves.toMatchObject({
      status: "applied",
      path: "/wiki/a.md",
      content: "V2",
    })

    expect(writeFile).toHaveBeenNthCalledWith(1, "/wiki/a.md", "V1")
    expect(writeFile).toHaveBeenNthCalledWith(2, "/wiki/a.md", "V2")
    expect(disk).toBe("V2")
  })

  it("persists an in-flight write after switching files but does not apply it to the new editor", async () => {
    const older = createDeferred<void>()
    const written: Array<{ path: string; content: string }> = []
    const writeFile = vi.fn((path: string, content: string) => {
      if (path.endsWith("a.md") && content === "draft A") {
        return older.promise.then(() => {
          written.push({ path, content })
        })
      }
      written.push({ path, content })
      return Promise.resolve()
    })

    const session = createPreviewFileSession(vi.fn(), writeFile)
    session.activate("/wiki/a.md")
    const writeA = session.write("/wiki/a.md", "draft A")
    await flushMicrotasks()
    session.activate("/wiki/b.md")

    older.resolve()
    await expect(writeA).resolves.toMatchObject({ status: "stale" })
    expect(written).toEqual([{ path: "/wiki/a.md", content: "draft A" }])
  })

  it("does not surface a failure from a superseded file write", async () => {
    const older = createDeferred<void>()
    const writeFile = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(undefined)

    const session = createPreviewFileSession(vi.fn(), writeFile)
    session.activate("/wiki/a.md")
    const writeV1 = session.write("/wiki/a.md", "V1")
    await flushMicrotasks()
    const writeV2 = session.write("/wiki/a.md", "V2")

    older.reject(new Error("write timeout"))
    await expect(writeV1).resolves.toMatchObject({ status: "stale" })
    await expect(writeV2).resolves.toMatchObject({ status: "applied", content: "V2" })
  })

  it("propagates a failure from the current file write", async () => {
    const writeFile = vi.fn().mockRejectedValueOnce(new Error("disk full"))
    const session = createPreviewFileSession(vi.fn(), writeFile)
    session.activate("/wiki/a.md")
    await expect(session.write("/wiki/a.md", "V1")).rejects.toThrow("disk full")
  })
})
