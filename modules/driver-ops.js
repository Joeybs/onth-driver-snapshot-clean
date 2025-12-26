// modules/driver-ops.js
// Driver collection, parsing, clicking, and navigation

import {
  SELECTORS,
  RX,
  CONFIG,
  log,
  sleep,
  norm,
  firstLine,
  digits,
  readViaSel,
  tidyPhone,
  waitFor,
  toast,
} from './core.js';

const ROW_SEL = SELECTORS.rows;
const trackedElements = new WeakMap();

// ============================================
// DRIVER ROW PARSING
// ============================================
export function extractPhone(row, lines) {
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

export function parseRow(row) {
  const text = row?. innerText || "";
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const name = firstLine(text) || "[unknown]";
  const phone = extractPhone(row, lines);

  let projectedRTS = readViaSel(row, SELECTORS.projectedRTS) || one(text, RX.rts, RX.rtsAlt) || "";
  let avgPerHour = readViaSel(row, SELECTORS. avgPerHour) || one(text, RX.avg);
  avgPerHour = typeof avgPerHour === "string" ? parseFloat(avgPerHour) : avgPerHour;

  let lastHourPace = readViaSel(row, SELECTORS.lastHourPace) || one(text, RX.pace);
  lastHourPace = typeof lastHourPace === "string" ?  parseFloat(lastHourPace) : lastHourPace;

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

// Helper for parseRow
function one(t, ...rxs) {
  t = String(t || "");
  for (const rx of rxs) {
    const m = t.match(rx);
    if (m) return m[1].trim();
  }
  return null;
}

// ============================================
// DRIVER COLLECTION
// ============================================
export async function collectAllDrivers() {
  const panel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
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

  for (let loops = 0; loops < CONFIG.MAX_SCROLL_LOOPS; loops++) {
    const rows = [... document.querySelectorAll(SELECTORS.rows)];
    for (const row of rows) {
      if (trackedElements.has(row)) continue;
      trackedElements.set(row, true);
      out.push(parseRow(row));
      await sleep(18);
    }

    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 6;
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

// ============================================
// CLICK SIMULATION HELPERS
// ============================================
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
  const x = r.left + r. width / 2,
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
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2;
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

// ============================================
// DRIVER NAVIGATION
// ============================================
export function inDriverView() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get("itineraryId")) return true;
  } catch (err) {
    log.warn("URL parsing failed:", err);
  }
  return getStopHeaders().length > 0;
}

export function getStopHeaders() {
  return [
    ... document.querySelectorAll(
      'div[role="button"][aria-controls^="expandable"], button[aria-controls^="expandable"]'
    ),
  ].filter((el) => el.offsetWidth && el.offsetHeight);
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
  const panel = document.querySelector(SELECTORS.scrollPanel) || document.scrollingElement;
  if (!panel) return null;

  let row = [... document.querySelectorAll(ROW_SEL)].find((r) => rowMatches(r, name, phone));
  if (row) return row;

  const saved = panel.scrollTop;
  try {
    panel.scrollTop = 0;
  } catch (err) {
    log.warn("Scroll to top failed:", err);
  }
  await sleep(CONFIG.BASE_SLEEP);

  for (let loops = 0; loops < maxLoops; loops++) {
    row = [...document.querySelectorAll(ROW_SEL)].find((r) => rowMatches(r, name, phone));
    if (row) return row;

    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 6;
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

export async function clickDriver(name, phone) {
  const rowNow = [... document.querySelectorAll(ROW_SEL)].find((r) => rowMatches(r, name, phone));
  if (rowNow) return clickDriverExact(rowNow);
  const row = await findRowByNameScrolling(name, phone);
  if (row) return clickDriverExact(row);
  log.error("Could not find driver row:", name);
  return null;
}

// ============================================
// HIDE TOGGLE MANAGEMENT
// ============================================
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
    /hide completed stops/i.test(e.closest("label,div,span,section,form")?.textContent || "")
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
      /hide completed stops/i.test(n.closest("label,div,span,section,form")?.textContent || "")
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

export async function setHideCompleted(want) {
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

// ============================================
// BACK BUTTON NAVIGATION
// ============================================
export async function goBackToList() {
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
        return /^(back|return|go back|back to list)$/i.test(t) || /\bback\b/i.test(t);
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
    log.info("Used history. back()");
  } catch (err) {
    log.error("history.back() failed:", err);
  }
  const ok = await waitFor(() => document.querySelector(ROW_SEL), {
    timeout: 11000,
    interval: 200,
  });
  return !!ok;
}

export async function scrollToHideAreaExport() {
  return scrollToHideArea();
}
