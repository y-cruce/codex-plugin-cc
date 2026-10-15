import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { pathToFileURL } from "node:url";
import { runCommandChecked } from "./lib/process.mjs";

export function createWorktree(source, destination, branch) {
  const git = (cwd, args, input) => runCommandChecked("git", args, {
    cwd, input, shell: false, maxBuffer: 64 * 1024 * 1024
  }).stdout;
  source = fs.realpathSync(git(source, ["rev-parse", "--show-toplevel"]).trim());
  destination = path.resolve(destination);
  try {
    fs.lstatSync(destination);
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  git(source, ["check-ref-format", "--branch", branch]);
  const base = git(source, ["rev-parse", "HEAD"]).trim();
  const entries = git(source, ["ls-tree", "-r", "-z", base]).split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t");
    return { mode: entry.slice(0, 6), name: entry.slice(tab + 1) };
  });
  if (entries.some(entry => entry.mode === "160000")) {
    throw new Error("Use git worktree add for repositories with submodules.");
  }
  const changed = new Set(git(source, ["diff", "--name-only", "-z", base, "--"]).split("\0"));
  git(source, ["worktree", "add", "--no-checkout", "-b", branch, destination, base]);
  const result = { cwd: destination, branch, base, clonedFiles: 0, copiedFiles: 0, checkoutFiles: 0 };
  try {
    git(destination, ["-c", "core.sparseCheckout=false", "read-tree", base]);
    const checkout = [];
    const copies = [];
    for (const { mode, name } of entries) {
      const from = path.join(source, name);
      const to = path.join(destination, name);
      const stat = fs.lstatSync(from, { throwIfNoEntry: false });
      if (changed.has(name) || !stat || !(mode === "120000" ? stat.isSymbolicLink() : stat.isFile())) {
        checkout.push(name);
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (mode === "120000") {
        fs.symlinkSync(fs.readlinkSync(from), to);
        continue;
      }
      copies.push({ from, to, mode });
    }
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
        result.clonedFiles++;
      } catch (error) {
        if (!["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(error.code)) throw error;
        fs.copyFileSync(from, to);
        result.copiedFiles++;
      }
      fs.chmodSync(to, mode === "100755" ? 0o755 : 0o644);
    }
    if (checkout.length) {
      git(destination, ["-c", "core.sparseCheckout=false", "checkout-index", "-z", "--stdin"], checkout.join("\0") + "\0");
      result.checkoutFiles = checkout.length;
    }
    if (git(destination, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
      throw new Error("Worktree differs from the pinned commit; keep the source stable and retry with a new destination.");
    }
    return result;
  } catch (error) {
    throw new Error(`${error.message}\nIncomplete worktree retained at ${destination}; inspect it before git worktree remove.`, { cause: error });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error("Usage: node worktree.mjs <source-repo> <new-directory> <new-branch>");
    console.log(JSON.stringify(createWorktree(args[0], args[1], args[2]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
