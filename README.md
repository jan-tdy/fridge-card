# fridge-card

A modern Home Assistant Lovelace card for a fridge camera (esp32-cam) with
AI-recognized contents.

![type](https://img.shields.io/badge/type-lovelace--card-blue)

- Shows the latest fridge photo, with a fixed rotation set in the card
  config (0/90/180/270°) to correct a crooked camera mount, and a refresh
  button in the header to force-reload it on demand
- Optional **Save** + ◀ ▶ **Latest** controls to keep a copy of the
  current photo and browse back through previously saved ones (needs a
  small one-time Home Assistant config step — see below)
- Lists the AI-recognized items as a plain list (no checkboxes), each
  field editable directly on the card: name, quantity, condition, an AI
  confidence readout, a note, brand and expiration date
- Add / edit / delete items in place. Editing quantity, condition, note
  or brand protects that field from being overwritten by a fresh AI
  guess on the next scan — the same idea as a hand-drawn detection frame
- A numeric quantity gets a one-tap down arrow to knock it down by one
  without opening the edit form — greyed out once it reaches 1
- A checkbox on each item marks it **eaten** instead of deleting it
  outright — it moves into a collapsed **Eaten** section at the bottom,
  restorable from there. Adding a new item under a name that's already
  in that section offers to restore it instead of creating a duplicate,
  and so does the fridge-core automation if it still recognizes the item
  on a later scan
- The layout responds to the card's own width, not the browser window —
  side-by-side (photo left, items right) on a wider card, and the item
  list itself splitting into two columns once there's room for it
- A **brand** field per item, set by hand and never touched by the AI —
  the [fridge-core](https://github.com/jan-tdy/fridge-core) automation
  carries it forward across re-scans. Autocompletes from every brand
  already used elsewhere in the list, so you only type each one out once
- Optional **detection frames**: toggle in the header to overlay each
  item's location and name (truncated with an ellipsis if it doesn't fit)
  on the photo (only shown once at least one item carries box data — see
  below). Boxes can come from the AI (accuracy depends on the model) or
  be **drawn by hand**: while editing an item, hit "Add box" and drag a
  rectangle over it. An item can carry more than one box (e.g. a few of
  the same item sitting in different spots in the photo), each with its
  own optional expiration date, and each can be **redrawn** individually
  in place without removing and re-adding it. Tapping a box on the photo
  — whether or not the frames are currently toggled on — jumps straight
  to editing that item. Note: at `image_rotation` 90/270° the name tag rotates
  together with the frame, so it reads sideways. On a mouse (not touch),
  hovering an item's row in the list highlights its frame(s) on the photo
  in orange, whether or not detection frames are toggled on
- An item can be marked **in side door** or **in freezer** by hand — for
  something the camera can't see (a side compartment or the freezer
  drawer). Shows as a badge next to quantity/condition instead of a
  detection frame, and drops any existing box
- Quick controls: fridge light toggle, door status, open the live camera
  view, and a button to trigger the fridge-analysis automation
- Optional **simple list** view: toggle in the header to swap the item
  list for a compact name/quantity/place/brand/expiration line per item,
  with no badges — the pencil icon and the quantity down-arrow still
  work, and the name turns red once the item is expiring soon or overdue
- A **search box** above the item list filters by name as you type, in
  either list view — the item you're currently editing always stays
  visible even if it no longer matches
- Fully configurable from the Lovelace UI editor — no YAML required

<img width="1610" height="682" alt="image" src="https://github.com/user-attachments/assets/75e08cbb-0770-480c-953e-8a6b58193326" />


## How it works

The card reads its item list from a Home Assistant `todo` entity, using the
entity's `summary`, `description` and `due` fields directly (the same fields
the built-in to-do list card uses). Point `todo_entity` at whatever entity
your fridge-recognition automation writes items into, and the card will
display and let you edit them — without the completed/checkbox semantics of
a normal to-do list.

