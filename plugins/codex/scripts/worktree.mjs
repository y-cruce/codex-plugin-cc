import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { pathToFileURL } from "node:url";
import { runCommand, runCommandChecked } from "./lib/process.mjs";

export const DEFAULT_MAX_SLOTS = 10;

function git(cwd, args, input) {
  return runCommandChecked("git", args, {
    cwd, input, shell: false, maxBuffer: 64 * 1024 * 1024
  }).stdout;
}

function parseMaxSlots() {
  const raw = process.env.CODEX_WORKTREE_MAX_SLOTS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_SLOTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CODEX_WORKTREE_MAX_SLOTS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function listLinkedWorktrees(source) {
  const blocks = git(source, ["worktree", "list", "--porcelain"]).trim().split(/\r?\n\r?\n/).filter(Boolean);
  return blocks.slice(1).map(block => {
    let wtPath = "";
    let branch = "(unknown)";
    let prunable = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") branch = "(detached)";
      else if (line === "bare") branch = "(bare)";
      else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
    }
    return { path: wtPath, branch, prunable };
  });
}

function worktreeDirtyState(entry) {
  if (entry.prunable || !entry.path || !fs.existsSync(entry.path)) return "missing";
  const result = runCommand("git", ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], { cwd: entry.path, shell: false });
  if (result.status !== 0) return "status unavailable";
  const lines = result.stdout.split("\n").filter(Boolean);
  if (!lines.length) return "clean";
  const hasUntracked = lines.some(line => line.startsWith("?? "));
  const hasUncommitted = lines.some(line => !line.startsWith("?? "));
  if (hasUncommitted && hasUntracked) return "uncommitted and untracked files";
  return hasUntracked ? "untracked files" : "uncommitted changes";
}

function tree(cwd, base) {
  return git(cwd, ["ls-tree", "-r", "-z", base]).split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t");
    const [mode, , object] = entry.slice(0, tab).split(" ");
    return { mode, object, name: entry.slice(tab + 1) };
  });
}

