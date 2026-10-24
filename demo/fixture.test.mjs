import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeGitHubRecords, normalizeGitHubImport, normalizeManualOrder } from "../board-core.mjs";
import { DEMO_REPOSITORY, buildDemoBoard, isDemoWorkItem, laneCounts, shiftSnapshotDates } from "./fixture.mjs";

const plan = JSON.parse(await readFile(new URL("./orbitron-plan.json", import.meta.url), "utf8"));
const now = new Date("2026-10-24T12:00:00.000Z");

// Synthetic stand-in for the 30 demo records: 24 open issues, PRs 25 and 28 open, 26/27/29/30 merged.
function syntheticSnapshot() {
  const records = [];
  for (let number = 1; number <= 24; number += 1) records.push({ number, type: "issue", title: `[DEMO] Issue ${number}`, state: "open", ciStatus: "not-applicable" });
  for (const number of [25, 28]) records.push({ number, type: "pr", title: `[DEMO] PR ${number}`, state: "open", merged: false });
  for (const number of [26, 27, 29, 30]) records.push({ number, type: "pr", title: `[DEMO] PR ${number}`, state: "closed", merged: true, mergedAt: `2026-10-23T22:5${number - 26}:00Z`, closedAt: `2026-10-23T22:5${number - 26}:00Z` });
  return { repository: DEMO_REPOSITORY, records };
}

test("demo plan targets only the demo repository and yields the agreed six-column distribution", () => {
  const { board, laneCounts: counts } = buildDemoBoard(syntheticSnapshot(), plan, { now });
  assert.equal(board.repository, DEMO_REPOSITORY);
  assert.equal(board.records.length, 30);
  assert.equal(new Set(board.records.map((record) => record.key)).size, 30);
  assert.deepEqual(counts, plan.expectedLaneCounts);
  assert.deepEqual(counts, { Backlog: 8, Ready: 5, "In Progress": 6, Review: 4, Blocked: 3, Done: 4 });
  assert.ok(board.records.every((record) => record.key.startsWith(`${DEMO_REPOSITORY}#`)));
});

test("GitHub state stays authoritative: open records never reach Done and merged PRs do", () => {
  const { board } = buildDemoBoard(syntheticSnapshot(), plan, { now });
  const byNumber = new Map(board.records.map((record) => [record.number, record]));
  for (const number of [26, 27, 29, 30]) assert.equal(byNumber.get(number).merged, true);
  assert.equal(byNumber.get(28).githubState, "open");
  assert.equal(board.records.some((record) => record.boardStatus === "Done"), false);
  const later = laneCounts(board.records, new Date("2026-11-30T00:00:00.000Z"));
  assert.equal(later.Done, 0, "the rolling 14-day window still governs Done");
});

test("demo plan is rejected when it does not match GitHub exactly or targets another repository", () => {
  const snapshot = syntheticSnapshot();
  assert.throws(() => buildDemoBoard({ ...snapshot, records: snapshot.records.slice(1) }, plan, { now }), /not a \[DEMO\] record on GitHub/);
  assert.throws(() => buildDemoBoard({ ...snapshot, records: [...snapshot.records, { number: 31, type: "issue", title: "[DEMO] Extra", state: "open" }] }, plan, { now }), /missing from the plan/);
  assert.throws(() => buildDemoBoard({ ...snapshot, repository: "Other-Owner/other-repo" }, { ...plan, repository: "Other-Owner/other-repo" }, { now }), /must target/);
  assert.throws(() => buildDemoBoard(snapshot, { ...plan, records: plan.records.map((entry) => (entry.id === "issue:1" ? { ...entry, boardStatus: "Done" } : entry)) }, { now }), /Done comes only from GitHub/);
  assert.throws(() => buildDemoBoard(snapshot, { ...plan, records: plan.records.map((entry) => (entry.id === "issue:1" ? { ...entry, priority: "Critical" } : entry)) }, { now }), /priority must be one of/);
});

