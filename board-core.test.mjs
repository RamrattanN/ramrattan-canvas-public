import assert from "node:assert/strict";
import test from "node:test";

import { ACTIVE_LANE_LIMITS, BOARD_STATUSES, MAX_CUSTOM_LANE_LIMIT, DONE_WINDOW_MS, STORAGE_KEY, legacyRepositoryFromStorage, getBoardMetrics, getCompletionDateISO, getCompletionStatus, getCompletionTimestamp, getDisplayLane, getRecentDoneRecords, isActiveRecord, isHistoricalRecord, isValidRepositoryName, limitActiveLane, matchesFilters, mergeLaneOrder, normalizeLaneLimit, repositoryDisplayName, repositoryIdentity, mergeGitHubRecords, migrateManualOrder, needsCompletionRefresh, normalizeGitHubImport, normalizeGitHubRecord, recordsForView, sanitizeGitHubText, sortCards, storageKeyForRepository } from "./board-core.mjs";

const repository = "Example-Owner/example-repo";

test("all six required lanes exist in the specified order", () => {
  assert.deepEqual(BOARD_STATUSES, ["Backlog", "Ready", "In Progress", "Review", "Blocked", "Done"]);
});

test("normalizes GitHub issues and pull requests without inventing priority or owner", () => {
  const imported = normalizeGitHubImport({ repository, records: [
    { number: 4, type: "issue", title: "An issue", state: "open", draft: false, merged: false, html_url: `https://github.com/${repository}/issues/4` },
    { number: 5, title: "A pull request", state: "closed", merged_at: "2026-10-01T12:00:00Z", html_url: `https://github.com/${repository}/pull/5` },
  ] });
  assert.equal(imported.records[0].type, "Issue");
  assert.equal(imported.records[0].priority, "Untriaged");
  assert.equal(imported.records[0].boardStatus, "Backlog");
  assert.deepEqual(imported.records[0].assignees, []);
  assert.equal(imported.records[1].type, "PR");
  assert.equal(imported.records[1].merged, true);
  assert.equal(imported.records[1].githubState, "closed");
  assert.equal(imported.records[1].boardStatus, "Backlog");
  const openPr = normalizeGitHubRecord({ number: 6, title: "Open PR", type: "PR", state: "open" }, repository);
  assert.equal(openPr.boardStatus, "Backlog");
  const draftPr = normalizeGitHubRecord({ number: 7, title: "Draft PR", type: "PR", state: "open", draft: true }, repository);
  assert.equal(draftPr.draft, true);
  const legacyIssue = normalizeGitHubRecord({ number: 8, type: "PR", title: "Cached issue", state: "open", ciStatus: "not-applicable" }, repository);
  assert.equal(legacyIssue.type, "Issue");
  assert.equal(legacyIssue.key, `${repository}#issue:8`);
});

test("accepts exported snapshot wrappers and API issue arrays", () => {
  assert.equal(normalizeGitHubImport({ repository, exportedAt: "2026-10-19", records: [] }).exportedAt, "2026-10-19");
  assert.equal(normalizeGitHubImport([{ number: 9, title: "Array issue", state: "open" }], repository).records.length, 1);
  assert.equal(normalizeGitHubImport({ repository, issues: [{ number: 10, title: "Issue" }], pullRequests: [{ number: 11, title: "PR", type: "pr" }] }).records.length, 2);
});

test("keeps imported GitHub links inside the selected repository", () => {
  const card = normalizeGitHubRecord({ number: 12, type: "issue", title: "Untrusted link", url: "https://attacker.example/" }, repository);
  assert.equal(card.url, `https://github.com/${repository}/issues/12`);
  const prefixCollision = normalizeGitHubRecord({ number: 12, type: "issue", title: "Wrong issue", url: `https://github.com/${repository}/issues/123` }, repository);
  assert.equal(prefixCollision.url, `https://github.com/${repository}/issues/12`);
});

test("local metadata overrides import lane and priority only when valid", () => {
  const card = normalizeGitHubRecord({ number: 13, title: "Local metadata", state: "open" }, repository, {
    boardStatus: "Review", priority: "P2", workstream: "Help", dependencies: [7],
  });
  assert.equal(card.boardStatus, "Review");
  assert.equal(card.priority, "P2");
  assert.equal(card.workstream, "Help");
  assert.deepEqual(card.dependencies, [7]);
  const invalid = normalizeGitHubRecord({ number: 14, title: "Invalid metadata" }, repository, { boardStatus: "Ship it", priority: "P0" });
  assert.equal(invalid.boardStatus, "Backlog");
  assert.equal(invalid.priority, "Untriaged");
});

