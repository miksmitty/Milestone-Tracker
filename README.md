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
id,ref,title,description,swimlane,subswimlane,owner,start,end,status,shape,parent,depends_on
```

- **id**: the **primary key** — a positive integer assigned automatically, unique, never changed and never reused. `parent` and `depends_on` reference ids, so they map directly onto a foreign key / join table when the data moves to a database
- **ref**: your own human-facing reference, e.g. `4.1`, `5.6` (shown on the chart; duplicates are flagged; "Sort by ref" orders 4.2 before 4.10)
- **start / end**: `YYYY-MM-DD`. If start = end the item is a **milestone** (drawn as a shape); if start < end it is a **task** (drawn as a bar)
- **status**: `Green` | `Amber` | `Red` | `Complete` (blue) | `Not Started` (grey)
- **shape**: `diamond` | `circle` | `square` | `triangle` (milestones only)
- **swimlane / subswimlane**: free text — each distinct value becomes a lane / nested sub-lane
- **parent**: id of the milestone this item rolls up to (the milestone can't fall before it finishes)
- **depends_on**: `;`-separated ids this item depends on (finish-to-start)

Changing an item's end date in the **Items** screen shifts everything downstream of it by the same number of days; anything that would then start before a predecessor finishes is pushed later. Circular dependencies are rejected. The old `name,date,rag` CSV format still loads.

Edit items in the app — in the **Items** table or by clicking an item on the chart. Every change saves to the CSV automatically. In the table, click a column header to sort (▲ / ▼ / off), use the filter row to narrow the list, and drag a header edge to resize a column (double-click to reset); sort and column widths are remembered per browser and never change the CSV order. You can also edit the CSV in a spreadsheet tool; hit *Reload* in the app afterwards.

## Gantt chart

- Swimlanes with alternating backgrounds and colour accents
- Swimlanes with nested sub-swimlanes
- Milestones drawn as status-coloured shapes, tasks as bars, with title, dates and owner; overlapping items stack automatically
- Dependency arrows and dashed roll-up arrows (toggle with **Dependencies**)
- **Row height** slider — below 40px the dates/owner line under each item is hidden for a compact view
- Hover an item for a summary card; **click it to edit** (or **+ Add** for a new one)
- Zoom: −/+ buttons, slider, and **Fit** (auto-fits until you zoom manually)
- Date range pickers with **Auto** reset to fit all milestones
- Toggles for **month grid**, **quarter grid**, and the **today line**
- **Download PNG** exports the chart at 2× resolution for slide decks / screenshots
