/*!
 * Fridge Card
 * A modern Home Assistant Lovelace card for an AI-recognized fridge inventory.
 *
 * Shows the latest fridge photo (rotation is set once in the card config, to
 * correct for a crooked camera mount), a plain list of recognized items -
 * name, quantity, condition, an AI confidence readout, a note, brand and
 * expiration date, each its own field and editable in place, no checkboxes -
 * plus quick controls for the fridge light, door sensor, live camera view and
 * triggering a re-analysis of the fridge contents. Optionally overlays each
 * item's AI-estimated bounding box(es) on the photo (toggle in the header) -
 * an item can carry more than one box, each with its own optional expiration
 * date, for the same item sitting in a few different spots. Box coordinates
 * come from a companion fridge-core automation, or can be drawn by hand on
 * the photo while editing an item when the AI gets it wrong or skips it -
 * tapping a box on the photo (whether or not frames are currently toggled
 * on) jumps straight to editing that item. Editing quantity, condition,
 * note or brand (or drawing a box by hand) protects that field from being
 * overwritten by a fresh AI guess on the next scan; the Brand field also
 * offers previously used brand names as autocomplete suggestions, so a
 * brand only needs to be typed once. A refresh button in the header
 * force-reloads the photo on demand, bypassing both the browser cache and
 * the usual entity-timestamp cache-busting. A checkbox on each item marks
 * it eaten instead of deleting it outright, tucking it into a collapsed
 * "Eaten" section it can be restored from; adding a new item under a name
 * that's sitting there offers to restore it instead of creating a
 * duplicate. The layout responds to the card's own width (not the browser
 * window) - side-by-side on a wider card, and the item list itself
 * splitting into two columns once there's room for it. A numeric quantity
 * gets a one-tap down arrow to knock it down by one without opening the
 * edit form, greyed out once it reaches 1. When a snapshot_service is
 * configured (see the fridge-core README), a Save button copies the
 * current photo to a timestamped file and ◀ ▶/Latest controls browse back
 * through previously saved ones. An item can also be marked "in side door"
 * or "in freezer" by hand for something the camera can't see (e.g. a
 * fridge's side compartment or the freezer drawer) - it shows as a badge
 * next to quantity/condition instead of a detection frame, and drops any
 * existing box(es). A "Simple list" toggle in the header swaps the item
 * list for a compact name/quantity/place/brand/expiration line per item
 * with no badges - the pencil icon and the quantity down-arrow still work,
 * and the item's name turns red once it's expiring soon or overdue. A
 * search box above the list filters items by name in either mode. On a
 * mouse (not touch), hovering an item's row highlights its detection
 * frame(s) on the photo in orange, regardless of the "Detection frames"
 * toggle.
 *
 * https://github.com/jan-tdy/fridge-card
 */

const CARD_VERSION = "1.11.0";

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

// True for a real calendar date in "yyyy-mm-dd" form - rejects e.g.
// "2026-02-30", which the Date constructor would otherwise silently roll
// over to March 2nd instead of erroring.
function isValidISODate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

// Auto-inserts the "/" separators as the user types digits.
function maskDMYInput(raw) {
  const digits = String(raw || "").replace(/\D/g, "").slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += `/${digits.slice(2, 4)}`;
  if (digits.length > 4) out += `/${digits.slice(4, 8)}`;
  return out;
}

// fridge-core embeds each item's estimated location in the photo as a
// trailing "[[box:x1,y1,x2,y2]]" marker in the todo item's description
// (x/y are percentages 0-100 of the photo's width/height, top-left origin).
// A trailing ",m" (e.g. "[[box:12,34,26,41,m]]") marks a box drawn by hand
// on this card, which tells fridge-core to keep it as-is on the next scan
// instead of replacing it with a fresh AI guess. An optional further
// ",yyyy-mm-dd" (e.g. "[[box:12,34,26,41,m,2026-09-12]]", or
// "[[box:12,34,26,41,,2026-09-12]]" for a non-manual box) is that specific
// box's own expiration date - useful when the same item has several
// instances (different spots in the photo) that don't all expire together.
// An item can carry more than one box - e.g. a few of the same item sitting
// in different spots in the photo - so descriptions can hold several
// "[[box:...]]" markers. A fresh RegExp is built per call (rather than
// reusing one "g"-flagged instance) so stateful lastIndex never leaks
// between calls.
const BOX_MARKER_SRC =
  "\\[\\[box:\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*(m)?\\s*(?:,\\s*(\\d{4}-\\d{2}-\\d{2}))?)?\\s*\\]\\]";

function extractBoxes(description) {
  const re = new RegExp(BOX_MARKER_SRC, "g");
  const text = String(description || "");
  const boxes = [];
  let m;
  while ((m = re.exec(text))) {
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
    if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) continue;
    boxes.push({ x1, y1, x2, y2, manual: m[5] === "m", due: m[6] && isValidISODate(m[6]) ? m[6] : null });
  }
  return boxes;
}

function boxMarker(box) {
  let suffix = "";
  if (box.manual || box.due) {
    suffix = `,${box.manual ? "m" : ""}`;
    if (box.due) suffix += `,${box.due}`;
  }
  return `[[box:${box.x1},${box.y1},${box.x2},${box.y2}${suffix}]]`;
}

function stripBoxMarker(description) {
  return String(description || "")
    .replace(new RegExp(BOX_MARKER_SRC, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The brand is set by hand on the card and never touched by the AI (the
// fridge-core automation carries it forward across re-scans) - stored the
// same way as the box, as a trailing "[[brand:...]]" marker.
const BRAND_MARKER_RE = /\s*\[\[brand:([^\]]*)\]\]\s*/;

function extractBrand(description) {
  const m = BRAND_MARKER_RE.exec(String(description || ""));
  return m ? m[1].trim() : "";
}

function stripBrandMarker(description) {
  return String(description || "").replace(BRAND_MARKER_RE, " ").trim();
}

// Marks an item that's known to sit somewhere the camera can't see (e.g. a
// fridge's side door or the freezer compartment) - set entirely by hand,
// like the brand. Such an item never gets a meaningful AI-estimated box, so
// this shows as a badge next to quantity/condition instead of a detection
// frame on the photo.
const SIDE_DOOR_RE = /\s*\[\[sidedoor:1\]\]\s*/;

function extractSideDoor(description) {
  return SIDE_DOOR_RE.test(String(description || ""));
}

function stripSideDoorMarker(description) {
  return String(description || "").replace(SIDE_DOOR_RE, " ").trim();
}

// Same idea as sidedoor, for an item known to sit in the freezer
// compartment instead - also never visible to the fridge camera.
const FREEZER_RE = /\s*\[\[freezer:1\]\]\s*/;

function extractFreezer(description) {
  return FREEZER_RE.test(String(description || ""));
}

function stripFreezerMarker(description) {
  return String(description || "").replace(FREEZER_RE, " ").trim();
}

// Quantity, condition ("openness") and note are split into their own fields
// instead of one free-text description. Each has an AI marker (refreshed on
// every scan) and a "manual" marker - a trailing "m" on the key, e.g.
// "[[qtym:3 pieces]]" - written whenever the field is edited on the card, so
// fridge-core keeps the hand-typed value instead of overwriting it with a
// fresh (and possibly wrong) AI guess on the next scan. Same idea as the
// manually-drawn detection box. Confidence is purely informational (the AI's
// own estimate of its guess) and always reflects the latest scan.
const QTY_RE = /\s*\[\[qty(m)?:([^\]]*)\]\]\s*/;
const COND_RE = /\s*\[\[cond(m)?:([^\]]*)\]\]\s*/;
const NOTE_RE = /\s*\[\[note(m)?:([^\]]*)\]\]\s*/;
const CONF_RE = /\s*\[\[conf:([^\]]*)\]\]\s*/;