test("filters by status, priority, type, workstream, and query", () => {
  const card = normalizeGitHubRecord({ number: 15, type: "pr", title: "Help copy update", state: "open", labels: [{ name: "P2" }] }, repository, {
    boardStatus: "Review", workstream: "Contextual Help",
  });
  assert.equal(matchesFilters(card, { query: "help", status: "Review", priority: "P2", type: "PR", workstream: "Contextual Help" }), true);
  assert.equal(matchesFilters(card, { query: "release", status: "", priority: "", type: "", workstream: "" }), false);
  assert.equal(matchesFilters(card, { query: "", githubStatus: "Ready for review", laneStatus: "Review", priority: "", type: "", workstream: "" }), true);
  assert.equal(matchesFilters(card, { query: "", githubStatus: "Merged", laneStatus: "Review", priority: "", type: "", workstream: "" }), false);
});

test("completion and UTC date filters distinguish completed from uncertain history and search notes", () => {
  const completed = normalizeGitHubRecord({
    number: 16, type: "issue", title: "Completed help item", state: "closed", stateReason: "completed", closedAt: "2026-10-20T12:00:00Z",
  }, repository, { notes: "owner acceptance notes" });
  const uncertain = normalizeGitHubRecord({
    number: 17, type: "issue", title: "Uncertain closure", state: "closed", closedAt: "2026-10-20T12:00:00Z",
  }, repository);
  const filters = { query: "acceptance", githubStatus: "Completed issue", completionStatus: "completed", completedFrom: "2026-10-20", completedTo: "2026-10-20", laneStatus: "", priority: "", type: "Issue", workstream: "" };
  assert.equal(matchesFilters(completed, filters), true);
  assert.equal(matchesFilters(uncertain, { ...filters, query: "" }), false);
  assert.equal(matchesFilters(completed, { ...filters, completedFrom: "2026-10-21" }), false);
});

test("sorts by priority, updated time, and record number", () => {
  const cards = [
    normalizeGitHubRecord({ number: 3, title: "Third", state: "open", updated_at: "2026-10-02" }, repository, { priority: "P3" }),
    normalizeGitHubRecord({ number: 1, title: "First", state: "open", updated_at: "2026-10-03" }, repository, { priority: "P1" }),
  ];
  assert.deepEqual(sortCards(cards, "priority").map((card) => card.number), [1, 3]);
  assert.deepEqual(sortCards(cards, "updated").map((card) => card.number), [1, 3]);
  assert.deepEqual(sortCards(cards, "number").map((card) => card.number), [1, 3]);
});

test("rejects imports for a different repository", () => {
  assert.throws(() => normalizeGitHubImport({ repository: "someone/else", records: [] }, repository), /must match Example-Owner\/example-repo/);
});

test("redacts token-shaped values before issue text is displayed or exported", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const card = normalizeGitHubRecord({
    number: 20,
    title: `Issue ${token}`,
    body: `Authorization: Bearer ${token} and https://example.test/?access_token=${token}`,
    state: "open",
  }, repository, { notes: `GITHUB_TOKEN=${token}` });
  assert.equal(JSON.stringify(card).includes(token), false);
  assert.match(card.title, /\[redacted\]/);
  assert.match(card.description, /access_token=\[redacted\]/);
  assert.match(sanitizeGitHubText(`GH_TOKEN: ${token}`), /GH_TOKEN=\[redacted\]/);
});

