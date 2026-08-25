import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock fs so the tests don't touch real disk.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
}))

import { checkIngestCache, saveIngestCache } from "./ingest-cache"
import { readFile, writeFile, fileExists } from "@/commands/fs"

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockFileExists = vi.mocked(fileExists)

beforeEach(() => {
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockFileExists.mockReset()
  mockWriteFile.mockResolvedValue(undefined as unknown as void)
})

describe("ingest-cache — checkIngestCache", () => {
  it("returns null when no entry exists", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ entries: {} }))
    const result = await checkIngestCache("/project", "foo.pdf", "content")
    expect(result).toBeNull()
  })

  it("returns cached filesWritten when hash matches AND all files exist", async () => {
    // Pre-seed cache with a hash matching "hello".
    // We compute the expected hash by running saveIngestCache first in
    // a controlled round-trip, then feeding the same JSON back in.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    mockFileExists.mockResolvedValue(true)
    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toEqual(["wiki/sources/foo.md", "wiki/entities/bar.md"])
  })

  it("returns null when hash matches but a cached file no longer exists on disk", async () => {
    // Prime cache, then simulate user deleting one of the written files.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    // wiki/entities/bar.md has been deleted since the cache was written.
    mockFileExists.mockImplementation(async (p: string) => {
      return !p.includes("entities/bar.md")
    })

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })

  it("returns null when the content hash no longer matches (cache stale on content change)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])

    const result = await checkIngestCache("/project", "foo.pdf", "different content")
    expect(result).toBeNull()
  })

  it("returns null if fileExists itself throws (safer to re-ingest than to trust)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])

    mockFileExists.mockRejectedValue(new Error("stat failed"))

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })

  it("treats escaped filesWritten as a miss even when those files exist", async () => {
    // ingest-cache.json is project-local and not a trusted writer. A
    // poisoned filesWritten list used to be returned verbatim after a
    // hash match, so the activity panel could open /etc/passwd.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])
    const parsed = JSON.parse(persisted) as {
      entries: Record<string, { filesWritten: string[] }>
    }
    parsed.entries["foo.pdf"].filesWritten = [
      "/etc/passwd",
      "wiki/../../../etc/passwd.md",
      "wiki/../.llm-wiki/project.json",
    ]
    persisted = JSON.stringify(parsed)
    mockFileExists.mockResolvedValue(true)

    expect(await checkIngestCache("/project", "foo.pdf", "hello")).toBeNull()
  })

  it("rewrites in-project absolute wiki paths to project-relative wiki/*.md", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "/project/wiki/sources/foo.md",
    ])
    mockFileExists.mockResolvedValue(true)

    expect(await checkIngestCache("/project", "foo.pdf", "hello")).toEqual([
      "wiki/sources/foo.md",
    ])
  })
})

describe("ingest-cache — saveIngestCache", () => {
  it("does not persist filesWritten that leave wiki/", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })

    await saveIngestCache("/project", "foo.pdf", "hello", [
      "/etc/passwd",
      "wiki/sources/foo.md",
      "wiki/../.llm-wiki/project.json",
    ])

    const parsed = JSON.parse(persisted) as {
      entries: Record<string, { filesWritten: string[] }>
    }
    expect(parsed.entries["foo.pdf"].filesWritten).toEqual(["wiki/sources/foo.md"])
  })
})
