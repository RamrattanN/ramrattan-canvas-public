export const BOARD_STATUSES = ["Backlog", "Ready", "In Progress", "Review", "Blocked", "Done"];
export const PRIORITIES = ["P1", "P2", "P3", "Untriaged"];
export const CARD_TYPES = ["Issue", "PR"];
export const STORAGE_KEY = "ramrattan-kanban-canvas-v1";
export const SELECTED_REPOSITORY_KEY = "ramrattan-kanban-canvas-selected-repository";
export const DONE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_DONE_CARDS = 20;
export const DONE_DISPLAY_OPTIONS = [20, 50, 100, "all"];
export function normalizeDoneDisplay(value) {
  return value === "all" ? "all" : [20, 50, 100].includes(Number(value)) ? Number(value) : 20;
}
export const ACTIVE_LANE_LIMITS = [25, 50, 75, 100, 200];
export const MAX_CUSTOM_LANE_LIMIT = 10000;

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const githubTokenPattern = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function sanitizeGitHubText(value) {
  return String(value ?? "")
    .replace(githubTokenPattern, "[redacted]")
    .replace(/\b(GH_TOKEN|GITHUB_TOKEN|Authorization)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/([?&](?:access_token|token)=)[^&#\s]+/gi, "$1[redacted]");
}

// Trusted per-repository identities. Icons are local files served by Canvas under /canvas/brands/; repositories without an entry use initials.
export const REPOSITORY_IDENTITIES = Object.freeze({
  "RamrattanN/canvas-demo": Object.freeze({ displayName: "Orbitron Sprocket Works", icon: "/canvas/brands/orbitron-portrait.png", iconAlt: "Orbitron Sprocket Works logo" }),
  "RamrattanN/ramrattan-canvas": Object.freeze({ icon: "/canvas/brands/ramrattan-shield.png", iconAlt: "The Ramrattan Consultancy shield", iconFit: "contain" }),
});

export function repositoryIdentity(repository, identities = REPOSITORY_IDENTITIES) {
  const configured = Object.hasOwn(identities, repository) ? identities[repository] : {};
  const displayName = typeof configured.displayName === "string" && configured.displayName.trim() ? configured.displayName.trim() : repositoryDisplayName(repository);
  const icon = typeof configured.icon === "string" && /^\/canvas\/brands\/[a-z0-9-]+\.png$/.test(configured.icon) ? configured.icon : "";
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("") || "?";
  // Logos show whole ("contain"); illustrations fill the square ("cover", the default).
  const iconFit = icon && configured.iconFit === "contain" ? "contain" : "cover";
  return { displayName, icon, iconAlt: icon ? configured.iconAlt || `${displayName} logo` : "", iconFit, initials };
}

// Readable project name from owner/name, e.g. octo-org/sprocket-works -> Sprocket Works.
export function repositoryDisplayName(repository) {
  const name = String(repository ?? "").split("/").pop();
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  return words.length ? words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") : String(repository ?? "");
}

export function isValidRepositoryName(value) {
  return typeof value === "string" && repositoryPattern.test(value) && !/\/\.{1,2}$/.test(value);
}

// A board saved by an earlier single-repository version keeps the original key; every other repository gets its own key.
export function storageKeyForRepository(repository, legacyRepository = "") {
  if (!isValidRepositoryName(repository)) throw new Error("A valid owner/name repository is required.");
  return repository === legacyRepository ? STORAGE_KEY : `${STORAGE_KEY}:${repository}`;
}

// Reads which repository owns the original storage key, from that key's saved JSON.
export function legacyRepositoryFromStorage(savedValue) {
  try {
    const repository = JSON.parse(savedValue ?? "null")?.repository;
    return isValidRepositoryName(repository) ? repository : "";
  } catch {
    return "";
  }
}

export function getGitHubStatus(card) {
  if (card.githubState === "open") {
    if (card.type === "PR" && card.draft) return "Draft";
    if (card.type === "PR") return "Ready for review";
    return "Open";
  }
  const completionStatus = getCompletionStatus(card);
  if (completionStatus === "completed") return card.type === "PR" ? "Merged PR" : "Completed issue";
  if (completionStatus === "not-planned") return "Not planned";
  if (completionStatus === "closed-unmerged") return "Closed without merge";
  if (completionStatus === "closed-unknown") return "Closed (reason unknown)";
  return "Unknown";
}

export function getCompletionStatus(card) {
  if (card.githubState === "open") return "active";
  if (card.type === "PR") return card.merged ? "completed" : card.githubState === "closed" ? "closed-unmerged" : "unknown";
  if (card.githubState !== "closed") return "unknown";
  if (card.stateReason === "completed") return "completed";
  if (card.stateReason === "not_planned") return "not-planned";
  return "closed-unknown";
}

export function getCompletionTimestamp(card) {
  if (getCompletionStatus(card) !== "completed") return null;
  const value = card.type === "PR" ? card.mergedAt : card.closedAt;
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function getCompletionDateISO(card) {
  const timestamp = getCompletionTimestamp(card);
  return timestamp === null ? "" : new Date(timestamp).toISOString().slice(0, 10);
}

export function getRecentDoneRecords(cards, now = new Date(), limit = MAX_DONE_CARDS) {
  const referenceTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(referenceTime)) throw new Error("Done-window reference time must be valid.");
  const cutoff = referenceTime - DONE_WINDOW_MS;
  return cards.map((card) => ({ card, timestamp: getCompletionTimestamp(card) }))
    .filter(({ timestamp }) => timestamp !== null && timestamp >= cutoff && timestamp <= referenceTime)
    .sort((left, right) => right.timestamp - left.timestamp || (left.card.key < right.card.key ? -1 : left.card.key > right.card.key ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(({ card }) => card);
}

// The default keeps the existing 14-day window. Expanded modes show older verified completions without changing GitHub state.
export function getDisplayedDoneRecords(cards, now = new Date(), display = 20) {
  const normalized = normalizeDoneDisplay(display);
  if (normalized === 20) return getRecentDoneRecords(cards, now);
  const referenceTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(referenceTime)) throw new Error("Done-window reference time must be valid.");
  return cards.map((card) => ({ card, timestamp: getCompletionTimestamp(card) }))
    .filter(({ timestamp }) => timestamp !== null && timestamp <= referenceTime)
    .sort((left, right) => right.timestamp - left.timestamp || left.card.key.localeCompare(right.card.key))
    .slice(0, normalized === "all" ? cards.length : normalized)
    .map(({ card }) => card);
}

export function isHistoricalRecord(card) {
  return card.githubState === "closed";
}

export function isActiveRecord(card) {
  return card.githubState === "open" || (card.pinnedActive && isHistoricalRecord(card));
}

export function recordsForView(cards, view, now = new Date(), doneDisplay = 20) {
  if (view === "History") return cards.filter(isHistoricalRecord);
  if (view === "All records") return [...cards];
  const active = cards.filter(isActiveRecord);
  const activeKeys = new Set(active.map((card) => card.key));
  return [...active, ...getDisplayedDoneRecords(cards, now, doneDisplay).filter((card) => !activeKeys.has(card.key))];
}

export function getBoardMetrics(cards, now = new Date()) {
  const openRecords = cards.filter((card) => card.githubState === "open");
  const historicalRecords = cards.filter(isHistoricalRecord);
  const doneRecords = getRecentDoneRecords(cards, now);
  return {
    activeGitHubRecords: openRecords.length,
    activeBoardCards: openRecords.length,
    blockedActiveWork: openRecords.filter((card) => card.boardStatus === "Blocked").length,
    inReview: openRecords.filter((card) => card.boardStatus === "Review").length,
    doneRecently: doneRecords.length,
    totalCompleted: cards.filter((card) => getCompletionStatus(card) === "completed").length,
    historicalRecords: historicalRecords.length,
    totalTracked: cards.length,
  };
}

// Returns "all", a positive whole number up to MAX_CUSTOM_LANE_LIMIT, or null when invalid.
export function normalizeLaneLimit(value) {
  if (value === "all") return "all";
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) return null;
  const limit = Number(text);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_CUSTOM_LANE_LIMIT ? limit : null;
}

// Display-only cap applied after filtering and sorting; Done and non-Active views are never capped.
export function limitActiveLane(laneCards, lane, view, limit) {
  const total = laneCards.length;
  if (lane === "Done" || view !== "Active work" || limit === "all" || !Number.isSafeInteger(limit) || total <= limit) return { cards: laneCards, total };
  return { cards: laneCards.slice(0, limit), total };
}

// Keeps the saved position of cards that are hidden by filters or the lane cap.
export function mergeLaneOrder(visibleKeys, previousOrder = [], excludedKey = "") {
  const visible = new Set(visibleKeys);
  return [...visibleKeys, ...previousOrder.filter((key) => !visible.has(key) && key !== excludedKey)];
}

export function getDisplayLane(card, doneKeys) {
  if (doneKeys.has(card.key)) return "Done";
  if (card.boardStatus === "Done") return "Backlog";
  return card.boardStatus;
}

function inferType(record) {
  const declaredType = String(record.type ?? "").toLowerCase();
  if (declaredType === "pr" && record.ciStatus === "not-applicable") return "Issue";
  if (declaredType === "pr" || declaredType === "pull") return "PR";
  if (declaredType === "issue") return "Issue";
  if (record.pull_request || Object.hasOwn(record, "merged_at") || Object.hasOwn(record, "draft")) return "PR";
  return "Issue";
}

function canonicalUrl(record, repository, type, number) {
  const expectedPath = type === "PR" ? "pull" : "issues";
  const candidate = record.url ?? record.html_url ?? record.htmlUrl;
  if (typeof candidate === "string") {
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === "https://github.com" && parsed.pathname === `/${repository}/${expectedPath}/${number}`) return parsed.href;
    } catch {}
  }
  return `https://github.com/${repository}/${expectedPath}/${number}`;
}

