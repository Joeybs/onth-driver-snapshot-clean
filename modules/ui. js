// modules/ui.js
// UI layer - drawer, table rendering, event handling, and state management

import {
  CONFIG,
  log,
  toast,
  LRUCache,
  globalMutex,
  cssEscape,
  copyText,
  sleep,
  norm,
} from './core. js';
import { collectAllDrivers } from './driver-ops.js';
import { openToggleCopyStop } from './address-ops.js';

// ============================================
// UI STATE
// ============================================
export const UI = {
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

// ============================================
// STYLES
// ============================================
const STYLES = `
  #__onth_snap_btn__{
    position: fixed; top: 12px; right:12px; z-index:2147483647;
    padding: 10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,. 14);
    background:rgba(2,6,23,. 82); color:#e5e7eb; cursor:pointer; font-weight:800;
    box-shadow:0 10px 30px rgba(0,0,0,. 35); backdrop-filter:  blur(10px);
  }
  #__onth_snap_btn__: hover{ transform:  translateY(-1px); }
  #__onth_snap_drawer__{
    position: fixed; top:64px; right:12px; width:440px; max-width:calc(100vw - 24px);
    height:  calc(100vh - 92px); z-index:2147483646;
    background:  rgba(2,6,23,. 86); color:#e5e7eb;
    border: 1px solid rgba(255,255,255,. 12);
    border-radius: 16px; box-shadow:  0 18px 60px rgba(0,0,0,.5);
    overflow: hidden; display:none; backdrop-filter: blur(12px);
  }
  #__onth_snap_drawer__. open{ display:flex; flex-direction:column; }
  #__onth_snap_head__{
    padding:12px 12px 10px; border-bottom:1px solid rgba(255,255,255,.10);
    display:flex; align-items: center; gap:10px;
  }
  #__onth_snap_title__{ font-weight:900; }
  #__onth_snap_count__{ margin-left:auto; font-size:12px; color: rgba(226,232,240,.75); }
  #__onth_snap_controls__{
    padding:10px 12px; display:flex; gap:8px; align-items:center;
    border-bottom:1px solid rgba(255,255,255,.10);
  }
  #__onth_snap_controls__ input{
    background:  rgba(15,23,42,.75); color:#e5e7eb;
    border:1px solid rgba(255,255,255,.12);
    border-radius:10px; padding:8px 10px; font-size:13px; outline:none;
  }
  #__onth_snap_filter__{ flex: 1; }
  #__onth_snap_stop__{ width:86px; text-align:center; }
  #__onth_snap_refresh__{
    background:#2563eb; border:0; color:#fff; border-radius:10px;
    padding:8px 10px; font-weight:900; cursor:pointer;
  }
  #__onth_snap_close__{
    margin-left:6px; background:  rgba(15,23,42,.75);
    border:1px solid rgba(255,255,255,.12); color:#e5e7eb;
    border-radius:10px; padding:8px 10px; font-weight:900; cursor:pointer;
  }
  #__onth_snap_tablewrap__{ flex: 1; overflow:auto; }
  #__onth_snap_table__{ width:100%; border-collapse:collapse; }
  #__onth_snap_table__ thead th{
    position:sticky; top:0; background:  rgba(2,6,23,.95);
    padding:10px 10px; font-size:12px; color:rgba(148,163,184,.95);
    text-align:left; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.10);
    user-select:none;
  }
  #__onth_snap_table__ tbody td{
    padding:10px 10px; border-bottom:1px solid rgba(255,255,255,.06);
    font-size:13px; vertical-align:top;
  }
  #__onth_snap_table__ tbody tr:hover{ background: rgba(255,255,255,.04); }
  .__onth_mono{ font-variant-numeric:  tabular-nums; }
  .__onth_row{ cursor:pointer; }
  .__onth_name{ font-weight:900; }
  .__onth_detail{
    background: rgba(15,23,42,.35);
    border-bottom:1px solid rgba(255,255,255,.06);
  }
  .__onth_detailBox{ padding:10px 10px 12px; display:grid; gap:8px; }
  .__onth_kv{ display:grid; grid-template-columns:86px 1fr; gap:6px 10px; }
  .__onth_k{ color: rgba(148,163,184,. 95); font-size:12px; }
  .__onth_v{ color:#e5e7eb; font-size:13px; word-break:break-word; }
  .__onth_pills{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .__onth_pillNoBg{ border: 0 ! important; background:  transparent ! important; padding:0 !important; box-shadow:none !important; }
  .__onth_btn{
    border:1px solid rgba(255,255,255,.16);
    background:  transparent;
    color:#e5e7eb;
    padding:8px 10px;
    border-radius:10px;
    font-weight:900;
    cursor:pointer;
  }
  .__onth_btn:hover{ background: rgba(255,255,255,.06); }
  .__onth_btn: active{ transform:  translateY(1px); }
  .__onth_btnPrimary{ border-color:  rgba(59,130,246,.45); }
  .__onth_btnPrimary:hover{ background: rgba(37,99,235,.16); }
  .__onth_btnSmall{ padding:6px 8px; border-radius:9px; font-size:12px; font-weight:900; }
`;

// ============================================
// DRAWER CONTROL
// ============================================
export function openDrawer() {
  UI.open = true;
  document.getElementById("__onth_snap_drawer__")?.classList.add("open");
}

export function closeDrawer() {
  UI.open = false;
  document.getElementById("__onth_snap_drawer__")?.classList.remove("open");
}

// ============================================
// FORMATTING
// ============================================
function fmt(v) {
  return typeof v === "number" && ! Number.isNaN(v)
    ? Number. isInteger(v)
      ? String(v)
      : v.toFixed(1)
    : "";
}

// ============================================
// VIEW MANAGEMENT
// ============================================
export function rebuildView() {
  const f = String(UI.filter || "").toLowerCase().trim();
  let v = UI.data.slice();
  if (f) {
    v = v.filter(
      (r) =>
        String(r.name || "").toLowerCase().includes(f) ||
        String(r.number || "").toLowerCase().includes(f)
    );
  }

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

// ============================================
// TABLE RENDERING
// ============================================
export function renderTable() {
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

    // Render detail row if open
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
      refreshBtn. setAttribute("data-refreshkey", r.key);
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

// ============================================
// REFRESH SNAPSHOT
// ============================================
export async function refreshSnapshot() {
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
    if (UI.openKey && ! UI.data.some((r) => r.key === UI.openKey)) UI.openKey = null;
    rebuildView();
    renderTable();
    toast(`Loaded ${data.length} drivers`, true);
  } catch (e) {
    log.error("Refresh snapshot failed:", e);
    toast("Failed to load drivers", false);
  } finally {
    UI. busy = false;
    globalMutex.unlock();
  }
}

// ============================================
// REQUEST ADDRESS
// ============================================
export async function requestAddress(row) {
  if (!row?. name) return;
  if (globalMutex.isLocked) {
    toast("Busy…", null);
    return;
  }

  const stopN = Math.max(1, Number(UI.stopN) || CONFIG.DEFAULT_STOP_N);
  const cacheKey = `${row.key}|${stopN}`;

  if (UI.addrByKey. has(cacheKey)) {
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

// ============================================
// UI INJECTION
// ============================================
export function injectUI() {
  if (document.getElementById("__onth_snap_drawer__")) return;

  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head. appendChild(style);

  // Main button
  const btn = document.createElement("button");
  btn.id = "__onth_snap_btn__";
  btn.textContent = "Driver Snapshot";
  btn.setAttribute("aria-label", "Open Driver Snapshot");
  btn.addEventListener("click", async () => {
    if (! UI.open) {
      openDrawer();
      if (! UI.data.length) await refreshSnapshot();
    } else closeDrawer();
  });
  document.body.appendChild(btn);

  // Drawer container
  const drawer = document.createElement("div");
  drawer.id = "__onth_snap_drawer__";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Driver Snapshot Panel");

  // Header
  const head = document.createElement("div");
  head.id = "__onth_snap_head__";

  const title = document.createElement("div");
  title.id = "__onth_snap_title__";
  title.textContent = "Driver Snapshot";

  const count = document.createElement("div");
  count.id = "__onth_snap_count__";
  count. textContent = "0 drivers";

  head.appendChild(title);
  head.appendChild(count);

  // Controls
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

  // Table wrapper
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
    { key:  "avgPerHour", label:  "Stops/hr" },
    { key: "lastHourPace", label:  "Pace" },
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

  // Event listeners
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

  // Sort column headers
  thead.querySelectorAll("th").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (UI.sortKey === k) UI.sortDir = UI.sortDir === "asc" ? "desc" : "asc";
      else {
        UI.sortKey = k;
        UI.sortDir = "asc";
      }

      thead.querySelectorAll("th").forEach((t) => t.setAttribute("aria-sort", "none"));
      th.setAttribute("aria-sort", UI.sortDir === "asc" ? "ascending" : "descending");

      rebuildView();
      renderTable();
    });
  });

  // Drawer event delegation
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
      if (! safeAddr) return toast("No address yet", false);

      const blob = `${row.name}\n${row.number || ""}\n${safeAddr}`.trim();
      const ok = await copyText(blob);
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
    if (! rowEl || e.target. closest("button")) return;

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

// ============================================
// INITIALIZATION
// ============================================
export function ensure() {
  if (!document.body) return;
  injectUI();
}

export function initializeUI() {
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

  if (document. documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}
