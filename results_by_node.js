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
  { key: "path",         label: "Node (covariate path)",     type: "str" },
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

// Numeric fields that get a min/max range filter (keys index the row object).
const NUMERIC_FIELDS = [
  { key: "n",            label: "N" },
  { key: "pct_obs_abx",  label: "% obs. abx" },
  { key: "pct_obs_mort", label: "% obs. mortality" },
  { key: "p_abx",        label: "p(mort) WITH abx" },
  { key: "p_noabx",      label: "p(mort) WITHOUT abx" },
  { key: "ate",          label: "ATE" },
];

let DATA = null;            // parsed results_by_node.json
let currentFamily = null;   // family object
let signalFilter = "all";
let sortKey = "node_id";
let sortDir = 1;            // 1 = asc, -1 = desc

// Dynamic filter state, reset per family.
let minDepth = 0;
let maxDepth = 0;
let valueFilters = {};      // { splitColumnName: selectedValue }  ("" = all)
let numericFilters = {};    // { fieldKey: { min: number|null, max: number|null } }

// Parse a row's value for a numeric field to a Number, or null when it is
// suppressed ("<20") or blank.
function numericValue(row, key) {
  const v = row[key];
  if (v === null || v === undefined || v === "" || v === SUPP) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

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
      } else if (col.key === "path") {
        td.textContent = row.path || row.label || "";
        td.classList.add("varname", "node-path");
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

  // Depth range.
  rows = rows.filter((r) => r.depth >= minDepth && r.depth <= maxDepth);

  // Per-split-column value filters (match the node's ancestor path value).
  Object.keys(valueFilters).forEach((col) => {
    const val = valueFilters[col];
    if (!val) return;
    rows = rows.filter((r) => r.splits && r.splits[col] === val);
  });

  // Numeric range filters (suppressed/blank values are excluded when a bound
  // is active on that field).
  NUMERIC_FIELDS.forEach((f) => {
    const nf = numericFilters[f.key];
    if (!nf || (nf.min === null && nf.max === null)) return;
    rows = rows.filter((r) => {
      const v = numericValue(r, f.key);
      if (v === null) return false;
      if (nf.min !== null && v < nf.min) return false;
      if (nf.max !== null && v > nf.max) return false;
      return true;
    });
  });

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

// --- dynamic filter controls ----------------------------------------------

// Depth levels for the family: level 0 is the root; level d (>=1) is named by
// the split column that defines nodes at that depth.
function depthLevels(family) {
  const maxD = family.rows.reduce((m, r) => Math.max(m, r.depth || 0), 0);
  const rootRow = family.rows.find((r) => r.depth === 0);
  const rootName = (rootRow && (rootRow.path || rootRow.label)) || "Root";
  const splitCols = family.split_columns || [];
  const levels = [];
  for (let d = 0; d <= maxD; d++) {
    const label = d === 0 ? rootName : (splitCols[d - 1] || "Depth " + d);
    levels.push({ depth: d, label: label });
  }
  return levels;
}

function buildDepthControls(family) {
  const levels = depthLevels(family);
  minDepth = 0;
  maxDepth = levels[levels.length - 1].depth;

  const fill = (sel, selectedDepth) => {
    sel.innerHTML = "";
    levels.forEach((lvl) => {
      const opt = document.createElement("option");
      opt.value = String(lvl.depth);
      opt.textContent = lvl.depth + " · " + lvl.label;
      if (lvl.depth === selectedDepth) opt.selected = true;
      sel.appendChild(opt);
    });
  };
  const minSel = document.getElementById("min-depth");
  const maxSel = document.getElementById("max-depth");
  fill(minSel, minDepth);
  fill(maxSel, maxDepth);
}

// Distinct non-null values present in a split column, in first-seen order.
function valuesForColumn(family, col) {
  const seen = [];
  family.rows.forEach((r) => {
    const v = r.splits && r.splits[col];
    if (v != null && v !== "" && seen.indexOf(v) === -1) seen.push(v);
  });
  return seen;
}

function buildValueFilters(family) {
  valueFilters = {};
  const container = document.getElementById("value-filters");
  container.innerHTML = "";
  (family.split_columns || []).forEach((col) => {
    const values = valuesForColumn(family, col);
    if (!values.length) return;
    valueFilters[col] = "";

    const wrap = document.createElement("label");
    wrap.className = "value-filter";
    const span = document.createElement("span");
    span.className = "value-filter-label";
    span.textContent = col;
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", col + " value filter");
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "(all)";
    sel.appendChild(allOpt);
    values.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", (e) => {
      valueFilters[col] = e.target.value;
      render();
    });
    wrap.appendChild(span);
    wrap.appendChild(sel);
    container.appendChild(wrap);
  });
}

function buildNumericFilters() {
  numericFilters = {};
  const grid = document.getElementById("numeric-filter-grid");
  grid.innerHTML = "";
  NUMERIC_FIELDS.forEach((f) => {
    numericFilters[f.key] = { min: null, max: null };

    const row = document.createElement("div");
    row.className = "numeric-filter-row";
    const label = document.createElement("span");
    label.className = "numeric-filter-label";
    label.textContent = f.label;
    row.appendChild(label);

    ["min", "max"].forEach((bound) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "any";
      inp.placeholder = bound;
      inp.setAttribute("aria-label", f.label + " " + bound);
      inp.addEventListener("input", (e) => {
        const raw = e.target.value.trim();
        numericFilters[f.key][bound] = raw === "" ? null : Number(raw);
        render();
      });
      row.appendChild(inp);
    });
    grid.appendChild(row);
  });
}

function resetFilters() {
  signalFilter = "all";
  document.querySelectorAll('input[name="signal"]').forEach((r) => {
    r.checked = r.value === "all";
  });
  buildDepthControls(currentFamily);
  buildValueFilters(currentFamily);
  buildNumericFilters();
  render();
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
  // Rebuild the family-specific dynamic filter controls.
  buildDepthControls(fam);
  buildValueFilters(fam);
  buildNumericFilters();
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

  const minSel = document.getElementById("min-depth");
  const maxSel = document.getElementById("max-depth");
  minSel.addEventListener("change", (e) => {
    minDepth = Number(e.target.value);
    if (minDepth > maxDepth) { maxDepth = minDepth; maxSel.value = String(maxDepth); }
    render();
  });
  maxSel.addEventListener("change", (e) => {
    maxDepth = Number(e.target.value);
    if (maxDepth < minDepth) { minDepth = maxDepth; minSel.value = String(minDepth); }
    render();
  });

  document.getElementById("reset-filters").addEventListener("click", resetFilters);
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
  // Build the dynamic filter controls for the initial family, then render.
  buildDepthControls(currentFamily);
  buildValueFilters(currentFamily);
  buildNumericFilters();
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
