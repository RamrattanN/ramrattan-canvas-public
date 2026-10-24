# Troubleshooting and Security

## Troubleshooting

| Symptom | What to do |
|---|---|
| "GitHub CLI (gh) was not found" | Install the GitHub CLI, run `gh auth login`, then select **Reload repositories**. |
| "GitHub CLI is not signed in" | Run `gh auth login` (check with `gh auth status`), then select **Reload repositories**. |
| A repository is missing | Check the account shown in the toolbar.  Ask the owner to share the repository with it, or run `gh auth switch`, then reload. |
| "That repository is not available" | The active account can no longer read it.  Its saved board stays visible. |
| Page does not load or port 4173 is busy | Another Canvas server may already be running.  Use it, or stop it first. |
| Saved board is missing | Use exactly `http://127.0.0.1:4173/canvas/` in the same browser profile. |
| Done looks empty | Done shows only the last 14 days of completions.  See **History**. |
| CI shows "Unavailable" | CI is checked only for the 20 most recently updated open pull requests and is informational. |
| Refresh fails on a very large repository | Canvas reads up to 1,000 issues and 1,000 pull requests per repository. |

## Security model

- **Local and single-user.**  The server listens only on `127.0.0.1:4173`, accepts only loopback `Host` headers and same-origin browser requests, and serves a fixed list of files with a strict Content Security Policy.
- **Read-only GitHub access.**  All reads go through the `gh` CLI with GET requests.  Canvas never writes to GitHub.
- **No stored credentials.**  Tokens stay in the GitHub CLI's credential store.  The server removes token environment variables before starting `gh` and never returns tokens or raw CLI output.
- **Strict repository names.**  Only valid `owner/name` values that appear in the account's repository list are refreshed, and they are passed as process arguments, never through a shell.
- **Safe display.**  GitHub text is rendered as escaped text, and token-like strings are redacted before display and export.  Repository icons come only from trusted local files.

## Limitations

- Canvas does not authenticate local processes.  Software already running on your computer could request repository data through the server while it runs.
- It is not designed to be exposed on a network, hosted, or shared between users.
- Boards live in one browser profile.  There is no sync, backup, conflict resolution, or GitHub write-back.
- Exported files contain repository content and your notes.  Treat them as private.
