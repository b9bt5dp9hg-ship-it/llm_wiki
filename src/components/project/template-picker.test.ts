import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./template-picker.tsx", import.meta.url), "utf8")

describe("template picker accessibility", () => {
  it("exposes the selected template state", () => {
    expect(source).toMatch(/aria-pressed=\{selected === template\.id\}/)
  })
})