function normalizeStatus(status) {
  if (BOARD_STATUSES.includes(status)) return status;
  return "Backlog";
}

function inferPriority(record) {
  const values = [...(record.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? ""), record.priority ?? ""];
  const match = values.join(" ").match(/\bP([123])\b/i);
  return match ? `P${match[1]}` : "Untriaged";
}

export function normalizeGitHubRecord(record, repository, local = {}) {
  const number = Number(record.number);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Each record needs a valid GitHub number.");
  const type = inferType(record);
  const title = sanitizeGitHubText(record.title).trim();
  if (!title) throw new Error(`GitHub #${number} is missing a title.`);
  const merged = Boolean(record.merged ?? record.merged_at);
  const githubState = String(record.githubState ?? record.state ?? "unknown").toLowerCase();
  const identityType = type === "PR" ? "pull" : "issue";
  const labels = Array.isArray(record.labels) ? record.labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean) : [];
  const assignees = Array.isArray(record.assignees) ? record.assignees.map((person) => typeof person === "string" ? person : person.login).filter(Boolean) : [];
  const key = `${repository}#${identityType}:${number}`;
  const ciStates = ["success", "failure", "pending", "none", "unknown", "not-applicable"];
  const ciChecks = Array.isArray(record.ciChecks) ? record.ciChecks.map((check) => ({
    name: String(check.name ?? ""),
    status: String(check.status ?? ""),
    conclusion: String(check.conclusion ?? ""),
  })) : [];

  return {
    key,
    number,
    type,
    title,
    url: canonicalUrl(record, repository, type, number),
    githubState,
    stateReason: String(record.stateReason ?? record.state_reason ?? ""),
    merged,
    closedAt: record.closedAt ?? record.closed_at ?? "",
    mergedAt: record.mergedAt ?? record.merged_at ?? "",
    draft: Boolean(record.draft),
    updatedAt: record.updatedAt ?? record.updated_at ?? "",
    description: sanitizeGitHubText(record.description ?? record.body),
    ciStatus: ciStates.includes(record.ciStatus) ? record.ciStatus : type === "Issue" ? "not-applicable" : "unknown",
    ciChecks: ciChecks.map((check) => ({ ...check, name: sanitizeGitHubText(check.name) })),
    assignees: assignees.map(sanitizeGitHubText),
    labels: labels.map(sanitizeGitHubText),
    summary: sanitizeGitHubText(record.summary),
    workstream: sanitizeGitHubText(local.workstream ?? record.workstream ?? "Other"),
    priority: PRIORITIES.includes(local.priority ?? record.priority) ? (local.priority ?? record.priority) : inferPriority(record),
    boardStatus: normalizeStatus(local.boardStatus ?? record.boardStatus),
    boardStatusExplicit: Boolean(local.boardStatusExplicit ?? record.boardStatusExplicit),
    pinnedActive: Boolean(local.pinnedActive ?? record.pinnedActive),
    dependencies: Array.isArray(local.dependencies ?? record.dependencies) ? (local.dependencies ?? record.dependencies).map(Number).filter(Number.isSafeInteger) : [],
    notes: sanitizeGitHubText(local.notes ?? record.notes),
    missingFromLatestRefresh: Boolean(record.missingFromLatestRefresh),
    source: "github-import",
  };
}

