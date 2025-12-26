// ==UserScript==
// @name         Amazon Driver Snapshot (IN-PAGE Drawer + Copy Nth Remaining Stop Address + Auto-Back)
// @namespace    https://github.com/onth/scripts
// @version      1.9.5
// @description  In-page Driver Snapshot drawer.  Click driver → open itinerary → hide completed → copy Nth *remaining* stop address (default 5) → auto-back.
// @match        https://logistics.amazon.com/operations/execution/itineraries*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Joeybs/onth-driver-snapshot-clean/main/amazon-driver-snapshot.user.js
// @downloadURL  https://raw.githubusercontent.com/Joeybs/onth-driver-snapshot-clean/main/amazon-driver-snapshot. user.js
// ==/UserScript==

(function () {
  "use strict";

  // ============================================================================
  // CONSTANTS & CONFIGURATION
  // ============================================================================

  const SELECTORS = {
    rows: '[data-testid="allow-text-selection-div"]',
    scrollPanel: ". fp-page-template",
    projectedRTS: ["[data-testid='projected-rts']", "[data-attr='projected-rts']"],
    avgPerHour: ["[data-testid='avg-stops-per-hour']", "[data-attr='avg-stops-per-hour']"],
    lastHourPace: ["[data-testid='last-hour-pace']", "[data-attr='last-hour-pace']"],
  };

  const RX = {
    phone: /(\+?\d[\d\s().-]{7,}\d)/,
    time12h: /\b\d{1,2}:\d{2}\s*[APMapm]{2}\b/,
    avg:  /\bAvg(? :\. |\s+stops\/hour|\s*\/\s*hr)?\s*[:\-]?\s*(-?\d+(?:\.\d+)?)/i,
    pace: /\b(? : Pace|Last\s*(? :hr|hour))\s*[:\-]?\s*(-?\d+(?:\.\d+)?)/i,
    rts: /\bProjected\s*RTS\s*[:\-]?\s*([0-9]{1,2}:[0-9]{2}\s*[APMapm]{2})\b/i,
    rtsAlt: /\bRTS\s*[:\-]?\s*([0-9]{1,2}:[0-9]{2}\s*[APMapm]{2})\b/i,
    numVal: /-?\d+(?:\.\d+)?/,
    zip: /\b\d{5}(-\d{4})?\b/,
    stopsPair: /(\d+)\s*\/\s*(\d+)\s*stops/i,
  };

  const CONFIG = {
    MAX_CACHE_SIZE: 500,
    DEFAULT_STOP_N: 5,
    MAX_SCROLL_LOOPS: 160,
    STAGNANT_THRESHOLD: 7,
    BASE_SLEEP:  120,
    RETRY_ATTEMPTS: 3,
    VERSION: "1.9.5",
  };

  // ============================================================================
  // LOGGING
  // ============================================================================

  const log = {
    info:  (msg, ... args) => console.log(`[ONTH] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[ONTH] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ONTH] ${msg}`, ...args),
  };

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").toLowerCase().trim();
  const firstLine = (t = "") => (t. split("\n")[0] || "").trim();
  const digits = (s) => String(s || "").replace(/\D+/g, "");

  const num = (t) => {
    const m = String(t || "").match(RX.numVal);
    return m ? Number(m[0]) : null;
  };

  const one = (t, ... rxs) => {
    t = String(t || "");
    for (const rx of rxs) {
      const m = t.match(rx);
      if (m) return m[1]. trim();
    }
    return null;
  };

  const readViaSel = (root, arr) => {
    for (const sel of arr || []) {
      const el = root.querySelector(sel);
      if (el?. innerText) return el.innerText.trim();
    }
    return null;
  };

  const tidyPhone = (s) =>
    String(s || "")
      .replace(/^[^\d+]*(\+? [\d(]. *)$/, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();

  const cssEscape =
    window.CSS && typeof window.CSS.escape === "function"
      ? window.CSS.escape. bind(window. CSS)
      : (s) => String(s).replace(/[^\w-]/g, "\\$&");

  const escAttr = (v) => String(v ??  "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const escHtml = (v) => {
    const div = document.createElement("div");
    div.textContent = String(v ?? "");
    return div.innerHTML;
  };

  // ============================================================================
  // MUTEX CLASS
  // ============================================================================

  class Mutex {
    constructor() {
      this._locked = false;
      this._queue = [];
    }

    async lock() {
      while (this._locked) {
        await new Promise((resolve) => this._queue.push(resolve));
      }
      this._locked = true;
    }

    unlock() {
      this._locked = false;
      const resolve = this._queue.shift();
      if (resolve) resolve();
    }

    get isLocked() {
      return this._locked;
    }
  }

  const globalMutex = new Mutex();

  // ============================================================================
  // LRU CACHE CLASS
  // ============================================================================

  class LRUCache {
    constructor(maxSize = CONFIG.MAX_CACHE_SIZE) {
      this._cache = new Map();
      this._maxSize = maxSize;
    }

    get(key) {
      if (! this._cache.has(key)) return undefined;
      const value = this._cache.get(key);
      this._cache.delete(key);
      this._cache.set(key, value);
      return value;
    }

    set(key, value) {
      if (this._cache. has(key)) this._cache.delete(key);
      else if (this._cache. size >= this._maxSize) {
        const firstKey = this._cache.keys().next().value;
        this._cache.delete(firstKey);
      }
      this._cache.set(key, value);
    }

    has(key) {
      return this._cache.has(key);
    }

    clear() {
      this._cache. clear();
    }

    get size() {
      return this._cache.size;
    }
  }

  // ============================================================================
  // TOAST NOTIFICATIONS
  // ============================================================================

  let toastTimeout;

  function toast(msg, ok = null) {
    let d = document.getElementById("__onth_snap_toast__");
    if (!d) {
      d = document.createElement("div");
      d.id = "__onth_snap_toast__";
      d.setAttribute("role", "status");
      d.setAttribute("aria-live", "polite");
      d.style.cssText = [
        "position: fixed;right:16px;bottom:16px;z-index: 2147483647",
        "background:#0b1220;color:#e5e7eb;border: 1px solid rgba(255,255,255,. 12)",
        "padding:10px 12px;border-radius:10px;opacity:0;transform:translateY(10px)",
        "transition:. 18s;pointer-events:none;max-width:62vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
        "box-shadow:0 10px 30px rgba(0,0,0,.35)",
      ].join(";");
      document.body.appendChild(d);
    }
    const icon = ok === true ? "✅ " : ok === false ? "❌ " : "🟦 ";
    d.textContent = icon + msg;
    d.style.opacity = "1";
    d.style.transform = "translateY(0)";
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      d.style.opacity = "0";
      d.style.transform = "translateY(10px)";
    }, 1300);
  }

  // ============================================================================
  // ADDRESS CLEANING
  // ============================================================================

  function cleanAddress(raw) {
    const txt = String(raw || "").replace(/\r/g, "\n");
    const lines = txt
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const keep = lines. filter(
      (l) => !/^edit in/i.test(l) && !/^driver aid/i.test(l) && !/geostudio/i.test(l)
    );
    const hasZip = (s) => RX.zip.test(String(s || ""));

    if (keep.length >= 2 && ! hasZip(keep[0]) && hasZip(keep[1]))
      return `${keep[0]}, ${keep[1]}`.trim();

    for (const l of keep) {
      if (hasZip(l) && /,/.test(l)) {
        const m = l.match(new RegExp(`^(.*?${RX.zip.source})`));
        return (m ? m[1] : l).trim();
      }
    }
    for (const l of keep) {
      if (hasZip(l)) {
        const m = l.match(new RegExp(`^(.*? ${RX.zip.source})`));
        return (m ? m[1] : l).trim();
      }
    }
    return (keep[0] || lines[0] || "").trim();
  }

  // ============================================================================
  // CLIPBOARD COPY
  // ============================================================================

  const copyText = async (text) => {
    text = String(text ??  "");
    try {
      await navigator.clipboard. writeText(text);
      return true;
    } catch (err) {
      log.warn("Clipboard API failed:", err);
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const success = document.execCommand("copy");
      document.body.removeChild(ta);
      if (success) return true;
    } catch (err) {
      log.warn("execCommand copy failed:", err);
    }
    try {
      if (typeof copy === "function") {
        copy(text);
        return true;
      }
    } catch (err) {
      log.warn("copy() function failed:", err);
    }
    return false;
  };

  window. ONTH_copyText = copyText;

  // ============================================================================
  // NETWORK HOOKS
  // ============================================================================

  (function hookNetworkOnce() {
    if (window.__ONTH_NET__?. hooked) return;

    if (! window.__ONTH_NET__) {
      window.__ONTH_NET__ = { hooked: false, byId: Object.create(null) };
    }
    if (window.__ONTH_NET__. hooked) return;
    window.__ONTH_NET__.hooked = true;

    window.__ONTH_ADDRINDEX__ = window.__ONTH_ADDRINDEX__ || Object.create(null);

    const RX_ITIN = /\/operations\/execution\/api\/itineraries\/([^/? ]+)/i;
    const isItinUrl = (url) => RX_ITIN.test(String(url || ""));

    const saveIfItinerary = (url, j) => {
      try {
        const m = String(url || "").match(RX_ITIN);
        const itinId = m? .[1];
        if (! itinId || !j) return;
        window.__ONTH_NET__.byId[String(itinId)] = j;
        if (window.__ONTH_ADDRINDEX__) delete window.__ONTH_ADDRINDEX__[String(itinId)];
        log.info("Captured itinerary:", itinId);
      } catch (err) {
        log.error("Failed to save itinerary:", err);
      }
    };

    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const url = String(args? .[0]?.url || args? .[0] || "");
        if (isItinUrl(url)) {
          res
            .clone()
            .json()
            .then((j) => saveIfItinerary(url, j))
            .catch((err) => log.warn("Failed to parse fetch response:", err));
        }
      } catch (err) {
        log.error("Fetch hook error:", err);
      }
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ... rest) {
      this.__ONTH_url__ = String(url || "");
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      const handleLoad = () => {
        try {
          const url = this.__ONTH_url__ || "";
          if (! isItinUrl(url)) return;
          const txt = this.responseText;
          if (! txt || txt[0] !== "{") return;
          saveIfItinerary(url, JSON.parse(txt));
        } catch (err) {
          log.warn("XHR hook error:", err);
        }
      };
      this.addEventListener("load", handleLoad, { once: true });
      return origSend.apply(this, args);
    };

    log.info("Network hooks initialized");
  })();

  // ============================================================================
  // WAIT FOR HELPER
  // ============================================================================

  const waitFor = async (fn, { timeout = 9000, interval = 120 } = {}) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      try {
        const v = fn();
        if (v) return v;
      } catch (err) {
        log.warn("waitFor function error:", err);
      }
      await sleep(interval);
    }
    log.warn("waitFor timeout exceeded");
    return null;
  };

  // ============================================================================
  // DRIVER OPERATIONS (Compressed from driver-ops.js logic)
  // ============================================================================

  const ROW_SEL = SELECTORS.rows;
  const trackedElements = new WeakMap();

  function extractPhone(row, lines) {
    const tel = row.querySelector('a[href^="tel:"]');
    if (tel) {
      const href = tel.getAttribute("href") || "";
      const fromHref = href.replace(/^tel:/i, "").trim();
      if (fromHref) return tidyPhone(fromHref);
    }
    const order = [1, 2, 0, 3];
    for (const i of order) {
      const L = lines[i] || "";
      if (! L || RX.time12h.test(L)) continue;
      const m = L.match(RX. phone);
      if (m) return tidyPhone(m[1]);
    }
    const all = lines.join("  ");
    if (! RX.time12h.test(all)) {
      const m = all.match(RX.phone);
      if (m) return tidyPhone(m[1]);
    }
    return "";
  }

  function parseRow(row) {
    const text = row?. innerText || "";
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const name = firstLine(text) || "[unknown]";
    const phone = extractPhone(row, lines);

    let projectedRTS = readViaSel(row, SELECTORS.projectedRTS) || one(text, RX.rts, RX.rtsAlt) || "";
    let avgPerHour = readViaSel(row, SELECTORS.avgPerHour) || one(text, RX.avg);
    avgPerHour = typeof avgPerHour === "string" ? num(avgPerHour) : avgPerHour;

    let lastHourPace = readViaSel(row, SELECTORS. lastHourPace) || one(text, RX.pace);
    lastHourPace = typeof lastHourPace === "string" ? num(lastHourPace) : lastHourPace;

    let stopsLeft = null;
    {
      const m = (row?. innerText || "").match(RX.stopsPair);
      if (m) {
        const done = Number(m[1]);
        const total = Number(m[2]);
        if (! Number.isNaN(done) && !Number.isNaN(total))
          stopsLeft = Math.max(0, total - done);
      }
    }

    const fix = (v) => (typeof v === "number" && ! Number.isNaN(v) ? v : null);
    const key = `${norm(name)}|${norm(phone)}`;

    return {
      key,
      name,
      number: phone,
      projectedRTS,
      avgPerHour:  fix(avgPerHour),
      lastHourPace:  fix(lastHourPace),
      stopsLeft:  typeof stopsLeft === "number" ?  stopsLeft : null,
    };
  }

  async function collectAllDrivers() {
    const panel =
      document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (!panel) {
      toast("Scroll container not found", false);
      log.error("Scroll panel not found");
      return [];
    }

    for (const r of document.querySelectorAll(SELECTORS.rows)) {
      if (trackedElements.has(r)) {
        trackedElements.delete(r);
      }
    }

    try {
      panel.scrollTop = 0;
    } catch (err) {
      log.warn("Failed to scroll to top:", err);
    }
    await sleep(CONFIG.BASE_SLEEP * 4);

    const out = [];
    let lastCount = 0;
    let stagnant = 0;

    for (let loops = 0; loops < CONFIG. MAX_SCROLL_LOOPS; loops++) {
      const rows = [... document.querySelectorAll(SELECTORS.rows)];
      for (const row of rows) {
        if (trackedElements.has(row)) continue;
        trackedElements.set(row, true);
        out.push(parseRow(row));
        await sleep(18);
      }

      const atBottom =
        panel.scrollTop + panel.clientHeight >= panel. scrollHeight - 6;
      stagnant = out.length === lastCount ?  stagnant + 1 :  0;
      lastCount = out.length;

      if (atBottom && stagnant >= CONFIG. STAGNANT_THRESHOLD) {
        log.info("Reached bottom with stagnant count:", stagnant);
        break;
      }

      panel.scrollTop += Math.max(260, panel.clientHeight * 0.9);
      await sleep(360);
    }

    log.info("Collected drivers:", out.length);
    return out;
  }

  function getStopHeaders() {
    return [
      ... document.querySelectorAll(
        'div[role="button"][aria-controls^="expandable"], button[aria-controls^="expandable"]'
      ),
    ].filter((el) => el.offsetWidth && el.offsetHeight);
  }

  function inDriverView() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("itineraryId")) return true;
    } catch (err) {
      log.warn("URL parsing failed:", err);
    }
    return getStopHeaders().length > 0;
  }

  function rowMatches(row, targetName, targetPhone) {
    const rowName = norm(firstLine(row?. innerText || ""));
    const nameOk = rowName === norm(targetName || "");
    if (!nameOk) return false;
    if (! targetPhone) return true;
    const want = digits(targetPhone);
    if (! want) return true;
    const got = digits(row?.innerText || "");
    return got. includes(want);
  }

  async function findRowByNameScrolling(name, phone, { maxLoops = 200 } = {}) {
    const panel =
      document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (! panel) return null;

    let row = [... document.querySelectorAll(ROW_SEL)].find((r) =>
      rowMatches(r, name, phone)
    );
    if (row) return row;

    const saved = panel.scrollTop;
    try {
      panel.scrollTop = 0;
    } catch (err) {
      log.warn("Scroll to top failed:", err);
    }
    await sleep(CONFIG.BASE_SLEEP);

    for (let loops = 0; loops < maxLoops; loops++) {
      row = [...document.querySelectorAll(ROW_SEL)].find((r) =>
        rowMatches(r, name, phone)
      );
      if (row) return row;

      const atBottom =
        panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 6;
      if (atBottom) break;

      panel.scrollTop += Math.max(260, panel.clientHeight * 0.9);
      await sleep(160);
    }

    try {
      panel.scrollTop = saved;
    } catch (err) {
      log.warn("Scroll restore failed:", err);
    }
    return null;
  }

  function clickAtCenter(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function dblClickAtCenter(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 2 };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    el.dispatchEvent(new MouseEvent("dblclick", opts));
  }

  function pressEnter(el) {
    el.focus?. ();
    const opts = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function pointerTap(el) {
    try {
      const r = el. getBoundingClientRect();
      const x = r.left + r.width / 2,
        y = r.top + r. height / 2;
      const base = {
        bubbles: true,
        cancelable: true,
        clientX:  x,
        clientY: y,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", base));
      el.dispatchEvent(new PointerEvent("pointerup", base));
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y })
      );
    } catch (err) {
      log.warn("pointerTap failed:", err);
    }
  }

  async function clickDriverExact(row) {
    if (!row) return null;

    const link =
      row.querySelector(
        'a[href*="itineraryId="], a[href*="/itineraries/"], a[href*="execution/itineraries"]'
      ) || row.querySelector("a,button,[role='button']");

    const attempts = [
      async () => {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(CONFIG.BASE_SLEEP);
        clickAtCenter(row);
        await sleep(CONFIG.BASE_SLEEP);
        dblClickAtCenter(row);
        await sleep(CONFIG.BASE_SLEEP);
        pressEnter(row);
      },
      async () => {
        if (! link) return;
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(CONFIG.BASE_SLEEP);
        try {
          link.click();
        } catch (err) {
          log.warn("Link click failed:", err);
        }
      },
      async () => {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(CONFIG.BASE_SLEEP);
        pointerTap(row);
        await sleep(CONFIG.BASE_SLEEP);
        pointerTap(link || row);
      },
    ];

    for (let i = 0; i < attempts.length; i++) {
      log.info(`Click attempt ${i + 1}/${attempts.length}`);
      await attempts[i]();
      const ok = await waitFor(() => (inDriverView() ? true : null), {
        timeout: 12000,
        interval: 200,
      });
      if (ok) {
        log.info("Successfully entered driver view");
        return row;
      }
      await sleep(300);
    }

    log.error("All click attempts failed");
    return null;
  }

  async function clickDriver(name, phone) {
    const rowNow = [... document.querySelectorAll(ROW_SEL)].find((r) =>
      rowMatches(r, name, phone)
    );
    if (rowNow) return clickDriverExact(rowNow);
    const row = await findRowByNameScrolling(name, phone);
    if (row) return clickDriverExact(row);
    log.error("Could not find driver row:", name);
    return null;
  }

  function findHideToggle() {
    let el = document.querySelector('input[role="switch"][type="checkbox"]');
    if (el && /hide completed/i.test(el.closest("label,div,span")?.textContent || "")) {
      return el;
    }

    const cands = [
      ... document.querySelectorAll(
        'input[role="switch"][type="checkbox"], input[type="checkbox"][role="switch"], [role="switch"]'
      ),
    ];
    el = cands.find((e) =>
      /hide completed stops/i.test(
        e.closest("label,div,span,section,form")?.textContent || ""
      )
    );
    return el || null;
  }

  function isOn(el) {
    if (! el) return false;
    const aria = el.getAttribute("aria-checked");
    if (aria != null) return aria === "true";
    if ("checked" in el) return !!el.checked;
    const ds = (el.getAttribute("data-state") || "").toLowerCase();
    return el.classList.contains("checked") || ds === "on" || ds === "true";
  }

  function clickCenter(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  async function scrollToHideArea() {
    const search =
      document.querySelector('input[placeholder="Search..."]') ||
      [... document.querySelectorAll("input,button,[role='switch']")].find((n) =>
        /hide completed stops/i.test(
          n.closest("label,div,span,section,form")?.textContent || ""
        )
      );
    if (search) {
      search.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    for (let i = 0; i < 7; i++) {
      window.scrollBy({ top: window.innerHeight * 0.5, behavior: "smooth" });
      await sleep(180);
    }
  }

  async function setHideCompleted(want) {
    const el = await waitFor(findHideToggle, { timeout:  9000, interval: 150 });
    if (!el) {
      log.warn("Hide toggle not found");
      return false;
    }
    if (typeof want === "boolean") {
      const current = isOn(el);
      if (current !== want) {
        clickCenter(el);
        await sleep(200);
      }
    } else {
      clickCenter(el);
      await sleep(200);
    }
    const finalState = isOn(findHideToggle());
    log.info("Hide completed state:", finalState);
    return finalState;
  }

  async function goBackToList() {
    if (document.querySelector(ROW_SEL)) {
      log.info("Already on list view");
      return true;
    }

    const findBackBtn = () => {
      const cands = [... document.querySelectorAll("button,a,[role='button']")];
      return (
        cands.find((el) => {
          const t = (
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.textContent ||
            ""
          ).trim();
          return (
            /^(back|return|go back|back to list)$/i.test(t) || /\bback\b/i.test(t)
          );
        }) || null
      );
    };

    for (let i = 0; i < CONFIG. RETRY_ATTEMPTS; i++) {
      const b = findBackBtn();
      if (b) {
        try {
          b.click();
          log.info("Clicked back button");
        } catch (err) {
          log.warn("Back button click failed:", err);
        }
      }
      await sleep(380);
      if (document.querySelector(ROW_SEL)) {
        log.info("Returned to list view");
        return true;
      }
    }

    try {
      history.back();
      log.info("Used history.back()");
    } catch (err) {
      log.error("history.back() failed:", err);
    }
    const ok = await waitFor(() => document.querySelector(ROW_SEL), {
      timeout: 11000,
      interval: 200,
    });
    return !!ok;
  }

  // ============================================================================
  // ADDRESS OPERATIONS (Compressed from address-ops.js logic)
  // ============================================================================

  function getItinParamsFromUrl() {
    try {
      const u = new URL(location.href);
      return {
        itineraryId: u.searchParams. get("itineraryId"),
        serviceAreaId: u.searchParams.get("serviceAreaId"),
      };
    } catch (err) {
      log.warn("URL params parsing failed:", err);
      return { itineraryId: null, serviceAreaId: null };
    }
  }

  async function getItineraryJSON() {
    const { itineraryId, serviceAreaId } = getItinParamsFromUrl();
    if (!itineraryId || !serviceAreaId) {
      log.warn("Missing itinerary params");
      return null;
    }

    const cached = window.__ONTH_NET__?.byId? .[String(itineraryId)];
    if (cached) {
      log.info("Using cached itinerary JSON");
      return cached;
    }

    const apiUrl =
      `/operations/execution/api/itineraries/${itineraryId}` +
      `? documentType=Itinerary&historicalDay=false&itineraryId=${encodeURIComponent(
        itineraryId
      )}` +
      `&serviceAreaId=${encodeURIComponent(serviceAreaId)}`;

    try {
      const j = await fetch(apiUrl, { credentials: "include" })
        .then((r) => r.json())
        .catch((err) => {
          log.error("Fetch itinerary failed:", err);
          return null;
        });
      if (j) {
        window.__ONTH_NET__ = window.__ONTH_NET__ || {};
        window.__ONTH_NET__.byId = window.__ONTH_NET__.byId || Object.create(null);
        window.__ONTH_NET__.byId[String(itineraryId)] = j;
        window.__ONTH_ADDRINDEX__ = window.__ONTH_ADDRINDEX__ || Object.create(null);
        delete window.__ONTH_ADDRINDEX__[String(itineraryId)];
        log.info("Fetched itinerary JSON");
      }
      return j;
    } catch (err) {
      log.error("Get itinerary JSON error:", err);
      return null;
    }
  }

  function buildStopAddressIndex(itinJson) {
    const idx = Object.create(null);

    const asNum = (v) => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() && ! Number.isNaN(Number(v)))
        return Number(v);
      return null;
    };

    const pickStopNum = (o) => {
      if (!o || typeof o !== "object") return null;
      const keys = [
        "stopNumber",
        "stopNum",
        "stopSequenceNumber",
        "stopSequence",
        "sequenceNumber",
        "sequence",
        "stopIndex",
        "index",
        "order",
        "stopIdNumber",
      ];
      for (const k of keys) {
        if (k in o) {
          const n = asNum(o[k]);
          if (n != null) return n;
        }
      }
      const nested = o.stop || o.stopInfo || o.stopDetails;
      if (nested && typeof nested === "object") {
        for (const k of keys) {
          if (k in nested) {
            const n = asNum(nested[k]);
            if (n != null) return n;
          }
        }
      }
      return null;
    };

    const joinParts = (parts) =>
      cleanAddress(
        parts
          .filter(Boolean)
          .map((x) => String(x).trim())
          .filter(Boolean)
          .join("\n")
      );

    const extractAddressFromObj = (o) => {
      if (!o || typeof o !== "object") return null;

      const candidates = [
        o.address,
        o.deliveryAddress,
        o.shipToAddress,
        o.destinationAddress,
        o.location?. address,
        o.location?. destinationAddress,
        o.stopAddress,
        o.addressInfo,
        o.customerAddress,
      ];

      for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return cleanAddress(c);
      }

      const addrObj =
        candidates.find((c) => c && typeof c === "object") ||
        o.destination?. address ||
        o.customer?.address ||
        o.locationAddress;

      if (addrObj && typeof addrObj === "object") {
        const line1 =
          addrObj.addressLine1 ||
          addrObj.line1 ||
          addrObj.street ||
          addrObj.street1 ||
          addrObj.address1 ||
          addrObj. addressLine ||
          (Array.isArray(addrObj. addressLines) ? addrObj.addressLines[0] : null) ||
          (Array.isArray(addrObj.lines) ? addrObj.lines[0] : null);

        const line2 =
          addrObj.addressLine2 ||
          addrObj.line2 ||
          addrObj.unit ||
          addrObj.apt ||
          addrObj.suite ||
          (Array.isArray(addrObj.addressLines) ? addrObj.addressLines[1] : null) ||
          (Array.isArray(addrObj.lines) ? addrObj.lines[1] : null);

        const city = addrObj.city || addrObj.town || addrObj.locality;
        const state =
          addrObj.state || addrObj.region || addrObj.stateCode || addrObj.province;
        const zip =
          addrObj.zip || addrObj.zipCode || addrObj.postalCode || addrObj.postcode;

        const combo = joinParts([
          line1,
          line2,
          [city, state, zip]
            .filter(Boolean)
            .join(", ")
            . 
