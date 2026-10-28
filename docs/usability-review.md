# Usability review — 28 Oct 2026

The app has grown feature by feature over 55 commits without a plan for how the pieces fit. Every feature works on its own; what's disjointed is the layer above them: how pages are named and grouped, what each page is *for*, which words are used for the same thing, where the primary action sits, and how much explanation the screen carries. This review is of the running app (both demo workspaces, every page, the main dialogs, at desktop and phone widths), not of the code.

## What the app is today

Two levels, ten pages, six dialogs:

| Level | Page | What it answers |
|---|---|---|
| All workspaces | Program overview | Weekly RAG and summary per program, as a table |
| All workspaces | All workspaces | The same programs, as cards, plus New / Edit |
| Workspace | Dashboard | How is this workspace doing? |
| Workspace | Gantt chart | The plan over time; edit by dragging or clicking |
| Workspace | Items | The plan as a grid; edit in cells; import / export |
| Workspace | Reports | Status reports on items; what's due |
| Workspace | Risks & issues | The register |
| Workspace | What changed | Diff against an earlier day |
| Workspace | Date history | Audit log of date changes |
| Workspace | Stream overview | Weekly RAG and summary per stream, as a table |

Dialogs: item edit, quick update (on the chart), item report, weekly update (program or stream), workspace settings (4 tabs), risk/issue/dependency, two importers, Find (⌘K), and three confirmation dialogs.

## The six things that make it feel disjointed

### 1. Three different "reports", with four different words

The app has three reporting concepts and never says so:

- **Item reports** — weekly/fortnightly/monthly status on one item. Called *Report*, *Provide report*, *Submit report*, *New report*, *Reports (11)*, *View reports*, *View all reports*.
- **Program weekly update** — one per workspace per week. Called *Update* (button), *Weekly update* (dialog), *Submit update*, *latest weekly update*, *Use in weekly update*.
- **Stream weekly update** — the same, per stream. Only reachable from Stream overview.

Item reports have a home (the Reports page). Weekly updates have none: they live inside the Program overview and Stream overview tables and as 12 cells on the dashboard. A user who wrote last week's program update can't find a list of them. The Reports page doesn't mention them at all.

### 2. "Program" and "Workspace" are the same thing

*Program overview* lists *programs*, with a *Program no.*; the next menu item is *All workspaces*; the dialog is *Edit workspace*; the dashboard says *Platform Replacement · PLT*. The two top-level pages show the same records in two shapes (table and cards) with different vocabulary and different actions (Update on one, Edit / Open on the other). A newcomer reads them as two different things.

### 3. The menu is a list of features, not a map

Ten entries in one flat list, in roughly the order they were built. Related pages sit apart: *Stream overview* (a workspace-level twin of *Program overview*) is last; *What changed* and *Date history* are both history but are presented as peers of *Gantt chart*. Settings hide behind a gear inside the workspace switcher. The bottom holds three near-duplicates: *Theme*, *Collapse*, *Hide*. On first open the app lands on the Gantt chart, which is the densest page; the Dashboard, which was built to answer "how are we doing?", is not the landing.

The URL for Items is `#/ws/1/editor`, a leftover name.

### 4. Every page explains itself in a paragraph, with file names

All ten pages end with a `hint` paragraph (two on Reports) of 60–120 words describing what the page does, how it's calculated and which CSV it's stored in: *"Weekly updates are stored in `updates.csv`"*, *"Stored in `raid.csv` and `raid-notes.csv`"*, *"The server keeps a copy of each file … in `backups/`"*. This is README content on the screen. It pushes the content up, is read once at most, and the file names mean nothing to the people writing reports. The same goes for the field-level notes in the edit dialog ("A milestone has one date and is drawn as a diamond…") and in Workspace settings.

### 5. Toolbars differ on every page

| Page | Primary (red) button | Search | Export |
|---|---|---|---|
| Program overview | **PNG** | — | Download CSV (secondary) |
| Dashboard | **PNG** | — | — |
| Gantt chart | **PNG** | left, first | Download PNG |
| Items | **+ Add item** | filter row in grid | Download CSV, Import…, Reload |
| Reports | **+ New report** | right, last | Download CSV |
| Risks & issues | **+ Add** | second row | Download CSV, PNG (secondary) |
| What changed | **Use in weekly update** | — | PNG (secondary), Copy summary |
| Date history | — | left | Download CSV (right) |
| Stream overview | **PNG** | — | Download CSV |

Exporting a picture is the emphasised action on five pages, where it is rarely what a user came to do. The search box moves around. Three pages wrap their toolbar onto two rows at 800px. The hamburger-less phone view shows a rail of unlabelled icons.

### 6. Editing an item has three surfaces with three field sets

- The **quick update panel** on the chart: RAG, type, dates, and four more buttons (Provide report, Reports, Date history, Edit details…).
- The **edit dialog**: everything, plus six footer buttons (Delete, Provide report, View reports, Date history, Risks & issues, Cancel, Save).
- The **Items grid**, with its own *Quick update* / *All fields* switch, inline editing, and a *Report…* column.