The `description` field is where all of this actually lives: quantity,
condition, confidence, note, brand, side door/freezer and each detection
box are stored as their own `[[key:value]]` marker (e.g. `[[qty:2
pieces]]`, `[[box:x1,y1,x2,y2]]` — `x`/`y` as percentages 0-100 of the
photo's width/height, top-left origin) and hidden from view, with the
card showing/editing them as separate fields instead. An item can carry
several `[[box:...]]` markers at once, one per detection frame, each
optionally ending in its own `,yyyy-mm-dd` expiration date (e.g.
`[[box:12,34,26,41,m,2026-09-12]]`). A field you edit on the card —
quantity, condition, note or a hand-drawn box — gets marked with a
trailing `m` on its key (e.g. `[[qtym:2 pieces]]`,
`[[box:12,34,26,41,m]]`), which tells the
[fridge-core](https://github.com/jan-tdy/fridge-core) automation to leave
it alone on the next scan instead of replacing it with a fresh AI guess.
Brand works the same way but simpler: the AI never writes to it at all,
so it's always exactly what you typed. Confidence is the one field the
AI always refreshes, since only the AI ever sets it. An item created
before these fields existed (plain free text, no markers at all) still
shows that text as its note.

## Installation

### HACS (custom repository)

1. HACS → Frontend → ⋮ → Custom repositories
2. Add `https://github.com/jan-tdy/fridge-card` as category **Dashboard**
3. Install **Fridge Card**, then add the resource if HACS doesn't do it
   automatically (Settings → Dashboards → Resources):
   `/hacsfiles/fridge-card/fridge-card.js`, type **JavaScript Module**

### Manual

1. Copy `fridge-card.js` into `<config>/www/fridge-card/fridge-card.js`
2. Add it as a Lovelace resource:
   `/local/fridge-card/fridge-card.js`, type **JavaScript Module**

## Usage

Add a new card, search for **Fridge Card**, and configure it in the UI
editor. Equivalent YAML:

```yaml
type: custom:fridge-card
title: Fridge
image_entity: sensor.fridge_contents
image_path: /local/fridge/fridge_latest.jpg
image_rotation: 90
image_height: 220
todo_entity: todo.fridge_contents
camera_entity: camera.fridge
light_entity: light.fridge
door_entity: binary_sensor.fridge_door
analyze_entity: automation.fridge_analysis
```

| Option | Required | Description |
| --- | --- | --- |
| `title` | no | Card header text |
| `image_entity` | yes* | Entity whose `last_changed` is used to cache-bust the photo (e.g. the sensor updated by your recognition automation) |
| `image_path` | yes* | URL/local path of the fridge photo |
| `image_rotation` | no | `0`, `90`, `180` or `270` — fixed clockwise rotation applied to the photo, for a camera that isn't mounted straight (default `0`) |
| `image_height` | no | Height of the photo box in pixels (default `220`) |
| `todo_entity` | yes | `todo.*` entity holding the recognized items |
| `camera_entity` | no | Camera entity; shows a "Live view" button that opens Home Assistant's live camera dialog |
| `light_entity` | no | Fridge light; shows a toggle chip |
| `door_entity` | no | Door `binary_sensor`; shows an open/closed status chip |
| `analyze_entity` | no | `automation`, `script` or `button` entity to trigger; shows an "Analyze fridge" button (calls `trigger`/`turn_on`/`press` as appropriate for the entity's domain) |
| `snapshot_service` | no | `domain.service` to call for **Save** (e.g. `shell_command.fridge_save_snapshot`); shows Save + ◀ ▶ **Latest** controls once set — see [Saved snapshot history](#saved-snapshot-history) |

\* At least one of `image_entity` or `image_path` is required; `image_path`
defaults to `/local/fridge/fridge_latest.jpg`.

### Editing items

Click the pencil icon on any item — or tap its detection frame on the
photo — to edit its name, quantity, condition, note, brand and
expiration date, or delete it. The AI's confidence in its own guess, if
any, is shown for reference but isn't editable. The Brand field suggests
every brand already used on some other item in the list (browser
autocomplete), so a brand only needs to be typed once and can be picked
from the list after that. The badge shows a relative countdown ("expires
in 3d"); hover it for the exact date. When editing, the date field always
uses `dd/mm/yyyy` (typing digits auto-inserts the `/`), regardless of the
browser's locale — clear the field and hit Save to remove the expiration
date entirely. Use **Add item** to add a new one. Editing calls the
standard `todo.add_item` / `todo.update_item` / `todo.remove_item`
services, so your `todo_entity` must support the corresponding features
(create/update/delete, description, due date).

While editing, use **Add box** to set one or more detection frames by
hand — drag a rectangle over the item on the photo each time; **Redraw**
replaces one frame in place (keeping its own expiration date) instead of
removing and re-adding it, and the ✕ next to it removes it outright. This
works correctly at any `image_rotation`. Each frame can carry its own
expiration date, for items that have more than one instance in the
fridge with different best-by dates. Quantity, condition, note, the
hand-drawn frames and the Brand
field are all matched by item name and carried forward by the
fridge-core automation on the next scan, instead of being overwritten by
a fresh (and possibly wrong) AI guess.

The checkbox on each item calls `todo.update_item` with `status:
completed` instead of removing it, so it shows up in the collapsed
**Eaten (N)** section at the bottom of the list instead of disappearing
for good — expand it and hit **Restore** to bring an item back. If you
add a new item under a name that's already sitting there, the card asks
whether to restore it instead of creating a duplicate; fridge-core does
the same automatically if a later scan still recognizes the item.

### Saved snapshot history

Setting `snapshot_service` turns on a **Save** button and ◀ ▶ /
**Latest** controls on the photo. **Save** copies whatever the photo file
currently holds to a timestamped file, so you can keep a record without
waiting for the next automatic scan; ◀ ▶ browse back and forward through
what's been saved, and **Latest** returns to the live photo. This needs
one `shell_command` added to your own Home Assistant config first, since
the card is just a browser page and can't copy a file on the server by
itself — see [fridge-core's README](https://github.com/jan-tdy/fridge-core#optional-saved-snapshot-history)
for the exact YAML to add. Leave `snapshot_service` unset (the default)
to skip all of this — the card works exactly as before.

## Companion repository

This card is the Lovelace UI half of the fridge project. The other half —
capturing photos from the esp32-cam, running AI recognition and writing
the results into the `todo`/`sensor` entities this card reads — lives in
[jan-tdy/fridge-core](https://github.com/jan-tdy/fridge-core).