function extractField(re, description) {
  const m = re.exec(String(description || ""));
  if (!m) return null;
  return { value: m[2].trim(), manual: Boolean(m[1]) };
}

function fieldValue(extractFn, description) {
  const f = extractFn(description);
  return f ? f.value : "";
}

function fieldMarker(key, value, manual) {
  return `[[${key}${manual ? "m" : ""}:${value}]]`;
}

function stripField(re, description) {
  return String(description || "").replace(re, " ").trim();
}

function extractQty(description) {
  return extractField(QTY_RE, description);
}

function extractCond(description) {
  return extractField(COND_RE, description);
}

function extractConf(description) {
  const m = CONF_RE.exec(String(description || ""));
  return m ? m[1].trim() : "";
}

function stripAllFieldMarkers(description) {
  return stripField(CONF_RE, stripField(NOTE_RE, stripField(COND_RE, stripField(QTY_RE, description))));
}

function stripMarkers(description) {
  return stripAllFieldMarkers(stripFreezerMarker(stripSideDoorMarker(stripBrandMarker(stripBoxMarker(description)))));
}

// Legacy items (created before quantity/condition/note existed as separate
// fields) have their free text directly in the description with no markers
// at all - treat any of that leftover text as the note, so old items keep
// showing something instead of going blank.
function extractNote(description) {
  const marked = extractField(NOTE_RE, description);
  if (marked) return marked;
  const leftover = stripMarkers(description);
  return leftover ? { value: leftover, manual: false } : null;
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
      snapshot_service: "",
    };
  }

  static getConfigElement() {
    return document.createElement("fridge-card-editor");
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._items = [];
    this._eatenItems = [];
    this._eatenExpanded = false;
    this._itemsStateKey = null;
    this._editingUid = null;
    this._showBoxes = false;
    this._simpleMode = false;
    this._searchQuery = "";
    // uid of whichever item row the mouse is currently over (desktop only -
    // see the "mouseover"/"mouseout" listeners in _build) - highlights that
    // item's detection frame(s) on the photo in orange, regardless of the
    // "Detection frames" toggle. See _renderBoxes.
    this._hoveredUid = null;
    // Timestamp behind the currently-shown photo (entity last_changed, or a
    // manual "now" from a hard refresh) - see _updateImage/_hardRefreshImage.
    this._shownTs = null;
    // Saved-snapshot browsing (see _fetchHistory/_showHistory). _history is
    // a list of unix timestamps read from history/manifest.txt, newest
    // first; _historyIndex is -1 while viewing the live photo, or an index
    // into _history while browsing a saved one.
    this._history = [];
    this._historyIndex = -1;
    // Manual box drawing (draw-on-photo) state.
    this._drawingUid = null;
    this._drawActive = false;
    this._drawStart = null;
    this._drawCurrent = null;
    this._pendingBoxes = undefined; // undefined = untouched; array = the edit session's working set of boxes
    // Snapshot of the edit form's live field values, captured just before a
    // re-render that can happen mid-edit (e.g. finishing a hand-drawn box),
    // so in-progress typing isn't lost when the row's HTML is rebuilt.
    this._draft = null;
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
    this._eatenItems = [];
    this._eatenExpanded = false;
    this._itemsStateKey = null;
    this._editingUid = null;
    this._showBoxes = this._loadShowBoxes();
    this._simpleMode = this._loadSimpleMode();
    this._searchQuery = "";
    this._hoveredUid = null;
    this._shownTs = null;
    this._history = [];
    this._historyIndex = -1;
    this._drawingUid = null;
    this._drawActive = false;
    this._pendingBoxes = undefined;
    this._draft = null;
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

  // Simple mode swaps the item list for a plain name/qty/place/brand/expiry
  // line per item, dropping the AI-confidence/condition/sidedoor/freezer
  // badges - the pencil button still opens the same full edit form.
  _loadSimpleMode() {
    try {
      return localStorage.getItem(`fridge-card-simple-${this._config.todo_entity}`) === "1";
    } catch (e) {
      return false;
    }
  }

  _saveSimpleMode() {
    try {
      localStorage.setItem(`fridge-card-simple-${this._config.todo_entity}`, this._simpleMode ? "1" : "0");
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
    if (first) {
      this._fetchItems();
      if (this._config.snapshot_service) this._fetchHistory();
    }
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
    if (this._config.snapshot_service) this._fetchHistory();
  }

  _build() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="header">
          <div class="title"></div>
          <div class="header-actions">
            <button class="pill-btn save-btn" hidden>
              <ha-icon icon="mdi:content-save-outline"></ha-icon>
              <span>Save</span>
            </button>
            <button class="pill-btn latest-btn" hidden disabled>
              <span>Latest</span>
            </button>
            <button class="icon-btn refresh-btn" title="Refresh photo">
              <ha-icon icon="mdi:refresh"></ha-icon>
            </button>
            <button class="boxes-toggle" data-action="toggle-boxes" hidden>
              <ha-icon icon="mdi:vector-square"></ha-icon>
              <span>Detection frames</span>
            </button>
            <button class="boxes-toggle simple-toggle" title="Simple list">
              <ha-icon icon="mdi:format-list-bulleted"></ha-icon>
              <span>Simple list</span>
            </button>
          </div>
        </div>
        <div class="body">
          <div class="media-col">
            <div class="image-wrap">
              <img class="fridge-img" alt="Fridge contents" />
              <div class="detection-overlay"></div>
              <div class="history-badge" hidden></div>
              <button class="history-nav history-prev" hidden disabled title="Older">
                <ha-icon icon="mdi:chevron-left"></ha-icon>
              </button>
              <button class="history-nav history-next" hidden disabled title="Newer">
                <ha-icon icon="mdi:chevron-right"></ha-icon>
              </button>
              <div class="fallback">
                <ha-icon icon="mdi:image-off-outline"></ha-icon>
                <span>No image</span>
              </div>
            </div>
            <div class="status-row"></div>
          </div>
          <div class="list-col">
            <input class="item-search" type="text" placeholder="Search items…" />
            <div class="items"></div>
            <datalist id="brand-list"></datalist>
            <div class="add-row">
              <button class="add-btn">
                <ha-icon icon="mdi:plus"></ha-icon>
                <span>Add item</span>
              </button>
            </div>
            <div class="eaten-section" hidden>
              <button class="eaten-toggle">
                <ha-icon icon="mdi:chevron-right"></ha-icon>
                <span class="eaten-toggle-label">Eaten (0)</span>
              </button>
              <div class="eaten-list" hidden></div>
            </div>
          </div>
        </div>
      </ha-card>
    `;

    this._headerEl = root.querySelector(".header");
    this._titleEl = root.querySelector(".title");
    this._refreshBtnEl = root.querySelector(".refresh-btn");
    this._boxesToggleEl = root.querySelector(".boxes-toggle");
    this._simpleToggleEl = root.querySelector(".simple-toggle");
    this._imgEl = root.querySelector(".fridge-img");
    this._imageWrapEl = root.querySelector(".image-wrap");
    this._overlayEl = root.querySelector(".detection-overlay");
    this._fallbackEl = root.querySelector(".fallback");
    this._statusRowEl = root.querySelector(".status-row");
    this._searchInputEl = root.querySelector(".item-search");
    this._itemsEl = root.querySelector(".items");
    this._brandListEl = root.querySelector("#brand-list");
    this._eatenSectionEl = root.querySelector(".eaten-section");
    this._eatenToggleEl = root.querySelector(".eaten-toggle");
    this._eatenToggleLabelEl = root.querySelector(".eaten-toggle-label");
    this._eatenListEl = root.querySelector(".eaten-list");
    this._saveBtnEl = root.querySelector(".save-btn");
    this._latestBtnEl = root.querySelector(".latest-btn");
    this._historyPrevEl = root.querySelector(".history-prev");
    this._historyNextEl = root.querySelector(".history-next");
    this._historyBadgeEl = root.querySelector(".history-badge");

    this._titleEl.textContent = this._config.title || "";
    this._titleEl.style.display = this._config.title ? "" : "none";
    this._imageWrapEl.style.height = `${Number(this._config.image_height) || 220}px`;

    const hasSnapshotService = Boolean(this._config.snapshot_service);
    this._saveBtnEl.hidden = !hasSnapshotService;
    this._latestBtnEl.hidden = !hasSnapshotService;
    this._historyPrevEl.hidden = !hasSnapshotService;
    this._historyNextEl.hidden = !hasSnapshotService;
    this._saveBtnEl.addEventListener("click", () => this._saveSnapshot());
    this._latestBtnEl.addEventListener("click", () => this._showHistory(-1));
    this._historyPrevEl.addEventListener("click", () => this._showHistory(this._historyIndex + 1));
    this._historyNextEl.addEventListener("click", () => this._showHistory(this._historyIndex - 1));
    this._updateHistoryControls();

    this._boxesToggleEl.classList.toggle("active", this._showBoxes);
    this._boxesToggleEl.addEventListener("click", () => {
      this._showBoxes = !this._showBoxes;
      this._saveShowBoxes();
      this._boxesToggleEl.classList.toggle("active", this._showBoxes);
      this._renderBoxes();
    });
    this._simpleToggleEl.classList.toggle("active", this._simpleMode);
    this._simpleToggleEl.addEventListener("click", () => {
      this._simpleMode = !this._simpleMode;
      this._saveSimpleMode();
      this._simpleToggleEl.classList.toggle("active", this._simpleMode);
      this._renderItems();
    });
    this._refreshBtnEl.addEventListener("click", () => this._hardRefreshImage());
    this._eatenToggleEl.addEventListener("click", () => {
      this._eatenExpanded = !this._eatenExpanded;
      this._eatenToggleEl.classList.toggle("expanded", this._eatenExpanded);
      this._eatenListEl.hidden = !this._eatenExpanded;
      this._renderEatenSection();
    });
    this._eatenListEl.addEventListener("click", (e) => this._onEatenClick(e));
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
      if (!e.target.classList.contains("edit-due") && !e.target.classList.contains("box-due")) return;
      e.target.value = maskDMYInput(e.target.value);
    });
    // An item can be in the side door or the freezer, never both - checking
    // one unchecks the other instead of letting the save path write both
    // markers at once.
    this._itemsEl.addEventListener("change", (e) => {
      if (!e.target.checked) return;
      const itemEl = e.target.closest(".item");
      if (!itemEl) return;
      if (e.target.classList.contains("edit-sidedoor")) {
        const other = itemEl.querySelector(".edit-freezer");
        if (other) other.checked = false;
      } else if (e.target.classList.contains("edit-freezer")) {
        const other = itemEl.querySelector(".edit-sidedoor");
        if (other) other.checked = false;
      }
    });
    root.querySelector(".add-btn").addEventListener("click", () => this._addItem());
    this._searchInputEl.addEventListener("input", () => {
      this._searchQuery = this._searchInputEl.value.trim().toLowerCase();
      this._renderItems();
    });

    // Highlights an item's detection frame(s) on the photo in orange while
    // the mouse hovers its row, regardless of the "Detection frames"
    // toggle - desktop only (matchMedia guards against a touch device's
    // synthetic hover after a tap).
    this._itemsEl.addEventListener("mouseover", (e) => {
      if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
      const itemEl = e.target.closest(".item");
      if (!itemEl || itemEl.classList.contains("item-editing")) return;
      const uid = itemEl.dataset.uid;
      if (uid === this._hoveredUid) return;
      this._hoveredUid = uid;
      this._renderBoxes();
    });
    this._itemsEl.addEventListener("mouseout", (e) => {
      const itemEl = e.target.closest(".item");
      if (!itemEl || itemEl.contains(e.relatedTarget)) return;
      if (itemEl.dataset.uid !== this._hoveredUid) return;
      this._hoveredUid = null;
      this._renderBoxes();
    });

    this._imageWrapEl.addEventListener("pointerdown", (e) => this._onDrawStart(e));
    this._imageWrapEl.addEventListener("pointermove", (e) => this._onDrawMove(e));
    this._imageWrapEl.addEventListener("click", (e) => this._onImageClick(e));
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

  // The header always shows now that it also holds the photo refresh
  // button (useful regardless of title/detection-frames config).
  _updateHeaderVisibility() {
    if (!this._headerEl) return;
    this._headerEl.style.display = "";
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
      manual: true,
      due: null,
    };
    // Ignore accidental taps/tiny drags.
    if (box.x2 - box.x1 < 2 || box.y2 - box.y1 < 2) {
      this._renderBoxes();
      return;
    }
    // Adds to the working set rather than replacing it, so an item can carry
    // more than one box (e.g. a few of it sitting in different spots). Any
    // per-box due date already typed for the existing boxes is read out of
    // the form first, so it survives this re-render.
    const itemEl = this._itemsEl.querySelector(".item-editing");
    const editingItem = this._items.find((i) => i.uid === this._editingUid);
    const current = this._pendingBoxes !== undefined ? this._pendingBoxes : editingItem ? extractBoxes(editingItem.description) : [];
    this._pendingBoxes = [...this._syncBoxDraftDates(itemEl, current), box];
    this._captureDraft();
    this._renderItems();
  }

  // A plain tap/click on the photo (not a drag-to-draw) jumps straight to
  // editing whichever item's box contains that point - regardless of
  // whether detection frames are currently toggled on, since the box data
  // itself doesn't depend on that. Picks the smallest-area match if boxes
  // overlap; does nothing if the tap didn't land on any box.
  _onImageClick(e) {
    if (this._drawingUid) return; // let draw-on-photo handle its own click
    const pt = this._pointerToBoxPercent(e.clientX, e.clientY);
    let best = null;
    let bestArea = Infinity;
    for (const item of this._items) {
      for (const box of extractBoxes(item.description)) {
        const x1 = Math.min(box.x1, box.x2);
        const x2 = Math.max(box.x1, box.x2);
        const y1 = Math.min(box.y1, box.y2);
        const y2 = Math.max(box.y1, box.y2);
        if (pt.x < x1 || pt.x > x2 || pt.y < y1 || pt.y > y2) continue;
        const area = (x2 - x1) * (y2 - y1);
        if (area < bestArea) {
          bestArea = area;
          best = item;
        }
      }
    }
    if (!best || best.uid === this._editingUid) return;
    this._editingUid = best.uid;
    this._pendingBoxes = undefined;
    this._draft = null;
    this._drawingUid = null;
    this._imageWrapEl.classList.remove("drawing");
    this._renderItems();
    requestAnimationFrame(() => {
      const el = this._itemsEl.querySelector(".item-editing");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  // Reads whatever the user has currently typed in the open edit form and
  // stashes it, so a re-render triggered mid-edit (finishing a hand-drawn
  // box, clearing one) doesn't reset those fields back to the item's
  // last-saved values.
  _captureDraft() {
    const itemEl = this._itemsEl.querySelector(".item-editing");
    if (!itemEl) return;
    this._draft = {
      name: itemEl.querySelector(".edit-name").value,
      qty: itemEl.querySelector(".edit-qty").value,
      cond: itemEl.querySelector(".edit-cond").value,
      note: itemEl.querySelector(".edit-note").value,
      brand: itemEl.querySelector(".edit-brand").value,
      due: itemEl.querySelector(".edit-due").value,
      sideDoor: itemEl.querySelector(".edit-sidedoor").checked,
      freezer: itemEl.querySelector(".edit-freezer").checked,
    };
  }

  _boxDivHtml(box, variant, label) {
    const left = Math.min(box.x1, box.x2);
    const top = Math.min(box.y1, box.y2);
    const width = Math.abs(box.x2 - box.x1);
    const height = Math.abs(box.y2 - box.y1);
    const dueSuffix = box.due ? ` · ${formatDMY(new Date(`${box.due}T00:00:00`))}` : "";
    const labelHtml = label ? `<span class="detection-label">${escapeHtml(label + dueSuffix)}</span>` : "";
    const variantClass = variant ? ` ${variant}` : "";
    return `<div class="detection-box${variantClass}" style="left:${left}%; top:${top}%; width:${width}%; height:${height}%;">${labelHtml}</div>`;
  }

  // Draws one rectangle (with a truncated name tag) per AI-estimated or
  // hand-drawn box (see extractBoxes - an item can carry several) when
  // detection frames are toggled on, plus - always, regardless of the
  // toggle - every box in the working set of whichever item is currently
  // being edited, so the user can see what they're placing, plus - also
  // regardless of the toggle - the hovered item's box(es) in orange (see
  // the "mouseover"/"mouseout" listeners in _build).
  _renderBoxes() {
    if (!this._overlayEl) return;
    const withBoxes = this._items.flatMap((item) => extractBoxes(item.description).map((box) => ({ item, box })));

    this._boxesToggleEl.toggleAttribute("hidden", withBoxes.length === 0);
    this._updateHeaderVisibility();

    // A saved snapshot has its own overlay state (cleared by _showHistory) -
    // none of the live item list's boxes belong to it, including a hover
    // highlight.
    if (this._historyIndex !== -1) {
      this._overlayEl.innerHTML = "";
      return;
    }

    const parts = [];
    if (this._showBoxes) {
      for (const { item, box } of withBoxes) {
        if (item.uid === this._editingUid || item.uid === this._hoveredUid) continue; // handled below instead
        parts.push(this._boxDivHtml(box, "", item.summary));
      }
    }

    const editingItem = this._editingUid ? this._items.find((i) => i.uid === this._editingUid) : null;

    if (this._editingUid) {
      const boxes = this._pendingBoxes !== undefined ? this._pendingBoxes : editingItem ? extractBoxes(editingItem.description) : [];
      for (const box of boxes) parts.push(this._boxDivHtml(box, "pending", editingItem ? editingItem.summary : ""));
    }

    if (this._hoveredUid && this._hoveredUid !== this._editingUid) {
      const hoveredItem = this._items.find((i) => i.uid === this._hoveredUid);
      if (hoveredItem) {
        for (const box of extractBoxes(hoveredItem.description)) {
          parts.push(this._boxDivHtml(box, "hover", hoveredItem.summary));
        }
      }
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
          "pending",
          editingItem ? editingItem.summary : ""
        )
      );
    }

    this._overlayEl.innerHTML = parts.join("");
  }

  _updateImage() {
    if (this._historyIndex !== -1) return; // browsing a saved snapshot - leave it alone
    const cfg = this._config;
    let ts = null;
    if (cfg.image_entity) {
      const st = this._hass.states[cfg.image_entity];
      ts = st ? Math.floor(new Date(st.last_changed).getTime() / 1000) : Math.floor(Date.now() / 1000);
    }
    // Once a photo has been shown, only replace it for a genuinely newer
    // timestamp. Without this, a manual hard refresh (which jumps the
    // shown timestamp to "now") would get immediately undone by the very
    // next tick recomputing the same, unchanged entity/no-entity state.
    if (this._shownTs !== null) {
      if (ts === null || ts <= this._shownTs) return;
    }
    this._shownTs = ts;
    const url = ts !== null ? `${cfg.image_path}?v=${ts}` : cfg.image_path;
    if (this._imgEl.dataset.src !== url) {
      this._imgEl.dataset.src = url;
      this._imgEl.src = url;
    }
  }

  // Forces an immediate reload of the photo, bypassing both the browser
  // cache and the entity-timestamp cache-busting above - useful when a new
  // snapshot is ready on disk but the image_entity's last_changed hasn't
  // ticked (e.g. its state value happened not to change). Also backs out
  // of browsing a saved snapshot, if that's what's currently shown.
  _hardRefreshImage() {
    if (this._historyIndex !== -1) {
      this._historyIndex = -1;
      this._historyBadgeEl.hidden = true;
      this._renderBoxes();
      this._updateHistoryControls();
    }
    this._shownTs = Math.floor(Date.now() / 1000);
    const url = `${this._config.image_path}?v=${this._shownTs}`;
    this._imgEl.dataset.src = url;
    this._imgEl.src = url;
  }

  // The directory saved snapshots and their manifest live in, derived from
  // image_path (e.g. "/local/fridge/fridge_latest.jpg" -> ".../history").
  _historyBase() {
    const path = this._config.image_path || "";
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? `${path.slice(0, idx)}/history` : "history";
  }

  // Reads history/manifest.txt - one unix timestamp per line, appended to
  // by the shell_command each time Save runs (see fridge-core's README) -
  // as a plain text file the card fetches directly; no listing API needed.
  async _fetchHistory() {
    try {
      const res = await fetch(`${this._historyBase()}/manifest.txt`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      this._history = text
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => b - a);
    } catch (e) {
      this._history = [];
    }
    if (this._historyIndex >= this._history.length) this._historyIndex = -1;
    this._updateHistoryControls();
  }

  async _saveSnapshot() {
    if (!this._config.snapshot_service) return;
    const [domain, service] = this._config.snapshot_service.split(".");
    if (!domain || !service) return;
    this._saveBtnEl.disabled = true;
    try {
      await this._hass.callService(domain, service, {});
      // Give the shell command a moment to finish writing before re-reading
      // the manifest it just appended to.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await this._fetchHistory();
    } finally {
      this._saveBtnEl.disabled = false;
    }
  }

  // index -1 = live photo; 0..n-1 = that entry in _history (0 = most
  // recently saved). Out-of-range requests are clamped to the nearest end
  // instead of ignored, so holding the arrow down doesn't need per-click
  // bounds-checking at the call site.
  _showHistory(index) {
    if (!this._history.length && index !== -1) return;
    const clamped = Math.max(-1, Math.min(index, this._history.length - 1));
    this._historyIndex = clamped;
    if (clamped === -1) {
      this._exitHistoryView();
    } else {
      const ts = this._history[clamped];
      const url = `${this._historyBase()}/fridge_${ts}.jpg`;
      this._imgEl.dataset.src = url;
      this._imgEl.src = url;
      this._overlayEl.innerHTML = ""; // detection boxes belong to the live photo, not history
      this._historyBadgeEl.hidden = false;
      this._historyBadgeEl.textContent = new Date(ts * 1000).toLocaleString();
    }
    this._updateHistoryControls();
  }

  // Drops back to the live photo. Resets _shownTs so the immediate
  // _updateImage call below doesn't think it's already showing this
  // timestamp and skip reloading it.
  _exitHistoryView() {
    this._historyIndex = -1;
    this._historyBadgeEl.hidden = true;
    this._shownTs = null;
    this._updateImage();
    this._renderBoxes();
  }

  _updateHistoryControls() {
    if (!this._latestBtnEl) return;
    const atLive = this._historyIndex === -1;
    this._latestBtnEl.disabled = atLive;
    this._historyNextEl.disabled = atLive;
    this._historyPrevEl.disabled = this._historyIndex >= this._history.length - 1;
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
      const items = result.items || [];
      this._items = items.filter((i) => i.status !== "completed");
      this._eatenItems = items.filter((i) => i.status === "completed");
      this._renderItems();
    } catch (err) {
      this._itemsEl.innerHTML = `<div class="empty">Unable to load items: ${escapeHtml(err.message || err)}</div>`;
    }
  }

  _renderItems() {
    this._renderBrandList();
    this._renderEatenSection();
    if (!this._items.length) {
      this._itemsEl.innerHTML = `<div class="empty">No items recognized yet.</div>`;
      this._renderBoxes();
      return;
    }
    // The item currently being added/edited always stays visible, even if
    // its name doesn't match the search box, so a search doesn't yank the
    // open edit form out from under the user.
    const query = this._searchQuery;
    const filtered = query
      ? this._items.filter(
          (item) => item.uid === this._editingUid || (item.summary || "").toLowerCase().includes(query)
        )
      : this._items;
    if (!filtered.length) {
      this._itemsEl.innerHTML = `<div class="empty">No items match your search.</div>`;
      this._renderBoxes();
      return;
    }
    const sorted = [...filtered].sort((a, b) => {
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      if (a.due) return -1;
      if (b.due) return 1;
      return (a.summary || "").localeCompare(b.summary || "");
    });
    this._itemsEl.innerHTML = sorted.map((item) => this._itemRowHtml(item)).join("");
    this._renderBoxes();
  }

  // A collapsed-by-default "Eaten" section at the bottom, so marking
  // something eaten doesn't make it vanish for good - it can be restored
  // (back to needs_action) if that was a mistake or the item's back.
  _renderEatenSection() {
    if (!this._eatenSectionEl) return;
    const n = this._eatenItems.length;
    this._eatenSectionEl.hidden = n === 0;
    this._eatenToggleLabelEl.textContent = `Eaten (${n})`;
    if (!this._eatenExpanded) return;
    this._eatenListEl.innerHTML = this._eatenItems
      .map(
        (item) => `
        <div class="eaten-row" data-uid="${escapeHtml(item.uid)}">
          <span>${escapeHtml(item.summary)}</span>
          <button type="button" class="text-btn" data-action="restore-eaten">Restore</button>
        </div>`
      )
      .join("");
  }

  _onEatenClick(e) {
    const btn = e.target.closest("[data-action='restore-eaten']");
    if (!btn) return;
    const uid = e.target.closest(".eaten-row").dataset.uid;
    this._restoreEaten(uid);
  }

  async _restoreEaten(uid) {
    await this._hass.callService("todo", "update_item", {
      entity_id: this._config.todo_entity,
      item: uid,
      status: "needs_action",
    });
    await this._fetchItems();
  }

  // Offers every brand already used on some item as an autocomplete
  // suggestion on the Brand field, so it only has to be typed out once.
  _renderBrandList() {
    if (!this._brandListEl) return;
    const brands = [...new Set(this._items.map((i) => extractBrand(i.description)).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
    this._brandListEl.innerHTML = brands.map((b) => `<option value="${escapeHtml(b)}"></option>`).join("");
  }

  _itemRowHtml(item) {
    if (this._editingUid === item.uid) {
      const boxes = this._pendingBoxes !== undefined ? this._pendingBoxes : extractBoxes(item.description);
      // A draft (captured just before a mid-edit re-render, e.g. finishing
      // a hand-drawn box) always wins over the item's last-saved values,
      // so in-progress typing survives.
      const draft = this._draft;
      const nameVal = draft ? draft.name : item.summary;
      const qtyVal = draft ? draft.qty : fieldValue(extractQty, item.description);
      const condVal = draft ? draft.cond : fieldValue(extractCond, item.description);
      const noteVal = draft ? draft.note : fieldValue(extractNote, item.description);
      const brandVal = draft ? draft.brand : extractBrand(item.description);
      const sideDoorVal = draft ? draft.sideDoor : extractSideDoor(item.description);
      const freezerVal = draft ? draft.freezer : extractFreezer(item.description);
      const confVal = extractConf(item.description);
      const dueVal = draft
        ? draft.due
        : item.due
          ? formatDMY(new Date(item.due.length === 10 ? `${item.due}T00:00:00` : item.due))
          : "";
      return `
        <div class="item item-editing" data-uid="${escapeHtml(item.uid)}">
          <input class="edit-name" type="text" value="${escapeHtml(nameVal)}" placeholder="Item name" />
          <div class="field-grid">
            <input class="edit-qty" type="text" value="${escapeHtml(qtyVal)}" placeholder="Quantity (e.g. 2 pieces)" />
            <input class="edit-cond" type="text" value="${escapeHtml(condVal)}" placeholder="Condition (e.g. opened)" />
          </div>
          ${confVal ? `<div class="edit-conf">AI confidence: ${escapeHtml(confVal)}%</div>` : ""}
          <textarea class="edit-note" placeholder="Note">${escapeHtml(noteVal)}</textarea>
          <input class="edit-brand" type="text" list="brand-list" value="${escapeHtml(brandVal)}" placeholder="Brand (set by hand, AI won't touch it)" />
          <label class="sidedoor-row">
            <input class="edit-sidedoor" type="checkbox" ${sideDoorVal ? "checked" : ""} />
            In side door (camera can't see it)
          </label>
          <label class="sidedoor-row">
            <input class="edit-freezer" type="checkbox" ${freezerVal ? "checked" : ""} />
            In freezer (camera can't see it)
          </label>
          <input
            class="edit-due"
            type="text"
            inputmode="numeric"
            maxlength="10"
            placeholder="dd/mm/yyyy"
            value="${escapeHtml(dueVal)}"
          />
          <div class="frame-row">
            <span>${boxes.length ? `${boxes.length} detection frame${boxes.length === 1 ? "" : "s"}` : "No detection frame set"}</span>
            <div class="frame-actions">
              <button type="button" class="text-btn" data-action="draw-box">Add box</button>
            </div>
          </div>
          ${
            boxes.length
              ? `<div class="frame-list">
                  ${boxes
                    .map((b, i) => {
                      const boxDueVal = b.due ? formatDMY(new Date(`${b.due}T00:00:00`)) : "";
                      return `
                    <span class="frame-chip">
                      <span>Frame ${i + 1}</span>
                      <input class="box-due" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yyyy" data-index="${i}" value="${escapeHtml(boxDueVal)}" />
                      <button type="button" class="frame-remove" data-action="remove-box" data-index="${i}" title="Remove this frame">✕</button>
                    </span>`;
                    })
                    .join("")}
                </div>`
              : ""
          }
          <div class="edit-actions">
            <button class="text-btn danger" data-action="delete-item">Delete</button>
            <button class="text-btn" data-action="cancel-edit">Cancel</button>
            <button class="text-btn primary" data-action="save-item">Save</button>
          </div>
        </div>
      `;
    }

    const info = dueInfo(item.due);
    const qty = fieldValue(extractQty, item.description);
    const cond = fieldValue(extractCond, item.description);
    const note = fieldValue(extractNote, item.description);
    const conf = extractConf(item.description);
    const brand = extractBrand(item.description);
    const sideDoor = extractSideDoor(item.description);
    const freezer = extractFreezer(item.description);
    const qtyNumMatch = qty.match(/^(\d+)/);
    const qtyNum = qtyNumMatch ? Number(qtyNumMatch[1]) : null;

    if (this._simpleMode) {
      const place = sideDoor ? "Side door" : freezer ? "Freezer" : "Fridge";
      const isWarn = Boolean(info && info.cls);
      const parts = [];
      if (qty) {
        parts.push(
          `<span>${escapeHtml(qty)}${
            qtyNum !== null
              ? `<button type="button" class="qty-dec-btn" data-action="decrement-qty" ${qtyNum <= 1 ? "disabled" : ""} title="One less">
                  <ha-icon icon="mdi:chevron-down"></ha-icon>
                </button>`
              : ""
          }</span>`
        );
      }
      parts.push(escapeHtml(place));
      if (brand) parts.push(escapeHtml(brand));
      if (info) parts.push(`<span class="${isWarn ? "simple-name-warn" : ""}">${escapeHtml(info.label)}</span>`);
      const line = parts.join(" · ");
      return `
        <div class="item item-simple" data-uid="${escapeHtml(item.uid)}">
          <div class="simple-line">
            <strong class="${isWarn ? "simple-name-warn" : ""}">${escapeHtml(item.summary)}</strong>${line ? ` — ${line}` : ""}
          </div>
          <button class="icon-btn edit-btn" data-action="edit-item" title="Edit">
            <ha-icon icon="mdi:pencil-outline"></ha-icon>
          </button>
        </div>
      `;
    }

    return `
      <div class="item" data-uid="${escapeHtml(item.uid)}">
        <button class="icon-btn eaten-btn" data-action="mark-eaten" title="Mark as eaten">
          <ha-icon icon="mdi:checkbox-blank-circle-outline"></ha-icon>
        </button>
        <div class="item-main">
          <div class="item-name">${escapeHtml(item.summary)}</div>
          ${
            qty || cond || conf || sideDoor || freezer
              ? `<div class="item-meta">
                  ${
                    qty
                      ? `<span class="meta-chip"><ha-icon icon="mdi:counter"></ha-icon>${escapeHtml(qty)}${
                          qtyNum !== null
                            ? `<button type="button" class="qty-dec-btn" data-action="decrement-qty" ${qtyNum <= 1 ? "disabled" : ""} title="One less">
                                <ha-icon icon="mdi:chevron-down"></ha-icon>
                              </button>`
                            : ""
                        }</span>`
                      : ""
                  }
                  ${cond ? `<span class="meta-chip"><ha-icon icon="mdi:package-variant-closed"></ha-icon>${escapeHtml(cond)}</span>` : ""}
                  ${conf ? `<span class="meta-chip meta-conf">${escapeHtml(conf)}%</span>` : ""}
                  ${sideDoor ? `<span class="meta-chip" title="Not visible to the camera - no detection frame"><ha-icon icon="mdi:door"></ha-icon>Side door</span>` : ""}
                  ${freezer ? `<span class="meta-chip" title="Not visible to the camera - no detection frame"><ha-icon icon="mdi:snowflake"></ha-icon>Freezer</span>` : ""}
                </div>`
              : ""
          }
          ${note ? `<div class="item-desc">${escapeHtml(note)}</div>` : ""}
          ${brand ? `<div class="item-brand"><ha-icon icon="mdi:tag-outline"></ha-icon>${escapeHtml(brand)}</div>` : ""}
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
      this._pendingBoxes = undefined;
      this._draft = null;
      this._renderItems();
    } else if (action === "cancel-edit") {
      this._editingUid = null;
      this._pendingBoxes = undefined;
      this._draft = null;
      this._drawingUid = null;
      this._imageWrapEl.classList.remove("drawing");
      if (uid === "__new__") this._items = this._items.filter((i) => i.uid !== "__new__");
      this._renderItems();
    } else if (action === "delete-item") {
      this._deleteItem(uid);
    } else if (action === "mark-eaten") {
      this._markEaten(uid);
    } else if (action === "decrement-qty") {
      this._decrementQty(uid);
    } else if (action === "save-item") {
      this._saveItem(uid, itemEl);
    } else if (action === "draw-box") {
      this._drawingUid = uid;
      this._imageWrapEl.classList.add("drawing");
      this._renderBoxes();
    } else if (action === "remove-box") {
      const idx = Number(btn.dataset.index);
      const item = this._items.find((i) => i.uid === uid);
      const current = this._pendingBoxes !== undefined ? this._pendingBoxes : item ? extractBoxes(item.description) : [];
      this._pendingBoxes = this._syncBoxDraftDates(itemEl, current).filter((_, i) => i !== idx);
      this._captureDraft();
      this._renderItems();
    }
  }

  // Reads whatever per-box due-date inputs are currently in the open edit
  // form and merges them onto the matching box (by index) - same rule as
  // the item-level due field: empty clears the date, non-empty-but-
  // unparseable text is left alone rather than risking wiping it over a
  // typo. Called before any mutation that would re-render the box list
  // (adding/removing a box, or saving), so in-progress typing isn't lost.
  _syncBoxDraftDates(itemEl, boxes) {
    if (!itemEl) return boxes;
    return boxes.map((box, i) => {
      const input = itemEl.querySelector(`.box-due[data-index="${i}"]`);
      if (!input) return box;
      const text = input.value.trim();
      if (text === "") return { ...box, due: null };
      const due = parseDMY(text);
      return due !== null ? { ...box, due } : box;
    });
  }

  _addItem() {
    if (this._items.some((i) => i.uid === "__new__")) return;
    this._editingUid = "__new__";
    this._pendingBoxes = undefined;
    this._draft = null;
    this._items = [{ uid: "__new__", summary: "", description: "", due: null }, ...this._items];
    this._renderItems();
    requestAnimationFrame(() => {
      const el = this._itemsEl.querySelector(".item-editing .edit-name");
      if (el) el.focus();
    });
  }

  async _saveItem(uid, itemEl) {
    const name = itemEl.querySelector(".edit-name").value.trim();
    const qty = itemEl.querySelector(".edit-qty").value.trim();
    const cond = itemEl.querySelector(".edit-cond").value.trim();
    const note = itemEl.querySelector(".edit-note").value.trim();
    const brand = itemEl.querySelector(".edit-brand").value.trim();
    const sideDoor = itemEl.querySelector(".edit-sidedoor").checked;
    const freezer = itemEl.querySelector(".edit-freezer").checked;
    const dueText = itemEl.querySelector(".edit-due").value.trim();
    const due = dueText ? parseDMY(dueText) : null;
    if (!name) return;

    // The edited/added/removed frames win; otherwise carry the item's
    // existing [[box:...]] markers forward (editing the description strips
    // them for display, so they'd otherwise be lost until the next scan).
    // An item in the side door or freezer has no meaningful box - the
    // camera can't see it there - so marking it drops every frame instead
    // of keeping stale ones.
    const existing = this._items.find((i) => i.uid === uid);
    const existingBoxes = existing ? extractBoxes(existing.description) : [];
    const existingConf = existing ? extractConf(existing.description) : "";
    const boxes =
      sideDoor || freezer
        ? []
        : this._syncBoxDraftDates(itemEl, this._pendingBoxes !== undefined ? this._pendingBoxes : existingBoxes);

    // Quantity/condition/note are always written back through the "manual"
    // marker when saved from the card - same idea as a hand-drawn detection
    // box - so fridge-core keeps a hand-typed correction instead of
    // overwriting it with a fresh (and possibly wrong) AI guess on the next
    // scan. Confidence is purely informational and only ever set by the AI,
    // so an edit just carries the existing value forward unchanged.
    const parts = [];
    if (qty) parts.push(fieldMarker("qty", qty, true));
    if (cond) parts.push(fieldMarker("cond", cond, true));
    if (note) parts.push(fieldMarker("note", note, true));
    if (existingConf) parts.push(`[[conf:${existingConf}]]`);
    for (const box of boxes) parts.push(boxMarker(box));
    if (brand) {
      // Strip brackets so the value can't break out of the [[brand:...]] marker.
      parts.push(`[[brand:${brand.replace(/[[\]]/g, "")}]]`);
    }
    if (sideDoor) parts.push("[[sidedoor:1]]");
    if (freezer) parts.push("[[freezer:1]]");
    const description = parts.join(" ");

    try {
      if (uid === "__new__") {
        // Adding a new item under a name that's already sitting in the
        // Eaten section is probably the same item again (a refill, or it
        // was marked eaten by mistake) - offer to restore that one instead
        // of quietly creating a duplicate.
        const eatenMatch = this._eatenItems.find(
          (i) => (i.summary || "").trim().toLowerCase() === name.toLowerCase()
        );
        if (
          eatenMatch &&
          confirm(`"${name}" is already in the Eaten list. Restore it instead of adding a duplicate?`)
        ) {
          const payload = {
            entity_id: this._config.todo_entity,
            item: eatenMatch.uid,
            rename: name,
            description,
            status: "needs_action",
          };
          if (due) payload.due_date = due;
          await this._hass.callService("todo", "update_item", payload);
        } else {
          const payload = { entity_id: this._config.todo_entity, item: name };
          if (description) payload.description = description;
          if (due) payload.due_date = due;
          await this._hass.callService("todo", "add_item", payload);
        }
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
      this._pendingBoxes = undefined;
      this._draft = null;
      await this._fetchItems();
    }
  }

  // Marks an item completed instead of deleting it outright - a quicker,
  // checkbox-like "I ate this" gesture. It moves out of the active list
  // into the "Eaten" section below (see _renderEatenSection) instead of
  // being gone for good, and fridge-core reactivates it by name instead of
  // adding a duplicate if it turns out the item is still in the fridge.
  async _markEaten(uid) {
    await this._hass.callService("todo", "update_item", {
      entity_id: this._config.todo_entity,
      item: uid,
      status: "completed",
    });
    await this._fetchItems();
  }

  // One tap to knock a numeric quantity down by one (e.g. "3 kusy" -> "2
  // kusy") without opening the edit form - stops at 1 (the button is
  // disabled in _itemRowHtml at that point; use "eaten" for the last one).
  // Written back through the "manual" qty marker, same as any other
  // card edit, so fridge-core keeps it instead of overwriting it with a
  // fresh AI guess; every other field is carried forward unchanged.
  async _decrementQty(uid) {
    const item = this._items.find((i) => i.uid === uid);
    if (!item) return;
    const qty = extractQty(item.description);
    if (!qty) return;
    const m = qty.value.match(/^(\d+)(.*)$/);
    if (!m) return;
    const n = Number(m[1]);
    if (n <= 1) return;
    const newQty = `${n - 1}${m[2]}`;

    const cond = extractCond(item.description);
    // extractNote (not the raw marker) so a legacy item's plain free text -
    // not yet captured by a [[note:...]] marker - doesn't get silently
    // dropped just because its quantity was decremented.
    const note = extractNote(item.description);
    const conf = extractConf(item.description);
    const brand = extractBrand(item.description);
    const boxes = extractBoxes(item.description);
    const sideDoor = extractSideDoor(item.description);
    const freezer = extractFreezer(item.description);

    const parts = [fieldMarker("qty", newQty, true)];
    if (cond) parts.push(fieldMarker("cond", cond.value, cond.manual));
    if (note) parts.push(fieldMarker("note", note.value, note.manual));
    if (conf) parts.push(`[[conf:${conf}]]`);
    for (const box of boxes) parts.push(boxMarker(box));
    if (brand) parts.push(`[[brand:${brand.replace(/[[\]]/g, "")}]]`);
    if (sideDoor) parts.push("[[sidedoor:1]]");
    if (freezer) parts.push("[[freezer:1]]");

    await this._hass.callService("todo", "update_item", {
      entity_id: this._config.todo_entity,
      item: uid,
      description: parts.join(" "),
    });
    await this._fetchItems();
  }

  async _deleteItem(uid) {
    this._pendingBoxes = undefined;
    this._draft = null;
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
      :host { display: block; container-type: inline-size; container-name: fridge-card; }
      ha-card { padding: 16px; overflow: hidden; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
      .body { display: flex; flex-direction: column; gap: 14px; }
      .media-col { display: flex; flex-direction: column; }
      .list-col { min-width: 0; }
      .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .refresh-btn ha-icon { --mdc-icon-size: 18px; }
      .title { font-size: 1.2rem; font-weight: 600; color: var(--primary-text-color); }
      .icon-btn { border: none; background: var(--secondary-background-color, rgba(0,0,0,0.06)); color: var(--primary-text-color); width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .15s ease; flex-shrink: 0; }
      .icon-btn:hover { background: var(--divider-color, rgba(0,0,0,0.12)); }
      .boxes-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; border: none; background: var(--secondary-background-color, rgba(0,0,0,0.06)); color: var(--secondary-text-color); font-size: 0.8rem; font-family: inherit; cursor: pointer; flex-shrink: 0; transition: background .15s ease, color .15s ease; }
      .boxes-toggle ha-icon { --mdc-icon-size: 16px; }
      .boxes-toggle:hover { background: var(--divider-color, rgba(0,0,0,0.12)); }
      .boxes-toggle.active { background: var(--error-color, #f44336); color: var(--text-primary-color, #fff); }
      .pill-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; border: none; background: var(--secondary-background-color, rgba(0,0,0,0.06)); color: var(--secondary-text-color); font-size: 0.8rem; font-family: inherit; cursor: pointer; flex-shrink: 0; transition: background .15s ease, color .15s ease; }
      .pill-btn ha-icon { --mdc-icon-size: 16px; }
      .pill-btn:hover:not(:disabled) { background: var(--divider-color, rgba(0,0,0,0.12)); }
      .pill-btn:disabled { opacity: 0.4; cursor: default; }
      .image-wrap { position: relative; border-radius: 12px; overflow: hidden; background: var(--secondary-background-color, #eee); margin-bottom: 14px; }
      .image-wrap.drawing { cursor: crosshair; user-select: none; touch-action: none; }
      .image-wrap.drawing::after { content: 'Drag on the photo to mark the item'; position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); background: rgba(0,0,0,0.65); color: #fff; font-size: 0.7rem; padding: 4px 10px; border-radius: 999px; pointer-events: none; white-space: nowrap; z-index: 2; }
      .fridge-img { position: absolute; top: 50%; left: 50%; transition: transform .25s ease, width .25s ease, height .25s ease; }
      .detection-overlay { position: absolute; top: 50%; left: 50%; pointer-events: none; transition: transform .25s ease, width .25s ease, height .25s ease; }
      .detection-box { position: absolute; border: 2px solid #ff3b3b; border-radius: 3px; box-shadow: 0 0 0 1px rgba(0,0,0,0.35); }
      .detection-box.pending { border-color: #2196f3; border-style: dashed; background: rgba(33,150,243,0.1); }
      .detection-label { position: absolute; top: 0; left: 0; max-width: 130px; background: #ff3b3b; color: #fff; font-size: 11px; font-weight: 600; line-height: 1.5; padding: 1px 6px; border-radius: 0 0 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .detection-box.pending .detection-label { background: #2196f3; }
      .detection-box.hover { border-color: #ff9800; box-shadow: 0 0 0 1px rgba(0,0,0,0.35), 0 0 0 2px rgba(255,152,0,0.35); }
      .detection-box.hover .detection-label { background: #ff9800; }
      .fallback { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 6px; color: var(--secondary-text-color); font-size: 0.85rem; }
      .fallback.show { display: flex; }
      .fallback ha-icon { --mdc-icon-size: 32px; }
      .history-nav { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; border: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; background: rgba(0,0,0,0.45); color: #fff; transition: background .15s ease, opacity .15s ease; }
      .history-nav:hover:not(:disabled) { background: rgba(0,0,0,0.65); }
      .history-nav:disabled { opacity: 0.25; cursor: default; }
      .history-prev { left: 8px; }
      .history-next { right: 8px; }
      .history-badge { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 2; background: rgba(0,0,0,0.65); color: #fff; font-size: 0.7rem; padding: 4px 10px; border-radius: 999px; white-space: nowrap; pointer-events: none; }
      .status-row { display: flex; flex-wrap: nowrap; gap: 8px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
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
      .item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.08)); }
      .item:last-child { border-bottom: none; }
      .eaten-btn { margin-top: 2px; }
      .eaten-btn ha-icon { --mdc-icon-size: 20px; }
      .item-main { min-width: 0; flex: 1 1 auto; }
      .item-name { font-weight: 600; color: var(--primary-text-color); }
      .item-desc { font-size: 0.85rem; color: var(--secondary-text-color); margin-top: 2px; overflow-wrap: anywhere; }
      .item-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
      .meta-chip { display: inline-flex; align-items: center; gap: 3px; font-size: 0.7rem; font-weight: 600; color: var(--secondary-text-color); background: var(--secondary-background-color, rgba(0,0,0,0.06)); padding: 2px 7px; border-radius: 999px; }
      .meta-chip ha-icon { --mdc-icon-size: 13px; }
      .qty-dec-btn { border: none; background: none; padding: 0; margin: 0 0 0 1px; display: inline-flex; align-items: center; cursor: pointer; color: inherit; }
      .qty-dec-btn ha-icon { --mdc-icon-size: 13px; }
      .qty-dec-btn:hover:not(:disabled) { color: var(--primary-color); }
      .qty-dec-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .meta-chip.meta-conf { color: var(--primary-color); }
      .item-brand { display: inline-flex; align-items: center; gap: 3px; font-size: 0.75rem; font-weight: 600; color: var(--primary-color); margin-top: 4px; }
      .item-brand ha-icon { --mdc-icon-size: 14px; }
      .item-side { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .due-chip { font-size: 0.75rem; padding: 3px 8px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space: nowrap; }
      .due-chip.due-soon { background: rgba(255,193,7,0.18); color: #b98900; }
      .due-chip.due-overdue { background: rgba(var(--rgb-error-color, 244,67,54), 0.14); color: var(--error-color, #f44336); }
      .edit-btn ha-icon { --mdc-icon-size: 18px; }
      .empty { padding: 16px 4px; color: var(--secondary-text-color); font-size: 0.9rem; text-align: center; }
      .item-editing { flex-direction: column; align-items: stretch; gap: 8px; background: var(--secondary-background-color, rgba(0,0,0,0.04)); border-radius: 10px; padding: 12px; border-bottom: none; margin-bottom: 8px; }
      .item-editing input, .item-editing textarea { font-family: inherit; font-size: 0.9rem; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--divider-color, rgba(0,0,0,0.15)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
      .item-editing textarea { resize: vertical; min-height: 50px; }
      .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .edit-conf { font-size: 0.75rem; color: var(--secondary-text-color); }
      .sidedoor-row { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--secondary-text-color); }
      .sidedoor-row input { width: auto; padding: 0; }
      .item-simple { align-items: center; gap: 8px; }
      .simple-line { flex: 1; min-width: 0; font-size: 0.85rem; color: var(--primary-text-color); overflow-wrap: anywhere; }
      .simple-line strong { font-weight: 600; }
      .simple-name-warn { color: var(--error-color, #f44336) !important; }
      .frame-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.8rem; color: var(--secondary-text-color); }
      .frame-actions { display: flex; gap: 4px; flex-shrink: 0; }
      .frame-actions .text-btn { padding: 4px 10px; }
      .frame-list { display: flex; flex-direction: column; gap: 4px; }
      .frame-chip { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--secondary-text-color); background: var(--card-background-color, rgba(0,0,0,0.03)); border-radius: 8px; padding: 4px 8px; }
      .frame-chip > span:first-child { flex-shrink: 0; }
      .box-due { flex: 1; min-width: 0; font-size: 0.78rem !important; padding: 4px 6px !important; }
      .frame-remove { border: none; background: none; color: var(--error-color, #f44336); cursor: pointer; font-size: 0.85rem; padding: 2px 4px; flex-shrink: 0; }
      .frame-remove:hover { background: var(--divider-color, rgba(0,0,0,0.1)); border-radius: 4px; }
      .edit-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .text-btn { border: none; background: none; padding: 6px 12px; border-radius: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer; color: var(--primary-text-color); font-family: inherit; }
      .text-btn:hover { background: var(--divider-color, rgba(0,0,0,0.1)); }
      .text-btn.primary { color: var(--primary-color); }
      .text-btn.danger { color: var(--error-color, #f44336); margin-right: auto; }
      .add-row { margin-top: 6px; }
      .item-search { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 0.85rem; padding: 8px 10px; margin-bottom: 8px; border-radius: 8px; border: 1px solid var(--divider-color, rgba(0,0,0,0.15)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
      .add-btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px; border-radius: 10px; border: 1px dashed var(--divider-color, rgba(0,0,0,0.2)); background: none; color: var(--secondary-text-color); font-family: inherit; font-size: 0.9rem; cursor: pointer; transition: background .15s ease, color .15s ease; }
      .add-btn:hover { background: var(--secondary-background-color, rgba(0,0,0,0.05)); color: var(--primary-text-color); }
      .eaten-section { margin-top: 10px; }
      .eaten-toggle { display: flex; align-items: center; gap: 4px; padding: 6px 4px; border: none; background: none; color: var(--secondary-text-color); font-family: inherit; font-size: 0.85rem; cursor: pointer; width: 100%; text-align: left; }
      .eaten-toggle ha-icon { --mdc-icon-size: 18px; transition: transform .15s ease; }
      .eaten-toggle.expanded ha-icon { transform: rotate(90deg); }
      .eaten-list { display: flex; flex-direction: column; margin-top: 2px; }
      .eaten-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 4px; font-size: 0.85rem; color: var(--secondary-text-color); border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.06)); }
      .eaten-row:last-child { border-bottom: none; }
      /* Placed last so these win the cascade over the unconditional rules
         above regardless of source order within a matching @container.
         Roughly 2+ columns of a Home Assistant sections grid: photo moves
         to a fixed-width left column, items take the rest on the right. */
      @container fridge-card (min-width: 520px) {
        .body { flex-direction: row; align-items: flex-start; }
        .media-col { flex: 0 0 240px; }
        .list-col { flex: 1 1 auto; }
      }
      /* Roughly 4+ columns: enough room for the items themselves to flow
         into two columns instead of one long list. */
      @container fridge-card (min-width: 820px) {
        .items { display: grid; grid-template-columns: repeat(2, 1fr); align-items: start; gap: 0 16px; }
        .items .item-editing { grid-column: 1 / -1; }
      }
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
      { name: "snapshot_service", selector: { text: {} } },
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
      snapshot_service: "Save-snapshot service (e.g. shell_command.fridge_save_snapshot) - optional, enables Save/history browsing",
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
