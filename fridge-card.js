/*!
 * Fridge Card
 * A modern Home Assistant Lovelace card for an AI-recognized fridge inventory.
 *
 * Shows the latest fridge photo (rotation is set once in the card config, to
 * correct for a crooked camera mount), a plain list of recognized items
 * (name, description, expiration date - all editable in place, no checkboxes),
 * plus quick controls for the fridge light, door sensor, live camera view and
 * triggering a re-analysis of the fridge contents. Optionally overlays each
 * item's AI-estimated bounding box on the photo (toggle in the header) - the
 * box coordinates come from a companion fridge-core automation, or can be
 * drawn by hand on the photo while editing an item when the AI gets it
 * wrong or skips it.
 *
 * https://github.com/jan-tdy/fridge-card
 */

const CARD_VERSION = "1.2.0";

function fireEvent(node, type, detail = {}, options = {}) {
  const event = new Event(type, {
    bubbles: options.bubbles === undefined ? true : options.bubbles,
    cancelable: Boolean(options.cancelable),
    composed: options.composed === undefined ? true : options.composed,
  });
  event.detail = detail;
  node.dispatchEvent(event);
  return event;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function serviceForTrigger(entityId) {
  const domain = entityId.split(".")[0];
  switch (domain) {
    case "automation":
      return { domain: "automation", service: "trigger" };
    case "script":
      return { domain: "script", service: "turn_on" };
    case "button":
      return { domain: "button", service: "press" };
    case "input_button":
      return { domain: "input_button", service: "press" };
    default:
      return { domain, service: "turn_on" };
  }
}

function formatDMY(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${date.getFullYear()}`;
}

// Parses a "dd/mm/yyyy" string into an ISO "yyyy-mm-dd" date, or null if
// it isn't a valid complete date (used instead of <input type="date">,
// whose displayed format follows the browser/OS locale rather than what
// we ask for).
function parseDMY(text) {
  const m = String(text || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Auto-inserts the "/" separators as the user types digits.
function maskDMYInput(raw) {
  const digits = String(raw || "").replace(/\D/g, "").slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += `/${digits.slice(2, 4)}`;
  if (digits.length > 4) out += `/${digits.slice(4, 8)}`;
  return out;
}

// fridge-core embeds each item's AI-estimated location in the photo as a
// trailing "[[box:x1,y1,x2,y2]]" marker in the todo item's description
// (x/y are percentages 0-100 of the photo's width/height, top-left origin).
const BOX_MARKER_RE = /\s*\[\[box:\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]\]\s*/;

function extractBox(description) {
  const m = BOX_MARKER_RE.exec(String(description || ""));
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) return null;
  return { x1, y1, x2, y2 };
}

function stripBoxMarker(description) {
  return String(description || "").replace(BOX_MARKER_RE, " ").trim();
}

function dueInfo(due) {
  if (!due) return null;
  const dueDate = new Date(due.length === 10 ? `${due}T00:00:00` : due);
  if (Number.isNaN(dueDate.getTime())) return null;

  const startOfDue = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.round((startOfDue - startOfToday) / 86400000);

  let label;
  if (days < 0) label = `Expired ${Math.abs(days)}d ago`;
  else if (days === 0) label = "Expires today";
  else if (days === 1) label = "Expires tomorrow";
  else label = `Expires in ${days}d`;

  const cls = days < 0 ? "due-overdue" : days <= 2 ? "due-soon" : "";
  return { label, title: formatDMY(startOfDue), cls };
}

class FridgeCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: "Fridge",
      image_entity: "sensor.fridge_contents",
      image_path: "/local/fridge/fridge_latest.jpg",
      image_rotation: 0,
      image_height: 220,
      todo_entity: "todo.fridge_contents",
      camera_entity: "",
      light_entity: "",
      door_entity: "",
      analyze_entity: "",
    };
  }

  static getConfigElement() {
    return document.createElement("fridge-card-editor");
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._items = [];
    this._itemsStateKey = null;
    this._editingUid = null;
    this._showBoxes = false;
    // Manual box drawing (draw-on-photo) state.
    this._drawingUid = null;
    this._drawActive = false;
    this._drawStart = null;
    this._drawCurrent = null;
    this._pendingBox = undefined; // undefined = untouched, object = drawn, null = explicitly cleared
  }

  setConfig(config) {
    if (!config.image_entity && !config.image_path) {
      throw new Error("Please define an image_entity or image_path");
    }
    if (!config.todo_entity) {
      throw new Error("Please define a todo_entity holding the recognized items");
    }
    this._config = {
      title: "Fridge",
      image_path: "/local/fridge/fridge_latest.jpg",
      image_rotation: 0,
      image_height: 220,
      ...config,
    };
    this._items = [];
    this._itemsStateKey = null;
    this._editingUid = null;
    this._showBoxes = this._loadShowBoxes();
    this._drawingUid = null;
    this._drawActive = false;
    this._pendingBox = undefined;
    this._build();
    if (this._hass) this._refreshAll();
  }

  _loadShowBoxes() {
    try {
      return localStorage.getItem(`fridge-card-boxes-${this._config.todo_entity}`) === "1";
    } catch (e) {
      return false;
    }
  }

  _saveShowBoxes() {
    try {
      localStorage.setItem(`fridge-card-boxes-${this._config.todo_entity}`, this._showBoxes ? "1" : "0");
    } catch (e) {
      /* storage unavailable, ignore */
    }
  }

  connectedCallback() {
    if (this._config && !this.shadowRoot.firstChild) this._build();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (!this.shadowRoot.firstChild) this._build();
    this._updateImage();
    this._updateStatusRow();
    this._maybeRefreshItems();
    if (first) this._fetchItems();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 3 + Math.max(1, this._items.length);
  }

  _refreshAll() {
    this._updateImage();
    this._updateStatusRow();
    this._fetchItems();
  }

  _build() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="header">
          <div class="title"></div>
          <button class="boxes-toggle" data-action="toggle-boxes" hidden>
            <ha-icon icon="mdi:vector-square"></ha-icon>
            <span>Detection frames</span>
          </button>
        </div>
        <div class="image-wrap">
          <img class="fridge-img" alt="Fridge contents" />
          <div class="detection-overlay"></div>
          <div class="fallback">
            <ha-icon icon="mdi:image-off-outline"></ha-icon>
            <span>No image</span>
          </div>
        </div>
        <div class="status-row"></div>
        <div class="items"></div>
        <div class="add-row">
          <button class="add-btn">
            <ha-icon icon="mdi:plus"></ha-icon>
            <span>Add item</span>
          </button>
        </div>
      </ha-card>
    `;

    this._headerEl = root.querySelector(".header");
    this._titleEl = root.querySelector(".title");
    this._boxesToggleEl = root.querySelector(".boxes-toggle");
    this._imgEl = root.querySelector(".fridge-img");
    this._imageWrapEl = root.querySelector(".image-wrap");
    this._overlayEl = root.querySelector(".detection-overlay");
    this._fallbackEl = root.querySelector(".fallback");
    this._statusRowEl = root.querySelector(".status-row");
    this._itemsEl = root.querySelector(".items");

    this._titleEl.textContent = this._config.title || "";
    this._titleEl.style.display = this._config.title ? "" : "none";
    this._imageWrapEl.style.height = `${Number(this._config.image_height) || 220}px`;

    this._boxesToggleEl.classList.toggle("active", this._showBoxes);
    this._boxesToggleEl.addEventListener("click", () => {
      this._showBoxes = !this._showBoxes;
      this._saveShowBoxes();
      this._boxesToggleEl.classList.toggle("active", this._showBoxes);
      this._renderBoxes();
    });
    this._updateHeaderVisibility();

    this._imgEl.addEventListener("load", () => {
      this._fallbackEl.classList.remove("show");
      this._applyImageTransform();
    });
    this._imgEl.addEventListener("error", () => {
      this._fallbackEl.classList.add("show");
    });

    if (!this._resizeObserver && typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._applyImageTransform());
    }
    if (this._resizeObserver) this._resizeObserver.observe(this._imageWrapEl);

    this._statusRowEl.addEventListener("click", (e) => this._onStatusClick(e));
    this._itemsEl.addEventListener("click", (e) => this._onItemsClick(e));
    this._itemsEl.addEventListener("input", (e) => {
      if (!e.target.classList.contains("edit-due")) return;
      e.target.value = maskDMYInput(e.target.value);
    });
    root.querySelector(".add-btn").addEventListener("click", () => this._addItem());

    this._imageWrapEl.addEventListener("pointerdown", (e) => this._onDrawStart(e));
    this._imageWrapEl.addEventListener("pointermove", (e) => this._onDrawMove(e));
    // _build() can re-run (e.g. every keystroke in the config editor's live
    // preview); only ever attach one window-level pointerup listener.
    if (!this._pointerUpBound) {
      this._pointerUpBound = true;
      window.addEventListener("pointerup", (e) => this._onDrawEnd(e));
    }

    this._applyImageTransform();
  }

  // Sizes/positions the <img> to fit image-wrap (preserving aspect ratio,
  // like object-fit:contain would) using explicit width/height rather than
  // max-width/max-height, and applies the configured rotation. The
  // detection overlay is given the exact same box + transform so its
  // percentage-positioned children rotate together with the photo.
  _applyImageTransform() {
    if (!this._imgEl || !this._imageWrapEl) return;
    const rot = Number(this._config.image_rotation) || 0;
    const swapped = rot === 90 || rot === 270;
    const wrapRect = this._imageWrapEl.getBoundingClientRect();
    const boxW = swapped ? wrapRect.height : wrapRect.width;
    const boxH = swapped ? wrapRect.width : wrapRect.height;
    const naturalW = this._imgEl.naturalWidth || boxW || 1;
    const naturalH = this._imgEl.naturalHeight || boxH || 1;
    const scale = Math.min(boxW / naturalW, boxH / naturalH) || 1;
    const renderW = `${naturalW * scale}px`;
    const renderH = `${naturalH * scale}px`;
    const transform = `translate(-50%, -50%) rotate(${rot}deg)`;

    this._imgEl.style.width = renderW;
    this._imgEl.style.height = renderH;
    this._imgEl.style.transform = transform;
    if (this._overlayEl) {
      this._overlayEl.style.width = renderW;
      this._overlayEl.style.height = renderH;
      this._overlayEl.style.transform = transform;
    }
  }

  _updateHeaderVisibility() {
    if (!this._headerEl) return;
    const hasTitle = Boolean(this._config.title);
    const hasBoxes = !this._boxesToggleEl.hasAttribute("hidden");
    this._headerEl.style.display = hasTitle || hasBoxes ? "" : "none";
  }

  // Converts a pointer event's screen position into a percentage (0-100)
  // in the photo's own coordinate space (top-left origin, same frame the
  // AI's [[box:...]] percentages use) - inverting whatever rotation is
  // currently applied to the image/overlay so drawing stays correct at
  // 90/180/270°.
  _pointerToBoxPercent(clientX, clientY) {
    const rect = this._overlayEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const rot = Number(this._config.image_rotation) || 0;
    const rad = (-rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = clientX - cx;
    const dy = clientY - cy;
    const localDx = dx * cos - dy * sin;
    const localDy = dx * sin + dy * cos;
    const w = this._overlayEl.offsetWidth || 1;
    const h = this._overlayEl.offsetHeight || 1;
    const x = ((w / 2 + localDx) / w) * 100;
    const y = ((h / 2 + localDy) / h) * 100;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  }

  _onDrawStart(e) {
    if (!this._drawingUid) return;
    e.preventDefault();
    this._drawActive = true;
    this._drawStart = this._pointerToBoxPercent(e.clientX, e.clientY);
    this._drawCurrent = this._drawStart;
    this._renderBoxes();
  }

  _onDrawMove(e) {
    if (!this._drawingUid || !this._drawActive) return;
    this._drawCurrent = this._pointerToBoxPercent(e.clientX, e.clientY);
    this._renderBoxes();
  }

  _onDrawEnd(e) {
    if (!this._drawingUid || !this._drawActive) return;
    this._drawActive = false;
    const end = this._pointerToBoxPercent(e.clientX, e.clientY);
    const start = this._drawStart;
    this._drawingUid = null;
    this._drawStart = null;
    this._drawCurrent = null;
    this._imageWrapEl.classList.remove("drawing");

    const round1 = (n) => Math.round(n * 10) / 10;
    const box = {
      x1: round1(Math.min(start.x, end.x)),
      y1: round1(Math.min(start.y, end.y)),
      x2: round1(Math.max(start.x, end.x)),
      y2: round1(Math.max(start.y, end.y)),
    };
    // Ignore accidental taps/tiny drags.
    if (box.x2 - box.x1 < 2 || box.y2 - box.y1 < 2) {
      this._renderBoxes();
      return;
    }
    this._pendingBox = box;
    this._renderItems();
  }

  _boxDivHtml(box, pending) {
    const left = Math.min(box.x1, box.x2);
    const top = Math.min(box.y1, box.y2);
    const width = Math.abs(box.x2 - box.x1);
    const height = Math.abs(box.y2 - box.y1);
    return `<div class="detection-box${pending ? " pending" : ""}" style="left:${left}%; top:${top}%; width:${width}%; height:${height}%;"></div>`;
  }

  // Draws one rectangle per item that carries an AI-estimated box (see
  // extractBox) when detection frames are toggled on, plus - always,
  // regardless of the toggle - the box (pending draw, existing, or a
  // live drag preview) of whichever item is currently being edited, so
  // the user can see what they're placing.
  _renderBoxes() {
    if (!this._overlayEl) return;
    const withBoxes = this._items
      .map((item) => ({ item, box: extractBox(item.description) }))
      .filter((x) => x.box);

    this._boxesToggleEl.toggleAttribute("hidden", withBoxes.length === 0);
    this._updateHeaderVisibility();

    const parts = [];
    if (this._showBoxes) {
      for (const { item, box } of withBoxes) {
        if (item.uid === this._editingUid) continue; // handled below instead
        parts.push(this._boxDivHtml(box, false));
      }
    }

    if (this._editingUid && this._drawingUid !== this._editingUid) {
      const editingItem = this._items.find((i) => i.uid === this._editingUid);
      const box =
        this._pendingBox !== undefined ? this._pendingBox : editingItem ? extractBox(editingItem.description) : null;
      if (box) parts.push(this._boxDivHtml(box, true));
    }

    if (this._drawActive && this._drawStart && this._drawCurrent) {
      parts.push(
        this._boxDivHtml(
          {
            x1: Math.min(this._drawStart.x, this._drawCurrent.x),
            y1: Math.min(this._drawStart.y, this._drawCurrent.y),
            x2: Math.max(this._drawStart.x, this._drawCurrent.x),
            y2: Math.max(this._drawStart.y, this._drawCurrent.y),
          },
          true
        )
      );
    }

    this._overlayEl.innerHTML = parts.join("");
  }

  _updateImage() {
    const cfg = this._config;
    let url = cfg.image_path;
    if (cfg.image_entity) {
      const st = this._hass.states[cfg.image_entity];
      const ts = st ? Math.floor(new Date(st.last_changed).getTime() / 1000) : Math.floor(Date.now() / 1000);
      url = `${cfg.image_path}?v=${ts}`;
    }
    if (this._imgEl.dataset.src !== url) {
      this._imgEl.dataset.src = url;
      this._imgEl.src = url;
    }
  }

  _onStatusClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if (action === "toggle-light") {
      this._hass.callService("light", "toggle", { entity_id: this._config.light_entity });
    } else if (action === "stream") {
      fireEvent(this, "hass-more-info", { entityId: this._config.camera_entity });
    } else if (action === "analyze") {
      const { domain, service } = serviceForTrigger(this._config.analyze_entity);
      this._hass.callService(domain, service, { entity_id: this._config.analyze_entity });
    }
  }

  _updateStatusRow() {
    const cfg = this._config;
    const hass = this._hass;
    const chips = [];

    if (cfg.door_entity && hass.states[cfg.door_entity]) {
      const open = hass.states[cfg.door_entity].state === "on";
      chips.push(`
        <div class="chip ${open ? "chip-alert" : ""}">
          <ha-icon icon="${open ? "mdi:door-open" : "mdi:door-closed"}"></ha-icon>
          <span>${open ? "Door open" : "Door closed"}</span>
        </div>
      `);
    }

    if (cfg.light_entity && hass.states[cfg.light_entity]) {
      const on = hass.states[cfg.light_entity].state === "on";
      chips.push(`
        <button class="chip chip-btn ${on ? "chip-active" : ""}" data-action="toggle-light">
          <ha-icon icon="${on ? "mdi:lightbulb" : "mdi:lightbulb-off-outline"}"></ha-icon>
          <span>${on ? "Light on" : "Light off"}</span>
        </button>
      `);
    }

    if (cfg.camera_entity) {
      chips.push(`
        <button class="chip chip-btn" data-action="stream">
          <ha-icon icon="mdi:cctv"></ha-icon>
          <span>Live view</span>
        </button>
      `);
    }

    if (cfg.analyze_entity) {
      chips.push(`
        <button class="chip chip-btn chip-accent" data-action="analyze">
          <ha-icon icon="mdi:magnify-scan"></ha-icon>
          <span>Analyze fridge</span>
        </button>
      `);
    }

    this._statusRowEl.innerHTML = chips.join("");
  }

  _maybeRefreshItems() {
    const st = this._hass.states[this._config.todo_entity];
    const key = st ? `${st.state}|${st.last_changed}` : null;
    if (key === this._itemsStateKey) return;
    this._itemsStateKey = key;
    if (this._editingUid) return;
    this._fetchItems();
  }

  async _fetchItems() {
    if (!this._hass || !this._config) return;
    try {
      const result = await this._hass.callWS({
        type: "todo/item/list",
        entity_id: this._config.todo_entity,
      });
      this._items = result.items || [];
      this._renderItems();
    } catch (err) {
      this._itemsEl.innerHTML = `<div class="empty">Unable to load items: ${escapeHtml(err.message || err)}</div>`;
    }
  }

  _renderItems() {
    if (!this._items.length) {
      this._itemsEl.innerHTML = `<div class="empty">No items recognized yet.</div>`;
      this._renderBoxes();
      return;
    }
    const sorted = [...this._items].sort((a, b) => {
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      if (a.due) return -1;
      if (b.due) return 1;
      return (a.summary || "").localeCompare(b.summary || "");
    });
    this._itemsEl.innerHTML = sorted.map((item) => this._itemRowHtml(item)).join("");
    this._renderBoxes();
  }

  _itemRowHtml(item) {
    if (this._editingUid === item.uid) {
      const hasBox = this._pendingBox !== undefined ? Boolean(this._pendingBox) : Boolean(extractBox(item.description));
      return `
        <div class="item item-editing" data-uid="${escapeHtml(item.uid)}">
          <input class="edit-name" type="text" value="${escapeHtml(item.summary)}" placeholder="Item name" />
          <textarea class="edit-desc" placeholder="Description">${escapeHtml(stripBoxMarker(item.description))}</textarea>
          <input
            class="edit-due"
            type="text"
            inputmode="numeric"
            maxlength="10"
            placeholder="dd/mm/yyyy"
            value="${item.due ? escapeHtml(formatDMY(new Date(item.due.length === 10 ? `${item.due}T00:00:00` : item.due))) : ""}"
          />
          <div class="frame-row">
            <span>Detection frame${hasBox ? " set" : " not set"}</span>
            <div class="frame-actions">
              <button type="button" class="text-btn" data-action="draw-box">${hasBox ? "Redraw" : "Draw on photo"}</button>
              ${hasBox ? `<button type="button" class="text-btn danger" data-action="clear-box">Clear</button>` : ""}
            </div>
          </div>
          <div class="edit-actions">
            <button class="text-btn danger" data-action="delete-item">Delete</button>
            <button class="text-btn" data-action="cancel-edit">Cancel</button>
            <button class="text-btn primary" data-action="save-item">Save</button>
          </div>
        </div>
      `;
    }

    const info = dueInfo(item.due);
    const desc = stripBoxMarker(item.description);
    return `
      <div class="item" data-uid="${escapeHtml(item.uid)}">
        <div class="item-main">
          <div class="item-name">${escapeHtml(item.summary)}</div>
          ${desc ? `<div class="item-desc">${escapeHtml(desc)}</div>` : ""}
        </div>
        <div class="item-side">
          ${info ? `<div class="due-chip ${info.cls}" title="${escapeHtml(info.title)}">${escapeHtml(info.label)}</div>` : ""}
          <button class="icon-btn edit-btn" data-action="edit-item" title="Edit">
            <ha-icon icon="mdi:pencil-outline"></ha-icon>
          </button>
        </div>
      </div>
    `;
  }

  _onItemsClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const itemEl = e.target.closest(".item");
    const uid = itemEl ? itemEl.dataset.uid : null;
    const action = btn.dataset.action;

    if (action === "edit-item") {
      this._editingUid = uid;
      this._pendingBox = undefined;
      this._renderItems();
    } else if (action === "cancel-edit") {
      this._editingUid = null;
      this._pendingBox = undefined;
      this._drawingUid = null;
      this._imageWrapEl.classList.remove("drawing");
      if (uid === "__new__") this._items = this._items.filter((i) => i.uid !== "__new__");
      this._renderItems();
    } else if (action === "delete-item") {
      this._deleteItem(uid);
    } else if (action === "save-item") {
      this._saveItem(uid, itemEl);
    } else if (action === "draw-box") {
      this._drawingUid = uid;
      this._imageWrapEl.classList.add("drawing");
      this._renderBoxes();
    } else if (action === "clear-box") {
      this._pendingBox = null;
      this._renderItems();
    }
  }

  _addItem() {
    if (this._items.some((i) => i.uid === "__new__")) return;
    this._editingUid = "__new__";
    this._pendingBox = undefined;
    this._items = [{ uid: "__new__", summary: "", description: "", due: null }, ...this._items];
    this._renderItems();
    requestAnimationFrame(() => {
      const el = this._itemsEl.querySelector(".item-editing .edit-name");
      if (el) el.focus();
    });
  }

  async _saveItem(uid, itemEl) {
    const name = itemEl.querySelector(".edit-name").value.trim();
    let description = itemEl.querySelector(".edit-desc").value.trim();
    const dueText = itemEl.querySelector(".edit-due").value.trim();
    const due = dueText ? parseDMY(dueText) : null;
    if (!name) return;

    // A manually drawn/cleared frame wins; otherwise carry the item's
    // existing [[box:...]] marker forward (editing the description strips
    // it for display, so it would otherwise be lost until the next scan).
    const existing = this._items.find((i) => i.uid === uid);
    const existingBox = existing ? extractBox(existing.description) : null;
    const box = this._pendingBox !== undefined ? this._pendingBox : existingBox;
    if (box) {
      description = `${description} [[box:${box.x1},${box.y1},${box.x2},${box.y2}]]`.trim();
    }

    try {
      if (uid === "__new__") {
        const payload = { entity_id: this._config.todo_entity, item: name };
        if (description) payload.description = description;
        if (due) payload.due_date = due;
        await this._hass.callService("todo", "add_item", payload);
      } else {
        const payload = {
          entity_id: this._config.todo_entity,
          item: uid,
          rename: name,
          description,
        };
        // An empty field explicitly clears the due date (due_date: null);
        // non-empty-but-unparseable text is left alone rather than risking
        // wiping the date over a typo.
        if (dueText === "") payload.due_date = null;
        else if (due) payload.due_date = due;
        await this._hass.callService("todo", "update_item", payload);
      }
    } finally {
      this._editingUid = null;
      this._pendingBox = undefined;
      await this._fetchItems();
    }
  }

  async _deleteItem(uid) {
    this._pendingBox = undefined;
    if (uid === "__new__") {
      this._editingUid = null;
      this._items = this._items.filter((i) => i.uid !== "__new__");
      this._renderItems();
      return;
    }
    await this._hass.callService("todo", "remove_item", { entity_id: this._config.todo_entity, item: uid });
    this._editingUid = null;
    await this._fetchItems();
  }

  _styles() {
    return `
      :host { display: block; }
      ha-card { padding: 16px; overflow: hidden; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
      .title { font-size: 1.2rem; font-weight: 600; color: var(--primary-text-color); }
      .icon-btn { border: none; background: var(--secondary-background-color, rgba(0,0,0,0.06)); color: var(--primary-text-color); width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .15s ease; flex-shrink: 0; }
      .icon-btn:hover { background: var(--divider-color, rgba(0,0,0,0.12)); }
      .boxes-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; border: none; background: var(--secondary-background-color, rgba(0,0,0,0.06)); color: var(--secondary-text-color); font-size: 0.8rem; font-family: inherit; cursor: pointer; flex-shrink: 0; transition: background .15s ease, color .15s ease; }
      .boxes-toggle ha-icon { --mdc-icon-size: 16px; }
      .boxes-toggle:hover { background: var(--divider-color, rgba(0,0,0,0.12)); }
      .boxes-toggle.active { background: var(--error-color, #f44336); color: var(--text-primary-color, #fff); }
      .image-wrap { position: relative; border-radius: 12px; overflow: hidden; background: var(--secondary-background-color, #eee); margin-bottom: 14px; }
      .image-wrap.drawing { cursor: crosshair; user-select: none; touch-action: none; }
      .image-wrap.drawing::after { content: 'Drag on the photo to mark the item'; position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); background: rgba(0,0,0,0.65); color: #fff; font-size: 0.7rem; padding: 4px 10px; border-radius: 999px; pointer-events: none; white-space: nowrap; z-index: 2; }
      .fridge-img { position: absolute; top: 50%; left: 50%; transition: transform .25s ease, width .25s ease, height .25s ease; }
      .detection-overlay { position: absolute; top: 50%; left: 50%; pointer-events: none; transition: transform .25s ease, width .25s ease, height .25s ease; }
      .detection-box { position: absolute; border: 2px solid #ff3b3b; border-radius: 3px; box-shadow: 0 0 0 1px rgba(0,0,0,0.35); }
      .detection-box.pending { border-color: #2196f3; border-style: dashed; background: rgba(33,150,243,0.1); }
      .fallback { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 6px; color: var(--secondary-text-color); font-size: 0.85rem; }
      .fallback.show { display: flex; }
      .fallback ha-icon { --mdc-icon-size: 32px; }
      .status-row { display: flex; flex-wrap: nowrap; gap: 8px; margin-bottom: 14px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
      .status-row::-webkit-scrollbar { height: 4px; }
      .status-row::-webkit-scrollbar-thumb { background: var(--divider-color, rgba(0,0,0,0.15)); border-radius: 999px; }
      .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: var(--secondary-background-color, rgba(0,0,0,0.06)); color: var(--primary-text-color); font-size: 0.85rem; border: none; font-family: inherit; white-space: nowrap; flex-shrink: 0; }
      .chip ha-icon { --mdc-icon-size: 18px; }
      .chip-btn { cursor: pointer; transition: background .15s ease, transform .1s ease; }
      .chip-btn:hover { background: var(--divider-color, rgba(0,0,0,0.12)); }
      .chip-btn:active { transform: scale(0.96); }
      .chip-alert { background: rgba(var(--rgb-error-color, 244,67,54), 0.14); color: var(--error-color, #f44336); }
      .chip-active { background: rgba(var(--rgb-primary-color, 3,169,244), 0.16); color: var(--primary-color); }
      .chip-accent { background: var(--primary-color); color: var(--text-primary-color, #fff); }
      .chip-accent:hover { filter: brightness(1.06); }
      .items { display: flex; flex-direction: column; }
      .item { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.08)); }
      .item:last-child { border-bottom: none; }
      .item-main { min-width: 0; }
      .item-name { font-weight: 600; color: var(--primary-text-color); }
      .item-desc { font-size: 0.85rem; color: var(--secondary-text-color); margin-top: 2px; overflow-wrap: anywhere; }
      .item-side { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .due-chip { font-size: 0.75rem; padding: 3px 8px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space: nowrap; }
      .due-chip.due-soon { background: rgba(255,193,7,0.18); color: #b98900; }
      .due-chip.due-overdue { background: rgba(var(--rgb-error-color, 244,67,54), 0.14); color: var(--error-color, #f44336); }
      .edit-btn ha-icon { --mdc-icon-size: 18px; }
      .empty { padding: 16px 4px; color: var(--secondary-text-color); font-size: 0.9rem; text-align: center; }
      .item-editing { flex-direction: column; align-items: stretch; gap: 8px; background: var(--secondary-background-color, rgba(0,0,0,0.04)); border-radius: 10px; padding: 12px; border-bottom: none; margin-bottom: 8px; }
      .item-editing input, .item-editing textarea { font-family: inherit; font-size: 0.9rem; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--divider-color, rgba(0,0,0,0.15)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
      .item-editing textarea { resize: vertical; min-height: 50px; }
      .frame-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.8rem; color: var(--secondary-text-color); }
      .frame-actions { display: flex; gap: 4px; flex-shrink: 0; }
      .frame-actions .text-btn { padding: 4px 10px; }
      .edit-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .text-btn { border: none; background: none; padding: 6px 12px; border-radius: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer; color: var(--primary-text-color); font-family: inherit; }
      .text-btn:hover { background: var(--divider-color, rgba(0,0,0,0.1)); }
      .text-btn.primary { color: var(--primary-color); }
      .text-btn.danger { color: var(--error-color, #f44336); margin-right: auto; }
      .add-row { margin-top: 6px; }
      .add-btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px; border-radius: 10px; border: 1px dashed var(--divider-color, rgba(0,0,0,0.2)); background: none; color: var(--secondary-text-color); font-family: inherit; font-size: 0.9rem; cursor: pointer; transition: background .15s ease, color .15s ease; }
      .add-btn:hover { background: var(--secondary-background-color, rgba(0,0,0,0.05)); color: var(--primary-text-color); }
    `;
  }
}

class FridgeCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _schema() {
    return [
      { name: "title", selector: { text: {} } },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "image_entity", selector: { entity: {} } },
          { name: "image_path", selector: { text: {} } },
        ],
      },
      {
        type: "grid",
        name: "",
        schema: [
          {
            name: "image_rotation",
            selector: {
              select: {
                mode: "dropdown",
                options: [
                  { value: 0, label: "No rotation" },
                  { value: 90, label: "90° clockwise" },
                  { value: 180, label: "180°" },
                  { value: 270, label: "270° clockwise (90° counter-clockwise)" },
                ],
              },
            },
          },
          {
            name: "image_height",
            selector: { number: { min: 80, max: 600, step: 10, mode: "box", unit_of_measurement: "px" } },
          },
        ],
      },
      { name: "todo_entity", selector: { entity: { domain: "todo" } } },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "camera_entity", selector: { entity: { domain: "camera" } } },
          { name: "light_entity", selector: { entity: { domain: "light" } } },
        ],
      },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "door_entity", selector: { entity: { domain: "binary_sensor" } } },
          { name: "analyze_entity", selector: { entity: {} } },
        ],
      },
    ];
  }

  _computeLabel(schemaItem) {
    const labels = {
      title: "Card title",
      image_entity: "Fridge photo sensor (used to bust the image cache)",
      image_path: "Image URL / local path",
      image_rotation: "Image rotation (fixes a crooked camera mount)",
      image_height: "Image height",
      todo_entity: "Recognized items (todo entity)",
      camera_entity: "Camera (for live view)",
      light_entity: "Fridge light",
      door_entity: "Fridge door sensor",
      analyze_entity: "Analyze trigger (automation / script / button)",
    };
    return labels[schemaItem.name] || schemaItem.name;
  }

  _render() {
    if (!this._hass || !this._config) return;
    this.innerHTML = "";
    const form = document.createElement("ha-form");
    form.hass = this._hass;
    form.data = this._config;
    form.schema = this._schema();
    form.computeLabel = (schemaItem) => this._computeLabel(schemaItem);
    form.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      this._config = ev.detail.value;
      fireEvent(this, "config-changed", { config: this._config });
    });
    this.appendChild(form);
  }
}

customElements.define("fridge-card", FridgeCard);
customElements.define("fridge-card-editor", FridgeCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "fridge-card",
  name: "Fridge Card",
  description: "AI-recognized fridge contents with rotatable photo, optional detection frames, live view and quick controls.",
  preview: false,
  documentationURL: "https://github.com/jan-tdy/fridge-card",
});

console.info(
  `%c FRIDGE-CARD %c v${CARD_VERSION} `,
  "color: white; background: #039be5; font-weight: 700; border-radius: 3px 0 0 3px; padding: 2px 0;",
  "color: #039be5; background: white; font-weight: 700; border-radius: 0 3px 3px 0; padding: 2px 0;"
);
