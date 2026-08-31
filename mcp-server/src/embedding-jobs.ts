import { randomUUID } from "node:crypto"
import type { ApiPageEmbeddingResult } from "./api-client.js"

export type EmbeddingJobStatus = "running" | "completed" | "failed"

export interface EmbeddingJobSnapshot {
  jobId: string
  projectId: string
  path: string
  force: boolean
  status: EmbeddingJobStatus
  startedAt: string
  completedAt?: string
  result?: ApiPageEmbeddingResult
  error?: string
}

interface EmbeddingJob extends EmbeddingJobSnapshot {
  key: string
}

type EmbedRunner = () => Promise<ApiPageEmbeddingResult>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class EmbeddingJobStore {
  private readonly jobs = new Map<string, EmbeddingJob>()
  private readonly activeByKey = new Map<string, string>()

  constructor(
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly maxRetainedJobs = 128,
  ) {}

  start(projectId: string, path: string, force: boolean, run: EmbedRunner): EmbeddingJobSnapshot {
    const key = `${projectId}\0${path}`
    const activeId = this.activeByKey.get(key)
    if (activeId) {
      const active = this.jobs.get(activeId)
      if (active?.status === "running") return this.snapshot(active)
      this.activeByKey.delete(key)
    }

    this.prune()
    const job: EmbeddingJob = {
      key,
      jobId: this.createId(),
      projectId,
      path,
      force,
      status: "running",
      startedAt: this.now().toISOString(),
    }
    this.jobs.set(job.jobId, job)
    this.activeByKey.set(key, job.jobId)

    void run().then(
      (result) => this.finish(job.jobId, { status: "completed", result }),
      (error) => this.finish(job.jobId, { status: "failed", error: errorMessage(error) }),
    )
    return this.snapshot(job)
  }

  get(jobId: string): EmbeddingJobSnapshot | undefined {
    const job = this.jobs.get(jobId)
    return job ? this.snapshot(job) : undefined
  }

  private finish(
    jobId: string,
    outcome:
      | { status: "completed"; result: ApiPageEmbeddingResult }
      | { status: "failed"; error: string },
  ): void {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== "running") return
    job.status = outcome.status
    job.completedAt = this.now().toISOString()
    if (outcome.status === "completed") job.result = outcome.result
    else job.error = outcome.error
    if (this.activeByKey.get(job.key) === jobId) this.activeByKey.delete(job.key)
  }

  private prune(): void {
    if (this.jobs.size < this.maxRetainedJobs) return
    const completed = [...this.jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((left, right) => left.completedAt!.localeCompare(right.completedAt!))
    while (this.jobs.size >= this.maxRetainedJobs && completed.length > 0) {
      this.jobs.delete(completed.shift()!.jobId)
    }
  }

  private snapshot(job: EmbeddingJob): EmbeddingJobSnapshot {
    const { key: _key, ...snapshot } = job
    return { ...snapshot }
  }
}
