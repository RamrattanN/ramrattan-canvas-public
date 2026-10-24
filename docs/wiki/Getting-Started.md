# Getting Started

## Requirements

- Node.js 20 or later.  There are no packages to install.
- The [GitHub CLI](https://cli.github.com/) (`gh`).
- A current desktop browser.

## Install and start

```powershell
gh repo clone RamrattanN/ramrattan-canvas-public
cd ramrattan-canvas-public
npm start
```

Open <http://127.0.0.1:4173/canvas/>.  Stop the server with Ctrl+C.

On Windows you can use a desktop shortcut instead:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-desktop-shortcut.ps1
```

The **Ramrattan Canvas** shortcut runs `launch-canvas.cmd`, which starts the server in a minimized window when needed and opens the board.

Always use the same address.  Saved boards belong to the browser origin, so `127.0.0.1:4173` and `localhost:4173` keep separate data.

## Sign in to GitHub

Canvas has no sign-in of its own.  It reads GitHub through the `gh` CLI on your computer:

```powershell
gh auth login
gh auth status
```

Canvas uses whichever account `gh` has active and never switches accounts or stores tokens.  To use another signed-in account, run `gh auth switch` in a terminal and then select **Reload repositories**.

## Choose a repository

![Repository selector and account](https://github.com/RamrattanN/ramrattan-canvas-public/raw/main/docs/demo/images/02-repository-and-account.png)

The toolbar shows the signed-in account, the number of repositories it can read, and the **Repository** dropdown.  The list includes repositories the account owns, collaborates on, or reaches through an organization.  Another person's private repository appears only after it is shared with that account.

- **Reload repositories** re-reads the list without touching any board.
- On first use, Canvas opens the first repository in the list and then remembers your choice.
- Selecting a repository shows its saved board, or refreshes it once from GitHub if this browser has none.
- **Refresh from GitHub** reads the selected repository's issues, pull requests, and recent CI status.
