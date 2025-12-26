// ==UserScript==
// @name         Amazon Driver Snapshot (IN-PAGE Drawer + Copy Nth Remaining Stop Address + Auto-Back)
// @namespace    https://github.com/onth/scripts
// @version      1.9.5
// @description  In-page Driver Snapshot drawer. Click driver → open itinerary → hide completed → copy Nth *remaining* stop address (default 5) → auto-back.
// @match        https://logistics.amazon.com/operations/execution/itineraries*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Joeybs/onth-driver-snapshot-clean/main/amazon-driver-snapshot.user.js
// @downloadURL  https://raw.githubusercontent.com/Joeybs/onth-driver-snapshot-clean/main/amazon-driver-snapshot.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SELECTORS = {
    rows: '[data-testid="allow-text-selection-div"]',
    scrollPanel: ".fp-page-template",
    projectedRTS: ["[data-testid='projected-rts']", "[data-attr='projected-rts']"],
    avgPerHour: ["[data-testid='avg-stops-per-hour']", "[data-attr='avg-stops-per-hour']"],
    lastHourPace: ["[data-testid='last-hour-pace']", "[data-attr='last-hour-pace']"],
  };

  const RX = {
    phone: /(\+?\d[\d\s().-]{7,}\d)/,
    time12h: /\b\d{1,2}:\d{2}\s*[APMapm]{2}\b/,
    avg: /\bAvg(?:\.|\s+stops\/hour|\s*\/\s*hr)?\s*[:\-]?\s*(-?\d+(?:\.\d+)?)/i,
    pace: /\b(?:Pace|Last\s*(?:hr|hour))\s*[:\-]?\s*(-?\d+(?:\.\d+)?)/i,
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
    BASE_SLEEP: 120,
    RETRY_ATTEMPTS: 3,
  };

  // Utility functions
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || "").toLowerCase().trim();
  const firstLine = (t = "") => (t.split("\n")[0] || "").trim();
  const digits = (s) => String(s || "").replace(/\D+/g, "");
  const num = (t) => {
    const m = String(t || "").match(RX.numVal);
    return m ? Number(m[0]) : null;
  };
  const one = (t, ...rxs) => {
    t = String(t || "");
    for (const rx of rxs) {
      const m = t.match(rx);
      if (m) return m[1].trim();
    }
    return null;
  };
  const readViaSel = (root, arr) => {
    for (const sel of arr || []) {
      const el = root.querySelector(sel);
      if (el?.innerText) return el.innerText.trim();
    }
    return null;
  };
  const tidyPhone = (s) =>
    String(s || "")
      .replace(/^[^\d+]*(\+?[\d(].*)$/, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();

  const cssEscape =
    window.CSS && typeof window.CSS.escape === "function"
      ? window.CSS.escape.bind(window.CSS)
      : (s) => String(s).replace(/[^\w-]/g, "\\$&");

  const escAttr = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escHtml = (v) => {
    const div = document.createElement("div");
    div.textContent = String(v ?? "");
    return div.innerHTML;
  };

  // Enhanced logging
  const log = {
    info: (msg, ...args) => console.log(`[ONTH] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[ONTH] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ONTH] ${msg}`, ...args),
  };

  // Mutex for async operations
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

  // LRU Cache implementation
  class LRUCache {
    constructor(maxSize = CONFIG.MAX_CACHE_SIZE) {
      this._cache = new Map();
      this._maxSize = maxSize;
    }

    get(key) {
      if (!this._cache.has(key)) return undefined;
      const value = this._cache.get(key);
      this._cache.delete(key);
      this._cache.set(key, value);
      return value;
    }

    set(key, value) {
      if (this._cache.has(key)) this._cache.delete(key);
      else if (this._cache.size >= this._maxSize) {
        const firstKey = this._cache.keys().next().value;
        this._cache.delete(firstKey);
      }
      this._cache.set(key, value);
    }

    has(key) {
      return this._cache.has(key);
    }

    clear() {
      this._cache.clear();
    }

    get size() {
      return this._cache.size;
    }
  }

  function toast(msg, ok = null) {
    let d = document.getElementById("__onth_snap_toast__");
    if (!d) {
      d = document.createElement("div");
      d.id = "__onth_snap_toast__";
      d.setAttribute("role", "status");
      d.setAttribute("aria-live", "polite");
      d.style.cssText = [
        "position:fixed;right:16px;bottom:16px;z-index:2147483647",
        "background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,.12)",
        "padding:10px 12px;border-radius:10px;opacity:0;transform:translateY(10px)",
        "transition:.18s;pointer-events:none;max-width:62vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
        "box-shadow:0 10px 30px rgba(0,0,0,.35)",
      ].join(";");
      document.body.appendChild(d);
    }
    const icon = ok === true ? "✅ " : ok === false ? "❌ " : "🟦 ";
    d.textContent = icon + msg;
    d.style.opacity = "1";
    d.style.transform = "translateY(0)";
    clearTimeout(d.__t);
    d.__t = setTimeout(() => {
      d.style.opacity = "0";
      d.style.transform = "translateY(10px)";
    }, 1300);
  }

  function cleanAddress(raw) {
    const txt = String(raw || "").replace(/\r/g, "\n");
    const lines = txt
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const keep = lines.filter(
      (l) => !/^edit in/i.test(l) && !/^driver aid/i.test(l) && !/geostudio/i.test(l)
    );
    const hasZip = (s) => RX.zip.test(String(s || ""));

    if (keep.length >= 2 && !hasZip(keep[0]) && hasZip(keep[1]))
      return `${keep[0]}, ${keep[1]}`.trim();

    for (const l of keep) {
      if (hasZip(l) && /,/.test(l)) {
        const m = l.match(new RegExp(`^(.*?${RX.zip.source})`));
        return (m ? m[1] : l).trim();
      }
    }
    for (const l of keep) {
      if (hasZip(l)) {
        const m = l.match(new RegExp(`^(.*?${RX.zip.source})`));
        return (m ? m[1] : l).trim();
      }
    }
    return (keep[0] || lines[0] || "").trim();
  }

  window.ONTH_copyText = async (text) => {
    text = String(text ?? "");
    try {
      await navigator.clipboard.writeText(text);
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

  /* ---------------------------
     Capture itinerary JSON by itineraryId
  ---------------------------- */
  (function hookNetworkOnce() {
    if (window.__ONTH_NET__?.hooked) return;

    // Atomic check-and-set
    if (!window.__ONTH_NET__) {
      window.__ONTH_NET__ = { hooked: false, byId: Object.create(null) };
    }
    if (window.__ONTH_NET__.hooked) return;
    window.__ONTH_NET__.hooked = true;

    window.__ONTH_ADDRINDEX__ = window.__ONTH_ADDRINDEX__ || Object.create(null);

    const RX_ITIN = /\/operations\/execution\/api\/itineraries\/([^/?]+)/i;
    const isItinUrl = (url) => RX_ITIN.test(String(url || ""));

    const saveIfItinerary = (url, j) => {
      try {
        const m = String(url || "").match(RX_ITIN);
        const itinId = m?.[1];
        if (!itinId || !j) return;
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
        const url = String(args?.[0]?.url || args?.[0] || "");
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

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ONTH_url__ = String(url || "");
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          const url = this.__ONTH_url__ || "";
          if (!isItinUrl(url)) return;
          const txt = this.responseText;
          if (!txt || txt[0] !== "{") return;
          saveIfItinerary(url, JSON.parse(txt));
        } catch (err) {
          log.warn("XHR hook error:", err);
        }
      });
      return origSend.apply(this, args);
    };
  })();

  /* ---------------------------
     Driver rows
  ---------------------------- */
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
      if (!L || RX.time12h.test(L)) continue;
      const m = L.match(RX.phone);
      if (m) return tidyPhone(m[1]);
    }
    const all = lines.join("  ");
    if (!RX.time12h.test(all)) {
      const m = all.match(RX.phone);
      if (m) return tidyPhone(m[1]);
    }
    return "";
  }

  function parseRow(row) {
    const text = row?.innerText || "";
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const name = firstLine(text) || "[unknown]";
    const phone = extractPhone(row, lines);

    let projectedRTS =
      readViaSel(row, SELECTORS.projectedRTS) || one(text, RX.rts, RX.rtsAlt) || "";
    let avgPerHour = readViaSel(row, SELECTORS.avgPerHour) || one(text, RX.avg);
    avgPerHour = typeof avgPerHour === "string" ? num(avgPerHour) : avgPerHour;

    let lastHourPace = readViaSel(row, SELECTORS.lastHourPace) || one(text, RX.pace);
    lastHourPace = typeof lastHourPace === "string" ? num(lastHourPace) : lastHourPace;

    let stopsLeft = null;
    {
      const m = (row?.innerText || "").match(RX.stopsPair);
      if (m) {
        const done = Number(m[1]);
        const total = Number(m[2]);
        if (!Number.isNaN(done) && !Number.isNaN(total))
          stopsLeft = Math.max(0, total - done);
      }
    }

    const fix = (v) => (typeof v === "number" && !Number.isNaN(v) ? v : null);
    const key = `${norm(name)}|${norm(phone)}`;

    return {
      key,
      name,
      number: phone,
      projectedRTS,
      avgPerHour: fix(avgPerHour),
      lastHourPace: fix(lastHourPace),
      stopsLeft: typeof stopsLeft === "number" ? stopsLeft : null,
    };
  }

  // DOM element tracking for cleanup
  const trackedElements = new WeakMap();

  async function collectAllDrivers() {
    const panel =
      document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (!panel) {
      toast("Scroll container not found", false);
      log.error("Scroll panel not found");
      return [];
    }

    // Cleanup previous markers
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

    for (let loops = 0; loops < CONFIG.MAX_SCROLL_LOOPS; loops++) {
      const rows = [...document.querySelectorAll(SELECTORS.rows)];
      for (const row of rows) {
        if (trackedElements.has(row)) continue;
        trackedElements.set(row, true);
        out.push(parseRow(row));
        await sleep(18);
      }

      const atBottom =
        panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 6;
      stagnant = out.length === lastCount ? stagnant + 1 : 0;
      lastCount = out.length;

      if (atBottom && stagnant >= CONFIG.STAGNANT_THRESHOLD) {
        log.info("Reached bottom with stagnant count:", stagnant);
        break;
      }

      panel.scrollTop += Math.max(260, panel.clientHeight * 0.9);
      await sleep(360);
    }

    log.info("Collected drivers:", out.length);
    return out;
  }

  /* ---------------------------
     Driver click + hide toggle + address copy
  ---------------------------- */
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

  const ROW_SEL = SELECTORS.rows;

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
    el.focus?.();
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
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2,
        y = r.top + r.height / 2;
      const base = {
        bubbles: true,
        cancelable: true,
        clientX: x,
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

  function getStopHeaders() {
    return [
      ...document.querySelectorAll(
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
    const rowName = norm(firstLine(row?.innerText || ""));
    const nameOk = rowName === norm(targetName || "");
    if (!nameOk) return false;
    if (!targetPhone) return true;
    const want = digits(targetPhone);
    if (!want) return true;
    const got = digits(row?.innerText || "");
    return got.includes(want);
  }

  async function findRowByNameScrolling(name, phone, { maxLoops = 200 } = {}) {
    const panel =
      document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (!panel) return null;

    let row = [...document.querySelectorAll(ROW_SEL)].find((r) =>
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
        if (!link) return;
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
    const rowNow = [...document.querySelectorAll(ROW_SEL)].find((r) =>
      rowMatches(r, name, phone)
    );
    if (rowNow) return clickDriverExact(rowNow);
    const row = await findRowByNameScrolling(name, phone);
    if (row) return clickDriverExact(row);
    log.error("Could not find driver row:", name);
    return null;
  }

  function findHideToggle() {
    // Try specific selector first
    let el = document.querySelector('input[role="switch"][type="checkbox"]');
    if (el && /hide completed/i.test(el.closest("label,div,span")?.textContent || "")) {
      return el;
    }

    const cands = [
      ...document.querySelectorAll(
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
    if (!el) return false;
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
      [...document.querySelectorAll("input,button,[role='switch']")].find((n) =>
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
    const el = await waitFor(findHideToggle, { timeout: 9000, interval: 150 });
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

  function getItinParamsFromUrl() {
    try {
      const u = new URL(location.href);
      return {
        itineraryId: u.searchParams.get("itineraryId"),
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

    const cached = window.__ONTH_NET__?.byId?.[String(itineraryId)];
    if (cached) {
      log.info("Using cached itinerary JSON");
      return cached;
    }

    const apiUrl =
      `/operations/execution/api/itineraries/${itineraryId}` +
      `?documentType=Itinerary&historicalDay=false&itineraryId=${encodeURIComponent(
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

  /* ---------------------------
     JSON address index
  ---------------------------- */
  function buildStopAddressIndex(itinJson) {
    const idx = Object.create(null);

    const asNum = (v) => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v)))
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
        o.location?.address,
        o.location?.destinationAddress,
        o.stopAddress,
        o.addressInfo,
        o.customerAddress,
      ];

      for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return cleanAddress(c);
      }

      const addrObj =
        candidates.find((c) => c && typeof c === "object") ||
        o.destination?.address ||
        o.customer?.address ||
        o.locationAddress;

      if (addrObj && typeof addrObj === "object") {
        const line1 =
          addrObj.addressLine1 ||
          addrObj.line1 ||
          addrObj.street ||
          addrObj.street1 ||
          addrObj.address1 ||
          addrObj.addressLine ||
          (Array.isArray(addrObj.addressLines) ? addrObj.addressLines[0] : null) ||
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
            .replace(/\s+,/g, ",")
            .trim(),
        ]);
        if (combo) return combo;
      }

      const maybeTextKeys = [
        "formattedAddress",
        "addressText",
        "fullAddress",
        "addressString",
      ];
      for (const k of maybeTextKeys)
        if (typeof o[k] === "string" && o[k].trim()) return cleanAddress(o[k]);

      return null;
    };

    const seen = new WeakSet();
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      const stopNum = pickStopNum(node);
      if (stopNum != null) {
        const addr = extractAddressFromObj(node);
        if (addr && !idx[String(stopNum)]) idx[String(stopNum)] = addr;
      }

      if (Array.isArray(node)) return void node.forEach(walk);
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === "object") walk(v);
      }
    })(itinJson);

    log.info("Built address index with", Object.keys(idx).length, "stops");
    return idx;
  }

  function getJsonAddressForStop(stopNum, itinJson) {
    const { itineraryId } = getItinParamsFromUrl();
    const id = itineraryId ? String(itineraryId) : null;
    if (!id || !itinJson) return null;

    window.__ONTH_ADDRINDEX__ = window.__ONTH_ADDRINDEX__ || Object.create(null);
    let idx = window.__ONTH_ADDRINDEX__[id];
    if (!idx) {
      idx = buildStopAddressIndex(itinJson);
      window.__ONTH_ADDRINDEX__[id] = idx;
    }
    const a = idx[String(stopNum)];
    return a ? cleanAddress(a) : null;
  }

  /* ---------------------------
     Stop DOM helpers
  ---------------------------- */
  const isScrollable = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    const oy = s.overflowY;
    return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 5;
  };

  function pickStopScroller() {
    const headers = getStopHeaders();
    const first = headers[0];
    if (!first)
      return document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;

    let p = first.parentElement;
    for (let i = 0; i < 14 && p; i++) {
      if (isScrollable(p)) return p;
      p = p.parentElement;
    }
    return document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
  }

  function parseStopHeader(el) {
    const box = el.closest("div") || el;
    const raw = (box.innerText || "").trim();
    const lines = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const textAll = lines.join(" ");

    let stopNum = null;
    const mStop = textAll.match(/\bStop\s*(\d{1,4})\b/i);
    if (mStop) stopNum = Number(mStop[1]);

    if (stopNum == null) {
      for (const l of lines) {
        const m = l.match(/^(\d{1,4})(?:\s|$)/);
        if (m) {
          stopNum = Number(m[1]);
          break;
        }
      }
    }

    if (stopNum == null) {
      for (const l of lines) {
        if (/^\d{1,4}$/.test(l)) {
          stopNum = Number(l);
          break;
        }
      }
    }

    const done =
      /\bat\s*\d{1,2}:\d{2}\s*(am|pm)\b/i.test(textAll) || /\bcompleted\b/i.test(textAll);
    return { stopNum, done };
  }

  function findAddressInPanel(panel) {
    if (!panel) return null;

    const quick = panel.querySelector(
      '[data-testid*="address" i], [data-attr*="address" i], [aria-label*="address" i]'
    );
    if (quick?.innerText?.trim()) return quick;

    const nodes = [...panel.querySelectorAll("div,span,p,li,td")].filter(
      (n) => n?.innerText?.trim()
    );

    const label = nodes.find((n) => /^address$/i.test(n.innerText.trim()));
    if (label) {
      const idx = nodes.indexOf(label);
      for (let k = idx + 1; k < Math.min(idx + 12, nodes.length); k++) {
        const t = nodes[k].innerText.trim();
        if (t && (/,/.test(t) || RX.zip.test(t))) return nodes[k];
      }
    }

    return (
      nodes.find((x) => {
        const t = x.innerText || "";
        return /,/.test(t) && (RX.zip.test(t) || /\b[A-Z]{2}\b/.test(t));
      }) || null
    );
  }

  async function locateHeaderByStopNum(stopNum) {
    const scroller = pickStopScroller();
    if (!scroller) return null;

    const tryFind = () => {
      const headers = getStopHeaders();
      for (const h of headers) {
        const p = parseStopHeader(h);
        if (p.stopNum === Number(stopNum)) return h;
      }
      return null;
    };

    let h = tryFind();
    if (h) return h;

    try {
      scroller.scrollTop = 0;
    } catch (err) {
      log.warn("Scroll to top failed:", err);
    }
    await sleep(CONFIG.BASE_SLEEP);

    for (let i = 0; i < 110; i++) {
      h = tryFind();
      if (h) return h;

      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6;
      if (atBottom) break;

      try {
        scroller.scrollTop += Math.max(520, scroller.clientHeight * 0.9);
      } catch (err) {
        log.warn("Scroll failed:", err);
      }
      await sleep(150);
    }
    return null;
  }

  async function domExpandAndGetAddressForStop(stopNum) {
    const header = await locateHeaderByStopNum(stopNum);
    if (!header) {
      log.warn("Header not found for stop:", stopNum);
      return null;
    }

    header.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(CONFIG.BASE_SLEEP);

    if (header.getAttribute("aria-expanded") !== "true") {
      clickCenter(header);
      await sleep(260);
    }

    const ctrlId = header.getAttribute("aria-controls");
    const panel = (ctrlId && document.getElementById(ctrlId)) || header.nextElementSibling;
    if (!panel) {
      log.warn("Panel not found for stop:", stopNum);
      return null;
    }

    const node = findAddressInPanel(panel);
    if (!node?.innerText) {
      log.warn("Address node not found for stop:", stopNum);
      return null;
    }

    return cleanAddress(node.innerText) || null;
  }

  async function collectRemainingStopsNth(nthRemaining = 5) {
    const scroller = pickStopScroller();
    const want = Math.max(1, Number(nthRemaining) || 5);

    try {
      scroller.scrollTop = 0;
    } catch (err) {
      log.warn("Scroll to top failed:", err);
    }
    await sleep(140);

    const seen = new Map();
    let stagnant = 0;
    let lastSeen = 0;

    for (let loops = 0; loops < CONFIG.MAX_SCROLL_LOOPS; loops++) {
      const headers = getStopHeaders();
      for (const h of headers) {
        const p = parseStopHeader(h);
        if (p.stopNum != null && !Number.isNaN(p.stopNum)) seen.set(p.stopNum, p);
      }

      const remaining = [...seen.values()]
        .filter((x) => !x.done)
        .sort((a, b) => a.stopNum - b.stopNum);
      if (remaining.length >= want) {
        log.info(`Found ${remaining.length} remaining stops`);
        return { remaining, target: remaining[want - 1] };
      }

      const nowSeen = seen.size;
      stagnant = nowSeen === lastSeen ? stagnant + 1 : 0;
      lastSeen = nowSeen;

      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6;
      if (atBottom && stagnant >= CONFIG.STAGNANT_THRESHOLD) break;

      try {
        scroller.scrollTop += Math.max(520, scroller.clientHeight * 0.9);
      } catch (err) {
        log.warn("Scroll failed:", err);
      }
      await sleep(200);
    }

    const remaining = [...seen.values()]
      .filter((x) => !x.done)
      .sort((a, b) => a.stopNum - b.stopNum);
    log.info(`Final: ${remaining.length} remaining stops found`);
    return { remaining, target: remaining[want - 1] || null };
  }

  async function copyNthRemainingStopAddress(nthRemaining = 5, itinJson = null) {
    const want = Math.max(1, Number(nthRemaining) || 5);
    const { target } = await collectRemainingStopsNth(want);
    if (!target?.stopNum) {
      log.warn("No target stop found");
      return null;
    }

    log.info("Target stop:", target.stopNum);

    const jsonAddr = getJsonAddressForStop(target.stopNum, itinJson);
    if (jsonAddr) {
      const full = cleanAddress(jsonAddr);
      await window.ONTH_copyText(full);
      log.info("Copied from JSON:", full);
      return { stopNum: target.stopNum, full, raw: target, source: "json" };
    }

    const domAddr = await domExpandAndGetAddressForStop(target.stopNum);
    if (!domAddr) {
      log.warn("No DOM address found");
      return null;
    }

    const full = cleanAddress(domAddr);
    if (!full) {
      log.warn("Address cleaning failed");
      return null;
    }

    await window.ONTH_copyText(full);
    log.info("Copied from DOM:", full);
    return { stopNum: target.stopNum, full, raw: target, source: "dom" };
  }

  async function goBackToList() {
    if (document.querySelector(ROW_SEL)) {
      log.info("Already on list view");
      return true;
    }

    const findBackBtn = () => {
      const cands = [...document.querySelectorAll("button,a,[role='button']")];
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

    for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
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

  async function openToggleCopyStop(name, stopN = 5, phone = "") {
    if (!document.querySelector(ROW_SEL)) {
      log.info("Not on list view, going back");
      await goBackToList();
      await sleep(450);
    }

    const listPanel =
      document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    const savedScroll = listPanel ? listPanel.scrollTop : null;

    const ok = await clickDriver(name, phone);
    if (!ok) {
      log.error("Failed to click driver");
      return { ok: false, address: "" };
    }

    await waitFor(() => (getStopHeaders().length ? true : null), {
      timeout: 20000,
      interval: 200,
    });

    await sleep(250);
    await scrollToHideArea();
    await setHideCompleted(true);
    await sleep(350);

    const itinJson = await getItineraryJSON().catch((err) => {
      log.error("Failed to get itinerary JSON:", err);
      return null;
    });
    const res = await copyNthRemainingStopAddress(Number(stopN) || 5, itinJson);

    await goBackToList();
    await sleep(300);

    try {
      if (listPanel && typeof savedScroll === "number")
        listPanel.scrollTop = savedScroll;
    } catch (err) {
      log.warn("Scroll restore failed:", err);
    }

    const address = res?.full || "";
    return { ok: !!address, address };
  }

  /* ---------------------------
     UI
  ---------------------------- */
  const UI = {
    open: false,
    data: [],
    view: [],
    sortKey: "name",
    sortDir: "asc",
    filter: "",
    busy: false,
    stopN: CONFIG.DEFAULT_STOP_N,
    addrByKey: new LRUCache(CONFIG.MAX_CACHE_SIZE),
    pendingKey: null,
    openKey: null,
  };

  const STYLES = `
  #__onth_snap_btn__{
    position:fixed; top:12px; right:12px; z-index:2147483647;
    padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.14);
    background:rgba(2,6,23,.82); color:#e5e7eb; cursor:pointer; font-weight:800;
    box-shadow:0 10px 30px rgba(0,0,0,.35); backdrop-filter: blur(10px);
  }
  #__onth_snap_btn__:hover{ transform: translateY(-1px); }
  #__onth_snap_drawer__{
    position:fixed; top:64px; right:12px; width:440px; max-width:calc(100vw - 24px);
    height: calc(100vh - 92px); z-index:2147483646;
    background: rgba(2,6,23,.86); color:#e5e7eb;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.5);
    overflow:hidden; display:none; backdrop-filter: blur(12px);
  }
  #__onth_snap_drawer__.open{ display:flex; flex-direction:column; }
  #__onth_snap_head__{
    padding:12px 12px 10px; border-bottom:1px solid rgba(255,255,255,.10);
    display:flex; align-items:center; gap:10px;
  }
  #__onth_snap_title__{ font-weight:900; }
  #__onth_snap_count__{ margin-left:auto; font-size:12px; color:rgba(226,232,240,.75); }
  #__onth_snap_controls__{
    padding:10px 12px; display:flex; gap:8px; align-items:center;
    border-bottom:1px solid rgba(255,255,255,.10);
  }
  #__onth_snap_controls__ input{
    background: rgba(15,23,42,.75); color:#e5e7eb;
    border:1px solid rgba(255,255,255,.12);
    border-radius:10px; padding:8px 10px; font-size:13px; outline:none;
  }
  #__onth_snap_filter__{ flex:1; }
  #__onth_snap_stop__{ width:86px; text-align:center; }
  #__onth_snap_refresh__{
    background:#2563eb; border:0; color:#fff; border-radius:10px;
    padding:8px 10px; font-weight:900; cursor:pointer;
  }
  #__onth_snap_close__{
    margin-left:6px; background: rgba(15,23,42,.75);
    border:1px solid rgba(255,255,255,.12); color:#e5e7eb;
    border-radius:10px; padding:8px 10px; font-weight:900; cursor:pointer;
  }
  #__onth_snap_tablewrap__{ flex:1; overflow:auto; }
  #__onth_snap_table__{ width:100%; border-collapse:collapse; }
  #__onth_snap_table__ thead th{
    position:sticky; top:0; background: rgba(2,6,23,.95);
    padding:10px 10px; font-size:12px; color:rgba(148,163,184,.95);
    text-align:left; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.10);
    user-select:none;
  }
  #__onth_snap_table__ tbody td{
    padding:10px 10px; border-bottom:1px solid rgba(255,255,255,.06);
    font-size:13px; vertical-align:top;
  }
  #__onth_snap_table__ tbody tr:hover{ background: rgba(255,255,255,.04); }
  .__onth_mono{ font-variant-numeric: tabular-nums; }
  .__onth_row{ cursor:pointer; }
  .__onth_name{ font-weight:900; }
  .__onth_detail{
    background: rgba(15,23,42,.35);
    border-bottom:1px solid rgba(255,255,255,.06);
  }
  .__onth_detailBox{ padding:10px 10px 12px; display:grid; gap:8px; }
  .__onth_kv{ display:grid; grid-template-columns:86px 1fr; gap:6px 10px; }
  .__onth_k{ color:rgba(148,163,184,.95); font-size:12px; }
  .__onth_v{ color:#e5e7eb; font-size:13px; word-break:break-word; }
  .__onth_pills{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .__onth_pillNoBg{ border:0 !important; background: transparent !important; padding:0 !important; box-shadow:none !important; }
  .__onth_btn{
    border:1px solid rgba(255,255,255,.16);
    background: transparent;
    color:#e5e7eb;
    padding:8px 10px;
    border-radius:10px;
    font-weight:900;
    cursor:pointer;
  }
  .__onth_btn:hover{ background: rgba(255,255,255,.06); }
  .__onth_btn:active{ transform: translateY(1px); }
  .__onth_btnPrimary{ border-color: rgba(59,130,246,.45); }
  .__onth_btnPrimary:hover{ background: rgba(37,99,235,.16); }
  .__onth_btnSmall{ padding:6px 8px; border-radius:9px; font-size:12px; font-weight:900; }
  `;

  function openDrawer() {
    UI.open = true;
    document.getElementById("__onth_snap_drawer__")?.classList.add("open");
  }

  function closeDrawer() {
    UI.open = false;
    document.getElementById("__onth_snap_drawer__")?.classList.remove("open");
  }

  function fmt(v) {
    return typeof v === "number" && !Number.isNaN(v)
      ? Number.isInteger(v)
        ? String(v)
        : v.toFixed(1)
      : "";
  }

  function rebuildView() {
    const f = norm(UI.filter);
    let v = UI.data.slice();
    if (f)
      v = v.filter(
        (r) => norm(r.name).includes(f) || norm(r.number).includes(f)
      );

    const k = UI.sortKey;
    const dir = UI.sortDir;

    v.sort((a, b) => {
      const va = a[k],
        vb = b[k];
      const na = typeof va === "number",
        nb = typeof vb === "number";
      let c = 0;
      if (na && nb) c = va - vb;
      else
        c = String(va || "").localeCompare(String(vb || ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      return dir === "asc" ? c : -c;
    });

    UI.view = v;
    const countEl = document.getElementById("__onth_snap_count__");
    if (countEl) countEl.textContent = `${v.length} drivers`;
  }

  function renderTable() {
    const tbody = document.querySelector("#__onth_snap_table__ tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    for (const r of UI.view) {
      const tr = document.createElement("tr");
      tr.className = "__onth_row";
      tr.setAttribute("data-key", r.key);

      const tdName = document.createElement("td");
      tdName.className = "__onth_name";
      tdName.textContent = r.name;

      const tdRTS = document.createElement("td");
      tdRTS.className = "__onth_mono";
      tdRTS.textContent = r.projectedRTS || "";

      const tdStops = document.createElement("td");
      tdStops.className = "__onth_mono";
      tdStops.textContent = typeof r.stopsLeft === "number" ? String(r.stopsLeft) : "";

      const tdAvg = document.createElement("td");
      tdAvg.className = "__onth_mono";
      tdAvg.textContent = fmt(r.avgPerHour);

      const tdPace = document.createElement("td");
      tdPace.className = "__onth_mono";
      tdPace.textContent = fmt(r.lastHourPace);

      tr.appendChild(tdName);
      tr.appendChild(tdRTS);
      tr.appendChild(tdStops);
      tr.appendChild(tdAvg);
      tr.appendChild(tdPace);

      tbody.appendChild(tr);

      if (UI.openKey === r.key) {
        const cacheKey = `${r.key}|${UI.stopN}`;
        const addr =
          UI.addrByKey.get(cacheKey) || (UI.pendingKey === r.key ? "Working…" : "—");

        const dtr = document.createElement("tr");
        dtr.className = "__onth_detail";
        const td = document.createElement("td");
        td.setAttribute("colspan", "5");

        const detailBox = document.createElement("div");
        detailBox.className = "__onth_detailBox";

        const kvDiv = document.createElement("div");
        kvDiv.className = "__onth_kv";

        const addKV = (key, value) => {
          const k = document.createElement("div");
          k.className = "__onth_k";
          k.textContent = key;
          const v = document.createElement("div");
          v.className = "__onth_v";
          if (key === "Address") {
            v.setAttribute("data-addrkey", cacheKey);
          }
          v.textContent = value;
          kvDiv.appendChild(k);
          kvDiv.appendChild(v);
        };

        addKV("Name", r.name);
        addKV("Phone", r.number || "");
        addKV("Address", addr);

        const pillsDiv = document.createElement("div");
        pillsDiv.className = "__onth_pills";

        const refreshSpan = document.createElement("span");
        refreshSpan.className = "__onth_pillNoBg";
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "__onth_btn __onth_btnPrimary";
        refreshBtn.setAttribute("data-refreshkey", r.key);
        refreshBtn.textContent = "Refresh address";
        refreshSpan.appendChild(refreshBtn);

        const copySpan = document.createElement("span");
        copySpan.className = "__onth_pillNoBg";
        const copyBtn = document.createElement("button");
        copyBtn.className = "__onth_btn __onth_btnSmall";
        copyBtn.setAttribute("data-copykey", r.key);
        copyBtn.textContent = "Copy Info";
        copySpan.appendChild(copyBtn);

        pillsDiv.appendChild(refreshSpan);
        pillsDiv.appendChild(copySpan);

        detailBox.appendChild(kvDiv);
        detailBox.appendChild(pillsDiv);
        td.appendChild(detailBox);
        dtr.appendChild(td);
        tbody.appendChild(dtr);
      }
    }
  }

  async function refreshSnapshot() {
    if (globalMutex.isLocked) {
      toast("Busy…", null);
      return;
    }

    await globalMutex.lock();
    try {
      UI.busy = true;
      toast("Loading drivers…");
      const data = await collectAllDrivers();
      UI.data = data;
      if (UI.openKey && !UI.data.some((r) => r.key === UI.openKey)) UI.openKey = null;
      rebuildView();
      renderTable();
      toast(`Loaded ${data.length} drivers`, true);
    } catch (e) {
      log.error("Refresh snapshot failed:", e);
      toast("Failed to load drivers", false);
    } finally {
      UI.busy = false;
      globalMutex.unlock();
    }
  }

  async function requestAddress(row) {
    if (!row?.name) return;
    if (globalMutex.isLocked) {
      toast("Busy…", null);
      return;
    }

    const stopN = Math.max(1, Number(UI.stopN) || CONFIG.DEFAULT_STOP_N);
    const cacheKey = `${row.key}|${stopN}`;

    if (UI.addrByKey.has(cacheKey)) {
      UI.openKey = row.key;
      renderTable();
      toast(`Using cached stop ${stopN}`, true);
      return;
    }

    await globalMutex.lock();
    try {
      UI.busy = true;
      UI.pendingKey = row.key;

      if (UI.openKey !== row.key) UI.openKey = row.key;
      renderTable();

      toast(`Copying stop ${stopN}…`);
      const { ok, address } = await openToggleCopyStop(row.name, stopN, row.number);

      if (ok && address) {
        UI.addrByKey.set(cacheKey, String(address).trim());
        toast("Copied ✔", true);
      } else {
        toast("Failed ✖", false);
      }

      UI.pendingKey = null;
      renderTable();
    } catch (e) {
      log.error("Request address failed:", e);
      toast("Failed ✖", false);
      UI.pendingKey = null;
      renderTable();
    } finally {
      UI.busy = false;
      globalMutex.unlock();
    }
  }

  function injectUI() {
    if (document.getElementById("__onth_snap_drawer__")) return;

    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "__onth_snap_btn__";
    btn.textContent = "Driver Snapshot";
    btn.setAttribute("aria-label", "Open Driver Snapshot");
    btn.addEventListener("click", async () => {
      if (!UI.open) {
        openDrawer();
        if (!UI.data.length) await refreshSnapshot();
      } else closeDrawer();
    });
    document.body.appendChild(btn);

    const drawer = document.createElement("div");
    drawer.id = "__onth_snap_drawer__";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-label", "Driver Snapshot Panel");

    const head = document.createElement("div");
    head.id = "__onth_snap_head__";

    const title = document.createElement("div");
    title.id = "__onth_snap_title__";
    title.textContent = "Driver Snapshot";

    const count = document.createElement("div");
    count.id = "__onth_snap_count__";
    count.textContent = "0 drivers";

    head.appendChild(title);
    head.appendChild(count);

    const controls = document.createElement("div");
    controls.id = "__onth_snap_controls__";

    const stopInput = document.createElement("input");
    stopInput.id = "__onth_snap_stop__";
    stopInput.type = "number";
    stopInput.min = "1";
    stopInput.value = String(CONFIG.DEFAULT_STOP_N);
    stopInput.title = "Nth remaining stop (5 = 5th remaining)";
    stopInput.setAttribute("aria-label", "Stop number");

    const filterInput = document.createElement("input");
    filterInput.id = "__onth_snap_filter__";
    filterInput.type = "search";
    filterInput.placeholder = "Filter…";
    filterInput.setAttribute("aria-label", "Filter drivers");

    const refreshBtn = document.createElement("button");
    refreshBtn.id = "__onth_snap_refresh__";
    refreshBtn.textContent = "Refresh";
    refreshBtn.setAttribute("aria-label", "Refresh driver list");

    const closeBtn = document.createElement("button");
    closeBtn.id = "__onth_snap_close__";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close panel");

    controls.appendChild(stopInput);
    controls.appendChild(filterInput);
    controls.appendChild(refreshBtn);
    controls.appendChild(closeBtn);

    const tableWrap = document.createElement("div");
    tableWrap.id = "__onth_snap_tablewrap__";

    const table = document.createElement("table");
    table.id = "__onth_snap_table__";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    const headers = [
      { key: "name", label: "Name" },
      { key: "projectedRTS", label: "Projected RTS" },
      { key: "stopsLeft", label: "Stops Left" },
      { key: "avgPerHour", label: "Stops/hr" },
      { key: "lastHourPace", label: "Pace" }
    ];

    for (const h of headers) {
      const th = document.createElement("th");
      th.setAttribute("data-k", h.key);
      th.textContent = h.label;
      th.setAttribute("role", "columnheader");
      th.setAttribute("aria-sort", "none");
      headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);

    const tbody = document.createElement("tbody");

    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    drawer.appendChild(head);
    drawer.appendChild(controls);
    drawer.appendChild(tableWrap);

    document.body.appendChild(drawer);

    closeBtn.addEventListener("click", closeDrawer);
    refreshBtn.addEventListener("click", refreshSnapshot);

    filterInput.addEventListener("input", (e) => {
      UI.filter = String(e.target.value || "");
      rebuildView();
      renderTable();
    });

    stopInput.addEventListener("input", (e) => {
      UI.stopN = Math.max(1, Number(e.target.value) || CONFIG.DEFAULT_STOP_N);
      renderTable();
      toast(`Stop set to ${UI.stopN}`, null);
    });

    thead.querySelectorAll("th").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.dataset.k;
        if (UI.sortKey === k) UI.sortDir = UI.sortDir === "asc" ? "desc" : "asc";
        else (UI.sortKey = k), (UI.sortDir = "asc");

        thead.querySelectorAll("th").forEach(t => t.setAttribute("aria-sort", "none"));
        th.setAttribute("aria-sort", UI.sortDir === "asc" ? "ascending" : "descending");

        rebuildView();
        renderTable();
      });
    });

    drawer.addEventListener("click", async (e) => {
      const copyBtn = e.target.closest("button[data-copykey]");
      if (copyBtn) {
        e.preventDefault();
        const key = copyBtn.getAttribute("data-copykey");
        const row = UI.data.find((r) => r.key === key);
        if (!row) return;

        const cacheKey = `${key}|${UI.stopN}`;
        const addr =
          (UI.addrByKey.get(cacheKey) || "").trim() ||
          (document.querySelector(`[data-addrkey="${cssEscape(cacheKey)}"]`)?.textContent ||
            "").trim();

        const safeAddr = addr && addr !== "—" && addr !== "Working…" ? addr : "";
        if (!safeAddr) return toast("No address yet", false);

        const blob = `${row.name}\n${row.number || ""}\n${safeAddr}`.trim();
        const ok = await window.ONTH_copyText(blob);
        toast(ok ? "Copied info" : "Copy failed", ok);
        return;
      }

      const refreshBtn = e.target.closest("button[data-refreshkey]");
      if (refreshBtn) {
        e.preventDefault();
        const key = refreshBtn.getAttribute("data-refreshkey");
        const row = UI.data.find((r) => r.key === key);
        if (row) await requestAddress(row);
        return;
      }

      const rowEl = e.target.closest("tr[data-key]");
      if (!rowEl || e.target.closest("button")) return;

      e.preventDefault();
      const key = rowEl.getAttribute("data-key");

      const wasOpen = UI.openKey === key;
      UI.openKey = wasOpen ? null : key;
      renderTable();
      if (wasOpen) return;

      const row = UI.data.find((r) => r.key === key);
      if (row) await requestAddress(row);
    });
  }

  function ensure() {
    if (!document.body) return;
    injectUI();
  }

  let initInterval;
  let initAttempts = 0;
  const MAX_INIT_ATTEMPTS = 40;

  initInterval = setInterval(() => {
    initAttempts++;
    ensure();
    if (document.getElementById("__onth_snap_btn__")) {
      clearInterval(initInterval);
      log.info("UI initialized successfully");
    }
    if (initAttempts >= MAX_INIT_ATTEMPTS) {
      clearInterval(initInterval);
      log.warn("Max init attempts reached");
    }
  }, 250);

  const observer = new MutationObserver(() => {
    ensure();
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  log.info("Driver Snapshot v2.0.0 loaded");
})();
