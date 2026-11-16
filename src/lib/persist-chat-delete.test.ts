import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => mocks)

import { discardConversation } from "./persist"

describe("discardConversation", () => {
  beforeEach(() => {
    mocks.deleteFile.mockReset().mockResolvedValue(undefined)
    mocks.fileExists.mockReset().mockResolvedValue(true)
  })

  it("does not drop the in-memory conversation when the file delete fails", async () => {
    mocks.deleteFile.mockRejectedValue(new Error("EACCES"))
    const removeFromStore = vi.fn()

    await expect(discardConversation("/proj", "c1", removeFromStore)).rejects.toThrow("EACCES")
    expect(removeFromStore).not.toHaveBeenCalled()
  })

  it("drops the in-memory conversation after the file is removed", async () => {
    const removeFromStore = vi.fn()
    await discardConversation("/proj", "c1", removeFromStore)
    expect(mocks.deleteFile).toHaveBeenCalledWith("/proj/.llm-wiki/chats/c1.json")
    expect(removeFromStore).toHaveBeenCalledWith("c1")
  })

  it("deletes the canonical lowercase chat file for a mixed-case id", async () => {
    const removeFromStore = vi.fn()
    await discardConversation("/proj", "C1", removeFromStore)
    expect(mocks.deleteFile).toHaveBeenCalledWith("/proj/.llm-wiki/chats/c1.json")
    expect(removeFromStore).toHaveBeenCalledWith("C1")
  })

  it("drops an unsaved conversation when no chat file exists", async () => {
    mocks.fileExists.mockResolvedValue(false)
    const removeFromStore = vi.fn()
    await discardConversation("/proj", "c1", removeFromStore)
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(removeFromStore).toHaveBeenCalledWith("c1")
  })

  it("drops the conversation when no project is open", async () => {
    const removeFromStore = vi.fn()
    await discardConversation(undefined, "c1", removeFromStore)
    expect(mocks.fileExists).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(removeFromStore).toHaveBeenCalledWith("c1")
  })
})
