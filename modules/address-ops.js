// modules/address-ops.js
// Address extraction, JSON indexing, and stop management

import {
  CONFIG,
  log,
  sleep,
  waitFor,
  cleanAddress,
  RX,
  SELECTORS,
  copyText,
  toast,
} from './core.js';
import {
  getStopHeaders,
  setHideCompleted,
  goBackToList,
  clickDriver,
  inDriverView,
  scrollToHideAreaExport,
} from './driver-ops. js';

// ============================================
// ITINERARY FETCHING
// ============================================
export function getItinParamsFromUrl() {
  try {
    const u = new URL(location.href);
    return {
      itineraryId:  u.searchParams.get("itineraryId"),
      serviceAreaId: u.searchParams.get("serviceAreaId"),
    };
  } catch (err) {
    log.warn("URL params parsing failed:", err);
    return { itineraryId: null, serviceAreaId: null };
  }
}

export async function getItineraryJSON() {
  const { itineraryId, serviceAreaId } = getItinParamsFromUrl();
  if (!itineraryId || !serviceAreaId) {
    log.warn("Missing itinerary params");
    return null;
  }

  const cached = window.__ONTH_NET__?. byId? .[String(itineraryId)];
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

// ============================================
// JSON ADDRESS INDEXING
// ============================================
export function buildStopAddressIndex(itinJson) {
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
      if (addr && ! idx[String(stopNum)]) idx[String(stopNum)] = addr;
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

export function getJsonAddressForStop(stopNum, itinJson) {
  const { itineraryId } = getItinParamsFromUrl();
  const id = itineraryId ?  String(itineraryId) : null;
  if (!id || !itinJson) return null;

  window.__ONTH_ADDRINDEX__ = window.__ONTH_ADDRINDEX__ || Object.create(null);
  let idx = window.__ONTH_ADDRINDEX__[id];
  if (!idx) {
    idx = buildStopAddressIndex(itinJson);
    window.__ONTH_ADDRINDEX__[id] = idx;
  }
  const a = idx[String(stopNum)];
  return a ?  cleanAddress(a) : null;
}

// ============================================
// DOM STOP HELPERS
// ============================================
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
    p = p. parentElement;
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
  if (quick?. innerText?.trim()) return quick;

  const nodes = [... panel.querySelectorAll("div,span,p,li,td")]. filter(
    (n) => n?.innerText?.trim()
  );

  const label = nodes.find((n) => /^address$/i.test(n.innerText. trim()));
  if (label) {
    const idx = nodes.indexOf(label);
    for (let k = idx + 1; k < Math.min(idx + 12, nodes.length); k++) {
      const t = nodes[k].innerText. trim();
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
      if (p. stopNum === Number(stopNum)) return h;
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
    const r = header.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r. width / 2,
      clientY: r.top + r. height / 2,
    };
    header.dispatchEvent(new MouseEvent("mousedown", opts));
    header.dispatchEvent(new MouseEvent("mouseup", opts));
    header.dispatchEvent(new MouseEvent("click", opts));
    await sleep(260);
  }

  const ctrlId = header.getAttribute("aria-controls");
  const panel = (ctrlId && document.getElementById(ctrlId)) || header. nextElementSibling;
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

// ============================================
// REMAINING STOPS COLLECTION
// ============================================
export async function collectRemainingStopsNth(nthRemaining = 5) {
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
      if (p.stopNum != null && ! Number.isNaN(p.stopNum)) seen.set(p.stopNum, p);
    }

    const remaining = [... seen.values()]
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
    if (atBottom && stagnant >= CONFIG. STAGNANT_THRESHOLD) break;

    try {
      scroller.scrollTop += Math. max(520, scroller.clientHeight * 0.9);
    } catch (err) {
      log.warn("Scroll failed:", err);
    }
    await sleep(200);
  }

  const remaining = [...seen.values()]
    .filter((x) => !x.done)
    .sort((a, b) => a.stopNum - b.stopNum);
  log.info(`Final:  ${remaining.length} remaining stops found`);
  return { remaining, target: remaining[want - 1] || null };
}

// ============================================
// COPY NTH REMAINING STOP ADDRESS
// ============================================
export async function copyNthRemainingStopAddress(nthRemaining = 5, itinJson = null) {
  const want = Math.max(1, Number(nthRemaining) || 5);
  const { target } = await collectRemainingStopsNth(want);
  if (!target?. stopNum) {
    log.warn("No target stop found");
    return null;
  }

  log.info("Target stop:", target.stopNum);

  const jsonAddr = getJsonAddressForStop(target. stopNum, itinJson);
  if (jsonAddr) {
    const full = cleanAddress(jsonAddr);
    await copyText(full);
    log.info("Copied from JSON:", full);
    return { stopNum: target.stopNum, full, raw: target, source: "json" };
  }

  const domAddr = await domExpandAndGetAddressForStop(target.stopNum);
  if (!domAddr) {
    log.warn("No DOM address found");
    return null;
  }

  const full = cleanAddress(domAddr);
  if (! full) {
    log.warn("Address cleaning failed");
    return null;
  }

  await copyText(full);
  log.info("Copied from DOM:", full);
  return { stopNum: target. stopNum, full, raw: target, source: "dom" };
}

// ============================================
// ORCHESTRATION
// ============================================
export async function openToggleCopyStop(name, stopN = 5, phone = "") {
  const ROW_SEL = SELECTORS.rows;

  if (! document.querySelector(ROW_SEL)) {
    log.info("Not on list view, going back");
    await goBackToList();
    await sleep(450);
  }

  const listPanel =
    document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
  const savedScroll = listPanel ?  listPanel.scrollTop : null;

  const ok = await clickDriver(name, phone);
  if (!ok) {
    log.error("Failed to click driver");
    return { ok: false, address: "" };
  }

  await waitFor(() => (getStopHeaders().length ?  true : null), {
    timeout: 20000,
    interval: 200,
  });

  await sleep(250);
  await scrollToHideAreaExport();
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
