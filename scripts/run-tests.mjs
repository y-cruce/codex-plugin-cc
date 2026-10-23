#!/usr/bin/env node
// `npm test [-- <node --test flags> <test files>]`. Every non-flag argument must
// name an existing file: node --test treats an unknown argument as a glob and
// silently skips it, which is how a whole file list passed as one argument
// (an unquoted `$F` in zsh) ran nothing and still reported green.
import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("-"));
const files = args.filter((arg) => !arg.startsWith("-"));
const missing = files.filter((file) => !fs.statSync(file, { throwIfNoEntry: false })?.isFile());

if (missing.length > 0) {
  for (const file of missing) console.error(`✖ not a test file: ${JSON.stringify(file)}`);
  console.error("✖ pass each file as its own argument (zsh: files=(...); npm test -- \"${files[@]}\"), and flags as --flag=value");
  process.exit(1);
}

const targets = files.length > 0
  ? files
  : fs.readdirSync("tests").filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `tests/${name}`);
const run = spawnSync(process.execPath, ["--test", ...flags, ...targets], { stdio: "inherit" });
process.exit(run.status ?? 1);
