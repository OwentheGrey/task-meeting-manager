# Task Meeting Manager — Chat History

Rolling log of major implementation work. New sessions append to the top. Each feature entry traces from initial Jira ticket through to the artifact push. Excludes work still pending in Jira to keep that as the single source of truth.

---

## 2026-05-12 — Revert TSKMGR-45 Part B

**Why.** Part B (canvas-driven proposed agenda items) shipped earlier today but bricked the page on load. Root cause was suspected to be the new ~470-line block introducing some combination of (a) unescaped `</script>` substrings inside JS comments/strings, (b) MCP bridge calls firing during render before window.cowork was ready, and/or (c) parser regex behavior on unusual canvas content. Rather than spelunk through the failure in a no-DevTools, no-hard-refresh environment, we rolled the change back to a known-good post-TSKMGR-70 state and parked the work for a future wave with better validation tooling.

**What was removed:**

- `COMMITTEE_SCHEMA` fields: `canvasId`, `canvasItemDecisions`.
- `STATE.canvasProposals` hydration in `_loadInitialState`.
- The `TSKMGR-45 Part B — Canvas proposed-agenda cache + parsing + fetch helpers` section (≈175 lines): `CANVAS_PROPOSALS_TTL_MS`, `getCanvasProposals`, `isCanvasProposalsStale`, `setCanvasProposals`, `_canvasItemHashId`, `parseCanvasMarkdownToItems`, `fetchCanvasProposals`, `resolveCanvasIdForCommittee`, `_canvasUrlFor`.
- The `TSKMGR-45 Part B — Proposed agenda from Slack canvas` render section (≈245 lines): `_canvasAutoFetchInFlight`, `_showDismissedCanvasItems`, `_agendaIdHasCanvasSource`, `acceptCanvasProposalToAgenda`, `dismissCanvasProposal`, `undoDismissCanvasProposal`, `renderCanvasProposalsSection`.
- The `dos.append(renderCanvasProposalsSection(c))` call at the top of `renderOwnerShape`.
- The committee-only Canvas ID input (paste-URL → F-token extraction) inside `_renderSlackChannelEditor`. Editor is back to the post-TSKMGR-70 shape: Slack channel ID + name fields plus a one-line meta note.
- The `mcp__41e23f2c-10b6-43fa-ae26-3ec63b9776d0__slack_read_canvas` entry from the artifact-meta `mcpTools` array and the corresponding `"Slack"` entry from `mcpServerNames` (kept the two arrays positionally aligned).

**What was restored:**

- `TODO TSKMGR-45 Part B` comment block above `renderCommitteeProfile` — same placeholder shape the function had right after Part A landed, just a multi-line `//` comment so future implementers can grep for the ticket.

**What we kept:**

- Everything TSKMGR-70 (calendar attendees), TSKMGR-69 (state write-back), Waves 1/2/3, TSKMGR-65/67/61, and TSKMGR-45 Part A (Slack channel mapping + `STATE.slackChannelMembers`).
- The two `</script>`-substring escape edits in the state-write-back comments (lines ~1401 and ~1470). Those weren't the bug — they were the post-Part-B fix attempt — and they're harmless on their own.

**Validation.** No DevTools / hard-refresh / console available in Cowork desktop. Validated structurally via Read/Grep:

