# Tracker

A simple, zero-dependency tracker for one or more workspaces: define milestones and tasks in a CSV-backed editor, view them on a visually rich Gantt-style timeline, and collect periodic status reports.

## Run

```bash
node server.js
```

Then open http://localhost:3100 (set `PORT=xxxx` to use another port).

No `npm install` needed — plain Node (18+) and vanilla JS.

Always open the app through `node server.js`: it serves both the page and the CSV data, so opening `index.html` as a file or from another web server won't load anything. It works behind a proxy that serves it under a path (e.g. `https://host/proxy/3100/`), and reads CSVs re-saved by Excel (semicolon separated, Windows encoding or with a byte order mark); they are written back as UTF-8 CSV. If data doesn't load, the app shows why and can't be edited until it does (so a half-loaded page never saves over your files); the server's console says more. After updating the app, restart `node server.js` so it knows about any new data files.

**Backups:** the first time each CSV is saved on a given day, the server copies the day's starting version to `backups/` (e.g. `backups/reports.2026-09-29.csv`), keeping the newest 30 per file. To undo a bad day, copy one back over the CSV and reload.

## Title and logo

`config.json`, next to `server.js`, sets the name shown at the top of the menu and in the browser tab, and an optional logo:

```json
{
  "title": "Tracker",
  "logo": "logo.png"
}
```

- **title**: the app's name (default *Tracker*). Leave it empty (`""`) to show only the logo.
- **logo**: an image file (PNG, JPG, SVG, GIF or WebP), as a path relative to `config.json`, or a web address (`https://…`). It replaces the red diamond at the top of the menu, 28px tall and as wide as its shape needs. Leave it empty for the default mark.

Changes show when the page is reloaded; there's no need to restart the server. If the file is missing, the defaults are used.

## Workspaces

Everything belongs to a **workspace**. The left-hand menu has **Program overview**, **All workspaces**, a workspace switcher, and the current workspace's **Gantt chart**, **Items**, **Reports**, **Swimlane overview** and **Workspace settings**. Collapse the menu to icons with **Collapse** at the bottom; the app remembers the open workspace, view and menu state per browser.

**All workspaces** shows a card per workspace: its RAG, code, program number, owner and area lead, trend, timeline, last report, a RAG breakdown of its items, its milestone overview and counts. Click a card to open it, **Edit** to change it, or **+ New workspace**. A workspace has:

- **Name** (required, unique), **Program number** (optional, unique, e.g. `101`), **Code** (e.g. `PLT`, shown beside the name), **Description**
- **Owner**, **Area lead**, **Overall RAG** and **Trend** (Improving, Stable or Declining)
- **Planned start / end**: optional; if blank, the card shows the span of the workspace's items
- **What does this workspace call things?**: the word for everything (default *Item*), for a single-date item (default *Milestone*) and for one with a date range (default *Task*). For example *Work item*, *Deliverable* and *Task*. The menu, buttons, badges, filters, legend and messages use these words; plurals are worked out automatically

### Program overview

**Program overview** lists every workspace as a program in a table, one row per program, in program number order:

- **Program no.**, **Program** (click to open its Gantt chart; its overall RAG is shown underneath) and **Area lead**
- **Previous weekly RAG** and **Current weekly RAG**: from the two most recent weekly updates, with their week-ending dates. The date turns red when there's no update for this week yet
- **Trend**, shown as an arrow (↑ improving, → stable, ↓ declining; hover for the word), and the **summary of last week's progress** (key points for management) from the latest update
- **Milestones overview**: the program's milestones counted as **Not started**, **Green**, **Red/Amber**, **Closed** and **Total**. Done statuses (named or described as complete) are Closed, statuses that need a get to green plan (Amber and Red as standard) are Red/Amber, the default status is Not started, and anything else counts as Green, so the four add up to the total. A totals row sums every program

**Update** on a row records that program's weekly update: the week ending (defaults to this Friday), the weekly RAG, trend, summary (with formatting) and area lead. If the week already has an update it's opened for editing; a new one starts from last week's RAG, and the previous update is shown for reference. The trend is suggested from the change in RAG since last week until you pick one; the trend and area lead are saved to the workspace. **Download CSV** saves the table.

### Swimlane overview

**Swimlane overview** is the same table for the current workspace, one row per swimlane in the order the Gantt chart lists them: **Swimlane** (click to show just that swimlane on the Gantt chart), **Area lead**, **Previous / Current weekly RAG**, **Trend**, the **summary** and the **milestones overview** of that swimlane's milestones, with a totals row that matches the program's. Each swimlane has its own weekly updates, area lead and trend, recorded with **Update** exactly as for a program. Swimlanes are matched by name, so renaming one starts it afresh.

