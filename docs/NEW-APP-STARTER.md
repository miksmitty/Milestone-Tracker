# New app starter: build another app in the Tracker's style

**How to use this file.** Start a new, empty project folder, copy this file into it (or point Claude at it), fill in the **"About the new app"** section below, and tell Claude: *"Read NEW-APP-STARTER.md and build the app it describes, following the Tracker's conventions."* Everything after that section is the standing spec: stack, data layer, look and feel, and the shared grid behaviour. It was written from the Milestone Tracker in this repository (`server.js`, `public/app.js`, `public/styles.css`); where this file and that code differ, the code is the reference.

---

## About the new app (fill this in)

- **Name and purpose:** _one or two sentences_
- **Who uses it and how often:** _e.g. a PMO of five people, weekly_
- **What the main records are:** _e.g. suppliers, contracts, invoices. For each: its fields and which are required_
- **How records relate:** _e.g. an invoice belongs to a contract; a task rolls up to another task_
- **Does it need workspaces?** _Yes = every record belongs to a workspace (project, team, client) chosen in the sidebar, as in the Tracker. No = one flat data set._
- **Pages wanted:** _e.g. Dashboard, Records (grid), Calendar, Reports_
- **Special views:** _timeline, board, charts… (the grid, forms and shell are covered below and should not need describing again)_
- **Import / export needs:** _what files people bring in from Excel, what they export_
- **Anything that must differ from the Tracker:** _accent colour, terminology, no dark mode…_

---

## 1. Principles

1. **Zero dependencies.** Plain Node 18+ on the server (`http`, `fs`, `path`, `crypto` only), vanilla JavaScript in the browser, no framework, no bundler, no `npm install`. `package.json` has a name, version and a `start` script and nothing else. Run with `node server.js`.
2. **Data is plain CSV files** next to the server (or in `DATA_DIR`), readable and editable in Excel. No database.
3. **One screen of truth.** The page never shows a half-loaded state it could then save over the files: if data fails to load, show why and disable editing.
4. **Autosave, with Undo.** There is no Save button on grids. Edits save automatically; deletes, imports, bulk changes and one-click changes happen straight away and a toast offers **Undo**.
5. **Several people at once.** Saves are versioned and merged field by field; changes appear for everyone within moments (section 3).
6. **Every grid is a spreadsheet-style grid** (section 6), built on one shared helper. Never ship a plain `<table>` with a `<th>` list. This is a standing rule.
7. **People first.** Plain words, the workspace's own terminology where it is configurable, empty states that say what to do next, no jargon in the UI.
8. **Accessible by default.** Real buttons and labels, visible focus (`outline: 2px solid var(--accent)`), `aria-pressed` / `aria-label` where there is no text, respects `prefers-reduced-motion`, works at phone width.

## 2. Project layout

```
server.js            the whole backend (static files + CSV API + events)
package.json         name, version, "start": "node server.js"
config.json          { "title", "logo", "environment", "environmentColor" }
public/index.html    all page markup: shell, every view, every dialog (hidden until used)
public/app.js        all behaviour, one file, in sections (see below)
public/styles.css    all styling, using the tokens in section 4
<records>.csv        one file per record type, created with its header on first run
ids.json             last id issued per file
backups/             one copy of each CSV per day, newest 30 kept
README.md            how to run, deploy, the data files and their columns
```

`app.js` is organised in banner-commented sections in roughly this order: constants and palettes; CSV parse/write; load/save and the merge logic; undo; the shared grid helper (`makeTable` and friends); each page's render function; dialogs; import; export; the Find palette; start-up wiring.

## 3. Data layer and server

**Files.** Each record type is one CSV with a fixed header, listed in a `DATASETS` map in `server.js` (`'/api/<name>'` → file, header). A missing file is served as its header alone. Every record has a numeric `id`; records in a workspace-based app also carry `workspace_id`. References between records store ids; columns holding several values use `;` (e.g. `depends_on` = `4;7`).

