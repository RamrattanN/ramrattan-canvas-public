import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import test from "node:test";

import { createGitHubEnvironment, fetchAccessibleRepositories, fetchGitHubSnapshot, fetchRepositoryDirectory, MAX_PAGES, PAGE_SIZE } from "./github-reader.mjs";
import { createCanvasServer } from "./server.mjs";

const REPOSITORY = "Example-Owner/example-repo";

function apiPath(endpoint) {
  return new URL(endpoint, "https://api.github.test/").pathname;
}

test("removes token environment variables before invoking the GitHub CLI", () => {
  const environment = createGitHubEnvironment({
    PATH: "safe-path",
    GH_TOKEN: "do-not-forward",
    GITHUB_TOKEN: "do-not-forward",
    GH_ENTERPRISE_TOKEN: "do-not-forward",
    GITHUB_ENTERPRISE_TOKEN: "do-not-forward",
  });
  assert.equal(environment.PATH, "safe-path");
  assert.equal(environment.GH_PROMPT_DISABLED, "1");
  assert.equal(environment.GH_PAGER, "cat");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
    assert.equal(Object.hasOwn(environment, name), false);
  }
});

test("reads issue and pull pagination with GETs, maps safe fields, and gathers CI for open PRs", async () => {
  const calls = [];
  const openSha = "a".repeat(40);
  const runApi = async (endpoint) => {
    calls.push(endpoint);
    const url = new URL(endpoint, "https://api.github.test/");
    if (url.pathname.endsWith("/issues")) {
      if (url.searchParams.get("page") !== "1") return [];
      return [
        { number: 40, title: "Closed issue", body: "Updated issue description", state: "closed", state_reason: "completed", closed_at: "2026-10-18T12:00:00Z", html_url: `https://github.com/${REPOSITORY}/issues/40`, updated_at: "2026-10-19T00:00:00Z", labels: [{ name: "triaged" }], assignees: [{ login: "operator" }], private_token: "never expose" },
        { number: 41, title: "API PR issue mirror", pull_request: { url: "hidden" } },
      ];
    }
    if (url.pathname.endsWith("/pulls")) {
      if (url.searchParams.get("page") !== "1") return [];
      return [
        { number: 41, title: "Draft PR", body: "PR details", state: "open", draft: true, merged_at: null, html_url: `https://github.com/${REPOSITORY}/pull/41`, updated_at: "2026-10-19T00:02:00Z", head: { sha: openSha, ref: "private-branch-name" }, labels: [], assignees: [] },
        { number: 42, title: "Merged PR", body: "Merged details", state: "closed", draft: false, merged_at: "2026-10-18T00:00:00Z", closed_at: "2026-10-18T00:00:00Z", html_url: `https://github.com/${REPOSITORY}/pull/42`, updated_at: "2026-10-19T00:01:00Z", head: { sha: "b".repeat(40) }, labels: [], assignees: [] },
      ];
    }
    if (url.pathname.endsWith("/check-runs")) return { check_runs: [{ name: "Canvas test", status: "completed", conclusion: "success", details_url: "hidden" }] };
    if (url.pathname.endsWith("/status")) return { state: "success", statuses: [{ context: "CI", state: "success" }] };
    throw new Error(`Unexpected API path: ${url.pathname}`);
  };
  const snapshot = await fetchGitHubSnapshot(runApi, () => "2026-10-19T23:59:00Z", REPOSITORY);
  const issue = snapshot.records.find((record) => record.type === "issue");
  const draftPr = snapshot.records.find((record) => record.type === "pr" && record.number === 41);
  const mergedPr = snapshot.records.find((record) => record.type === "pr" && record.number === 42);
  assert.equal(snapshot.exportedAt, "2026-10-19T23:59:00Z");
  assert.equal(snapshot.repository, REPOSITORY);
  assert.equal(snapshot.records.length, 3);
  assert.equal(issue.state, "closed");
  assert.equal(issue.stateReason, "completed");
  assert.equal(issue.closedAt, "2026-10-18T12:00:00Z");
  assert.equal(issue.description, "Updated issue description");
  assert.deepEqual(issue.assignees, ["operator"]);
  assert.equal(draftPr.draft, true);
  assert.equal(draftPr.ciStatus, "success");
  assert.deepEqual(draftPr.ciChecks, [{ name: "Canvas test", status: "completed", conclusion: "success" }]);
  assert.equal(mergedPr.merged, true);
  assert.equal(mergedPr.mergedAt, "2026-10-18T00:00:00Z");
  assert.equal(mergedPr.closedAt, "2026-10-18T00:00:00Z");
  assert.equal(mergedPr.ciStatus, "unknown");
  assert.equal(JSON.stringify(snapshot).includes("never expose"), false);
  assert.equal(JSON.stringify(snapshot).includes(openSha), false);
  assert.equal(JSON.stringify(snapshot).includes("private-branch-name"), false);
  assert.ok(calls.every((endpoint) => endpoint.startsWith(`repos/${REPOSITORY}/`)));
  assert.ok(calls.filter((endpoint) => endpoint.includes("/issues?")).length === 1);
  assert.ok(calls.filter((endpoint) => endpoint.includes("/pulls?")).length === 1);
});

