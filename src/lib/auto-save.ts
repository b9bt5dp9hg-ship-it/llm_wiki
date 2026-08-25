import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { saveReviewItems, saveLintItems, saveChatHistory, saveChatPreferences } from "./persist"

let reviewTimer: ReturnType<typeof setTimeout> | null = null
let lintTimer: ReturnType<typeof setTimeout> | null = null
let chatTimer: ReturnType<typeof setTimeout> | null = null

// While suspended, the store subscriptions skip writing. This is essential
// during a project switch: resetProjectState() clears every store to empty,
// and without this guard the debounced callbacks would persist those empty
// arrays back to the OUTGOING project's .llm-wiki/*.json — wiping its pending
// review / deep-research items. The switch flow flushes real data to disk via
// flushAndSuspendAutoSave() first, then resumes once the new project loads.
let suspended = false

function clearTimers(): void {
  if (reviewTimer) { clearTimeout(reviewTimer); reviewTimer = null }
  if (lintTimer) { clearTimeout(lintTimer); lintTimer = null }
  if (chatTimer) { clearTimeout(chatTimer); chatTimer = null }
}

function persistErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Immediately persist the current stores to the current project, then stop
 * auto-save from firing until resumeAutoSave() is called. Must be invoked
 * before resetProjectState() clears the stores on a project switch.
 * Throws if any persist step fails and re-arms auto-save so the still-open
 * project is not left unsaved and then emptied.
 */
export async function flushAndSuspendAutoSave(): Promise<void> {
  suspended = true
  clearTimers()
  const projectPath = useWikiStore.getState().project?.path
  if (!projectPath) return
  const review = useReviewStore.getState().items
  const lint = useLintStore.getState().items
  const chat = useChatStore.getState()
  const jobs: Array<[string, Promise<unknown>]> = [
    ["review", saveReviewItems(projectPath, review)],
    ["lint", saveLintItems(projectPath, lint)],
    ["chat preferences", saveChatPreferences(projectPath, {
      useWebSearch: chat.useWebSearch,
      useAnyTxtSearch: chat.useAnyTxtSearch,
      agentMode: chat.agentMode,
      retrievalMode: chat.retrievalMode,
      selectedSkills: chat.selectedSkills,
      disabledSkills: chat.disabledSkills,
    })],
  ]
  if (!chat.isStreaming) {
    jobs.push(["chat history", saveChatHistory(projectPath, chat.conversations, chat.messages)])
  }
  const results = await Promise.allSettled(jobs.map(([, job]) => job))
  const failures = results.flatMap((result, i) => {
    if (result.status === "fulfilled") return []
    return [`${jobs[i][0]}: ${persistErrorMessage(result.reason)}`]
  })
  if (failures.length > 0) {
    // Stay on the current project: resume so later edits still persist, and
    // surface the failure so callers do not empty in-memory state as if the
    // flush had succeeded.
    suspended = false
    throw new Error(`Failed to flush auto-save before project switch: ${failures.join("; ")}`)
  }
}

export function resumeAutoSave(): void {
  suspended = false
}

/**
 * Run a project-switch/open operation while auto-save is suspended. If the
 * operation fails, onFailure runs before auto-save resumes so callers can clear
 * any half-loaded project path before store changes are allowed to persist.
 */
export async function runWithSuspendedAutoSave<T>(
  action: () => Promise<T>,
  onFailure?: () => void,
): Promise<T> {
  await flushAndSuspendAutoSave()
  try {
    return await action()
  } catch (err) {
    try {
      onFailure?.()
    } catch (cleanupErr) {
      console.warn("Failed to clean up after suspended auto-save operation:", cleanupErr)
    }
    throw err
  } finally {
    resumeAutoSave()
  }
}

export function setupAutoSave(): void {
  // Auto-save review items (debounced 1s)
  useReviewStore.subscribe((state) => {
    if (suspended) return
    const projectPath = useWikiStore.getState().project?.path
    if (reviewTimer) clearTimeout(reviewTimer)
    reviewTimer = setTimeout(() => {
      if (projectPath) {
        saveReviewItems(projectPath, state.items).catch(() => {})
      }
    }, 1000)
  })

  // Auto-save lint items (debounced 1s)
  useLintStore.subscribe((state) => {
    if (suspended) return
    const projectPath = useWikiStore.getState().project?.path
    if (lintTimer) clearTimeout(lintTimer)
    lintTimer = setTimeout(() => {
      if (projectPath) {
        saveLintItems(projectPath, state.items).catch(() => {})
      }
    }, 1000)
  })

  // Auto-save chat conversations and messages (debounced 2s, skip during streaming)
  useChatStore.subscribe((state) => {
    if (suspended) return
    if (state.isStreaming) {
      // Drop a timer queued before streaming started. Otherwise a chat
      // deleted during the stream is rewritten from that stale snapshot.
      if (chatTimer) {
        clearTimeout(chatTimer)
        chatTimer = null
      }
      return
    }
    const projectPath = useWikiStore.getState().project?.path
    if (chatTimer) clearTimeout(chatTimer)
    chatTimer = setTimeout(() => {
      if (projectPath) {
        Promise.allSettled([
          saveChatPreferences(projectPath, {
            useWebSearch: state.useWebSearch,
            useAnyTxtSearch: state.useAnyTxtSearch,
            agentMode: state.agentMode,
            retrievalMode: state.retrievalMode,
            selectedSkills: state.selectedSkills,
            disabledSkills: state.disabledSkills,
          }),
          saveChatHistory(projectPath, state.conversations, state.messages),
        ]).catch(() => {})
      }
    }, 2000)
  })
}