function recordList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.issues) || Array.isArray(payload?.pullRequests)) return [...(payload.issues ?? []), ...(payload.pullRequests ?? [])];
  throw new Error("JSON must be a GitHub API array or contain records, issues, or pullRequests arrays.");
}

export function normalizeGitHubImport(payload, fallbackRepository, localByKey = {}) {
  const repository = payload?.repository ?? payload?.full_name ?? fallbackRepository;
  if (!isValidRepositoryName(repository)) throw new Error("Import must identify a GitHub repository as owner/name.");
  // Callers pass the selected repository; without one the payload's own repository is used.
  if (fallbackRepository !== undefined && repository !== fallbackRepository) throw new Error(`Import must match ${fallbackRepository}.`);
  const records = recordList(payload);
  const byKey = new Map();
  const localPlanningKeys = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const identityType = inferType(record) === "PR" ? "pull" : "issue";
    const local = localByKey[`${repository}#${identityType}:${record.number}`] ?? localByKey[`${repository}#${record.number}`] ?? {};
    const normalized = normalizeGitHubRecord(record, repository, local);
    byKey.set(normalized.key, normalized);
    if (LOCAL_FIELDS.some((field) => Object.hasOwn(record, field))) localPlanningKeys.add(normalized.key);
  }
  return { repository, records: [...byKey.values()], localPlanningKeys, exportedAt: payload?.exportedAt ?? payload?.exported_at ?? payload?.capturedAt ?? "" };
}