test("closes a failing refresh without returning a partial snapshot", async () => {
  const runApi = async (endpoint) => {
    if (apiPath(endpoint).endsWith("/issues")) throw new Error("simulated authentication failure");
    return [];
  };
  await assert.rejects(fetchGitHubSnapshot(runApi, undefined, REPOSITORY), /simulated authentication failure/);
});

test("refuses lists that exceed the bounded page limit", async () => {
  let issuePages = 0;
  const runApi = async (endpoint) => {
    if (apiPath(endpoint).endsWith("/issues")) {
      issuePages += 1;
      return Array.from({ length: 100 }, (_, index) => ({ number: issuePages * 100 + index, title: "Issue", state: "open" }));
    }
    return [];
  };
  await assert.rejects(fetchGitHubSnapshot(runApi, undefined, REPOSITORY), /page limit/);
  assert.equal(issuePages, MAX_PAGES);
});

test("the bundled snapshot is an empty starter with no repository records", async () => {
  const snapshot = JSON.parse(await readFile(new URL("./github-snapshot.json", import.meta.url), "utf8"));
  assert.equal(snapshot.repository, "");
  assert.deepEqual(snapshot.records, []);
});

test("browser assets and bundled snapshot contain no GitHub tokens or credential env values", async () => {
  const files = ["index.html", "board.mjs", "board-core.mjs", "github-snapshot.json"];
  const contents = await Promise.all(files.map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")));
  const combined = contents.join("\n");
  assert.doesNotMatch(combined, /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/);
  assert.doesNotMatch(combined, /(?:GH_TOKEN|GITHUB_TOKEN)\s*[:=]\s*[^\s"']+/);
});

test("local refresh server is loopback-only and exposes no GitHub write route", async () => {
  const [serverSource, readerSource] = await Promise.all([
    readFile(new URL("./server.mjs", import.meta.url), "utf8"),
    readFile(new URL("./github-reader.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /const HOST = "127\.0\.0\.1"/);
  assert.match(serverSource, /server\.listen\(PORT, HOST/);
  assert.match(serverSource, /request\.method !== "GET"/);
  assert.match(serverSource, /const STATIC_FILES = new Map/);
  assert.match(readerSource, /\["api", "--method", "GET", endpoint\]/);
  assert.doesNotMatch(readerSource, /--method", "(?:POST|PATCH|PUT|DELETE)"/);
});

test("refresh route rejects non-GET methods, foreign hosts, and cross-site requests before reaching GitHub", async () => {
  const server = createCanvasServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const send = (method, headers) => new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path: "/api/refresh", headers, agent: false }, (response) => {
      response.resume();
      response.on("end", () => resolve(response));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  try {
    const localHost = { Host: "127.0.0.1:4173" };
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await send(method, localHost);
      assert.equal(response.statusCode, 405, method);
      assert.equal(response.headers.allow, "GET");
    }
    assert.equal((await send("GET", { Host: "attacker.example:4173" })).statusCode, 403);
    assert.equal((await send("GET", { ...localHost, Origin: "https://attacker.example" })).statusCode, 403);
    assert.equal((await send("GET", { ...localHost, "Sec-Fetch-Site": "cross-site" })).statusCode, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("lists accessible repositories with read-only paginated GETs, sorted and validated", async () => {
  const calls = [];
  const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => ({ full_name: `Owner/repo-${String(index).padStart(3, "0")}` }));
  const repositories = await fetchAccessibleRepositories(async (endpoint) => {
    calls.push(endpoint);
    if (/[?&]page=1$/.test(endpoint)) return [{ full_name: "zeta/last" }, { full_name: "bad name; rm -rf /" }, ...firstPage];
    return [{ full_name: "Alpha/first" }, { full_name: "zeta/last" }, { full_name: "evil/.." }];
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((endpoint) => apiPath(endpoint) === "/user/repos"));
  assert.equal(repositories[0], "Alpha/first");
  assert.equal(repositories.at(-1), "zeta/last");
  assert.equal(repositories.length, PAGE_SIZE + 2);
  assert.ok(!repositories.some((name) => name.includes(";") || name.endsWith("/..")));
});

test("refreshes only the requested repository and rejects invalid names before calling GitHub", async () => {
  const calls = [];
  const snapshot = await fetchGitHubSnapshot(async (endpoint) => {
    calls.push(endpoint);
    return [];
  }, () => "2026-10-23T00:00:00.000Z", "Other-Owner/other.repo");
  assert.equal(snapshot.repository, "Other-Owner/other.repo");
  assert.ok(calls.length > 0 && calls.every((endpoint) => apiPath(endpoint).startsWith("/repos/Other-Owner/other.repo/")));
  for (const name of ["../etc/passwd", "owner/repo;calc", "owner/repo && whoami", "-owner/repo", "owner/..", "owner", "owner/repo/extra"]) {
    await assert.rejects(fetchGitHubSnapshot(async () => assert.fail(`GitHub called for ${name}`), undefined, name), /valid owner\/name/);
  }
});

test("server lists repositories and refreshes only allowlisted repositories", async () => {
  const refreshed = [];
  let listCalls = 0;
  const server = createCanvasServer({
    listRepositories: async () => { listCalls += 1; return { account: "Viewer", repositories: ["Alpha/first", REPOSITORY], truncated: false }; },
    fetchSnapshot: async (repository) => { refreshed.push(repository); return { repository, records: [] }; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const get = (path) => new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method: "GET", path, headers: { Host: "127.0.0.1:4173" }, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: JSON.parse(body) }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  try {
    const listed = await get("/api/repositories");
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.body, { account: "Viewer", repositories: ["Alpha/first", REPOSITORY], truncated: false });
    assert.equal((await get("/api/refresh")).statusCode, 400, "there is no default repository");
    assert.equal((await get(`/api/refresh?repository=${encodeURIComponent(REPOSITORY)}`)).statusCode, 200);
    assert.equal((await get(`/api/refresh?repository=${encodeURIComponent("Alpha/first")}`)).statusCode, 200);
    for (const name of ["Unlisted/repo", "../../etc/passwd", "Alpha/first;calc", "Alpha/first\" & whoami", ""]) {
      const response = await get(`/api/refresh?repository=${encodeURIComponent(name)}`);
      assert.equal(response.statusCode, 400, name);
      assert.doesNotMatch(response.body.error, /etc|whoami|calc/);
    }
    assert.deepEqual(refreshed, [REPOSITORY, "Alpha/first"]);
    assert.equal(listCalls, 2, "an unlisted valid name re-checks the GitHub list once; invalid names never reach GitHub");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
async function withServer(options, callback) {
  const server = createCanvasServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const get = (path) => new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method: "GET", path, headers: { Host: "127.0.0.1:4173" }, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: JSON.parse(body) }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  try {
    await callback(get);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("repository directory reports the signed-in gh account with read-only GETs", async () => {
  const calls = [];
  const directory = await fetchRepositoryDirectory(async (endpoint) => {
    calls.push(endpoint);
    return endpoint === "user" ? { login: "InfoExample" } : [{ full_name: "b/two" }, { full_name: "A/one" }];
  });
  assert.deepEqual(directory, { account: "InfoExample", repositories: ["A/one", "b/two"], truncated: false });
  assert.deepEqual(calls.map(apiPath).sort(), ["/user", "/user/repos"]);
  const unsafe = await fetchRepositoryDirectory(async (endpoint) => (endpoint === "user" ? { login: "<script>" } : []));
  assert.deepEqual(unsafe, { account: "", repositories: [], truncated: false });
});

test("repository directory flags a list cut off at the page limit instead of hiding it", async () => {
  let page = 0;
  const directory = await fetchRepositoryDirectory(async (endpoint) => {
    if (endpoint === "user") return { login: "Viewer" };
    page += 1;
    return Array.from({ length: PAGE_SIZE }, (_, index) => ({ full_name: `Owner/r${page}-${index}` }));
  });
  assert.equal(page, MAX_PAGES);
  assert.equal(directory.repositories.length, PAGE_SIZE * MAX_PAGES);
  assert.equal(directory.truncated, true);
});

test("reloading repositories refreshes the allowlist without fetching board records", async () => {
  let shared = ["Alpha/first"];
  const refreshed = [];
  await withServer({
    listRepositories: async () => ({ account: "Viewer", repositories: [...shared], truncated: false }),
    fetchSnapshot: async (repository) => { refreshed.push(repository); return { repository, records: [] }; },
  }, async (get) => {
    assert.deepEqual((await get("/api/repositories")).body.repositories, ["Alpha/first"]);
    shared = ["Beta/second"];
    const reloaded = await get("/api/repositories");
    assert.deepEqual(reloaded.body.repositories, ["Beta/second"]);
    assert.deepEqual(refreshed, [], "listing repositories never loads issues or pull requests");
    assert.equal((await get(`/api/refresh?repository=${encodeURIComponent("Alpha/first")}`)).statusCode, 400, "a repository no longer shared is rejected");
    assert.equal((await get(`/api/refresh?repository=${encodeURIComponent("Beta/second")}`)).statusCode, 200);
    assert.deepEqual(refreshed, ["Beta/second"]);
  });
});

test("repository listing returns empty lists and actionable sign-in errors", async () => {
  await withServer({ listRepositories: async () => ({ account: "Viewer", repositories: [], truncated: false }) }, async (get) => {
    const response = await get("/api/repositories");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.repositories, []);
  });
  const cases = [
    [Object.assign(new Error("x"), { code: "auth-required" }), /not signed in\. Run gh auth login/],
    [Object.assign(new Error("x"), { code: "cli-missing" }), /\(gh\) was not found/],
    [new Error("token ghp_should_not_leak"), /gh auth status/],
  ];
  for (const [error, message] of cases) {
    await withServer({ listRepositories: async () => { throw error; } }, async (get) => {
      const response = await get("/api/repositories");
      assert.equal(response.statusCode, 502);
      assert.match(response.body.error, message);
      assert.doesNotMatch(response.body.error, /ghp_|token/);
    });
  }
});
