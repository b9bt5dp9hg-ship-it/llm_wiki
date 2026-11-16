export type KnowledgeTreeLoadOutcome<T> =
  | { status: "applied"; value: T }
  | { status: "stale" }

export function createKnowledgeTreeLoadSession() {
  let generation = 0

  return {
    invalidate() {
      generation += 1
    },
    async load<T>(loader: () => Promise<T>): Promise<KnowledgeTreeLoadOutcome<T>> {
      const token = ++generation
      try {
        const value = await loader()
        return token === generation
          ? { status: "applied", value }
          : { status: "stale" }
      } catch (error) {
        if (token !== generation) return { status: "stale" }
        throw error
      }
    },
  }
}