**Endpoints** (all matched on the *end* of the path, so the app works behind a proxy that serves it under a prefix):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/<name>` | the CSV text and its version |
| `POST /api/<name>` | save the whole file. Header `X-Base-Version` names the version the save was based on; if the file has changed since, reply **409** `{ conflict: true, version, text }` and write nothing |
| `GET /api/events` | server-sent events: a `versions` event whenever any file changes (through the app *or* by editing the CSV on disk) |
| `GET /api/versions` | current version of every file (used as a fallback poll every 20 s and when the tab regains focus) |
| `POST /api/ids?file=<name>&n=20` | reserve ids; the server is the only issuer, so two people adding at once can't collide; last issued kept in `ids.json` |
| `GET /api/config`, `GET /api/logo` | title, logo, environment band and version from `config.json` / env vars |

**Client rules.**
- On a 409, merge the server's file with the local one *record by record and field by field* (only fields the user changed win over the server's copy), then save again. If the same field was changed by both, keep the first save and show **"Someone else changed the same things"** with **Use mine** to put the user's change back; same for delete-vs-edit.
- Forms save only the fields the user changed, so a stale open dialog never overwrites someone else's edit.
- **Undo** restores only the user's own change, not changes made since by anyone.
- New ids come from `/api/ids`, reserved a few at a time.
- CSV reading tolerates what Excel produces: comma / semicolon / tab separated, UTF-8 or Windows-1252, a BOM, quoted cells with line breaks. Writing is always UTF-8 with `,`.
- Older files missing newer columns must still load (default the column), so the schema can grow without migrations.
- **Daily backup**: the first save of a CSV each day copies the day's starting version to `backups/<file>.<YYYY-MM-DD>.csv`, keeping 30 per file.
- **Audit log** (optional but recommended for anything that has dates or money): an append-only `<thing>-changes.csv` (id, at, by, who/what changed, field, from, to, how). The server writes it by comparing each save with the file it replaces, so no code path can skip it.
- Run **one** server process; document this in the README.

**Configuration.** `config.json` (read on every request, so edits show on reload without a restart): `title`, `logo` (path or URL, 28 px tall in the menu), `environment` (e.g. *Test*, shows a coloured band across the top of every page and a badge by the name; empty on live), `environmentColor`. Environment variables `PORT`, `DATA_DIR`, `APP_ENVIRONMENT`, `APP_ENVIRONMENT_COLOR`, `APP_VERSION` override. Version comes from `package.json`.

**Deployment** (document it in the README): runs on Azure App Service (Linux, Node 18+, startup `node server.js`, `DATA_DIR=/home/data`, instance count 1, Always On) as-is.

## 4. Look and feel

Warm off-white pages, white panels, a near-black sidebar, one red accent. Quiet, dense, spreadsheet-like. System font stack, no webfonts.

### 4.1 Design tokens

Define every colour as a CSS variable on `:root`, redefine for dark under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` **and** under `:root[data-theme="dark"]`, so the theme switch (Auto / Light / Dark, remembered per browser) works. Give `body` an explicit `background: var(--bg)` and `color: var(--text)`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f4f3ee` | `#161615` | page background |
| `--panel` | `#ffffff` | `#1f1f1d` | cards, toolbars, grids, dialogs |
| `--panel-2` | `#f9f8f5` | `#252523` | table heads, quiet fills |
| `--hover` | `#f4f3ee` | `#2c2c29` | hover on menu items |
| `--row-hover` | `#fcfbf8` | `#262624` | grid row hover |
| `--chip` | `#ecebe4` | `#31312d` | segmented-control track, chips |
| `--line` | `#f4f3ee` | `#2a2a27` | rules between grid rows |
| `--border` | `#e0ded6` | `#3a3a36` | panel and input borders |
| `--text` | `#1c1c1c` | `#ecebe4` | body text |
| `--text-2` | `#404040` | `#cfcdc4` | secondary text |
| `--muted` | `#7a7870` | `#9a988d` | labels, helper text |
| `--muted-2` | `#5a5d5c` | `#b3b1a6` | |
| `--faint` / `--faint-2` | `#cccabc` / `#a8a69c` | `#5d5c55` / `#7a7870` | disabled, placeholder, glyphs |
| `--accent` | `#e60000` | `#ff4d4d` | primary buttons, focus, selection, active icons |
| `--tint`, `--tint-2`, `--tint-border` | `#fdecec`, `#fdf3f3`, `#f5c2c2` | `#3a1d1d`, `#2d1c1c`, `#6b2a2a` | red-tinted fills: selected rows, delete hover, duplicate-flag |
| `--warn`, `--warn-bg`, `--warn-border` | `#b45309`, `#fffbeb`, `#fde68a` | `#f0b45a`, `#2d2414`, `#5c4512` | warnings |
| `--ok`, `--ok-bg` | `#15803d`, `#dcfce7` | `#4ade80`, `#163222` | success |
| `--info`, `--info-bg` | `#134a7a`, `#dcebf7` | `#8ec2ee`, `#1a2c3d` | information |
| `--flash` | `#fef9c3` | `#3d3a14` | brief highlight of a row that just changed |
| `--env` | `#b45309` | | environment band |