Weekly updates live in [updates.csv](updates.csv), one row per program or swimlane per week (`swimlane` is blank for the program itself):

```
id,workspace_id,swimlane,week_ending,rag,summary,author,created,updated
```

A swimlane's area lead and trend live in [swimlanes.csv](swimlanes.csv), created the first time one is set:

```
workspace_id,name,lead,trend
```

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
id,number,name,code,description,owner,lead,start,end,rag,trend,item_term,milestone_term,task_term,created,updated
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

- **Gantt chart**: click (or right-click) an item to open the quick update panel. Change its RAG, switch it between milestone and task, or change its dates, then **Save** (or Enter) — nothing changes until you do, and **Cancel** / Esc throws the changes away. Switching the type back and forth keeps both dates, and moving a milestone's date keeps the task's length if you switch back. Clicking away with unsaved changes gives the panel a nudge instead of losing them. The panel says how many dependent items will move. From there you can also *Provide report*, see its *Reports* or *Edit details…* for everything else.
- **Items tab → Quick update** (the default view): ref, title, type, owner, RAG and dates, all editable. Click a RAG to set it, or edit any cell. Switch to **All fields** for lanes, links, shape and so on.
- The quick update panel on the chart also has a **Type** switch.

### Importing

**Items → Import…** brings a list of milestones and tasks into the current workspace, from a CSV file (comma, semicolon or tab separated; UTF-8 or Excel's Windows encoding) or from cells copied out of Excel or Sheets and pasted in. Excel workbooks can't be read directly: save as CSV, or copy and paste.

- **Columns** are matched to fields by their headings (e.g. *WBS* → Ref, *Task Name* → Title, *Finish* / *Due* → End date, *Status* → RAG, *Assigned To* → Owner, *Workstream* → Swimlane, *Predecessors* → Depends on), and each can be changed or left out. `workspace_id` is ignored: everything goes into the workspace you're in
- **Dates** can be written almost any way: `2026-03-31`, `31/03/2026`, `3/31/2026`, `31.03.26`, `31-Mar-26`, `31 March 2026`, `March 31, 2026`, `Tue 31st March 2026`, `20260331`, Excel date numbers, with or without a time. Whether `03/04/2026` is 3 April or 4 March is detected from the file (any day over 12 gives it away), otherwise it follows the browser's locale; you can override it. Each date column shows how its examples will be read
- **Type**: a type column (*milestone* / *task*, the workspace's own words, or yes/no from a *Milestone?* column), otherwise a start before the end makes a task and a single date a milestone
- **What to do**: *Add new, update matching refs* (the default), *Add all as new*, or *Replace all*, which also deletes items that aren't in the file (their reports are kept). Blank cells leave an existing item's value alone; a filled *depends on* cell replaces its dependencies
- **Links** (rolls up to, depends on) name items by their **ref** (e.g. a parent of `4` rolls up to the item with ref 4, whether it's in the file or already in the workspace), separated by `;` `,` or spaces; MS Project style `3FS+2d` works too. Links that would make a circular dependency are left out
- A **preview** shows every row as Add, Update, No change or Skip, with notes on anything it couldn't read (an unreadable date, a RAG the workspace doesn't use, an unknown link, a repeated ref). Nothing changes until you click **Import**

A file from **Download CSV** imports straight back in, matched on ref (or id, as its links are ids), so you can edit a workspace's items in a spreadsheet and bring them back.

Edit items in the app — in the **Items** table or by clicking an item on the chart. Every change saves to the CSV automatically. In the table, click a column header to sort (▲ / ▼ / off), use the filter row to narrow the list, and drag a header edge to resize a column (double-click to reset); sort and column widths are remembered per browser and never change the CSV order. You can also edit the CSV in a spreadsheet tool; hit *Reload* in the app afterwards.

## Reports

Owners provide a regular status report on any milestone or task. **Click an item on the Gantt chart → Provide report**, or use **Report…** on the Items tab. The form has:

- **Cadence**: Weekly, Fortnightly or Monthly, plus the **period ending** date. It defaults to the coming Friday, or to month end for monthly reports. The period covered is worked out from these two.
- **RAG this period**: Green / Amber / Red / Complete / Not Started. It defaults to the item's current RAG. If you change it on the item's latest report, you can update the item's RAG on the chart at the same time.
- **Exec summary** (required), **Achievements last period**, **Next steps**
- **Get to green plan**: only shown for, and required by, Amber and Red reports
- **Reported by**: defaults to the item's owner

The exec summary, achievements, next steps and get to green plan are **formatted text**. Use the toolbar or ⌘/Ctrl+B, I and K for bold, italic and links (plus strikethrough), and bulleted or numbered lists; typing `- `, `1. ` or `> ` at the start of a line starts a list or quote, Tab / Shift+Tab nest a list item, Enter starts a new paragraph and Shift+Enter a new line. Pasted text keeps any Markdown formatting it has, and never brings in other HTML. Behind the scenes the text is stored as **Markdown** in reports.csv (and the CSV download), so it reads cleanly in a spreadsheet; click **Markdown** on a box to see and edit that text directly (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `#` headings, `- `/`1. ` lists, `> ` quotes, `[links](https://…)`, and `\` to keep a character literal). The Reports list shows the exec summary as plain text.

The item's previous report is shown in a panel beside the form while you write the new one, with ‹ › to step back through older reports. Its sections can be copied across: last period's *next steps* into this period's *achievements*, the *exec summary*, or the *get to green plan* (carried forward). You can only have one report per item per period; if one exists, you'll be offered a link to open it.

The **Reports** tab lists every report in the current workspace, newest period first. Like the Items grid, click a header to sort, use the filter row (item, RAG, cadence, text…) to narrow the list, and drag a header edge to resize a column; the toolbar search looks through every report field. **View reports** in the item's edit dialog, the quick update panel and the report form jumps here filtered to that item. Select a report to read it in the **preview** beside the list, and use **↑ ↓** to move through the list, like previewing files in a folder. Click into the preview (or press **Enter**, or double-click the row) to edit the report in place: **Save** (⌘/Ctrl+Enter) or **Cancel** (Esc). Moving to another report saves your edits if they're complete, and otherwise asks before discarding them. **Delete** is there too. If some reports belong to items that no longer exist (shown as *Deleted item #…*), **Delete N reports on deleted items** in the toolbar clears them all at once. Drag the divider to resize the list; double-click it to reset. Untick **Preview** to use the full-width list, where clicking a report opens it in the report form. Edits are tracked with `created` / `updated` timestamps. **Download CSV** saves the reports currently listed (filters applied) with the item's `ref` and `title` added for readability.

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
- Each task shows its duration in days after its title (e.g. **24d**, counting start and end day)
- Each milestone with tasks rolling up to it shows its **% complete**: the share of those tasks' total duration that is at a complete RAG (a status named or described as Complete / Done). Tasks rolling up through other milestones count too, and the hover card shows the days and tasks behind it
- Dependency arrows and dashed roll-up arrows (toggle with **View → Dependencies**)
- **View → Row height** — below 40px the dates/owner line under each item is hidden for a compact view
- Hover an item for a summary card (including its last report); **click it** to update its RAG or dates, provide a report, see its reports or edit its details (**+ Add** for a new item)
- The chart fills the window below its toolbar and scrolls inside its own panel
- One toolbar: **Search**, **Filter**, **Sort** and **View** menus on the left; the date range, zoom and actions on the right
- Timescale, as in MS Project: **Quarters** (quarters over months, fitted to the window), **Months** (months over weeks) or **Weeks** (weeks over days, with day names). Months and Weeks open scrolled to today, weekends are shaded once days are wide enough, and the choice is remembered per browser
- The swimlane column and the timescale header stay pinned while the chart scrolls
- Zoom: − **Fit** + (auto-fits until you zoom manually), with a finer slider under **View**; header labels shorten to fit as you zoom
- The date range button shows the months in view; open it to pick dates, or **Fit to items** to fit the range to everything shown
- **Search** by ref, title, description, owner or swimlane, and **Filter** by swimlane, owner, type and RAG (pick one or more). Active filters show as chips under the toolbar, each with ✕ to remove it, with a count of what's shown and **Clear all**. Dependency arrows to hidden items are left out, and filters reset when you switch workspace
- **Sort** swimlanes A–Z (the default), as listed, by earliest start, by latest end, or most at risk first (most items at an off-track RAG). Items are packed several to a row by date, or choose one per row sorted by start, end, ref, title, RAG or owner, ascending or descending. A dot on **Sort** shows it's changed from the default, and the sort is remembered per browser
- **View** toggles the **top** and **bottom timescale**, **today line** and **dependencies**
- **Download PNG** exports the chart at 2× resolution for slide decks / screenshots, named after the workspace
