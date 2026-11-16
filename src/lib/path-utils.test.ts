import { describe, it, expect } from "vitest"
import {
  normalizePath,
  joinPath,
  getFileName,
  getFileStem,
  getRelativePath,
  isAbsolutePath,
  confineWikiFilePath,
  confinePreviewFilePath,
  confineProjectFilePath,
  previewFilePathCandidates,
} from "./path-utils"

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("C:\\Users\\foo\\bar")).toBe("C:/Users/foo/bar")
  })

  it("leaves forward slash paths unchanged", () => {
    expect(normalizePath("/Users/foo/bar")).toBe("/Users/foo/bar")
  })

  it("handles mixed separators", () => {
    expect(normalizePath("C:\\mixed/path\\here")).toBe("C:/mixed/path/here")
  })

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("")
  })

  it("doesn't collapse consecutive slashes (by design)", () => {
    // normalizePath only does separator replacement, not deduplication
    expect(normalizePath("a\\\\b")).toBe("a//b")
  })
})

describe("joinPath", () => {
  it("joins simple segments with forward slashes", () => {
    expect(joinPath("a", "b", "c")).toBe("a/b/c")
  })

  it("collapses duplicate slashes at the join boundary", () => {
    expect(joinPath("a/", "/b", "c")).toBe("a/b/c")
  })

  it("normalizes backslashes inside segments", () => {
    expect(joinPath("C:\\Users", "foo", "bar")).toBe("C:/Users/foo/bar")
  })

  it("preserves a leading slash", () => {
    expect(joinPath("/abs", "path")).toBe("/abs/path")
  })

  it("joins a single segment", () => {
    expect(joinPath("only")).toBe("only")
  })
})

describe("getFileName", () => {
  it("returns the last segment of a POSIX path", () => {
    expect(getFileName("/a/b/c.md")).toBe("c.md")
  })

  it("returns the last segment of a Windows path", () => {
    expect(getFileName("C:\\Users\\foo\\bar.pdf")).toBe("bar.pdf")
  })

  it("returns the original string when no separators", () => {
    expect(getFileName("solo.md")).toBe("solo.md")
  })

  it("returns empty string when path ends with separator", () => {
    expect(getFileName("/dir/")).toBe("")
  })
})

describe("getFileStem", () => {
  it("strips a single extension", () => {
    expect(getFileStem("/a/b/note.md")).toBe("note")
  })

  it("strips only the LAST extension for double extensions", () => {
    expect(getFileStem("archive.tar.gz")).toBe("archive.tar")
  })

  it("returns the name unchanged for dotfiles (leading dot)", () => {
    // lastDot > 0 — so .env stays as .env
    expect(getFileStem(".env")).toBe(".env")
  })

  it("works across separators", () => {
    expect(getFileStem("C:\\dir\\notes.txt")).toBe("notes")
  })

  it("handles names with no extension", () => {
    expect(getFileStem("README")).toBe("README")
  })
})

describe("getRelativePath", () => {
  it("strips the base prefix", () => {
    expect(getRelativePath("/project/wiki/note.md", "/project")).toBe("wiki/note.md")
  })

  it("handles base with trailing slash", () => {
    expect(getRelativePath("/project/wiki/note.md", "/project/")).toBe("wiki/note.md")
  })

  it("normalizes separators on both sides", () => {
    expect(getRelativePath("C:\\project\\wiki\\note.md", "C:\\project")).toBe("wiki/note.md")
  })

  it("returns the full path if base doesn't prefix it", () => {
    expect(getRelativePath("/other/path", "/project")).toBe("/other/path")
  })

  it("requires an exact segment boundary (not just prefix match)", () => {
    // '/projector' should NOT be considered a base of '/project...'
    // The impl adds '/' to base for matching, so this is handled.
    expect(getRelativePath("/projector/a", "/project")).toBe("/projector/a")
  })

  it("matches Windows drive-letter paths case-insensitively", () => {
    expect(getRelativePath("c:/users/me/inbox/sub/report.pdf", "C:/Users/Me/Inbox")).toBe(
      "sub/report.pdf",
    )
  })

  it("matches Windows UNC paths case-insensitively", () => {
    expect(getRelativePath("//server/SHARE/sub/file.md", "//SERVER/share")).toBe("sub/file.md")
  })

  it("does not derive the relative offset from case-folded character length", () => {
    expect(getRelativePath("c:/i\u0307/sub/file.md", "C:/\u0130")).toBe("sub/file.md")
  })

  it("keeps Unix paths case-sensitive", () => {
    expect(getRelativePath("/Project/wiki/note.md", "/project")).toBe("/Project/wiki/note.md")
  })
})

