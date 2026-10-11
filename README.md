<div align="center">

# ThinnSpace

### Your AI coworkers, their documents, and the flows that connect them.

**A self-hosted workspace by [ThinnAIQ](https://github.com/DhanaVazanth). Give each specialist a name, a face, and a job, then wire them together on a canvas.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Status](https://img.shields.io/badge/status-alpha-orange.svg)

</div>

---

## Overview

ThinnSpace runs on your own infrastructure. It has three ideas:

**Dots** are persistent AI coworkers. Each one has a name, role instructions, its own avatar, permissions you control, and optionally its own isolated computer. A researcher investigates, a writer drafts, a reviewer critiques.

**Spaces** hold working documents. Pages have a rich editor with slash commands, autosave, and revision checks. Dots you authorize can read, create, and edit them.

**Flows** chain Dots, pages, and tools into repeatable work on a visual canvas, with a human in the loop wherever you want one.

## Flows

A flow is a team. Nodes are the things your Dots already do, so there is no model, prompt, or parser plumbing on the canvas.

| Category       | Nodes                                                         |
| -------------- | ------------------------------------------------------------- |
| Start & finish | Start (manual, schedule, Slack, webhook, page change), Finish |
| Dots           | Dot task, Dot decides                                         |
| Pages          | Read page, Save page                                          |
| Actions        | Web research, Connected app, Send message                     |
| Logic          | Branch, Combine                                               |
| People         | Human review                                                  |
| Notes          | Note                                                          |

Dot team, For each, Run flow, Computer task, and Wait appear in the palette as coming soon.

**Building.** A single orange button opens a searchable node panel on the right. Ports are typed and colour-coded, so the canvas refuses a connection that could not carry its payload, and refuses cycles. Text fields take `{{chips}}` that reference any upstream output. A linter paints problems on the cards and in a tray, and Preview run order numbers every step and tints the parallel waves before you run anything.

**Running.** The engine executes a snapshot of the graph, so editing mid-run is safe. Steps that do not depend on each other run in parallel. Exclusive branches rejoin without a merge node because a node is ready once every incoming edge has either delivered a value or been skipped. Each Dot step runs in its own inspectable conversation. Human review parks the run, releases its lease, and resumes on your decision. Runs survive a restart as interrupted with their completed outputs intact.

**Publishing.** Autosave keeps the draft. Publish names a version and registers the triggers; the header shows Draft, Published, or unpublished changes. Versions can be restored.

See [docs/FLOWS.md](docs/FLOWS.md) for the full design: node catalog, execution semantics, linter rules, and the data model.

## Get started

Requires **Node.js 24** and npm.

```sh
git clone https://github.com/DhanaVazanth/ThinnSpace.git
cd ThinnSpace
npm ci
cp .env.example .env
npm run dev
```

Open <http://127.0.0.1:5173>. Spaces, pages, Dots, and the Flows canvas all work before you connect anything. Deterministic flow steps (pages, web research, branches, human review) run without a model.

To chat and to run Dot steps, add two things to `.env`:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select   # writes CPK_INTELLIGENCE_API_KEY
```

then set `OPENAI_API_KEY` and `OPENAI_MODEL` and restart. Any OpenAI-compatible endpoint works via `OPENAI_BASE_URL`.

See [docs/SETUP.md](docs/SETUP.md) for Slack, calls, the browser service, Docker, and the per-Dot computers in [docs/COMPUTERS.md](docs/COMPUTERS.md).

## Avatars

Every Dot has a character. Five are bundled, and anyone can upload their own: the browser fits the image into a 512px transparent square and the server stores it, so it becomes a permanent option for any Dot. Avatars are served from the app, never from a third party.

## Development

```sh
npm run dev          # client + server with reload
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run build        # production bundle
npm run format       # prettier
```

Pages, Spaces, Dots, flows, runs, and avatars live in SQLite at `DATABASE_PATH`. Conversation history lives in your configured CopilotKit Intelligence deployment. Neither the database nor `.env` is committed.

## Credits

ThinnSpace is built on [OpenDots](https://github.com/CopilotKit/OpenDots) by CopilotKit, which is MIT licensed and remains the upstream for the Dots, Spaces, and conversation layers. The Flows canvas and execution engine, the avatar system, and the ThinnSpace brand are additions in this repository.

Also uses [AG-UI](https://docs.ag-ui.com/introduction), [React Flow](https://reactflow.dev), [TanStack AI](https://tanstack.com), and [Hono](https://hono.dev).

## License

[MIT](LICENSE).
