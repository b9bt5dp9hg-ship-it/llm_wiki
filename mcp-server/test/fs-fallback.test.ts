import assert from "node:assert/strict"
import { test, before, after } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildGraphOffline,
  findOfflineProject,
  listFilesOffline,
  readFileOffline,
  readProjectId,
  readProjectsFromAppState,
  readReviewsOffline,
  resolveOfflineProjectPath,
  searchOffline,
} from "../src/fs-fallback.js"

let projectDir: string

before(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-fallback-"))
  fs.mkdirSync(path.join(projectDir, "wiki", "sources"), { recursive: true })
  fs.mkdirSync(path.join(projectDir, "raw", "sources", "mail"), { recursive: true })
  fs.mkdirSync(path.join(projectDir, ".llm-wiki"), { recursive: true })

  fs.writeFileSync(path.join(projectDir, "purpose.md"), "# Purpose\n")
  fs.writeFileSync(
    path.join(projectDir, "wiki", "alpha.md"),
    '---\ntitle: "Alpha Seite"\ntype: entity\n---\n\nAlpha spricht über [[beta]] und nochmal [[beta|Beta-Link]].\n',
  )
  fs.writeFileSync(
    path.join(projectDir, "wiki", "beta.md"),
    "---\ntitle: Beta\ntype: concept\n---\n\nBeta erwähnt Rechnungsstellung und Skonto.\n",
  )
  fs.writeFileSync(path.join(projectDir, "wiki", "sources", "mail-1.md"), "---\ntype: source\n---\n\nQuelle ohne Links.\n")
  fs.writeFileSync(path.join(projectDir, "raw", "sources", "mail", "brief.txt"), "Rohtext")
  fs.writeFileSync(path.join(projectDir, "raw", "sources", "mail", "scan.bin"), "binär")
  fs.writeFileSync(path.join(projectDir, ".llm-wiki", "project.json"), JSON.stringify({ id: "proj-uuid-1" }))
  fs.writeFileSync(path.join(projectDir, ".llm-wiki", "review.json"), JSON.stringify([
    { type: "missing-page", title: "Offen", description: "d", resolved: false, options: [], createdAt: 1 },
    { id: "r2", type: "duplicate", title: "Erledigt", description: "d", resolved: true, options: [], createdAt: 2 },
  ]))
})

