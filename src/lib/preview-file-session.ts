import { readFile, writeFile } from "@/commands/fs"

export type PreviewFileLoadOutcome =
  | { status: "applied"; path: string; content: string; token: number }
  | { status: "cleared"; token: number }
  | { status: "stale"; token: number }

export type PreviewFileWriteOutcome =
  | { status: "applied"; path: string; content: string; token: number }
  | { status: "stale"; token: number }

function createSerialQueue(): { enqueue: <T>(job: () => Promise<T>) => Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  return {
    enqueue<T>(job: () => Promise<T>): Promise<T> {
      pending++
      let run: Promise<T>
      if (pending === 1) {
        try {
          run = Promise.resolve(job())
        } catch (err) {
          run = Promise.reject(err) as Promise<T>
        }
      } else {
        run = tail.then(job, job)
      }
      tail = run.then(
        () => { pending-- },
        () => { pending-- },
      )
      return run
    },
  }
}

/**
 * Latest-wins guard for overlapping preview reads, plus a serial write
 * queue. A slower older readFile must not replace the currently selected
 * file's editor body, and a slower older writeFile must not persist after
 * a newer save of the same path.
 */
export function createPreviewFileSession(
  readFileFn: (path: string) => Promise<string> = readFile,
  writeFileFn: (path: string, content: string) => Promise<void> = writeFile,
) {
  let generation = 0
  let writeGeneration = 0
  let activePath: string | null = null
  const writes = createSerialQueue()

  return {
    get generation() {
      return generation
    },
    activate(path: string | null) {
      if (activePath === path) return
      activePath = path
      generation += 1
      writeGeneration += 1
    },
    invalidate() {
      generation += 1
    },
    isCurrent(token: number) {
      return token === generation
    },
    async load(path: string | null): Promise<PreviewFileLoadOutcome> {
      activePath = path
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
    write(path: string, content: string): Promise<PreviewFileWriteOutcome> {
      const token = ++writeGeneration
      return writes.enqueue(async () => {
        try {
          await writeFileFn(path, content)
        } catch (error) {
          if (token !== writeGeneration || activePath !== path) {
            return { status: "stale", token }
          }
          throw error
        }
        return token === writeGeneration && activePath === path
          ? { status: "applied", path, content, token }
          : { status: "stale", token }
      })
    },
  }
}
