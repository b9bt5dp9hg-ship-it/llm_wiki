import { describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { createSearchNavigationSession } from "./search-navigation-session"

describe("createSearchNavigationSession", () => {
  it("drops a slower older result read after a newer result opens", async () => {
    const older = createDeferred<string>()
    const read = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce("B")
    const session = createSearchNavigationSession(read)

    const openA = session.open("/project/wiki/a.md")
    await flushMicrotasks()
    const openB = session.open("/project/wiki/b.md")
    await expect(openB).resolves.toMatchObject({ status: "applied", path: "/project/wiki/b.md", content: "B" })

    older.resolve("A")
    await expect(openA).resolves.toMatchObject({ status: "stale" })
  })

  it("stops a stale image jump before reading its resolved source", async () => {
    const target = createDeferred<{ path: string; scrollTarget: string }>()
    const read = vi.fn().mockResolvedValue("old source")
    const session = createSearchNavigationSession(read)

    const jump = session.jump(() => target.promise)
    await flushMicrotasks()
    session.invalidate()
    target.resolve({ path: "/project/raw/sources/a.pdf", scrollTarget: "image-a" })

    await expect(jump).resolves.toMatchObject({ status: "stale" })
    expect(read).not.toHaveBeenCalled()
  })
})
