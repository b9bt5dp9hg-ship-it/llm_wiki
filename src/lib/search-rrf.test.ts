/**
 * The RRF scoring implementation now lives in Rust
 * (`commands::search`). These TS tests only guard the WebView wrapper:
 * it should pass embedding config to the shared backend command and map
 * backend-relative result paths back to absolute project paths for the editor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"

const mockInvoke = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { createSearchSession, searchWiki, tokenizeQuery } from "./search"

beforeEach(() => {
  mockInvoke.mockReset()
  useWikiStore.getState().setEmbeddingConfig({
    enabled: true,
    endpoint: "http://test/v1/embeddings",
    apiKey: "",
    model: "test-embed",
  })
})

describe("searchWiki backend wrapper", () => {
  it("passes embeddingConfig to the shared backend search command and absolutizes paths", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "hybrid",
      tokenHits: 1,
      vectorHits: 1,
      results: [
        {
          path: "wiki/concepts/attention.md",
          title: "Attention",
          snippet: "Attention",
          titleMatch: true,
          score: 1 / 61,
          images: [],
        },
      ],
    })

    const out = await searchWiki("/tmp/project", "attention")

    expect(mockInvoke).toHaveBeenCalledWith("search_project", {
      projectPath: "/tmp/project",
      query: "attention",
      topK: 20,
      includeContent: false,
      queryEmbedding: null,
      embeddingConfig: expect.objectContaining({ enabled: true, model: "test-embed" }),
    })
    expect(out[0].path).toBe("/tmp/project/wiki/concepts/attention.md")
  })

  it("drops search hits whose paths escape the project wiki or raw tree", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "keyword",
      tokenHits: 4,
      vectorHits: 0,
      results: [
        {
          path: "wiki/../.llm-wiki/project.json",
          title: "secret",
          snippet: "id",
          titleMatch: true,
          score: 1,
          images: [],
        },
        {
          path: "../outside.md",
          title: "outside",
          snippet: "x",
          titleMatch: true,
          score: 1,
          images: [],
        },
        {
          path: "/etc/passwd.md",
          title: "passwd",
          snippet: "root",
          titleMatch: true,
          score: 1,
          images: [],
        },
        {
          path: "wiki/concepts/attention.md",
          title: "Attention",
          snippet: "Attention",
          titleMatch: true,
          score: 1 / 61,
          images: [],
        },
      ],
    })

    const out = await searchWiki("/tmp/project", "attention")

    expect(out.map((result) => result.path)).toEqual([
      "/tmp/project/wiki/concepts/attention.md",
    ])
  })

  it("canonicalizes nested wiki-page ../media image urls onto wiki/media", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "keyword",
      tokenHits: 2,
      vectorHits: 0,
      results: [
        {
          path: "wiki/sources/report.md",
          title: "Report",
          snippet: "figure",
          titleMatch: true,
          score: 1,
          images: [{ url: "../media/report/img-1.png", alt: "chart" }],
        },
        {
          path: "wiki/concepts/attention.md",
          title: "Attention",
          snippet: "figure",
          titleMatch: true,
          score: 1,
          images: [{ url: "media/report/img-1.png", alt: "chart" }],
        },
      ],
    })

    const out = await searchWiki("/tmp/project", "chart")

    expect(out.map((result) => result.images.map((image) => image.url))).toEqual([
      ["/tmp/project/wiki/media/report/img-1.png"],
      ["/tmp/project/wiki/media/report/img-1.png"],
    ])
  })

  it("drops search image urls that leave the project wiki or raw tree", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "keyword",
      tokenHits: 1,
      vectorHits: 0,
      results: [
        {
          path: "wiki/concepts/attention.md",
          title: "Attention",
          snippet: "figure",
          titleMatch: true,
          score: 1,
          images: [
            { url: "../../.llm-wiki/secret.png", alt: "secret" },
            { url: "/etc/passwd.png", alt: "passwd" },
            { url: "media/report/img-1.png", alt: "chart" },
            { url: "https://cdn.example/fig.png", alt: "remote" },
          ],
        },
      ],
    })

    const out = await searchWiki("/tmp/project", "chart")

    expect(out[0].images).toEqual([
      { url: "/tmp/project/wiki/media/report/img-1.png", alt: "chart" },
      { url: "https://cdn.example/fig.png", alt: "remote" },
    ])
  })

  it("keeps already-absolute in-project wiki paths instead of double-joining them", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "keyword",
      tokenHits: 1,
      vectorHits: 0,
      results: [
        {
          path: "/tmp/project/wiki/concepts/attention.md",
          title: "Attention",
          snippet: "Attention",
          titleMatch: true,
          score: 1 / 61,
          images: [],
        },
      ],
    })

    const out = await searchWiki("/tmp/project", "attention")

    expect(out.map((result) => result.path)).toEqual([
      "/tmp/project/wiki/concepts/attention.md",
    ])
  })

  it("passes disabled embedding config through for backend keyword-only search", async () => {
    useWikiStore.getState().setEmbeddingConfig({
      enabled: false,
      endpoint: "",
      apiKey: "",
      model: "",
    })
    mockInvoke.mockResolvedValueOnce({
      mode: "keyword",
      tokenHits: 1,
      vectorHits: 0,
      results: [],
    })

    await searchWiki("/tmp/project", "attention")

    expect(mockInvoke).toHaveBeenCalledWith(
      "search_project",
      expect.objectContaining({
        queryEmbedding: null,
        embeddingConfig: expect.objectContaining({ enabled: false }),
      }),
    )
  })

  it("keeps CJK tokenization behavior for image caption filtering", () => {
    const tokens = tokenizeQuery("默会知识")
    expect(tokens).toContain("默会")
    expect(tokens).toContain("知识")
    expect(tokens).toContain("默")
  })
})

function searchHit(title: string, path: string) {
  return {
    path,
    title,
    snippet: title,
    titleMatch: true,
    score: 1,
    images: [],
  }
}

function searchResponse(title: string, path: string) {
  return {
    mode: "keyword" as const,
    tokenHits: 1,
    vectorHits: 0,
    results: [searchHit(title, path)],
  }
}

describe("createSearchSession", () => {
  it("does not apply a slower older query after a newer search finishes", async () => {
    const older = createDeferred<ReturnType<typeof searchResponse>>()
    mockInvoke.mockImplementationOnce(() => older.promise)
    mockInvoke.mockResolvedValueOnce(
      searchResponse("Beta", "wiki/concepts/beta.md"),
    )

    const session = createSearchSession()
    const olderSearch = session.run("/tmp/project", "alpha")
    await flushMicrotasks()
    const newerSearch = session.run("/tmp/project", "beta")

    await expect(newerSearch).resolves.toMatchObject({
      status: "applied",
      results: [expect.objectContaining({ title: "Beta" })],
    })

    older.resolve(searchResponse("Alpha", "wiki/concepts/alpha.md"))
    await expect(olderSearch).resolves.toMatchObject({ status: "stale" })
  })

  it("treats an empty query as a newer request so in-flight hits cannot refill the list", async () => {
    const older = createDeferred<ReturnType<typeof searchResponse>>()
    mockInvoke.mockImplementationOnce(() => older.promise)

    const session = createSearchSession()
    const olderSearch = session.run("/tmp/project", "alpha")
    await flushMicrotasks()
    const cleared = session.run("/tmp/project", "   ")

    await expect(cleared).resolves.toMatchObject({ status: "applied", results: [] })
    older.resolve(searchResponse("Alpha", "wiki/concepts/alpha.md"))
    await expect(olderSearch).resolves.toMatchObject({ status: "stale" })
  })

  it("drops in-flight results after invalidate", async () => {
    const older = createDeferred<ReturnType<typeof searchResponse>>()
    mockInvoke.mockImplementationOnce(() => older.promise)

    const session = createSearchSession()
    const olderSearch = session.run("/tmp/project", "alpha")
    await flushMicrotasks()
    session.invalidate()
    older.resolve(searchResponse("Alpha", "wiki/concepts/alpha.md"))
    await expect(olderSearch).resolves.toMatchObject({ status: "stale" })
  })

  it("does not surface a failure from a superseded search", async () => {
    const older = createDeferred<ReturnType<typeof searchResponse>>()
    mockInvoke.mockImplementationOnce(() => older.promise)
    mockInvoke.mockResolvedValueOnce(
      searchResponse("Beta", "wiki/concepts/beta.md"),
    )

    const session = createSearchSession()
    const olderSearch = session.run("/tmp/project", "alpha")
    await flushMicrotasks()
    const newerSearch = session.run("/tmp/project", "beta")

    await expect(newerSearch).resolves.toMatchObject({ status: "applied" })
    older.reject(new Error("backend timeout"))
    await expect(olderSearch).resolves.toMatchObject({ status: "stale" })
  })
})
