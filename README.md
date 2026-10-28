# Context Visualizer

A small local web app that shows **what's filling the context window** of a Claude Code or
OpenCode session — system prompt vs. messages vs. tool calls vs. tool results vs. attachments —
so you can see what to trim.

It reads the session transcripts Claude Code already writes to
`~/.claude/projects/**/*.jsonl` (read-only), or accesses OpenCode V2 through its local
`opencode api` CLI (read-only), and renders a per-session breakdown as a
treemap, sunburst, or stacked bar, with a drill-down into the individual heaviest items.

## Requirements

- [Bun](https://bun.sh) — used for both the API server and the web build.
- [OpenCode V2](https://opencode.ai/v2/docs/cli) CLI installed to view OpenCode sessions (optional).

## Setup

```sh
bun install
cd web && bun install && cd ..
```

## Run

```sh
bun run dev
```

Starts the API (port 5174) and the Vite dev server (port 5173) — open
<http://localhost:5173>. The dev server proxies `/api` to the backend.

To build the frontend for production: `bun run build:web` (outputs `web/dist`); run the
API with `bun run start`.

## How it works

- The **headline total** comes straight from the `usage` field of the latest assistant
  turn — ground truth from the API.
- Visible messages, tool calls, and tool results are tokenized locally with
  `js-tiktoken` (`cl100k_base`); Claude snapshots are calibrated toward Claude's
  BPE. Counts and proportions are estimates, especially for OpenCode and media.
- The **system prompt + tool schemas** can't be read from the transcript, so they're
  shown as the residual: `realTotal − Σ(identified buckets)`.
- If a session has been compacted, only content after the latest `compact_boundary` is
  counted.
- Snapshots are cached under `.cache/<sessionId>.json`, keyed by the source file's mtime;
  each session has a Refresh button to recompute.
- OpenCode session snapshots use the last assistant call's input usage and are recalculated
  on each view; its session-level token totals are cumulative and are not shown as context
  totals in the project list. OpenCode category counts use `cl100k_base` estimates (no
  Claude-specific calibration); model context limits vary, so no capacity percentage is shown.

## Project layout

- `server/` — Bun HTTP API: reads/parses Claude JSONL or queries OpenCode's local API,
  tokenizes visible content, computes the snapshot.
- `web/` — React + Vite frontend (ECharts for the visualizations).

## License

[GPL-3.0-or-later](./LICENSE)