test("refresh updates GitHub fields while preserving local lane, priority, notes, and dependencies", () => {
  const current = normalizeGitHubImport({ repository, records: [
    { number: 30, type: "issue", title: "Old title", state: "open", body: "Old description" },
  ] }).records.map((card) => ({
    ...card,
    boardStatus: "In Progress",
    boardStatusExplicit: true,
    pinnedActive: true,
    priority: "P1",
    workstream: "Land parcels",
    dependencies: [12, 13],
    notes: "Operator note stays local.",
  }));
  const incoming = normalizeGitHubImport({ repository, records: [
    { number: 30, type: "issue", title: "Updated title", state: "closed", body: "Updated description", labels: [{ name: "reviewed" }], assignees: [{ login: "operator" }] },
    { number: 31, type: "pr", title: "Ready PR", state: "open", draft: false },
    { number: 32, type: "pr", title: "Merged PR", state: "closed", merged: true },
    { number: 33, type: "issue", title: "Closed issue", state: "closed" },
    { number: 34, type: "issue", title: "New issue", state: "open" },
    { number: 30, type: "pr", title: "Distinct PR identity", state: "open", draft: true },
  ] }).records;
  const merged = mergeGitHubRecords(current, incoming);
  const updatedIssue = merged.find((card) => card.key === `${repository}#issue:30`);
  assert.equal(updatedIssue.title, "Updated title");
  assert.equal(updatedIssue.description, "Updated description");
  assert.equal(updatedIssue.githubState, "closed");
  assert.deepEqual(updatedIssue.labels, ["reviewed"]);
  assert.deepEqual(updatedIssue.assignees, ["operator"]);
  assert.equal(updatedIssue.boardStatus, "In Progress");
  assert.equal(updatedIssue.boardStatusExplicit, true);
  assert.equal(updatedIssue.pinnedActive, true);
  assert.equal(updatedIssue.priority, "P1");
  assert.equal(updatedIssue.workstream, "Land parcels");
  assert.equal(updatedIssue.notes, "Operator note stays local.");
  assert.deepEqual(updatedIssue.dependencies, [12, 13]);

  const readyPr = merged.find((card) => card.key === `${repository}#pull:31`);
  const mergedPr = merged.find((card) => card.key === `${repository}#pull:32`);
  const closedIssue = merged.find((card) => card.key === `${repository}#issue:33`);
  assert.equal(readyPr.draft, false);
  assert.equal(readyPr.boardStatus, "Backlog");
  assert.equal(mergedPr.merged, true);
  assert.equal(mergedPr.boardStatus, "Backlog");
  assert.equal(closedIssue.githubState, "closed");
  assert.equal(closedIssue.boardStatus, "Backlog");
  assert.ok(merged.some((card) => card.key === `${repository}#issue:34`));
  assert.ok(merged.some((card) => card.key === `${repository}#pull:30`));
  assert.equal(merged.length, 6);
  assert.equal(mergeGitHubRecords(merged, incoming).length, 6);
});

test("reconciles exact legacy issue duplicates without collapsing real same-number PR records", () => {
  const updatedAt = "2026-10-19T21:22:12Z";
  const legacyIssue = normalizeGitHubRecord({
    number: 254,
    type: "PR",
    title: "Prevent internal property identifiers",
    url: `https://github.com/${repository}/pull/254`,
    state: "open",
    updatedAt,
  }, repository, { boardStatus: "In Progress", priority: "P2", notes: "Keep local note" });
  const currentRealPr = normalizeGitHubRecord({
    number: 253,
    type: "PR",
    title: "A separate pull request",
    state: "open",
    updatedAt,
  }, repository, { boardStatus: "Review" });
  const updatedIssue = normalizeGitHubRecord({
    number: 254,
    type: "issue",
    title: "Prevent internal property identifiers",
    state: "open",
    updatedAt: "2026-10-20T00:42:23Z",
  }, repository);
  const merged = mergeGitHubRecords([legacyIssue, currentRealPr], [updatedIssue]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((card) => card.type === "Issue").boardStatus, "In Progress");
  assert.equal(merged.find((card) => card.type === "Issue").notes, "Keep local note");
  assert.equal(merged.find((card) => card.type === "PR").title, "A separate pull request");
});

test("a draft PR becoming ready updates GitHub state without moving its local lane", () => {
  const draft = normalizeGitHubRecord({ number: 80, type: "pr", title: "Ready transition", state: "open", draft: true }, repository, {
    boardStatus: "Review", priority: "P2", notes: "Waiting on CI",
  });
  const ready = normalizeGitHubRecord({ number: 80, type: "pr", title: "Ready transition", state: "open", draft: false }, repository);
  const [updated] = mergeGitHubRecords([draft], [ready]);
  assert.equal(updated.draft, false);
  assert.equal(updated.githubState, "open");
  assert.equal(updated.boardStatus, "Review");
  assert.equal(updated.priority, "P2");
  assert.equal(updated.notes, "Waiting on CI");
});

