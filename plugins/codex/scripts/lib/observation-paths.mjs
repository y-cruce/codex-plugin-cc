import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "./state.mjs";

export async function readObservationJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function observationRoots(cwd) {
  const current = resolveStateDir(cwd);
  const key = path.basename(current);
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const data = path.join(config, "plugins", "data");
  let entries;
  try { entries = await fs.readdir(data, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; entries = []; }
  return [...new Set([current, ...entries.filter((entry) => entry.isDirectory())
    .map((entry) => path.join(data, entry.name, "state", key)), path.join(os.tmpdir(), "codex-companion", key)])];
}

export async function observationJobs(stateDir) {
  const state = await readObservationJson(path.join(stateDir, "state.json"));
  const jobs = new Map((state?.jobs ?? []).map((job) => [job.id, { job, stateDir, mtime: 0 }]));
  for (const name of await fs.readdir(path.join(stateDir, "jobs")).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(stateDir, "jobs", name);
    try {
      const job = await readObservationJson(file);
      if (job) jobs.set(job.id, { job, stateDir, mtime: (await fs.stat(file)).mtimeMs });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const id of await fs.readdir(path.join(stateDir, "job-history")).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  })) {
    if (jobs.has(id)) continue;
    const job = (await readObservationJson(path.join(stateDir, "job-history", id, "manifest.json")))?.metadata?.job;
    if (job) jobs.set(id, { job, stateDir, mtime: 0 });
  }
  return [...jobs.values()];
}

export async function resolveObservationRoot(cwd, id) {
  if (!id || path.basename(id) !== id || id === "." || id === "..") throw Object.assign(new Error(`UNKNOWN_JOB ${id}`), { code: "UNKNOWN_JOB" });
  const current = resolveStateDir(cwd);
  if ((await observationJobs(current)).some((entry) => entry.job.id === id)) return current;
  const roots = await observationRoots(cwd);
  let selected = null;
  for (const stateDir of roots.slice(1)) {
    try {
      const stat = await fs.stat(path.join(stateDir, "jobs", `${id}.json`));
      if (stat.isFile() && (!selected || stat.mtimeMs > selected.mtime)) selected = { stateDir, mtime: stat.mtimeMs };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return selected?.stateDir ?? roots[0];
}