export function sortCards(cards, mode) {
  const priorityRank = { P1: 0, P2: 1, P3: 2, Untriaged: 3 };
  return [...cards].sort((left, right) => {
    if (mode === "priority") return priorityRank[left.priority] - priorityRank[right.priority] || left.number - right.number;
    if (mode === "updated") return String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.number - right.number;
    if (mode === "number") return left.number - right.number;
    return 0;
  });
}

// Pass the board's doneKeys so the lane filter matches the lane the card is displayed in.
export function matchesFilters(card, filters, doneKeys) {
  const query = filters.query.trim().toLowerCase();
  const completionStatus = getCompletionStatus(card);
  const completionDate = getCompletionDateISO(card);
  const searchable = `${card.title} ${card.number} ${card.notes} ${getGitHubStatus(card)} ${completionStatus} ${completionDate}`.toLowerCase();
  const timestamp = getCompletionTimestamp(card);
  const fromDate = filters.completedFrom ? Date.parse(`${filters.completedFrom}T00:00:00.000Z`) : null;
  const toDate = filters.completedTo ? Date.parse(`${filters.completedTo}T23:59:59.999Z`) : null;
  const lane = doneKeys ? getDisplayLane(card, doneKeys) : card.boardStatus;
  return (!query || searchable.includes(query))
    && (!filters.githubStatus || getGitHubStatus(card) === filters.githubStatus)
    && (!filters.completionStatus || completionStatus === filters.completionStatus)
    && (!filters.completedFrom || (timestamp !== null && Number.isFinite(fromDate) && timestamp >= fromDate))
    && (!filters.completedTo || (timestamp !== null && Number.isFinite(toDate) && timestamp <= toDate))
    && (!(filters.laneStatus ?? filters.status) || lane === (filters.laneStatus ?? filters.status))
    && (!filters.priority || card.priority === filters.priority)
    && (!filters.type || card.type === filters.type)
    && (!filters.workstream || card.workstream === filters.workstream);
}

