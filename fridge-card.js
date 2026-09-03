/*!
 * Fridge Card
 * A modern Home Assistant Lovelace card for an AI-recognized fridge inventory.
 *
 * Shows the latest fridge photo (rotation is set once in the card config, to
 * correct for a crooked camera mount), a plain list of recognized items
 * (name, description, expiration date - all editable in place, no checkboxes),
 * plus quick controls for the fridge light, door sensor, live camera view and
 * triggering a re-analysis of the fridge contents.
 *
 * https://github.com/jan-tdy/fridge-card
 */

const CARD_VERSION = "1.0.0";

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
    this._build();
    if (this._hass) this._refreshAll();
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
        </div>
        <div class="image-wrap">
          <img class="fridge-img" alt="Fridge contents" />
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

    this._titleEl = root.querySelector(".title");
    this._imgEl = root.querySelector(".fridge-img");
    this._imageWrapEl = root.querySelector(".image-wrap");
    this._fallbackEl = root.querySelector(".fallback");
    this._statusRowEl = root.querySelector(".status-row");
    this._itemsEl = root.querySelector(".items");

    this._titleEl.textContent = this._config.title || "";
    root.querySelector(".header").style.display = this._config.title ? "" : "none";
    this._imageWrapEl.style.height = `${Number(this._config.image_height) || 220}px`;

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

    this._applyImageTransform();
  }

  _applyImageTransform() {
    if (!this._imgEl || !this._imageWrapEl) return;
    const rot = Number(this._config.image_rotation) || 0;
    this._imgEl.style.transform = `rotate(${rot}deg)`;
    const swapped = rot === 90 || rot === 270;
    if (swapped) {
      const rect = this._imageWrapEl.getBoundingClientRect();
      this._imgEl.style.maxWidth = `${rect.height}px`;
      this._imgEl.style.maxHeight = `${rect.width}px`;
    } else {
      this._imgEl.style.maxWidth = "100%";
      this._imgEl.style.maxHeight = "100%";
    }
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
      return;
    }
    const sorted = [...this._items].sort((a, b) => {
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      if (a.due) return -1;
      if (b.due) return 1;
      return (a.summary || "").localeCompare(b.summary || "");
    });
    this._itemsEl.innerHTML = sorted.map((item) => this._itemRowHtml(item)).join("");
  }

  _itemRowHtml(item) {
    if (this._editingUid === item.uid) {
      return `
        <div class="item item-editing" data-uid="${escapeHtml(item.uid)}">
          <input class="edit-name" type="text" value="${escapeHtml(item.summary)}" placeholder="Item name" />
          <textarea class="edit-desc" placeholder="Description">${escapeHtml(item.description || "")}</textarea>
          <input
            class="edit-due"
            type="text"
            inputmode="numeric"
            maxlength="10"
            placeholder="dd/mm/yyyy"
            value="${item.due ? escapeHtml(formatDMY(new Date(item.due.length === 10 ? `${item.due}T00:00:00` : item.due))) : ""}"
          />
          <div class="edit-actions">
            <button class="text-btn danger" data-action="delete-item">Delete</button>
            <button class="text-btn" data-action="cancel-edit">Cancel</button>
            <button class="text-btn primary" data-action="save-item">Save</button>
          </div>
        </div>
      `;
    }

    const info = dueInfo(item.due);
    return `
      <div class="item" data-uid="${escapeHtml(item.uid)}">
        <div class="item-main">
          <div class="item-name">${escapeHtml(item.summary)}</div>
          ${item.description ? `<div class="item-desc">${escapeHtml(item.description)}</div>` : ""}
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
      this._renderItems();
    } else if (action === "cancel-edit") {
      this._editingUid = null;
      if (uid === "__new__") this._items = this._items.filter((i) => i.uid !== "__new__");
      this._renderItems();
    } else if (action === "delete-item") {
      this._deleteItem(uid);
    } else if (action === "save-item") {
      this._saveItem(uid, itemEl);
    }
  }

  _addItem() {
    if (this._items.some((i) => i.uid === "__new__")) return;
    this._editingUid = "__new__";
    this._items = [{ uid: "__new__", summary: "", description: "", due: null }, ...this._items];
    this._renderItems();
    requestAnimationFrame(() => {
      const el = this._itemsEl.querySelector(".item-editing .edit-name");
      if (el) el.focus();
    });
  }

  async _saveItem(uid, itemEl) {
    const name = itemEl.querySelector(".edit-name").value.trim();
    const description = itemEl.querySelector(".edit-desc").value.trim();
    const dueText = itemEl.querySelector(".edit-due").value.trim();
    const due = dueText ? parseDMY(dueText) : null;
    if (!name) return;

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
        if (due) payload.due_date = due;
        await this._hass.callService("todo", "update_item", payload);
      }
    } finally {
      this._editingUid = null;
      await this._fetchItems();
    }
  }

  async _deleteItem(uid) {
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
      .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .title { font-size: 1.2rem; font-weight: 600; color: var(--primary-text-color); }
      .icon-btn { border: none; background: var(--secondary-background-color, rgba(0,0,0,0.06)); color: var(--primary-text-color); width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .15s ease; flex-shrink: 0; }
      .icon-btn:hover { background: var(--divider-color, rgba(0,0,0,0.12)); }
      .image-wrap { position: relative; border-radius: 12px; overflow: hidden; background: var(--secondary-background-color, #eee); display: flex; align-items: center; justify-content: center; margin-bottom: 14px; }
      .fridge-img { object-fit: contain; transition: transform .25s ease, max-width .25s ease, max-height .25s ease; }
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
  description: "AI-recognized fridge contents with rotatable photo, live view and quick controls.",
  preview: false,
  documentationURL: "https://github.com/jan-tdy/fridge-card",
});

console.info(
  `%c FRIDGE-CARD %c v${CARD_VERSION} `,
  "color: white; background: #039be5; font-weight: 700; border-radius: 3px 0 0 3px; padding: 2px 0;",
  "color: #039be5; background: white; font-weight: 700; border-radius: 0 3px 3px 0; padding: 2px 0;"
);
