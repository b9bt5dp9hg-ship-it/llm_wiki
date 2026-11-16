/**
 * Shared wiki/index.md and wiki/log.md appends for Save-to-Wiki and
 * review page creation. Those read-modify-writes must serialize with
 * each other and with ingest commits that hold the per-project lock.
 */
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"

export interface WikiIndexEntry {
  sectionHeader: string
  line: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function insertIndexEntries(indexContent: string, entries: readonly WikiIndexEntry[]): string {
  let next = indexContent
  for (const { sectionHeader, line } of entries) {
    const heading = sectionHeader.trim()
    const markdownLine = line.trim()
    if (!heading || !markdownLine) continue
    if (next.includes(heading)) {
      const replaced = next.replace(
        new RegExp(`(${escapeRegExp(heading)}\\n)`),
        `$1${markdownLine}\n`,
      )
      next = replaced === next
        ? `${next.trimEnd()}\n${markdownLine}\n`
        : replaced
    } else {
      next = `${next.trimEnd()}\n\n${heading}\n${markdownLine}\n`
    }
  }
  return next
}

async function appendWikiIndexEntriesUnlocked(
  projectPath: string,
  entries: readonly WikiIndexEntry[],
): Promise<void> {
  if (entries.length === 0) return
  const indexPath = `${projectPath}/wiki/index.md`
  let indexContent = "# Wiki Index\n"
  try {
    indexContent = await readFile(indexPath)
  } catch {
    // create on first save
  }
  await writeFile(indexPath, insertIndexEntries(indexContent, entries))
}

async function appendWikiLogLineUnlocked(projectPath: string, logLine: string): Promise<void> {
  const line = logLine.trim()
  if (!line) return
  const logPath = `${projectPath}/wiki/log.md`
  let logContent = "# Wiki Log\n"
  try {
    logContent = await readFile(logPath)
  } catch {
    // create on first save
  }
  await writeFile(logPath, `${logContent.trimEnd()}\n${line}\n`)
}

export async function appendWikiIndexAndLog(
  projectPath: string,
  entries: readonly WikiIndexEntry[],
  logLine: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await withProjectLock(pp, async () => {
    await appendWikiIndexEntriesUnlocked(pp, entries)
    await appendWikiLogLineUnlocked(pp, logLine)
  })
}
