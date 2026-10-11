# ThinnSpace Flows — Final design spec (release 1 editor, release 2 engine)

## 0. Summary

Flows is a Dot-centric canvas for repeatable multi-Dot processes. The base is Proposal 1 (the design two of three judges preferred and the one already scaffolded in `src/shared/flows.ts`, `src/server/flow-store.ts`, `src/server/flow-routes.ts`, `src/shared/flow-templates.ts`, `src/client/flows/*`), with every "must graft" idea from the three verdicts folded in. Where grafts conflicted, the rule was: keep SaaS polish (one edge type, zero-config nodes, one docked panel, no plumbing vocabulary) and keep multi-agent correctness (typed ports stored on edges, universal edge-settlement readiness, bounded loops, persisted human gates, per-step tool allowlists, honest Slack and approval limits).

**Release 1 ships:** canvas, palette, properties panel with Issues tab, chips, linter, Preview run order, autosave + versions, publish lifecycle (Draft / Published / Published with unpublished changes / Paused, Lock, Unpublish), templates gallery, import/export, Reviews inbox shell, Flows in the sidebar and inside Spaces, and the complete graph + run schema below.
**Release 2 ships:** the FlowRunner (scheduler, triggers, approvals bridge, SSE run events), plus Beta-flagged nodes (Dot team, For each, Computer task, Run flow, Wait).

**v1 node count: 13** (12 executable + Note). Full catalog: 18.

## 1. Principles

1. **Dots are the unit of work; the Flow is the audit layer.** The canvas never shows model / prompt / parser / memory plumbing. A Dot task re-exposes none of the Dot's configuration: only a task brief, a tool subset, a thread policy and an output shape. Editing a Dot updates every flow ("Used in N flows" makes that visible).
2. **One vocabulary, ThinnSpace words only.** Start, Finish, Dot task, Dot decides, Read page, Save page, Web research, Connected app, Send message, Branch, Combine, Human review, Note. No Join, Transform, Router, Prompt, Parser, Model, Memory.
3. **One edge type.** An edge carries exactly one typed payload and also sequences execution. There are no separate control ports. Fan-in is "wait for every live incoming edge" (visible as a `waits for N` chip), "first of N" is a per-node setting, loops are a per-item toggle or the bounded For each container, and exactly one back-edge shape is legal in v1: the revise edge from Human review → an upstream Dot task, bounded by Max revisions.
4. **Zero-config happy path.** Every node is valid the moment its one identifying field is set (pick a Dot, pick a Space). Required selects have defaults. Advanced options never block Save. Save is always allowed; Publish and Preview are blocked only by errors.
5. **Typed ports that teach.** Four kinds (text, json, trigger, any), fixed colours, compatibility enforced while dragging. json → text is accepted and rendered readably (never `JSON.stringify` dumps); text → json is refused with a one-click fix toast. Every edge stores its port kind at creation so later config changes surface as issues, never as silent coercion.
6. **Design-time validation, one source of truth.** `lintFlow(graph, workspace)` in `src/shared` runs in the client (badges, pill, Issues tab, Problems tray) and in the server (`/validate`, Publish). Permission and setup checks read the real Dot, Space, connection and SetupStatus records.
7. **Human review is first-class and persisted server-side.** `flow_approvals` (kind review | page | connection) is the single source of truth for every gate; the in-app card reuses the Approve & save / Decline visual language; a Reviews inbox lists pending decisions across flows; runs park as `waiting` with the lease released. Because `review_space_page` and `request_connection_action` are _client_ tools in `dot-agent.ts`, nothing in a headless run depends on them: the engine owns the checkpoint.
8. **Honest execution.** Branches drawn in parallel run in parallel. Same-Dot steps serialise only when they share a thread. Slack delivery that the channels SDK cannot do yet (proactive channel posts, DMs) is declared in the schema, shown as "Coming soon" and linted, not pretended.
9. **One configuration surface.** A docked, resizable right panel with Setup | Advanced | Issues tabs (Last run in release 2). No modals; long briefs get an expanded in-panel editor.
10. **Reuse before build.** Steps run through `runThreadTurn` with `{opendotsSource:'flow', runId, nodeId, tools}` metadata; pages through `page-service.ts`; research through `research.ts`/`parallel.ts`; connections through `connection-tools.ts`; Slack through `slack-channel.ts`; results in the existing `Result {text, sources}` shape rendered by ResultPane. New code: the shared registry additions, `FlowStore` tables, `FlowRunner`, the approvals bridge, the run-events SSE route.
11. **SaaS table stakes on day one.** Autosave with "Saved 2m ago", named versions with restore, undo/redo, copy/paste across flows, minimap, tidy up, keyboard sheet, templates, secrets-free export, typeVersion migrations.