test("Active, History, and All use GitHub state plus explicit historical pins", () => {
  const cards = normalizeGitHubImport({ repository, records: [
    { number: 90, type: "pr", title: "Merged PR", state: "closed", merged: true, boardStatus: "Blocked" },
    { number: 91, type: "issue", title: "Closed issue", state: "closed", boardStatus: "Backlog" },
    { number: 92, type: "issue", title: "Open issue", state: "open", boardStatus: "Backlog" },
    { number: 93, type: "pr", title: "Open PR", state: "open", draft: false, boardStatus: "Review" },
    { number: 94, type: "issue", title: "Pinned historical", state: "closed", pinnedActive: true, boardStatus: "In Progress", boardStatusExplicit: true },
  ] }).records;
  assert.deepEqual(recordsForView(cards, "Active work").map((card) => card.number), [92, 93, 94]);
  assert.deepEqual(recordsForView(cards, "History").map((card) => card.number), [90, 91, 94]);
  assert.equal(recordsForView(cards, "All records").length, 5);
  assert.equal(isActiveRecord(cards[0]), false);
  assert.equal(isHistoricalRecord(cards[0]), true);
  assert.equal(cards[0].boardStatus, "Blocked");
  assert.equal(cards[0].boardStatusExplicit, false);
  assert.equal(cards.find((card) => card.number === 91).boardStatus, "Backlog");
  assert.equal(cards.find((card) => card.number === 91).boardStatusExplicit, false);
  assert.equal(cards.find((card) => card.number === 94).boardStatus, "In Progress");
  assert.equal(cards.find((card) => card.number === 94).boardStatusExplicit, true);
});

test("operational metrics separate GitHub activity from local Kanban lanes", () => {
  const cards = normalizeGitHubImport({ repository, records: [
    { number: 100, type: "issue", title: "Open blocked", state: "open", boardStatus: "Blocked" },
    { number: 101, type: "pr", title: "Open review", state: "open", boardStatus: "Review" },
    { number: 102, type: "pr", title: "Merged", state: "closed", merged: true, boardStatus: "Backlog" },
    { number: 103, type: "issue", title: "Pinned historical", state: "closed", pinnedActive: true },
  ] }).records;
  assert.deepEqual(getBoardMetrics(cards), {
    activeGitHubRecords: 2,
    activeBoardCards: 2,
    blockedActiveWork: 1,
    inReview: 1,
    doneRecently: 0,
    totalCompleted: 1,
    historicalRecords: 2,
    totalTracked: 4,
  });
});

test("legacy manual-order migration is deterministic and idempotent", () => {
  const cards = normalizeGitHubImport({ repository, records: [
    { number: 110, type: "issue", title: "Issue", state: "open" },
    { number: 111, type: "pr", title: "PR", state: "open" },
  ] }).records;
  const legacyOrder = { Backlog: [`${repository}#110`, `${repository}#pull:111`, `${repository}#110`] };
  const migrated = migrateManualOrder(legacyOrder, cards, repository);
  assert.deepEqual(migrated, { Backlog: [`${repository}#issue:110`, `${repository}#pull:111`] });
  assert.deepEqual(migrateManualOrder(migrated, cards, repository), migrated);
  assert.deepEqual(legacyOrder.Backlog, [`${repository}#110`, `${repository}#pull:111`, `${repository}#110`]);
});

test("completion classification distinguishes open, completed, not-planned, unknown, and unmerged closures", () => {
  const records = normalizeGitHubImport({ repository, records: [
    { number: 120, type: "issue", title: "Open issue", state: "open" },
    { number: 121, type: "pr", title: "Open PR", state: "open", draft: false },
    { number: 122, type: "pr", title: "Merged PR", state: "closed", merged: true, mergedAt: "2026-10-18T00:00:00Z" },
    { number: 123, type: "issue", title: "Completed issue", state: "closed", stateReason: "completed", closedAt: "2026-10-18T00:00:00Z" },
    { number: 124, type: "issue", title: "Not planned", state: "closed", stateReason: "not_planned", closedAt: "2026-10-18T00:00:00Z" },
    { number: 125, type: "issue", title: "Unknown close", state: "closed", closedAt: "2026-10-18T00:00:00Z" },
    { number: 126, type: "pr", title: "Closed without merge", state: "closed", merged: false, closedAt: "2026-10-18T00:00:00Z" },
  ] }).records;
  assert.deepEqual(records.map(getCompletionStatus), ["active", "active", "completed", "completed", "not-planned", "closed-unknown", "closed-unmerged"]);
  assert.equal(isActiveRecord(records[0]), true);
  assert.equal(isActiveRecord(records[1]), true);
  const activeView = recordsForView(records, "Active work", new Date("2026-10-19T00:00:00Z"));
  assert.equal(activeView.length, 4);
  assert.equal(activeView.filter((card) => card.githubState === "open").length, 2);
  assert.equal(recordsForView(records, "History").length, 5);
  const doneKeys = new Set(getRecentDoneRecords(records, new Date("2026-10-19T00:00:00Z")).map((card) => card.key));
  assert.equal(getDisplayLane(records[2], doneKeys), "Done");
  assert.equal(getDisplayLane(records[4], doneKeys), "Backlog");
  assert.equal(getDisplayLane({ ...records[0], boardStatus: "Done" }, new Set()), "Backlog");
});

