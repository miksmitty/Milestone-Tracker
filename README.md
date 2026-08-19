# Milestone Tracker

A simple, zero-dependency milestone tracker: define milestones in a CSV-backed editor and view them on a visually rich Gantt-style timeline.

## Run

```bash
node server.js
```

Then open http://localhost:3000 (set `PORT=xxxx` to use another port).

No `npm install` needed — plain Node (18+) and vanilla JS.

## Data

Milestones live in [milestones.csv](milestones.csv) with columns:

```
name,description,rag,date,shape,swimlane
```

- **rag**: `Green` | `Amber` | `Red` (controls milestone colour)
- **date**: `YYYY-MM-DD`
- **shape**: `diamond` | `triangle` | `square`
- **swimlane**: free text — each distinct value becomes a horizontal lane

Edit the CSV in the app's **Milestones** screen (add / delete / sort rows, then *Save to CSV*), or in any spreadsheet tool — hit *Reload* in the app afterwards.

## Gantt chart

- Swimlanes with alternating backgrounds and colour accents
- Milestones drawn as RAG-coloured diamonds / triangles / squares with name + date labels; overlapping items stack automatically
- Zoom: −/+ buttons, slider, and **Fit** (auto-fits until you zoom manually)
- Date range pickers with **Auto** reset to fit all milestones
- Toggles for **month grid**, **quarter grid**, and the **today line**
- **Download PNG** exports the chart at 2× resolution for slide decks / screenshots
