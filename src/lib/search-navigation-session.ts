import { readFile } from "@/commands/fs"

export type SearchOpenOutcome =
  | { status: "applied"; path: string; content: string; token: number }
  | { status: "stale"; token: number }

export interface SearchJumpTarget {
  path: string
  scrollTarget: string
}

export type SearchJumpOutcome =
  | { status: "applied"; target: SearchJumpTarget; content: string; token: number }
  | { status: "stale"; token: number }

export function createSearchNavigationSession(
  readFileFn: (path: string) => Promise<string> = readFile,
) {
  let generation = 0
  return {
    invalidate() { generation += 1 },
    async open(path: string): Promise<SearchOpenOutcome> {
      const token = ++generation
      try {
        const content = await readFileFn(path)
        return token === generation
          ? { status: "applied", path, content, token }
          : { status: "stale", token }
      } catch (error) {
        if (token !== generation) return { status: "stale", token }
        throw error
      }
    },
    async jump(resolveTarget: () => Promise<SearchJumpTarget>): Promise<SearchJumpOutcome> {
      const token = ++generation
      try {
        const target = await resolveTarget()
        if (token !== generation) return { status: "stale", token }
        const content = await readFileFn(target.path)
        return token === generation
          ? { status: "applied", target, content, token }
          : { status: "stale", token }
      } catch (error) {
        if (token !== generation) return { status: "stale", token }
        throw error
      }
    },
  }
}
