import { spawn } from "node:child_process";
import { isValidRepositoryName, sanitizeGitHubText } from "./board-core.mjs";

export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
export const MAX_CI_PULL_REQUESTS = 20;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const GH_EXECUTABLE = process.platform === "win32" ? "gh.exe" : "gh";

const GH_AUTH_REQUIRED_EXIT_CODE = 4;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function gitHubError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const sensitiveEnvironmentNames = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

export function createGitHubEnvironment(environment) {
  const result = { ...environment, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_NO_UPDATE_NOTIFIER: "1" };
  for (const name of sensitiveEnvironmentNames) delete result[name];
  return result;
}

function runGhApi(endpoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(GH_EXECUTABLE, ["api", "--method", "GET", endpoint], {
      env: createGitHubEnvironment(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("GitHub request timed out."));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("GitHub response exceeded the local size limit."));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(gitHubError("GitHub CLI could not be started.", "cli-missing")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(code === GH_AUTH_REQUIRED_EXIT_CODE ? gitHubError("GitHub CLI is not signed in.", "auth-required") : new Error("GitHub CLI request failed."));
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new Error("GitHub returned an unreadable response."));
      }
    });
  });
}

async function fetchPages(resource, runApi, repository) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const endpoint = `repos/${repository}/${resource}?state=all&per_page=${PAGE_SIZE}&page=${page}`;
    const response = await runApi(endpoint);
    if (!Array.isArray(response)) throw new Error("GitHub returned an unreadable list response.");
    items.push(...response);
    if (response.length < PAGE_SIZE) return items;
  }
  throw new Error("This repository exceeds the local refresh page limit.");
}

function text(value) {
  return sanitizeGitHubText(typeof value === "string" ? value : "");
}

function mapLabels(labels) {
  return Array.isArray(labels) ? labels.map((label) => text(label?.name)).filter(Boolean) : [];
}

function mapAssignees(assignees) {
  return Array.isArray(assignees) ? assignees.map((assignee) => text(assignee?.login)).filter(Boolean) : [];
}

function mapIssue(issue) {
  return {
    number: issue.number,
    type: "issue",
    title: text(issue.title),
    description: text(issue.body),
    url: text(issue.html_url),
    state: text(issue.state),
    stateReason: text(issue.state_reason),
    closedAt: text(issue.closed_at),
    merged: false,
    draft: false,
    updatedAt: text(issue.updated_at),
    assignees: mapAssignees(issue.assignees),
    labels: mapLabels(issue.labels),
    ciStatus: "not-applicable",
    ciChecks: [],
  };
}

function mapPullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    type: "pr",
    title: text(pullRequest.title),
    description: text(pullRequest.body),
    url: text(pullRequest.html_url),
    state: text(pullRequest.state),
    merged: Boolean(pullRequest.merged_at),
    mergedAt: text(pullRequest.merged_at),
    closedAt: text(pullRequest.closed_at),
    draft: Boolean(pullRequest.draft),
    updatedAt: text(pullRequest.updated_at),
    assignees: mapAssignees(pullRequest.assignees),
    labels: mapLabels(pullRequest.labels),
    headSha: /^[a-f0-9]{40}$/i.test(text(pullRequest.head?.sha)) ? pullRequest.head.sha : "",
    ciStatus: "unknown",
    ciChecks: [],
  };
}

function checkRunLabel(check) {
  return {
    name: text(check.name),
    status: text(check.status),
    conclusion: text(check.conclusion),
  };
}

function summarizeCi(checkRunResponse, statusResponse) {
  const checks = Array.isArray(checkRunResponse?.check_runs) ? checkRunResponse.check_runs.map(checkRunLabel) : [];
  const commitStatuses = Array.isArray(statusResponse?.statuses) ? statusResponse.statuses : [];
  const checkConclusion = checks.some((check) => ["failure", "cancelled", "timed_out", "action_required"].includes(check.conclusion));
  const commitFailure = ["failure", "error"].includes(statusResponse?.state);
  const pending = checks.some((check) => check.status !== "completed") || statusResponse?.state === "pending";
  let ciStatus = "none";
  if (checkConclusion || commitFailure) ciStatus = "failure";
  else if (pending) ciStatus = "pending";
  else if (checks.length || commitStatuses.length) ciStatus = "success";
  return { ciStatus, ciChecks: checks };
}

