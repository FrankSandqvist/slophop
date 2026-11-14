import "server-only";
import { deleteFiles, listFiles, readText, saveFile } from "./storage";

/**
 * Puzzles being made, so the menu can show them even after the player left the page (generation runs on in the
 * background). One small file per job, removed when it finishes or fails; anything older than 6 minutes is stale.
 */
export type Job = { id: string; startedAt: string; repository?: string; title?: string };

const STALE_MS = 6 * 60 * 1000;
const path = (id: string) => `jobs/${id}.json`;

export async function saveJob(job: Job) {
  await saveFile(path(job.id), JSON.stringify(job), "application/json").catch(() => {});
}

export async function clearJob(id: string) {
  await deleteFiles([path(id)]).catch(() => {});
}

export async function listJobs(): Promise<Job[]> {
  const files = await listFiles("jobs/").catch(() => []);
  const jobs = await Promise.all(files.map((file) => readText(file.pathname).then((text) => (text ? (JSON.parse(text) as Job) : null)).catch(() => null)));
  const now = Date.now();
  const stale = jobs.filter((job): job is Job => Boolean(job && now - Date.parse(job.startedAt) > STALE_MS));
  if (stale.length) void deleteFiles(stale.map((job) => path(job.id))).catch(() => {});
  return jobs
    .filter((job): job is Job => Boolean(job && now - Date.parse(job.startedAt) <= STALE_MS))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
