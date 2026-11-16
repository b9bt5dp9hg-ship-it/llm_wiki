import { listFileHistory, restoreFileHistory, type FileHistoryEntry } from "@/commands/fs"

export type FileHistoryListOutcome =
  | { status: "applied"; entries: FileHistoryEntry[]; token: number }
  | { status: "stale"; token: number }

export type FileHistoryRestoreOutcome =
  | { status: "applied"; content: string; token: number }
  | { status: "stale"; token: number }

export function createFileHistorySession(
  listFn: (projectPath: string, filePath: string) => Promise<FileHistoryEntry[]> = listFileHistory,
  restoreFn: (projectPath: string, filePath: string, historyId: string) => Promise<string> = restoreFileHistory,
) {
  let generation = 0
  let restoreTail: Promise<unknown> = Promise.resolve()

  function enqueueRestore<T>(job: () => Promise<T>): Promise<T> {
    const run = restoreTail.then(job, job)
    restoreTail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    get generation() { return generation },
    invalidate() { generation += 1 },
    isCurrent(token: number) { return token === generation },
    async list(projectPath: string, filePath: string): Promise<FileHistoryListOutcome> {
      const token = ++generation
      try {
        const entries = await listFn(projectPath, filePath)
        return token === generation
          ? { status: "applied", entries, token }
          : { status: "stale", token }
      } catch (error) {
        if (token !== generation) return { status: "stale", token }
        throw error
      }
    },
    async restore(projectPath: string, filePath: string, historyId: string): Promise<FileHistoryRestoreOutcome> {
      const token = ++generation
      return enqueueRestore(async () => {
        try {
          const content = await restoreFn(projectPath, filePath, historyId)
          return token === generation
            ? { status: "applied", content, token }
            : { status: "stale", token }
        } catch (error) {
          if (token !== generation) return { status: "stale", token }
          throw error
        }
      })
    },
  }
}