test("Done includes the exact rolling cutoff and excludes expired, future, and invalid timestamps", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const exactCutoff = new Date(now.getTime() - DONE_WINDOW_MS).toISOString();
  const records = normalizeGitHubImport({ repository, records: [
    { number: 130, type: "pr", title: "At cutoff", state: "closed", merged: true, mergedAt: exactCutoff },
    { number: 131, type: "issue", title: "Within window", state: "closed", stateReason: "completed", closedAt: "2026-10-20T11:00:00.000Z" },
    { number: 132, type: "issue", title: "One millisecond old", state: "closed", stateReason: "completed", closedAt: new Date(now.getTime() - DONE_WINDOW_MS - 1).toISOString() },
    { number: 133, type: "pr", title: "Future merge", state: "closed", merged: true, mergedAt: "2026-10-20T12:00:00.001Z" },
    { number: 134, type: "issue", title: "Invalid close time", state: "closed", stateReason: "completed", closedAt: "not-a-date" },
  ] }).records;
  assert.deepEqual(getRecentDoneRecords(records, now).map((card) => card.number), [131, 130]);
  assert.equal(getCompletionTimestamp(records[2]), Date.parse(records[2].closedAt));
  assert.equal(getCompletionTimestamp(records[4]), null);
  assert.equal(getCompletionDateISO(records[0]), "2026-10-06");
  assert.ok(recordsForView(records, "History", now).some((card) => card.number === 132));
});

test("Done caps display at 20 without discarding history and breaks timestamp ties by identity", () => {
  const mergedAt = "2026-10-19T12:00:00.000Z";
  const records = normalizeGitHubImport({ repository, records: Array.from({ length: 35 }, (_, index) => ({
    number: 200 + index,
    type: "pr",
    title: `Merged ${index}`,
    state: "closed",
    merged: true,
    mergedAt,
  })) }).records;
  const done = getRecentDoneRecords(records, new Date("2026-10-20T12:00:00.000Z"));
  assert.equal(done.length, 20);
  assert.deepEqual(done.map((card) => card.key), [...done.map((card) => card.key)].sort());
  assert.equal(recordsForView(records, "History").length, 35);
  assert.equal(recordsForView(records, "All records").length, 35);
});

test("reopening completed work restores Active classification without changing its local lane", () => {
  const current = normalizeGitHubRecord({
    number: 140, type: "issue", title: "Reopened work", state: "closed", stateReason: "completed", closedAt: "2026-10-19T12:00:00Z",
  }, repository, { boardStatus: "Review", boardStatusExplicit: true, priority: "P1", notes: "Keep after reopen" });
  const reopened = normalizeGitHubRecord({
    number: 140, type: "issue", title: "Reopened work", state: "open", stateReason: "", closedAt: null,
  }, repository);
  const [result] = mergeGitHubRecords([current], [reopened]);
  assert.equal(getCompletionStatus(result), "active");
  assert.equal(result.boardStatus, "Review");
  assert.equal(result.boardStatusExplicit, true);
  assert.equal(result.priority, "P1");
  assert.equal(result.notes, "Keep after reopen");
  assert.equal(getCompletionTimestamp(result), null);
});

test("legacy snapshots signal that completion metadata needs refresh without changing their stored cards", () => {
  const cards = normalizeGitHubImport({ repository, records: [
    { number: 150, type: "issue", title: "Legacy completed issue", state: "closed", boardStatus: "Review" },
    { number: 151, type: "pr", title: "Legacy merged PR", state: "closed", merged: true, boardStatus: "Blocked" },
  ] }).records;
  const before = JSON.stringify(cards);
  assert.equal(needsCompletionRefresh(cards, "Agent-imported snapshot"), true);
  assert.equal(needsCompletionRefresh(cards, "Imported GitHub JSON"), true);
  assert.equal(needsCompletionRefresh(cards, "GitHub CLI read-only refresh"), false);
  assert.equal(JSON.stringify(cards), before);
});

