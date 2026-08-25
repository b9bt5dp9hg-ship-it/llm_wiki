import { writeFile, readFile, createDirectory, listDirectory, deleteFile, fileExists } from "@/commands/fs"
import { normalizeReviewItems, type ReviewItem } from "@/stores/review-store"
import { normalizeLintItems, type LintItem } from "@/stores/lint-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import type { ChatAgentMode, ChatRetrievalMode } from "@/lib/chat-agent-types"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

async function ensureDir(projectPath: string): Promise<void> {
  await createDirectory(`${projectPath}/.llm-wiki`).catch(() => {})
  await createDirectory(`${projectPath}/.llm-wiki/chats`).catch(() => {})
}

export async function saveReviewItems(projectPath: string, items: ReviewItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/review.json`, JSON.stringify(items, null, 2))
}

export async function loadReviewItems(projectPath: string): Promise<ReviewItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/review.json`)
    return normalizeReviewItems(JSON.parse(content) as ReviewItem[])
  } catch {
    return []
  }
}

export async function saveLintItems(projectPath: string, items: LintItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/lint.json`, JSON.stringify(items, null, 2))
}

export async function loadLintItems(projectPath: string): Promise<LintItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/lint.json`)
    return normalizeLintItems(JSON.parse(content))
  } catch {
    return []
  }
}

interface PersistedChatData {
  conversations: Conversation[]
  messages: DisplayMessage[]
}

export interface ChatPreferences {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  agentMode: ChatAgentMode
  retrievalMode: ChatRetrievalMode
  selectedSkills: string[]
  disabledSkills: string[]
}

/** Generated chat IDs are `conv_<timestamp>_<rand>`; tests also use short slugs. */
const CONVERSATION_ID_MAX_LENGTH = 128
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const WINDOWS_RESERVED_CONVERSATION_ID = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * Conversation ids are used as a single filename under `.llm-wiki/chats/`.
 * Reject anything that is not a single safe path segment so a tampered
 * `conversations.json` or message payload cannot traverse out of that directory.
 */
export function isSafeConversationId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > CONVERSATION_ID_MAX_LENGTH) {
    return false
  }
  if (/[\x00-\x1f]/.test(id)) return false
  if (!SAFE_CONVERSATION_ID.test(id)) return false
  if (WINDOWS_RESERVED_CONVERSATION_ID.test(id)) return false
  return true
}

/** Case-insensitive filesystems treat `c1.json` and `C1.json` as one file. */
export function canonicalizeConversationId(id: string): string {
  return id.toLowerCase()
}

export function conversationChatFilePath(
  projectPath: string,
  conversationId: string,
): string | null {
  if (!isSafeConversationId(conversationId)) return null
  return `${normalizePath(projectPath)}/.llm-wiki/chats/${canonicalizeConversationId(conversationId)}.json`
}

function uniqueCanonicalConversations(conversations: Conversation[]): Conversation[] {
  const seen = new Set<string>()
  const out: Conversation[] = []
  for (const conversation of conversations) {
    if (!conversation || !isSafeConversationId(conversation.id)) continue
    const id = canonicalizeConversationId(conversation.id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(conversation.id === id ? conversation : { ...conversation, id })
  }
  return out
}

function stripPersistedMessageImages(msg: DisplayMessage): DisplayMessage {
  const withoutImages = (() => {
    if (!msg.images || msg.images.length === 0) return msg
    const { images: _images, ...rest } = msg
    return rest
  })()
  if (!withoutImages.agentFileChanges?.some((change) => "beforeContent" in change || "afterContent" in change)) {
    return withoutImages
  }
  return {
    ...withoutImages,
    agentFileChanges: withoutImages.agentFileChanges.map(({
      beforeContent: _before,
      afterContent: _after,
      ...change
    }) => change),
  }
}

export async function saveChatHistory(
  projectPath: string,
  conversations: Conversation[],
  messages: DisplayMessage[]
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)

  const safeConversations = uniqueCanonicalConversations(conversations)
  const keptIds = new Set(safeConversations.map((conversation) => conversation.id))

  // Save each conversation's messages separately
  const byConversation = new Map<string, DisplayMessage[]>()
  for (const msg of messages) {
    if (!isSafeConversationId(msg.conversationId)) continue
    const conversationId = canonicalizeConversationId(msg.conversationId)
    if (!keptIds.has(conversationId)) continue
    const list = byConversation.get(conversationId) ?? []
    // Images can be multi-megabyte base64 payloads. Keep them in memory for the
    // current chat turn, but don't persist them into chat JSON where they would
    // quickly bloat auto-save files and project backups.
    list.push({ ...stripPersistedMessageImages(msg), conversationId })
    byConversation.set(conversationId, list)
  }

  for (const [convId, msgs] of byConversation) {
    const chatPath = conversationChatFilePath(pp, convId)
    if (!chatPath) continue
    // Keep last 100 messages per conversation
    const toSave = msgs.slice(-100)
    await writeFile(chatPath, JSON.stringify(toSave, null, 2))
  }

  // Drop files for conversations no longer in the index *before* rewriting
  // conversations.json. Otherwise an in-memory delete plus a failed file
  // unlink leaves an orphan that loadChatHistory will resurrect.
  await pruneRemovedChatFiles(pp, keptIds)

  await writeFile(
    `${pp}/.llm-wiki/conversations.json`,
    JSON.stringify(safeConversations, null, 2)
  )
}