Sidebar and toast are fixed dark in both themes: background `#1c1c1c`, text `#e0ded6` / `#cccabc`, muted `#8e8d83`, hover `#2c2c2a`, rules `#3a3a38`. The active nav item is white with `#1c1c1c` text and an accent-coloured icon.

**Status (RAG) colours** are data, not theme: Green `#16a34a`, Amber `#f59e0b`, Red `#e60000`, Complete `#1f6fb2`, Not Started `#a8a69c` (default). Each status shows as a coloured pill (white text on the colour, `font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 1px 8px`) or, when it isn't the current one, a coloured dot. Statuses are configurable per workspace (name, colour, description, "needs a plan to get to green", default). Anything with an unknown status shows grey.

### 4.2 Type, shape, spacing

- Font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif`, antialiased.
- Sizes: body and grid cells 13 px; table heads 11 px uppercase, `letter-spacing: .06em`, `--muted`; page title 21–30 px weight 700–750, `letter-spacing: -0.015em` to `-0.025em`; helper text 12–12.5 px.
- Radii: panels and toolbars 12 px; buttons and inputs 8 px (grid cell inputs 5 px); pills 999 px.
- Shadows are faint: panels `0 1px 3px rgba(28,28,28,.07)`, popovers `0 12px 32px rgba(28,28,28,.16)`, toast `0 12px 32px rgba(0,0,0,.28)`.
- Focus: inputs get `border-color: var(--accent)` and `box-shadow: 0 0 0 3px rgba(230,0,0,.12)`; other controls `outline: 2px solid var(--accent); outline-offset: 1px`.
- Page padding 14–20 px (12 px under 600 px wide).

### 4.3 App shell

- **Layout:** `.app` is a full-height flex row: a 232 px **sidebar** and a flexible **main** that scrolls. Optional full-width **environment band** above everything.
- **Sidebar:** brand (logo or a red diamond mark, app name 21 px bold white, environment badge) then **Find… ⌘K**, then nav groups separated by a rule and a small uppercase label (*Portfolio*, *Workspace*, *History*…). Nav item: 19 px stroke icon + 13.5 px semibold label, 9×10 px padding, 8 px radius. In the workspace group, a **workspace switcher** (coloured RAG dot, name, ⚙ settings) sits above the page links. Badges on links show counts (red when something is overdue). At the foot: **Theme** (Auto/Light/Dark), the version, and two arrows: **‹** collapses the menu to a 64 px icon rail (workspace code under its dot), **«** hides it entirely (a **Menu** button then appears in the page header). Under 760 px wide it is always the icon rail. The app remembers workspace, page, theme and menu state per browser.
- **Page header:** `PLT Platform Replacement / Items`: workspace code in a small red-tinted tag, workspace name large, a `/`, then the page title lighter, then a **?** button that opens a short "what this page is for" popover. A right-aligned save status (*Saved* green, error red).
- **Toolbar** under the header on every page, one white rounded panel: **what to look at on the left** (mode switch, search box, filters, count) and **what to do on the right** (the primary action as a red `btn-primary`, **Import…**, an **Export ▾** menu for CSV / PNG / copy). Wraps responsively; actions go full width on phones.
- **Buttons:** `.btn` white, 1 px `--border`, 8 px radius, 13 px semibold, hover `--panel-2`; `.btn-primary` red with white text (hover `#bd000c`); `.btn-ghost`; `.btn-danger` red text with tint hover; `.btn-sm` smaller. A **segmented control** (`.mode-seg`: `--chip` track, white selected segment with a faint shadow) switches modes such as *Quick update / All fields*.
- **Dialogs:** native `<dialog>` for forms, headed with the action and the record (*New item*, *Edit 2.1 Solution Architecture*), Save primary, Cancel, Delete on the left (danger) when editing, an inline error line (never an alert). Esc cancels; clicking outside does **not** close an edit dialog. Quick-edit **side panels** open beside what was clicked.
- **Toast** (bottom centre, dark): the message, **Undo**, close. Used after every immediate change.
- **Find palette (⌘K / Ctrl+K):** one box that jumps to any record in any workspace or any page; every word typed must match; refs and title starts rank first; ↑ ↓ Enter.
- **Deep links:** the address bar holds the workspace, page and filters (`#/ws/1/items`, `#/ws/1/gantt?stream=Delivery&rag=Red`) so a view can be bookmarked or sent.
- **Empty states** say what to do (*No items in this workspace yet. Use + Add item to create one.*). A **filtered-to-nothing** state says so and offers **Clear filters**.