## 2. Layout

**Sidebar.** A "Flows" section sits directly under "Spaces" in the existing left sidebar (same nav-item styling as Dots and Spaces): a "Flows" heading with "+" (opens the templates gallery), then one row per flow (Workflow icon, name, trigger glyph(s), status dot: grey draft / green published / amber paused or problems). A "Reviews" row with a count badge appears under Flows whenever any `flow_approvals` row is pending; it opens the Reviews inbox (list of pending decisions across flows, each opening the same review card). Inside each Space's sidebar section (`SpaceNav.tsx`) a "Flows" row lists flows whose `settings.spaceId` points at that Space, so flows live beside the pages they read and write. The icon rail gets a Workflow icon that collapses to the same section. Dot settings get a "Used in N flows" line linking to the flows.

**Flows list (`#/flows`).** Template cards on top (strip of node chips, read-only preview, "Use template"), then your flows: name, node-chip strip, trigger badges, status chip, last saved, last published, owner avatar; search; "..." with Duplicate / Export / Delete.

**Editor (`#/flows/:id`).** Replaces the workspace area with a three-column layout.

- Header (48 px): back chevron, editable name, Space folder chip, "Dots in this flow" avatar strip, save chip ("Saved just now" / "Unsaved changes" / "Saving…"), status chip (Draft / Published / Published with unpublished changes / Paused / Locked), "N problems" pill, Undo/Redo, Tidy up, **Preview run order**, **Publish** (primary; requires a version name, optional notes), "..." menu: Pause/Resume triggers, Unpublish, Lock/Unlock, Duplicate, Export JSON, Import JSON, Versions, Delete.
- Left: palette, 280 px, collapsible to an icon strip (Cmd+B). Search on top (focused by `/`). Accordions: Start & finish · Dots (your real Dots with avatars; drag creates a pre-bound Dot task) · Pages · Actions (plus a "Tools" group listing each Dot's MCP tools with favicon, read-only and approval hints; drag creates a pre-bound Connected app) · Logic · People. Note is a single button at the bottom. A "Beta" toggle in the palette footer reveals non-v1 nodes (Dot team, For each, Computer task, Run flow, Wait) for early adopters; they are drawable and saveable, and the linter marks them "Runs in a future release".
- Centre: React Flow canvas (dot grid, minimap bottom-right, controls bottom-left). Empty state: an auto-created Start card with a "What starts this flow?" chooser and a floating "Add a Dot" button.
- Right: properties panel, default 360 px, resizable 320–480, persisted; visible only while a node or edge is selected; header (icon/avatar, editable name and description, "..." menu: duplicate, delete, change Dot, open Dot); tabs **Setup | Advanced | Issues** (Last run reserved); footer "Next step" list with "+". Esc closes.
- Bottom: a Problems tray slides up when the pill is clicked (release 2 adds Runs / Logs tabs in the same slot). Trays and panels never cover the canvas: the canvas shrinks.
- Below 900 px: read-only canvas, list view of nodes, properties as a bottom sheet.

## 3. Canvas features (release 1)

See the `canvasFeaturesV1` list for the implementable checklist. Highlights that resolve judge conflicts:

- **Preview run order** replaces the disabled Test button: runs the linter, then numbers every executable node by topological rank, tints parallel groups, draws the chosen Branch / Dot decides / Human review arm solid and the others dimmed (pick the sample route in a small popover), and shows `waits for N` / `first of N` chips. It uses the same readiness predicate the engine will use (`src/shared/flow-schedule.ts`), so the overlay _is_ the engine's dry run.
- **Fan-in is visible.** Any node with more than one live incoming edge shows `waits for N` (or `first of N` when Start when = first).
- **Per-item is a suggestion, never magic.** When a json list is connected to a Dot task or Save page, a toast says "A list arrived. Run Writer once per item? Its Result becomes a list." with one-click accept; nothing toggles silently.
- **Connection refusal teaches.** Dropping text on a json port toasts "Switch Writer to Structured JSON" (adds the Data port and rewires) or "Connect to Context instead". Dropping on a Note, a self-edge or a cycle (other than the revise edge) toasts why.
- **Issues tab** in the panel lists the selected node's problems with fix hints (each a button where a fix is mechanical), alongside the header pill and card badge.
- **"How does it work?"** explainers (popover, 3–4 sentences, one diagram) sit beside Conversation (thread mode), Run once per item, Start when, Human review timeout and Max revisions.
- **Expanded brief editor:** a full-height in-panel textarea with the chip picker, toggled by an expand icon; no modal.

## 4. Port kinds, coercion and chips

| kind    | colour         | carries                                                                  |
| ------- | -------------- | ------------------------------------------------------------------------ |
| text    | indigo #6366f1 | Markdown / plain text                                                    |
| json    | rose #e11d48   | object or array                                                          |
| trigger | sky #0ea5e9    | the run's trigger payload `{source, text, fields, slack?, page?, body?}` |
| any     | slate #94a3b8  | accepts anything; passes through unchanged                               |

`kindsCompatible(source, target)`:

- any ↔ anything.
- trigger → trigger, any, **text** (coerces to `payload.text`), **json** (coerces to the payload object).
- json → json, **text** (rendered readably: arrays as Markdown list/sections, objects as `key: value` lines, pages as `title (url)`), never the reverse.
- text → text only. Refused into json with the fix toast.

Every edge stores `kind` (the source port kind at creation). `ports(config)` can change a port's kind later (Structured JSON on, per-item on, Dot decides branches renamed); the linter then raises `edge-kind-changed` with a fix hint instead of coercing.

**Chips.** Tokens bind to stable ids: `{{n_ab12.result}}`, `{{start.text}}`, `{{start.fields.topic}}`, `{{start.slack.channel}}`, `{{flow.audience}}`. The UI renders labels and re-resolves on rename, so renaming never breaks a brief. The picker (typed `{{` or the chip button) lists only outputs upstream on the same path, grouped node › port with the kind icon; hovering shows the sample value derived from Start's sample input. Unknown or non-upstream references are lint errors; connected-but-unreferenced context is an info-level note (context is always appended as labelled sections, so wiring alone passes data).

## 5. Common settings (Advanced tab of every executable node)

Appended by the registry (`COMMON_SETTINGS`), not repeated per node in the catalog:

| key              | control | values / default                                                                                                                                                                                                                           |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| startWhen        | select  | `all` (All connected inputs have arrived, default) · `first` (The first input arrives; later arrivals are ignored)                                                                                                                         |
| onError          | select  | `stop` (Stop the run, default) · `retry` (Retry, then stop) · `skip` (Skip this step; downstream prunes) · `error-port` (Send to an Error port: an orange `error` output appears carrying `{message, nodeId}`; the main ports are skipped) |
| retries          | number  | 1–3, default 1, shown for retry; backoff 2 s · 8 s · 30 s                                                                                                                                                                                  |
| timeLimitMinutes | number  | per-node; default 2 for Dot steps (a Dot turn is capped at 90 s), 10 for Web research, none for Human review (it uses its own timeout)                                                                                                     |
| noteOnCard       | text    | short text rendered under the summary on the card                                                                                                                                                                                          |

Start and Note have no common settings. Finish has only `startWhen`.

## 6. Node catalog (v1 = default palette and first engine cut)

| type          | label         | category       | v1   | in                                      | out                                                                                  | maps to                                                          |
| ------------- | ------------- | -------------- | ---- | --------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| start         | Start         | Start & finish | yes  | —                                       | started: trigger                                                                     | runs API, FlowRunner trigger loop, slack-channel mention handler |
| finish        | Finish        | Start & finish | yes  | value: any*, sources: json              | —                                                                                    | flow_runs.result (Result {text, sources})                        |
| dot-task      | Dot task      | Dots           | yes  | context: any*                           | result: text (list when per-item), data: json (Structured), pages: json, error (opt) | runThreadTurn + per-step tool allowlist                          |
| dot-decide    | Dot decides   | Dots           | yes  | input: any                              | branch:<label>: any …, otherwise: any                                                | runThreadTurn with constrained choice                            |
| read-page     | Read page     | Pages          | yes  | ref: json                               | text: text, page: json                                                               | page-service read/list                                           |
| save-page     | Save page     | Pages          | yes  | content: text*, title: text, page: json | saved: json, declined: any (review on)                                               | page-service create/update + flow_approvals(page)                |
| web-research  | Web research  | Actions        | yes  | context: any                            | findings: text, sources: json                                                        | research.ts / parallel.ts / read_public_page                     |
| mcp-tool      | Connected app | Actions        | yes  | input: json                             | result: json, text: text                                                             | connection-tools.ts                                              |
| send-message  | Send message  | Actions        | yes  | content: any*                           | sent: json                                                                           | slack-channel.ts thread reply; in-app inbox events               |
| branch        | Branch        | Logic          | yes  | input: any                              | yes: any, no: any                                                                    | shared evaluator, no model                                       |
| combine       | Combine       | Logic          | yes  | values: any*                            | text: text                                                                           | shared template renderer, no model                               |
| human-review  | Human review  | People         | yes  | draft: text                             | approved: text, changes: text (3-button), declined: text, decision: json             | flow_approvals(review) + review card + Reviews inbox             |
| note          | Note          | Notes          | yes  | —                                       | —                                                                                    | graph JSON only                                                  |
| dot-team      | Dot team      | Dots           | Beta | context: any*                           | result: text, log: json                                                              | release 2: delegate_<worker> server tools                        |
| for-each      | For each      | Logic          | Beta | list: json, next: any                   | item: json, results: json                                                            | release 2: sub-scope execution                                   |
| computer-task | Computer task | Dots           | Beta | context: any*                           | result: text, screenshot: json                                                       | computer-tools.ts in a Dot turn                                  |
| run-flow      | Run flow      | Logic          | Beta | input: any                              | result: any                                                                          | child flow_run                                                   |
| wait          | Wait          | Logic          | Beta | input: any                              | output: any                                                                          | FlowRunner timers                                                |

(`*` = accepts several incoming edges.) Full ports, config controls, card contents and mappings are in the machine-readable catalog.

### Node notes that resolve judge findings

- **Start** is addable: several per flow, each an independent entry point; the linter requires at least one. The Slack option is modelled on the single workspace bot (channel filter, keyword, "Reply On it immediately"), not "Dot to listen for". Manual runs support a simple input label _and_ typed form fields (`inputFields` rows → `{{start.fields.<name>}}`); a sample input drives chip previews and Preview run order. Webhook and Page-saved are in the v1 schema and editor and lint as "Runs in a future release".
- **Dot task** defaults: task text "Do your job with the context provided" (so a node is valid once a Dot is picked); tools = everything the Dot is permitted _minus_ create/edit page, which are off by default (side effects live in Save page or behind "Review before any page save"); thread = fresh. Thread modes: `fresh` · `run` (one thread per Dot per run) · `keyed` (persistent thread per key such as `{{start.slack.threadTs}}`) · `trigger` (continue the Slack conversation that started the flow; valid only behind a Slack Start and only for the workspace's Slack-bound Dot, which `requireThread` enforces). The chip row on the card is generated live from the Dot record (Web, Memory, Computer, N tools, N Spaces) and dims the ones the step disallows.
- **Dot decides** keeps Otherwise on by default so no case silently stops the flow; the edge inherits the branch label as a pill; the untaken arms are pruned by inactive propagation.
- **Save page** "Ask me before saving" is sugar for the same `flow_approvals(kind='page')` checkpoint Human review uses (never the client-side `review_space_page` tool); the saved page records `sourceThreadId` = the run's thread. "On revision conflict": re-read and retry (default) / stop the run.
- **Connected app** validates arguments against the tool's `inputSchema` at design time. An approval-gated tool (per-tool `requiresApproval`, or "Always ask") is a lint **error** in release 1 ("Approval-gated tools pause only in chat today"); release 2 ships the approvals bridge and downgrades it to an info note.
- **Send message / Finish**: "Reply in the Slack thread that started this flow" is the default destination when a Slack Start exists and is fully supported (`thread.post`). "Slack channel" and Human review "Slack DM" are declared, render a "Coming soon" chip and lint as `slack-proactive-unavailable` (warning) until `@copilotkit/channels` wires proactive delivery. "My inbox" posts a flow event that the Scheduled & activity view and the Reviews/Activity list render.
- **Human review**: Approve / Request changes / Decline, reviewer can edit the draft (edited text leaves on Approved), require feedback on Request changes / Decline, optional "Save approved draft as a page in <Space>" (one node for review + publish), notify In app (always) + Slack reply-in-thread (supported) + Slack DM (coming soon), timeout hours with Keep waiting / Decline / Approve, and **Max revisions** (default 2) which bounds the revise edge.
- **Combine** is the only zero-token fan-in helper: template + separator, waits for all or first; it exists so sections can be assembled into one page without a Dot turn. It is not required for fan-in (Dot task context already waits).
- **Note** sits behind nodes, never connects, is excluded from validation and from the executable count.

## 7. Graph JSON (schema 2) and the shared registry

```
{
  "schema": 2,
  "nodes": [
    { "id": "n_ab12", "type": "dot-task", "typeVersion": 1, "label": "Writer",
      "position": { "x": 420, "y": 160 }, "collapsed": false,
      "config": { "dot": "dot_123", "task": "Draft a post about {{n_res1.findings}}", "outputFormat": "text", "tools": ["web", "pages:read"], "thread": "fresh" },
      "settings": { "startWhen": "all", "onError": "stop", "retries": 1, "timeLimitMinutes": 2, "noteOnCard": "" } }
  ],
  "edges": [
    { "id": "e_1", "source": "n_start", "sourceHandle": "started", "target": "n_ab12", "targetHandle": "context", "kind": "trigger", "label": null },
    { "id": "e_9", "source": "n_rev", "sourceHandle": "changes", "target": "n_ab12", "targetHandle": "context", "kind": "text", "revise": true }
  ],
  "notes": [ { "id": "note_1", "text": "Runs every weekday", "color": "amber", "position": { "x": 40, "y": 40 }, "size": { "w": 240, "h": 120 } } ],
  "variables": { "audience": "SMB founders" },
  "settings": { "spaceId": "space_1", "timeoutMinutes": 60, "maxConcurrency": 5, "maxDotTurns": 30, "tokenBudget": null, "onError": "stop" }
}
```

Schema 1 graphs (the current scaffold) migrate in `migrateGraph()`: edge kinds are computed from the catalog, `start.singleton` is dropped, `notes` are split out of nodes, `settings` get defaults.

**Registry** (`src/shared/flows.ts`, extended): each `NodeSpec` gains `ports(config) → {inputs, outputs}` for dynamic handles (Dot decides branches, Human review actions, Structured JSON Data port, per-item list kinds, Error port), `configSchema` (zod), `summary(config, workspace) → string` for the card line, `validate(node, graph, workspace) → FlowProblem[]` for node-specific lint, and `execute` is attached server-side only. The same registry feeds palette, cards, panel, linter, server validation and the runner.

## 8. Data model (SQLite, `src/server/flow-store.ts`)

- `flows(id PK, name, description, spaceId NULL, ownerId, graph JSON, revision INTEGER, status 'draft'|'published'|'paused', publishedVersionId NULL, locked INTEGER, createdAt, updatedAt)`
- `flow_versions(id PK, flowId, graph JSON, label NULL, notes NULL, source 'autosave'|'named'|'restore'|'publish', createdBy, createdAt)`
- `flow_triggers(id PK, flowId, nodeId, kind 'manual'|'schedule'|'slack'|'webhook'|'page', config JSON, active INTEGER, nextRunAt NULL, token NULL, lease NULL, leaseUntil NULL)` — rebuilt on Publish; schedule rows are claimed by the FlowRunner's own loop (modelled on `Store.claim`, but with lease renewal and multi-flight), never by the single-flight task `Runner`.
- `flow_runs(id PK, flowId, versionId, status 'queued'|'running'|'waiting'|'completed'|'failed'|'cancelled'|'timed_out'|'interrupted', trigger JSON {source, nodeId, text, fields, slack?, page?, body?, startedBy}, result JSON NULL (Result {text, sources} keyed by Finish label), error NULL, waitingNodeId NULL, threadId NULL, startedAt, finishedAt NULL, lease NULL, leaseUntil NULL, dotTurns INTEGER, tokens INTEGER NULL, parentRunId NULL)`
- `flow_run_steps(runId, nodeId, iterationKey TEXT DEFAULT '', attempt INTEGER DEFAULT 1, status 'pending'|'ready'|'running'|'waiting'|'completed'|'failed'|'skipped', input JSON, output JSON ({port: {kind, value}}), error NULL, threadId NULL, startedAt, finishedAt, durationMs, tokens NULL, PK(runId, nodeId, iterationKey, attempt))`
- `flow_run_events(id AUTOINCREMENT, runId, nodeId NULL, kind, data JSON, text, createdAt)` — append-only, streamed over SSE, and mirrored as a text log so `poll-notice` works unchanged.
- `flow_approvals(id PK, runId, stepId, flowId, kind 'review'|'page'|'connection', title, payload JSON (draft, instructions, allowEdits, actions, pageTarget?, approvalId?), status 'pending'|'approved'|'changes'|'declined'|'expired', editedText NULL, feedback NULL, decidedBy NULL, expiresAt NULL, slackRef NULL, createdAt, decidedAt NULL)`
- `flow_threads(runId, nodeId, iterationKey, dotId, threadId, PK(runId, nodeId, iterationKey))` mapping steps to `thread_bindings` rows titled "Flow: <flow> / <node>" so every step is an ordinary, inspectable conversation.

REST (Hono, `/api/flows`): `GET/POST /flows`, `GET/PUT/DELETE /flows/:id` (PUT takes `revision` for conflict detection), `POST /flows/:id/duplicate`, `POST /flows/:id/validate`, `GET/POST /flows/:id/versions`, `GET /flows/:id/versions/:vid`, `POST /flows/:id/versions/:vid/restore`, `POST /flows/:id/publish` (label, notes; refuses on lint errors; rebuilds flow_triggers), `POST /flows/:id/unpublish`, `POST /flows/:id/pause`, `POST /flows/:id/resume`, `POST /flows/:id/lock`, `POST /flows/:id/export`, `POST /flows/import` (re-links Dots and Spaces by name with a review dialog), `GET /flows/approvals` (inbox). Release 2: `POST /flows/:id/runs`, `GET /runs/:id` (SSE), `POST /runs/:id/cancel`, `POST /flows/approvals/:id/decide`, `POST /flows/:id/hooks/:nodeId`.

Export never includes secrets: webhook tokens live only in `flow_triggers`, MCP tokens in `mcp_connections`, Slack ids in `slack-channel` config; Dots and Spaces are exported as `{id, name}` references.

## 9. Execution semantics (specified now, implemented in release 2)

**Readiness (universal).** Each output port yields `{kind, value}`. An edge is _settled_ when its source step completed (value) or was skipped (edge inactive). A node is _ready_ when every incoming edge is settled (Start when = all) or when the first value arrives (first; later arrivals are ignored and logged). A node whose incoming edges are all inactive is skipped, and skipping propagates. When Branch, Dot decides, Human review or Save page (declined) takes one arm, every other arm's downstream subgraph is marked skipped unless a node there also has a live incoming edge. This is how exclusive branches rejoin at Finish, Send message or Save page with no Join node, and why no node can deadlock.

**Chips and context.** A step's text fields are rendered with chips resolved from `flow_run_steps.output`; a chip whose source was skipped resolves to an empty string and an info event. Dot task context assembly: the brief, then every live context payload as a labelled section ("From Research:"), with text over 8 000 chars truncated with a note, page payloads passed as references (title, url, revision) for the Dot to read with its own page tools, lists summarised as "N items" unless per-item is on.

**Parallelism.** All ready steps run concurrently under `settings.maxConcurrency` (default 5). Each Dot step runs via `runThreadTurn` in its own `thread_bindings` row with metadata `{opendotsSource:'flow', runId, nodeId, tools}`; `headless.ts` gains a `flowMessagePrefix` so transcripts label flow turns. Same-Dot steps serialise only when they share a thread (`run`, `keyed`, `trigger` modes); fresh-thread fan-out with one Dot is truly parallel.

**Per-step tool allowlist (hard rule).** `DotAgent` reads `tools` from the flow message metadata / forwardedProps and filters serverTools and connected tools accordingly; create/edit page tools are off unless the node enabled them; `review_space_page` and `request_connection_action` are never offered in flow turns. "Review before any page save" swaps the page-write tools for a flow-only server tool `propose_space_page` that writes `flow_approvals(kind='page')` and returns "pending review"; the run parks and the decision performs the save through `page-service.ts`.

**Per-item.** When a json array arrives and `perItem` is on, the engine runs the step once per element (concurrency ≤ 5), one `flow_run_steps` row per item with `iterationKey = index`, and emits a json array on the output port (the port's declared kind is json while per-item is on). Item failures follow the node's onError (skip by default for items).

**Structured JSON.** A response-format instruction plus server-side validation against the node's field rows; one automatic retry with the validation error appended, then the step fails per onError.

**Revise edge (the only v1 cycle besides For each).** `human-review.changes → dot-task.context` with `edge.revise = true`. On Request changes the engine re-runs the sub-path from the target Dot task to the review node with the feedback appended as context, increments `attempt`, and stops when `maxRevisions` is reached (the review then presents only Approve / Decline). Lint: the target must be an ancestor of the review node and `maxRevisions` must be set.

**Human gates.** Human review, Save page (review on), and (release 2) connection approvals write a `flow_approvals` row, set the step and run to `waiting`, persist all pending values, release the lease, post the card in-app (Reviews inbox, Scheduled & activity, the flow's thread) and, if a Slack Start triggered the run and Slack notify is on, post the card with buttons via `thread.post(ui)` + `onInteraction` in that thread. The decision endpoint re-claims the run, routes Approved (edited text if allowed) / Changes requested (feedback text) / Declined (feedback; the Declined arm) and resumes. Expiry applies onTimeout. Connection approvals (release 2 bridge): when a flow turn ends with a pending `mcp_approvals` row, the engine writes `flow_approvals(kind='connection')`, parks, and on approval re-issues the action (APPROVAL_TTL is 60 min) and resumes the turn with "Approval granted; continue".

**Errors and guards.** Per-node onError as in §5. Run-level: `timeoutMinutes` (default 60, excludes waiting time), `maxDotTurns` (default 30; the token budget field exists in the schema but is hidden until `runThreadTurn` reports usage). Cancellation aborts in-flight turns through the AbortSignal already threaded into `runThreadTurn`. Leases are renewed every 30 s; on expiry or server restart a run becomes `interrupted` with completed step outputs intact; release 2 adds "Resume from last completed step" and "Replay with cached outputs".

**Triggers.** Manual: `POST /flows/:id/runs` with the form fields. Schedule: `flow_triggers` rows claimed by the FlowRunner loop (`nextRunAt`, lease renewal; not the 90 s single-flight task Runner). Slack: `slack-channel.ts` `handlers.mention` checks published Slack triggers (channel filter, keyword) before the default Dot reply, optionally posts "On it", and passes `{text, channel, user, threadTs, permalink}`. Webhook and Page-saved: release 2.

**Results.** Finish nodes assemble `flow_runs.result` as `Result {text, sources}` keyed by unique label (several Finish nodes merge with headings); with `replyToTrigger` the result is posted to the originating Slack thread. The Scheduled & activity view gains a Flows section rendering runs with the existing ResultPane.

**Observability.** Every state change appends `flow_run_events` streamed over SSE (card status ring, `i/n` counters, waiting badge, edge payload counts) and mirrored as text for `poll-notice`; tokens are recorded only where the runtime reports them.

## 10. Linter rules (shared; error blocks Publish/Preview, warning and info never block)

Errors: no Start; unknown node type; missing required field; missing Dot / Space / tool; unwired required port; text → json edge; edge to a port that no longer exists; cycle other than a bounded revise edge or For each loop-back; revise edge without Max revisions or not targeting an ancestor; too many edges into a single-input port; chip referencing an unknown or non-upstream node; duplicate Finish labels; Connected app arguments failing the tool's inputSchema; approval-gated tool in a Dot task allowlist or Connected app (release 1); `thread = trigger` without a Slack Start or on a Dot that is not the Slack-bound Dot; Dot lacking a permission a step needs (web research off, no access to the chosen Space, no computer); Beta node present ("Runs in a future release" — error for Publish, allowed for Save).

Warnings: unreachable node; dangling output never used; no Finish; edge kind changed since creation; Human review whose outputs feed nothing; Send message / Human review using a Slack destination that is not available yet; Slack Start without Slack configured; research provider not configured; connection in error; outdated typeVersion; nested For each; For each body edge escaping the body; duplicate chip labels into one node.

Info: Save page fed directly by a Dot with review off; connected context never referenced in the brief; Note overlapping a node.

## 11. Publish lifecycle

Autosave writes the draft 1.5 s after the last edit (header chip). Publish requires a version name, creates a `flow_versions` row with `source='publish'`, sets `publishedVersionId`, rebuilds `flow_triggers`, and shows "Published". Further edits show "Published with unpublished changes"; published triggers keep running the published version. Pause stops schedule and Slack triggers (status "Paused"); Resume restarts them. Unpublish clears triggers and returns to Draft. Lock makes the canvas read-only for everyone (header padlock). Versions drawer lists autosave snapshots and named/published versions with read-only preview, Restore to draft, and Duplicate as new flow.

## 12. Starter templates

Built only from v1 nodes; described in `starterTemplates`. The first one is the onboarding tour target and demonstrates fan-out, fan-in (`waits for 2`), a three-button review with inline edit, the bounded revise edge, and review + publish in one node.

## 13. Migration from the current scaffold

1. `src/shared/flows.ts`: add `combine`, `settings` on nodes, `kind`/`revise`/`label` on edges, `notes`/`variables`/`settings` on the graph, `ports(config)`, `summary`, `validate`, `COMMON_SETTINGS`, `migrateGraph`, the coercion table in `kindsCompatible`, multi-Start, and the rule list above; drop `singleton`. Replace the `page` and `list` controls with `select` (live options) and `json` (rows editor) to match the catalog's control set.
2. `src/server/flow-store.ts`: add status/locked/publishedVersionId/spaceId columns and the run/approval/trigger tables; `flow-routes.ts`: add publish/unpublish/pause/resume/lock/export/import/approvals.
3. `src/client/flows`: FlowEditor (React Flow), palette with Dots and Tools groups and Beta toggle, cards per registry, Issues tab, Preview run order overlay, Problems tray, Versions drawer, Reviews inbox, sidebar entries, SpaceNav rows.
4. `src/server/dot-agent.ts`: tool allowlist from flow metadata; `headless.ts`: `flowMessagePrefix`; `page-service.ts`: pass `sourceThreadId` for flow turns so the Dot task `pages` output is populated.

## 14. Open questions

- Should the Reviews inbox also list chat-originated page reviews (`page_reviews`) so there is one inbox? Proposed: yes, in release 2, read-only for chat items.
- Dot team needs a flow-turn override for `TURN_TIME_LIMIT_MS` and `maxIterations` before it can run; decide whether that override is per-node config or a FlowRunner constant.
- Should Preview run order be able to show a sample route for Dot decides by asking the Dot once (costs a turn) or stay purely manual? Proposed: manual in release 1.
- Where does the Slack channel destination land once channels supports proactive posting: Send message only, or also Human review notify? Proposed: both, same flag.
- Token budget stays hidden until `runThreadTurn` returns usage; confirm the Intelligence runtime can surface it.
