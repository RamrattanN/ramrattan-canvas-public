import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidRepositoryName } from "./board-core.mjs";
import { fetchGitHubSnapshot, fetchRepositoryDirectory } from "./github-reader.mjs";

const PORT = 4173;
const HOST = "127.0.0.1";
const CANVAS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(CANVAS_DIR, "ramrattan-shield.png");
const STATIC_FILES = new Map([
  ["/canvas/", [path.join(CANVAS_DIR, "index.html"), "text/html; charset=utf-8"]],
  ["/canvas/index.html", [path.join(CANVAS_DIR, "index.html"), "text/html; charset=utf-8"]],
  ["/canvas/board.css", [path.join(CANVAS_DIR, "board.css"), "text/css; charset=utf-8"]],
  ["/canvas/board.mjs", [path.join(CANVAS_DIR, "board.mjs"), "text/javascript; charset=utf-8"]],
  ["/canvas/board-core.mjs", [path.join(CANVAS_DIR, "board-core.mjs"), "text/javascript; charset=utf-8"]],
  ["/canvas/github-snapshot.json", [path.join(CANVAS_DIR, "github-snapshot.json"), "application/json; charset=utf-8"]],
  ["/canvas/README.md", [path.join(CANVAS_DIR, "README.md"), "text/markdown; charset=utf-8"]],
  ["/canvas/ramrattan-shield.png", [LOGO_PATH, "image/png"]],
  ["/canvas/brands/orbitron-portrait.png", [path.join(CANVAS_DIR, "brands", "orbitron-portrait.png"), "image/png"]],
  ["/canvas/brands/ramrattan-shield.png", [LOGO_PATH, "image/png"]],
]);

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function allowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function isLocalPageRequest(request, port) {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  const originAllowed = port === PORT ? allowedOrigins.has(origin) : [`http://${HOST}:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
  return !(origin && !originAllowed) && !(fetchSite && fetchSite !== "same-origin");
}

// Only repositories the authenticated GitHub CLI reports as accessible may be refreshed.
async function isAllowedRepository(repository, github) {
  if (!isValidRepositoryName(repository)) return false;
  if (!github.allowlist.has(repository)) github.allowlist = new Set((await github.listRepositories()).repositories);
  return github.allowlist.has(repository);
}

function repositoryListError(error) {
  if (error?.code === "cli-missing") return "GitHub CLI (gh) was not found. Install it, run gh auth login in a terminal, then select Reload repositories.";
  if (error?.code === "auth-required") return "GitHub CLI is not signed in. Run gh auth login in a terminal, then select Reload repositories.";
  return "The repository list could not be loaded from GitHub. Run gh auth status in a terminal to check the sign-in, then select Reload repositories.";
}

async function handleRequest(request, response, github) {
  // port 0 (tests and the demo harness only) trusts the loopback port the server was bound to.
  const port = github.port || request.socket.localPort;
  if (!allowedHost(request.headers.host ?? "", port)) {
    response.writeHead(403, securityHeaders);
    response.end("Forbidden");
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { ...securityHeaders, Allow: "GET" });
    response.end("Method not allowed");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const pathname = url.pathname;
  if (pathname === "/api/repositories") {
    if (!isLocalPageRequest(request, port)) {
      sendJson(response, 403, { error: "Repository requests are accepted only from the local Canvas page." });
      return;
    }
    try {
      const { account = "", repositories = [], truncated = false } = await github.listRepositories();
      github.allowlist = new Set(repositories);
      sendJson(response, 200, { account, repositories, truncated });
    } catch (error) {
      sendJson(response, 502, { error: repositoryListError(error) });
    }
    return;
  }
  if (pathname === "/api/refresh") {
    if (!isLocalPageRequest(request, port)) {
      sendJson(response, 403, { error: "Refresh requests are accepted only from the local Canvas page." });
      return;
    }
    const repository = url.searchParams.get("repository") ?? "";
    try {
      if (!await isAllowedRepository(repository, github)) {
        sendJson(response, 400, { error: "That repository is not available to the signed-in GitHub CLI account. The current board snapshot was not changed." });
        return;
      }
      sendJson(response, 200, await github.fetchSnapshot(repository));
    } catch {
      sendJson(response, 502, { error: "GitHub refresh failed. Check GitHub CLI authentication in a terminal and retry. The current board snapshot was not changed." });
    }
    return;
  }

  const staticFile = STATIC_FILES.get(pathname);
  if (!staticFile) {
    response.writeHead(404, securityHeaders);
    response.end("Not found");
    return;
  }
  try {
    const contents = await readFile(staticFile[0]);
    response.writeHead(200, { ...securityHeaders, "Content-Type": staticFile[1] });
    response.end(contents);
  } catch {
    response.writeHead(404, securityHeaders);
    response.end("Not found");
  }
}

export function createCanvasServer({
  listRepositories = () => fetchRepositoryDirectory(),
  fetchSnapshot = (repository) => fetchGitHubSnapshot(undefined, undefined, repository),
  port = PORT,
} = {}) {
  const github = { listRepositories, fetchSnapshot, port, allowlist: new Set() };
  return createServer((request, response) => {
    void handleRequest(request, response, github);
  });
}

export function startCanvasServer() {
  const server = createCanvasServer();
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Canvas listening at http://${HOST}:${PORT}/canvas/\n`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startCanvasServer();