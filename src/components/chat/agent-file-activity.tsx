import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, FilePlus2, FileText, RotateCcw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { readFile } from "@/commands/fs"
import type { ChatAgentFileChange } from "@/lib/chat-agent-types"
import { confineProjectFilePath, getFileName } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { useWikiStore } from "@/stores/wiki-store"
import { groupAgentFileChanges, undoAgentFileChange } from "@/lib/agent-file-activity"

export function AgentFileActivity({
  changes,
  embedded = false,
}: {
  changes: ChatAgentFileChange[]
  embedded?: boolean
}) {
  const { t } = useTranslation()
  const project = useWikiStore((state) => state.project)
  const openFileInPreview = useWikiStore((state) => state.openFileInPreview)
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  const [expandedEdits, setExpandedEdits] = useState<Record<string, boolean>>({})
  const [undoing, setUndoing] = useState<string | null>(null)
  const [undone, setUndone] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const groups = useMemo(() => groupAgentFileChanges(changes), [changes])

  if (changes.length === 0) return null

  const undo = async (change: ChatAgentFileChange) => {
    if (!project || change.beforeContent === undefined || change.afterContent === undefined || undone.has(change.id)) return
    setUndoing(change.id)
    setError(null)
    try {
      await undoAgentFileChange(project.path, change)
      await refreshProjectFileTree(project.path, { bumpDataVersion: true })
      setUndone((current) => new Set(current).add(change.id))
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(
        /outside the project|conflict/i.test(message)
          ? t("chat.agentChanges.undoConflict")
          : message,
      )
    } finally {
      setUndoing(null)
    }
  }

  return (
    <section className={embedded ? "" : "rounded-md border border-border/60 bg-background/60"} aria-label={t("chat.agentChanges.title") }>
      {!embedded && (
        <div className="flex items-center justify-between gap-2 border-b border-border/50 px-2.5 py-1.5">
          <span className="text-xs font-medium">{t("chat.agentChanges.title")}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {t("chat.agentChanges.fileCount", { count: groups.length })}
          </span>
        </div>
      )}
      <div>
        {groups.map((group) => {
          const fileExpanded = expandedFiles[group.path] ?? true
          const FileIcon = group.edits[0]?.operation === "created" ? FilePlus2 : FileText
          return (
            <div key={group.path} className="border-b border-border/40 last:border-b-0">
              <div className="flex min-w-0 items-center gap-1.5 bg-muted/15 px-2 py-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => setExpandedFiles((current) => ({ ...current, [group.path]: !fileExpanded }))}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-expanded={fileExpanded}
                  aria-label={fileExpanded ? t("chat.agentChanges.collapseDiff") : t("chat.agentChanges.expandDiff")}
                >
                  {fileExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => {
                    if (!project) return
                    const confined = confineProjectFilePath(project.path, group.path)
                    if (!confined) return
                    void readFile(confined)
                      .catch(() => "")
                      .then((content) => openFileInPreview(confined, content))
                  }}
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  title={group.path}
                >
                  {getFileName(group.path)}
                </button>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t("chat.agentChanges.editCount", { count: group.edits.length })}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">+{group.additions}</span>
                <span className="shrink-0 font-mono text-[10px] text-red-600 dark:text-red-400">-{group.deletions}</span>
              </div>
              {fileExpanded && group.edits.map((change, editIndex) => {
                const editExpanded = Boolean(expandedEdits[change.id])
                const canUndo = change.beforeContent !== undefined
                  && change.afterContent !== undefined
                  && !undone.has(change.id)
                return (
                  <div key={change.id} className="border-t border-border/30 pl-5">
                    <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setExpandedEdits((current) => ({ ...current, [change.id]: !editExpanded }))}
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-expanded={editExpanded}
                        aria-label={editExpanded ? t("chat.agentChanges.collapseDiff") : t("chat.agentChanges.expandDiff")}
                      >
                        {editExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </button>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {change.tool} · {t("chat.agentChanges.editNumber", { number: editIndex + 1 })}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">+{change.additions}</span>
                      <span className="shrink-0 font-mono text-[10px] text-red-600 dark:text-red-400">-{change.deletions}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(change.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                      <button
                        type="button"
                        disabled={!canUndo || undoing === change.id}
                        onClick={() => void undo(change)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                        title={canUndo ? t("chat.agentChanges.undo") : t("chat.agentChanges.undoUnavailable")}
                        aria-label={canUndo ? t("chat.agentChanges.undo") : t("chat.agentChanges.undoUnavailable")}
                      >
                        <RotateCcw className={`h-3.5 w-3.5 ${undoing === change.id ? "animate-spin" : ""}`} />
                      </button>
                    </div>
                    {editExpanded && (
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-border/30 bg-muted/30 px-3 py-2 font-mono text-[10px] leading-4">
                        {change.diff}
                      </pre>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {error && <div className="border-t border-destructive/20 px-2.5 py-1.5 text-[10px] text-destructive">{error}</div>}
    </section>
  )
}
