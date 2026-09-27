# Milestone Tracker

A simple, zero-dependency milestone tracker: define milestones in a CSV-backed editor and view them on a visually rich Gantt-style timeline.

## Run

```bash
node server.js
```

Then open http://localhost:3000 (set `PORT=xxxx` to use another port).

No `npm install` needed — plain Node (18+) and vanilla JS.

## Data

Items live in [milestones.csv](milestones.csv) with columns:

```
id,ref,title,description,swimlane,subswimlane,owner,start,end,rag,shape,parent,depends_on
```

- **id**: the **primary key** — a positive integer assigned automatically, unique, never changed and never reused. `parent` and `depends_on` reference ids, so they map directly onto a foreign key / join table when the data moves to a database
- **ref**: your own human-facing reference, e.g. `4.1`, `5.6` (shown on the chart; duplicates are flagged; "Sort by ref" orders 4.2 before 4.10)
- **start / end**: `YYYY-MM-DD`. If start = end the item is a **milestone** (drawn as a shape); if start < end it is a **task** (drawn as a bar)
- **rag**: `Green` | `Amber` | `Red` | `Complete` (blue) | `Not Started` (grey). Files with the older `status` column still load
- **shape**: `diamond` | `circle` | `square` | `triangle` (milestones only)
- **swimlane / subswimlane**: free text — each distinct value becomes a lane / nested sub-lane
- **parent**: id of the milestone this item rolls up to (the milestone can't fall before it finishes)
- **depends_on**: `;`-separated ids this item depends on (finish-to-start)

Changing an item's end date in the **Items** screen shifts everything downstream of it by the same number of days; anything that would then start before a predecessor finishes is pushed later. Circular dependencies are rejected. The old `name,date,rag` CSV format still loads.

RAG and dates change far more often than anything else, so they are the quickest to update:

- **Gantt chart**: click (or right-click) an item to open the quick update panel. Click a RAG to change it; change the dates and hit *Update dates* (the panel says how many dependent items will move). From there you can also *Provide report*, see its *Reports* or *Edit details…* for everything else.
- **Items tab → Quick update** (the default view): just ref, title, owner, RAG and dates. Click a RAG to set it, or edit a date. Switch to **All fields** to change titles, lanes, links, shape and so on.

Edit items in the app — in the **Items** table or by clicking an item on the chart. Every change saves to the CSV automatically. In the table, click a column header to sort (▲ / ▼ / off), use the filter row to narrow the list, and drag a header edge to resize a column (double-click to reset); sort and column widths are remembered per browser and never change the CSV order. You can also edit the CSV in a spreadsheet tool; hit *Reload* in the app afterwards.

## Reports

Owners provide a regular status report on any milestone or task. **Click an item on the Gantt chart → Provide report**, or use **Report…** on the Items tab. The form has:

- **Cadence**: Weekly, Fortnightly or Monthly, plus the **period ending** date. It defaults to the coming Friday, or to month end for monthly reports. The period covered is worked out from these two.
- **RAG this period**: Green / Amber / Red / Complete / Not Started. It defaults to the item's current RAG. If you change it on the item's latest report, you can update the item's RAG on the chart at the same time.
- **Exec summary** (required), **Achievements last period**, **Next steps**
- **Get to green plan**: only shown for, and required by, Amber and Red reports
- **Reported by**: defaults to the item's owner

The item's previous report is shown in a panel beside the form while you write the new one, with ‹ › to step back through older reports. Its sections can be copied across: last period's *next steps* into this period's *achievements*, the *exec summary*, or the *get to green plan* (carried forward). You can only have one report per item per period; if one exists, you'll be offered a link to open it.

The **Reports** tab lists every report, newest period first. Like the Items grid, click a header to sort, use the filter row (item, RAG, cadence, text…) to narrow the list, and drag a header edge to resize a column; the toolbar search looks through every report field. **View reports** in the item's edit dialog, the quick update panel and the report form jumps here filtered to that item. Click any report to edit or delete it; edits are tracked with `created` / `updated` timestamps. **Download CSV** saves the reports currently listed (filters applied) with the item's `ref` and `title` added for readability.

Reports are stored in [reports.csv](reports.csv), one row per report:

```
id,item_id,cadence,period_start,period_end,rag,exec_summary,achievements,next_steps,get_to_green,author,created,updated
```

- **id**: the report's primary key (never reused)
- **item_id**: foreign key to the item's `id` in milestones.csv. Deleting an item keeps its reports.

## Gantt chart

- Swimlanes with alternating backgrounds and colour accents
- Swimlanes with nested sub-swimlanes
- Milestones drawn as RAG-coloured shapes, tasks as bars, with title, dates and owner; overlapping items stack automatically
- Dependency arrows and dashed roll-up arrows (toggle with **Dependencies**)
- **Row height** slider — below 40px the dates/owner line under each item is hidden for a compact view
- Hover an item for a summary card (including its last report); **click it** to update its RAG or dates, provide a report, see its reports or edit its details (**+ Add** for a new item)
- Zoom: −/+ buttons, slider, and **Fit** (auto-fits until you zoom manually)
- Date range pickers with **Auto** reset to fit all milestones
- Toggles for **month grid**, **quarter grid**, and the **today line**
- **Download PNG** exports the chart at 2× resolution for slide decks / screenshots
