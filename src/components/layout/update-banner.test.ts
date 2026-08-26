import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./update-banner.tsx", import.meta.url), "utf8")

describe("update banner accessibility", () => {
  it("announces a newly available version", () => {
    expect(source).toMatch(/role="status"/)
  })
})
