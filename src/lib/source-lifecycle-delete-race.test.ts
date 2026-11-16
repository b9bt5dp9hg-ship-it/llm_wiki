/**
 * Parallel deleteSourceFiles used to read-modify-write the same
 * `sources:` frontmatter. The later write restored a source the other
 * delete had already removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import type { FileNode } from "@/types/wiki"

const mockDeleteFile = vi.fn<(path: string) => Promise<void>>()
const mockReadFile = vi.fn<(path: string) => Promise<string>>()
const mockWriteFile = vi.fn<(path: string, content: string) => Promise<void>>()
const mockListDirectory = vi.fn<(path: string) => Promise<FileNode[]>>()
const mockFileExists = vi.fn<(path: string) => Promise<boolean>>()

vi.mock("@/commands/fs", () => ({
  deleteFile: (path: string) => mockDeleteFile(path),
  readFile: (path: string) => mockReadFile(path),
  writeFile: (path: string, content: string) => mockWriteFile(path, content),
  listDirectory: (path: string) => mockListDirectory(path),
  fileExists: (path: string) => mockFileExists(path),
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  getFileSize: vi.fn(),
}))

vi.mock("@/lib/ingest-queue", () => ({
  discardTasksForSources: vi.fn().mockResolvedValue(0),
  enqueueBatch: vi.fn(),
}))

vi.mock("@/lib/ingest-cache", () => ({
  removeFromIngestCache: vi.fn().mockResolvedValue(undefined),
  moveIngestCacheEntry: vi.fn(),
}))

vi.mock("@/lib/parsed-source-output", () => ({
  removeParsedMarkdown: vi.fn().mockResolvedValue(undefined),
  moveParsedMarkdown: vi.fn(),
}))

vi.mock("@/lib/embedding", () => ({
  removePageEmbedding: vi.fn().mockResolvedValue(undefined),
}))

import { deleteSourceFiles, migrateSourcePath } from "./source-lifecycle"
import { __resetProjectLocksForTesting } from "./project-mutex"

const PROJECT = "/proj"
const SHARED = `${PROJECT}/wiki/concepts/shared.md`
const B_ONLY = `${PROJECT}/wiki/concepts/b-only.md`
const LOG = `${PROJECT}/wiki/log.md`
const SOURCE_A = `${PROJECT}/raw/sources/a.yaml`
const SOURCE_B = `${PROJECT}/raw/sources/b.yaml`

function fileNode(path: string): FileNode {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, is_dir: false }
}

function wikiTree(files: Map<string, string>): FileNode[] {
  const concepts: FileNode[] = []
  if (files.has(SHARED)) concepts.push(fileNode(SHARED))
  if (files.has(B_ONLY)) concepts.push(fileNode(B_ONLY))
  const children: FileNode[] = []
  if (concepts.length > 0) {
    children.push({
      name: "concepts",
      path: `${PROJECT}/wiki/concepts`,
      is_dir: true,
      children: concepts,
    })
  }
  if (files.has(LOG)) children.push(fileNode(LOG))
  return children
}

describe("deleteSourceFiles overlapping sources rewrites", () => {
  beforeEach(() => {
    mockDeleteFile.mockReset()
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockListDirectory.mockReset()
    mockFileExists.mockReset()
    __resetProjectLocksForTesting()
  })

  it("does not restore a deleted source reference when two deletes overlap", async () => {
    const files = new Map<string, string>([
      [SHARED, '---\nsources: ["a.yaml", "b.yaml"]\n---\n# Shared\n'],
      [B_ONLY, '---\nsources: ["b.yaml"]\n---\n# B only\n'],
      [LOG, "# Wiki Log\n"],
      [SOURCE_A, "name: a\n"],
      [SOURCE_B, "name: b\n"],
    ])
    const firstSharedReadStarted = createDeferred<void>()
    const releaseFirstSharedRead = createDeferred<void>()
    let sharedReads = 0

    mockFileExists.mockImplementation(async (path) => files.has(path))
    mockDeleteFile.mockImplementation(async (path) => {
      files.delete(path)
    })
    mockWriteFile.mockImplementation(async (path, content) => {
      files.set(path, content)
    })
    mockListDirectory.mockImplementation(async () => wikiTree(files))
    mockReadFile.mockImplementation(async (path) => {
      if (path === SHARED) {
        sharedReads += 1
        const snapshot = files.get(path)
        if (snapshot === undefined) throw new Error(`missing ${path}`)
        if (sharedReads === 1) {
          firstSharedReadStarted.resolve()
          await releaseFirstSharedRead.promise
        }
        return snapshot
      }
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing ${path}`)
      return content
    })

    const deleteA = deleteSourceFiles(PROJECT, [SOURCE_A])
    await firstSharedReadStarted.promise
    const deleteB = deleteSourceFiles(PROJECT, [SOURCE_B])
    await flushMicrotasks()
    releaseFirstSharedRead.resolve()
    await Promise.all([deleteA, deleteB])

    const shared = files.get(SHARED)
    if (shared !== undefined) {
      expect(shared).not.toContain("a.yaml")
      expect(shared).not.toContain("b.yaml")
    }
    expect(files.has(B_ONLY)).toBe(false)
  })

  it("does not drop a source identity when two path migrations overlap", async () => {
    const sourceA2 = `${PROJECT}/raw/sources/a-renamed.yaml`
    const sourceB2 = `${PROJECT}/raw/sources/b-renamed.yaml`
    const files = new Map<string, string>([
      [SHARED, '---\nsources: ["a.yaml", "b.yaml"]\n---\n# Shared\n'],
      [LOG, "# Wiki Log\n"],
      [sourceA2, "name: a\n"],
      [sourceB2, "name: b\n"],
    ])
    const firstSharedReadStarted = createDeferred<void>()
    const releaseFirstSharedRead = createDeferred<void>()
    let sharedReads = 0

    mockFileExists.mockImplementation(async (path) => files.has(path))
    mockDeleteFile.mockImplementation(async (path) => {
      files.delete(path)
    })
    mockWriteFile.mockImplementation(async (path, content) => {
      files.set(path, content)
    })
    mockListDirectory.mockImplementation(async (path) => {
      if (path === `${PROJECT}/wiki`) return wikiTree(files)
      return [
        fileNode(sourceA2),
        fileNode(sourceB2),
      ]
    })
    mockReadFile.mockImplementation(async (path) => {
      if (path === SHARED) {
        sharedReads += 1
        const snapshot = files.get(path)
        if (snapshot === undefined) throw new Error(`missing ${path}`)
        if (sharedReads === 1) {
          firstSharedReadStarted.resolve()
          await releaseFirstSharedRead.promise
        }
        return snapshot
      }
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing ${path}`)
      return content
    })

    const migrateA = migrateSourcePath(PROJECT, SOURCE_A, sourceA2)
    await firstSharedReadStarted.promise
    const migrateB = migrateSourcePath(PROJECT, SOURCE_B, sourceB2)
    await flushMicrotasks()
    releaseFirstSharedRead.resolve()
    await Promise.all([migrateA, migrateB])

    const shared = files.get(SHARED) ?? ""
    expect(shared).toContain("a-renamed.yaml")
    expect(shared).toContain("b-renamed.yaml")
    expect(shared).not.toContain('"a.yaml"')
    expect(shared).not.toContain('"b.yaml"')
  })
})