test("importing the fixture over an already refreshed board applies its lanes and order", () => {
  const { board } = buildDemoBoard(syntheticSnapshot(), plan, { now });
  const refreshed = normalizeGitHubImport(syntheticSnapshot(), DEMO_REPOSITORY).records;
  assert.ok(refreshed.every((card) => card.boardStatus === "Backlog"));
  const imported = normalizeGitHubImport(JSON.parse(JSON.stringify(board)), DEMO_REPOSITORY);
  assert.equal(imported.localPlanningKeys.size, 30);
  const cards = mergeGitHubRecords(refreshed, imported.records, imported.localPlanningKeys);
  assert.deepEqual(laneCounts(cards, now), plan.expectedLaneCounts);
  const order = normalizeManualOrder(board.manualOrder, cards);
  assert.deepEqual(order["In Progress"].map((key) => key.split("#")[1]), plan.manualOrder["In Progress"]);
});

test("raw GitHub JSON imports keep the current local planning, and refreshes never reset lanes", () => {
  const { board } = buildDemoBoard(syntheticSnapshot(), plan, { now });
  const planned = normalizeGitHubImport(board, DEMO_REPOSITORY).records;
  const raw = normalizeGitHubImport(syntheticSnapshot(), DEMO_REPOSITORY);
  assert.equal(raw.localPlanningKeys.size, 0);
  const afterRefresh = mergeGitHubRecords(planned, raw.records, raw.localPlanningKeys);
  assert.deepEqual(laneCounts(afterRefresh, now), plan.expectedLaneCounts);
  assert.equal(afterRefresh.find((card) => card.number === 21).notes, "Robotic inspection blocked by a missing fictional calibration fixture.");
});

test("records without a [DEMO] title, such as maintenance PRs, are reported but not planned", () => {
  const snapshot = syntheticSnapshot();
  snapshot.records.push({ number: 31, type: "pr", title: "docs: add Orbitron branding assets", state: "open", merged: false });
  const { board, laneCounts: counts, ignored } = buildDemoBoard(snapshot, plan, { now });
  assert.deepEqual(ignored, [`${DEMO_REPOSITORY}#pull:31`]);
  assert.equal(board.records.length, 30);
  assert.ok(board.records.every(isDemoWorkItem));
  assert.deepEqual(counts, plan.expectedLaneCounts);
  assert.throws(() => buildDemoBoard(snapshot, { ...plan, records: [...plan.records, { id: "pull:31", boardStatus: "Review", priority: "P3", workstream: "Operations" }] }, { now }), /not a \[DEMO\] record/);
});

test("the bundled synthetic snapshot yields the agreed layout at any date", () => {
  const bundled = JSON.parse(readFileSync(new URL("./orbitron-snapshot.json", import.meta.url), "utf8"));
  assert.equal(bundled.repository, DEMO_REPOSITORY);
  assert.equal(bundled.records.length, 30);
  assert.ok(bundled.records.every(isDemoWorkItem));
  for (const when of ["2026-10-24T12:00:00Z", "2031-05-01T08:30:00Z"]) {
    const moment = new Date(when);
    const shifted = shiftSnapshotDates(bundled, moment);
    const newest = Math.max(...shifted.records.map((record) => Date.parse(record.mergedAt || record.updatedAt)));
    assert.equal(newest, moment.getTime() - 60 * 60 * 1000);
    assert.deepEqual(buildDemoBoard(shifted, plan, { now: moment }).laneCounts, plan.expectedLaneCounts, when);
  }
});

test("imported lane order keeps only known lanes and cards", () => {
  const cards = normalizeGitHubImport(syntheticSnapshot(), DEMO_REPOSITORY).records;
  const first = cards[0].key;
  assert.deepEqual(normalizeManualOrder({ Backlog: [first, first, "Other/repo#issue:1", 7], Bogus: [first] }, cards), { Backlog: [first] });
  assert.deepEqual(normalizeManualOrder(["Backlog"], cards), {});
  assert.deepEqual(normalizeManualOrder(undefined, cards), {});
});