test("exported board JSON round-trips V4 completion fields and local metadata without duplicates", () => {
  const token = `ghp_${"b".repeat(36)}`;
  const original = normalizeGitHubImport({ repository, records: [
    { number: 160, type: "pr", title: "Merged work", state: "closed", merged: true, mergedAt: "2026-10-18T10:00:00Z", closedAt: "2026-10-18T10:00:00Z", ciStatus: "success" },
    { number: 160, type: "issue", title: "Same-number issue", state: "closed", state_reason: "completed", closed_at: "2026-10-17T09:00:00Z" },
    { number: 161, type: "issue", title: "Not planned", state: "closed", state_reason: "not_planned", closed_at: "2026-10-16T09:00:00Z" },
  ] }, repository, {
    [`${repository}#pull:160`]: { boardStatus: "Blocked", boardStatusExplicit: true, pinnedActive: true, priority: "P1", workstream: "Release", dependencies: [161], notes: `Keep ${token}` },
  }).records;
  const exported = JSON.parse(JSON.stringify({ repository, exportedAt: "2026-10-20T00:00:00.000Z", records: original }));
  const reimported = normalizeGitHubImport(exported, repository).records;
  assert.deepEqual(reimported, original);
  assert.doesNotMatch(JSON.stringify(exported), /ghp_/);

  const pr = reimported.find((card) => card.key === `${repository}#pull:160`);
  assert.equal(getCompletionStatus(pr), "completed");
  assert.equal(getCompletionTimestamp(pr), Date.parse("2026-10-18T10:00:00Z"));
  assert.equal(pr.notes, "Keep [redacted]");
  assert.deepEqual([pr.boardStatus, pr.boardStatusExplicit, pr.pinnedActive, pr.priority, pr.workstream, pr.dependencies], ["Blocked", true, true, "P1", "Release", [161]]);
  assert.equal(getCompletionStatus(reimported.find((card) => card.key === `${repository}#issue:160`)), "completed");
  assert.equal(getCompletionStatus(reimported.find((card) => card.key === `${repository}#issue:161`)), "not-planned");

  const merged = mergeGitHubRecords(original, reimported);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((card) => card.key).sort(), original.map((card) => card.key).sort());
});

test("Done lane filter follows the displayed lane for a completed item saved In Progress, and a reopened item returns to its active lane", () => {
  const now = new Date("2026-10-21T00:00:00Z");
  const filters = { query: "", priority: "", type: "", workstream: "" };
  const [completed] = normalizeGitHubImport({ repository, records: [
    { number: 130, type: "issue", title: "Completed while In Progress", state: "closed", stateReason: "completed", closedAt: "2026-10-20T00:00:00Z" },
  ] }).records;
  const saved = { ...completed, boardStatus: "In Progress", boardStatusExplicit: true };
  const doneKeys = new Set(getRecentDoneRecords([saved], now).map((card) => card.key));
  assert.equal(matchesFilters(saved, { ...filters, laneStatus: "Done" }, doneKeys), true);
  assert.equal(matchesFilters(saved, { ...filters, laneStatus: "In Progress" }, doneKeys), false);
  assert.equal(saved.boardStatus, "In Progress", "the saved local lane is preserved");

  const reopened = { ...saved, githubState: "open", state: "open", stateReason: null, closedAt: null };
  const reopenedDoneKeys = new Set(getRecentDoneRecords([reopened], now).map((card) => card.key));
  assert.equal(reopenedDoneKeys.has(reopened.key), false);
  assert.equal(matchesFilters(reopened, { ...filters, laneStatus: "In Progress" }, reopenedDoneKeys), true);
  assert.equal(matchesFilters(reopened, { ...filters, laneStatus: "Done" }, reopenedDoneKeys), false);
});
test("validates repository names strictly before they reach storage keys or GitHub endpoints", () => {
  for (const name of ["Example-Owner/example-repo", "a/b", "Owner-1/repo.name_2", "x/.github"]) assert.equal(isValidRepositoryName(name), true, name);
  for (const name of ["", "owner", "owner/", "/repo", "-owner/repo", "owner/..", "owner/.", "../owner/repo", "owner/repo/x", "owner/repo;calc", "owner/re po", "owner/repo\n", null, 42]) {
    assert.equal(isValidRepositoryName(name), false, String(name));
  }
});

test("only the repository saved under the original key keeps it; every other repository gets a separate key", () => {
  assert.equal(storageKeyForRepository(repository, repository), STORAGE_KEY);
  assert.equal(storageKeyForRepository(repository), `${STORAGE_KEY}:${repository}`, "new installations never use the original key");
  const other = storageKeyForRepository("Other/project", repository);
  assert.notEqual(other, STORAGE_KEY);
  assert.notEqual(other, storageKeyForRepository("Other/project-two"));
  assert.throws(() => storageKeyForRepository("../escape"), /valid owner\/name/);
});

