import { ACTIVE_LANE_LIMITS, BOARD_STATUSES, CARD_TYPES, MAX_CUSTOM_LANE_LIMIT, PRIORITIES, SELECTED_REPOSITORY_KEY, STORAGE_KEY, getBoardMetrics, getCompletionDateISO, getCompletionStatus, getCompletionTimestamp, getDisplayLane, getGitHubStatus, getRecentDoneRecords, isHistoricalRecord, isValidRepositoryName, legacyRepositoryFromStorage, limitActiveLane, matchesFilters, mergeLaneOrder, repositoryIdentity, mergeGitHubRecords, migrateManualOrder, needsCompletionRefresh, normalizeGitHubImport, normalizeLaneLimit, normalizeManualOrder, recordsForView, sanitizeGitHubText, sortCards, storageKeyForRepository } from "./board-core.mjs";

const $ = (selector) => document.querySelector(selector);
const grid = $("#board-grid");
const notice = $("#notice");
const snapshot = await fetch("./github-snapshot.json").then((response) => {
  if (!response.ok) throw new Error("The bundled GitHub snapshot could not be loaded.");
  return response.json();
});
const legacyRepository = readLegacyRepository();
let repository = readSelectedRepository();
let importedAt;
let sourceLabel;
let cards;
let manualOrder;
let noticeTimer;
let isRefreshing = false;
let lastRefreshAt;
let currentView;
let activeLaneLimit;
let customLaneLimitPending = false;
let availableRepositories = [];
let repositoryListError = "";
let repositoryAccount = "";
let isLoadingRepositories = false;

function readLegacyRepository() {
  try {
    return legacyRepositoryFromStorage(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "";
  }
}

// Saved selection first, then the board from an earlier single-repository version; otherwise none until the list loads.
function readSelectedRepository() {
  try {
    const saved = localStorage.getItem(SELECTED_REPOSITORY_KEY);
    if (isValidRepositoryName(saved)) return saved;
  } catch {}
  return legacyRepository;
}

// Only the default repository has a bundled snapshot; other repositories start empty until refreshed.
function bundledSnapshotFor(name) {
  return name === snapshot.repository ? snapshot : { repository: name, records: [] };
}

function resetBoardState() {
  const base = bundledSnapshotFor(repository);
  importedAt = base.exportedAt ?? "";
  sourceLabel = base === snapshot ? "Agent-imported snapshot" : "Not loaded";
  cards = normalizeGitHubImport(base, repository).records;
  manualOrder = {};
  lastRefreshAt = null;
  currentView = "Active work";
  activeLaneLimit = "all";
  customLaneLimitPending = false;
}

// Returns true when this repository already has saved records in this browser.
function loadLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKeyForRepository(repository, legacyRepository)) ?? "{}");
    if (saved.repository !== repository) return false;
    sourceLabel = saved.sourceLabel ?? sourceLabel;
    importedAt = saved.importedAt ?? importedAt;
    lastRefreshAt = saved.lastRefreshAt ?? null;
    if (["Active work", "All records", "History"].includes(saved.currentView)) currentView = saved.currentView;
    activeLaneLimit = normalizeLaneLimit(saved.activeLaneLimit) ?? "all";
    const savedSnapshot = Array.isArray(saved.records) ? { repository, records: saved.records } : bundledSnapshotFor(repository);
    cards = normalizeGitHubImport(savedSnapshot, repository, saved.cardMetadata ?? {}).records;
    manualOrder = migrateManualOrder(saved.manualOrder, cards, repository);
    return cards.length > 0;
  } catch {
    showNotice("Saved local board settings were unreadable. The bundled snapshot is still available.", "warning");
    return false;
  }
}

