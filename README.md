# Tracker

A simple, zero-dependency tracker for one or more workspaces: define milestones and tasks in a CSV-backed editor, view them on a visually rich Gantt-style timeline, and collect periodic status reports.

## Run

```bash
node server.js
```

Then open http://localhost:3100 (set `PORT=xxxx` to use another port).

No `npm install` needed — plain Node (18+) and vanilla JS.

## Workspaces

Everything belongs to a **workspace**. The left-hand menu has **All workspaces**, a workspace switcher, and the current workspace's **Gantt chart**, **Items**, **Reports** and **Workspace settings**. Collapse the menu to icons with **Collapse** at the bottom; the app remembers the open workspace, view and menu state per browser.

**All workspaces** shows a card per workspace: its RAG, code, owner and lead, timeline, last report, a RAG breakdown of its items and counts. Click a card to open it, **Edit** to change it, or **+ New workspace**. A workspace has:

- **Name** (required, unique), **Code** (e.g. `PLT`, shown beside the name), **Description**
- **Owner**, **Lead** and **Workspace RAG**
- **Planned start / end**: optional; if blank, the card shows the span of the workspace's items
- **What does this workspace call things?**: the word for everything (default *Item*), for a single-date item (default *Milestone*) and for one with a date range (default *Task*). For example *Work item*, *Deliverable* and *Task*. The menu, buttons, badges, filters, legend and messages use these words; plurals are worked out automatically

### RAG options

**Workspace settings → RAG options** sets the RAG statuses a workspace uses. Every workspace starts with the standard five: Green (on track), Amber (at risk), Red (off track), Complete and Not Started, with Amber and Red needing a get to green plan and new items starting at Not Started. For each status you can set:

- **Colour**: used for the Gantt chart shapes and bars, the RAG buttons, pills and the workspace cards
- **Name** and **Meaning**: shown in the **Gantt key** as “Name — meaning”
- **Get to green plan**: reports at this status must include one
- **Default**: the status new items start at

Reorder statuses with ↑ ↓ (the order is used in the key, the RAG buttons and when sorting by RAG), **+ Add status**, remove one with ✕, or **Reset to the standard RAG**. Renaming a status renames it on every item and report in the workspace. Removing a status that's in use asks which status to move those items and reports to. A key preview shows the result before you save, and the workspace's own RAG is chosen from the same list.

RAG options are stored in [statuses.csv](statuses.csv), created the first time a workspace changes them. Workspaces without rows there use the standard five:

```
workspace_id,position,name,color,description,get_to_green,is_default
```

