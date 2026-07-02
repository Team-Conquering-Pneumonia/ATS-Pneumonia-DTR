/*
 * results_by_node.js
 *
 * Browsable per-node results table (Track C). Consumes results_by_node.json
 * (produced by build_results_by_node_data.py, which mirrors the T3.5 static
 * workbook builder code/R/build_static_results_workbook.R). One row per node
 * across 16 export-native tree families; sort any column; filter by tree family and by
 * Signal (Benefit/Harm/Inconclusive). VA <20 small-cell suppression is mirrored
 * exactly from the data file: fully suppressed nodes show N = "<20" with blank
 * estimates; suppressed observed mortality is blank and suppressed observed
 * antibiotic use shows "<20". Benefit/harm
 * shading on the ATE cell matches the workbook palette (#d6efdc / #fadbd8),
 * driven by the Signal column.
 *
 * Plain script (no module syntax) so it loads via file:// or a static server,
 * matching app.js's convention.
 */

const SUPP = "<20";

// Fixed (always-present) columns, in display order. `key` indexes the row
// object; `type` controls sort comparison; `label` is the header text.
const FIXED_COLS = [
  { key: "node_id",      label: "Node ID",                   type: "num" },
  { key: "label",        label: "Label",                     type: "str" },
  { key: "depth",        label: "Depth",                     type: "num" },
];
// Tail columns (after the per-family split columns).
const TAIL_COLS = [
  { key: "n",            label: "N",                         type: "supp" },
  { key: "pct_obs_abx",  label: "% obs. abx",                type: "supp" },
  { key: "pct_obs_mort", label: "% obs. mortality",          type: "supp" },
  { key: "p_abx",        label: "p(mort) WITH abx",          type: "num" },
  { key: "p_noabx",      label: "p(mort) WITHOUT abx",       type: "num" },
  { key: "ate",          label: "ATE",                       type: "num" },
  { key: "ci",           label: "95% CI",                    type: "str" },
  { key: "signal",       label: "Signal",                    type: "str" },
];

let DATA = null;            // parsed results_by_node.json
let currentFamily = null;   // family object
let signalFilter = "all";
let sortKey = "node_id";
let sortDir = 1;            // 1 = asc, -1 = desc

// --- value formatting ------------------------------------------------------
function fmtCell(row, col) {
  const v = row[col.key];
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "supp") {
    // Either the suppression flag "<20" (string) or a numeric value.
    return v === SUPP ? SUPP : String(v);
  }
  return String(v);
}

// Build the active column list for the current family (fixed + split + tail).
function activeColumns() {
  const splitCols = (currentFamily.split_columns || []).map((name) => ({
    key: "split:" + name, label: name, type: "str",
  }));
  return FIXED_COLS.concat(splitCols, TAIL_COLS);
}

// Read a sort value for a row + column key. Split columns live in row.splits.
function cellValue(row, col) {
  if (col.key.startsWith("split:")) {
    const name = col.key.slice("split:".length);
    return (row.splits && row.splits[name] != null) ? row.splits[name] : null;
  }
  return row[col.key];
}

// Comparator: suppressed / blank cells sort to the end (stable within group).
function compareRows(a, b, col) {
  const va = cellValue(a, col);
  const vb = cellValue(b, col);
  const aBlank = va === null || va === undefined || va === "" || va === SUPP;
  const bBlank = vb === null || vb === undefined || vb === "" || vb === SUPP;
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;   // blanks always last, regardless of direction
  if (bBlank) return -1;
  if (col.type === "num") {
    return (Number(va) - Number(vb)) * sortDir;
  }
  return String(va).localeCompare(String(vb)) * sortDir;
}

// --- rendering -------------------------------------------------------------
function renderHead(cols) {
  const thead = document.getElementById("results-thead");
  const tr = document.createElement("tr");
  cols.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col.label;
    th.tabIndex = 0;
    th.dataset.key = col.key;
    th.classList.add("sortable");
    if (col.key === sortKey) {
      th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
      th.setAttribute("aria-sort", sortDir === 1 ? "ascending" : "descending");
    }
    const sortHandler = () => setSort(col.key);
    th.addEventListener("click", sortHandler);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortHandler(); }
    });
    tr.appendChild(th);
  });
  thead.innerHTML = "";
  thead.appendChild(tr);
}

