import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktree } from "../plugins/codex/scripts/worktree.mjs";
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
