import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const section = readFileSync(new URL("./mineru-section.tsx", import.meta.url), "utf8")

describe("MinerU connection-test request ordering", () => {
  it("captures the tested configuration and ignores stale success or failure", () => {
    expect(section).toMatch(/const testedConfigKey = mineruTestConfigKey/)
    expect(section).toMatch(/const requestId = \+\+mineruTestRequest\.current/)
    expect(section).toMatch(/await testMineruConnection[\s\S]*isCurrentMineruTest\(requestId, testedConfigKey/)
    expect(section).toMatch(/catch \(err\)[\s\S]*isCurrentMineruTest\(requestId, testedConfigKey/)
  })
})
