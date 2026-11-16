import { useEffect, useState } from "react"
import { FolderOpen, Plus, Clock, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getRecentProjects, removeFromRecentProjects } from "@/lib/project-store"
import type { WikiProject } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { namedIconButtonProps, revealOnHoverOrFocusClass, selectRowProps } from "@/components/list-row-a11y"

interface WelcomeScreenProps {
  onCreateProject: () => void
  onOpenProject: () => void
  onSelectProject: (project: WikiProject) => void
}

export function WelcomeScreen({
  onCreateProject,
  onOpenProject,
  onSelectProject,
}: WelcomeScreenProps) {
  const { t } = useTranslation()
  const [recentProjects, setRecentProjects] = useState<WikiProject[]>([])

  useEffect(() => {
    getRecentProjects().then(setRecentProjects).catch(() => {})
  }, [])

  async function handleRemoveRecent(path: string) {
    await removeFromRecentProjects(path)
    const updated = await getRecentProjects()
    setRecentProjects(updated)
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8 px-4">
        <div className="text-center">
          <h1 className="text-3xl font-bold">{t("app.title")}</h1>
          <p className="mt-2 text-muted-foreground">
            {t("app.subtitle")}
          </p>
        </div>

        <div className="flex gap-3">
          <Button onClick={onCreateProject}>
            <Plus className="mr-2 h-4 w-4" />
            {t("welcome.newProject")}
          </Button>
          <Button variant="outline" onClick={onOpenProject}>
            <FolderOpen className="mr-2 h-4 w-4" />
            {t("welcome.openProject")}
          </Button>
        </div>

        {recentProjects.length > 0 && (
          <section className="w-full max-w-md" aria-labelledby="recent-projects-heading">
            <h2
              id="recent-projects-heading"
              className="mb-2 flex items-center gap-2 text-sm font-normal text-muted-foreground"
            >
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {t("welcome.recentProjects")}
            </h2>
            <ul className="m-0 list-none rounded-lg border p-0">
              {recentProjects.map((proj) => (
                <li
                  key={proj.path}
                  className="group flex items-center justify-between border-b last:border-b-0"
                >
                  <button
                    {...selectRowProps(false)}
                    onClick={() => onSelectProject(proj)}
                    className="min-w-0 flex-1 px-4 py-3 text-left transition-colors hover:bg-accent"
                  >
                    <div className="truncate text-sm font-medium">{proj.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {proj.path}
                    </div>
                  </button>
                  <button
                    {...namedIconButtonProps(t("welcome.removeRecent", { name: proj.name }))}
                    onClick={() => void handleRemoveRecent(proj.path)}
                    className={`ml-2 mr-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 ${revealOnHoverOrFocusClass}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