describe("isAbsolutePath", () => {
  it("recognizes Unix absolute paths", () => {
    expect(isAbsolutePath("/")).toBe(true)
    expect(isAbsolutePath("/home/user")).toBe(true)
    expect(isAbsolutePath("/a/b/c.md")).toBe(true)
  })

  it("recognizes Windows drive-letter paths with both separators", () => {
    expect(isAbsolutePath("C:\\Users\\nash")).toBe(true)
    expect(isAbsolutePath("C:/Users/nash")).toBe(true)
    expect(isAbsolutePath("D:\\")).toBe(true)
    expect(isAbsolutePath("z:/project/file.pdf")).toBe(true)
  })

  it("recognizes Windows UNC paths", () => {
    expect(isAbsolutePath("\\\\server\\share")).toBe(true)
    expect(isAbsolutePath("//server/share")).toBe(true)
  })

  it("rejects relative paths", () => {
    expect(isAbsolutePath("")).toBe(false)
    expect(isAbsolutePath("foo")).toBe(false)
    expect(isAbsolutePath("foo/bar.md")).toBe(false)
    expect(isAbsolutePath("./foo")).toBe(false)
    expect(isAbsolutePath("../foo")).toBe(false)
    expect(isAbsolutePath("wiki/concepts/attention.md")).toBe(false)
  })

  it("rejects drive-letter WITHOUT a separator (ambiguous)", () => {
    // "C:foo" is a Windows drive-relative path, not absolute.
    expect(isAbsolutePath("C:foo")).toBe(false)
  })
})

describe("confineWikiFilePath", () => {
  const PROJECT = "/Users/me/MyWiki"

  it("accepts an in-wiki markdown path, absolute or wiki-relative", () => {
    expect(confineWikiFilePath(PROJECT, `${PROJECT}/wiki/entities/foo.md`)).toBe(
      `${PROJECT}/wiki/entities/foo.md`,
    )
    expect(confineWikiFilePath(PROJECT, "entities/foo.md")).toBe(
      `${PROJECT}/wiki/entities/foo.md`,
    )
  })

  it("rejects a delete target outside the project", () => {
    expect(confineWikiFilePath(PROJECT, "/etc/passwd")).toBeNull()
    expect(confineWikiFilePath(PROJECT, "/etc/passwd.md")).toBeNull()
  })

  it("rejects a path that shares the project prefix but climbs out via ..", () => {
    expect(confineWikiFilePath(PROJECT, `${PROJECT}/wiki/../.llm-wiki/project.json`)).toBeNull()
    expect(confineWikiFilePath(PROJECT, `${PROJECT}/wiki/../../.ssh/id_rsa.md`)).toBeNull()
    expect(confineWikiFilePath(PROJECT, "concepts/../../../etc/passwd.md")).toBeNull()
  })

  it("rejects a sibling directory that only shares the wiki prefix", () => {
    expect(confineWikiFilePath(PROJECT, `${PROJECT}/wiki-secret/foo.md`)).toBeNull()
  })

  it("rejects the wiki root and extension-less directory targets", () => {
    expect(confineWikiFilePath(PROJECT, `${PROJECT}/wiki`)).toBeNull()
    expect(confineWikiFilePath(PROJECT, `${PROJECT}/wiki/entities`)).toBeNull()
    expect(confineWikiFilePath(PROJECT, `${PROJECT}/wiki/media/slug`)).toBeNull()
  })

  it("accepts an in-wiki Windows path and rejects a drive-letter escape", () => {
    expect(
      confineWikiFilePath("C:/Users/me/MyWiki", "C:/Users/me/MyWiki/wiki/queries/a.md"),
    ).toBe("C:/Users/me/MyWiki/wiki/queries/a.md")
    expect(
      confineWikiFilePath("C:/Users/me/MyWiki", "C:/Users/me/MyWiki/wiki/../.llm-wiki/project.json"),
    ).toBeNull()
  })
})