after(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

test("resolveOfflineProjectPath prefers explicit absolute path, then env", () => {
  assert.equal(resolveOfflineProjectPath(projectDir), projectDir)
  const prev = process.env.LLM_WIKI_PROJECT_PATH
  process.env.LLM_WIKI_PROJECT_PATH = projectDir
  try {
    assert.equal(resolveOfflineProjectPath(), projectDir)
  } finally {
    if (prev === undefined) delete process.env.LLM_WIKI_PROJECT_PATH
    else process.env.LLM_WIKI_PROJECT_PATH = prev
  }
})

test("readProjectId reads the project UUID from .llm-wiki/project.json", () => {
  assert.equal(readProjectId(projectDir), "proj-uuid-1")
})

test("listFilesOffline lists wiki and sources roots", () => {
  const wiki = listFilesOffline(projectDir, { root: "wiki" })
  const paths = JSON.stringify(wiki.files)
  assert.ok(paths.includes("wiki/alpha.md"))
  assert.ok(paths.includes("wiki/sources"))
  assert.ok(!paths.includes("raw/sources"))

  const all = listFilesOffline(projectDir, { root: "all" })
  assert.ok(JSON.stringify(all.files).includes("raw/sources/mail/brief.txt"))
})

test("readFileOffline enforces the allow-list", () => {
  assert.ok(readFileOffline(projectDir, "wiki/alpha.md").content.includes("Alpha"))
  assert.ok(readFileOffline(projectDir, "purpose.md").content.includes("Purpose"))
  assert.throws(() => readFileOffline(projectDir, ".llm-wiki/review.json"), /not allowed/)
  assert.throws(() => readFileOffline(projectDir, "raw/sources/mail/scan.bin"), /not allowed/)
  assert.throws(() => readFileOffline(projectDir, "wiki/../.llm-wiki/review.json"), /not allowed/)
})

test("readFileOffline refuses a wiki file symlink that points outside the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-offline-file-link-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-offline-secret-"))
  try {
    fs.mkdirSync(path.join(root, "wiki"), { recursive: true })
    const secret = path.join(outside, "secret.txt")
    fs.writeFileSync(secret, "outside-secret")
    fs.symlinkSync(secret, path.join(root, "wiki", "escape.md"))
    assert.throws(
      () => readFileOffline(root, "wiki/escape.md"),
      /escapes the project directory/,
    )
    assert.equal(fs.readFileSync(secret, "utf8"), "outside-secret")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("readFileOffline refuses a wiki path whose parent directory is a symlink outside the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-offline-dir-link-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-offline-other-"))
  try {
    fs.mkdirSync(path.join(root, "wiki"), { recursive: true })
    fs.mkdirSync(path.join(outside, "wiki"), { recursive: true })
    fs.writeFileSync(path.join(outside, "wiki", "page.md"), "leaked-from-other-project")
    fs.symlinkSync(path.join(outside, "wiki"), path.join(root, "wiki", "linked"))
    assert.throws(
      () => readFileOffline(root, "wiki/linked/page.md"),
      /escapes the project directory/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("listFilesOffline and searchOffline do not follow a wiki root symlink outside the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-offline-wiki-link-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-offline-wiki-src-"))
  try {
    fs.mkdirSync(path.join(outside, "wiki"), { recursive: true })
    fs.writeFileSync(
      path.join(outside, "wiki", "secret.md"),
      "---\ntitle: Secret\n---\n\nOutside wiki body.\n",
    )
    fs.symlinkSync(path.join(outside, "wiki"), path.join(root, "wiki"))
    const listed = JSON.stringify(listFilesOffline(root, { root: "wiki" }).files)
    assert.equal(listed.includes("secret"), false)
    const search = searchOffline(root, "Secret")
    assert.equal(search.results.some((hit) => hit.path.includes("secret")), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("readReviewsOffline defaults to unresolved and backfills ids", () => {
  const unresolved = readReviewsOffline(projectDir)
  assert.equal(unresolved.count, 1)
  assert.equal(unresolved.reviews[0].title, "Offen")
  assert.equal(unresolved.reviews[0].id, "review-0")

  const all = readReviewsOffline(projectDir, { status: "all" })
  assert.equal(all.count, 2)
})

test("buildGraphOffline parses frontmatter types and wikilinks", () => {
  const graph = buildGraphOffline(projectDir)
  const alpha = graph.nodes.find((node) => node.id === "wiki/alpha.md")
  const beta = graph.nodes.find((node) => node.id === "wiki/beta.md")
  assert.ok(alpha && beta)
  assert.equal(alpha.label, "Alpha Seite")
  assert.equal(alpha.type, "entity")
  assert.equal(beta.type, "concept")
  assert.equal(graph.edges.length, 1)
  assert.deepEqual(
    [graph.edges[0].source, graph.edges[0].target].sort(),
    ["wiki/alpha.md", "wiki/beta.md"],
  )
  assert.ok((alpha.linkCount ?? 0) > 0)
})

test("searchOffline scores title matches above body matches", () => {
  const result = searchOffline(projectDir, "Beta")
  assert.equal(result.mode, "offline-keyword")
  assert.ok(result.results.length >= 1)
  assert.equal(result.results[0].path, "wiki/beta.md")
  assert.equal(result.vectorHits, 0)

  const none = searchOffline(projectDir, "nichtvorhandenes-wort")
  assert.equal(none.results.length, 0)
})

test("searchOffline tokenizes CJK queries instead of requiring the whole phrase", () => {
  fs.writeFileSync(
    path.join(projectDir, "wiki", "tacit.md"),
    "---\ntitle: 知识管理\ntype: concept\n---\n\n这段笔记提到默会，但知识两字并不紧挨着默会。\n",
  )
  const result = searchOffline(projectDir, "默会知识")
  assert.ok(result.results.some((hit) => hit.path === "wiki/tacit.md"), "expected CJK bigram hits on a page that never contains the full phrase")
})

test("searchOffline splits typographic quotes like the desktop tokenizer", () => {
  fs.writeFileSync(
    path.join(projectDir, "wiki", "quoted.md"),
    "---\ntitle: Tacit knowledge\ntype: concept\n---\n\nA note about tacit knowledge.\n",
  )
  const result = searchOffline(projectDir, "“tacit knowledge”")
  assert.ok(result.results.some((hit) => hit.path === "wiki/quoted.md"))
})

function withAppState<T>(state: unknown, fn: () => T): T {
  const prevState = process.env.LLM_WIKI_APP_STATE
  const prevProject = process.env.LLM_WIKI_PROJECT_PATH
  const statePath = path.join(os.tmpdir(), `llm-wiki-app-state-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(statePath, JSON.stringify(state))
  process.env.LLM_WIKI_APP_STATE = statePath
  delete process.env.LLM_WIKI_PROJECT_PATH
  try {
    return fn()
  } finally {
    fs.rmSync(statePath, { force: true })
    if (prevState === undefined) delete process.env.LLM_WIKI_APP_STATE
    else process.env.LLM_WIKI_APP_STATE = prevState
    if (prevProject === undefined) delete process.env.LLM_WIKI_PROJECT_PATH
    else process.env.LLM_WIKI_PROJECT_PATH = prevProject
  }
}

test("resolveOfflineProjectPath maps a registry UUID to that project, not lastProject", () => {
  const alpha = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-alpha-"))
  const beta = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-beta-"))
  try {
    withAppState({
      lastProject: { id: "aaaa-aaaa", name: "Alpha", path: alpha },
      projectRegistry: {
        "aaaa-aaaa": { id: "aaaa-aaaa", name: "Alpha", path: alpha, lastOpened: 1 },
        "bbbb-bbbb": { id: "bbbb-bbbb", name: "Beta", path: beta, lastOpened: 2 },
      },
    }, () => {
      assert.equal(resolveOfflineProjectPath("bbbb-bbbb"), beta)
      assert.equal(resolveOfflineProjectPath("aaaa-aaaa"), alpha)
      assert.equal(resolveOfflineProjectPath("current"), alpha)
      const found = findOfflineProject("bbbb-bbbb")
      assert.equal(found?.id, "bbbb-bbbb")
      assert.equal(found?.name, "Beta")
    })
  } finally {
    fs.rmSync(alpha, { recursive: true, force: true })
    fs.rmSync(beta, { recursive: true, force: true })
  }
})

test("unknown project UUID does not silently fall through to lastProject or env", () => {
  const alpha = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-alpha-"))
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-env-"))
  try {
    withAppState({
      lastProject: { id: "aaaa-aaaa", name: "Alpha", path: alpha },
      projectRegistry: {
        "aaaa-aaaa": { id: "aaaa-aaaa", name: "Alpha", path: alpha, lastOpened: 1 },
      },
    }, () => {
      process.env.LLM_WIKI_PROJECT_PATH = envDir
      assert.equal(resolveOfflineProjectPath("missing-uuid"), null)
    })
  } finally {
    fs.rmSync(alpha, { recursive: true, force: true })
    fs.rmSync(envDir, { recursive: true, force: true })
  }
})

test("readProjectsFromAppState uses the registry key as id and includes recentProjects", () => {
  const alpha = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-alpha-"))
  const gamma = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-gamma-"))
  try {
    fs.mkdirSync(path.join(gamma, ".llm-wiki"), { recursive: true })
    fs.writeFileSync(path.join(gamma, ".llm-wiki", "project.json"), JSON.stringify({ id: "gggg-gggg" }))
    withAppState({
      lastProject: { id: "aaaa-aaaa", name: "Alpha", path: alpha },
      projectRegistry: {
        "aaaa-aaaa": { name: "Alpha", path: alpha, lastOpened: 1 },
      },
      recentProjects: [
        { name: "Gamma", path: gamma },
      ],
    }, () => {
      const projects = readProjectsFromAppState()
      const byId = Object.fromEntries(projects.map((p) => [p.id, p]))
      assert.equal(byId["aaaa-aaaa"]?.path, alpha)
      assert.equal(byId["aaaa-aaaa"]?.current, true)
      assert.equal(byId["gggg-gggg"]?.path, gamma)
      assert.equal(resolveOfflineProjectPath("gggg-gggg"), gamma)
    })
  } finally {
    fs.rmSync(alpha, { recursive: true, force: true })
    fs.rmSync(gamma, { recursive: true, force: true })
  }
})
