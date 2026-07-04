/*
 * results_by_node.js
 *
 * Browsable per-node results table (Track C). Consumes results_by_node.json
 * (produced by build_results_by_node_data.py, which mirrors the T3.5 static
 * workbook builder code/R/build_static_results_workbook.R). One row per node
 * across 4 merged export-native tree-family views; sort any column; filter by tree family and by
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

// Column blocks in display order (Alec 2026-07-04 reorder):
//   1. Node ID + label
//   2. N + observed %s (both carry a `*` marker pointing at the <20 caveat)
//   3. ATE / 95% CI / Signal, then p(mort) WITH/WITHOUT kept together just after
//   4. Depth, then the per-family root/split covariate columns (appended in
//      activeColumns()).
// `key` indexes the row object; `type` controls sort comparison; `label` is the
// header text. Sorting/filtering key off `key`, not position, so this is a pure
// display reorder.
const ID_COLS = [
  { key: "node_id",      label: "Node ID",                   type: "num" },
  { key: "path",         label: "Node (covariate path)",     type: "str" },
];
const OBS_COLS = [
  { key: "n",            label: "N",                         type: "supp" },
  { key: "pct_obs_abx",  label: "% obs. abx *",              type: "supp" },
  { key: "pct_obs_mort", label: "% obs. mortality *",        type: "supp" },
];
const EST_COLS = [
  { key: "ate",          label: "ATE",                       type: "num" },
  { key: "ci",           label: "95% CI",                    type: "str" },
  { key: "signal",       label: "Signal",                    type: "str" },
  { key: "p_noabx",      label: "p(mort) WITHOUT abx",       type: "num" },
  { key: "p_abx",        label: "p(mort) WITH abx",          type: "num" },
];
const DEPTH_COL = [
  { key: "depth",        label: "Depth",                     type: "num" },
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
let valueFilters = {};        // { splitColumnName: Set<string> of checked values }
let valueFilterOptions = {};  // { splitColumnName: string[] } all distinct values for the column
let valueFilterDepth = {};    // { splitColumnName: {min, max} } observed depth range for the column
let valueFilterEls = {};      // { splitColumnName: <details> element } for depth-gating updates
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
  const rootCol = currentFamily.root_column ? [{
    key: "split:" + currentFamily.root_column,
    label: currentFamily.root_column,
    type: "str",
  }] : [];
  const splitCols = (currentFamily.split_columns || []).map((name) => ({
    key: "split:" + name, label: name, type: "str",
  }));
  return ID_COLS
    .concat(OBS_COLS, EST_COLS, DEPTH_COL, rootCol, splitCols);
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
    if (row.signal === "Benefit") tr.classList.add("row-benefit");
    else if (row.signal === "Harm") tr.classList.add("row-harm");
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
  // A column filters only when it's not fully checked (fully checked = "all",
  // no filtering). Blank/undefined splits (row hasn't reached this column)
  // never match an active filter, same as before multi-select.
  Object.keys(valueFilters).forEach((col) => {
    const selected = valueFilters[col];
    const total = (valueFilterOptions[col] || []).length;
    if (!selected || selected.size === total) return;
    rows = rows.filter((r) => r.splits && selected.has(r.splits[col]));
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
    "Cells showing “<20” are VA small-cell suppressed; * columns (% observed) " +
    "show “<20” for small cells. Rows shaded green = " +
    "credible benefit (95% CI below 0), red = credible harm (CI above 0).";
}

// --- dynamic filter controls ----------------------------------------------

// Depth levels for the family: level 0 is the root; level d (>=1) is named by
// the split column that defines nodes at that depth.
function depthLevels(family) {
  const maxD = family.rows.reduce((m, r) => Math.max(m, r.depth || 0), 0);
  const rootRows = family.rows.filter((r) => r.depth === 0);
  const rootName = rootRows.length === 1 ?
    ((rootRows[0].path || rootRows[0].label) || "Root") : "Root";
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

// Observed [min, max] row depth at which a split column carries a value.
// Used to gray out a column's filter once it falls outside [minDepth, maxDepth].
function depthRangeForColumn(family, col) {
  let lo = null, hi = null;
  family.rows.forEach((r) => {
    if (r.splits && r.splits[col] != null && r.splits[col] !== "") {
      if (lo === null || r.depth < lo) lo = r.depth;
      if (hi === null || r.depth > hi) hi = r.depth;
    }
  });
  return { min: lo, max: hi };
}

function updateValueFilterSummary(col) {
  const el = valueFilterEls[col];
  if (!el) return;
  const total = valueFilterOptions[col].length;
  const n = valueFilters[col].size;
  el.summary.textContent = col + (n === total ? " (all)" : " (" + n + "/" + total + ")");
}

// Gray out (disable) value-filter groups whose column has no row within the
// current [minDepth, maxDepth] range. State is preserved, not reset, so
// widening the depth range later restores the prior selection.
function applyValueFilterDepthGating() {
  Object.keys(valueFilterEls).forEach((col) => {
    const range = valueFilterDepth[col];
    const inRange = range && range.min !== null &&
      range.max >= minDepth && range.min <= maxDepth;
    const el = valueFilterEls[col];
    el.details.classList.toggle("value-filter--out-of-range", !inRange);
    el.checkboxes.forEach((cb) => { cb.disabled = !inRange; });
  });
}

function buildValueFilters(family) {
  valueFilters = {};
  valueFilterOptions = {};
  valueFilterDepth = {};
  valueFilterEls = {};
  const container = document.getElementById("value-filters");
  container.innerHTML = "";
  const filterColumns = (family.root_column ? [family.root_column] : [])
    .concat(family.split_columns || []);
  filterColumns.forEach((col) => {
    const values = valuesForColumn(family, col);
    if (!values.length) return;
    valueFilterOptions[col] = values;
    valueFilters[col] = new Set(values); // default: all checked = no filter
    valueFilterDepth[col] = depthRangeForColumn(family, col);

    const details = document.createElement("details");
    details.className = "value-filter";
    const summary = document.createElement("summary");
    summary.className = "value-filter-summary";
    details.appendChild(summary);

    const list = document.createElement("div");
    list.className = "value-filter-options";
    const checkboxes = [];
    values.forEach((v) => {
      const label = document.createElement("label");
      label.className = "value-filter-option";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = v;
      cb.setAttribute("aria-label", col + ": " + v);
      cb.addEventListener("change", () => {
        if (cb.checked) valueFilters[col].add(v); else valueFilters[col].delete(v);
        updateValueFilterSummary(col);
        render();
      });
      const text = document.createElement("span");
      text.textContent = " " + v;
      label.appendChild(cb);
      label.appendChild(text);
      list.appendChild(label);
      checkboxes.push(cb);
    });
    details.appendChild(list);
    container.appendChild(details);
    valueFilterEls[col] = { details: details, summary: summary, checkboxes: checkboxes };
    updateValueFilterSummary(col);
  });
  applyValueFilterDepthGating();
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
    applyValueFilterDepthGating();
    render();
  });
  maxSel.addEventListener("change", (e) => {
    maxDepth = Number(e.target.value);
    if (maxDepth < minDepth) { minDepth = maxDepth; minSel.value = String(minDepth); }
    applyValueFilterDepthGating();
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
