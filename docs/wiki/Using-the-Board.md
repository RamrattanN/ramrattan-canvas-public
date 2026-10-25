# Using the Board

## Views

- **Active work** (default): open issues and pull requests, recent completions in **Done**, and closed records you have chosen to **Retain in Active work**.
- **History**: every closed issue and pull request, with its actual outcome.
- **All records**: everything Canvas has read for the repository.

## Lanes and local planning

The lanes are Backlog, Ready, In Progress, Review, Blocked, and Done.  Drag a card, or use its **Local lane** selector.  Each card also has a local priority (P1, P2, P3, or Untriaged), workstream, dependencies, and notes.

![Cards with local priorities, workstreams, and notes](https://github.com/RamrattanN/ramrattan-canvas-public/raw/main/docs/demo/images/03-planning-cards.png)

**GitHub status and Canvas lanes are different things.**  The **GitHub:** tag on each card (Open, Ready for review, Merged PR, Completed issue, Not planned, and so on) comes from GitHub.  The lane, priority, and notes are your own planning, stored only in this browser.  Moving a card never changes GitHub, and a refresh never resets your lanes.

## Done

![Done column with merged pull requests](https://github.com/RamrattanN/ramrattan-canvas-public/raw/main/docs/demo/images/04-done-merged-prs.png)

GitHub alone decides what is done:

- A pull request is completed when GitHub reports it merged.  An issue is completed when GitHub closed it as completed.
- Not-planned issues, issues closed without a reason, and closed, unmerged pull requests are never counted as completed.
- **Done column display** defaults to 20 completions from the last 14 days.  Select 50, 100 or All to view older verified completions, newest first.  Older completions always remain searchable in **History**.
- A reopened record returns to active work.

## Card limits, search, and filters

![Card limit, search, and filters](https://github.com/RamrattanN/ramrattan-canvas-public/raw/main/docs/demo/images/05-search-filters-card-limit.png)

- **Cards per active column**, in the summary panel, limits the cards shown in each working lane: 25, 50, 75, 100, 200, All, or Custom (1 to 10,000).  Lane counts stay complete, and capped lanes show **Showing N of M**.  Done has a separate 20 / 50 / 100 / All display setting.  Both settings are saved per repository.
- Search covers titles, numbers, and notes.  Filters cover GitHub status, completion, completion dates (UTC), lane, priority, type, and workstream.  **Clear filters** resets them.
- **Board order** keeps your manual card order.  Other sorts are by priority, recent update, or number.

## Local data, export, and import

Each repository's board is saved in the browser's `localStorage` under its own key, so repositories never share lanes, notes, or settings.

- **Export board** downloads the board as JSON, including card order.  Keep exports private, because they contain repository content and your notes.
- **Import JSON** accepts a Canvas export, which restores its local planning, or GitHub issue and pull request JSON, which keeps your existing lanes.  A file is accepted only for the selected repository.
- Clearing the browser's site data deletes saved boards.  Export first to keep a backup.