function persistLocalState() {
  const cardMetadata = Object.fromEntries(cards.map((card) => [card.key, {
    boardStatus: card.boardStatus,
    boardStatusExplicit: card.boardStatusExplicit,
    pinnedActive: card.pinnedActive,
    priority: card.priority,
    workstream: card.workstream,
    dependencies: card.dependencies,
    notes: card.notes,
  }]));
  const records = cards.map(({ number, type, title, description, url, githubState, stateReason, closedAt, merged, mergedAt, draft, ciStatus, ciChecks, updatedAt, assignees, labels, summary, workstream, priority, boardStatus, boardStatusExplicit, pinnedActive, dependencies, missingFromLatestRefresh }) => ({
    number, type, title, description, url, githubState, stateReason, closedAt, merged, mergedAt, draft, ciStatus, ciChecks, updatedAt, assignees, labels, summary, workstream, priority, boardStatus, boardStatusExplicit, pinnedActive, dependencies, missingFromLatestRefresh,
  }));
  localStorage.setItem(storageKeyForRepository(repository, legacyRepository), JSON.stringify({ repository, sourceLabel, importedAt, lastRefreshAt, currentView, activeLaneLimit, records, cardMetadata, manualOrder }));
}

function showNotice(message, kind = "") {
  notice.textContent = message;
  notice.className = `notice is-visible ${kind}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.className = "notice"; }, 4500);
}

function localDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
}

function completionDateLabel(card) {
  const timestamp = getCompletionTimestamp(card);
  if (timestamp === null) return "Completion date unavailable";
  const isoDate = getCompletionDateISO(card);
  const displayDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(timestamp);
  return `<time datetime="${isoDate}">Completed ${displayDate} UTC</time>`;
}

function ciStatusLabel(card) {
  if (card.type !== "PR") return "";
  const labels = { success: "CI · Success", failure: "CI · Failed", pending: "CI · Running", none: "CI · No checks", unknown: "CI · Unavailable", "not-fetched": "CI · Not checked" };
  return labels[card.ciStatus] ?? labels.unknown;
}

function fillFilter(id, values, firstLabel) {
  const control = $(id);
  const selected = control.value;
  control.innerHTML = `<option value="">${firstLabel}</option>` + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  if (values.includes(selected)) control.value = selected;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function getFilters() {
  return {
    query: $("#search").value,
    githubStatus: $("#filter-github-status").value,
    completionStatus: $("#filter-completion-status").value,
    completedFrom: $("#filter-completed-from").value,
    completedTo: $("#filter-completed-to").value,
    laneStatus: $("#filter-lane").value,
    priority: $("#filter-priority").value,
    type: $("#filter-type").value,
    workstream: $("#filter-workstream").value,
  };
}

function updateView(view) {
  if (!["Active work", "All records", "History"].includes(view)) return;
  currentView = view;
  persistLocalState();
  render();
}

function sortLane(laneCards, lane) {
  const mode = $("#sort-order").value;
  if (mode !== "manual") return sortCards(laneCards, mode);
  const order = manualOrder[lane] ?? [];
  return [...laneCards].sort((left, right) => {
    const leftIndex = order.indexOf(left.key);
    const rightIndex = order.indexOf(right.key);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex) || left.number - right.number;
  });
}

function renderCard(card, displayLane) {
  const dependencyMarkup = card.dependencies.length
    ? card.dependencies.map((number) => {
      const dependency = cards.find((item) => item.number === number);
      const url = dependency?.url ?? `https://github.com/${repository}/issues/${number}`;
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">#${number}</a>`;
    }).join(" ")
    : "None";
  const owners = card.assignees.length ? card.assignees.map(escapeHtml).join(", ") : "Unassigned";
  const kind = card.type === "PR" ? "Pull request" : "Issue";
  const githubStatus = getGitHubStatus(card);
  const completionStatus = getCompletionStatus(card);
  const labels = card.labels.map((label) => `<span class="github-label">${escapeHtml(label)}</span>`).join("");
  const ci = ciStatusLabel(card);
  const completionInfo = completionStatus === "completed"
    ? `<p class="completion-info"><b>${card.type === "PR" ? "Merged PR" : "Completed issue"}</b><span>${completionDateLabel(card)}</span><small>Completion derived from GitHub</small></p>`
    : completionStatus === "not-planned"
      ? `<p class="completion-info completion-uncertain"><b>Not planned</b><small>Closed by GitHub as not planned; not counted as completed.</small></p>`
      : completionStatus === "closed-unknown"
        ? `<p class="completion-info completion-uncertain"><b>Closed; reason unknown</b><small>Not counted as completed because GitHub did not report a completed reason.</small></p>`
        : completionStatus === "closed-unmerged"
          ? `<p class="completion-info completion-uncertain"><b>Closed without merge</b><small>Not counted as completed.</small></p>`
          : "";
  const laneOrigin = card.boardStatusExplicit ? "User-assigned lane" : "Legacy/default lane";
  const retentionControl = card.pinnedActive || isHistoricalRecord(card)
    ? `<button class="pin-button" data-pin="${escapeHtml(card.key)}" type="button" aria-pressed="${card.pinnedActive}">${card.pinnedActive ? "Remove Active retention" : "Retain in Active work"}</button>`
    : `<span class="active-source-label">Active from GitHub</span>`;
  const localLaneDescription = displayLane === "Done"
    ? `Previous local lane: ${card.boardStatus} (${laneOrigin})`
    : card.boardStatus === "Done" ? "Saved lane Done; GitHub completion is not inferred" : `${card.boardStatus} (${laneOrigin})`;
  return `<article class="task-card ${displayLane === "Done" ? "done-card" : ""}" draggable="true" data-card-key="${escapeHtml(card.key)}" data-number="${card.number}">
    <div class="card-top"><span class="record-id">#${card.number}</span><span class="record-type type-${card.type.toLowerCase()}">${kind}</span><span class="priority priority-${card.priority.toLowerCase()}">${card.priority === "Untriaged" ? "No priority" : card.priority}</span></div>
    <h3><a href="${escapeHtml(card.url)}" target="_blank" rel="noreferrer">${escapeHtml(card.title)}</a></h3>
    <div class="card-tags"><span>${escapeHtml(card.workstream)}</span><span class="github-state ${card.merged ? "is-merged" : ""}">GitHub: ${githubStatus}</span>${ci ? `<span class="ci-state ci-${escapeHtml(card.ciStatus)}">${ci}</span>` : ""}${card.pinnedActive ? `<span class="pinned-state">Retained in Active work</span>` : ""}${card.missingFromLatestRefresh ? `<span class="stale-state">Not in latest refresh</span>` : ""}${labels}</div>
    ${card.summary ? `<p class="card-summary">${escapeHtml(card.summary)}</p>` : ""}
    ${completionInfo}
    ${card.description ? `<details class="description"><summary>GitHub description</summary><p>${escapeHtml(card.description)}</p></details>` : ""}
    <dl class="card-meta"><div><dt>Owner</dt><dd>${owners}</dd></div><div><dt>Display lane</dt><dd>${escapeHtml(displayLane)}</dd></div><div><dt>Saved Kanban lane</dt><dd>${escapeHtml(localLaneDescription)}</dd></div><div class="dependencies"><dt>Dependencies</dt><dd>${dependencyMarkup}</dd></div></dl>
    <div class="card-controls"><label><span>Local priority</span><select data-priority="${escapeHtml(card.key)}" aria-label="Local priority for #${card.number}">${PRIORITIES.map((value) => `<option value="${value}" ${value === card.priority ? "selected" : ""}>${value === "Untriaged" ? "Untriaged" : value}</option>`).join("")}</select></label><label><span>Local lane</span><select data-status="${escapeHtml(card.key)}" aria-label="Local lane for #${card.number}">${BOARD_STATUSES.map((value) => `<option value="${escapeHtml(value)}" ${value === card.boardStatus ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label><label class="notes-control"><span>Local notes</span><textarea data-notes="${escapeHtml(card.key)}" rows="2" aria-label="Local notes for #${card.number}">${escapeHtml(card.notes)}</textarea></label>${retentionControl}<a class="record-link" href="${escapeHtml(card.url)}" target="_blank" rel="noreferrer">Open GitHub <span aria-hidden="true">↗</span></a></div>
  </article>`;
}

function renderRepositorySelect() {
  const control = $("#repository-select");
  const names = !repository || availableRepositories.includes(repository) ? availableRepositories : [repository, ...availableRepositories];
  control.innerHTML = (repository ? "" : `<option value="">Select a repository</option>`) + names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  control.value = repository;
  control.disabled = isRefreshing || availableRepositories.length === 0;
  $("#repository-status").textContent = repositoryListError || (availableRepositories.length || !isLoadingRepositories ? "" : "Loading repositories…");
  const count = `${availableRepositories.length} ${availableRepositories.length === 1 ? "repository" : "repositories"}`;
  $("#repository-account").textContent = isLoadingRepositories ? "Checking GitHub CLI account…" : repositoryAccount ? `Signed in as ${repositoryAccount} · ${count}` : repositoryListError ? "" : count;
  $("#reload-repositories").disabled = isLoadingRepositories;
  $("#reload-repositories").setAttribute("aria-busy", String(isLoadingRepositories));
  const identity = repository ? repositoryIdentity(repository) : { displayName: "No repository selected", icon: "", iconAlt: "", initials: "?" };
  const projectName = identity.displayName;
  renderProjectMark(identity);
  $("#project-name").textContent = projectName;
  $("#repository-name").textContent = projectName;
  $("#repository-name").title = repository;
  document.title = `${projectName} | Project Delivery Board`;
}

// Shows the configured icon, or initials when there is none or it fails to load.
function renderProjectMark(identity) {
  const logo = $("#project-logo");
  if (logo.dataset.icon !== identity.icon) {
    logo.dataset.icon = identity.icon;
    logo.dataset.failed = "";
    if (identity.icon) logo.src = identity.icon;
    else logo.removeAttribute("src");
  }
  const showLogo = Boolean(identity.icon) && logo.dataset.failed !== "true";
  logo.alt = identity.iconAlt;
  logo.classList.toggle("is-contained", identity.iconFit === "contain");
  logo.hidden = !showLogo;
  $("#project-initials").textContent = identity.initials;
  $("#project-initials").hidden = showLogo;
}

// Shown until the GitHub CLI reports at least one repository.
function renderWithoutRepository() {
  renderRepositorySelect();
  grid.innerHTML = `<p class="lane-empty">No repository selected.  Sign in with gh auth login in a terminal, then select Reload repositories.</p>`;
  $("#empty-state").hidden = true;
  $("#filter-summary").textContent = "";
  $("#snapshot-time").textContent = "Never refreshed";
  $("#snapshot-note").textContent = "Canvas opens the first repository available to the GitHub CLI account.";
  ["#refresh-button", "#export-button", "#import-trigger"].forEach((selector) => { $(selector).disabled = true; });
}

function render() {
  if (!repository) {
    renderWithoutRepository();
    return;
  }
  $("#export-button").disabled = false;
  $("#import-trigger").disabled = false;
  renderRepositorySelect();
  fillFilter("#filter-github-status", ["Open", "Draft", "Ready for review", "Merged PR", "Completed issue", "Not planned", "Closed without merge", "Closed (reason unknown)", "Unknown"], "All GitHub statuses");
  fillFilter("#filter-completion-status", ["active", "completed", "not-planned", "closed-unknown", "closed-unmerged", "unknown"], "All completion states");
  fillFilter("#filter-completion-status", ["active", "completed", "not-planned", "closed-unknown", "closed-unmerged", "unknown"], "All completion states");
  fillFilter("#filter-lane", BOARD_STATUSES, "All Kanban lanes");
  fillFilter("#filter-priority", PRIORITIES, "All priorities");
  fillFilter("#filter-type", CARD_TYPES, "All types");
  fillFilter("#filter-workstream", [...new Set(cards.map((card) => card.workstream))].sort(), "All workstreams");
  const now = new Date();
  const doneRecords = getRecentDoneRecords(cards, now);
  const doneKeys = new Set(doneRecords.map((card) => card.key));
  const filters = getFilters();
  const viewRecords = recordsForView(cards, currentView, now);
  const visible = viewRecords.filter((card) => matchesFilters(card, filters, doneKeys));
  const visibleDone = doneRecords.filter((card) => matchesFilters(card, filters, doneKeys));
  const metrics = getBoardMetrics(cards, now);
  const lanes = BOARD_STATUSES.map((status) => {
      const sortedCards = status === "Done"
        ? visibleDone
        : sortLane(visible.filter((card) => !doneKeys.has(card.key) && getDisplayLane(card, doneKeys) === status), status);
    const { cards: laneCards, total } = limitActiveLane(sortedCards, status, currentView, activeLaneLimit);
    const laneId = status.toLowerCase().replaceAll(" ", "-");
    const limitLabel = laneCards.length < total ? `<small class="done-window-label lane-limit-label">Showing ${laneCards.length} of ${total}</small>` : "";
    return `<section class="lane lane-${laneId}" data-lane="${escapeHtml(status)}" aria-label="${escapeHtml(status)} lane">
      <header class="lane-header"><h3>${escapeHtml(status)}</h3><span class="lane-count">${total}</span>${status === "Done" ? `<small class="done-window-label">Recent · rolling 14 days · max 20</small>` : limitLabel}</header>
      <div class="lane-body" data-drop-lane="${escapeHtml(status)}">${laneCards.map((card) => renderCard(card, status)).join("") || `<p class="lane-empty">${status === "Done" ? "No verified recent completions." : `No cards in ${escapeHtml(currentView.toLowerCase())}.`}</p>`}</div>
    </section>`;
  }).join("");
  grid.innerHTML = lanes;
  $("#empty-state").hidden = visible.length > 0;
  $("#view-description").textContent = currentView === "Active work"
    ? "Open GitHub records and historical cards you have retained."
    : currentView === "History" ? "Closed and merged GitHub records, including any also retained in Active work." : "Every tracked GitHub issue and pull request.";
  $("#board-heading").textContent = currentView;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === currentView;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#active-board-count").textContent = String(metrics.activeBoardCards);
  $("#active-github-count").textContent = String(metrics.activeGitHubRecords);
  $("#blocked-count").textContent = String(metrics.blockedActiveWork);
  $("#review-count").textContent = String(metrics.inReview);
  $("#done-count").textContent = String(metrics.doneRecently);
  $("#total-completed-count").textContent = String(metrics.totalCompleted);
  $("#history-count").textContent = String(metrics.historicalRecords);
  $("#total-count").textContent = String(metrics.totalTracked);
  const filtered = Object.values(filters).some(Boolean);
  const filterSuffix = filtered ? ` Filters hide ${viewRecords.length - visible.length} more records in this view.` : "";
  if (currentView === "Active work") {
    const openCount = visible.filter((card) => card.githubState === "open").length;
    const recentDoneCount = visible.filter((card) => doneKeys.has(card.key)).length;
    const retainedCount = visible.filter((card) => card.pinnedActive && isHistoricalRecord(card) && !doneKeys.has(card.key)).length;
    $("#filter-summary").textContent = `Showing ${openCount} open work, ${recentDoneCount} recent completions, and ${retainedCount} retained historical cards.${filterSuffix}`;
  } else {
    const viewNoun = currentView === "History" ? "historical records" : "records";
    $("#filter-summary").textContent = `Showing ${visible.length} of ${viewRecords.length} ${viewNoun}.${filterSuffix}`;
  }
  $("#snapshot-kind").textContent = sourceLabel.toUpperCase();
  $("#snapshot-time").textContent = lastRefreshAt ? localDate(lastRefreshAt) : "Never refreshed";
  const completionRefreshNeeded = needsCompletionRefresh(cards, sourceLabel);
  $("#snapshot-note").textContent = completionRefreshNeeded
    ? "Older snapshot: refresh GitHub to load closure reasons and completion timestamps."
    : !cards.length && !lastRefreshAt ? "No records loaded yet · select Refresh from GitHub"
    : sourceLabel === "GitHub CLI read-only refresh" ? "Read-only refresh · GitHub remains authoritative" : `${sourceLabel} · manual snapshot`;
  $("#snapshot-note").classList.toggle("completion-refresh-needed", completionRefreshNeeded);
  renderLaneLimitControl();
  $("#refresh-button").disabled = isRefreshing;
  $("#refresh-button").setAttribute("aria-busy", String(isRefreshing));
  attachCardEvents();
}

function attachCardEvents() {
  grid.querySelectorAll("[data-priority]").forEach((control) => control.addEventListener("change", () => {
    const card = cards.find((item) => item.key === control.dataset.priority);
    if (!card) return;
    card.priority = control.value;
    persistLocalState();
    render();
    showNotice(`Local priority changed for #${card.number}. GitHub was not changed.`);
  }));
  grid.querySelectorAll("[data-status]").forEach((control) => control.addEventListener("change", () => {
    const card = cards.find((item) => item.key === control.dataset.status);
    if (!card) return;
    card.boardStatus = control.value;
    card.boardStatusExplicit = true;
    $("#sort-order").value = "manual";
    persistLocalState();
    render();
    showNotice(`#${card.number} moved locally to ${card.boardStatus}. GitHub was not changed.`);
  }));
  grid.querySelectorAll("[data-pin]").forEach((control) => control.addEventListener("click", () => {
    const card = cards.find((item) => item.key === control.dataset.pin);
    if (!card) return;
    card.pinnedActive = !card.pinnedActive;
    persistLocalState();
    render();
    showNotice(card.pinnedActive ? `#${card.number} is retained in Active work. GitHub was not changed.` : `#${card.number} is no longer retained in Active work. GitHub was not changed.`);
  }));
  grid.querySelectorAll("[data-notes]").forEach((control) => control.addEventListener("input", () => {
    const card = cards.find((item) => item.key === control.dataset.notes);
    if (!card) return;
    card.notes = sanitizeGitHubText(control.value);
    if (control.value !== card.notes) control.value = card.notes;
    persistLocalState();
  }));

  grid.querySelectorAll("[data-card-key]").forEach((element) => element.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", element.dataset.cardKey);
    event.dataTransfer.effectAllowed = "move";
    element.classList.add("is-dragging");
  }));
  grid.querySelectorAll("[data-card-key]").forEach((element) => element.addEventListener("dragend", () => element.classList.remove("is-dragging")));
  grid.querySelectorAll("[data-drop-lane]").forEach((lane) => {
    lane.addEventListener("dragover", (event) => { event.preventDefault(); lane.closest(".lane").classList.add("is-target"); });
    lane.addEventListener("dragleave", (event) => { if (!lane.contains(event.relatedTarget)) lane.closest(".lane").classList.remove("is-target"); });
    lane.addEventListener("drop", (event) => {
      event.preventDefault();
      const key = event.dataTransfer.getData("text/plain");
      const card = cards.find((item) => item.key === key);
      if (!card) return;
      const previousLane = card.boardStatus;
      const movingElement = grid.querySelector(`[data-card-key="${CSS.escape(key)}"]`);
      const targetElement = event.target.closest(".task-card");
      if (targetElement && targetElement.dataset.cardKey !== key) {
        const rect = targetElement.getBoundingClientRect();
        lane.insertBefore(movingElement, event.clientY < rect.top + rect.height / 2 ? targetElement : targetElement.nextElementSibling);
      } else {
        lane.append(movingElement);
      }
      card.boardStatus = lane.dataset.dropLane;
      card.boardStatusExplicit = true;
      lane.closest(".lane").classList.remove("is-target");
      $("#sort-order").value = "manual";
      if (previousLane !== card.boardStatus) {
        manualOrder[previousLane] = mergeLaneOrder([...grid.querySelector(`[data-drop-lane="${CSS.escape(previousLane)}"]`).querySelectorAll(".task-card")].map((item) => item.dataset.cardKey), manualOrder[previousLane], key);
      }
      manualOrder[card.boardStatus] = mergeLaneOrder([...lane.querySelectorAll(".task-card")].map((item) => item.dataset.cardKey), manualOrder[card.boardStatus]);
      persistLocalState();
      render();
      showNotice(`#${card.number} moved locally to ${card.boardStatus}. GitHub was not changed.`);
    });
  });
}

