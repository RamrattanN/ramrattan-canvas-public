// Validates the Orbitron demo board in a disposable Chrome profile and captures documentation screenshots.
// Usage: npm run demo:fixture && npm run demo:capture   (needs Chrome; uses the bundled synthetic snapshot, so no GitHub access)
// Images 02 to 05 go to docs/demo/images; the overview goes to demo/out for review, because the published one is approved separately.
// Maintainers can add --live to both commands to use a read-only GitHub refresh instead.
/* global WebSocket */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvasServer } from "../server.mjs";
import { fetchRepositoryDirectory } from "../github-reader.mjs";
import { DEMO_REPOSITORY } from "./fixture.mjs";
import { FIXTURE_PATH, loadSyntheticSnapshot } from "./generate-fixture.mjs";
import { assertFrame, assertFullWidthClip, assertImageSize, assertIsolatedSession, assertSyntheticIdentity, pngSize } from "./screenshot-checks.mjs";

const LIVE = process.argv.includes("--live");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_DIR = path.join(ROOT, "docs", "demo", "images");
// The published overview is a reviewed image; the capture writes a candidate here instead of overwriting it.
const CANDIDATE_DIR = path.join(ROOT, "demo", "out");
const SYNTHETIC_ACCOUNT = "orbitron-demo";
// Matches the approved overview image: 2034 CSS pixels wide at 1.875 device pixels per CSS pixel, so card controls fit inside each lane.
const VIEWPORT = { width: 2034, height: 1000 };
const DEVICE_SCALE = 1.875;
const CHROME_CANDIDATES = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);

if (typeof WebSocket === "undefined") throw new Error("Run with Node.js 22+ or node --experimental-websocket (npm run demo:capture does this).");
const plan = JSON.parse(await readFile(path.join(ROOT, "demo", "orbitron-plan.json"), "utf8"));
if (!existsSync(FIXTURE_PATH)) throw new Error("Fixture not found. Run npm run demo:fixture first.");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server) => { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; };

// 1. With --live, check real repository discovery (V6.2) through a local Canvas server; names are not printed.
let discovery = { account: `${SYNTHETIC_ACCOUNT} (synthetic)`, repositories: [DEMO_REPOSITORY] };
if (LIVE) {
  const realServer = createCanvasServer({ port: 0 });
  const realPort = await listen(realServer);
  discovery = await (await fetch(`http://127.0.0.1:${realPort}/api/repositories`)).json();
  realServer.close();
  assert.ok(discovery.account, "GitHub CLI account was not identified");
  assert.ok(discovery.repositories.includes(DEMO_REPOSITORY), `${DEMO_REPOSITORY} is not available to ${discovery.account}`);
}

// 2. Canvas server for the browser: synthetic account and repository list; synthetic snapshot unless --live.
const server = createCanvasServer({
  port: 0,
  listRepositories: async () => {
    if (LIVE && !(await fetchRepositoryDirectory()).repositories.includes(DEMO_REPOSITORY)) throw new Error("Demo repository unavailable.");
    return { account: SYNTHETIC_ACCOUNT, repositories: [DEMO_REPOSITORY], truncated: false };
  },
  fetchSnapshot: LIVE ? undefined : async () => loadSyntheticSnapshot(),
});
const port = await listen(server);
const profile = await mkdtemp(path.join(os.tmpdir(), "canvas-demo-profile-"));
assertIsolatedSession(profile, port);
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error("Chrome was not found. Set CHROME_PATH.");
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

