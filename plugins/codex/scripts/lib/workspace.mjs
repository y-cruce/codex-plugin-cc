import { ensureGitRepository } from "./git.mjs";

// Every path a command builds goes through here, and each miss shells out to
// `git rev-parse`. One process never sees its repository root move, so the
// answer is worth keeping: without this a job that writes a hundred files pays
// for a hundred git processes.
const roots = new Map();

export function resolveWorkspaceRoot(cwd) {
  const cached = roots.get(cwd);
  if (cached !== undefined) return cached;
  let root;
  try {
    root = ensureGitRepository(cwd);
  } catch {
    root = cwd;
  }
  roots.set(cwd, root);
  return root;
}
