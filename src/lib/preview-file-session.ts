import { readFile } from "@/commands/fs"

export type PreviewFileLoadOutcome =
  | { status: "applied"; path: string; content: string; token: number }
  | { status: "cleared"; token: number }
  | { status: "stale"; token: number }

/**
 * Latest-wins guard for overlapping preview reads. A slower older
 * readFile must not replace the currently selected file's editor body.
 */
export function createPreviewFileSession(
  readFileFn: (path: string) => Promise<string> = readFile,
) {
  let generation = 0

  return {
    get generation() {
      return generation
    },
    invalidate() {
      generation += 1
    },
    isCurrent(token: number) {
      return token === generation
    },
    async load(path: string | null): Promise<PreviewFileLoadOutcome> {
      const token = ++generation
      if (!path) {
        return token === generation
          ? { status: "cleared", token }
          : { status: "stale", token }
      }
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
  }
}
