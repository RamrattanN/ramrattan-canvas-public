import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DISTRIBUTION_EXCLUDES, isExcluded, isPublicAuthor, prepareDistributionFiles, scanDistribution, stripPrivateBlocks } from "./distribution.mjs";

const file = (path, text) => ({ path, content: Buffer.from(text) });
// Built at run time so this test file itself passes the tracked-tree scan.
const personalEmail = ["person", "personal-mail.test"].join("@");
const windowsPath = ["C:", "Users", "someone", "Desktop"].join("\\");
const homePath = ["", "home", "someone", "canvas"].join("/");
const privateKey = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");

test("distribution scan blocks credentials, local paths, personal emails, private names, dependencies and bundled records", () => {
  const { findings } = scanDistribution([
    file("a.mjs", `const token = "ghp_${"x".repeat(30)}";`),
    file("b.md", `Saved at ${windowsPath} and ${homePath}`),
    file("c.md", `Contact ${personalEmail} or 1+user@users.noreply.github.com or demo@example.com`),
    file("d.md", "Mentions Secret-Client/Private-Repo in passing"),
    file("package.json", JSON.stringify({ dependencies: { leftpad: "1.0.0" } })),
    file("github-snapshot.json", JSON.stringify({ repository: "Owner/repo", records: [{ number: 1 }] })),
    file("e.pem", privateKey),
  ], { denyTerms: ["secret-client/private-repo"] });
  assert.deepEqual(findings.map(({ path, issue }) => `${path}: ${issue}`), [
    "a.mjs: GitHub token",
    "b.md: Local file path",
    "c.md: Email address (1)",
    "d.md: Private name from the deny list",
    "package.json: Unexpected dependencies",
    "github-snapshot.json: Bundled snapshot contains repository records",
    "e.pem: Private key",
  ]);
});

test("distribution scan accepts redaction patterns, synthetic test strings, and lists images for rights review", () => {
  const { findings, reviewAssets } = scanDistribution([
    file("core.mjs", "const pattern = /\\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b/g;"),
    file("test.mjs", 'throw new Error("token ghp_should_not_leak");'),
    file("package.json", JSON.stringify({ scripts: { test: "node --test" } })),
    file("github-snapshot.json", JSON.stringify({ repository: "", records: [] })),
    file("logo.png", "binary"),
  ]);
  assert.deepEqual(findings, []);
  assert.deepEqual(reviewAssets, ["logo.png"]);
});

test("distribution authors must use a noreply address", () => {
  assert.equal(isPublicAuthor("Canvas Maintainers <123+canvas@users.noreply.github.com>"), true);
  for (const author of [`Someone <${personalEmail}>`, "noreply", "", undefined]) assert.equal(isPublicAuthor(author), false, String(author));
});

test("the current tracked tree passes the distribution scan once internal documents are excluded", () => {
  assert.ok(DISTRIBUTION_EXCLUDES.includes("docs/public-readiness.md"));
  const root = new URL("../", import.meta.url);
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter((path) => path && !isExcluded(path));
  const { findings } = scanDistribution(paths.map((path) => ({ path, content: readFileSync(new URL(path, root)) })));
  assert.deepEqual(findings, []);
});

test("private blocks are removed whole, and unbalanced markers are rejected", () => {
  const start = "// distribution:" + "private-start";
  const end = "// distribution:" + "private-end";
  assert.deepEqual(stripPrivateBlocks(`a\n  ${start}\n  secret\n  ${end}\nb\n`), { text: "a\nb\n", blocks: 1 });
  assert.throws(() => stripPrivateBlocks(`${start}\nx\n`), /Unclosed/);
  assert.throws(() => stripPrivateBlocks(`${end}\n`), /without a start/);
});