const LOCAL_FIELDS = ["boardStatus", "boardStatusExplicit", "pinnedActive", "priority", "workstream", "dependencies", "notes"];

// Records listed in incomingLocalKeys (a Canvas board export) bring their own local planning fields.
export function mergeGitHubRecords(currentRecords, incomingRecords, incomingLocalKeys = new Set()) {
  const currentByKey = new Map(currentRecords.map((record) => [record.key, record]));
  const incomingKeys = new Set();
  const reconciledLegacyKeys = new Set();
  const mergedRecords = incomingRecords.map((record) => {
    incomingKeys.add(record.key);
    const legacy = record.type === "Issue" ? currentRecords.find((candidate) => (
      candidate.type === "PR"
      && candidate.number === record.number
      && candidate.title === record.title
      && candidate.ciStatus === "unknown"
      && candidate.url !== record.url
    )) : undefined;
    const current = currentByKey.get(record.key) ?? legacy;
    if (legacy) reconciledLegacyKeys.add(legacy.key);
    if (!current || incomingLocalKeys.has(record.key)) return { ...record, missingFromLatestRefresh: false };
    const localFields = Object.fromEntries(LOCAL_FIELDS.map((field) => [field, current[field]]));
    return { ...record, ...localFields, missingFromLatestRefresh: false };
  });
  for (const current of currentRecords) {
    if (!incomingKeys.has(current.key) && !reconciledLegacyKeys.has(current.key)) mergedRecords.push({ ...current, missingFromLatestRefresh: true });
  }
  return [...new Map(mergedRecords.map((record) => [record.key, record])).values()];
}

// Accepts an imported lane order, keeping only known lanes and cards on this board.
export function normalizeManualOrder(manualOrder, cards) {
  if (!manualOrder || typeof manualOrder !== "object" || Array.isArray(manualOrder)) return {};
  const cardKeys = new Set(cards.map((card) => card.key));
  return Object.fromEntries(BOARD_STATUSES
    .filter((lane) => Array.isArray(manualOrder[lane]))
    .map((lane) => [lane, [...new Set(manualOrder[lane].filter((key) => typeof key === "string" && cardKeys.has(key)))]]));
}

export function migrateManualOrder(manualOrder, cards, repository) {
  const legacyKeys = new Map(cards.map((card) => [`${repository}#${card.number}`, card.key]));
  return Object.fromEntries(Object.entries(manualOrder ?? {}).map(([lane, keys]) => [
    lane,
    [...new Set(keys.map((key) => legacyKeys.get(key) ?? key))],
  ]));
}

export function needsCompletionRefresh(cards, source) {
  if (source === "GitHub CLI read-only refresh") return false;
  return cards.some((card) => card.githubState === "closed" && (
    (card.type === "Issue" && (!card.stateReason || (card.stateReason === "completed" && !card.closedAt)))
    || (card.type === "PR" && card.merged && !card.mergedAt)
  ));
}