## 5. Workspaces (if the app has them)

Everything belongs to a workspace (`workspaces.csv`: id, number, name, 2–4 letter `code`, description, owner, lead, dates, RAG, trend, the workspace's own words for things, option lists, hidden). A **Portfolio** page lists all workspaces as a grid or as cards. Workspace settings let each workspace rename its terms (e.g. *Item / Milestone / Task* → *Work item / Deliverable / Task*) and edit its own status list; **all labels read the workspace's terms**, never hard-coded words. Find and the portfolio span workspaces; everything else is scoped to the current one. If the new app has no workspaces, drop the group and the switcher and keep the rest.

## 6. Grids (the most important shared part)

All grids come from one helper, `makeTable({ table, store, cols, rows, onChange, mode })`, plus `renderTableHead`, `wireTable`, `passesFilters`, `sortRows`. Build every list this way. The Items, Reports, RAID and Actions lists do (the Meetings and Series lists predate the rule and haven't been moved onto it yet; don't copy them).

### 6.1 Every grid has

1. **Resizable columns.** A `<colgroup>` with one `<col>` per column, `table-layout: fixed`. Drag the right edge of a heading to resize (a tooltip shows the width). Widths are remembered per grid, per browser (`localStorage` key = the `store` option).
2. **Excel-style sort and filter on every heading.** A **▾** button on each heading opens a menu: *Sort A to Z / Z to A* (wording follows the column kind: *oldest to newest* for dates, *smallest to largest* for numbers, *in RAG order* for status), **Filter…**, *Autofit column width*, *Distribute columns evenly*, *Fit all columns to window*, *Reset column widths*, *Reset column order*. **Filter…** opens a popover with a search box and a tick-list of the column's distinct values (with *(Blanks)*, a column-specific blank label such as *(None)*, and *Select all*), OK / Cancel. A filtered heading shows an accent-tinted ▾ / funnel. Several filters combine with AND. A multi-valued column (e.g. dependencies) filters on any of its values.
3. **A "Clear filters" button** in the toolbar, shown only while a filter is active, and a count that reads *Showing 12 of 40* when filtered.
4. **Column move.** Drag a heading to reorder; click to select a column, shift/ctrl-click to select several, then resize or autofit them together. Column order is remembered per grid and per mode; fixed columns (checkbox, actions) stay at the ends.
5. **Sticky header** (`position: sticky; top: 0`) and the grid scrolls inside a window-high box so the sideways scrollbar is always on screen. Header: 11 px uppercase on `--panel-2`; cell borders `--line` between rows and `--border` between columns; the last column has no right border.
6. **Row selection** where bulk actions exist: a checkbox column (fixed, 36–66 px) with a *select all shown* box in the heading, shift-click for a range. Selected rows get `--tint-2`. Only rows on screen stay selected, so a bulk action never reaches something filtered out of view.

### 6.2 Column definition

Each column: `{ key, label, w, kind, show, order, blank, vals, fixed, wkey, head, title }`.

- `kind`: `'date' | 'number' | 'status'` (default text); controls sort wording and comparison (status sorts in the status list's order, numbers numerically, text with `localeCompare(…, { numeric: true, sensitivity: 'base' })`).
- `vals(row)`: the value(s) used for filter and sort when they aren't `row[key]`; `show(v)`: how a value reads in the filter list; `order`: custom comparator for filter-list order; `blank`: label for empty.
- Blank values always sort **last**, whichever direction.
- A `mode` option lets one grid offer different column sets (e.g. **Quick update** = just RAG and dates; **All fields**); each mode keeps its own widths and column order.

### 6.3 Editable grids (like Items)

- **Cells are inputs.** Text, date (with the app's date picker upgrade), select, URL, chips-with-add for multi-value links. Inputs are borderless until hover (`border-color: var(--border)`) and show the accent focus ring when focused. Wrap nothing; truncate.
- **Rows stay put while editing, like a spreadsheet.** An edited row doesn't jump to its new sort position or vanish from a filter. New rows go at the bottom. Sorting, filtering, switching mode or view puts everything back in order. (Implementation: remember the shown order and the set of known ids; re-render with `keepOrder`.)
- **Don't clobber focus.** Updating a cell only touches cells whose HTML changed, and a cell holding the focus keeps its control, so typing carries on undisturbed.
- **Status as one-click pills** in the compact mode: the current status as a pill, the rest as dots; click a dot to set it.
- **Dates:** invalid or half-typed dates are ignored until complete; date cells flag overdue in red (`late`) and clashes with a tinted outline.
- **Duplicate flag:** a duplicated `ref` gets a `--tint` fill and `--tint-border` border and a title saying so.
- **Fill handle:** a small accent-coloured square at the bottom-right of the selected cell; drag down to copy the value into the cells below (cursor `crosshair`).
- **Bulk bar:** when rows are ticked, a bar offers *Change field…* (with the new value), *Dates: move by N days*, *Delete*, and shows how many rows it will affect and how many it skipped and why. One Undo restores all.
- **Per-row actions** in the last (fixed) column: ✕ delete in All-fields mode, a context button (e.g. *New report*) in Quick mode. Deleting asks nothing but offers Undo.
- **Hierarchy (parent/child lists).** If records can roll up to another record, add a *Show hierarchy* switch in the toolbar (on by default, remembered): each record sits directly under the one it rolls up to, the title indented 30 px per level with a `↳` connector, parents in bold, only *shown* records count as ancestors (a filter that hides a parent leaves its children as tops of their own branches), siblings follow the current sort, and a roll-up loop can't hang the render. A **＋** button in the checkbox column of every eligible parent row opens the New dialog already set as a child of it; saved, it lands directly under that parent. Changing a row's parent moves it under the new parent at once.

### 6.4 Read-only and list grids

Same helper, no inputs: cells are text, pills and links; clicking a row opens the record (an edit dialog, or a reading pane beside the list); dates in red when overdue; counts in the toolbar. Lists that mix grouping (e.g. items grouped by month) still keep the heading sort/filter/resize.

### 6.5 Persistence

`localStorage` per grid (`<app>.<grid>`): `{ sort, widths, mode, order, tree }`. Wrap every read and write in `try/catch`; the grid must work with storage blocked.

## 7. Import and export

- **Export ▾** on every list: *Download CSV* (names rather than ids for references, so people can read it; includes ids where re-import needs them), plus *Copy* (tab-separated, pastes straight into Excel) and *PNG* for charts. Exports respect the current filters. The export's column headings are the import's matching names.
- **Import…** accepts a CSV file or cells **pasted** from Excel/Sheets (no .xlsx parsing). A preview step shows each row as *new*, *updates*, *same* or *skipped* with the reason, lets each column be re-mapped, and nothing is written until confirmed; one Undo reverses the import.
- **Column matching is by heading**, forgiving (*WBS* → Ref, *Task Name* → Title, *Finish* → End, *Assigned To* → Owner…). Dates accept almost any written form (`2026-03-31`, `31/03/2026`, `31-Mar-26`, `31 March 2026`, Excel serials) with the day/month order guessed from the file and confirmable.
- Rows match existing records by id if present, else by ref, else by a natural key, so re-importing an export updates rather than duplicates.

## 8. Dashboards and charts (when the app has them)

Tiles and cards show counts and breakdowns; **every number is a way in**: clicking it opens the underlying records on the right page with the filters set. Charts are inline SVG using the same tokens (so they follow the theme), a single typeface, status colours for status, and PNG export that renders fully in the light theme. Use sequential or categorical palettes sparingly; the red accent is for action and alarm, not decoration.

## 9. Writing the README and in-app help

- A `README.md` documents: how to run; the data files and every column; how several people work together; deployment; configuration; each page in a short section. Keep it updated with every feature.
- Each page has a **?** note of two or three sentences about what the page is for and the one thing to know.

## 10. Build order for a new app

1. `server.js` with `DATASETS`, static serving, `/api/<name>` GET/POST with versions and 409, `/api/ids`, `/api/events`, `/api/config`, daily backups. Smoke test with `curl`.
2. `index.html` shell: sidebar, page header, toolbar, empty views; `styles.css` tokens and shell; theme switch; menu collapse.
3. Load/save/merge/undo core in `app.js`; toast; save status.
4. `makeTable` and one editable grid for the main record, with every behaviour in section 6.
5. The record dialog (new/edit/delete/duplicate) and import/export for that record.
6. Remaining record types and their grids, each on `makeTable`.
7. Workspaces/portfolio (if used), Find palette, dashboard, page help notes.
8. README, `config.json`, deployment notes.

## 11. Definition of done (check before saying a page is finished)

- [ ] Every grid has resizable columns, ▾ sort and filter on every heading, Clear filters, remembered widths.
- [ ] Works in light and dark, and at phone width (nothing scrolls the page sideways except inside a grid).
- [ ] Keyboard: Tab order sensible, Esc closes popovers and dialogs, Enter saves forms, focus ring visible.
- [ ] Every change that happens immediately shows a toast with a working Undo.
- [ ] Two browsers editing different fields of one record both keep their changes; a clash shows the *Someone else changed the same things* message.
- [ ] A CSV edited in Excel (semicolons, BOM, Windows encoding) loads; an old file missing new columns loads.
- [ ] Empty, filtered-to-nothing and error states are written and tested.
- [ ] No hard-coded workspace terms; labels come from the workspace's settings.
- [ ] Verified in a browser (console clean, interactions tried), not just by reading the code.
- [ ] README updated.