async function mapWithLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  }));
  return results;
}

async function fetchCi(pullRequest, runApi, repository) {
  if (!pullRequest.headSha) return { ...pullRequest, ciStatus: "unknown", ciChecks: [] };
  const base = `repos/${repository}/commits/${pullRequest.headSha}`;
  const [checkRuns, commitStatus] = await Promise.allSettled([
    runApi(`${base}/check-runs?per_page=100`),
    runApi(`${base}/status?per_page=100`),
  ]);
  if (checkRuns.status === "rejected" && commitStatus.status === "rejected") return { ...pullRequest, ciStatus: "unknown", ciChecks: [] };
  return {
    ...pullRequest,
    ...summarizeCi(checkRuns.status === "fulfilled" ? checkRuns.value : null, commitStatus.status === "fulfilled" ? commitStatus.value : null),
  };
}

async function listRepositoryPages(runApi) {
  const names = new Set();
  let truncated = true;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await runApi(`user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(response)) throw new Error("GitHub returned an unreadable repository list.");
    for (const repository of response) if (isValidRepositoryName(repository?.full_name)) names.add(repository.full_name);
    if (response.length < PAGE_SIZE) {
      truncated = false;
      break;
    }
  }
  const repositories = [...names].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }) || left.localeCompare(right));
  return { repositories, truncated };
}

export async function fetchAccessibleRepositories(runApi = runGhApi) {
  return (await listRepositoryPages(runApi)).repositories;
}

// The signed-in gh account and every repository it can read; truncated means the page limit was reached.
export async function fetchRepositoryDirectory(runApi = runGhApi) {
  const [user, listing] = await Promise.all([runApi("user"), listRepositoryPages(runApi)]);
  const login = typeof user?.login === "string" && loginPattern.test(user.login) ? user.login : "";
  return { account: login, ...listing };
}

export async function fetchGitHubSnapshot(runApi = runGhApi, now = () => new Date().toISOString(), repository = "") {
  if (!isValidRepositoryName(repository)) throw new Error("A valid owner/name repository is required.");
  const [issues, pulls] = await Promise.all([
    fetchPages("issues", runApi, repository),
    fetchPages("pulls", runApi, repository),
  ]);
  const pullRequests = pulls.map(mapPullRequest);
  const openPullRequests = pullRequests
    .filter((pullRequest) => pullRequest.state === "open" && !pullRequest.merged)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_CI_PULL_REQUESTS);
  const ciByNumber = new Map(await mapWithLimit(openPullRequests, 4, async (pullRequest) => {
    const result = await fetchCi(pullRequest, runApi, repository);
    return [pullRequest.number, { ciStatus: result.ciStatus, ciChecks: result.ciChecks }];
  }));
  const records = [
    ...issues.filter((issue) => !issue.pull_request).map(mapIssue),
    ...pullRequests.map((pullRequest) => {
      const publicRecord = { ...pullRequest };
      delete publicRecord.headSha;
      return { ...publicRecord, ...(ciByNumber.get(pullRequest.number) ?? {}) };
    }),
  ];
  const uniqueRecords = new Map(records.map((record) => [`${record.type}:${record.number}`, record]));
  return {
    repository,
    exportedAt: now(),
    source: "GitHub CLI read-only refresh",
    records: [...uniqueRecords.values()],
    ciCoverage: {
      checkedOpenPullRequests: openPullRequests.length,
      skippedOpenPullRequests: Math.max(0, pullRequests.filter((pullRequest) => pullRequest.state === "open" && !pullRequest.merged).length - MAX_CI_PULL_REQUESTS),
    },
  };
}