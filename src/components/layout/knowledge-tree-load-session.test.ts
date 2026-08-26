import { describe, expect, it } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { createKnowledgeTreeLoadSession } from "./knowledge-tree-load-session"

describe("createKnowledgeTreeLoadSession", () => {
  it("drops a slower project load after a newer project load completes", async () => {
    const projectA = createDeferred<string[]>()
    const session = createKnowledgeTreeLoadSession()

    const loadA = session.load(() => projectA.promise)
    await flushMicrotasks()
    const loadB = session.load(async () => ["project-b"])

    await expect(loadB).resolves.toEqual({ status: "applied", value: ["project-b"] })
    projectA.resolve(["project-a"])
    await expect(loadA).resolves.toEqual({ status: "stale" })
  })

  it("turns a rejected invalidated load into a stale result", async () => {
    const projectA = createDeferred<string[]>()
    const session = createKnowledgeTreeLoadSession()

    const loadA = session.load(() => projectA.promise)
    session.invalidate()
    projectA.reject(new Error("old project disappeared"))

    await expect(loadA).resolves.toEqual({ status: "stale" })
  })
})
