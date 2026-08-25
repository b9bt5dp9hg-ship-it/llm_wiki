/**
 * Project identity: stable UUID per project + global registry mapping
 * `UUID → current filesystem path`.
 *
 * Why: absolute paths are unstable (users move / rename project folders).
 * Queue tasks reference projects by UUID and look up the current path
 * via the registry at run time, so a moved folder doesn't orphan tasks.
 *
 * Storage:
 * - Per-project identity: `{project}/.llm-wiki/project.json`
 *     `{ "id": "<uuid>", "createdAt": <ms> }`
 * - Global registry: Tauri plugin-store `app-state.json` key `projectRegistry`
 *     `{ [id]: { id, path, name, lastOpened } }`
 */

import { load } from "@tauri-apps/plugin-store"
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

const STORE_NAME = "app-state.json"
const REGISTRY_KEY = "projectRegistry"

export interface ProjectIdentity {
  id: string
  createdAt: number
}

export interface ProjectRegistryEntry {
  id: string
  path: string       // latest known filesystem path (normalized forward slashes)
  name: string
  lastOpened: number
}

export type ProjectRegistry = Record<string, ProjectRegistryEntry>

// ── Per-project identity (reads/creates `.llm-wiki/project.json`) ─────────

function identityPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/project.json`
}

/**
 * Return the project's stable UUID. Generates + writes one on first call
 * for a project that doesn't have `.llm-wiki/project.json` yet.
 */
export async function ensureProjectId(projectPath: string): Promise<string> {
  const path = identityPath(projectPath)
  try {
    const raw = await readFile(path)
    const parsed = JSON.parse(raw) as ProjectIdentity
    if (parsed?.id && typeof parsed.id === "string") {
      return parsed.id
    }
  } catch {
    // missing or corrupt — fall through to create
  }
  const identity = newProjectIdentity()
  try {
    await writeFile(path, JSON.stringify(identity, null, 2))
  } catch (err) {
    console.warn("[project-identity] failed to write identity file:", err)
  }
  return identity.id
}

function newProjectIdentity(): ProjectIdentity {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  }
}

/**
 * Mint a fresh on-disk identity for an imported project copy.
 * Archive import must not reuse the source project's stable UUID, or
 * queue tasks and the global registry would collide with the original.
 */
export async function reissueImportedProjectIdentity(projectPath: string): Promise<string> {
  const identity = newProjectIdentity()
  const pp = normalizePath(projectPath)
  await writeFile(identityPath(pp), JSON.stringify(identity, null, 2))
  await remapImportedProjectBoundQueues(pp, identity.id)
  return identity.id
}

const IMPORTED_TASK_ARRAY_QUEUES = ["ingest-queue.json", "dedup-queue.json"] as const

/**
 * Archive copies still contain the source project's UUID inside per-project
 * queue files. Restore/watch filters drop those tasks, and the cloned id
 * would otherwise keep pointing at the original registry entry.
 */
async function remapImportedProjectBoundQueues(
  projectPath: string,
  projectId: string,
): Promise<void> {
  const wiki = `${projectPath}/.llm-wiki`
  for (const name of IMPORTED_TASK_ARRAY_QUEUES) {
    await remapProjectIdInTaskArray(`${wiki}/${name}`, projectId)
  }
  await remapProjectIdInFileChangeQueue(`${wiki}/file-change-queue.json`, projectId)
}

async function remapProjectIdInTaskArray(path: string, projectId: string): Promise<void> {
  const parsed = await readOptionalJson(path)
  if (parsed === undefined) return
  if (!Array.isArray(parsed)) {
    await writeFile(path, "[]")
    return
  }
  await writeFile(path, JSON.stringify(parsed.map((task) => withProjectId(task, projectId)), null, 2))
}

async function remapProjectIdInFileChangeQueue(path: string, projectId: string): Promise<void> {
  const parsed = await readOptionalJson(path)
  if (parsed === undefined) return
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await writeFile(path, JSON.stringify({ version: 1, tasks: [] }, null, 2))
    return
  }
  const record = parsed as { tasks?: unknown }
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map((task) => withProjectId(task, projectId))
    : []
  await writeFile(path, JSON.stringify({ ...record, tasks }, null, 2))
}

function withProjectId(value: unknown, projectId: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const { project_id: _legacy, ...rest } = value as Record<string, unknown>
  return { ...rest, projectId }
}

/** `undefined` if the file is missing; `null` if it is not valid JSON. */
async function readOptionalJson(path: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await readFile(path)
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

// ── Global registry (Tauri plugin-store) ──────────────────────────────────

async function getStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} })
}

export async function loadRegistry(): Promise<ProjectRegistry> {
  try {
    const store = await getStore()
    const registry = await store.get<ProjectRegistry>(REGISTRY_KEY)
    return registry ?? {}
  } catch {
    return {}
  }
}

async function saveRegistry(registry: ProjectRegistry): Promise<void> {
  const store = await getStore()
  await store.set(REGISTRY_KEY, registry)
}

/**
 * Create or update the registry entry for this project. Call on open /
 * create / switch so the path always reflects the latest known location.
 */
export async function upsertProjectInfo(
  id: string,
  path: string,
  name: string,
): Promise<void> {
  const registry = await loadRegistry()
  registry[id] = {
    id,
    path: normalizePath(path),
    name,
    lastOpened: Date.now(),
  }
  await saveRegistry(registry)
}

/**
 * Look up the current filesystem path by UUID. Returns null if the
 * project isn't in the registry (e.g. was deleted or never opened).
 */
export async function getProjectPathById(id: string): Promise<string | null> {
  const registry = await loadRegistry()
  return registry[id]?.path ?? null
}

/**
 * Reverse lookup: given a path, find the UUID of a known project at
 * that exact location. Used by the clip watcher to translate
 * clip-server-supplied paths back to stable project ids.
 */
export async function getProjectIdByPath(path: string): Promise<string | null> {
  const normalized = normalizePath(path)
  const registry = await loadRegistry()
  for (const entry of Object.values(registry)) {
    if (entry.path === normalized) return entry.id
  }
  return null
}