Each is sensible alone. Together, the same four related things (reports, date history, risks, delete) are reached from different buttons in different orders, and a user has to learn which surface has which fields.

## Smaller findings, by page

- **Dashboard** — the headline *"51% of the work complete … 44 points behind the time gone"* and the tile *"Dates moved 236 · 19 items · 110 knock-on · 30 days"* need a second read. The *Update* button on the At-a-glance card is the only workspace-level action and is unlabelled as to what it updates. PNG is the primary button.
- **Gantt chart** — the toolbar is the most capable in the app and reads well. Opening the chart with `?item=` draws the hover card over the menu (top-left) rather than beside the item. The quick panel's *Save* is correctly disabled until a change but *Cancel* is always live, which reads as the default.
- **Items** — at normal widths the first two columns truncate (*R…*, titles cut). The *Quick update / All fields* names don't say what differs. *Reload* belongs with the data tools, not beside Download.
- **Reports** — the Due view is the clearest thing on the page and is hidden behind a segment. Nine words describe the Preview toggle; the list says *period ending* while the form says *reporting cadence* and *period ending*.
- **Risks & issues** — the menu says *Risks & issues*, the page says *Risks, issues & dependencies*, the tabs say *Risks / Issues / Dependencies*. The status filter defaults to *Not closed*, which is right but is a select rather than the segment used everywhere else.
- **What changed** — an empty result shows five boxes each saying *No … changes* and a summary box saying *Nothing changed*. One line would do.
- **Date history** — good as an audit log; the *Who* column is blank by design and sits first. The *How* column mixes a label, a source and a note in one cell.
- **Stream overview** — all six streams show *— — — No update yet*: a table of blanks. Its only real content is the Update button.
- **Workspace settings** — *Clear history…* (destructive) sits in the Details tab in a red box; *Delete workspace* is in the footer. Two danger zones in one dialog.
- **Find (⌘K)** — works well. It stays open if you navigate while it's open, and Esc clears the text before closing.
- **Phone width** — the menu collapses to icons with no labels, and the green dot / gear pair sits with no workspace name beside it.

## What good looks like

One idea per page, one vocabulary, one toolbar pattern, help out of the way.

**Menu** (grouped, in the order people work):

```
Find…                        ⌘K
PORTFOLIO
  Portfolio          (table ⇄ cards; Update and Edit on both)
WORKSPACE  [switcher ▾]  ⚙
  Dashboard          (landing page)
  Plan               (the Gantt chart)
  Items
  Reports            (Item reports · Weekly updates · Due)
  Risks & issues
  Streams            (today's Stream overview)
HISTORY
  What changed
  Date log
Theme · Menu
```

**Words**: *Workspace* everywhere (program number stays as a field). *Report* means an item report; *Weekly update* means a program or stream update; buttons say *New report* / *New update*, never *Provide* or *Submit*. *Status* for the RAG field label; *RAG* only in the key. *Owner* and *Lead* consistently.

**Toolbar**: left = the page's one primary action, then search and filters; right = a single *Export ▾* (CSV / PNG / Copy summary) and *Import…*. PNG is never the primary button. Same row heights and gaps on every page; nothing wraps above 1024px.

**Help**: every `hint` paragraph becomes a *?* button in the page header that opens the same text in a popover; file names and storage details go only in the README. Field notes in dialogs become placeholder text or a tooltip.

**Editing**: the edit dialog gets a side column (or tabs) for *Reports · Date log · Risks & issues*, with Delete alone on the left and Cancel / Save on the right; the quick panel links to the same places with the same names.

**Empty states**: one sentence and one action (*No changes since 21 Oct. Pick an earlier day.*).

## Proposed phases

Each phase is a commit on its own and leaves the app working.

1. **Words and menu** (half a day): rename and regroup the menu, rename Program overview → Portfolio with the cards as its second view, land on the Dashboard, fix `editor` → `items` in URLs (old links still work), settle *Report* vs *Weekly update* in every button and heading, *Status* vs *RAG*.
2. **Help out of the way** (half a day): header *?* popovers replace the ten page paragraphs and the dialog notes; strip file names from the UI.
3. **One toolbar** (a day): the shared pattern on all nine pages, *Export ▾*, search in one place, no wrapping at 1024px, PNG demoted.
4. **Weekly updates get a home** (a day): a *Weekly updates* tab on Reports listing program and stream updates by week, with New update; the overview tables keep their Update buttons.
5. **Item editing** (a day): edit dialog with a related-things column; quick panel and grid use the same names; Items columns sized so ref and title never truncate at 1280px.
6. **Dashboard wording and empty states** (half a day): plain-English headline and tiles, single-line empty states on What changed and Streams, the hover-card position bug on deep links, Find closing on navigation.
7. **Phone and collapsed menu** (half a day): labels on hover/long-press, workspace name in the collapsed rail, toolbars that stack cleanly.

Phases 1–3 remove most of the disjointed feel; 4–7 finish the job.
