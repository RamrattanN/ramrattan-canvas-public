# Demo Board

Orbitron Sprocket Works is a fictional retro-futuristic manufacturer used to demonstrate Canvas.  The repository bundles a synthetic snapshot of 30 invented `[DEMO]` records: 24 open issues, two open pull requests, and four merged pull requests.  It contains no real client, operational, or credential data, and it needs no GitHub access.

| Column | Cards |
|---|---:|
| Backlog | 8 |
| Ready | 5 |
| In Progress | 6 |
| Review | 4 |
| Blocked | 3 |
| Done | 4 |

The layout comes from a committed plan of local planning metadata.  The bundled snapshot supplies every title, state, and merge date, with dates moved to the present each time it is used.

```powershell
npm run demo:fixture   # synthetic snapshot + plan -> demo/out/canvas-demo-board.json
npm run demo:capture   # verify in a disposable Chrome profile and regenerate the screenshots
```

The full procedure, verification steps, and limitations are in [`docs/demo/orbitron-sprocket-works.md`](https://github.com/RamrattanN/ramrattan-canvas-public/blob/main/docs/demo/orbitron-sprocket-works.md).
