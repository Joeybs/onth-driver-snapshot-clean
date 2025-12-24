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
  /* =========================
     0) Selectors + utils
  ========================= */
  const SELECTORS = {
    rows: '[data-testid="allow-text-selection-div"]',
    scrollPanel: '.fp-page-template',
    projectedRTS: ['[data-testid="projected-rts"]', '[data-attr="projected-rts"]'],
    avgPerHour: ['[data-testid="avg-stops-per-hour"]', '[data-attr="avg-stops-per-hour"]'],
    lastHourPace: ['[data-testid="last-hour-pace"]', '[data-attr="last-hour-pace"]'],
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

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const sleep = delay;

  const norm = (s) => String(s || "").toLowerCase().trim();
  const firstLine = (t = "") => ((t.split("\n")[0] || "").trim());
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

  // Safe CSS.escape (avoid name collision with our styles var and older engines)
  const cssEscape = (window.CSS && typeof window.CSS.escape === "function")
    ? window.CSS.escape.bind(window.CSS)
    : (s) => String(s).replace(/[^\w-]/g, "\\$&");

  function toast(msg, ok = null) {
    let d = document.getElementById("__onth_snap_toast__");
    if (!d) {
      d = document.createElement("div");
      d.id = "__onth_snap_toast__";
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

  // ✅ copy ONLY the real address (strip GeoStudio / Driver aid / extra junk)
  function cleanAddress(raw) {
    const txt = String(raw || "").replace(/\r/g, "\n");
    const lines = txt.split("\n").map((s) => s.trim()).filter(Boolean);

    const keep = lines.filter(
      (l) =>
        !/^edit in/i.test(l) &&
        !/^driver aid/i.test(l) &&
        !/geostudio/i.test(l)
    );

    const hasZip = (s) => RX.zip.test(String(s || ""));

    if (keep.length >= 2 && !hasZip(keep[0]) && hasZip(keep[1])) {
      return `${keep[0]}, ${keep[1]}`.trim();
    }

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

  /* =========================
     Clipboard helper (reliable)
  ========================= */
  window.ONTH_copyText = async (text) => {
    text = String(text ?? "");
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (_) {}
    try { copy(text); return true; } catch (_) {}
    return false;
  };

  /* =========================
     0.5) Capture itinerary JSON (fetch + XHR)
  ========================= */
  (function hookNetworkOnce() {
    if (window.__ONTH_NET__?.hooked) return;
    window.__ONTH_NET__ = window.__ONTH_NET__ || {};
    window.__ONTH_NET__.hooked = true;

    const isItinUrl = (url) => /\/operations\/execution\/api\/itineraries\/[^/?]+/i.test(String(url || ""));

    const saveIfItinerary = (j) => {
      try {
        if (j?.addresses?.length) window.__ONTH_NET__.last = j;
      } catch (_) {}
    };

    // fetch hook
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const url = String(args?.[0]?.url || args?.[0] || "");
        if (isItinUrl(url)) res.clone().json().then(saveIfItinerary).catch(() => {});
      } catch (_) {}
      return res;
    };

    // XHR hook
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
          saveIfItinerary(JSON.parse(txt));
        } catch (_) {}
      });
      return origSend.apply(this, args);
    };
  })();

  /* =========================
     1) Parse driver rows
  ========================= */
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
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const name = firstLine(text) || "[unknown]";
    const phone = extractPhone(row, lines);

    let projectedRTS = readViaSel(row, SELECTORS.projectedRTS) || one(text, RX.rts, RX.rtsAlt) || "";
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
        if (!Number.isNaN(done) && !Number.isNaN(total)) {
          stopsLeft = Math.max(0, total - done);
        }
      }
    }

    const fix = (v) => (typeof v === "number" && !Number.isNaN(v)) ? v : null;
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

  async function collectAllDrivers() {
    const panel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (!panel) { toast("Scroll container not found", false); return []; }

    for (const r of document.querySelectorAll(SELECTORS.rows)) delete r.__DONE__;

    try { panel.scrollTop = 0; } catch (_) {}
    await delay(450);

    const out = [];
    let lastCount = 0;
    let stagnant = 0;
    let loops = 0;

    while (loops++ < 160) {
      const rows = [...document.querySelectorAll(SELECTORS.rows)];
      for (const row of rows) {
        if (row.__DONE__) continue;
        row.__DONE__ = true;
        out.push(parseRow(row));
        await delay(18);
      }

      const atBottom = (panel.scrollTop + panel.clientHeight) >= (panel.scrollHeight - 6);

      if (out.length === lastCount) stagnant++;
      else stagnant = 0;
      lastCount = out.length;

      if (atBottom && stagnant >= 7) break;

      panel.scrollTop += Math.max(260, panel.clientHeight * 0.9);
      await delay(360);
    }
    return out;
  }

  /* =======================================================================
     2) open driver + hide completed + copy Nth REMAINING stop address + auto-back
  ======================================================================= */
  const waitFor = async (fn, { timeout = 9000, interval = 120 } = {}) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  };

  const firstLineLocal = (t) => (t || "").split("\n")[0].trim();
  const ROW_SEL = SELECTORS.rows;

  function clickAtCenter(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  function dblClickAtCenter(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 2 };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    el.dispatchEvent(new MouseEvent("dblclick", opts));
  }
  function pressEnter(el) {
    el.focus?.();
    const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function rowMatches(row, targetName, targetPhone) {
    const nameOk = norm(firstLineLocal(row?.innerText || "")) === norm(targetName || "");
    if (!nameOk) return false;
    if (!targetPhone) return true;
    const want = digits(targetPhone);
    if (!want) return true;
    const got = digits(row?.innerText || "");
    return got.includes(want);
  }

  async function findRowByNameScrolling(namePart, phone, { maxLoops = 200 } = {}) {
    const panel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (!panel) return null;

    let rows = [...document.querySelectorAll(ROW_SEL)];
    let row = rows.find((r) => rowMatches(r, namePart, phone));
    if (row) return row;

    const saved = panel.scrollTop;
    try { panel.scrollTop = 0; } catch (_) {}
    await sleep(120);

    let loops = 0;
    while (loops++ < maxLoops) {
      rows = [...document.querySelectorAll(ROW_SEL)];
      row = rows.find((r) => rowMatches(r, namePart, phone));
      if (row) return row;

      const atBottom = (panel.scrollTop + panel.clientHeight) >= (panel.scrollHeight - 6);
      if (atBottom) break;

      panel.scrollTop += Math.max(260, panel.clientHeight * 0.9);
      await sleep(160);
    }

    try { panel.scrollTop = saved; } catch (_) {}
    return null;
  }

  async function clickDriverExact(row) {
    if (!row) return null;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    clickAtCenter(row);
    await sleep(160);
    dblClickAtCenter(row);
    await sleep(160);
    pressEnter(row);
    return row;
  }

  async function clickDriver(name, phone) {
    {
      const rows = [...document.querySelectorAll(ROW_SEL)];
      const row = rows.find((r) => rowMatches(r, name, phone));
      if (row) return clickDriverExact(row);
    }
    const row = await findRowByNameScrolling(name, phone);
    if (row) return clickDriverExact(row);
    return null;
  }

  function findHideToggle() {
    let el = document.querySelector('input[role="switch"][type="checkbox"].css-hkr77h');
    if (el) return el;

    const cands = [...document.querySelectorAll(
      'input[role="switch"][type="checkbox"], input[type="checkbox"][role="switch"], [role="switch"]'
    )];
    el = cands.find((e) => /hide completed stops/i.test(e.closest("label,div,span,section,form")?.textContent || ""));
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
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  async function scrollToHideArea() {
    const search =
      document.querySelector('input[placeholder="Search..."]') ||
      [...document.querySelectorAll('input,button,[role="switch"]')].find((n) =>
        /hide completed stops/i.test(n.closest("label,div,span,section,form")?.textContent || "")
      );
    if (search) { search.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    for (let i = 0; i < 7; i++) { window.scrollBy({ top: window.innerHeight * 0.5, behavior: "smooth" }); await sleep(180); }
  }

  async function setHideCompleted(want) {
    const el = await waitFor(findHideToggle, { timeout: 7000 });
    if (!el) return false;
    if (typeof want === "boolean") {
      if (isOn(el) !== want) clickCenter(el);
    } else {
      clickCenter(el);
    }
    await sleep(170);
    return isOn(findHideToggle());
  }

  // ---------- Itinerary JSON + resolver (Nth remaining logic) ----------
  async function getItineraryJSON() {
    const last = window.__ONTH_NET__?.last;
    if (last?.addresses?.length) return last;

    const u = new URL(location.href);
    const itineraryId = u.searchParams.get("itineraryId");
    const serviceAreaId = u.searchParams.get("serviceAreaId");
    if (!itineraryId || !serviceAreaId) return null;

    const apiUrl =
      `/operations/execution/api/itineraries/${itineraryId}` +
      `?documentType=Itinerary&historicalDay=false&itineraryId=${encodeURIComponent(itineraryId)}` +
      `&serviceAreaId=${encodeURIComponent(serviceAreaId)}`;

    return fetch(apiUrl, { credentials: "include" }).then(r => r.json()).catch(() => null);
  }

  function buildAddressMaps(data) {
    const addrById = new Map();
    for (const a of (data?.addresses || [])) {
      const id = a?.addressId ?? a?.id;
      if (id != null) addrById.set(String(id), a);
    }

    const stops =
      data?.itineraryDetails?.stops ||
      data?.itineraryDetails?.itineraryStops ||
      data?.itineraryDetails?.stopDetails ||
      data?.itineraryDetails?.routeStops ||
      data?.itineraryDetails?.tasks ||
      data?.stops ||
      [];

    const addrIdBySeq = new Map();
    if (Array.isArray(stops)) {
      for (const s of stops) {
        const seq = s?.sequenceNumber ?? s?.stopNum ?? s?.stopNumber ?? s?.stopSequence;
        const addrId = s?.addressId ?? s?.location?.addressId ?? s?.stopAddressId ?? s?.address?.addressId;
        if (seq != null && addrId != null) addrIdBySeq.set(Number(seq), String(addrId));
      }
    }

    return { addrById, addrIdBySeq };
  }

  function getStopHeaders() {
    return [...document.querySelectorAll(
      'div[role="button"][aria-controls^="expandable"], button[aria-controls^="expandable"]'
    )].filter(el => el.offsetWidth && el.offsetHeight);
  }

  function parseStopHeader(el) {
    const box = el.closest("div") || el;
    const lines = (box.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
    const textAll = lines.join(" ");

    const stopNum = (() => {
      for (const l of lines) if (/^\d{1,4}$/.test(l)) return Number(l);
      const m = textAll.match(/\b(\d{1,4})\b/);
      return m ? Number(m[1]) : null;
    })();

    const street = (() => {
      for (const l of lines) {
        if (/^tx\d+/i.test(l)) continue;
        if (/delivery|deliveries|expected|multi-location|stop|pickup/i.test(l)) continue;
        if (/^\d{1,4}$/.test(l)) continue;
        if (/[a-z]/i.test(l) && /\d/.test(l)) return l;
      }
      return "";
    })();

    const done = /\bat\s*\d{1,2}:\d{2}\s*(am|pm)\b/i.test(textAll);
    return { stopNum, street, done };
  }

  async function collectRemainingStopsNth(nthRemaining = 5) {
    const panel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    const want = Math.max(1, Number(nthRemaining) || 5);

    const seen = new Map();
    let stagnant = 0;
    let lastSeen = 0;

    for (let loops = 0; loops < 140; loops++) {
      const headers = getStopHeaders();
      for (const h of headers) {
        const p = parseStopHeader(h);
        if (p.stopNum != null) seen.set(p.stopNum, p);
      }

      const remaining = [...seen.values()].filter(x => !x.done).sort((a, b) => a.stopNum - b.stopNum);
      if (remaining.length >= want) return { remaining, target: remaining[want - 1] };

      const nowSeen = seen.size;
      if (nowSeen === lastSeen) stagnant++;
      else stagnant = 0;
      lastSeen = nowSeen;

      const atBottom = panel
        ? (panel.scrollTop + panel.clientHeight) >= (panel.scrollHeight - 6)
        : (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 6);

      if (atBottom && stagnant >= 6) break;

      try {
        if (panel) panel.scrollTop += Math.max(420, panel.clientHeight * 0.9);
        else window.scrollBy(0, Math.max(420, window.innerHeight * 0.8));
      } catch (_) {}
      await sleep(220);
    }

    const remaining = [...seen.values()].filter(x => !x.done).sort((a, b) => a.stopNum - b.stopNum);
    return { remaining, target: remaining[Math.max(0, want - 1)] || null };
  }

  function buildFullAddress(a, fallbackStreet) {
    if (!a) return cleanAddress(String(fallbackStreet || "").trim());
    const full = [
      a.address1 || a.addressLine1 || a.line1 || a.street1 || a.street,
      a.address2 || a.addressLine2 || a.line2 || a.street2,
      a.address3,
      a.city,
      a.state || a.region,
      a.postalCode || a.zip
    ].filter(Boolean).join(", ").replace(/\s+/g, " ").trim();
    return cleanAddress(full || fallbackStreet);
  }

  function findAddressInPanel(panel) {
    if (!panel) return null;

    const quick = panel.querySelector('[data-testid*="address" i], [data-attr*="address" i], [aria-label*="address" i]');
    if (quick?.innerText?.trim()) return quick;

    const nodes = [...panel.querySelectorAll("div,span,p,li,td")].filter((n) => n?.innerText?.trim());

    const label = nodes.find((n) => /^address$/i.test(n.innerText.trim()));
    if (label) {
      const idx = nodes.indexOf(label);
      for (let k = idx + 1; k < Math.min(idx + 12, nodes.length); k++) {
        const t = nodes[k].innerText.trim();
        if (t && (/,/.test(t) || RX.zip.test(t))) return nodes[k];
      }
    }

    return nodes.find((x) => {
      const t = x.innerText || "";
      return /,/.test(t) && (RX.zip.test(t) || /\b[A-Z]{2}\b/.test(t));
    }) || null;
  }

  async function locateHeaderByStopNum(stopNum) {
    const panel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    if (!panel) return null;

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

    for (let i = 0; i < 90; i++) {
      try { panel.scrollTop += Math.max(520, panel.clientHeight * 0.9); } catch (_) {}
      await sleep(160);
      h = tryFind();
      if (h) return h;
    }
    return null;
  }

  async function domExpandAndGetAddressForStop(stopNum) {
    const header = await locateHeaderByStopNum(stopNum);
    if (!header) return null;

    header.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(120);

    if (header.getAttribute("aria-expanded") !== "true") {
      clickCenter(header);
      await sleep(260);
    }

    const ctrlId = header.getAttribute("aria-controls");
    const panel = (ctrlId && document.getElementById(ctrlId)) || header.nextElementSibling;
    if (!panel) return null;

    const node = findAddressInPanel(panel);
    if (!node?.innerText) return null;

    const cleaned = cleanAddress(node.innerText);
    return cleaned || null;
  }
/* =========================
   JSON-FIRST stop helpers
========================= */

function getStopsFromJSON(j) {
  return (
    j?.itineraryDetails?.stops ||
    j?.itineraryDetails?.itineraryStops ||
    j?.itineraryDetails?.stopDetails ||
    j?.itineraryDetails?.routeStops ||
    j?.itineraryDetails?.tasks ||
    j?.stops ||
    []
  );
}

function getStopSeq(stop) {
  return stop?.sequenceNumber ??
         stop?.stopNum ??
         stop?.stopNumber ??
         stop?.stopSequence ??
         stop?.sequence ??
         null;
}

function isPickupOrReturn(stop) {
  const t = String(stop?.itineraryStopType || stop?.stopType || "").toUpperCase();
  if (t.includes("PICK") || t.includes("RETURN")) return true;

  const tasks = Array.isArray(stop?.tasks) ? stop.tasks : [];
  return tasks.some(x =>
    String(x?.taskType || "").toUpperCase().includes("PICK") ||
    String(x?.taskType || "").toUpperCase().includes("RETURN")
  );
}

function isStopCompleted(stop) {
  const tasks = Array.isArray(stop?.tasks) ? stop.tasks : [];
  return tasks.some(t =>
    String(t?.executionStatus || "").toUpperCase().includes("COMPLETE")
  );
}

function getNthRemainingStopFromJSON(itin, nth = 5) {
  const stops = getStopsFromJSON(itin);
  if (!Array.isArray(stops)) return null;

  const remaining = stops
    .filter(s => {
      const seq = getStopSeq(s);
      if (seq == null) return false;
      if (isPickupOrReturn(s)) return false;
      return !isStopCompleted(s);
    })
    .map(s => ({ seq: getStopSeq(s), stop: s }))
    .sort((a, b) => a.seq - b.seq);

  return remaining[nth - 1] || null;
}

function resolveAddressFromJSON(itin, stop) {
  const addrId =
    stop?.addressId ??
    stop?.location?.addressId ??
    stop?.stopAddressId ??
    stop?.address?.addressId;

  if (!addrId) return "";

  const addr = itin.addresses?.find(
    a => String(a.addressId ?? a.id) === String(addrId)
  );

  if (!addr) return "";

  return cleanAddress([
    addr.address1 || addr.addressLine1 || addr.street,
    addr.address2 || addr.addressLine2,
    addr.city,
    addr.state || addr.region,
    addr.postalCode || addr.zip
  ].filter(Boolean).join(", "));
}


  async function copyNthRemainingStopAddress(nthRemaining = 5) {

  const itin = await getItineraryJSON();

  /* ===== JSON FIRST ===== */
  if (itin?.addresses?.length) {
    const hit = getNthRemainingStopFromJSON(itin, nthRemaining);
    if (hit?.stop) {
      const full = resolveAddressFromJSON(itin, hit.stop);
      if (full) {
        await window.ONTH_copyText(full);
        console.log("📍 JSON Nth remaining stop:", {
          nthRemaining,
          stopNum: hit.seq,
          full
        });
        return { stopNum: hit.seq, full, raw: hit.stop };
      }
    }
  }

  /* ===== ORIGINAL DOM FALLBACK (UNCHANGED) ===== */
  const { target } = await collectRemainingStopsNth(nthRemaining);
  if (!target?.stopNum) return null;

  let full = "";
  let addrId = null;

  const data = await getItineraryJSON();
  if (data?.addresses?.length) {
    const { addrById, addrIdBySeq } = buildAddressMaps(data);
    addrId = addrIdBySeq.get(Number(target.stopNum)) || null;
    const a = addrId ? addrById.get(String(addrId)) : null;
    full = buildFullAddress(a, target.street) || "";
  }

  if (!full) {
    const domAddr = await domExpandAndGetAddressForStop(target.stopNum);
    if (domAddr) full = domAddr;
  }

  if (!full) full = String(target.street || "").trim();
  full = cleanAddress(full);

  if (full) await window.ONTH_copyText(full);

  return { stopNum: target.stopNum, addressId: addrId, full, raw: target };
}

  async function goBackToList() {
    if (document.querySelector(ROW_SEL)) return true;

    const findBackBtn = () => {
      const cands = [...document.querySelectorAll("button,a,[role='button']")];
      return cands.find((el) => {
        const t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
        return /^(back|return|go back|back to list)$/i.test(t) || /\bback\b/i.test(t);
      }) || null;
    };

    for (let i = 0; i < 3; i++) {
      const b = findBackBtn();
      if (b) { try { b.click(); } catch (_) {} }
      await sleep(380);
      if (document.querySelector(ROW_SEL)) return true;
    }

    try { history.back(); } catch (_) {}
    const ok = await waitFor(() => document.querySelector(ROW_SEL), { timeout: 11000, interval: 200 });
    return !!ok;
  }

  async function openToggleCopyStop(name, stopN = 5, phone = "") {
    if (!document.querySelector(ROW_SEL)) {
      await goBackToList();
      await sleep(450);
    }

    const listPanel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
    const savedScroll = listPanel ? listPanel.scrollTop : null;

    const ok = await clickDriver(name, phone);
    if (!ok) return { ok: false, address: "" };

    await waitFor(() => getStopHeaders().length ? true : null, { timeout: 16000, interval: 180 });

    await sleep(250);
    await scrollToHideArea();
    await setHideCompleted(true);
    await sleep(350);

    const res = await copyNthRemainingStopAddress(Number(stopN) || 5);

    await goBackToList();
    await sleep(300);

    try { if (listPanel && typeof savedScroll === "number") listPanel.scrollTop = savedScroll; } catch (_) {}

    const address = res?.full || "";
    return { ok: !!address, address };
  }

  /* =========================
     3) In-page UI (drawer)
  ========================= */
  const UI = {
    open: false,
    data: [],
    view: [],
    sortKey: "name",
    sortDir: "asc",
    filter: "",
    busy: false,
    addrByKey: new Map(),
    pendingKey: null,
    openKey: null,
  };

  // Renamed from CSS -> STYLES to avoid collision with window.CSS
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
  .__onth_detailBox{
    padding:10px 10px 12px;
    display:grid; gap:8px;
  }
  .__onth_kv{ display:grid; grid-template-columns:86px 1fr; gap:6px 10px; }
  .__onth_k{ color:rgba(148,163,184,.95); font-size:12px; }
  .__onth_v{ color:#e5e7eb; font-size:13px; word-break:break-word; }
  .__onth_pills{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }

  .__onth_pillNoBg{
    border:0 !important;
    background: transparent !important;
    padding:0 !important;
    box-shadow:none !important;
  }

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

  .__onth_btnPrimary{
    border-color: rgba(59,130,246,.45);
  }
  .__onth_btnPrimary:hover{ background: rgba(37,99,235,.16); }

  .__onth_btnSmall{
    padding:6px 8px;
    border-radius:9px;
    font-size:12px;
    font-weight:900;
  }
  `;

  function injectUI() {
    if (document.getElementById("__onth_snap_drawer__")) return;

    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "__onth_snap_btn__";
    btn.textContent = "Driver Snapshot";
    btn.addEventListener("click", async () => {
      if (!UI.open) {
        openDrawer();
        if (!UI.data.length) await refreshSnapshot();
      } else {
        closeDrawer();
      }
    });
    document.body.appendChild(btn);

    const drawer = document.createElement("div");
    drawer.id = "__onth_snap_drawer__";
    drawer.innerHTML = `
      <div id="__onth_snap_head__">
        <div id="__onth_snap_title__">Driver Snapshot</div>
        <div id="__onth_snap_count__">0 drivers</div>
      </div>
      <div id="__onth_snap_controls__">
        <input id="__onth_snap_stop__" type="number" min="1" value="5" title="Nth remaining stop (5 = 5th remaining)"/>
        <input id="__onth_snap_filter__" type="search" placeholder="Filter…"/>
        <button id="__onth_snap_refresh__">Refresh</button>
        <button id="__onth_snap_close__">✕</button>
      </div>
      <div id="__onth_snap_tablewrap__">
        <table id="__onth_snap_table__">
          <thead>
            <tr>
              <th data-k="name">Name</th>
              <th data-k="projectedRTS">Projected RTS</th>
              <th data-k="stopsLeft">Stops Left</th>
              <th data-k="avgPerHour">Stops/hr</th>
              <th data-k="lastHourPace">Pace</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    document.body.appendChild(drawer);

    drawer.querySelector("#__onth_snap_close__").addEventListener("click", closeDrawer);
    drawer.querySelector("#__onth_snap_refresh__").addEventListener("click", refreshSnapshot);
    drawer.querySelector("#__onth_snap_filter__").addEventListener("input", (e) => {
      UI.filter = String(e.target.value || "");
      rebuildView();
      renderTable();
    });

    drawer.querySelectorAll("thead th").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.dataset.k;
        if (UI.sortKey === k) UI.sortDir = UI.sortDir === "asc" ? "desc" : "asc";
        else { UI.sortKey = k; UI.sortDir = "asc"; }
        rebuildView();
        renderTable();
      });
    });

    drawer.addEventListener("click", async (e) => {
      const copyBtn = e.target.closest("button[data-copykey]");
      if (copyBtn) {
        e.preventDefault();
        const key = copyBtn.getAttribute("data-copykey");
        const row = UI.data.find(r => r.key === key);
        if (!row) return;

        const addr =
          (UI.addrByKey.get(key) || "").trim() ||
          (document.querySelector(`[data-addrkey="${cssEscape(key)}"]`)?.textContent || "").trim();

        const safeAddr = (addr && addr !== "—" && addr !== "Working…") ? addr : "";
        if (!safeAddr) { toast("No address yet", false); return; }

        const blob = `${row.name}\n${row.number || ""}\n${safeAddr}`.trim();
        const ok = await window.ONTH_copyText(blob);
        toast(ok ? "Copied info" : "Copy failed", ok);
        return;
      }

      const refreshBtn = e.target.closest("button[data-refreshkey]");
      if (refreshBtn) {
        e.preventDefault();
        const key = refreshBtn.getAttribute("data-refreshkey");
        const row = UI.data.find(r => r.key === key);
        if (row) await requestAddress(row);
        return;
      }

      const rowEl = e.target.closest("tr[data-key]");
      if (!rowEl) return;
      if (e.target.closest("button")) return;

      e.preventDefault();
      const key = rowEl.getAttribute("data-key");
      UI.openKey = (UI.openKey === key) ? null : key;
      renderTable();

      const row = UI.data.find(r => r.key === key);
      if (row) await requestAddress(row);
    });
  }

  function openDrawer() {
    UI.open = true;
    document.getElementById("__onth_snap_drawer__")?.classList.add("open");
  }
  function closeDrawer() {
    UI.open = false;
    document.getElementById("__onth_snap_drawer__")?.classList.remove("open");
  }

  function fmt(v) {
    return (typeof v === "number" && !Number.isNaN(v))
      ? (Number.isInteger(v) ? String(v) : v.toFixed(1))
      : "";
  }

  function rebuildView() {
    const f = norm(UI.filter);
    let v = UI.data.slice();
    if (f) v = v.filter(r => norm(r.name).includes(f) || norm(r.number).includes(f));

    const k = UI.sortKey;
    const dir = UI.sortDir;

    v.sort((a, b) => {
      const va = a[k], vb = b[k];
      const na = typeof va === "number", nb = typeof vb === "number";
      let c = 0;
      if (na && nb) c = va - vb;
      else c = String(va || "").localeCompare(String(vb || ""), undefined, { numeric: true, sensitivity: "base" });
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
      tr.innerHTML = `
        <td class="__onth_name">${r.name}</td>
        <td class="__onth_mono">${r.projectedRTS || ""}</td>
        <td class="__onth_mono">${typeof r.stopsLeft === "number" ? r.stopsLeft : ""}</td>
        <td class="__onth_mono">${fmt(r.avgPerHour)}</td>
        <td class="__onth_mono">${fmt(r.lastHourPace)}</td>
      `;
      tbody.appendChild(tr);

      if (UI.openKey === r.key) {
        const addr = UI.addrByKey.get(r.key) || (UI.pendingKey === r.key ? "Working…" : "—");

        const dtr = document.createElement("tr");
        dtr.className = "__onth_detail";
        dtr.innerHTML = `
          <td colspan="5">
            <div class="__onth_detailBox">
              <div class="__onth_kv">
                <div class="__onth_k">Name</div><div class="__onth_v">${r.name}</div>
                <div class="__onth_k">Phone</div><div class="__onth_v">${r.number || ""}</div>
                <div class="__onth_k">Address</div><div class="__onth_v" data-addrkey="${r.key}">${addr}</div>
              </div>
              <div class="__onth_pills">
                <span class="__onth_pillNoBg">
                  <button class="__onth_btn __nth__onth_btn __onth_btnPrimary" data-refreshkey="${r.key}">Refresh address</button>
                </span>
                <span class="__onth_pillNoBg">
                  <button class="__onth_btn __onth_btnSmall" data-copykey="${r.key}">Copy Info</button>
                </span>
              </div>
            </div>
          </td>
        `;
        tbody.appendChild(dtr);
      }
    }
  }

  async function refreshSnapshot() {
    if (UI.busy) return toast("Busy…", null);
    UI.busy = true;
    toast("Loading drivers…");
    try {
      const data = await collectAllDrivers();
      UI.data = data;

      if (UI.openKey && !UI.data.some(r => r.key === UI.openKey)) UI.openKey = null;

      rebuildView();
      renderTable();

      toast(`Loaded ${data.length} drivers`, true);
    } catch (e) {
      console.error(e);
      toast("Failed to load drivers", false);
    } finally {
      UI.busy = false;
    }
  }

  async function requestAddress(row) {
    if (!row?.name) return;
    if (UI.busy) return toast("Busy…", null);

    UI.busy = true;
    UI.pendingKey = row.key;

    if (UI.openKey !== row.key) UI.openKey = row.key;
    renderTable();

    try {
      const stopN = Number(document.getElementById("__onth_snap_stop__")?.value) || 5;
      toast("Copying address…");

      const { ok, address } = await openToggleCopyStop(row.name, stopN, row.number);
      if (ok && address) {
        UI.addrByKey.set(row.key, String(address).trim());
        toast("Copied ✔", true);
      } else {
        toast("Failed ✖", false);
      }

      UI.pendingKey = null;
      renderTable();
    } catch (e) {
      console.error(e);
      toast("Failed ✖", false);
      UI.pendingKey = null;
      renderTable();
    } finally {
      UI.busy = false;
    }
  }

  /* =========================
     4) Inject (stable)
  ========================= */
  function ensure() {
    if (!document.body) return;
    injectUI();
  }
  const t = setInterval(() => { ensure(); if (document.getElementById("__onth_snap_btn__")) clearInterval(t); }, 250);
  new MutationObserver(() => ensure()).observe(document.documentElement, { childList: true, subtree: true });
})();
