import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { embeddingConfigFromDraft } from "./embedding-section"

const here = dirname(fileURLToPath(import.meta.url))

function source(relative: string): string {
  return readFileSync(join(here, relative), "utf8")
}

function handleReindexSource(section: string): string {
  const start = section.indexOf("const handleReindex = useCallback")
  const end = section.indexOf("const handleDropLegacy", start)
  return section.slice(start, end === -1 ? undefined : end)
}

describe("EmbeddingSection reindex config", () => {
  const handle = handleReindexSource(source("embedding-section.tsx"))

  it("reindexes with the unsaved on-screen draft instead of the last persisted store config", () => {
    expect(handle).toMatch(/embedAllPages\(/)
    expect(handle).not.toMatch(/embedAllPages\(\s*project\.path,\s*embeddingConfig/)
    expect(handle).toMatch(/embeddingConfigFromDraft\(draft\)/)
  })

  it("persists the draft embedding config before reindex so later loads match the vectors", () => {
    const persistAt = handle.indexOf("saveEmbeddingConfig(")
    const embedAt = handle.indexOf("embedAllPages(")
    expect(persistAt).toBeGreaterThan(-1)
    expect(embedAt).toBeGreaterThan(-1)
    expect(persistAt).toBeLessThan(embedAt)
    expect(handle).not.toMatch(/setEmbeddingConfig\(/)
  })
})

describe("EmbeddingSection accessibility", () => {
  const section = source("embedding-section.tsx")

  it("exposes the enabled state and name of the embedding toggle", () => {
    expect(section).toMatch(/role="switch"/)
    expect(section).toMatch(/aria-checked=\{draft\.embeddingEnabled\}/)
    expect(section).toMatch(/aria-label=\{t\("settings\.sections\.embedding\.enableLabel"\)\}/)
  })
})

describe("embeddingConfigFromDraft", () => {
  it("maps the unsaved settings draft rather than a persisted store snapshot", () => {
    const draft = {
      embeddingEnabled: true,
      embeddingEndpoint: "http://draft-embed/v1",
      embeddingApiKey: "draft-key",
      embeddingModel: "draft-model",
      embeddingOutputDimensionality: 768,
      embeddingMaxChunkChars: 400,
      embeddingOverlapChunkChars: 40,
      embeddingConcurrency: 4,
      embeddingBatchSize: 8,
      embeddingExtraHeaders: { "X-Test": "1" },
    }

    expect(embeddingConfigFromDraft(draft)).toEqual({
      enabled: true,
      endpoint: "http://draft-embed/v1",
      apiKey: "draft-key",
      model: "draft-model",
      outputDimensionality: 768,
      maxChunkChars: 400,
      overlapChunkChars: 40,
      concurrency: 4,
      batchSize: 8,
      extraHeaders: { "X-Test": "1" },
    })
  })

  it("clamps draft concurrency and batch size before reindex", () => {
    const draft = {
      embeddingEnabled: true,
      embeddingEndpoint: "",
      embeddingApiKey: "",
      embeddingModel: "m",
      embeddingOutputDimensionality: undefined,
      embeddingMaxChunkChars: undefined,
      embeddingOverlapChunkChars: undefined,
      embeddingConcurrency: 999,
      embeddingBatchSize: 0,
      embeddingExtraHeaders: {},
    }

    expect(embeddingConfigFromDraft(draft)).toMatchObject({
      concurrency: 32,
      batchSize: 1,
    })
  })
})
