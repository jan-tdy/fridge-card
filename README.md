# fridge-card

A modern Home Assistant Lovelace card for a fridge camera (esp32-cam) with
AI-recognized contents.

![type](https://img.shields.io/badge/type-lovelace--card-blue)

- Shows the latest fridge photo, with a fixed rotation set in the card
  config (0/90/180/270°) to correct a crooked camera mount
- Lists the AI-recognized items as a plain list (no checkboxes) — name,
  description and expiration date, all editable directly on the card
- Add / edit / delete items in place
- Quick controls: fridge light toggle, door status, open the live camera
  view, and a button to trigger the fridge-analysis automation
- Fully configurable from the Lovelace UI editor — no YAML required

## How it works

The card reads its item list from a Home Assistant `todo` entity, using the
entity's `summary`, `description` and `due` fields directly (the same fields
the built-in to-do list card uses). Point `todo_entity` at whatever entity
your fridge-recognition automation writes items into, and the card will
display and let you edit them — without the completed/checkbox semantics of
a normal to-do list.

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
| `todo_entity` | yes | `todo.*` entity holding the recognized items |
| `camera_entity` | no | Camera entity; shows a "Live view" button that opens Home Assistant's live camera dialog |
| `light_entity` | no | Fridge light; shows a toggle chip |
| `door_entity` | no | Door `binary_sensor`; shows an open/closed status chip |
| `analyze_entity` | no | `automation`, `script` or `button` entity to trigger; shows an "Analyze fridge" button (calls `trigger`/`turn_on`/`press` as appropriate for the entity's domain) |

\* At least one of `image_entity` or `image_path` is required; `image_path`
defaults to `/local/fridge/fridge_latest.jpg`.

### Editing items

Click the pencil icon on any item to edit its name, description and
expiration date, or delete it. Use **Add item** to add a new one. Editing
calls the standard `todo.add_item` / `todo.update_item` / `todo.remove_item`
services, so your `todo_entity` must support the corresponding features
(create/update/delete, description, due date).

## Companion repository

This card is the Lovelace UI half of the fridge project. The other half —
capturing photos from the esp32-cam, running AI recognition and writing
the results into the `todo`/`sensor` entities this card reads — lives in
[jan-tdy/fridge-core](https://github.com/jan-tdy/fridge-core).