async function importFile(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const imported = normalizeGitHubImport(payload, repository);
    if (imported.repository !== repository) throw new Error(`Expected ${repository}, received ${imported.repository}.`);
    cards = mergeGitHubRecords(cards, imported.records, imported.localPlanningKeys);
    importedAt = imported.exportedAt || new Date().toISOString();
    sourceLabel = "Imported GitHub JSON";
    manualOrder = normalizeManualOrder(payload?.manualOrder, cards);
    persistLocalState();
    render();
    const planning = imported.localPlanningKeys.size ? ` Local planning applied to ${imported.localPlanningKeys.size} cards.` : "";
    showNotice(`Imported ${cards.length} GitHub records.${planning} No GitHub data was changed.`);
  } catch (error) {
    showNotice(`Import failed: ${error.message}`, "warning");
  }
}

async function refreshFromGitHub() {
  if (isRefreshing) return;
  isRefreshing = true;
  render();
  showNotice("Refreshing issues, pull requests, and available CI checks from GitHub…");
  const requestedRepository = repository;
  try {
    const response = await fetch(`/api/refresh?repository=${encodeURIComponent(requestedRepository)}`, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Refresh failed with HTTP ${response.status}.`);
    if (requestedRepository !== repository) return;
    const refreshed = normalizeGitHubImport(payload, repository);
    const nextCards = mergeGitHubRecords(cards, refreshed.records);
    cards = nextCards;
    importedAt = refreshed.exportedAt || new Date().toISOString();
    lastRefreshAt = importedAt;
    sourceLabel = "GitHub CLI read-only refresh";
    persistLocalState();
    render();
    const ci = payload.ciCoverage?.checkedOpenPullRequests ?? 0;
    const skipped = payload.ciCoverage?.skippedOpenPullRequests ?? 0;
    showNotice(`Refresh complete: ${refreshed.records.length} GitHub records updated. CI checked on ${ci} open pull requests${skipped ? `; ${skipped} more skipped by the local limit` : ""}. Local lanes and notes were preserved.`);
  } catch (error) {
    showNotice(`${error.message} The last valid board snapshot was kept.`, "warning");
  } finally {
    isRefreshing = false;
    render();
  }
}

function exportBoard() {
  const payload = {
    repository,
    exportedAt: new Date().toISOString(),
    source: sourceLabel,
    note: "GitHub record fields are imported read-only. boardStatus and priority are local planning metadata.",
    records: cards.map(({ key, number, type, title, description, url, githubState, stateReason, closedAt, merged, mergedAt, draft, ciStatus, ciChecks, updatedAt, assignees, labels, boardStatus, boardStatusExplicit, pinnedActive, priority, workstream, dependencies, notes, summary, missingFromLatestRefresh }) => ({
      key, number, type, title, description, url, githubState, stateReason, closedAt, merged, mergedAt, draft, ciStatus, ciChecks, updatedAt, assignees, labels, boardStatus, boardStatusExplicit, pinnedActive, priority, workstream, dependencies, notes, summary, missingFromLatestRefresh,
    })),
    manualOrder,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${repository.replace("/", "-").toLowerCase()}-kanban-export.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showNotice("Exported local board data. GitHub was not changed.");
}

function renderLaneLimitControl() {
  const control = $("#lane-limit");
  const custom = $("#lane-limit-custom");
  const isCustom = customLaneLimitPending || (activeLaneLimit !== "all" && !ACTIVE_LANE_LIMITS.includes(activeLaneLimit));
  control.value = isCustom ? "custom" : String(activeLaneLimit);
  custom.hidden = !isCustom;
  if (isCustom && document.activeElement !== custom && activeLaneLimit !== "all") custom.value = String(activeLaneLimit);
}

function setLaneLimit(value) {
  const limit = normalizeLaneLimit(value);
  if (limit === null) {
    showNotice(`Cards per active column must be a whole number from 1 to ${MAX_CUSTOM_LANE_LIMIT.toLocaleString("en")}.`, "warning");
    return;
  }
  activeLaneLimit = limit;
  customLaneLimitPending = false;
  persistLocalState();
  render();
}

function clearFilterControls() {
  $("#search").value = "";
  $("#filter-github-status").value = "";
  $("#filter-completion-status").value = "";
  $("#filter-completed-from").value = "";
  $("#filter-completed-to").value = "";
  $("#filter-lane").value = "";
  $("#filter-priority").value = "";
  $("#filter-type").value = "";
  $("#filter-workstream").value = "";
  $("#sort-order").value = "manual";
}

// Each repository loads only its own saved board; another repository's storage is never written.
function switchRepository(name) {
  if (isRefreshing || name === repository || !isValidRepositoryName(name)) return;
  repository = name;
  try {
    localStorage.setItem(SELECTED_REPOSITORY_KEY, name);
  } catch {}
  resetBoardState();
  clearFilterControls();
  const hasSavedRecords = loadLocalState();
  render();
  if (!hasSavedRecords) void refreshFromGitHub();
  else showNotice(`Showing the saved board for ${repository}. Select Refresh from GitHub for the latest records.`);
}

// Reloads only the repository names; board records are refreshed separately.
async function loadRepositories({ announce = false } = {}) {
  if (isLoadingRepositories) return;
  isLoadingRepositories = true;
  render();
  try {
    const response = await fetch("/api/repositories", { method: "GET", cache: "no-store", headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Repository list failed with HTTP ${response.status}.`);
    availableRepositories = (Array.isArray(payload.repositories) ? payload.repositories : []).filter(isValidRepositoryName);
    repositoryAccount = typeof payload.account === "string" ? payload.account : "";
    repositoryListError = availableRepositories.length ? "" : "No repositories are available to this GitHub CLI account.";
    const account = repositoryAccount || "the GitHub CLI account";
    if (availableRepositories.length && !availableRepositories.includes(repository)) {
      showNotice(`${repository} is not available to ${account}. Its saved board is still shown. Choose another repository, or ask the owner to share it with ${account}.`, "warning");
    } else if (payload.truncated) {
      showNotice(`Showing the first ${availableRepositories.length} repositories available to ${account}; GitHub listed more than Canvas loads.`, "warning");
    } else if (announce) {
      showNotice(`Found ${availableRepositories.length} ${availableRepositories.length === 1 ? "repository" : "repositories"} for ${account}. Missing one? Ask its owner to add ${account} as a collaborator, or run gh auth switch in a terminal and reload.`);
    }
  } catch (error) {
    availableRepositories = [];
    repositoryAccount = "";
    repositoryListError = "Repository list unavailable. Check GitHub CLI sign-in.";
    showNotice(`${error.message} The current repository is still shown.`, "warning");
  } finally {
    isLoadingRepositories = false;
    render();
  }
  if (!repository && availableRepositories.length) switchRepository(availableRepositories[0]);
}