- File line count: 8,413 (down from 8,883; was 8,410 pre-Part-B per Part A's notes — the +3 is from TSKMGR-69 + the new TODO placeholder).
- Grep for the removed function/symbol names returns zero hits anywhere in the file.
- IIFE opens at line 998 (`(function () {`) and closes at line 8409 (`})();`). Main `<script>` tag spans lines 997–8410.
- All four `</script>` substrings in the file are legitimate closing tags: meta block (line 31), theme-bootstrap inline script (line 917), state seed (line 919, on same line as content), main script (line 8410). The only other `<script` substrings live inside JS comments or `String(...).replace(/<\/script/...)` regex calls — both safe inside a `<script>` element because the HTML parser only sees the literal `</script>` byte sequence.
- File ends cleanly: `})();</script></body></html>`.

**Findings worth flagging:**

- The `mcpTools` and `mcpServerNames` arrays in the artifact-meta JSON were positionally aligned 11-to-11 before this revert. Removed entries paired correctly (item 9 in both — slack_read_canvas / Slack) so they're now 10-to-10. If anything else relies on that alignment, it's intact.
- Nothing in Part A (Slack channel mapping) depends on anything from Part B. They were intentionally decoupled — Part B reads `committee.canvasId`, never `slackChannelId`, so removing Part B doesn't strand Part A.
- The `_canvasUrlFor` hard-coded `cru-main.slack.com` host is gone with the revert, but it was a known TODO already — future Part B reimpl should use the optional `committee.canvasUrl` field instead (or call `slack_search_public` with `file:<canvasId>` for a permalink).
- The Workspace Linux mount continues to be unavailable for `node --check` runs. Still worth filing a session-tooling ticket — Part A flagged this, Part B re-confirmed it, and this revert had to fall back to Read/Grep validation too.

---

## 2026-05-12 — TSKMGR-45 Part B — Canvas-driven proposed agenda items for committees (REVERTED 2026-05-12)

**Premise.** Part A delivered the per-project/committee Slack channel mapping; Part B reads each committee's mapped Slack canvas and surfaces every heading / bullet line as a proposed agenda item with Accept / Dismiss controls. Owner-shape committees only — canvas content is most actionable for meetings Owen drives.

**Slack canvas MCP capability check (investigative step).** Confirmed `mcp__41e23f2c-10b6-43fa-ae26-3ec63b9776d0__slack_read_canvas` is available. Single required arg: `canvas_id` (Slack file id, e.g. `F08143HNAQJ`). Response shape (verified against two live canvases):
```
{ canvas_id: "F08143HNAQJ",
  markdown_content: "# Next Meeting\n\n## 📝 Agenda topics\n\n* Filtered View of the Calendar ...\n## ✅ Action items\n* [ ] Add something that needs to get done\n...",
  section_id_mapping: { LBN9CAeCfgy: "# Next Meeting", LBN9CAkVhwn: "## 📝 Agenda topics", ... } }
```
The MCP does NOT auto-discover a channel's default canvas from a channel ID — the caller must supply a canvas file ID directly. We therefore added a new optional `committee.canvasId` field and a Canvas ID input in the existing Slack channel editor that accepts either a raw `F...` id or a pasted canvas URL (the input pulls the `F`-prefixed token out via regex).

**Key decisions:**

- New `COMMITTEE_SCHEMA` fields: `canvasId` (default null) and `canvasItemDecisions` (default `{}`). Decision shape: `{ [canvasItemId]: { decision: "accepted"|"dismissed", timestamp: ISO, acceptedAgendaItemId?: string } }`.
- New `STATE.canvasProposals = {}` keyed by canvas ID. Value: `{ fetchedAt, canvasId, source: "slack_read_canvas"|"manual", items: [{ canvasItemId, text, level }] }`. 24h soft-stale TTL — stale entries still served, with a "stale >24h" pill.
- Parser: every heading (`#`/`##`/`###`/...) and bullet (`-`/`*`/`+`, with optional task-list checkbox) becomes one proposed item. Source order preserved; horizontal rules and empties skipped. Bold/italic/code/link markup stripped from the surfaced title. Slack canvas `slack_date:` macros normalized to the bare date.
- Stable per-item id: `_canvasItemHashId(canvasId, text)` ASCII-folds non-ASCII then `btoa()`s → 16-char strip. Deterministic across refreshes (same canvas + same text = same id) so decisions outlive a refresh.
- Accept flow: pushes a new agenda item onto `committee.agenda` with source_type="slack", source_link=canvas URL, source_context.kind="slack_canvas", source_context.excerpt=original text. Stamps `canvasItemDecisions[id] = { decision: "accepted", timestamp, acceptedAgendaItemId }`. Independent copy — deleting from the canvas later doesn't remove the agenda item.
- Dismiss flow: records `decision: "dismissed"` only; item disappears from the proposed list. "Show dismissed (N)" toggle (in-memory, per-committee) reveals dismissed items with an Undo button.
- Auto-fetch policy: when a committee dossier renders with `committee.canvasId` set and the cache is missing or stale (>24h), kick a fire-and-forget `fetchCanvasProposals(canvasId)` and re-render on completion. Concurrent calls per canvas are deduped via `_canvasAutoFetchInFlight`. Manual Refresh button always available.

**Implementation:**

- New section in the artifact: `TSKMGR-45 Part B — Canvas proposed-agenda cache + parsing + fetch helpers` next to the Part A channel-members helpers. Functions: `getCanvasProposals`, `isCanvasProposalsStale`, `setCanvasProposals`, `_canvasItemHashId`, `parseCanvasMarkdownToItems`, `fetchCanvasProposals`, `resolveCanvasIdForCommittee`, `_canvasUrlFor`.
- New `renderCanvasProposalsSection(c)` + `acceptCanvasProposalToAgenda`, `dismissCanvasProposal`, `undoDismissCanvasProposal`, `_agendaIdHasCanvasSource` (future hook), placed just above `renderCommitteeProfile`.
- `renderOwnerShape` now calls `renderCanvasProposalsSection(c)` first, ABOVE the existing Suggested agenda block.
- `_renderSlackChannelEditor` extended with a committee-only Canvas ID input (paste-URL → F-token extraction). Project shape unaffected (canvas mapping is per-meeting-context, committees only for this wave).
- Artifact-meta block extended with `mcp__41e23f2c-10b6-43fa-ae26-3ec63b9776d0__slack_read_canvas` so the cowork bridge can broker it.
- `STATE.canvasProposals` hydration sits next to `STATE.slackChannelMembers` + `STATE.committeeAttendees` in `_loadInitialState`.
- Removed the `TODO TSKMGR-45 Part B` placeholder block from `renderCommitteeProfile` — replaced with a one-line comment on the existing Slack channel editor explaining where the canvas input now lives.

**Bug discovered + flagged.** The session's Linux bash mount is unavailable (`Workspace unavailable. The isolated Linux environment failed to start.`) — same class of issue as Part A. `node --check` couldn't run. Validated via Read/Edit on the Windows path: function declarations all balanced, IIFE closes at line 8878, total file length 8883 lines (was 8410, +473). Worth ticketing separately if the mount keeps misbehaving across sessions.

**TODOs left in code:**

- None new. The `TODO TSKMGR-45 Part B` placeholder was removed as part of this wave.
- `_agendaIdHasCanvasSource` is a future hook used to short-circuit re-accepting the same canvas item after the user manually deletes the prior agenda item; not wired up yet — current accept flow assumes user intent.

**Open follow-ups worth ticketing:**

- Canvas URL host detection. We hard-code `https://cru-main.slack.com/docs/<canvasId>` for the source attribution link because the MCP doesn't return a permalink. A separate ticket should either (a) call `slack_search_public` with `file:<canvasId>` to fetch the permalink, or (b) store `committee.canvasUrl` alongside `canvasId` on paste so we keep whatever the user gave us verbatim. Today's behavior already honors `committee.canvasUrl` if set externally.
- Channel-default canvas discovery. The MCP doesn't expose this; once it does, `resolveCanvasIdForCommittee` should fall back to channel-default when `committee.canvasId` is null.

---

## 2026-05-11 — TSKMGR-45 Part A — Project/committee Slack channel mapping + tester-dropdown channel members

**Premise.** TSKMGR-45 originally bundled two features: (Part A) per-project/committee Slack channel association with member sourcing for the UAT tester dropdown, and (Part B) canvas-driven proposed agenda items. This wave delivers Part A only; Part B is held for a separate wave with a `TODO TSKMGR-45 Part B` reference in `renderCommitteeProfile`.

**Slack MCP capability check (investigative step).** Confirmed via the deferred tool registry that there is NO first-class "list channel members" Slack MCP tool today. Available primitives: `slack_read_channel` (reverse-chron messages), `slack_search_channels` (find by name), `slack_search_users` (find by name/email), `slack_search_public_and_private`. Chose option (c) Hybrid from the brief: derive members from `slack_read_channel` recent posters, then let the user add/remove manually for lurkers. Manual entries survive auto-refreshes.

**Key decisions:**

- New `STATE.slackChannelMembers = {}` keyed by channel ID. Value shape: `{ fetchedAt, source: "manual"|"slack_read_channel"|"hybrid", members: [{slackUserId, name, displayName?, email?, source}] }`.
- Pre-work from TSKMGR-61 already declared `slackChannelId` and `slackChannelName` fields on `PROJECT_SCHEMA` and `COMMITTEE_SCHEMA` — no schema changes needed here.
- `fetchChannelMembers(channelId)` calls `slack_read_channel` via `window.cowork.callMcpTool`, deduplicates posters, then merges with any existing `source:"manual"` entries from the cache.
- Cache TTL 24h — soft-stale only. Stale entries are still served; the UI surfaces a "stale >24h" pill so the user knows to click Refresh.
- Auto-fetch on channel-ID change when no cache exists yet (first time a channel is mapped). Refresh button on the profile triggers manual refetch. No background polling.
- `renderTesterDropdown` now accepts a `source` arg so it can resolve a channel context (`item.projectId` > `source.kind==="project"` > `source.kind==="committee"` direct mapping > committee → single linked project fallback). When a channel context resolves, channel members appear in an `<optgroup label="Channel members">` group above a `<optgroup label="Partners + others">`. With no channel mapped the dropdown renders a flat list — preserves the legacy look.
- `_buildTesterDirectory(ctx)` extended with channel members first (deduped by email/slackUserId/name), then Owen + partners + free-text. Each entry carries a `source` tag for the UI to group on.
- `_testerLabelFor` now scans every channel cache first so testers stored as a raw `slackUserId` (e.g. `U03SFQHH1J9`) resolve to their display name regardless of which view is rendering.
- Free-text testers added via the "+ Add tester…" affordance still persist to `STATE.uatTesterDirectory`, AND when a channel context is in scope they're also seeded into the cache as a manual member so they appear under "Channel members" next render.

**Implementation:**

- New code blocks: `_buildTesterDirectory` rewrite + `_findTesterEntry(value, ctx)` + `_channelContextForEntry(item, source)` + `renderTesterDropdown(item, onChange, source)`, then a new section `TSKMGR-45 — Slack channel member cache + fetch helpers` with `SLACK_MEMBER_TTL_MS`, `getChannelMembers`, `isChannelMembersStale`, `setChannelMembers`, `addChannelMemberManually`, `removeChannelMember`, `fetchChannelMembers`.
- New shared editor `_renderSlackChannelEditor(entity, kind)` — channel ID + name inputs, Refresh button, member list with per-row remove, manual-add row (name + email + slack user ID), staleness indicator. Called from both `renderProjectProfile` (after Jira queries) and `renderCommitteeProfile` (before Committee ID).
- `STATE.slackChannelMembers` hydration added next to existing `uatTesterDirectory` hydration in `_loadInitialState` cleanup.
- Two existing callers of `renderTesterDropdown` (UAT row factory + Task Detail modal) updated to pass `source`. No other callers exist.
- Artifact-meta block extended with `slack_read_channel`, `slack_search_channels`, `slack_search_users` so the cowork bridge can broker them.

**Bug discovered + flagged.** The bash mount serving the cowork session reads a stale snapshot of `index.html` (366KB pre-edit version), so the standard `node --check` step couldn't run against the live file. Validation fell back to structural review via the Read/Grep tools on the Windows path: every function declares cleanly (`_buildTesterDirectory`, `_channelContextForEntry`, `renderTesterDropdown`, `getChannelMembers`, `isChannelMembersStale`, `setChannelMembers`, `addChannelMemberManually`, `removeChannelMember`, `fetchChannelMembers`, `_renderSlackChannelEditor`, plus updated `_testerLabelFor`), the IIFE closes correctly at the new line 7917, and no stray `}` or `else` patterns were introduced. Worth ticketing separately as a session-tooling issue (mount cache invalidation).

**TODOs left in code:**

- `TODO TSKMGR-45` (inside `fetchChannelMembers` comment) — swap to a true `conversations.members` Slack API when an MCP surface exists. Cache shape and downstream consumers stay the same.
- `TODO TSKMGR-45` (inside `_renderSlackChannelEditor` footer note) — visible inside the artifact under the manual-add row so the user knows why lurkers need manual entry today.
- `TODO TSKMGR-45 Part B` (inside `renderCommitteeProfile`) — placeholder for canvas-driven proposed agenda items: read pinned channel canvas, parse headings/bullets, surface as PROPOSED entries on the next-meeting-only render of `renderOwnerShape`.

**Part B foundation laid by Part A:**

- Channel mapping persists per-entity on `project.slackChannelId` and `committee.slackChannelId` — Part B can read these directly to scope which canvas to fetch.
- `_renderSlackChannelEditor` is a shared component — Part B can add a "Canvas source" input alongside the channel ID without re-implementing the editor.
- MCP bridge proven for Slack calls (`fetchChannelMembers` uses the same `callMcpTool` pattern); Part B can mirror this for the canvas-read tool when wired.
- Slack MCP server entries already declared in `mcpServerNames` — Part B can add `slack_read_canvas` (or whatever the canvas-source tool ends up being called) without touching the artifact-meta header pattern.

---

## 2026-05-11 — TSKMGR-67 — Task Detail Modal + structured source provenance

**Premise.** The MY TASKS rows show title + due + priority + a few pills, but no context about what the task is actually for. Owen needs to see commitments, expectations, and source content when executing a task.

**Key decisions per the ticket:**

- New `description: string | null` field on every task — Markdown rendering with three structured sub-headings ("What I committed to" / "Expectations" / "Source excerpt"). Editable inline; saves on blur.
- New `attachedDocuments: [{ url, title }]` field — list rendered in modal "Associated documents" section when non-empty.
- `source_type` enum extended with `gdrive` (Drive doc) and `manual` (user-created). User-created tasks via Quick Capture now stamp `source_type: "manual"` + `source_link: null` — label "Manual" renders in the modal.
- `source_context.location` added — `{ page_start, page_end, line_start, line_end } | null` for citation precision (e.g. "p. 3, lines 12–18").
- Source label naming convention via new `sourceLabelFor(item)` helper: Call Notes / Email / Slack / Drive / TICKET-KEY / Manual / Cowork / Other / null.
- Click anywhere on a row outside an inline-editable affordance opens the modal. Selector mirrors every interactive affordance the row factory paints — `.editable, .pill-select, .tester-select, .jira-link, .source-link-slot, .nudge-btn, .triage-btn, .unarchive-btn, input, textarea, select, button, a` — preserving all existing inline edits.
- Modal closes via X button, Escape key, or backdrop click.

**Implementation:**

- CSS: new `.task-detail-backdrop` / `.task-detail-modal` family appended to the Wave 3 style block, with dark-mode variants. Row cursor toggled to `pointer` (with overrides on inline affordances).
- New `<div class="task-detail-backdrop" id="task-detail-backdrop">` HTML element next to the existing Quick Capture modal.
- New helpers: `sourceLabelFor()`, `renderDescriptionMarkdown()` (handles `##` / `**heading**` / `- bullets` / `> blockquote` / paragraphs — regex-based, no library), `_formatSourceLocation()`, `openTaskDetailModal()` / `closeTaskDetailModal()` / `_refreshTaskDetailModalIfOpen()`, `renderTaskDetailModal()`.
- `SOURCE_LINK_GLYPHS` extended with `gdrive` (📁) and `manual` (✍️). `manual` has no glyph rendered inline since `renderSourceLinkSlot()` already guards on `source_link != null` and user-created tasks have no URL.
- `renderTaskRow` gets a single row-level click listener at the end that opens the modal when the click target isn't inside an inline affordance.
- All five Quick Capture creation paths (`partner.agenda` / `partner.commitments[lane]` / `committee.agenda` / `committee.actionItems` / `project.actionItems`) now stamp `description: null`, `attachedDocuments: []`, `source_type: "manual"`. Existing persisted state hydrates cleanly — every new field is read with `item.field ?? default` semantics throughout the new code.

**Bug discovered + flagged.** None. `node --check` validated the new code standalone; smoke tests confirmed `sourceLabelFor`, `_formatSourceLocation`, and `renderDescriptionMarkdown` behavior.

**TODOs left in code:**

- `TODO TSKMGR-67` (inside `renderTaskDetailModal`) — ingestion classifier needs to populate `item.description` on Claude-generated tasks using the spec template; for now manual capture defaults to null and the modal renders an "Add description…" placeholder. Downstream of this ticket.

---

## 2026-05-11 — Quick Views Overhaul (TSKMGR-52)

Restructured the quick-views surface from the split-by-time-window layout (Today / This Week / Rest) into a unified MY TASKS section with four internal filters. Also: refactored archive to include agenda items, built UAT view with tester assignment + nudge mechanic, and added 1:1 mirroring.

### Process

- Senior-BA-style Q&A per feature → Jira ticket created → implementation wave → artifact push
- Three implementation waves landed sequentially because the artifact is single-file (parallel agents would corrupt diffs)
- Row contract drafted upfront so each view inherits a consistent UI without rework

### Epic & supporting tickets

- **[TSKMGR-52](https://jira.cru.org/browse/TSKMGR-52)** — Quick Views Overhaul / MY TASKS Restructure (new epic, parent of the 8 implementation tickets below)

---

### TSKMGR-44 — This Week view (Wave 1)

**Premise.** I didn't want to split tasks across today / this week / rest sections. Many tasks span multiple weeks; I need the whole list visible while keeping visual cues for what's due today vs. later this week.

**Key decisions during Q&A:**

- Window: Monday through next Monday before 12pm.
- Exception 1: if 3+ of 4 morning hours next Monday are booked → also include afternoon-Monday tasks.
- Exception 2: Monday holidays shift the window to Tuesday. Holiday detection requires three signals — Google all-day named-holiday event, AIA master calendar holiday, OOO block >5h.
- Sort: priority must → should → nice desc, then due date asc.
- Due-date color coding: green (user-set), yellow-green (Claude ≥70% confidence), yellow (Claude <70% — routes to Needs Attention instead), red (overdue), TODAY chip + row highlight on items due today.
- Done/Cancelled rows fade and sort to the bottom for the day, then archive at midnight.

**Implementation (Wave 1):**

- Published the shared row factory `renderTaskRow(item, source, handlers, options)` here. All later filters inherit it.
- Added `computeThisWeekWindow()`, `inThisWeekWindow()`, `collectMyTasksAll()` walker.
- Calendar heavy-morning and holiday detection stubbed with `TODO TSKMGR-44` — no live Google Calendar feed in artifact yet.

---

### TSKMGR-53 — MY TASKS section shell (Wave 1)

**Premise.** Container for the four internal filters with consistent navigation, badge support, and archive toggle.

**Key decisions:**

- Tab order: This Week / All UAT / Must Tasks / Needs Attention.
- Default landing: This Week.
- Filter selection persists across reload via `tmm.v3.myTasksFilter` localStorage key.
- Needs Attention badge: yellow shield 1–9, red shield 10+, no badge at 0.
- Show-archived toggle lives on the section header.

**Implementation (Wave 1):**

- Tab strip renders in both sidebar (compact) and dossier panel (full).
- Dispatcher routes filter id to the appropriate `renderXxxPanel()` function.
- Legacy "Today" sidebar entry removed (its content folded into This Week with TODAY chip).
- Legacy `all-uat` saved filter deleted (Wave 3 replaces it).
- `STATE.selectedView === "today"` redirects to MY TASKS for backward compatibility on hydrated state.

---

### TSKMGR-56 — Source-link infrastructure (Wave 1)

**Premise.** Every Claude-generated task needs a provenance link so I can verify where it came from.

**Key decisions:**

- New fields on the task model: `source_link`, `source_type`, `source_title`, `source_timestamp`.
- Types: `gemini_notes / slack / gmail / jira / cowork_chat / other`.
- Icon in row right zone, tooltip with title + relative time, click opens new tab.
- User-edited tasks retain original source link unless explicitly cleared.
- Broken-link detection deferred (`TODO TSKMGR-56`).

**Implementation (Wave 1):**

- Added to all Quick Capture creation paths.
- Row factory renders icon via a `SOURCE_LINK_GLYPHS` lookup.
- Archive preserves these fields when items are swept.

---

### Wave 1.1 — Partner-lane assignee fix + JOINT pill

**Why we patched.** The Wave 1 row factory defaulted assignee to "Owen" for every partner-rooted row. Partner commitments use three lanes (`ownerToPartner / partnerToOwner / joint`) to convey direction — there's no `assigneeEmail` field, so the lane IS the source of truth.

**Key decisions:**

- `ownerToPartner` → assignee chip = Owen.
- `partnerToOwner` → assignee chip = partner name.
- `joint` → assignee chip = Owen (single-owner rule, per Owen). Joint items get a small JOINT pill for visual cue.
- Joint commitments already surface in the partner dossier's three-lane "Open commitments" column — no new render path needed there.

**Implementation:**

- `collectMyTasksAll` now passes `source.lane` through for partner items.
- Row factory reads `source.lane` to derive the assignee label.
- `commitCol()` accepts opts; renders the JOINT pill on joint-lane rows.
- Also added `options.assigneeLabel` override hook for Wave 2/3 callers that want custom assignee strings (e.g., UAT view uses tester name).

---

### TSKMGR-65 — Project-rooted action items (between Wave 1 and Wave 2)

**Premise — discovered during Wave 1 implementation.** Project entity had an `actionItems: []` field in its data shape, but no UI flow read or wrote to it. Project-bound work that wasn't tied to a specific 1:1 or committee meeting had nowhere to live, which would have pushed it into committees just to have somewhere to put it.

**Key decisions:**

- Quick Capture gets a "Project" target option, populated from active projects.
- Project dossier renders Action Items above attachedDocuments (mirrors the committee actionItems pattern).
- MY TASKS filters walk project actionItems.
- Source attribution: 📋 project icon + name in tooltip.
- Default assignee: Owen (projects don't have an inherent counterpart like partners do).

**Implementation:**

- Quick Capture modal extended with project target row + project-action type.
- `renderProjectDossier()` now renders an Action items section.
- `collectMyTasksAll()` walks `STATE.projects.actionItems` for active projects.

**Bug discovered + fixed.** This change introduced a JS syntax error (`else if` after a bare `else` in the Quick Capture commit logic) that bricked the entire artifact — page rendered blank. Fixed by explicitly typing the previously-catchall branch: `} else { ... }` → `} else if (targetKind === "committee") { ... }`.

---

### TSKMGR-51 — Needs Attention view (Wave 2)

**Premise.** A triage bucket for tasks that need a human decision before they can flow into the other MY TASKS views.

**Key decisions:**

- Three sub-groups:
  - **Need a date** — Claude-suggested tasks with `dueBySource: "claude_low"`, plus undated Musts routed from Must Tasks.
  - **Recently added Must\*** — Claude-assigned `must` items created since the last completed PLAN MY WEEK ritual. Empty in practice until TSKMGR-49 lands (ritual timestamp source).
  - **Need clarification** — ambiguous Claude extractions flagged via `clarificationNeeded`. Empty for now; rendering path implemented for future ingestion flow.
- Sort: priority desc, then oldest-in-bucket first.
- Per-row triage actions:
  - **Accept** — promotes Claude suggestion to user-confirmed (sets `dueBySource: "user"`, stamps `reviewedAt`).
  - **Edit** — existing inline editors do the work; row-level `change` listener stamps `reviewedAt` on any save.
  - **Dismiss** — sets `status: "cancelled"`; archive sweep takes it from there.
- Tab badge: yellow 1–9, red 10+ (consumes Wave 1 plumbing — Wave 1 fed it `0` as a placeholder).

**Implementation (Wave 2):**

- `collectNeedsAttention()`, `renderNeedsAttentionPanel()`, `countNeedsAttention()`.
- New field on items: `reviewedAt` (stamped on row interaction).
- Sub-group headers auto-hide at zero items.
- Empty state: "Nothing needs your attention. Nice."

---

### TSKMGR-48 — Must Tasks view (Wave 2)

**Premise.** Focus lens for high-stakes work. Never lose sight of every must-priority item, sorted by due date.

**Key decisions:**

- Filter: `priority === "must"` only.
- Time horizon: ALL Musts regardless of due date proximity. The point is "never lose sight"; sort handles urgency. (Owen explicitly chose this over capacity-windowed approaches — capacity adjustments happen via outreach, not by hiding work.)
- Include Claude-suggested Musts (`aiSuggested: true`) with `Must*` asterisk.
- Exclude UAT items (covered by All UAT view).
- Exclude undated Musts (they route to Needs Attention's Need-a-date sub-group).

**Implementation (Wave 2):**

- `collectMustTasks()`, `renderMustTasksPanel()`.
- `_isUatTagged()` initially used the legacy `tags.includes("UAT")` check; Wave 3 upgraded it to look at `uatColumn`.
- Sort: due date asc, then `created_at` asc. Done/Cancelled sink to the bottom.
- Empty state: "No Musts on the board — good place to be."

---

### TSKMGR-54 — Archive view + Show-archived toggle (Wave 2)

**Premise.** Weekly-grouped completion history for weekly/monthly progress retrospection.

**Key decisions:**

- Auto-archive sweep moves done/cancelled items past local midnight into `STATE.archive`.
- Archive renders BELOW the active filter, not replacing it. Grouped by ISO week (most recent first), then by category.
- Week header shows total completed + Musts completed.
- Rows are read-only with an Unarchive button.
- Sweep triggers: app load, after every `persistState`, and on a 60-second interval (defensive — covers long sessions across midnight).

**Implementation (Wave 2):**

- `runArchiveSweep()`, `renderArchivePanel()`, `unarchiveItem()`.
- New shared helper `_walkTaskCollections()` (consumed by other views too).
- Utility helpers: `nowIso()`, `_localMidnightToday()`, `_isoWeekStart()`, `_sourceNameForRef()`.

**Bug fixed (post-Wave 2).** Initial Wave 2 implementation didn't include agenda items in the archive walker — Done agenda items would stay in the agenda list forever. Owen asked for this to be added: `_walkTaskCollections` extended to walk `partner.agenda` and `committee.agenda`. `unarchiveItem` extended to restore agenda items back to their proper array (`coll: "agenda"` in `sourceRef`).

---

### TSKMGR-47 — All UAT view (Wave 3)

**Premise.** Surface every UAT ticket per project, with a cumulative SLA clock and nudge mechanic so testing doesn't stall.

**Key decisions during Q&A:**

- UAT detection: items with `uatColumn === "test1"` or `"test2"`. Real Jira sprint sync deferred — manual transitions via inline pill for now (`TODO TSKMGR-47 future`).
- Layout: per-project sections, Test 1 / Test 2 sub-groups, hide empty.
- Project list dynamic — every project where Owen has touched a ticket (created / reported / assigned / commented). New projects surfaced during the Friday ritual (not implemented; covered by TSKMGR-49).
- Tester assignment is the ONLY editable field on UAT rows. Slack channel members source deferred (`TODO TSKMGR-45`); fallback dropdown = partners + Owen + "+ Add tester…" free-text option.
- Cumulative SLA clock across both columns (not reset per column): 5 cumulative days yellow, 7+ cumulative days red. Owen confirmed: 4 days in Test 1 + 1 day in Test 2 = 5 cumulative → yellow.
- Nudge button when stuck + tester assigned. Slack DM template: "Hey [TICKET-KEY link] needs to get tested in the next couple of days. Do you have time to run a test today?" — bundles multiple stuck tickets per tester into one bulleted message.
- UAT2 chip on This Week rows when a Test 2 item appears there.
- Defaults: TSKMGR Test 1 + Test 2 default to Owen (sole tester). All other projects: no defaults, manual select each time. (Owen specifically pushed back on the per-project defaults I proposed — testers rotate too much.)

**Implementation (Wave 3):**

- State additions: `uatColumn`, `uatTester`, `uatEnteredAt`, `uatColumnHistory` on items; `STATE.uatTesterDirectory` (seed for TSKMGR-45 channel data).
- New inline UAT pill on row factory (None / Test 1 / Test 2). Editable in normal contexts; locked when row is locked (with `options.uatEditable` exception so the pill stays movable in the All UAT view).
- `renderAllUatPanel()`, `_testerLabelFor()`, `_uatTesterDropdown()`, `nudgeTester()`, `_openSlackForTester()`.
- Cumulative day clock computed from `uatEnteredAt`; yellow / red row highlight applied.
- Updated `_isUatTagged()` in Must Tasks to check `uatColumn` (legacy tag fallback retained).

---

### TSKMGR-55 — 1:1 section + mirroring plumbing (Wave 3)

**Premise.** When a tester is assigned to a UAT task, that task should surface in their 1:1 prep so I see it when meeting with them. If the tester isn't a partner (e.g., Brian Funkhouser), use a lightweight ad-hoc collaborator surface — don't auto-promote them to a recurring 1:1.

**Key decisions:**

- 1:1 sections already exist as partner dossiers — no new entity / surface needed.
- Mirror is a derived view, not a stored reference. Re-renders always show current state.
- Partner dossier gets a new "UAT — assigned to you" section near the top, just walks UAT items filtered to this partner.
- Non-partner testers → new Collaborators sidebar section appears (only when ≥1 non-partner tester exists). Each collaborator gets a dedicated panel showing their assigned UAT items.
- Free-text testers added via the "+ Add tester…" option persist to `STATE.uatTesterDirectory`.

**Implementation (Wave 3):**

- `collectCollaborators()`, `renderCollaboratorPanel()`.
- Sidebar "Collaborators" section renders only when collaborator count > 0.
- Partner dossier mirror section uses the shared row factory with `options.locked: true`.
- `STATE.selectedView === "collaborator"` dispatch route added.

---

### Session deliverables summary

| Ticket | Title | Wave |
| :-: | :-- | :-: |
| TSKMGR-52 | Quick Views Overhaul / MY TASKS Restructure (epic) | Org |
| TSKMGR-44 | This Week view | 1 |
| TSKMGR-53 | MY TASKS section shell + filter switcher | 1 |
| TSKMGR-56 | Source-link infrastructure | 1 |
| (no ticket) | Wave 1.1 row factory polish + JOINT pill | 1.1 |
| TSKMGR-65 | Project-rooted action items | 1.5 |
| TSKMGR-51 | Needs Attention view | 2 |
| TSKMGR-48 | Must Tasks view | 2 |
| TSKMGR-54 | Archive view + Show-archived toggle | 2 |
| (no ticket) | Wave 2 agenda-archive fixup | 2.1 |
| TSKMGR-47 | All UAT view | 3 |
| TSKMGR-55 | 1:1 section + mirroring plumbing | 3 |

### Artifact growth this session

- Starting: ~5,400 lines (v3.4.10 / pre-Wave 1)
- After Wave 1: ~5,864
- After TSKMGR-65: ~5,940
- After Wave 2: ~6,406
- After Wave 3: ~6,984 (v3.5.0)

Net +1,584 lines.
