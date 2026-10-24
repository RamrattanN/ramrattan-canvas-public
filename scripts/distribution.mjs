// Checks a proposed public distribution for credentials, private records, personal data, and dependencies.

// Internal documents and private-repository branding stay out of the public distribution.
export const DISTRIBUTION_EXCLUDES = Object.freeze([
  "docs/public-readiness.md",
  "docs/distribution.md",
]);
const PRIVATE_START = "// distribution:private-start";
const PRIVATE_END = "// distribution:private-end";

const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|ico|webp)$/i;
const SECRET_PATTERNS = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];
const LOCAL_PATH_PATTERN = /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\|(?:^|[\s"'`(])\/(?:Users|home)\/[A-Za-z0-9._-]+/m;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /noreply|@example\.(?:com|org|net)$/i;

export function isPublicAuthor(author) {
  const match = /^([^<>]+?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(String(author ?? "").trim());
  return Boolean(match) && /noreply/i.test(match[2]);
}

export function isExcluded(filePath) {
  return DISTRIBUTION_EXCLUDES.includes(filePath);
}

// Removes lines between private markers (inclusive) so private-only configuration never ships.
export function stripPrivateBlocks(text) {
  const kept = [];
  let blocks = 0;
  let inside = false;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = line.trim();
    if (marker === PRIVATE_START) {
      if (inside) throw new Error("Nested distribution:private-start marker.");
      inside = true;
      blocks += 1;
    } else if (marker === PRIVATE_END) {
      if (!inside) throw new Error("distribution:private-end without a start marker.");
      inside = false;
    } else if (!inside) {
      kept.push(line);
    }
  }
  if (inside) throw new Error("Unclosed distribution:private-start marker.");
  return { text: kept.join(""), blocks };
}

// Applies exclusions and strips private blocks from text files; the result is what gets scanned and written.
export function prepareDistributionFiles(files) {
  let strippedBlocks = 0;
  const prepared = files.filter(({ path }) => !isExcluded(path)).map(({ path, content }) => {
    if (BINARY_EXTENSIONS.test(path)) return { path, content };
    const { text, blocks } = stripPrivateBlocks(content.toString("utf8"));
    strippedBlocks += blocks;
    return { path, content: blocks ? Buffer.from(text) : content };
  });
  return { files: prepared, strippedBlocks };
}

// files: [{ path, content: Buffer }]; denyTerms: private names supplied at run time, never committed.
export function scanDistribution(files, { denyTerms = [] } = {}) {
  const findings = [];
  const reviewAssets = [];
  const terms = denyTerms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  for (const { path, content } of files) {
    if (BINARY_EXTENSIONS.test(path)) {
      reviewAssets.push(path);
      continue;
    }
    const text = content.toString("utf8");
    for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(text)) findings.push({ path, issue: label });
    if (LOCAL_PATH_PATTERN.test(text)) findings.push({ path, issue: "Local file path" });
    const emails = [...new Set(text.match(EMAIL_PATTERN) ?? [])].filter((email) => !ALLOWED_EMAIL.test(email));
    if (emails.length) findings.push({ path, issue: `Email address (${emails.length})` });
    const lower = text.toLowerCase();
    for (const term of terms) if (lower.includes(term)) findings.push({ path, issue: "Private name from the deny list" });
    if (path === "package.json") {
      const manifest = JSON.parse(text);
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        if (manifest[field] && Object.keys(manifest[field]).length) findings.push({ path, issue: `Unexpected ${field}` });
      }
    }
    if (path === "github-snapshot.json") {
      const snapshot = JSON.parse(text);
      if (snapshot.repository || (Array.isArray(snapshot.records) && snapshot.records.length)) findings.push({ path, issue: "Bundled snapshot contains repository records" });
    }
  }
  return { findings, reviewAssets };
}
