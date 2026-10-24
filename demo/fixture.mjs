import { BOARD_STATUSES, PRIORITIES, getDisplayLane, getRecentDoneRecords, isValidRepositoryName, normalizeGitHubImport } from "../board-core.mjs";

// Fictional repository identifier used by the bundled synthetic Orbitron snapshot.
export const DEMO_REPOSITORY = "RamrattanN/canvas-demo";
const DATE_FIELDS = ["updatedAt", "closedAt", "mergedAt"];

// Moves every timestamp by the same amount so the newest one lands an hour before now, keeping Done current.
export function shiftSnapshotDates(snapshot, now = new Date()) {
  const times = snapshot.records.flatMap((record) => DATE_FIELDS.map((field) => Date.parse(record[field] ?? ""))).filter(Number.isFinite);
  const offset = now.getTime() - 60 * 60 * 1000 - Math.max(...times);
  const shift = (value) => (Number.isFinite(Date.parse(value ?? "")) ? new Date(Date.parse(value) + offset).toISOString() : value);
  return {
    ...snapshot,
    exportedAt: now.toISOString(),
    records: snapshot.records.map((record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, DATE_FIELDS.includes(key) ? shift(value) : value]))),
  };
}

const planIdPattern = /^(issue|pull):([1-9]\d*)$/;

// Fictional work items carry a [DEMO] title prefix; other records (such as repository maintenance PRs) are left unplanned.
export function isDemoWorkItem(card) {
  return typeof card.title === "string" && card.title.startsWith("[DEMO]");
}

function fullKey(repository, id) {
  if (!planIdPattern.test(id)) throw new Error(`Plan id ${id} must look like issue:1 or pull:2.`);
  return `${repository}#${id}`;
}

// Combines a read-only GitHub snapshot with the local planning plan into a Canvas board export.
export function buildDemoBoard(snapshot, plan, { now = new Date(), exportedAt = now.toISOString() } = {}) {
  if (plan.repository !== DEMO_REPOSITORY || !isValidRepositoryName(plan.repository)) throw new Error(`The demo plan must target ${DEMO_REPOSITORY}.`);
  if (snapshot?.repository !== plan.repository) throw new Error(`The GitHub snapshot is for ${snapshot?.repository}, not ${plan.repository}.`);
  const allRecords = normalizeGitHubImport(snapshot, plan.repository).records;
  const github = allRecords.filter(isDemoWorkItem);
  const ignored = allRecords.filter((card) => !isDemoWorkItem(card)).map((card) => card.key);
  const githubByKey = new Map(github.map((card) => [card.key, card]));
  const planned = new Map();
  for (const entry of plan.records) {
    const key = fullKey(plan.repository, entry.id);
    if (planned.has(key)) throw new Error(`${entry.id} is planned more than once.`);
    if (!githubByKey.has(key)) throw new Error(`${entry.id} is in the plan but is not a [DEMO] record on GitHub.`);
    if (!BOARD_STATUSES.includes(entry.boardStatus) || entry.boardStatus === "Done") throw new Error(`${entry.id} needs a working lane; Done comes only from GitHub.`);
    if (!PRIORITIES.includes(entry.priority)) throw new Error(`${entry.id} priority must be one of ${PRIORITIES.join(", ")}.`);
    planned.set(key, entry);
  }
  const unplanned = github.filter((card) => !planned.has(card.key)).map((card) => card.key);
  if (unplanned.length) throw new Error(`GitHub records missing from the plan: ${unplanned.join(", ")}.`);

  const records = github.map((card) => {
    const entry = planned.get(card.key);
    return {
      ...card,
      boardStatus: entry.boardStatus,
      boardStatusExplicit: true,
      pinnedActive: false,
      priority: entry.priority,
      workstream: entry.workstream,
      dependencies: entry.dependencies ?? [],
      notes: entry.notes ?? "",
      missingFromLatestRefresh: false,
    };
  }).sort((left, right) => left.number - right.number);
  const manualOrder = Object.fromEntries(Object.entries(plan.manualOrder ?? {}).map(([lane, ids]) => [lane, ids.map((id) => fullKey(plan.repository, id))]));
  const board = {
    repository: plan.repository,
    exportedAt,
    source: "Orbitron Sprocket Works demo fixture",
    note: "Fictional demonstration board. GitHub record fields come from a read-only refresh; boardStatus, priority, workstream, dependencies, notes and manualOrder are local planning metadata.",
    records: records.map((record) => {
      const exported = { ...record };
      delete exported.source;
      return exported;
    }),
    manualOrder,
  };
  return { board, laneCounts: laneCounts(records, now), ignored };
}

export function laneCounts(records, now = new Date()) {
  const doneKeys = new Set(getRecentDoneRecords(records, now).map((card) => card.key));
  const counts = Object.fromEntries(BOARD_STATUSES.map((lane) => [lane, 0]));
  for (const card of records) if (card.githubState === "open" || doneKeys.has(card.key)) counts[getDisplayLane(card, doneKeys)] += 1;
  return counts;
}