function renderBody(cols, rows) {
  const tbody = document.getElementById("results-tbody");
  tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    if (row.suppressed) tr.classList.add("row-suppressed");
    cols.forEach((col) => {
      const td = document.createElement("td");
      if (col.key.startsWith("split:")) {
        const name = col.key.slice("split:".length);
        const val = (row.splits && row.splits[name] != null) ? row.splits[name] : "";
        td.textContent = val;
        td.classList.add("split-col");
      } else if (col.key === "label") {
        td.textContent = row.label || "";
        td.classList.add("varname");
      } else if (col.key === "ci") {
        td.textContent = row.ci || "";
        td.classList.add("ci");
      } else if (col.key === "ate") {
        td.textContent = fmtCell(row, col);
        // Benefit/harm shading driven by the Signal column (workbook palette).
        if (row.signal === "Benefit") td.classList.add("ate-benefit");
        else if (row.signal === "Harm") td.classList.add("ate-harm");
      } else if (col.key === "signal") {
        td.textContent = row.signal || "";
        if (row.signal) td.classList.add("signal-" + row.signal.toLowerCase());
      } else {
        const txt = fmtCell(row, col);
        td.textContent = txt;
        if (txt === SUPP) td.classList.add("cell-suppressed");
      }
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

function visibleRows() {
  let rows = currentFamily.rows.slice();
  if (signalFilter !== "all") {
    rows = rows.filter((r) => r.signal === signalFilter);
  }
  const cols = activeColumns();
  const sortCol = cols.find((c) => c.key === sortKey) || cols[0];
  rows.sort((a, b) => compareRows(a, b, sortCol));
  return rows;
}

function render() {
  const cols = activeColumns();
  const rows = visibleRows();
  renderHead(cols);
  renderBody(cols, rows);
  document.getElementById("row-count").textContent =
    rows.length + " / " + currentFamily.rows.length + " nodes";
  document.getElementById("table-foot").textContent =
    "Showing tree family “" + currentFamily.label + "”. " +
    "Cells showing “<20” are VA small-cell suppressed. ATE shaded green = " +
    "credible benefit (95% CI below 0), red = credible harm (CI above 0).";
}

// --- interaction -----------------------------------------------------------
function setSort(key) {
  if (sortKey === key) {
    sortDir = -sortDir;
  } else {
    sortKey = key;
    sortDir = 1;
  }
  render();
}

function setFamily(key) {
  const fam = DATA.families.find((f) => f.key === key);
  if (!fam) return;
  currentFamily = fam;
  // Reset sort if the previous sort column doesn't exist in this family.
  const cols = activeColumns();
  if (!cols.some((c) => c.key === sortKey)) {
    sortKey = "node_id";
    sortDir = 1;
  }
  render();
}

function wireControls() {
  const sel = document.getElementById("family-select");
  DATA.families.forEach((fam) => {
    const opt = document.createElement("option");
    opt.value = fam.key;
    opt.textContent = fam.label;
    sel.appendChild(opt);
  });
  sel.value = DATA.families[0].key;
  sel.addEventListener("change", (e) => setFamily(e.target.value));

  document.querySelectorAll('input[name="signal"]').forEach((r) => {
    r.addEventListener("change", (e) => {
      signalFilter = e.target.value;
      render();
    });
  });
}

// --- init ------------------------------------------------------------------
async function init() {
  let data;
  try {
    const res = await fetch("results_by_node.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (err) {
    console.error("Failed to load results_by_node.json:", err);
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<div style="padding:1rem;background:#fee2e2;color:#991b1b;">' +
      "Error loading results_by_node.json: " + err.message + ". " +
      "If running locally, serve via <code>python3 -m http.server</code> rather than file://." +
      "</div>"
    );
    return;
  }
  DATA = data;
  if (!DATA.families || !DATA.families.length) {
    console.error("results_by_node.json has no families");
    return;
  }
  currentFamily = DATA.families[0];
  wireControls();
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