$("#repository-select").addEventListener("change", (event) => switchRepository(event.target.value));
$("#project-logo").addEventListener("error", () => {
  $("#project-logo").dataset.failed = "true";
  renderProjectMark(repositoryIdentity(repository));
});
$("#reload-repositories").addEventListener("click", () => loadRepositories({ announce: true }));
$("#lane-limit").addEventListener("change", (event) => {
  if (event.target.value !== "custom") setLaneLimit(event.target.value === "all" ? "all" : Number(event.target.value));
  else {
    customLaneLimitPending = true;
    renderLaneLimitControl();
    $("#lane-limit-custom").focus();
  }
});
$("#lane-limit-custom").addEventListener("change", (event) => setLaneLimit(event.target.value));
$("#import-trigger").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (event) => importFile(event.target.files?.[0]));
$("#refresh-button").addEventListener("click", refreshFromGitHub);
$("#export-button").addEventListener("click", exportBoard);
$("#clear-filters").addEventListener("click", () => {
  clearFilterControls();
  render();
});
$("#filter-completion-status").addEventListener("input", render);
$("#filter-completed-from").addEventListener("input", render);
$("#filter-completed-to").addEventListener("input", render);
["#search", "#filter-priority", "#filter-type", "#filter-workstream", "#sort-order"].forEach((selector) => $(selector).addEventListener("input", render));
$("#filter-github-status").addEventListener("input", render);
$("#filter-lane").addEventListener("input", render);
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => updateView(button.dataset.view)));
let bootHasSavedRecords = false;
if (repository) {
  resetBoardState();
  bootHasSavedRecords = loadLocalState();
}
render();
const bootRepository = repository;
await loadRepositories();
if (bootRepository && repository === bootRepository) {
  if (availableRepositories.length && !availableRepositories.includes(repository)) switchRepository(availableRepositories[0]);
  else if (!bootHasSavedRecords && repository !== snapshot.repository) void refreshFromGitHub();
}