describe("confinePreviewFilePath", () => {
  const PROJECT = "/Users/me/MyWiki"

  it("accepts wiki-relative, wiki/-prefixed, and in-project absolute wiki paths", () => {
    expect(confinePreviewFilePath(PROJECT, "entities/foo.md")).toBe(
      `${PROJECT}/wiki/entities/foo.md`,
    )
    expect(confinePreviewFilePath(PROJECT, "wiki/entities/foo.md")).toBe(
      `${PROJECT}/wiki/entities/foo.md`,
    )
    expect(confinePreviewFilePath(PROJECT, `${PROJECT}/wiki/queries/a.md`)).toBe(
      `${PROJECT}/wiki/queries/a.md`,
    )
  })

  it("accepts raw/sources paths used by review source previews", () => {
    expect(confinePreviewFilePath(PROJECT, "raw/sources/paper.pdf")).toBe(
      `${PROJECT}/raw/sources/paper.pdf`,
    )
    expect(confinePreviewFilePath(PROJECT, `${PROJECT}/raw/sources/paper.pdf`)).toBe(
      `${PROJECT}/raw/sources/paper.pdf`,
    )
  })

  it("treats a bare raw or wiki stem as a wiki page name, not the tree root", () => {
    expect(confinePreviewFilePath(PROJECT, "raw")).toBe(`${PROJECT}/wiki/raw`)
    expect(confinePreviewFilePath(PROJECT, "wiki")).toBe(`${PROJECT}/wiki/wiki`)
  })

  it("rejects a prefix-matching absolute path that climbs out via ..", () => {
    // Review open: previously used startsWith(projectPath), so this leaked.
    expect(
      confinePreviewFilePath(PROJECT, `${PROJECT}/wiki/../.llm-wiki/project.json`),
    ).toBeNull()
    expect(
      confinePreviewFilePath(PROJECT, `${PROJECT}/wiki/../../.ssh/id_rsa.md`),
    ).toBeNull()
    expect(confinePreviewFilePath(PROJECT, "concepts/../../../etc/passwd.md")).toBeNull()
  })

  it("rejects a sibling directory that only shares the project prefix", () => {
    expect(confinePreviewFilePath(PROJECT, `${PROJECT}Secret/wiki/foo.md`)).toBeNull()
  })

  it("rejects .llm-wiki and other project-root files even when they sit under the project", () => {
    expect(confinePreviewFilePath(PROJECT, `${PROJECT}/.llm-wiki/chats/c1.json`)).toBeNull()
    expect(confinePreviewFilePath(PROJECT, `${PROJECT}/schema.md`)).toBeNull()
    expect(confinePreviewFilePath(PROJECT, "../../.llm-wiki/project.json")).toBeNull()
  })

  it("rejects outside absolute paths and the wiki/raw roots themselves", () => {
    expect(confinePreviewFilePath(PROJECT, "/etc/passwd")).toBeNull()
    expect(confinePreviewFilePath(PROJECT, "/etc/passwd.md")).toBeNull()
    expect(confinePreviewFilePath(PROJECT, `${PROJECT}/wiki`)).toBeNull()
    expect(confinePreviewFilePath(PROJECT, `${PROJECT}/raw`)).toBeNull()
  })

  it("accepts an in-project Windows preview path and rejects a drive-letter escape", () => {
    expect(
      confinePreviewFilePath("C:/Users/me/MyWiki", "C:/Users/me/MyWiki/wiki/queries/a.md"),
    ).toBe("C:/Users/me/MyWiki/wiki/queries/a.md")
    expect(
      confinePreviewFilePath(
        "C:/Users/me/MyWiki",
        "C:/Users/me/MyWiki/wiki/../.llm-wiki/project.json",
      ),
    ).toBeNull()
  })
})