function copyFiles(copies) {
  const counts = { clonedFiles: 0, copiedFiles: 0 };
  // Node/libuv can return ENOSYS for FICLONE on macOS even when APFS supports
  // clonefile. One Python process calls the native API for the whole batch.
  const nativeErrors = process.platform === "darwin" && copies.length ? JSON.parse(childProcess.execFileSync("python3", ["-c", `
import ctypes, errno, json, os, sys
clone = ctypes.CDLL(None, use_errno=True).clonefile
clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
results = []
for source, target in json.load(sys.stdin):
    status = clone(os.fsencode(source), os.fsencode(target), 0)
    results.append(errno.errorcode.get(ctypes.get_errno(), "UNKNOWN") if status else None)
json.dump(results, sys.stdout)
`], { input: JSON.stringify(copies.map(({ from, to }) => [from, to])), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) : null;
  for (const [index, { from, to, mode }] of copies.entries()) {
    try {
      if (nativeErrors) {
        if (nativeErrors[index]) throw Object.assign(new Error(`clonefile ${from}: ${nativeErrors[index]}`), { code: nativeErrors[index] });
      } else fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE_FORCE);
      counts.clonedFiles++;
    } catch (error) {
      if (!["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(error.code)) throw error;
      fs.copyFileSync(from, to);
      counts.copiedFiles++;
    }
    fs.chmodSync(to, mode);
  }
  return counts;
}

function cloneObjects(destination) {
  const objects = path.resolve(destination, git(destination, ["rev-parse", "--git-path", "objects"]).trim());
  const copies = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const original = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(original);
      else if (entry.isFile()) {
        const stat = fs.statSync(original);
        if (stat.nlink > 1) copies.push({ from: original, to: original + ".apfs-copy", original, mode: stat.mode & 0o777 });
      }
    }
  };
  // Local Git clones initially hard-link immutable objects. Replace those
  // links before returning, without first allocating a full object-store copy.
  visit(objects);
  const counts = copyFiles(copies);
  for (const copy of copies) fs.renameSync(copy.to, copy.original);
  return counts;
}

function populate(source, destination, base, result) {
  const entries = tree(destination, base);
  const changed = new Set(source ? git(source, ["diff", "--name-only", "-z", base, "--"]).split("\0") : []);
  git(destination, ["-c", "core.sparseCheckout=false", "read-tree", base]);
  const checkout = [];
  const copies = [];
  for (const { mode, name } of entries) {
    if (mode === "160000") continue;
    const from = source && path.join(source, name);
    const to = path.join(destination, name);
    const stat = from && fs.lstatSync(from, { throwIfNoEntry: false });
    if (changed.has(name) || !stat || !(mode === "120000" ? stat.isSymbolicLink() : stat.isFile())) {
      checkout.push(name);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (mode === "120000") fs.symlinkSync(fs.readlinkSync(from), to);
    else copies.push({ from, to, mode: mode === "100755" ? 0o755 : 0o644 });
  }
  const counts = copyFiles(copies);
  result.clonedFiles += counts.clonedFiles;
  result.copiedFiles += counts.copiedFiles;
  if (checkout.length) {
    git(destination, ["-c", "core.sparseCheckout=false", "checkout-index", "-z", "--stdin"], checkout.join("\0") + "\0");
    result.checkoutFiles += checkout.length;
  }
  const modules = entries.filter(entry => entry.mode === "160000");
  if (modules.length) {
    git(destination, ["submodule", "init", "--", ...modules.map(entry => entry.name)]);
    const keys = new Map(git(destination, ["config", "--null", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"])
      .split("\0").filter(Boolean).map(entry => {
        const newline = entry.indexOf("\n");
        return [entry.slice(newline + 1), entry.slice(0, newline - 5) + ".url"];
      }));
    for (const { name, object } of modules) {
      const from = source && path.join(source, name);
      const to = path.join(destination, name);
      const available = from && fs.existsSync(path.join(from, ".git"));
      const sourceHasBase = available && runCommand("git", ["cat-file", "-e", object + "^{commit}"], { cwd: from, shell: false }).status === 0;
      const url = git(destination, ["config", "--get", keys.get(name)]).trim();
      let fetchedFromRemote = false;
      git(destination, ["clone", "--no-checkout", "--dissociate", "--", available ? from : url, to]);
      if (runCommand("git", ["cat-file", "-e", object + "^{commit}"], { cwd: to, shell: false }).status !== 0) {
        git(to, ["fetch", "--no-tags", "--", sourceHasBase ? from : url, object]);
        fetchedFromRemote = !sourceHasBase;
      }
      const objects = cloneObjects(to);
      result.clonedObjectFiles += objects.clonedFiles;
      result.copiedObjectFiles += objects.copiedFiles;
      git(to, ["remote", "set-url", "origin", url]);
      git(to, ["update-ref", "--no-deref", "HEAD", object]);
      git(to, ["config", "--local", "codex.worktreeBase", object]);
      const initial = git(to, ["rev-list", "--all", "--reflog", "HEAD", "--no-walk"]).trim().split("\n");
      git(to, ["update-ref", "--stdin"], initial.map(commit => `update refs/codex/worktree-initial/${commit} ${commit}\n`).join(""));
      git(destination, ["submodule", "absorbgitdirs", "--", name]);
      result.submodules.push({ path: path.relative(result.cwd, to), base: object, source: available ? "local" : "remote", fetchedFromRemote });
      populate(sourceHasBase ? from : null, to, object, result);
    }
  }
  if (git(destination, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]).trim()) {
    throw new Error(`Worktree differs from the pinned commit at ${destination}; keep the source stable and retry with a new destination.`);
  }
}

export function createWorktree(source, destination, branch) {
  source = fs.realpathSync(git(source, ["rev-parse", "--show-toplevel"]).trim());
  destination = path.resolve(destination);
  try {
    fs.lstatSync(destination);
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  git(source, ["check-ref-format", "--branch", branch]);
  const maxSlots = parseMaxSlots();
  const linked = listLinkedWorktrees(source);
  if (linked.length >= maxSlots) {
    const details = linked.map(entry => `  ${entry.path} [${entry.branch}] (${worktreeDirtyState(entry)})`).join("\n");
    throw new Error(
      `Worktree limit reached (${linked.length}/${maxSlots} linked worktrees; set CODEX_WORKTREE_MAX_SLOTS to adjust).\n` +
      `Remove finished worktrees first with "worktree remove <source-repo> <worktree>" until fewer than ${maxSlots} remain, or wait for an active write task to finish:\n${details}`
    );
  }
  const base = git(source, ["rev-parse", "HEAD"]).trim();
  git(source, ["worktree", "add", "--no-checkout", "-b", branch, destination, base]);
  const result = { cwd: destination, branch, base, clonedFiles: 0, copiedFiles: 0, checkoutFiles: 0,
    clonedObjectFiles: 0, copiedObjectFiles: 0, submodules: [] };
  try {
    populate(source, destination, base, result);
    return result;
  } catch (error) {
    throw new Error(`${error.message}\nIncomplete worktree retained at ${destination}; inspect it before git worktree remove.`, { cause: error });
  }
}

function moduleGitDirs(directory) {
  const found = [];
  for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    if (fs.existsSync(path.join(child, "HEAD")) && fs.existsSync(path.join(child, "config"))) {
      found.push(child, ...moduleGitDirs(path.join(child, "modules")));
    } else found.push(...moduleGitDirs(child));
  }
  return found;
}

function unreachableParentCommits(destination, directory) {
  const head = runCommand("git", ["--git-dir", directory, "rev-parse", "--verify", "HEAD^{commit}"], { cwd: destination, shell: false });
  const sha = head.status === 0 ? head.stdout.trim() : "";
  if (!sha) return [];
  const out = git(destination, ["--git-dir", directory, "rev-list", sha, "--not", "--branches", "--tags", "--remotes"]).trim();
  return out ? out.split("\n").filter(Boolean) : [];
}

export function removeWorktree(source, destination) {
  destination = fs.realpathSync(destination);
  const common = cwd => fs.realpathSync(path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()));
  const directory = fs.realpathSync(git(destination, ["rev-parse", "--absolute-git-dir"]).trim());
  if (common(source) !== common(destination) || directory === common(destination) ||
      fs.realpathSync(git(destination, ["rev-parse", "--show-toplevel"]).trim()) !== destination) {
    throw new Error("Target must be a linked worktree of the supplied source repository.");
  }
  const modules = moduleGitDirs(path.join(directory, "modules"));
  for (const gitDir of [directory, ...modules]) {
    if (git(destination, ["--git-dir", gitDir, "status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]).trim()) {
      throw new Error(`Uncommitted, untracked or ignored files remain in ${gitDir}; preserve them before removal.`);
    }
    if (gitDir === directory) {
      const unreachable = unreachableParentCommits(destination, directory);
      if (unreachable.length) {
        throw new Error(`Unreachable commits remain in ${directory} (not reachable from any branch, tag, or remote): ${unreachable.join(", ")}; preserve them before removal.`);
      }
    } else {
      const base = git(destination, ["--git-dir", gitDir, "config", "--local", "--get", "codex.worktreeBase"]).trim();
      if (git(destination, ["--git-dir", gitDir, "rev-list", "--all", "--reflog", "HEAD", "--not", "--remotes", "--glob=refs/codex/worktree-initial/*", base]).trim()) {
        throw new Error(`Unpublished submodule commits remain in ${gitDir}; push or preserve them before removal.`);
      }
    }
  }
  // Git requires --force for initialized submodules, even when every tree is
  // clean. Only use it after checking files and commits in every private repo.
  git(source, ["worktree", "remove", ...(modules.length ? ["--force"] : []), destination]);
  return { cwd: destination, removed: true, submodules: modules.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error("Usage: node worktree.mjs <source-repo> <new-directory> <new-branch> | remove <source-repo> <worktree>");
    console.log(JSON.stringify(args[0] === "remove" ? removeWorktree(args[1], args[2]) : createWorktree(args[0], args[1], args[2]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