test("per-repository saved boards round-trip without leaking lanes, notes, or priorities", () => {
  const storage = new Map();
  const save = (name, records) => storage.set(storageKeyForRepository(name), JSON.stringify({
    repository: name,
    records,
    cardMetadata: Object.fromEntries(records.map((card) => [card.key, { boardStatus: card.boardStatus, boardStatusExplicit: true, priority: card.priority, notes: card.notes }])),
  }));
  const load = (name) => {
    const saved = JSON.parse(storage.get(storageKeyForRepository(name)) ?? "{}");
    if (saved.repository !== name) return [];
    return normalizeGitHubImport({ repository: name, records: saved.records }, name, saved.cardMetadata).records;
  };
  const primary = normalizeGitHubImport({ repository, records: [{ number: 7, title: "Primary work", state: "open" }] }, repository).records
    .map((card) => ({ ...card, boardStatus: "Blocked", priority: "P1", notes: "Primary-only note" }));
  save(repository, primary);
  const otherName = "Other/project";
  assert.deepEqual(load(otherName), [], "a new repository starts empty, not with another board");
  const other = normalizeGitHubImport({ repository: otherName, records: [{ number: 7, title: "Other work", state: "open" }] }, otherName).records;
  assert.equal(other[0].notes, "");
  assert.equal(other[0].boardStatus, "Backlog");
  save(otherName, other.map((card) => ({ ...card, boardStatus: "Review", priority: "P3", notes: "Other-only note" })));
  const restored = load(repository);
  assert.equal(restored[0].key, `${repository}#issue:7`);
  assert.equal(restored[0].boardStatus, "Blocked");
  assert.equal(restored[0].priority, "P1");
  assert.equal(restored[0].notes, "Primary-only note");
  assert.equal(load(otherName)[0].notes, "Other-only note");
  assert.equal(load(otherName)[0].key, `${otherName}#issue:7`);
  assert.throws(() => normalizeGitHubImport({ repository, records: [] }, otherName), /Import must match Other\/project/);
});

test("an existing board saved under the original key still loads for the repository recorded in it", () => {
  const v4Saved = { repository, records: [{ number: 12, type: "Issue", title: "Legacy", githubState: "open" }], cardMetadata: { [`${repository}#issue:12`]: { boardStatus: "Ready", boardStatusExplicit: true, priority: "P2", notes: "kept" } } };
  const storage = new Map([[STORAGE_KEY, JSON.stringify(v4Saved)]]);
  const legacy = legacyRepositoryFromStorage(storage.get(STORAGE_KEY));
  assert.equal(legacy, repository);
  for (const unusable of [null, "", "not json", JSON.stringify({ repository: "../x" }), JSON.stringify([])]) assert.equal(legacyRepositoryFromStorage(unusable), "");
  const saved = JSON.parse(storage.get(storageKeyForRepository(repository, legacy)));
  const [card] = normalizeGitHubImport({ repository, records: saved.records }, repository, saved.cardMetadata).records;
  assert.deepEqual([card.boardStatus, card.priority, card.notes], ["Ready", "P2", "kept"]);
});
test("derives a readable project name from the selected owner/name repository", () => {
  assert.equal(repositoryDisplayName(repository), "Example Repo");
  assert.equal(repositoryDisplayName("RamrattanN/ramrattan-canvas"), "Ramrattan Canvas");
  assert.equal(repositoryDisplayName("Owner/my_repo.v2"), "My Repo V2");
  assert.equal(repositoryDisplayName("Owner/Canvas"), "Canvas");
});
test("active lane limit accepts the preset sizes, All, and validated custom whole numbers", () => {
  assert.deepEqual(ACTIVE_LANE_LIMITS, [25, 50, 75, 100, 200]);
  assert.equal(normalizeLaneLimit("all"), "all");
  assert.equal(normalizeLaneLimit(50), 50);
  assert.equal(normalizeLaneLimit(" 7 "), 7);
  assert.equal(normalizeLaneLimit(MAX_CUSTOM_LANE_LIMIT), MAX_CUSTOM_LANE_LIMIT);
  for (const invalid of [0, -1, 1.5, "1.5", "1e3", "abc", "", null, undefined, Number.NaN, MAX_CUSTOM_LANE_LIMIT + 1, "99999999999999999999"]) {
    assert.equal(normalizeLaneLimit(invalid), null, String(invalid));
  }
});