describe("previewFilePathCandidates", () => {
  const PROJECT = "/Users/me/MyWiki"

  it("adds a .md sibling only when the confined path has no markdown extension", () => {
    expect(previewFilePathCandidates(PROJECT, "entities/foo")).toEqual([
      `${PROJECT}/wiki/entities/foo`,
      `${PROJECT}/wiki/entities/foo.md`,
    ])
    expect(previewFilePathCandidates(PROJECT, "entities/foo.md")).toEqual([
      `${PROJECT}/wiki/entities/foo.md`,
    ])
  })

  it("returns no candidates for a path that escapes the project", () => {
    expect(
      previewFilePathCandidates(PROJECT, `${PROJECT}/wiki/../.llm-wiki/project.json`),
    ).toEqual([])
    expect(previewFilePathCandidates(PROJECT, "../../../etc/passwd")).toEqual([])
  })
})

describe("confineProjectFilePath", () => {
  const PROJECT = "/Users/me/MyWiki"

  it("joins relative wiki and agent-workspace paths under the project", () => {
    expect(confineProjectFilePath(PROJECT, "wiki/entities/foo.md")).toBe(
      `${PROJECT}/wiki/entities/foo.md`,
    )
    expect(confineProjectFilePath(PROJECT, "agent-workspace/cover.png")).toBe(
      `${PROJECT}/agent-workspace/cover.png`,
    )
    expect(confineProjectFilePath(PROJECT, "purpose.md")).toBe(`${PROJECT}/purpose.md`)
  })

  it("keeps an already-absolute in-project file", () => {
    expect(confineProjectFilePath(PROJECT, `${PROJECT}/raw/sources/paper.pdf`)).toBe(
      `${PROJECT}/raw/sources/paper.pdf`,
    )
  })

  it("rejects absolute paths outside the project", () => {
    expect(confineProjectFilePath(PROJECT, "/etc/passwd")).toBeNull()
    expect(confineProjectFilePath(PROJECT, "/Users/me/.ssh/id_rsa")).toBeNull()
  })

  it("rejects a prefix-matching path that climbs out via ..", () => {
    expect(
      confineProjectFilePath(PROJECT, `${PROJECT}/wiki/../.llm-wiki/chats/c1.json`),
    ).toBeNull()
    expect(
      confineProjectFilePath(PROJECT, `${PROJECT}/agent-workspace/../../.ssh/id_rsa`),
    ).toBeNull()
    expect(confineProjectFilePath(PROJECT, "../.ssh/id_rsa")).toBeNull()
  })

  it("rejects a sibling directory that only shares the project prefix", () => {
    expect(confineProjectFilePath(PROJECT, `${PROJECT}Secret/wiki/foo.md`)).toBeNull()
  })

  it("rejects the project root itself", () => {
    expect(confineProjectFilePath(PROJECT, PROJECT)).toBeNull()
    expect(confineProjectFilePath(PROJECT, ".")).toBeNull()
  })

  it("accepts an in-project Windows path and rejects a drive-letter escape", () => {
    expect(
      confineProjectFilePath("C:/Users/me/MyWiki", "C:/Users/me/MyWiki/agent-workspace/a.svg"),
    ).toBe("C:/Users/me/MyWiki/agent-workspace/a.svg")
    expect(
      confineProjectFilePath("C:/Users/me/MyWiki", "C:/Windows/System32/config"),
    ).toBeNull()
  })
})
