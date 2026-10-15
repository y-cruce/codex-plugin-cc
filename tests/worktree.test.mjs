import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktree, removeWorktree } from "../plugins/codex/scripts/worktree.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function repository() {
  const root = makeTempDir();
  const source = path.join(root, "source repo");
  fs.mkdirSync(source);
  initGitRepo(source);
  fs.mkdirSync(path.join(source, "src"));
  fs.writeFileSync(path.join(source, "src/app.js"), "original\n");
  fs.writeFileSync(path.join(source, "dirty.txt"), "committed\n");
  fs.writeFileSync(path.join(source, "run.sh"), "#!/bin/sh\n");
  fs.chmodSync(path.join(source, "run.sh"), 0o755);
  if (process.platform !== "win32") fs.symlinkSync("src/app.js", path.join(source, "app-link"));
  run("git", ["add", "."], { cwd: source });
  run("git", ["commit", "-m", "base"], { cwd: source });
  return { source, target: path.join(root, "worker copy") };
}

function git(cwd, ...args) {
  const result = run("git", ["-c", "protocol.file.allow=always", ...args], { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("nested submodules pin commits, isolate parallel files and indexes, and preserve unpublished commits on cleanup", () => {
  const { source, target } = repository();
  const root = path.dirname(source);
  const leaf = path.join(root, "leaf repo");
  const child = path.join(root, "child repo");
  for (const directory of [leaf, child]) {
    fs.mkdirSync(directory);
    initGitRepo(directory);
    fs.writeFileSync(path.join(directory, "file.txt"), "pinned\n");
    fs.writeFileSync(path.join(directory, ".gitignore"), "ignored.log\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "base");
  }
  git(child, "submodule", "add", leaf, "deps/nested");
  git(child, "commit", "-am", "nested module");
  const unrelated = git(child, "commit-tree", "HEAD^{tree}", "-m", "unrelated imported history");
  git(child, "tag", "imported-history", unrelated);
  git(source, "submodule", "add", "--name", "logical/tool", child, "libs/tool");
  git(source, "commit", "-am", "module");
  git(source, "submodule", "update", "--init", "--recursive");
  const sourceChild = path.join(source, "libs/tool");
  const pinned = git(sourceChild, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(sourceChild, "file.txt"), "source edit\n");
  const sourceIndex = git(sourceChild, "ls-files", "--stage");
  const second = path.join(root, "second worker");
  const receipt = createWorktree(source, target, "worker/nested");
  createWorktree(source, second, "worker/second");
  assert.deepEqual(receipt.submodules.map(module => module.path), ["libs/tool", "libs/tool/deps/nested"]);
  assert.equal(receipt.submodules[0].base, pinned);
  const targetChild = path.join(target, "libs/tool");
  assert.equal(fs.readFileSync(path.join(targetChild, "file.txt"), "utf8"), "pinned\n");
  assert.equal(git(target, "status", "--porcelain", "--ignore-submodules=none"), "");
  assert.ok(git(target, "submodule", "status", "--recursive").split("\n").every(line => !/^[+-]/.test(line)));
  for (const module of receipt.submodules) {
    const directory = path.join(target, module.path);
    assert.notEqual(git(directory, "rev-parse", "--absolute-git-dir"), git(path.join(second, module.path), "rev-parse", "--absolute-git-dir"));
    assert.equal(fs.existsSync(git(directory, "rev-parse", "--git-path", "objects/info/alternates")), false);
    const objects = path.resolve(directory, git(directory, "rev-parse", "--git-path", "objects"));
    for (const name of fs.readdirSync(objects, { recursive: true })) {
      const stat = fs.statSync(path.join(objects, name));
      if (stat.isFile()) assert.equal(stat.nlink, 1, name);
    }
  }
  assert.equal(git(targetChild, "remote", "get-url", "origin"), child);
  fs.writeFileSync(path.join(targetChild, "file.txt"), "worker edit\n");
  git(targetChild, "add", "file.txt");
  assert.equal(git(sourceChild, "ls-files", "--stage"), sourceIndex);
  assert.equal(fs.readFileSync(path.join(sourceChild, "file.txt"), "utf8"), "source edit\n");
  assert.equal(fs.readFileSync(path.join(second, "libs/tool/file.txt"), "utf8"), "pinned\n");
  assert.throws(() => removeWorktree(source, target), /Uncommitted|untracked|ignored/);
  git(targetChild, "-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "worker edit");
  git(target, "add", "libs/tool");
  git(target, "commit", "-m", "pin worker edit");
  assert.throws(() => removeWorktree(source, target), /Unpublished submodule commits/);
  git(targetChild, "push", "origin", "HEAD:refs/heads/saved-worker");
  fs.writeFileSync(path.join(targetChild, "ignored.log"), "preserve me");
  assert.throws(() => removeWorktree(source, target), /Uncommitted|untracked|ignored/);
  fs.unlinkSync(path.join(targetChild, "ignored.log"));
  removeWorktree(source, target);
  const secondChild = path.join(second, "libs/tool");
  git(secondChild, "-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "later reset");
  const resetCommit = git(secondChild, "rev-parse", "HEAD");
  git(secondChild, "reset", "--hard", pinned);
  assert.throws(() => removeWorktree(source, second), /Unpublished submodule commits/);
  git(secondChild, "push", "origin", `${resetCommit}:refs/heads/saved-reset`);
  removeWorktree(source, second);
  assert.equal(fs.existsSync(target), false);
  assert.equal(git(sourceChild, "rev-parse", "HEAD"), pinned);
  assert.ok(git(source, "rev-parse", "worker/nested"));
});

test("lagging and uninitialized submodules fetch pinned commits, resolve relative URLs and retain failures", () => {
  const { source, target } = repository();
  const child = path.join(path.dirname(source), "child repo");
  fs.mkdirSync(child);
  initGitRepo(child);
  fs.writeFileSync(path.join(child, "file.txt"), "module\n");
  git(child, "add", ".");
  git(child, "commit", "-m", "base");
  git(source, "submodule", "add", "--name", "tool", child, "libs/tool");
  git(source, "config", "--file", ".gitmodules", "submodule.tool.url", "../child repo");
  git(source, "commit", "-am", "relative module");
  fs.writeFileSync(path.join(child, "file.txt"), "advanced module\n");
  git(child, "commit", "-am", "advance module");
  const advanced = git(child, "rev-parse", "HEAD");
  git(source, "update-index", "--cacheinfo", "160000", advanced, "libs/tool");
  git(source, "commit", "-m", "pin advanced module");
  const lagging = createWorktree(source, target, "worker/lagging");
  assert.equal(lagging.submodules[0].fetchedFromRemote, true);
  assert.equal(git(path.join(target, "libs/tool"), "rev-parse", "HEAD"), advanced);
  assert.equal(fs.readFileSync(path.join(target, "libs/tool/file.txt"), "utf8"), "advanced module\n");
  assert.notEqual(git(path.join(source, "libs/tool"), "rev-parse", "HEAD"), advanced);
  removeWorktree(source, target);
  git(source, "submodule", "deinit", "--force", "libs/tool");
  const receipt = createWorktree(source, target, "worker/uninitialized");
  assert.equal(receipt.submodules.length, 1);
  assert.equal(receipt.submodules[0].source, "remote");
  assert.equal(fs.readFileSync(path.join(target, "libs/tool/file.txt"), "utf8"), "advanced module\n");
  removeWorktree(source, target);
  git(source, "config", "submodule.tool.url", path.join(path.dirname(source), "missing repo"));
  assert.throws(() => createWorktree(source, target, "worker/unavailable"), /Incomplete worktree retained/);
  assert.ok(fs.existsSync(path.join(target, ".git")));
});

test("worktrees clone clean files, check out dirty files at HEAD and keep Git and writes independent", () => {
  const { source, target } = repository();
  fs.writeFileSync(path.join(source, "dirty.txt"), "local edit\n");
  fs.mkdirSync(path.join(source, "node_modules"));
  fs.writeFileSync(path.join(source, "node_modules/private.txt"), "not copied");
  const result = createWorktree(source, target, "worker/apfs");
  assert.equal(result.checkoutFiles, 1);
  assert.equal(result.clonedFiles + result.copiedFiles, 2);
  assert.equal(fs.readFileSync(path.join(target, "dirty.txt"), "utf8"), "committed\n");
  assert.equal(fs.existsSync(path.join(target, "node_modules")), false);
  assert.equal(run("git", ["status", "--porcelain"], { cwd: target }).stdout, "");
  assert.notEqual(run("git", ["rev-parse", "--git-dir"], { cwd: target }).stdout.trim(), ".git");
  if (process.platform !== "win32") {
    assert.equal(fs.readlinkSync(path.join(target, "app-link")), "src/app.js");
    assert.ok(fs.statSync(path.join(target, "run.sh")).mode & 0o111);
  }
  fs.writeFileSync(path.join(target, "src/app.js"), "worker edit\n");
  run("git", ["add", "src/app.js"], { cwd: target });
  assert.equal(fs.readFileSync(path.join(source, "src/app.js"), "utf8"), "original\n");
  assert.equal(run("git", ["diff", "--cached", "--name-only"], { cwd: source }).stdout, "");
  run("git", ["commit", "-m", "worker edit"], { cwd: target });
  run("git", ["worktree", "remove", target], { cwd: source });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(source, "dirty.txt"), "utf8"), "local edit\n");
  assert.ok(run("git", ["rev-parse", "worker/apfs"], { cwd: source }).stdout.trim());
});

test("unsupported cloning reports ordinary copies and an existing destination stays untouched", t => {
  const { source, target } = repository();
  const copyFile = fs.copyFileSync;
  if (process.platform === "darwin") t.mock.method(childProcess, "execFileSync", (_command, _args, options) =>
    JSON.stringify(JSON.parse(options.input).map(() => "ENOTSUP")));
  t.mock.method(fs, "copyFileSync", (from, to, flags) => {
    if (flags === fs.constants.COPYFILE_FICLONE_FORCE) throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
    return copyFile(from, to, flags);
  });
  const result = createWorktree(source, target, "worker/fallback");
  assert.equal(result.clonedFiles, 0);
  assert.equal(result.copiedFiles, 3);
  assert.equal(run("git", ["status", "--porcelain"], { cwd: target }).stdout, "");
  assert.throws(() => createWorktree(source, target, "worker/other"), /Destination already exists/);
  assert.equal(run("git", ["branch", "--show-current"], { cwd: target }).stdout.trim(), "worker/fallback");
});

test("a source change during cloning fails verification and retains the registered worktree for inspection", t => {
  const { source, target } = repository();
  if (process.platform === "darwin") {
    const execFile = childProcess.execFileSync;
    t.mock.method(childProcess, "execFileSync", (command, args, options) => {
      const result = execFile(command, args, options);
      for (const [, to] of JSON.parse(options.input)) {
        if (to.endsWith("app.js")) fs.writeFileSync(to, "raced change\n");
      }
      return result;
    });
  }
  const copyFile = fs.copyFileSync;
  t.mock.method(fs, "copyFileSync", (from, to, flags) => {
    const result = copyFile(from, to, flags);
    if (to.endsWith("app.js")) fs.writeFileSync(to, "raced change\n");
    return result;
  });
  assert.throws(() => createWorktree(source, target, "worker/race"), /differs from the pinned commit[\s\S]*Incomplete worktree retained/);
  assert.ok(fs.existsSync(path.join(target, ".git")));
  assert.match(run("git", ["status", "--porcelain"], { cwd: target }).stdout, /src\/app.js/);
});
