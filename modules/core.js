// modules/core.js
// Core utilities, constants, config, network hooks, and helper functions

export const SELECTORS = {
  rows: '[data-testid="allow-text-selection-div"]',
  scrollPanel: ". fp-page-template",
  projectedRTS: ["[data-testid='projected-rts']", "[data-attr='projected-rts']"],
  avgPerHour: ["[data-testid='avg-stops-per-hour']", "[data-attr='avg-stops-per-hour']"],
  lastHourPace: ["[data-testid='last-hour-pace']", "[data-attr='last-hour-pace']"],
};

export const RX = {
  phone: /(\+?\d[\d\s().-]{7,}\d)/,
  time12h: /\b\d{1,2}:\d{2}\s*[APMapm]{2}\b/,
  avg:  /\bAvg(? :\. |\s+stops\/hour|\s*\/\s*hr)?\s*[:\-]?\s*(-?\d+(?:\.\d+)?)/i,
  pace: /\b(?:Pace|Last\s*(? :hr|hour))\s*[:\-]?\s*(-?\d+(? :\.\d+)?)/i,
  rts: /\bProjected\s*RTS\s*[:\-]?\s*([0-9]{1,2}:[0-9]{2}\s*[APMapm]{2})\b/i,
  rtsAlt: /\bRTS\s*[:\-]?\s*([0-9]{1,2}:[0-9]{2}\s*[APMapm]{2})\b/i,
  numVal: /-?\d+(?:\.\d+)?/,
  zip: /\b\d{5}(-\d{4})?\b/,
  stopsPair: /(\d+)\s*\/\s*(\d+)\s*stops/i,
};

export const CONFIG = {
  MAX_CACHE_SIZE: 500,
  DEFAULT_STOP_N: 5,
  MAX_SCROLL_LOOPS: 160,
  STAGNANT_THRESHOLD: 7,
  BASE_SLEEP:  120,
  RETRY_ATTEMPTS: 3,
  VERSION: "1.9.5",
};

// ============================================
// LOGGING
// ============================================
export const log = {
  info: (msg, ... args) => console.log(`[ONTH] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[ONTH] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ONTH] ${msg}`, ...args),
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const norm = (s) => String(s || "").toLowerCase().trim();
export const firstLine = (t = "") => (t. split("\n")[0] || "").trim();
export const digits = (s) => String(s || "").replace(/\D+/g, "");

export const num = (t) => {
  const m = String(t || "").match(RX.numVal);
  return m ? Number(m[0]) : null;
};

export const one = (t, ... rxs) => {
  t = String(t || "");
  for (const rx of rxs) {
    const m = t.match(rx);
    if (m) return m[1]. trim();
  }
  return null;
};

export const readViaSel = (root, arr) => {
  for (const sel of arr || []) {
    const el = root.querySelector(sel);
    if (el?. innerText) return el.innerText.trim();
  }
  return null;
};

export const tidyPhone = (s) =>
  String(s || "")
    .replace(/^[^\d+]*(\+? [\d(]. *)$/, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

export const cssEscape =
  window.CSS && typeof window.CSS.escape === "function"
    ? window.CSS.escape. bind(window.CSS)
    : (s) => String(s).replace(/[^\w-]/g, "\\$&");

export const escAttr = (v) => String(v ??  "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const escHtml = (v) => {
  const div = document.createElement("div");
  div.textContent = String(v ?? "");
  return div.innerHTML;
};

// ============================================
// MUTEX FOR ASYNC OPERATIONS
// ============================================
export class Mutex {
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

export const globalMutex = new Mutex();

// ============================================
// LRU CACHE IMPLEMENTATION
// ============================================
export class LRUCache {
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
    if (this._cache.has(key)) this._cache.delete(key);
    else if (this._cache.size >= this._maxSize) {
      const firstKey = this._cache. keys().next().value;
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

// ============================================
// TOAST NOTIFICATIONS
// ============================================
let toastTimeout;

export function toast(msg, ok = null) {
  let d = document.getElementById("__onth_snap_toast__");
  if (!d) {
    d = document.createElement("div");
    d.id = "__onth_snap_toast__";
    d.setAttribute("role", "status");
    d.setAttribute("aria-live", "polite");
    d.style.cssText = [
      "position: fixed;right:16px;bottom:16px;z-index:2147483647",
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

// ============================================
// ADDRESS CLEANING
// ============================================
export function cleanAddress(raw) {
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
      const m = l.match(new RegExp(`^(.*? ${RX.zip.source})`));
      return (m ? m[1] : l).trim();
    }
  }
  for (const l of keep) {
    if (hasZip(l)) {
      const m = l.match(new RegExp(`^(.*?${RX.zip.source})`));
      return (m ? m[1] :  l).trim();
    }
  }
  return (keep[0] || lines[0] || "").trim();
}

// ============================================
// CLIPBOARD COPY
// ============================================
export const copyText = async (text) => {
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

// Expose to window for legacy compatibility
window. ONTH_copyText = copyText;

// ============================================
// NETWORK HOOKS
// ============================================
export function hookNetwork() {
  if (window.__ONTH_NET__?. hooked) return;

  if (! window.__ONTH_NET__) {
    window.__ONTH_NET__ = { hooked: false, byId: Object.create(null) };
  }
  if (window.__ONTH_NET__.hooked) return;
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
    const res = await origFetch(... args);
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
        const txt = this. responseText;
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
}

// ============================================
// WAIT FOR HELPER
// ============================================
export const waitFor = async (fn, { timeout = 9000, interval = 120 } = {}) => {
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