/**
 * Delete the on-disk chat file for a conversation. Missing files are
 * already gone. Callers must not drop the in-memory conversation until
 * this resolves — a swallowed failure plus auto-save would empty the
 * index while orphan recovery brings the chat back.
 */
export async function deletePersistedConversation(
  projectPath: string,
  conversationId: string,
): Promise<void> {
  const chatPath = conversationChatFilePath(projectPath, conversationId)
  if (!chatPath) return
  if (!(await fileExists(chatPath))) return
  await deleteFile(chatPath)
}

/** Remove a conversation from disk first, then from memory. */
export async function discardConversation(
  projectPath: string | undefined | null,
  conversationId: string,
  removeFromStore: (id: string) => void,
): Promise<void> {
  if (projectPath) {
    await deletePersistedConversation(projectPath, conversationId)
  }
  removeFromStore(conversationId)
}

async function pruneRemovedChatFiles(
  projectPath: string,
  keptIds: Set<string>,
): Promise<void> {
  let files: FileNode[]
  try {
    files = flattenFiles(await listDirectory(`${projectPath}/.llm-wiki/chats`))
  } catch {
    return
  }

  const canonicalKept = new Set(
    [...keptIds]
      .filter((id) => isSafeConversationId(id))
      .map((id) => canonicalizeConversationId(id)),
  )
  for (const file of files) {
    if (file.is_dir || !file.name.toLowerCase().endsWith(".json")) continue
    const id = file.name.replace(/\.json$/i, "")
    if (!isSafeConversationId(id)) continue
    if (canonicalKept.has(canonicalizeConversationId(id))) continue
    const chatPath = conversationChatFilePath(projectPath, id)
    if (!chatPath) continue
    await deleteFile(chatPath)
  }
}

export async function loadChatHistory(projectPath: string): Promise<PersistedChatData> {
  const pp = normalizePath(projectPath)
  try {
    // Try new format: separate files per conversation
    const convContent = await readFile(`${pp}/.llm-wiki/conversations.json`)
    const parsedConversations = JSON.parse(convContent) as Conversation[]
    const conversations = uniqueCanonicalConversations(
      Array.isArray(parsedConversations) ? parsedConversations : [],
    )

    const allMessages: DisplayMessage[] = []
    for (const conv of conversations) {
      const msgs = await readConversationMessages(pp, conv.id)
      if (!msgs) continue
      allMessages.push(...msgs)
    }

    if (conversations.length > 0 || allMessages.length > 0) {
      return { conversations, messages: allMessages }
    }

    // A previous startup race could overwrite conversations.json with [] while
    // leaving .llm-wiki/chats/<id>.json intact. Rebuild a minimal conversation
    // index from those orphan message files so users do not have to recreate
    // chat sessions manually.
    const recovered = await recoverChatHistoryFromOrphanChatFiles(pp)
    if (recovered.conversations.length > 0) return recovered
    return { conversations, messages: allMessages }
  } catch {
    const recovered = await recoverChatHistoryFromOrphanChatFiles(pp)
    if (recovered.conversations.length > 0) return recovered

    // Fall back to old format
    try {
      const content = await readFile(`${pp}/.llm-wiki/chat-history.json`)
      const parsed = JSON.parse(content)

      if (Array.isArray(parsed)) {
        // Very old format: flat array
        const legacyMessages = parsed as DisplayMessage[]
        const defaultConv: Conversation = {
          id: "default",
          title: "Previous Conversations",
          createdAt: legacyMessages[0]?.timestamp ?? Date.now(),
          updatedAt: legacyMessages[legacyMessages.length - 1]?.timestamp ?? Date.now(),
        }
        const migratedMessages = legacyMessages.map((m) => ({
          ...m,
          conversationId: "default",
        }))
        return { conversations: [defaultConv], messages: migratedMessages }
      }

      // Old combined format
      const data = parsed as PersistedChatData
      return data
    } catch {
      return { conversations: [], messages: [] }
    }
  }
}

