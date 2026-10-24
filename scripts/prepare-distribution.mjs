// Builds a clean-history copy of Canvas: one commit, a noreply author, no private history.  It never pushes or creates remotes.
// Usage: npm run dist:prepare -- --out <new folder> --author "Name <id+user@users.noreply.github.com>" [--ref main] [--deny <private name>]...
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPublicAuthor, prepareDistributionFiles, scanDistribution } from "./distribution.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, { cwd = ROOT, env, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env, encoding, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}

function parseArguments(argv) {
  const options = { ref: "main", deny: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === "--out") options.out = path.resolve(value);
    else if (flag === "--author") options.author = value;
    else if (flag === "--ref") options.ref = value;
    else if (flag === "--deny") options.deny.push(value);
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (!options.out) throw new Error("--out is required.");
  if (!isPublicAuthor(options.author)) throw new Error("--author must look like \"Name <...noreply...>\" so no personal email is published.");
  if (!/^[\w./-]+$/.test(options.ref)) throw new Error("--ref must be a branch, tag, or commit.");
  return options;
}

const options = parseArguments(process.argv.slice(2));
const commit = git(["rev-parse", "--verify", `${options.ref}^{commit}`]).trim();
const date = git(["show", "-s", "--format=%cI", commit]).trim();
const version = JSON.parse(git(["show", `${commit}:package.json`])).version;
const paths = git(["ls-tree", "-r", "--name-only", "-z", commit]).split("\0").filter(Boolean);
const { files, strippedBlocks } = prepareDistributionFiles(paths.map((filePath) => ({ path: filePath, content: git(["show", `${commit}:${filePath}`], { encoding: "buffer" }) })));

const { findings, reviewAssets } = scanDistribution(files, { denyTerms: options.deny });
if (findings.length) {
  for (const finding of findings) process.stderr.write(`BLOCKED ${finding.path}: ${finding.issue}\n`);
  process.exit(1);
}
if (existsSync(options.out)) throw new Error(`${options.out} already exists.  Choose a new folder.`);

for (const file of files) {
  const target = path.join(options.out, ...file.path.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.content);
}
const [, name, email] = /^([^<>]+?)\s*<([^<>]+)>$/.exec(options.author.trim());
const dated = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
git(["init", "-q", "-b", "main"], { cwd: options.out });
git(["-c", "core.autocrlf=false", "add", "-A"], { cwd: options.out });
git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `Ramrattan Canvas ${version}`], { cwd: options.out, env: dated });
const distributionCommit = git(["rev-parse", "HEAD"], { cwd: options.out }).trim();
const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: options.out }).trim();
writeFileSync(path.join(options.out, ".git", "canvas-distribution.json"), `${JSON.stringify({ sourceCommit: commit, files: files.length, strippedBlocks, tree, commit: distributionCommit }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ sourceCommit: commit, version, files: files.length, strippedBlocks, tree, commit: distributionCommit, reviewAssets }, null, 2)}\n`);
process.stdout.write("No remote was added and nothing was pushed.\n");