test("active lane limit caps each Active work lane after sorting without touching the records", () => {
  const sorted = Array.from({ length: 30 }, (_, index) => ({ key: `k${index}` }));
  const capped = limitActiveLane(sorted, "Backlog", "Active work", 25);
  assert.equal(capped.cards.length, 25);
  assert.equal(capped.total, 30);
  assert.equal(capped.cards[0].key, "k0");
  assert.equal(capped.cards.at(-1).key, "k24");
  assert.equal(sorted.length, 30, "the source lane is never truncated");
  for (const lane of ["Ready", "In Progress", "Review", "Blocked"]) assert.equal(limitActiveLane(sorted, lane, "Active work", 7).cards.length, 7, lane);
  assert.equal(limitActiveLane(sorted, "Backlog", "Active work", "all").cards.length, 30);
  assert.equal(limitActiveLane(sorted, "Backlog", "Active work", 100).cards.length, 30);
  assert.equal(limitActiveLane(sorted, "Backlog", "History", 5).cards.length, 30);
  assert.equal(limitActiveLane(sorted, "Backlog", "All records", 5).cards.length, 30);
});

test("Done keeps its rolling 14-day, 20-card window regardless of the active lane limit", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");
  const records = normalizeGitHubImport({ repository, records: Array.from({ length: 25 }, (_, index) => ({ number: index + 1, type: "pr", title: `PR ${index + 1}`, state: "closed", merged: true, mergedAt: new Date(now.getTime() - (index + 1) * 60_000).toISOString() })) }, repository).records;
  const done = getRecentDoneRecords(records, now);
  assert.equal(done.length, 20);
  const shown = limitActiveLane(done, "Done", "Active work", 5);
  assert.equal(shown.cards.length, 20);
  assert.equal(shown.total, 20);
});

test("lane limit persists separately per repository", () => {
  const storage = new Map();
  const save = (name, limit) => storage.set(storageKeyForRepository(name), JSON.stringify({ repository: name, activeLaneLimit: limit, records: [] }));
  const load = (name) => normalizeLaneLimit(JSON.parse(storage.get(storageKeyForRepository(name)) ?? "{}").activeLaneLimit) ?? "all";
  save(repository, 50);
  save("Other/project", 137);
  assert.equal(load(repository), 50);
  assert.equal(load("Other/project"), 137);
  assert.equal(load("Third/project"), "all", "an unsaved repository keeps the existing uncapped behavior");
  storage.set(storageKeyForRepository("Bad/value"), JSON.stringify({ repository: "Bad/value", activeLaneLimit: -4 }));
  assert.equal(load("Bad/value"), "all");
});

test("manual reordering keeps the saved order of cards hidden by filters or the lane cap", () => {
  assert.deepEqual(mergeLaneOrder(["c", "a"], ["a", "b", "c", "d"]), ["c", "a", "b", "d"]);
  assert.deepEqual(mergeLaneOrder(["a"], ["a", "moved", "z"], "moved"), ["a", "z"]);
  assert.deepEqual(mergeLaneOrder(["x"], undefined), ["x"]);
});
test("repository identity uses trusted configuration with an initials fallback", () => {
  assert.deepEqual(repositoryIdentity("RamrattanN/canvas-demo"), { displayName: "Orbitron Sprocket Works", icon: "/canvas/brands/orbitron-portrait.png", iconAlt: "Orbitron Sprocket Works logo", iconFit: "cover", initials: "OS" });
  assert.deepEqual(repositoryIdentity("RamrattanN/ramrattan-canvas"), { displayName: "Ramrattan Canvas", icon: "/canvas/brands/ramrattan-shield.png", iconAlt: "The Ramrattan Consultancy shield", iconFit: "contain", initials: "RC" });
  assert.deepEqual(repositoryIdentity(repository), { displayName: "Example Repo", icon: "", iconAlt: "", iconFit: "cover", initials: "ER" });
  const untrusted = { "Owner/repo": { displayName: "  Example  ", icon: "https://example.com/logo.svg" }, "Owner/script": { icon: "/canvas/brands/../server.mjs" } };
  assert.deepEqual(repositoryIdentity("Owner/repo", untrusted), { displayName: "Example", icon: "", iconAlt: "", iconFit: "cover", initials: "E" });
  assert.equal(repositoryIdentity("Owner/script", untrusted).icon, "");
  assert.equal(repositoryIdentity("Owner/__proto__", { __proto__: { displayName: "Injected" } }).displayName, "Proto");
});