Deleting a workspace also deletes its items and reports (you're told how many first). There must always be at least one workspace.

Workspaces live in [workspaces.csv](workspaces.csv):

```
id,name,code,description,owner,lead,start,end,rag,item_term,milestone_term,task_term,created,updated
```

Items and reports carry a `workspace_id`. Ids stay unique across all workspaces, and dependencies and roll-ups only link items in the same workspace. Files from before workspaces existed still load, as do the earlier `programs.csv`, `program_id`, `manager` and `sponsor` names: rows without a `workspace_id` join the first workspace (reports follow their item), and if `workspaces.csv` is missing one is created.

## Data

Items live in [milestones.csv](milestones.csv) with columns:

```
id,workspace_id,ref,title,type,description,swimlane,subswimlane,owner,start,end,rag,shape,parent,depends_on
```

- **workspace_id**: the workspace the item belongs to (`id` in workspaces.csv)

- **id**: the **primary key** — a positive integer assigned automatically, unique, never changed and never reused. `parent` and `depends_on` reference ids, so they map directly onto a foreign key / join table when the data moves to a database
- **ref**: your own human-facing reference, e.g. `4.1`, `5.6` (shown on the chart; duplicates are flagged; "Sort by ref" orders 4.2 before 4.10)
- **type**: `milestone` (one date, drawn as a shape) or `task` (a start and end date, drawn as a bar). Change the type to give a milestone a date range, or to collapse a task to its end date. Files without a type column still load: a start before the end makes a task, otherwise a milestone
- **start / end**: `YYYY-MM-DD`. A milestone's start and end are always the same, and **changing either one moves the milestone**. A task's dates are inclusive, so its bar runs to the end of its end date, and a one-day task can start and end on the same day
- **rag**: one of the workspace's RAG options (by default `Green` | `Amber` | `Red` | `Complete` | `Not Started`). Matching ignores case; a status that isn't in the list is kept and shown in grey. Files with the older `status` column still load
- **shape**: `diamond` | `circle` | `square` | `triangle` (milestones only)
- **swimlane / subswimlane**: free text — each distinct value becomes a lane / nested sub-lane
- **parent**: id of the milestone this item rolls up to (the milestone can't fall before it finishes)
- **depends_on**: `;`-separated ids this item depends on (finish-to-start)

Changing an item's end date in the **Items** screen shifts everything downstream of it by the same number of days; anything that would then start before a predecessor finishes is pushed later. Circular dependencies are rejected. The old `name,date,rag` CSV format still loads.

RAG and dates change far more often than anything else, so they are the quickest to update:

- **Gantt chart**: click (or right-click) an item to open the quick update panel. Click a RAG to change it; change the dates and hit *Update dates* (the panel says how many dependent items will move). From there you can also *Provide report*, see its *Reports* or *Edit details…* for everything else.
- **Items tab → Quick update** (the default view): ref, title, type, owner, RAG and dates, all editable. Click a RAG to set it, or edit any cell. Switch to **All fields** for lanes, links, shape and so on.
- The quick update panel on the chart also has a **Type** switch.

Edit items in the app — in the **Items** table or by clicking an item on the chart. Every change saves to the CSV automatically. In the table, click a column header to sort (▲ / ▼ / off), use the filter row to narrow the list, and drag a header edge to resize a column (double-click to reset); sort and column widths are remembered per browser and never change the CSV order. You can also edit the CSV in a spreadsheet tool; hit *Reload* in the app afterwards.

## Reports

Owners provide a regular status report on any milestone or task. **Click an item on the Gantt chart → Provide report**, or use **Report…** on the Items tab. The form has:

- **Cadence**: Weekly, Fortnightly or Monthly, plus the **period ending** date. It defaults to the coming Friday, or to month end for monthly reports. The period covered is worked out from these two.
- **RAG this period**: Green / Amber / Red / Complete / Not Started. It defaults to the item's current RAG. If you change it on the item's latest report, you can update the item's RAG on the chart at the same time.
- **Exec summary** (required), **Achievements last period**, **Next steps**
- **Get to green plan**: only shown for, and required by, Amber and Red reports
- **Reported by**: defaults to the item's owner

The item's previous report is shown in a panel beside the form while you write the new one, with ‹ › to step back through older reports. Its sections can be copied across: last period's *next steps* into this period's *achievements*, the *exec summary*, or the *get to green plan* (carried forward). You can only have one report per item per period; if one exists, you'll be offered a link to open it.

The **Reports** tab lists every report in the current workspace, newest period first. Like the Items grid, click a header to sort, use the filter row (item, RAG, cadence, text…) to narrow the list, and drag a header edge to resize a column; the toolbar search looks through every report field. **View reports** in the item's edit dialog, the quick update panel and the report form jumps here filtered to that item. Click any report to edit or delete it; edits are tracked with `created` / `updated` timestamps. **Download CSV** saves the reports currently listed (filters applied) with the item's `ref` and `title` added for readability.

Reports are stored in [reports.csv](reports.csv), one row per report:

```
id,workspace_id,item_id,cadence,period_start,period_end,rag,exec_summary,achievements,next_steps,get_to_green,author,created,updated
```

- **workspace_id**: the workspace the report belongs to

- **id**: the report's primary key (never reused)
- **item_id**: foreign key to the item's `id` in milestones.csv. Deleting an item keeps its reports.

## Gantt chart

- Swimlanes with alternating backgrounds and colour accents
- Swimlanes with nested sub-swimlanes
- Milestones drawn as RAG-coloured shapes, tasks as bars, with title, dates and owner; overlapping items stack automatically
- Dependency arrows and dashed roll-up arrows (toggle with **Dependencies**)
- **Row height** slider — below 40px the dates/owner line under each item is hidden for a compact view
- Hover an item for a summary card (including its last report); **click it** to update its RAG or dates, provide a report, see its reports or edit its details (**+ Add** for a new item)
- The chart fills the window below its toolbar and scrolls inside its own panel
- Zoom: −/+ buttons, slider, and **Fit** (auto-fits until you zoom manually)
- Date range pickers with **Auto** reset to fit all milestones
- Toggles for **month grid**, **quarter grid**, and the **today line**
- **Download PNG** exports the chart at 2× resolution for slide decks / screenshots, named after the workspace
