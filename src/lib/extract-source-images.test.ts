import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockCopyFile,
  mockCreateDirectory,
  mockFileExists,
  mockReadFileAsBase64,
} = vi.hoisted(() => ({
  mockCopyFile: vi.fn(),
  mockCreateDirectory: vi.fn(),
  mockFileExists: vi.fn(),
  mockReadFileAsBase64: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  copyFile: mockCopyFile,
  createDirectory: mockCreateDirectory,
  fileExists: mockFileExists,
  readFileAsBase64: mockReadFileAsBase64,
}))

import {
  extractAndSaveMarkdownImages,
  findLocalMarkdownImageRefs,
} from "./extract-source-images"

const PROJECT = "/Users/me/MyWiki"
const SOURCE = `${PROJECT}/raw/sources/notes/paper.md`

beforeEach(() => {
  mockCopyFile.mockReset()
  mockCreateDirectory.mockReset()
  mockFileExists.mockReset()
  mockReadFileAsBase64.mockReset()
  mockCopyFile.mockResolvedValue(undefined)
  mockCreateDirectory.mockResolvedValue(undefined)
  mockFileExists.mockResolvedValue(true)
  mockReadFileAsBase64.mockResolvedValue({ base64: "QQ==", mimeType: "image/png" })
})

describe("findLocalMarkdownImageRefs", () => {
  it("extracts Obsidian and markdown local image references", () => {
    const refs = findLocalMarkdownImageRefs(`
![[attachments/chart.png]]
![Figure](images/plot%201.jpg "title")
![Remote](https://example.com/a.png)
![[attachments/chart.png|400]]
`)
    expect(refs).toEqual(["attachments/chart.png", "images/plot 1.jpg"])
  })

  it("ignores non-image links and remote/data references", () => {
    const refs = findLocalMarkdownImageRefs(`
![Doc](notes/page.md)
![Data](data:image/png;base64,abc)
![[draft.txt]]
`)
    expect(refs).toEqual([])
  })
})

describe("extractAndSaveMarkdownImages path confinement", () => {
  it("does not copy an absolute image path outside the project", async () => {
    const images = await extractAndSaveMarkdownImages(
      PROJECT,
      SOURCE,
      "![leak](/etc/secret.png)",
    )
    expect(images).toEqual([])
    expect(mockCopyFile).not.toHaveBeenCalled()
  })

  it("does not copy a relative image that climbs out of the project", async () => {
    const images = await extractAndSaveMarkdownImages(
      PROJECT,
      SOURCE,
      "![leak](../../../../.ssh/id.png)",
    )
    expect(images).toEqual([])
    expect(mockCopyFile).not.toHaveBeenCalled()
  })

  it("does not copy an image from .llm-wiki", async () => {
    const images = await extractAndSaveMarkdownImages(
      PROJECT,
      SOURCE,
      "![leak](../../.llm-wiki/secret.png)",
    )
    expect(images).toEqual([])
    expect(mockCopyFile).not.toHaveBeenCalled()
  })

  it("does not create a media directory from a traversing slug", async () => {
    const images = await extractAndSaveMarkdownImages(
      PROJECT,
      SOURCE,
      "![ok](images/chart.png)",
      "../.llm-wiki",
    )
    expect(images).toEqual([])
    expect(mockCreateDirectory).not.toHaveBeenCalled()
    expect(mockCopyFile).not.toHaveBeenCalled()
  })

  it("copies an in-project image next to the source markdown", async () => {
    const images = await extractAndSaveMarkdownImages(
      PROJECT,
      SOURCE,
      "![Figure](images/chart.png)",
    )
    expect(mockCopyFile).toHaveBeenCalledTimes(1)
    expect(mockCopyFile.mock.calls[0]?.[0]).toBe(`${PROJECT}/raw/sources/notes/images/chart.png`)
    expect(mockCopyFile.mock.calls[0]?.[1]).toBe(`${PROJECT}/wiki/media/paper/001-chart.png`)
    expect(images).toHaveLength(1)
    expect(images[0]?.relPath).toBe("media/paper/001-chart.png")
    expect(images[0]?.absPath).toBe(`${PROJECT}/wiki/media/paper/001-chart.png`)
  })
})
