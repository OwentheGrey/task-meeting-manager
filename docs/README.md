# Task Meeting Manager

Single-file HTML artifact for managing 1:1 meeting prep, committee work, project tracking, and a unified personal task surface. ~8,413 lines, vanilla JS, custom state engine on a top-level `STATE` object.

**Current version:** v3.5.2 (post TSKMGR-70 — calendar-invitee tester sourcing; TSKMGR-45 Part B was reverted)
**Artifact path:** `C:\Users\Owen Grey\Documents\Claude\Artifacts\task-meeting-manager\index.html`
**Epic:** [TSKMGR-52](https://jira.cru.org/browse/TSKMGR-52) (Quick Views Overhaul / MY TASKS Restructure)

## Two main surfaces

### MY TASKS (top of sidebar)

Tab strip with four internal filters. Default landing is This Week; selection persists across reloads.

- **This Week** — Mon → next Mon noon, priority-sorted unified list. TODAY chip + row highlight on items due today. Due-date color coding: green (user-set), yellow-green (Claude ≥70%), yellow (Claude <70% → routes to Needs Attention), red (overdue).
- **All UAT** — per-project sections with Test 1 / Test 2 sub-groups. Cumulative SLA clock (5d yellow, 7d red). Tester dropdown sourced from partners + free-text. Slack nudge button when stuck + tester assigned. Read-only Jira fields; only tester is editable.
- **Must Tasks** — every `must` item from partner commitments, committee actions, project actions. UAT items excluded. Undated Musts route to Needs Attention. Claude-suggested Musts render with `Must*` asterisk.
- **Needs Attention** — three sub-groups (Need a date / Recently added Must* / Need clarification). Per-row Accept / Edit / Dismiss triage. Tab badge: yellow shield 1–9, red shield 10+.

Plus a **Show archived** toggle on the section header that reveals weekly-grouped completion history below the active filter.

### Existing dossiers (sidebar below MY TASKS)

- **Quick Views** (legacy filters): Due this week, Blocked, Stale >14d, My Must items, Plan my week (placeholder for TSKMGR-49)
- **Partners** — 1:1 dossiers. New "UAT — assigned to you" section at the top mirrors UAT tasks where this partner is the assigned tester.
- **Committees** — committee dossiers with agenda, action items, decisions, threads
- **Projects** — project dossiers with Action Items (new) + attached documents + linked committees
- **Collaborators** (conditional) — renders when ≥1 UAT tester isn't a partner (e.g., Brian Funkhouser). Per-collaborator panel shows their assigned UAT items.

## Task / commitment / action item shape

```
{
  id, text|title,
  status: "open" | "in_progress" | "blocked" | "done" | "cancelled",
  priority: "must" | "should" | "nice",
  category: "strategic" | "tactical" | "status",
  dueBy: ISO date | null,
  dueBySource: "user" | "claude_high" | "claude_low" | null,
  tags: [],
  blockedOn: null | string,
  assigneeEmail,
  verifyVia / verifyStatus / verifyNote / verifyCheckedAt,

  // UAT (Wave 3)
  uatColumn: "test1" | "test2" | null,
  uatTester: string | null,
  uatEnteredAt: ISO | null,
  uatColumnHistory: [{ column, enteredAt, leftAt }],

  // Source provenance (Wave 1, extended by TSKMGR-67)
  // source_type enum: gemini_notes | slack | gmail | jira | cowork_chat | gdrive | manual | other
  // (TSKMGR-67 added `gdrive` for non-Gemini Drive docs and `manual` for user-created tasks.)
  source_link, source_type, source_title, source_timestamp,
  source_context: {
    kind, created_at, meeting_label, excerpt,
    location: { page_start, page_end, line_start, line_end } | null   // TSKMGR-67
  },

  // TSKMGR-67 — task detail modal
  description: string | null,                                          // markdown, click-to-edit
  attachedDocuments: [ { url, title } ],                               // URL-based links rendered in the detail modal

  // Misc
  aiSuggested: boolean,
  reviewedAt: ISO | null,
  clarificationNeeded: boolean,
  created_at: ISO,
  done_at: ISO | null,

  // When archived
  archivedAt, sourceRef: { kind, id, lane?, coll? }
}
```

## State model

`STATE` (top-level singleton) contains:

- `partners[]`, `committees[]`, `projects[]`
- `archive[]` (Wave 2)
- `uatTesterDirectory[]` (Wave 3 — free-text testers persist here as a fallback alongside the channel-member cache)
- `slackChannelMembers{}` (TSKMGR-45 Part A — keyed by Slack channel ID, value `{ fetchedAt, source, members:[{slackUserId, name, email?, displayName?, source}] }`)
- `lastPlanMyWeekRitualAt` (consumed by Needs Attention's "Recently added Must*" sub-group)
- `selectedView`, `selectedPartnerId`, `selectedCommitteeId`, `selectedProjectId`, `selectedCollaboratorId`

Persistence: 600ms-debounced writes to `localStorage["tmm.v3.lastState"]`, plus a shadow merge from the embedded state seed at the top of the file.

## Row factory contract

Every MY TASKS view uses `renderTaskRow(item, source, handlers, options)`:

- `options.locked` — read-only row (UAT view, archive)
- `options.uatEditable` — exception that keeps the UAT pill editable on locked rows
- `options.uat = { column, testerLabel, daysCumulative }` — adds tester dropdown, day clock, nudge button
- `options.assigneeLabel` — pre-computed assignee override
- `source.lane` — for partner commitments, drives assignee derivation (ownerToPartner → Owen, partnerToOwner → partner name, joint → Owen with JOINT pill)
- `aiSuggested` flag on item — renders the `Must*` asterisk

Inline editing via existing `inlineEdit()` helper. Pill selectors (status, priority, category, UAT column) via `pillSelect()`.

## Archive sweep

`runArchiveSweep()` runs on app load, after every `persistState`, and on a 60-second interval.

Items with `status: "done"` or `"cancelled"` whose `done_at` is older than today's local midnight move from their source array into `STATE.archive`. Each archived record stores `archivedAt` + `sourceRef` so `unarchiveItem()` can restore correctly.

Walks: partner commitments (all three lanes), committee actionItems, project actionItems, partner agenda items, committee agenda items.

## Slack nudge mechanic

When a UAT row's cumulative day clock hits 5+ AND a tester is assigned, a "Nudge [tester]" button appears. Clicking opens `slack://user?...` if `slackUserId` is known on the partner, otherwise copies a templated message to clipboard and shows a toast:

> Hey [TICKET-KEY link] needs to get tested in the next couple of days. Do you have time to run a test today?

## MCP integrations

Declared in the artifact-meta JSON block at the top of the file:

- `cowork.update_artifact` — best-effort artifact updates
- `Google Calendar.list_events / update_event` — meeting context (and future OOO detection for the ritual)
- `Gmail.search_threads` — email-source detection
- `Slack.slack_search_public_and_private` — context lookup
- `Jira POC.jira_search / jira_get_sprints_from_board` — ticket links + future sprint sync

## Known stubs in code

Grep for `TODO TSKMGR-` to find them. Active ones:

- `TODO TSKMGR-44` — calendar heavy-morning detection, holiday detection (need live Google Calendar data)
- `TODO TSKMGR-45` — swap `fetchChannelMembers` to a true `conversations.members` Slack API when one ships as an MCP tool (current path derives members from `slack_read_channel` posters + manual entry)
- `TODO TSKMGR-47 future` — real Jira sprint sync (auto-detect column moves), broken Slack handle warning
- `TODO TSKMGR-49` — PLAN MY WEEK ritual section (separate epic, Phase 7)
- `TODO TSKMGR-54` — `done_at` fallback when missing on legacy items
- `TODO TSKMGR-56` — broken-link detection on source-link icons
- `TODO TSKMGR-67` — ingestion classifier needs to populate `description` on Claude-generated tasks (template: "What I committed to" / "Expectations" / "Source excerpt")

## How to extend

- **Add a new task source** — extend `_walkTaskCollections()` to yield items with `sourceRef: { kind, id, ... }` so archive can route them back.
- **Add a new MY TASKS filter** — register the filter id in the `mytasks-tabs` array (~line 2615), add a dispatcher branch, write `renderXxxPanel(parent)` + `collectXxx()` walker.
- **Add a new editable field on rows** — extend the row factory; if it's a pill, reuse `pillSelect()` with new defs. Persist via `persistState(reason)`.
- **Add a new data field** — update task creation paths (Quick Capture branches + any `addX()` helpers), default to null on existing data, read with `item.field ?? defaultValue` to avoid breakage on hydrated state.

## File line-range map (post Wave 3)

- 1–24: Cowork artifact metadata (JSON)
- 30–800: CSS (inline `<style>` block plus Wave 1/2/3 appendix)
- 689: Embedded state seed (in `<script type="application/json">`)
- 750–1100: State init, load, shadow merge
- 1300–1500: Editable affordances (`inlineEdit`, `pillSelect` family, UAT helpers)
- 2000–2300: Row factory (`renderTaskRow`) + UAT extras
- 2400–3000: MY TASKS filters (This Week, Must Tasks, Needs Attention, Archive, All UAT, partner UAT mirror, collaborators)
- 3100–3200: MY TASKS shell + tab dispatcher
- 6200–6300: Sidebar (with Collaborators section)
- 6900–6984: Init + first render