let socket;
try {
  let debugPort;
  for (let attempt = 0; attempt < 50 && !debugPort; attempt += 1) {
    await sleep(200);
    try { debugPort = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch {}
  }
  const page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((target) => target.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Page script failed");
    return result.result.value;
  };
  const waitFor = async (expression, label, timeout = 120_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(250); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const idle = `!document.querySelector("#refresh-button").disabled && !document.querySelector("#reload-repositories").disabled`;
  const boardState = () => evaluate(`(() => {
    const lanes = {};
    for (const lane of document.querySelectorAll(".lane")) {
      const cards = [...lane.querySelectorAll(".task-card")];
      const demo = cards.filter((card) => card.querySelector("h3").textContent.trim().startsWith("[DEMO]"));
      lanes[lane.dataset.lane] = { count: Number(lane.querySelector(".lane-count").textContent), keys: demo.map((card) => card.dataset.cardKey), status: demo.map((card) => card.querySelector(".github-state").textContent), limit: lane.querySelector(".lane-limit-label")?.textContent ?? "" };
    }
    return lanes;
  })()`);
  const importFile = async (file) => {
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#import-file" });
    await send("DOM.setFileInputFiles", { nodeId, files: [file] });
    await waitFor(`document.querySelector("#notice").textContent.startsWith("Imported")`, "import notice");
  };
  const expectBoard = (lanes, label) => {
    // Only [DEMO] work items are planned; repository maintenance records are reported separately.
    const counts = Object.fromEntries(Object.entries(lanes).map(([lane, value]) => [lane, value.keys.length]));
    assert.deepEqual(counts, plan.expectedLaneCounts, `${label}: lane counts`);
    const keys = Object.values(lanes).flatMap((lane) => lane.keys);
    assert.equal(keys.length, 30, `${label}: rendered cards`);
    assert.equal(new Set(keys).size, 30, `${label}: each record once`);
    assert.ok(lanes.Done.status.every((status) => status === "GitHub: Merged PR"), `${label}: Done holds merged PRs`);
    assert.ok(Object.entries(lanes).filter(([lane]) => lane !== "Done").every(([, lane]) => lane.status.every((status) => /Open|Ready for review|Draft/.test(status))), `${label}: active lanes hold open records`);
    for (const [lane, ids] of Object.entries(plan.manualOrder)) assert.deepEqual(lanes[lane].keys, ids.map((id) => `${DEMO_REPOSITORY}#${id}`), `${label}: ${lane} order`);
    return counts;
  };

  await send("Page.enable");
  await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: DEVICE_SCALE, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/canvas/` });
  // The default repository is not in the demo list, so Canvas switches to the demo and refreshes it once from GitHub.
  await waitFor(`document.querySelector("#repository-select")?.value === ${JSON.stringify(DEMO_REPOSITORY)} && document.querySelectorAll(".task-card").length >= 30 && ${idle}`, "demo refresh");
  const refreshedOnly = await boardState();
  assert.equal(refreshedOnly.Backlog.keys.length, 26, "fresh demo board starts with every open [DEMO] record in Backlog");
  const otherRecords = await evaluate(`[...document.querySelectorAll(".task-card")].filter((card) => !card.querySelector("h3").textContent.trim().startsWith("[DEMO]")).map((card) => card.dataset.cardKey)`);

  await importFile(FIXTURE_PATH);
  const counts = expectBoard(await boardState(), "after fixture import");

  await evaluate(`document.querySelector("#refresh-button").click()`);
  await sleep(500);
  await waitFor(`${idle} && document.querySelector("#notice").textContent.startsWith("Refresh complete")`, "read-only refresh");
  expectBoard(await boardState(), "after GitHub refresh");

  const exported = await evaluate(`new Promise((resolve) => {
    const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => { blob.text().then(resolve); return "about:blank"; };
    HTMLAnchorElement.prototype.click = function () {};
    document.querySelector("#export-button").click();
    URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click;
  })`);
  const exportPath = path.join(profile, "round-trip-export.json");
  await writeFile(exportPath, exported);
  assert.equal(JSON.parse(exported).records.length, 30 + otherRecords.length, "export holds every board record");
  await importFile(exportPath);
  expectBoard(await boardState(), "after export/import round trip");

  await evaluate(`(() => { const select = document.querySelector("#lane-limit"); select.value = "25"; select.dispatchEvent(new Event("change")); const c = document.querySelector("#lane-limit"); c.value = "custom"; c.dispatchEvent(new Event("change")); const input = document.querySelector("#lane-limit-custom"); input.value = "5"; input.dispatchEvent(new Event("change")); })()`);
  const limited = await boardState();
  assert.equal(limited.Backlog.limit, `Showing 5 of ${limited.Backlog.count}`);
  assert.equal(limited["In Progress"].limit, `Showing 5 of ${limited["In Progress"].count}`);
  assert.equal(limited.Done.keys.length, plan.expectedLaneCounts.Done, "Done ignores the card limit");

  const storage = await evaluate(`Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))`);
  const demoKey = `ramrattan-kanban-canvas-v1:${DEMO_REPOSITORY}`;
  assert.equal(JSON.parse(storage[demoKey]).activeLaneLimit, 5, "card limit saved with the demo board");
  assert.ok(Object.entries(storage).filter(([key]) => key !== demoKey).every(([, value]) => !value.includes("canvas-demo#")), "demo data stays in the demo key");

  // Screenshots, after functional checks. Hiding the transient notice is cosmetic only.
  // Every image starts at the top-left corner and spans the viewport, so the header, shield, Orbitron logo, and title are always included.
  const rect = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const setControl = (selector, value) => evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event("input")); control.dispatchEvent(new Event("change")); })()`);
  const isVisible = (selector) => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); const r = element?.getBoundingClientRect(); return Boolean(element && !element.hidden && r.width > 0 && r.height > 0); })()`);
  const assertSyntheticPage = async () => assertSyntheticIdentity(await evaluate(`({
    account: document.querySelector("#repository-account").textContent.trim(),
    repositoryOptions: [...document.querySelectorAll("#repository-select option")].map((option) => option.value),
    cardKeys: [...document.querySelectorAll(".task-card")].map((card) => card.dataset.cardKey),
    links: [...document.querySelectorAll(".task-card a[href^='http']")].map((link) => link.href),
    text: document.body.innerText,
  })`), { account: SYNTHETIC_ACCOUNT, repository: DEMO_REPOSITORY });
  const shoot = async (name, bottom, controls = {}, directory = IMAGE_DIR) => {
    await evaluate(`document.querySelector("#notice").className = "notice"`);
    await sleep(200);
    const documentHeight = await evaluate("document.documentElement.scrollHeight");
    const clip = { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(Math.min(bottom, documentHeight)) };
    assertFullWidthClip(name, clip, VIEWPORT.width, documentHeight);
    const controlState = {};
    for (const [label, selector] of Object.entries(controls)) controlState[label] = await isVisible(selector);
    assertFrame(name, {
      header: await rect(".topbar"), brandLogo: await rect(".brand-logo"), projectLogo: await rect("#project-logo"), title: await rect("#page-title"),
      ...(await evaluate(`({ brandLogoLoaded: document.querySelector(".brand-logo").naturalWidth > 0, projectLogoLoaded: !document.querySelector("#project-logo").hidden && document.querySelector("#project-logo").naturalWidth > 0, titleText: document.querySelector("#page-title").textContent.replace(/\\s+/g, " ").trim() })`)),
      controls: controlState,
    }, clip);
    await assertSyntheticPage();
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
    const image = Buffer.from(data, "base64");
    assertImageSize(name, pngSize(image), clip, DEVICE_SCALE);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), image);
    return path.join(directory, name);
  };
  const bottomOf = async (selector, extra = 0) => { const r = await rect(selector); return r.y + r.height + extra; };
  const captured = [];

  // 05: Cards per active column = Custom (5), with the independent Done column display at its default, 20 (recent 14 days).
  await setControl("#done-display", "20");
  assert.equal(await evaluate(`document.querySelector("#lane-limit").value`), "custom", "05: card limit is Custom");
  assert.equal(await evaluate(`document.querySelector("#lane-limit-custom").value`), "5", "05: custom card limit is 5");
  assert.equal(await evaluate(`document.querySelector(".lane[data-lane='Done'] .done-window-label").textContent`), "Recent · rolling 14 days · max 20", "05: Done shows the recent window");
  captured.push(await shoot("05-search-filters-card-limit.png", (await rect("#board-grid")).y + 420, {
    search: "#search", "GitHub status filter": "#filter-github-status", "Kanban lane filter": "#filter-lane", "Cards per active column": "#lane-limit",
    "custom card limit": "#lane-limit-custom", "Done column display": "#done-display", "Showing 5 of 8": ".lane[data-lane='Backlog'] .lane-limit-label",
  }));

  await setControl("#lane-limit", "all");
  await sleep(200);
  expectBoard(await boardState(), "card limit All");
  // 01: the whole page, header to footer.  Written as a candidate for review; the committed overview is never overwritten.
  captured.push(await shoot("01-board-overview.png", await evaluate("document.documentElement.scrollHeight"), { footer: ".footer" }, CANDIDATE_DIR));
  captured.push(await shoot("02-repository-and-account.png", await bottomOf(".heading-row", 12), { "repository selector": "#repository-select", "synthetic account": "#repository-account", "Last refreshed": ".snapshot-box" }));

  // 03 and 04 use the Kanban lane filter, so the full header sits above one complete lane with nothing cut off.
  await setControl("#filter-lane", "Blocked");
  await sleep(200);
  assert.equal((await boardState()).Blocked.keys.length, plan.expectedLaneCounts.Blocked, "03: every Blocked card shown");
  captured.push(await shoot("03-planning-cards.png", await bottomOf("#board-grid", 16), { "Kanban lane filter": "#filter-lane", "local priority": ".lane[data-lane='Blocked'] [data-priority]", "local notes": ".lane[data-lane='Blocked'] [data-notes]" }));
  await setControl("#filter-lane", "Done");
  await sleep(200);
  const doneLane = (await boardState()).Done;
  assert.equal(doneLane.keys.length, plan.expectedLaneCounts.Done, "04: every merged PR shown");
  assert.ok(doneLane.status.every((status) => status === "GitHub: Merged PR"), "04: Done holds merged PRs");
  captured.push(await shoot("04-done-merged-prs.png", await bottomOf("#board-grid", 16), { "Kanban lane filter": "#filter-lane", "Done window label": ".lane[data-lane='Done'] .done-window-label" }));
  await setControl("#filter-lane", "");

  process.stdout.write(`${JSON.stringify({ account: discovery.account, discoveredRepositories: discovery.repositories.length, laneCounts: counts, otherRecords, checks: ["fixture import", "read-only refresh", "export/import round trip", "card limit", "storage isolation"], screenshots: captured.map((file) => path.relative(ROOT, file)) }, null, 2)}\n`);
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  if (existsSync(profile)) process.stderr.write("Warning: the temporary Chrome profile could not be removed.\n");
}
