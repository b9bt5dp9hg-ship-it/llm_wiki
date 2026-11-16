import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

function source(relative: string): string {
  return readFileSync(join(here, relative), "utf8")
}

describe("chat project path confinement", () => {
  const message = source("chat-message.tsx")
  const panel = source("chat-panel.tsx")

  it("does not treat every absolute citation path as in-project", () => {
    expect(message).not.toMatch(/if \(isAbsolutePath\(normalized\)\) return normalized/)
    expect(panel).not.toMatch(/if \(isAbsolutePath\(normalized\)\) return normalized/)
    expect(panel).not.toMatch(
      /const directPath = isAbsolutePath\(reference\.path\)\s*\?\s*normalizePath\(reference\.path\)/,
    )
  })

  it("confines chat file reads and previews with confineProjectFilePath", () => {
    expect(message).toMatch(/confineProjectFilePath\(/)
    expect(panel).toMatch(/confineProjectFilePath\(/)
  })
})