async function readConversationMessages(
  projectPath: string,
  conversationId: string,
): Promise<DisplayMessage[] | null> {
  const chatPath = conversationChatFilePath(projectPath, conversationId)
  if (!chatPath) return null
  try {
    const msgContent = await readFile(chatPath)
    const msgs = JSON.parse(msgContent) as DisplayMessage[]
    if (!Array.isArray(msgs)) return null
    return msgs.map((message) => ({
      ...message,
      conversationId: canonicalizeConversationId(conversationId),
    }))
  } catch {
    return null
  }
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      out.push(...flattenFiles(node.children ?? []))
    } else {
      out.push(node)
    }
  }
  return out
}

function conversationFromMessages(id: string, messages: DisplayMessage[]): Conversation | null {
  if (messages.length === 0) return null
  const timestamps = messages
    .map((message) => message.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp))
  const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : Date.now()
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : createdAt
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim())
  return {
    id,
    title: firstUser?.content.slice(0, 50) || "Previous Conversation",
    createdAt,
    updatedAt,
  }
}

async function recoverChatHistoryFromOrphanChatFiles(projectPath: string): Promise<PersistedChatData> {
  try {
    const chatDir = `${projectPath}/.llm-wiki/chats`
    const files = flattenFiles(await listDirectory(chatDir))
      .filter((node) => node.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
    const conversations: Conversation[] = []
    const allMessages: DisplayMessage[] = []
    const seen = new Set<string>()

    for (const file of files) {
      try {
        const raw = await readFile(file.path)
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) continue
        const rawId = file.name.replace(/\.json$/i, "")
        if (!isSafeConversationId(rawId)) continue
        const id = canonicalizeConversationId(rawId)
        if (seen.has(id)) continue
        seen.add(id)
        const messages = (parsed as DisplayMessage[])
          .filter((message) => message && typeof message === "object")
          .map((message) => ({
            ...message,
            conversationId: id,
          }))
        const conversation = conversationFromMessages(id, messages)
        if (!conversation) continue
        conversations.push(conversation)
        allMessages.push(...messages)
      } catch {
        // Ignore one corrupt chat file and continue recovering the others.
      }
    }

    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    return { conversations, messages: allMessages }
  } catch {
    return { conversations: [], messages: [] }
  }
}

export async function saveChatPreferences(
  projectPath: string,
  preferences: ChatPreferences,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/chat-preferences.json`, JSON.stringify(preferences, null, 2))
}

export async function loadChatPreferences(projectPath: string): Promise<ChatPreferences> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/chat-preferences.json`)
    const parsed = JSON.parse(content) as Partial<ChatPreferences>
    return {
      useWebSearch: parsed.useWebSearch === true,
      useAnyTxtSearch: parsed.useAnyTxtSearch === true,
      agentMode: normalizePersistedAgentMode(parsed.agentMode),
      retrievalMode: normalizePersistedRetrievalMode(parsed.retrievalMode),
      selectedSkills: normalizePersistedSkillList(parsed.selectedSkills),
      disabledSkills: normalizePersistedSkillList(parsed.disabledSkills),
    }
  } catch {
    return {
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard",
      retrievalMode: "standard",
      selectedSkills: [],
      disabledSkills: [],
    }
  }
}

function normalizePersistedSkillList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
}

function normalizePersistedAgentMode(value: unknown): ChatAgentMode {
  switch (value) {
    case "fast":
    case "standard":
    case "deep":
    case "local_first":
      return value
    default:
      return "standard"
  }
}

function normalizePersistedRetrievalMode(value: unknown): ChatRetrievalMode {
  return value === "smart" || value === "faithful" ? value : "standard"
}
