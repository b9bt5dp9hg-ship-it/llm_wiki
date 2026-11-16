import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  filterSlashSkillOptions,
  findContextFileTrigger,
  findSlashSkillTrigger,
  removeSlashSkillToken,
  skillChipDeleteTarget,
  type ChatSkillOption,
} from "./chat-input"

const skills: ChatSkillOption[] = [
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Review code and documents",
    source: "project",
  },
  {
    id: "illustrator",
    name: "Illustrator",
    description: "Create article images",
    source: "claude",
  },
  {
    id: "draft",
    name: "Draft",
    description: "Write drafts",
    source: "agents",
  },
]

describe("chat slash skill helpers", () => {
  it("detects project-file mentions without matching email-like text", () => {
    expect(findContextFileTrigger("Use @wiki/page", 14)).toEqual({
      start: 4,
      end: 14,
      query: "wiki/page",
    })
    expect(findContextFileTrigger("name@example.com", 16)).toBeNull()
  })
  it("detects slash skill tokens at the cursor", () => {
    expect(findSlashSkillTrigger("/re", 3)).toEqual({ start: 0, end: 3, query: "re" })
    expect(findSlashSkillTrigger("hi /re", 6)).toEqual({ start: 3, end: 6, query: "re" })
    expect(findSlashSkillTrigger("a\n/re", 5)).toEqual({ start: 2, end: 5, query: "re" })
    expect(findSlashSkillTrigger("/review", 4)).toEqual({ start: 0, end: 7, query: "rev" })
  })

  it("does not detect mid-word slashes or out-of-range cursors", () => {
    expect(findSlashSkillTrigger("http://x", 8)).toBeNull()
    expect(findSlashSkillTrigger("/re", 0)).toBeNull()
    expect(findSlashSkillTrigger("/re", -1)).toBeNull()
    expect(findSlashSkillTrigger("/re", 99)).toBeNull()
  })

  it("removes a slash token without gluing adjacent words", () => {
    const trigger = findSlashSkillTrigger("a /x b", 4)
    expect(trigger).not.toBeNull()
    expect(removeSlashSkillToken("a /x b", trigger!)).toEqual({ value: "a  b", cursor: 2 })
  })

  it("removes the whole slash token when the cursor is in the middle", () => {
    const trigger = findSlashSkillTrigger("/review", 4)
    expect(trigger).not.toBeNull()
    expect(removeSlashSkillToken("/review", trigger!)).toEqual({ value: "", cursor: 0 })
  })

  it("filters skills by name, id, description, and localized source label", () => {
    const sourceLabel = (source: string) => ({ project: "项目", claude: "Claude", agents: "Agents" }[source] ?? source)

    expect(filterSlashSkillOptions(skills, "rev", sourceLabel).map((skill) => skill.id)).toEqual(["reviewer"])
    expect(filterSlashSkillOptions(skills, "图片", sourceLabel).map((skill) => skill.id)).toEqual([])
    expect(filterSlashSkillOptions(skills, "项目", sourceLabel).map((skill) => skill.id)).toEqual(["reviewer"])
  })

  it("caps filtered skills to the requested limit", () => {
    expect(filterSlashSkillOptions(skills, "", (source) => source, 2).map((skill) => skill.id)).toEqual([
      "reviewer",
      "illustrator",
    ])
  })

  it("returns every matching skill by default", () => {
    const manySkills = Array.from({ length: 12 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      source: "project",
    }))

    expect(filterSlashSkillOptions(manySkills, "", (source) => source)).toHaveLength(12)
  })

  it("maps boundary deletion to whole skill chips without hijacking forward-delete text editing", () => {
    expect(skillChipDeleteTarget("Backspace", "hello", 0, 0, 2)).toBe("last")
    expect(skillChipDeleteTarget("Delete", "", 0, 0, 2)).toBe("first")
    expect(skillChipDeleteTarget("Delete", "hello", 0, 0, 2)).toBeNull()
    expect(skillChipDeleteTarget("Backspace", "hello", 0, 2, 2)).toBeNull()
    expect(skillChipDeleteTarget("Backspace", "hello", 0, 0, 0)).toBeNull()
  })
})

describe("chat attachment removal accessibility", () => {
  const source = readFileSync(new URL("./chat-input.tsx", import.meta.url), "utf8")

  it("names image, context-file, and skill removal controls", () => {
    expect(source).toMatch(/aria-label=\{t\("chat\.removeImage"\)\}/)
    expect(source).toMatch(/aria-label=\{t\("chat\.removeContextFile", \{ name: path \}\)\}/)
    expect(source).toMatch(/aria-label=\{t\("chat\.removeSkill", \{ name: skill\.name \}\)\}/)
  })
})

describe("chat autocomplete accessibility", () => {
  const source = readFileSync(new URL("./chat-input.tsx", import.meta.url), "utf8")

  it("connects the chat combobox to named listbox options", () => {
    expect(source).toMatch(/role="combobox"/)
    expect(source).toMatch(/aria-autocomplete="list"/)
    expect(source).toMatch(/id="chat-slash-skill-options" role="listbox"/)
    expect(source).toMatch(/id="chat-context-file-options" role="listbox"/)
    expect(source.match(/role="option"/g)).toHaveLength(2)
    expect(source).toMatch(/aria-activedescendant=/)
  })
})
