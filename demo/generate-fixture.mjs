// Writes demo/out/canvas-demo-board.json from the plan and the bundled synthetic snapshot (or, with --live, a read-only GitHub refresh).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchGitHubSnapshot } from "../github-reader.mjs";
import { DEMO_REPOSITORY, buildDemoBoard, shiftSnapshotDates } from "./fixture.mjs";

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(DEMO_DIR, "out", "canvas-demo-board.json");

export async function loadSyntheticSnapshot(now = new Date()) {
  return shiftSnapshotDates(JSON.parse(await readFile(path.join(DEMO_DIR, "orbitron-snapshot.json"), "utf8")), now);
}

export async function generateFixture({ live = false } = {}) {
  const plan = JSON.parse(await readFile(path.join(DEMO_DIR, "orbitron-plan.json"), "utf8"));
  const snapshot = live ? await fetchGitHubSnapshot(undefined, undefined, DEMO_REPOSITORY) : await loadSyntheticSnapshot();
  const { board, laneCounts, ignored } = buildDemoBoard(snapshot, plan);
  const mismatched = Object.entries(plan.expectedLaneCounts).filter(([lane, count]) => laneCounts[lane] !== count);
  if (mismatched.length) throw new Error(`Lane counts differ from the plan: ${JSON.stringify(laneCounts)}. The Done lane depends on the rolling 14-day window.`);
  await mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, `${JSON.stringify(board, null, 2)}\n`);
  return { path: FIXTURE_PATH, records: board.records.length, laneCounts, ignored };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateFixture({ live: process.argv.includes("--live") });
  process.stdout.write(`Wrote ${result.records} records to ${result.path}\n${JSON.stringify(result.laneCounts)}\n`);
  if (result.ignored.length) process.stdout.write(`Not part of the demo plan (no [DEMO] title): ${result.ignored.join(", ")}\n`);
}
