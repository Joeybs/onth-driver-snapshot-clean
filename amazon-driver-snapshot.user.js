
// ==UserScript==
// @name         Amazon Driver Snapshot
// @namespace    https://github.com/onth/scripts
// @version      2.2.0
// @description  In-page Driver Snapshot drawer. Click driver → open itinerary → hide completed → copy Nth *remaining* stop address (default 5) → auto-back. Optimized for performance, reliability, and security.
// @match        https://logistics.amazon.com/operations/execution/itineraries*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Joeybs/onth-driver-snapshot-clean/main/amazon-driver-snapshot.user.js
// @downloadURL  https://raw.githubusercontent.com/Joeybs/onth-driver-snapshot-clean/main/amazon-driver-snapshot.user.js
// ==/UserScript==

/**
 * Amazon Driver Snapshot Userscript
 * 
 * Performance optimizations:
 * - Debounced input handlers to reduce unnecessary updates
 * - RequestAnimationFrame for smooth scrolling
 * - Batch DOM updates using DocumentFragment
 * - LRU cache for address data
 * - Performance monitoring with debug mode
 * - Single-pass address cleaning (no redundant processing)
 * 
 * Reliability improvements:
 * - Comprehensive error handling with try-catch blocks
 * - Input validation and sanitization
 * - Fetch timeout and retry mechanisms
 * - Memory leak prevention with cleanup system
 * 
 * Security enhancements:
 * - XSS prevention through text sanitization
 * - Input validation on user entries
 * - Safe clipboard operations with fallbacks
 * - Proper event listener cleanup
 * 
 * Enable debug mode: window.__ONTH_DEBUG__ = true
 */

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
    DEFAULT_STOP_N: 3,
    MAX_SCROLL_LOOPS: 160,
    STAGNANT_THRESHOLD: 3,
    BASE_SLEEP: 50,
    SCROLL_DELAY: 120,
    ROW_PROCESS_DELAY: 0,
    INITIAL_WAIT_DELAY: 200,
    MIN_SCROLL_AMOUNT: 260,
    SCROLL_MULTIPLIER: 1.2,
    RETRY_ATTEMPTS: 3,
    DEBOUNCE_DELAY: 300,
    FETCH_TIMEOUT: 15000,
    MAX_STOP_NUMBER: 999,
    MIN_STOP_NUMBER: 1,
  };

  // Utility functions
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s ?? "").toLowerCase().trim();
  const firstLine = (t = "") => (t?.split("\n")?.[0] ?? "").trim();
  const digits = (s) => String(s ?? "").replace(/\D+/g, "");
  const num = (t) => {
    const m = String(t ?? "").match(RX.numVal);
    return m ? Number(m[0]) : null;
  };
  const one = (t, ...rxs) => {
    t = String(t ?? "");
    for (const rx of rxs) {
      const m = t.match(rx);
      if (m) return m[1]?.trim();
    }
    return null;
  };
  const readViaSel = (root, arr) => {
    if (!root || !arr) return null;
    for (const sel of arr) {
      const el = root.querySelector(sel);
      if (el?.innerText) return el.innerText.trim();
    }
    return null;
  };
  const tidyPhone = (s) =>
    String(s ?? "")
      .replace(/^[^\d+]*(\+?[\d(].*)$/, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
  
  /**
   * Debounce function execution
   * @param {Function} fn - Function to debounce
   * @param {number} delay - Delay in milliseconds
   * @returns {Function} Debounced function
   */
  const debounce = (fn, delay) => {
    let timeoutId;
    return function debounced(...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
  };
  
  /**
   * Throttle function execution
   * @param {Function} fn - Function to throttle
   * @param {number} limit - Time limit in milliseconds
   * @returns {Function} Throttled function
   */
  const throttle = (fn, limit) => {
    let inThrottle;
    return function throttled(...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  };
  
  /**
   * Validate and sanitize stop number input
   * @param {*} value - Input value
   * @returns {number} Validated stop number
   */
  const validateStopNumber = (value) => {
    const num = Number(value);
    if (Number.isNaN(num) || !Number.isFinite(num)) {
      return CONFIG.DEFAULT_STOP_N;
    }
    return Math.max(CONFIG.MIN_STOP_NUMBER, Math.min(CONFIG.MAX_STOP_NUMBER, Math.floor(num)));
  };
  
  /**
   * Sanitize text input to prevent XSS
   * @param {string} text - Input text
   * @returns {string} Sanitized text
   */
  const sanitizeText = (text) => {
    return String(text ?? "").replace(/[<>&"']/g, (char) => {
      const entities = {
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return entities[char] || char;
    });
  };

  const cssEscape =
    window.CSS && typeof window.CSS.escape === "function"
      ? window.CSS.escape.bind(window.CSS)
      : (s) => String(s ?? "").replace(/[^\w-]/g, "\\$&");

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
    debug: (msg, ...args) => {
      if (window.__ONTH_DEBUG__) console.log(`[ONTH DEBUG] ${msg}`, ...args);
    },
  };
  
  /**
   * Performance monitoring utility
   */
  const perf = {
    timers: new Map(),
    start(label) {
      this.timers.set(label, performance.now());
      log.debug(`⏱️ Started: ${label}`);
    },
    end(label) {
      const start = this.timers.get(label);
      if (start) {
        const duration = (performance.now() - start).toFixed(2);
        log.debug(`⏱️ ${label}: ${duration}ms`);
        this.timers.delete(label);
        return duration;
      }
      return null;
    },
  };
  
  /**
   * Fetch with timeout and retry support
   * @param {string} url - URL to fetch
   * @param {object} options - Fetch options
   * @param {number} timeout - Timeout in milliseconds
   * @param {number} retries - Number of retry attempts
   * @returns {Promise<Response>}
   */
  const fetchWithTimeout = async (url, options = {}, timeout = CONFIG.FETCH_TIMEOUT, retries = CONFIG.RETRY_ATTEMPTS) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok && retries > 0) {
        log.warn(`Fetch failed (${response.status}), retrying...`);
        await sleep(500);
        return fetchWithTimeout(url, options, timeout, retries - 1);
      }
      
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        log.error('Fetch timeout:', url);
        if (retries > 0) {
          log.warn('Retrying after timeout...');
          await sleep(500);
          return fetchWithTimeout(url, options, timeout, retries - 1);
        }
      }
      
      throw error;
    }
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

  /**
   * Show toast notification with accessibility support
   * @param {string} msg - Message to display
   * @param {boolean|null} ok - Status indicator (true=success, false=error, null=info)
   */
  function toast(msg, ok = null) {
    try {
      let d = document.getElementById("__onth_snap_toast__");
      if (!d) {
        d = document.createElement("div");
        d.id = "__onth_snap_toast__";
        d.setAttribute("role", "status");
        d.setAttribute("aria-live", "polite");
        d.style.cssText = [
          "position:fixed;right:16px;bottom:16px;z-index:2147483647",
          "background:linear-gradient(135deg, rgba(15,23,42,.96), rgba(2,6,23,.94))",
          "color:#e5e7eb;border:1px solid rgba(59,130,246,.3)",
          "padding:12px 16px;border-radius:12px;opacity:0;transform:translateY(10px)",
          "transition:all 250ms cubic-bezier(0.4, 0, 0.2, 1);pointer-events:none",
          "max-width:62vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          "box-shadow:0 8px 24px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.05)",
          "backdrop-filter:blur(12px);font-size:13px;font-weight:600",
        ].join(";");
        document.body.appendChild(d);
      }
      
      // Update border and icon based on status
      if (ok === true) {
        d.style.borderColor = "rgba(34,197,94,.4)";
        d.textContent = "✅ " + sanitizeText(String(msg ?? ""));
      } else if (ok === false) {
        d.style.borderColor = "rgba(239,68,68,.4)";
        d.textContent = "❌ " + sanitizeText(String(msg ?? ""));
      } else {
        d.style.borderColor = "rgba(59,130,246,.35)";
        d.textContent = "ℹ️ " + sanitizeText(String(msg ?? ""));
      }
      
      d.style.opacity = "1";
      d.style.transform = "translateY(0)";
      clearTimeout(d.__t);
      d.__t = setTimeout(() => {
        d.style.opacity = "0";
        d.style.transform = "translateY(10px)";
      }, 1300);
    } catch (err) {
      log.error("Toast error:", err);
    }
  }

  /**
   * Clean and format address from raw text
   * @param {string} raw - Raw address text
   * @returns {string} Cleaned address
   */
  function cleanAddress(raw) {
    try {
      const txt = String(raw ?? "").replace(/\r/g, "\n");
      const lines = txt
        .split("\n")
        .map((s) => s?.trim())
        .filter(Boolean);

      const keep = lines.filter(
        (l) => !/^edit in/i.test(l) && !/^driver aid/i.test(l) && !/geostudio/i.test(l)
      );
      const hasZip = (s) => RX.zip.test(String(s ?? ""));

      if (keep.length >= 2 && !hasZip(keep[0]) && hasZip(keep[1]))
        return `${keep[0]}, ${keep[1]}`.trim();

      for (const l of keep) {
        if (hasZip(l) && /,/.test(l)) {
          const m = l.match(new RegExp(`^(.*?${RX.zip.source})`));
          return (m?.[1] ?? l).trim();
        }
      }
      for (const l of keep) {
        if (hasZip(l)) {
          const m = l.match(new RegExp(`^(.*?${RX.zip.source})`));
          return (m?.[1] ?? l).trim();
        }
      }
      return (keep[0] ?? lines[0] ?? "").trim();
    } catch (err) {
      log.error("cleanAddress error:", err);
      return String(raw ?? "").trim();
    }
  }

  /**
   * Copy text to clipboard with multiple fallback methods
   * @param {string} text - Text to copy
   * @returns {Promise<boolean>} Success status
   */
  window.ONTH_copyText = async (text) => {
    text = String(text ?? "");
    if (!text) {
      log.warn("Attempted to copy empty text");
      return false;
    }
    
    // Method 1: Modern Clipboard API
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      log.warn("Clipboard API failed:", err);
    }
    
    // Method 2: execCommand (deprecated but still works)
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const success = document.execCommand("copy");
      document.body.removeChild(ta);
      if (success) return true;
    } catch (err) {
      log.warn("execCommand copy failed:", err);
    }
    
    // Method 3: Legacy copy function
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
     Driver rows
  ---------------------------- */
  /**
   * Extract phone number from driver row
   * @param {HTMLElement} row - Row element
   * @param {string[]} lines - Text lines
   * @returns {string} Phone number
   */
  function extractPhone(row, lines) {
    if (!row) return "";
    
    try {
      const tel = row.querySelector('a[href^="tel:"]');
      if (tel) {
        const href = tel.getAttribute("href") ?? "";
        const fromHref = href.replace(/^tel:/i, "").trim();
        if (fromHref) return tidyPhone(fromHref);
      }
      
      const order = [1, 2, 0, 3];
      for (const i of order) {
        const L = lines?.[i] ?? "";
        if (!L || RX.time12h.test(L)) continue;
        const m = L.match(RX.phone);
        if (m) return tidyPhone(m[1]);
      }
      
      const all = lines.join("  ");
      if (!RX.time12h.test(all)) {
        const m = all.match(RX.phone);
        if (m) return tidyPhone(m[1]);
      }
    } catch (err) {
      log.warn("extractPhone error:", err);
    }
    
    return "";
  }

  /**
   * Parse driver row element into structured data
   * @param {HTMLElement} row - Row element
   * @returns {object} Driver data
   */
  function parseRow(row) {
    try {
      const text = row?.innerText ?? "";
      const lines = text
        .split("\n")
        .map((s) => s?.trim())
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
        const m = (row?.innerText ?? "").match(RX.stopsPair);
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
    } catch (err) {
      log.error("parseRow error:", err);
      return {
        key: `error_${Date.now()}`,
        name: "[error]",
        number: "",
        projectedRTS: "",
        avgPerHour: null,
        lastHourPace: null,
        stopsLeft: null,
      };
    }
  }

  // DOM element tracking for cleanup
  const trackedElements = new WeakMap();
  
  /**
   * Smoothly scroll element using requestAnimationFrame
   * @param {HTMLElement} element - Element to scroll
   * @param {number} target - Target scroll position
   * @returns {Promise<void>}
   */
  const smoothScrollTo = (element, target) => {
    return new Promise((resolve) => {
      if (!element) {
        resolve();
        return;
      }
      
      const start = element.scrollTop;
      const distance = target - start;
      const duration = 300; // ms
      const startTime = performance.now();
      
      const animate = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function
        const easeProgress = progress < 0.5
          ? 2 * progress * progress
          : -1 + (4 - 2 * progress) * progress;
        
        element.scrollTop = start + distance * easeProgress;
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };
      
      requestAnimationFrame(animate);
    });
  };

  /**
   * Collect all driver data by scrolling through the list
   * @returns {Promise<Array>} Array of driver data
   */
  async function collectAllDrivers() {
    perf.start('collectAllDrivers');
    
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
      await smoothScrollTo(panel, 0);
    } catch (err) {
      log.warn("Failed to scroll to top:", err);
      panel.scrollTop = 0;
    }
    await sleep(CONFIG.INITIAL_WAIT_DELAY);

    const out = [];
    let lastCount = 0;
    let stagnant = 0;

    for (let loops = 0; loops < CONFIG.MAX_SCROLL_LOOPS; loops++) {
      const rows = [...document.querySelectorAll(SELECTORS.rows)];
      for (const row of rows) {
        if (trackedElements.has(row)) continue;
        trackedElements.set(row, true);
        out.push(parseRow(row));
        if (CONFIG.ROW_PROCESS_DELAY > 0) {
          await sleep(CONFIG.ROW_PROCESS_DELAY);
        }
      }

      const atBottom =
        panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 6;
      stagnant = out.length === lastCount ? stagnant + 1 : 0;
      lastCount = out.length;

      if (atBottom && stagnant >= CONFIG.STAGNANT_THRESHOLD) {
        log.info("Reached bottom with stagnant count:", stagnant);
        break;
      }

      const scrollAmount = Math.max(CONFIG.MIN_SCROLL_AMOUNT, panel.clientHeight * CONFIG.SCROLL_MULTIPLIER);
      try {
        await smoothScrollTo(panel, panel.scrollTop + scrollAmount);
      } catch (err) {
        log.warn("Smooth scroll failed, using fallback:", err);
        panel.scrollTop += scrollAmount;
      }
      await sleep(CONFIG.SCROLL_DELAY);
    }

    perf.end('collectAllDrivers');
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

  /* ---------------------------
     Stop DOM helpers
  ---------------------------- */
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

  async function copyNthRemainingStopAddress(nthRemaining = 5) {
    perf.start('copyNthRemainingStopAddress');
    
    const want = Math.max(1, Number(nthRemaining) || 5);
    const { target } = await collectRemainingStopsNth(want);
    if (!target?.stopNum) {
      log.warn("No target stop found");
      perf.end('copyNthRemainingStopAddress');
      return null;
    }

    log.info("Target stop:", target.stopNum);

    // Use DOM-based address retrieval
    const domAddr = await domExpandAndGetAddressForStop(target.stopNum);
    
    if (!domAddr) {
      log.warn("No DOM address found");
      perf.end('copyNthRemainingStopAddress');
      return null;
    }

    const full = domAddr;  // Already cleaned in domExpandAndGetAddressForStop
    if (!full) {
      log.warn("Address cleaning failed");
      perf.end('copyNthRemainingStopAddress');
      return null;
    }

    await window.ONTH_copyText(full);
    log.info("Copied from DOM:", full);
    perf.end('copyNthRemainingStopAddress');
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

    const res = await copyNthRemainingStopAddress(Number(stopN) || 5);

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
  #__onth_snap_btn__ {
    position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(59,130,246,.35);
    background: linear-gradient(135deg, rgba(37,99,235,.92), rgba(29,78,216,.88));
    color: #fff; cursor: pointer; font-weight: 800; font-size: 13px;
    box-shadow: 0 4px 12px rgba(37,99,235,.35), 0 8px 24px rgba(0,0,0,.25);
    backdrop-filter: blur(10px);
    transition: all 250ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  #__onth_snap_btn__:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(37,99,235,.45), 0 12px 32px rgba(0,0,0,.3);
    background: linear-gradient(135deg, rgba(59,130,246,.95), rgba(37,99,235,.92));
  }
  #__onth_snap_btn__:active {
    transform: translateY(0);
    transition: all 100ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  #__onth_snap_drawer__ {
    position: fixed; top: 64px; right: 12px; width: 440px; max-width: calc(100vw - 24px);
    height: calc(100vh - 92px); z-index: 2147483646;
    background: linear-gradient(145deg, rgba(15,23,42,.94), rgba(2,6,23,.92));
    color: #e5e7eb;
    border: 1px solid rgba(59,130,246,.2);
    border-radius: 16px;
    box-shadow: 0 20px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.05);
    overflow: hidden; display: none;
    backdrop-filter: blur(16px);
  }
  #__onth_snap_drawer__.open { display: flex; flex-direction: column; }
  #__onth_snap_head__ {
    padding: 14px 16px 12px;
    border-bottom: 1px solid rgba(59,130,246,.15);
    background: rgba(30,41,59,.4);
    display: flex; align-items: center; gap: 10px;
  }
  #__onth_snap_title__ {
    font-weight: 900;
    font-size: 15px;
    color: #f1f5f9;
    letter-spacing: -0.01em;
  }
  #__onth_snap_count__ {
    margin-left: auto;
    font-size: 12px;
    color: rgba(148,163,184,.85);
    font-weight: 600;
  }
  #__onth_snap_controls__ {
    padding: 12px 16px;
    display: flex; gap: 8px; align-items: center;
    border-bottom: 1px solid rgba(59,130,246,.12);
    background: rgba(30,41,59,.25);
  }
  #__onth_snap_controls__ input {
    background: rgba(30,41,59,.6);
    color: #e5e7eb;
    border: 1px solid rgba(59,130,246,.25);
    border-radius: 10px;
    padding: 9px 12px;
    font-size: 13px;
    outline: none;
    transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  #__onth_snap_controls__ input:focus {
    border-color: rgba(59,130,246,.5);
    background: rgba(30,41,59,.75);
    box-shadow: 0 0 0 3px rgba(59,130,246,.1);
  }
  #__onth_snap_filter__ { flex: 1; }
  #__onth_snap_stop__ { width: 86px; text-align: center; }
  #__onth_snap_refresh__ {
    background: linear-gradient(135deg, #3b82f6, #2563eb);
    border: 0;
    color: #fff;
    border-radius: 10px;
    padding: 9px 14px;
    font-weight: 900;
    font-size: 13px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(37,99,235,.3);
    transition: all 220ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  #__onth_snap_refresh__:hover {
    background: linear-gradient(135deg, #60a5fa, #3b82f6);
    box-shadow: 0 4px 12px rgba(37,99,235,.4);
    transform: translateY(-1px);
  }
  #__onth_snap_refresh__:active {
    transform: translateY(0);
    transition: all 100ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  #__onth_snap_close__ {
    margin-left: 6px;
    background: rgba(30,41,59,.6);
    border: 1px solid rgba(148,163,184,.25);
    color: #e5e7eb;
    border-radius: 10px;
    padding: 9px 12px;
    font-weight: 900;
    font-size: 13px;
    cursor: pointer;
    transition: all 220ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  #__onth_snap_close__:hover {
    background: rgba(51,65,85,.75);
    border-color: rgba(148,163,184,.35);
    transform: translateY(-1px);
  }
  #__onth_snap_close__:active {
    transform: translateY(0);
    transition: all 100ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  #__onth_snap_tablewrap__ { flex: 1; overflow: auto; }
  #__onth_snap_table__ { width: 100%; border-collapse: collapse; }
  #__onth_snap_table__ thead th {
    position: sticky; top: 0;
    background: linear-gradient(180deg, rgba(15,23,42,.98), rgba(15,23,42,.95));
    padding: 12px 12px;
    font-size: 12px;
    color: rgba(148,163,184,1);
    text-align: left;
    cursor: pointer;
    border-bottom: 1px solid rgba(59,130,246,.2);
    user-select: none;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    transition: color 200ms ease;
  }
  #__onth_snap_table__ thead th:hover {
    color: rgba(59,130,246,.95);
  }
  #__onth_snap_table__ tbody td {
    padding: 11px 12px;
    border-bottom: 1px solid rgba(255,255,255,.05);
    font-size: 13px;
    vertical-align: top;
  }
  #__onth_snap_table__ tbody tr {
    transition: background-color 200ms ease;
  }
  #__onth_snap_table__ tbody tr:hover {
    background: rgba(59,130,246,.08);
  }
  .__onth_mono { font-variant-numeric: tabular-nums; }
  .__onth_row { cursor: pointer; }
  .__onth_name {
    font-weight: 900;
    color: #f1f5f9;
  }
  .__onth_detail {
    background: linear-gradient(180deg, rgba(30,41,59,.45), rgba(15,23,42,.35));
    border-bottom: 1px solid rgba(59,130,246,.15);
  }
  .__onth_detailBox { padding: 14px 14px 16px; display: grid; gap: 10px; }
  .__onth_kv { display: grid; grid-template-columns: 86px 1fr; gap: 8px 12px; }
  .__onth_k {
    color: rgba(148,163,184,1);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .__onth_v {
    color: #e5e7eb;
    font-size: 13px;
    word-break: break-word;
  }
  .__onth_pills { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .__onth_pillNoBg { border: 0 !important; background: transparent !important; padding: 0 !important; box-shadow: none !important; }
  .__onth_btn {
    border: 1px solid rgba(148,163,184,.3);
    background: rgba(30,41,59,.5);
    color: #e5e7eb;
    padding: 9px 12px;
    border-radius: 10px;
    font-weight: 900;
    font-size: 12px;
    cursor: pointer;
    transition: all 220ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .__onth_btn:hover {
    background: rgba(51,65,85,.65);
    border-color: rgba(148,163,184,.45);
    transform: translateY(-1px);
  }
  .__onth_btn:active {
    transform: translateY(0);
    transition: all 100ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .__onth_btnPrimary {
    border-color: rgba(59,130,246,.5);
    background: linear-gradient(135deg, rgba(59,130,246,.85), rgba(37,99,235,.75));
    color: #fff;
    box-shadow: 0 2px 8px rgba(37,99,235,.25);
  }
  .__onth_btnPrimary:hover {
    background: linear-gradient(135deg, rgba(96,165,250,.9), rgba(59,130,246,.85));
    border-color: rgba(59,130,246,.65);
    box-shadow: 0 4px 12px rgba(37,99,235,.35);
  }
  .__onth_btnSmall {
    padding: 7px 10px;
    border-radius: 9px;
    font-size: 12px;
    font-weight: 900;
  }
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

  /**
   * Rebuild filtered and sorted view of driver data
   */
  function rebuildView() {
    perf.start('rebuildView');
    
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
        c = String(va ?? "").localeCompare(String(vb ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      return dir === "asc" ? c : -c;
    });

    UI.view = v;
    const countEl = document.getElementById("__onth_snap_count__");
    if (countEl) countEl.textContent = `${v.length} drivers`;
    
    perf.end('rebuildView');
  }
  
  /**
   * Batch DOM updates for table rendering
   */
  function renderTable() {
    perf.start('renderTable');
    
    const tbody = document.querySelector("#__onth_snap_table__ tbody");
    if (!tbody) {
      perf.end('renderTable');
      return;
    }
    
    // Use DocumentFragment for batch DOM updates
    const fragment = document.createDocumentFragment();

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

      fragment.appendChild(tr);

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
        fragment.appendChild(dtr);
      }
    }
    
    // Single DOM update
    tbody.innerHTML = "";
    tbody.appendChild(fragment);
    
    perf.end('renderTable');
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

  /**
   * Cleanup function for memory leak prevention
   */
  const cleanup = {
    listeners: [],
    intervals: [],
    observers: [],
    
    addListener(element, event, handler, options) {
      if (!element) return;
      element.addEventListener(event, handler, options);
      this.listeners.push({ element, event, handler, options });
    },
    
    addInterval(id) {
      this.intervals.push(id);
    },
    
    addObserver(observer) {
      this.observers.push(observer);
    },
    
    removeAll() {
      // Remove event listeners
      for (const { element, event, handler, options } of this.listeners) {
        try {
          element?.removeEventListener(event, handler, options);
        } catch (err) {
          log.warn("Failed to remove listener:", err);
        }
      }
      this.listeners = [];
      
      // Clear intervals
      for (const id of this.intervals) {
        clearInterval(id);
      }
      this.intervals = [];
      
      // Disconnect observers
      for (const observer of this.observers) {
        try {
          observer?.disconnect();
        } catch (err) {
          log.warn("Failed to disconnect observer:", err);
        }
      }
      this.observers = [];
      
      log.info("Cleanup completed");
    }
  };
  
  // Global cleanup on page unload
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => cleanup.removeAll());
  }

  /**
   * Inject UI elements into the page
   */
  function injectUI() {
    if (document.getElementById("__onth_snap_drawer__")) return;

    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "__onth_snap_btn__";
    btn.textContent = "Driver Snapshot";
    btn.setAttribute("aria-label", "Open Driver Snapshot");
    
    const handleBtnClick = async () => {
      if (!UI.open) {
        openDrawer();
        if (!UI.data.length) await refreshSnapshot();
      } else closeDrawer();
    };
    
    cleanup.addListener(btn, "click", handleBtnClick);
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
    stopInput.min = String(CONFIG.MIN_STOP_NUMBER);
    stopInput.max = String(CONFIG.MAX_STOP_NUMBER);
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
      { key: "lastHourPace", label: "Last Hour" }
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

    // Event handlers with debouncing
    cleanup.addListener(closeBtn, "click", closeDrawer);
    
    const debouncedRefresh = debounce(refreshSnapshot, CONFIG.DEBOUNCE_DELAY);
    cleanup.addListener(refreshBtn, "click", debouncedRefresh);

    const debouncedFilter = debounce((e) => {
      UI.filter = sanitizeText(String(e.target?.value ?? ""));
      rebuildView();
      renderTable();
    }, CONFIG.DEBOUNCE_DELAY);
    cleanup.addListener(filterInput, "input", debouncedFilter);

    const handleStopInput = (e) => {
      const validated = validateStopNumber(e.target?.value);
      UI.stopN = validated;
      e.target.value = String(validated);
      toast(`Stop set to ${UI.stopN}`, null);
    };
    cleanup.addListener(stopInput, "input", debounce(handleStopInput, CONFIG.DEBOUNCE_DELAY));

    thead.querySelectorAll("th").forEach((th) => {
      const handleSort = () => {
        const k = th.dataset.k;
        if (UI.sortKey === k) UI.sortDir = UI.sortDir === "asc" ? "desc" : "asc";
        else (UI.sortKey = k), (UI.sortDir = "asc");

        thead.querySelectorAll("th").forEach(t => t.setAttribute("aria-sort", "none"));
        th.setAttribute("aria-sort", UI.sortDir === "asc" ? "ascending" : "descending");

        rebuildView();
        renderTable();
      };
      cleanup.addListener(th, "click", handleSort);
    });

    const handleDrawerClick = async (e) => {
      const copyBtn = e.target?.closest("button[data-copykey]");
      if (copyBtn) {
        e.preventDefault();
        const key = copyBtn.getAttribute("data-copykey");
        const row = UI.data.find((r) => r.key === key);
        if (!row) return;

        const cacheKey = `${key}|${UI.stopN}`;
        const addr =
          (UI.addrByKey.get(cacheKey) ?? "").trim() ||
          (document.querySelector(`[data-addrkey="${cssEscape(cacheKey)}"]`)?.textContent ??
            "").trim();

        const safeAddr = addr && addr !== "—" && addr !== "Working…" ? addr : "";
        if (!safeAddr) return toast("No address yet", false);

        const blob = `${row.name}\n${row.number ?? ""}\n${safeAddr}`.trim();
        const ok = await window.ONTH_copyText(blob);
        toast(ok ? "Copied info" : "Copy failed", ok);
        return;
      }

      const refreshBtn = e.target?.closest("button[data-refreshkey]");
      if (refreshBtn) {
        e.preventDefault();
        const key = refreshBtn.getAttribute("data-refreshkey");
        const row = UI.data.find((r) => r.key === key);
        if (row) await requestAddress(row);
        return;
      }

      const rowEl = e.target?.closest("tr[data-key]");
      if (!rowEl || e.target?.closest("button")) return;

      e.preventDefault();
      const key = rowEl.getAttribute("data-key");

      const wasOpen = UI.openKey === key;
      UI.openKey = wasOpen ? null : key;
      renderTable();
      if (wasOpen) return;

      const row = UI.data.find((r) => r.key === key);
      if (row) await requestAddress(row);
    };
    
    cleanup.addListener(drawer, "click", handleDrawerClick);
  }

  /**
   * Ensure UI is injected when DOM is ready
   */
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
  
  cleanup.addInterval(initInterval);

  const observer = new MutationObserver(() => {
    ensure();
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    cleanup.addObserver(observer);
  }

  log.info("Driver Snapshot v2.2.0 loaded");
  log.debug("Debug mode:", !!window.__ONTH_DEBUG__);
})();
