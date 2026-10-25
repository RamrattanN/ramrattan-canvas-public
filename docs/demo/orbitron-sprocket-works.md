# Orbitron Sprocket Works demonstration board

Orbitron Sprocket Works is a fictional, retro-futuristic manufacturing company.  Its board shows Canvas with realistic but entirely invented work: GitHub status, local lanes, priorities, workstreams, notes, dependencies, and GitHub-verified completions.  Use it for documentation screenshots, demonstrations, and regression checks.  It contains no real client, operational, or credential data, and it needs no GitHub access.

## The synthetic records

`demo/orbitron-snapshot.json` is a bundled synthetic snapshot of 30 records, all titled with a `[DEMO]` prefix.  It uses the same format as a Canvas GitHub refresh.  Its repository identifier, `RamrattanN/canvas-demo`, is only a label for the fictional data.  You never need to open or access it.

| Records | Status in the snapshot |
|---|---|
| Issues #1-#24 | Open |
| Pull requests #25 and #28 | Open |
| Pull requests #26, #27, #29 and #30 | Merged |

Whenever the scripts use the snapshot, they move every timestamp by the same amount so the newest one is an hour old.  The four merged pull requests therefore always fall inside Done's rolling 14-day window.

## GitHub status versus Canvas lanes

- **GitHub status** (Open, Ready for review, Merged PR) comes from the records.  A card reaches **Done** only when it is merged or completed within the rolling 14-day window, latest 20 cards.
- **Kanban lane, priority, workstream, dependencies, notes, and card order** are local Canvas planning metadata, saved per repository in your browser.  They never change GitHub.

The demo plan therefore never assigns a card to Done.  The merged pull requests keep **Review** as their previous local lane, and Canvas places them in Done because they merged.

## Target layout

| Column | Cards | Records |
|---|---:|---|
| Backlog | 8 | Issues #1-#8 |
| Ready | 5 | Issues #9-#13 |
| In Progress | 6 | Issues #14-#18 and PR #28 |
| Review | 4 | Issues #22-#24 and PR #25 |
| Blocked | 3 | Issues #19-#21 |
| Done | 4 | Merged PRs #26, #27, #29 and #30 |

Priorities use the values Canvas supports: P1 (most urgent), P2, P3, and Untriaged (shown as **No priority**).  Workstreams are Propulsion, Robotics, Manufacturing, Supply Chain, Operations, and Quality Assurance.

## Files

| File | Purpose |
|---|---|
| `demo/orbitron-snapshot.json` | The synthetic records. |
| `demo/orbitron-plan.json` | The local planning plan: lane, priority, workstream, notes, dependencies, and card order for each record. |
| `demo/generate-fixture.mjs` | Combines the snapshot and the plan into a standard Canvas board export. |
| `demo/capture.mjs` | Loads the board in a disposable Chrome profile, verifies it, and captures the screenshots. |
| `demo/out/canvas-demo-board.json` | Generated board export.  Not committed; regenerate it when needed. |
| `docs/demo/images/` | Screenshot source images. |

## Generate and verify the board

From the repository root, with Chrome or Edge installed:

```powershell
npm run demo:fixture
npm run demo:capture
```

`demo:fixture` writes the board export and stops with an error if the records and the plan differ or the column counts do not match the target layout.

`demo:capture` starts its own Canvas server on a random local port, with a synthetic account label (`orbitron-demo`) and only the demo board.  It opens a temporary Chrome profile, which it deletes afterwards.  It checks:

- 30 records, each appearing once;
- the six column counts;
- open records outside Done, and merged pull requests in Done;
- the plan's card order;
- lanes kept after a Refresh from GitHub, served from the synthetic snapshot;
- an Export board and Import JSON round trip;
- the cards-per-column limit;
- storage isolation;
- before each screenshot, that the image starts at the top-left corner of the page and spans its full width, with the application header, Ramrattan shield, Orbitron logo, and project title inside it;
- the controls each screenshot is meant to show;
- that only the synthetic account, the demo repository, and its records appear, with no email addresses;
- that each image's dimensions match its capture boundary.

Your normal Canvas server on port 4173 and your browser's saved boards are never touched.  Set `CHROME_PATH` if Chrome or Edge is not installed in the default location.

## Screenshots

Every image shows the full application header and the Orbitron project title above its subject.  The browser is 2034 CSS pixels wide at 1.875 device pixels per CSS pixel, which matches the approved overview image and keeps card controls inside each lane.

| Image | Shows |
|---|---|
| `01-board-overview.png` | The whole page, header to footer, with the complete six-column board and **All** cards. |
| `02-repository-and-account.png` | Repository selector, synthetic account, and the Orbitron project heading. |
| `03-planning-cards.png` | The Blocked lane, selected with the **Kanban lane** filter, with priorities, workstreams, and local notes. |
| `04-done-merged-prs.png` | The Done lane, selected with the **Kanban lane** filter, with merged pull requests. |
| `05-search-filters-card-limit.png` | **Cards per active column** set to Custom (5), **Done column display** at 20 (recent 14 days), search, and filters. |

`npm run demo:capture` writes images 02 to 05 to `docs/demo/images/`.  The published overview is a reviewed image, so the capture writes its overview to `demo/out/01-board-overview.png` instead.  Copy it over `docs/demo/images/01-board-overview.png` only after it has been reviewed and approved.

The Orbitron and Ramrattan artwork in these images is reserved; see `NOTICE`.

## Limitations

- **No live demo board.**  The demonstration board runs inside the capture script's disposable browser.  It is not added to your own Canvas, because Canvas only opens repositories your GitHub CLI account can read.
- **No GitHub labels.**  The demo records have none.
- **The overview image is tall,** because every card is shown in full with **All**.
