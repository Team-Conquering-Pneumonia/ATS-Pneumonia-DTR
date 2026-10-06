/* ATS Poster Interactive Site — Wave 3 (node-driven interaction model)
 *
 * Tree PNG path:           assets/trees/severity={...}_outcome=30day_depth={d}.png
 * Per-node contour PNG:    assets/node-contours-byvirus/contour_<tree>_nodeNN_<window>.png
 *                          (from node_contours_byvirus_index.json)
 *
 * Interaction model (replaces Wave 2.5 stacked-contour layout):
 *   - Hot-zones over each visible tree node (from tree_coordinates.json)
 *   - Hover/tap → tooltip with label, N, % abx, ATE
 *   - Click → select node, swap right-panel contour to that node's PNG
 *   - Double-click → advanceDepth() (depth-only model preserved)
 *   - Empty-space click no longer advances depth.
 */

"use strict";

const state = {
  outcome: "90day",
  root_var: "severity",
  root_value: "moderate",
  depth: 0,
  selected_slug: null,
  highlight_virus: null,   // virus row to highlight in the by-virus table (deep link)
  highlight_node_id: null, // Report node_id of that virus-level row
  interactive: true
};

let topology = null;          // tree_topology.json (depth/columns metadata)
let coordinates = null;       // tree_coordinates.json (node bboxes per state)
let contourIndex = null;      // node_contours_byvirus_index.json
let resultsByNode = null;     // results_by_node.json, used as a slug -> node_id bridge
let treePanzoom = null;
let contourPanzoom = null;

// --- panzoom ---------------------------------------------------------------

const PANZOOM_OPTS = {
  // Phase 2-D: allow 4x zoom-out so tall depth-4 trees (up to ~6000px) can be
  // shrunk to fit the viewport. `bounds: false` is required because, with
  // bounds on, panzoom refuses to scale below 1x once the content fits the
  // container — and our stage already starts at "fit width", so bounded
  // zoom-out is effectively clamped to 1. Looser bounds + boundsPadding keeps
  // the image partially recoverable if the user pans far off-screen.
  minZoom: 0.25,
  maxZoom: 8,
  smoothScroll: false,
  bounds: false,
  boundsPadding: 0.1,
  zoomDoubleClickSpeed: 1, // disable panzoom's double-click zoom
  // A plain scroll wheel scrolls the page; Ctrl/Cmd + wheel (and trackpad
  // pinch, which browsers report as Ctrl + wheel) zooms. Returning true tells
  // panzoom to ignore the event.
  beforeWheel: (e) => !(e.ctrlKey || e.metaKey)
};

function initPanzoom(targetEl) {
  if (typeof panzoom !== "function") {
    console.warn("panzoom library not loaded");
    return null;
  }
  return panzoom(targetEl, PANZOOM_OPTS);
}

function resetPanzoom(pz) {
  if (!pz) return;
  pz.moveTo(0, 0);
  pz.zoomAbs(0, 0, 1);
}

// --- fit the tree to its panel -----------------------------------------------
// Tree images share one canvas across depths, so a shallow tree can sit small in
// a wide, mostly blank image. Find the drawn (non-white) region once per image
// and zoom/pan so that region fills the panel.

const FIT_PAD_PX = 16;
const FIT_MAX_ZOOM = 2.5;
const contentBoxCache = {};

// Drawn-content box in the image's natural pixel coordinates, or null when the
// pixels can't be read (e.g. a file:// page taints the canvas).
function imageContentBox(img) {
  if (!img || !img.naturalWidth) return null;
  if (contentBoxCache[img.src] !== undefined) return contentBoxCache[img.src];
  let box = null;
  try {
    const w = Math.min(400, img.naturalWidth);
    const h = Math.max(1, Math.round(img.naturalHeight * w / img.naturalWidth));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3] > 16 && (px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 >= x0 && y1 >= y0) {
      const k = img.naturalWidth / w;
      box = { x: x0 * k, y: y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
    }
  } catch (err) {
    box = null;
  }
  contentBoxCache[img.src] = box;
  return box;
}

function fitTree() {
  const pz = treePanzoom;
  const wrapper = document.getElementById("tree-wrapper");
  const stage = document.getElementById("tree-stage");
  const img = document.getElementById("tree-img");
  if (!pz || !wrapper || !stage || !img || !img.clientWidth) return;
  resetPanzoom(pz);
  const box = imageContentBox(img);
  if (!box) return;
  const k = img.clientWidth / img.naturalWidth;          // natural -> rendered px
  const cw = box.w * k, ch = box.h * k;
  const cx = (box.x + box.w / 2) * k, cy = (box.y + box.h / 2) * k;
  const wr = wrapper.getBoundingClientRect();
  const scale = Math.max(1, Math.min(
    (wr.width - 2 * FIT_PAD_PX) / cw,
    (wr.height - 2 * FIT_PAD_PX) / ch,
    FIT_MAX_ZOOM
  ));
  // panzoom applies its transform on the next frame, so place the content
  // centre analytically rather than by measuring: with transform-origin 0 0,
  // a stage point p lands at stage offset + translate + scale * p.
  pz.zoomAbs(0, 0, scale);
  pz.moveTo(
    wr.width / 2 - stage.offsetLeft - scale * cx,
    wr.height / 2 - stage.offsetTop - scale * cy
  );
}

function ensurePanzooms() {
  // Tree panzoom attaches to the STAGE (img + hot-zone overlay) so they
  // pan/zoom together as one transformed group.
  const treeStage = document.getElementById("tree-stage");
  const contourImg = document.getElementById("contour-img");
  if (!treePanzoom) treePanzoom = initPanzoom(treeStage);
  if (!contourPanzoom) contourPanzoom = initPanzoom(contourImg);
}

function pzForTarget(target) {
  return target === "tree" ? treePanzoom : target === "contour" ? contourPanzoom : null;
}

// --- helpers ---------------------------------------------------------------

function treeKey() {
  return `${state.root_var}=${state.root_value}_outcome=${state.outcome}`;
}

function rootValueOptions(root_var) {
  if (root_var === "virus") return ["flu", "rsv", "covid", "others", "none"];
  // Whole-cohort trees have no user-facing root value; the tree_key's
  // root_value slot repeats the root_var so treeKey() resolves.
  if (root_var === "root") return ["root"];
  if (root_var === "sevvirus") return ["sevvirus"];
  if (root_var === "virsev") return ["virsev"];
  return ["mild", "moderate", "severe"];
}

// severity/virus trees have a root-value picker (which stratum); the whole-
// cohort trees (root, sevvirus, virsev) do not.
function rootVarHasValue(root_var) {
  return root_var === "severity" || root_var === "virus";
}

// Subgroup picker labels: the same spellings the Report view's data uses.
function rootValueLabel(v) {
  return rootValueColumnLabel(v);
}

function defaultRootValue(root_var) {
  if (root_var === "virus") return "flu";
  if (root_var === "root") return "root";
  if (root_var === "sevvirus") return "sevvirus";
  if (root_var === "virsev") return "virsev";
  return "moderate";
}

function stateKey() {
  return `${treeKey()}_depth=${state.depth}`;
}

function familyKey() {
  return `${state.outcome}_${state.root_var}`;
}

// Merged families (Item 6) key rows by root_var, not root_value; each row
// still carries its stratum in splits[family.root_column] (e.g. "Mild",
// "Influenza"). This maps a root_value slug to that exact label string.
function rootValueColumnLabel(v) {
  const labels = {
    mild: "Mild", moderate: "Moderate", severe: "Severe",
    flu: "Influenza", rsv: "RSV", covid: "SARS-CoV-2", others: "Other viruses", none: "No virus"
  };
  return labels[v] || v;
}

function maxDepth() {
  const entry = topology && topology[treeKey()];
  return entry ? entry.max_depth : 0;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function currentColumns() {
  const entry = topology[treeKey()];
  if (!entry) return [];
  const d = entry.depths[String(state.depth)];
  return d ? asArray(d.outline_columns) : [];
}

function fullColumns() {
  const entry = topology[treeKey()];
  if (!entry) return [];
  const d = entry.depths[String(entry.max_depth)];
  return d ? asArray(d.outline_columns) : [];
}

function currentNodes() {
  if (!coordinates || !coordinates.states) return [];
  const s = coordinates.states[stateKey()];
  if (!s) return [];
  return Array.isArray(s.nodes) ? s.nodes : [];
}

function currentImageDims() {
  if (!coordinates || !coordinates.states) return null;
  const s = coordinates.states[stateKey()];
  return s ? s.image : null;
}

function rootSlugForCurrentState() {
  const nodes = currentNodes();
  if (nodes.length === 0) return null;
  // Prefer is_root, else first node.
  const root = nodes.find(n => n.is_root);
  return (root || nodes[0]).slug;
}

// --- image setter (with missing-fallback) ---------------------------------

function setImage(imgEl, wrapperId, src, altText, onLoaded) {
  const wrapper = document.getElementById(wrapperId);
  const spinner = wrapper.querySelector(".loading-spinner");
  const oldFallback = wrapper.querySelector(".img-missing");
  if (oldFallback) oldFallback.remove();

  spinner.classList.add("active");
  imgEl.style.display = "";
  imgEl.alt = altText;

  imgEl.onload = () => {
    spinner.classList.remove("active");
    if (imgEl.id === "tree-img") fitTree();
    if (imgEl.id === "contour-img") resetPanzoom(contourPanzoom);
    if (typeof onLoaded === "function") onLoaded();
  };
  imgEl.onerror = () => {
    spinner.classList.remove("active");
    imgEl.style.display = "none";
    const fb = document.createElement("div");
    fb.className = "img-missing";
    fb.textContent = `Image not yet available:\n${src}`;
    fb.style.whiteSpace = "pre-line";
    wrapper.appendChild(fb);
  };
  imgEl.src = src;
}

// --- hot-zones -------------------------------------------------------------

const MIN_HIT_PX = 44; // mobile-friendly minimum tap target

function clearHotzones() {
  const layer = document.getElementById("hotzone-layer");
  if (layer) layer.innerHTML = "";
}

function renderHotzones() {
  const layer = document.getElementById("hotzone-layer");
  const treeImg = document.getElementById("tree-img");
  if (!layer || !treeImg) return;

  layer.innerHTML = "";

  const dims = currentImageDims();
  const nodes = currentNodes();
  // With more than one node on screen, the unselected ones are faded so the
  // selected node stands out at full strength.
  layer.classList.toggle("dim-unselected", nodes.length > 1);
  if (!dims || !dims.width_px || nodes.length === 0) return;

  // The hot-zone layer is sized to the natural img client size — pan/zoom is
  // applied by panzoom on the parent .tree-stage, so we work in unscaled
  // image coords here.
  const renderedW = treeImg.clientWidth || treeImg.naturalWidth || dims.width_px;
  const scale = renderedW / dims.width_px;
  if (!isFinite(scale) || scale <= 0) return;

  // Match layer to rendered image box.
  layer.style.width = treeImg.clientWidth + "px";
  layer.style.height = treeImg.clientHeight + "px";

  for (const node of nodes) {
    const bb = node.bbox_px || {};
    if ([bb.x, bb.y, bb.w, bb.h].some(v => typeof v !== "number" || !isFinite(v))) continue;

    const x = bb.x * scale;
    const y = bb.y * scale;
    const w = bb.w * scale;
    const h = bb.h * scale;

    // Expand the clickable area to MIN_HIT_PX without moving the visual rect.
    const padX = Math.max(0, (MIN_HIT_PX - w) / 2);
    const padY = Math.max(0, (MIN_HIT_PX - h) / 2);

    const hz = document.createElement("div");
    hz.className = "node-hotzone";
    if (node.slug === state.selected_slug) hz.classList.add("selected");
    hz.style.left = (x - padX) + "px";
    hz.style.top = (y - padY) + "px";
    hz.style.width = w + "px";
    hz.style.height = h + "px";
    hz.style.padding = padY + "px " + padX + "px";
    hz.dataset.slug = node.slug;
    hz.tabIndex = 0;
    hz.setAttribute("role", "button");
    hz.setAttribute("aria-label", `${node.label} — N=${node.N}`);

    hz.addEventListener("click", (e) => {
      e.stopPropagation();
      selectNode(node.slug);
    });
    hz.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      advanceDepth();
    });
    hz.addEventListener("mouseenter", () => showTooltip(node, hz));
    hz.addEventListener("mousemove", () => showTooltip(node, hz));
    hz.addEventListener("mouseleave", hideTooltip);
    // Touch: tap shows tooltip briefly + selects.
    hz.addEventListener("touchstart", () => showTooltip(node, hz), { passive: true });

    layer.appendChild(hz);
  }
}

// --- tooltip ---------------------------------------------------------------

let tooltipHideTimer = null;

function fmtPct(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  return SiteNav.fmtPct(v) + "%";
}
function fmtAte(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  return SiteNav.fmtPp(v) + " pp";
}
function fmtN(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  return v.toLocaleString();
}

function showTooltip(node, hzEl) {
  const tt = document.getElementById("node-tooltip");
  const wrapper = document.getElementById("tree-wrapper");
  if (!tt || !wrapper) return;
  tt.innerHTML = `
    <div class="tt-label">${escapeHtml(SiteNav.levelLabel(node.label || node.node_id))}</div>
    <div class="tt-row"><span class="tt-key">N</span><span>${fmtN(node.N)}</span></div>
    <div class="tt-row"><span class="tt-key">Given antibiotics</span><span>${fmtPct(node.abx_pct)}</span></div>
    <div class="tt-row"><span class="tt-key">Effect</span><span>${fmtAte(node.ate)}</span></div>
  `;
  // Anchor tooltip beside the hot-zone (right preferred, then left, then below)
  // so the node stays visible. Coordinates are relative to the wrapper.
  const wrapRect = wrapper.getBoundingClientRect();
  const hzRect = hzEl.getBoundingClientRect();
  tt.classList.add("visible");
  tt.setAttribute("aria-hidden", "false");
  const ttRect = tt.getBoundingClientRect();
  const gap = 10;
  const hzLeft = hzRect.left - wrapRect.left;
  const hzTop = hzRect.top - wrapRect.top;
  const rightSpace = wrapRect.width - (hzLeft + hzRect.width);
  const leftSpace = hzLeft;
  let left, top;
  if (rightSpace >= ttRect.width + gap + 4) {
    left = hzLeft + hzRect.width + gap;
    top = hzTop + hzRect.height / 2 - ttRect.height / 2;
  } else if (leftSpace >= ttRect.width + gap + 4) {
    left = hzLeft - ttRect.width - gap;
    top = hzTop + hzRect.height / 2 - ttRect.height / 2;
  } else {
    // Fallback: below the node, centered horizontally.
    left = hzLeft + hzRect.width / 2 - ttRect.width / 2;
    top = hzTop + hzRect.height + gap;
  }
  tt.style.left = Math.max(4, Math.min(left, wrapRect.width - ttRect.width - 4)) + "px";
  tt.style.top = Math.max(4, top) + "px";

  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  // Auto-hide on touch devices after a short delay.
  tooltipHideTimer = setTimeout(hideTooltip, 3500);
}

function hideTooltip() {
  const tt = document.getElementById("node-tooltip");
  if (!tt) return;
  tt.classList.remove("visible");
  tt.setAttribute("aria-hidden", "true");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function normalizeLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/flu/g, "influenza")
    .replace(/others/g, "other viruses")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pathDepth(node) {
  return String(node && node.node_id || "").split(" > ").length - 1;
}

// The merged families' own `depth` field is a Report-view "canonical depth"
// aligned across root values (so e.g. moderate can skip a column mild/severe
// use) — it no longer matches the tree page's pathDepth(). Count real splits
// applied instead (every non-null entry in `splits` besides the always-set
// root-stratum column), which does match pathDepth() exactly.
function rowSplitDepth(row, family) {
  const splits = row && row.splits;
  if (!splits) return -1;
  let count = 0;
  for (const key in splits) {
    if (key === family.root_column) continue;
    if (splits[key] != null) count++;
  }
  return count;
}

// The merged families (Item 6) carry rows for every root_value of a stratum
// concatenated in per-value blocks. contourIndex/node_contours_byvirus_index.json
// still number nodes locally within each root_value (1..N per block), so a
// row's merged, global node_id is not usable as-is to key into it — the row's
// position within its own root_value's block is.
function currentFamilyStrata() {
  if (!resultsByNode || !Array.isArray(resultsByNode.families)) return null;
  const family = resultsByNode.families.find(f => f.key === familyKey());
  if (!family || !Array.isArray(family.rows)) return null;
  const rootLabel = rootValueColumnLabel(state.root_value);
  const rows = family.rows.filter(r => r.splits && r.splits[family.root_column] === rootLabel);
  return { family, rows };
}

function matchingResultRow(node) {
  if (!node) return null;
  const strata = currentFamilyStrata();
  if (!strata) return null;

  const nText = (typeof node.N === "number" && isFinite(node.N)) ? String(node.N) : null;
  if (!nText) return null;
  const depth = pathDepth(node);
  const label = normalizeLabel(node.label);
  const candidates = strata.rows.filter(r => String(r.n) === nText && rowSplitDepth(r, strata.family) === depth);
  const labelMatches = candidates.filter(r => {
    const rowLabel = normalizeLabel(r.label);
    return rowLabel === label || rowLabel.includes(label) || label.includes(rowLabel);
  });
  const matches = labelMatches.length === 1 ? labelMatches : candidates;
  return matches.length === 1 ? matches[0] : null;
}

// contourIndex's local numbering is the node's position in the FULL,
// pre-suppression per-root_value node enumeration, so on strata (like
// "severe") where some nodes were dropped for small N it has gaps. The
// merged results_by_node.json drops the same nodes and keeps the rest in the
// same relative order, so a row's rank among the surviving rows equals its
// rank among the surviving (sorted, gappy) contourIndex keys for that
// root_value+outcome — not the row's raw array position.
function contourLocalIndexNumbers(rootValue, outcome) {
  const prefix = `${rootValue}__node`;
  const suffix = `__${outcome}`;
  return Object.keys(contourIndex.nodes)
    .filter(k => k.startsWith(prefix) && k.endsWith(suffix))
    .map(k => parseInt(k.slice(prefix.length, k.length - suffix.length), 10))
    .sort((a, b) => a - b);
}

function contourEntryForNode(node) {
  if (!node || !contourIndex || !contourIndex.nodes) return null;
  if (state.root_var !== "severity") return null;
  const strata = currentFamilyStrata();
  if (!strata) return null;
  const resultRow = matchingResultRow(node);
  if (!resultRow) return null;
  const rank = strata.rows.indexOf(resultRow);
  if (rank < 0) return null;
  const localIndex = contourLocalIndexNumbers(state.root_value, state.outcome)[rank];
  if (localIndex == null) return null;
  const key = `${state.root_value}__node${String(localIndex).padStart(2, "0")}__${state.outcome}`;
  return contourIndex.nodes[key] || null;
}

function setMissingContour(message) {
  const wrapper = document.getElementById("contour-wrapper");
  const img = document.getElementById("contour-img");
  const spinner = wrapper.querySelector(".loading-spinner");
  const oldFallback = wrapper.querySelector(".img-missing");
  if (oldFallback) oldFallback.remove();
  spinner.classList.remove("active");
  img.style.display = "none";
  img.removeAttribute("src");
  const fb = document.createElement("div");
  fb.className = "img-missing";
  fb.textContent = message;
  wrapper.appendChild(fb);
}

// Same colors as the contour legend (VIRUS_PALETTE in code/R/figure_contour_overlay.R).
const VIRUS_COLORS = {
  "Influenza": "#E76F51", "SARS-CoV-2": "#264653", "COVID": "#264653",
  "RSV": "#2A9D8F", "Other": "#F4A261", "None": "#7E7E7E",
};

// Virus names differ slightly between files ("Other" vs "Other Viruses").
function virusKey(v) {
  const k = String(v || "").toLowerCase();
  if (k.startsWith("other")) return "other";
  if (k === "none" || k === "no virus") return "none";
  if (k === "covid") return "sars-cov-2";
  return k;
}

function contourByvirusTableHtml(byVirus, highlightVirus) {
  if (!Array.isArray(byVirus) || byVirus.length === 0) return "";
  const target = highlightVirus ? virusKey(highlightVirus) : null;
  const rows = byVirus.map(row => {
    const lo = typeof row.ate_ci_lower === "number" ? row.ate_ci_lower : null;
    const hi = typeof row.ate_ci_upper === "number" ? row.ate_ci_upper : null;
    const signal = (lo == null || hi == null) ? "" : (hi < 0 ? "Benefit" : (lo > 0 ? "Harm" : "Inconclusive"));
    const classes = [signal === "Benefit" ? "row-benefit" : (signal === "Harm" ? "row-harm" : "")];
    if (target && virusKey(row.virus) === target) classes.push("row-target-highlight");
    const ateClass = signal === "Benefit" ? "ate-benefit" : (signal === "Harm" ? "ate-harm" : "");
    const ci = SiteNav.fmtPpRange(lo, hi);
    return `
      <tr class="${classes.join(" ").trim()}">
        <td class="varname"><span class="virus-label">${VIRUS_COLORS[row.virus] ? `<span class="virus-dot" style="background:${VIRUS_COLORS[row.virus]}" aria-hidden="true"></span>` : ""}${escapeHtml(row.virus)}</span></td>
        <td>${fmtN(row.n)}</td>
        <td class="${ateClass}">${SiteNav.fmtPp(row.ate)}</td>
        <td class="ci">${ci}</td>
      </tr>`;
  }).join("");
  return `
    <div class="table-scroll">
      <table class="data-table results-by-node byvirus-table" aria-label="Treatment effect by virus for the selected subgroup">
        <thead>
          <tr><th>Virus</th><th>N</th><th>Effect (pp)</th><th>95% CI</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="table-foot">Effect: mortality with antibiotics minus without, in percentage points.</p>`;
}

function renderContourByvirusTable(idxEntry) {
  const table = document.getElementById("contour-byvirus-table");
  if (!table) return;
  const html = contourByvirusTableHtml(idxEntry && idxEntry.by_virus, state.highlight_virus);
  table.innerHTML = html;
  table.hidden = html === "";
}

function rootValueSlugFromLabel(root_var, label) {
  const opts = rootValueOptions(root_var);
  return opts.find(v => rootValueColumnLabel(v) === label) || null;
}

function updateReportLink(node) {
  const link = document.getElementById("view-in-report-link");
  if (!link) return;
  const row = matchingResultRow(node);
  if (!row) { link.hidden = true; return; }
  link.href = `results_by_node.html?family=${encodeURIComponent(familyKey())}&node=${row.node_id}`;
  link.hidden = false;
}

// "Moderate pneumonia (90-day mortality) > Sepsis (No Hypoxemia)" ->
// "Moderate pneumonia › Sepsis (No Hypoxemia)".
function nodePathLabel(node) {
  const raw = String((node && (node.node_id || node.label)) || "");
  const parts = raw.split(" > ").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  let root = parts[0].replace(/\s*\(\d+-day mortality\)\s*$/i, "");
  root = SiteNav.levelLabel(root);
  if (/^overall cohort$/i.test(root)) root = "Whole cohort";
  parts[0] = root.charAt(0).toUpperCase() + root.slice(1);
  return parts.join(" \u203A ");
}

// Parse a Report-row CI string "(-0.034, -0.013)" into numbers.
function parseCi(ci) {
  const m = String(ci || "").match(/\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
  return m ? { lo: Number(m[1]), hi: Number(m[2]) } : null;
}

// --- selection -------------------------------------------------------------

function selectNode(slug) {
  if (!slug) return;
  state.selected_slug = slug;
  state.highlight_virus = null;
  // Update hot-zone selection class without full re-render.
  document.querySelectorAll(".node-hotzone").forEach(el => {
    el.classList.toggle("selected", el.dataset.slug === slug);
  });
  renderContourPanel();
  syncUrl();
}

function ensureSelectionValid() {
  const nodes = currentNodes();
  const slugs = new Set(nodes.map(n => n.slug));
  if (!state.selected_slug || !slugs.has(state.selected_slug)) {
    state.selected_slug = rootSlugForCurrentState();
  }
}

// --- right panel: by-virus contour ----------------------------------------

function renderContourPanel() {
  const breadcrumb = document.getElementById("contour-breadcrumb");
  const meta = document.getElementById("contour-meta");
  const img = document.getElementById("contour-img");
  if (!breadcrumb || !meta || !img) return;

  const slug = state.selected_slug;
  const node = currentNodes().find(n => n.slug === slug);
  // Positivity-blanked nodes (node_suppression.R) show no treatment effect, so
  // no contour either: the contour IS the blanked contrast.
  const idxEntry = node && node.effect_blanked ? null : contourEntryForNode(node);
  updateReportLink(node);

  if (!slug) {
    breadcrumb.textContent = "";
    meta.innerHTML = "";
    renderContourByvirusTable(null);
    img.style.display = "none";
    return;
  }

  const breadcrumbText = nodePathLabel(node) || slug;
  breadcrumb.textContent = breadcrumbText;
  breadcrumb.title = breadcrumbText;

  // Effect and CI come from the Report row when there is one, so both pages
  // show the same rounded numbers; otherwise from the contour index / node.
  const row = matchingResultRow(node);
  const rowCi = row ? parseCi(row.ci) : null;
  const N = node ? node.N : null;
  const ate = row && typeof row.ate === "number" ? row.ate
    : (idxEntry ? idxEntry.ate : (node ? node.ate : null));
  const ci = rowCi ? SiteNav.fmtPpRange(rowCi.lo, rowCi.hi)
    : (idxEntry && idxEntry.ate_ci_lower != null && idxEntry.ate_ci_upper != null
      ? SiteNav.fmtPpRange(idxEntry.ate_ci_lower, idxEntry.ate_ci_upper) : null);
  meta.innerHTML = [
    N != null ? `<span><span class="meta-key">N</span>${fmtN(N)}</span>` : "",
    ate != null ? `<span><span class="meta-key">Effect</span>${fmtAte(ate)}${ci != null ? ` <span class="meta-ci">(95% CI ${ci})</span>` : ""}</span>` : ""
  ].filter(Boolean).join("");
  renderContourByvirusTable(idxEntry);

  if (!idxEntry || !idxEntry.image) {
    setMissingContour(
      state.root_var === "severity"
        ? "Virus breakdown isn't available for this subgroup."
        : "Virus breakdown is available for severity trees only."
    );
    return;
  }

  const src = idxEntry.image;
  setImage(img, "contour-wrapper", src, `Contour for ${breadcrumbText}`);
}

// --- outline + depth display ----------------------------------------------

// One button per tree level. Shown levels are filled; clicking one collapses
// the tree back to it. Hidden levels are outlined with a "+"; clicking one
// expands the tree down to it.
function renderOutline() {
  const container = document.getElementById("outline-columns");
  container.innerHTML = "";

  const cur = currentColumns();
  const full = fullColumns();
  const pending = full.slice(cur.length);

  cur.forEach((label, idx) => {
    const name = SiteNav.levelLabel(label);
    const el = document.createElement("button");
    el.type = "button";
    el.className = "outline-col active";
    el.textContent = name;
    el.dataset.depth = String(idx);
    const isLast = idx === cur.length - 1;
    el.setAttribute("aria-pressed", "true");
    el.title = isLast ? "Shown" : `Collapse the tree back to ${name}`;
    el.addEventListener("click", () => setDepth(idx));
    container.appendChild(el);
  });

  pending.forEach((label, i) => {
    const name = SiteNav.levelLabel(label);
    const targetDepth = cur.length + i;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "outline-col pending";
    el.dataset.depth = String(targetDepth);
    el.setAttribute("aria-pressed", "false");
    el.title = `Show the tree down to ${name}`;
    const plus = document.createElement("span");
    plus.className = "outline-plus";
    plus.setAttribute("aria-hidden", "true");
    plus.textContent = "+";
    el.appendChild(plus);
    el.appendChild(document.createTextNode(name));
    el.addEventListener("click", () => setDepth(targetDepth));
    container.appendChild(el);
  });
}

function renderTreeImage() {
  const key = treeKey();
  const st = coordinates && coordinates.states ? coordinates.states[stateKey()] : null;
  const treeDir = (st && st.image_dir) || "assets/trees";
  const treeSrc = `${treeDir}/${key}_depth=${state.depth}.png`;
  // Top-down trees are wide rather than tall: give the tree more of the row.
  const panels = document.querySelector(".main-panels");
  if (panels) panels.classList.toggle("topdown", !!(st && st.image_dir));
  const treeImg = document.getElementById("tree-img");
  setImage(
    treeImg,
    "tree-wrapper",
    treeSrc,
    `Decision tree for ${state.root_value} pneumonia at depth ${state.depth}`,
    () => renderHotzones()
  );
}

function render() {
  applyViewMode();
  if (!state.interactive) {
    renderStaticView();
    syncUrl();
    return;
  }
  ensureSelectionValid();
  renderOutline();
  renderTreeImage();
  renderContourPanel();
  syncUrl();
}

// --- interactive / static view toggle -------------------------------------

// Interactive-only regions are hidden when the static integrated figure is
// shown; the control bar (outcome / root / root value) still selects which
// figure to display.
function applyViewMode() {
  const interactive = state.interactive;
  const setHidden = (sel, hidden) =>
    document.querySelectorAll(sel).forEach((el) => { el.hidden = hidden; });
  setHidden(".legend", !interactive);
  setHidden(".tree-outline", !interactive);
  setHidden(".main-panels", !interactive);
  const sp = document.getElementById("static-panel");
  if (sp) sp.hidden = interactive;
}

function staticFigureSrc() {
  // The integrated tree+contour figure exists per root value × window.
  return `assets/integrated/tree_contour_integrated_${state.root_value}_${state.outcome}.png`;
}

function setMissingStatic(message) {
  const wrapper = document.getElementById("static-wrapper");
  const img = document.getElementById("static-img");
  const spinner = wrapper.querySelector(".loading-spinner");
  const oldFallback = wrapper.querySelector(".img-missing");
  if (oldFallback) oldFallback.remove();
  if (spinner) spinner.classList.remove("active");
  img.style.display = "none";
  img.removeAttribute("src");
  const fb = document.createElement("div");
  fb.className = "img-missing";
  fb.textContent = message;
  wrapper.appendChild(fb);
}

function renderStaticView() {
  const wrapper = document.getElementById("static-wrapper");
  const img = document.getElementById("static-img");
  if (!wrapper || !img) return;
  const spinner = wrapper.querySelector(".loading-spinner");
  const oldFallback = wrapper.querySelector(".img-missing");
  if (oldFallback) oldFallback.remove();

  const src = staticFigureSrc();
  if (!src) {
    setMissingStatic(
      "The full figure for this tree isn't available. Switch View to Explore to step through it."
    );
    return;
  }

  if (spinner) spinner.classList.add("active");
  img.style.display = "";
  img.onload = () => { if (spinner) spinner.classList.remove("active"); };
  img.onerror = () => {
    setMissingStatic(
      "The full figure for this tree isn't available. Switch View to Explore to step through it."
    );
  };
  img.src = src;
}

// --- state mutators --------------------------------------------------------

function setDepth(d) {
  const m = maxDepth();
  const next = Math.max(0, Math.min(d, m));
  if (next === state.depth) return;
  state.depth = next;
  // Reset selection to root of the new view; ensureSelectionValid in render()
  // will repick if the previous slug is gone.
  state.selected_slug = null;
  state.highlight_virus = null;
  render();
}

function advanceDepth() { setDepth(state.depth + 1); }
function retreatDepth() { setDepth(state.depth - 1); }

function setRootValue(v) {
  if (!rootValueOptions(state.root_var).includes(v)) return;
  state.root_value = v;
  state.depth = 0;
  state.selected_slug = null;
  state.highlight_virus = null;
  render();
}

function setRootVar(rv) {
  if (!SiteNav.TREE_ORDER.includes(rv)) return;
  if (rv === state.root_var) return;
  state.root_var = rv;
  state.root_value = defaultRootValue(rv);
  state.depth = 0;
  state.selected_slug = null;
  state.highlight_virus = null;
  refreshRootValueSelect();
  render();
}

function setOutcome(o) {
  if (!["30day", "90day"].includes(o)) return;
  if (o === state.outcome) return;
  state.outcome = o;
  state.depth = 0;
  state.selected_slug = null;
  state.highlight_virus = null;
  render();
}

function refreshRootValueSelect() {
  // Whole-cohort trees (root, sevvirus, virsev) have no subgroup: keep the
  // picker in place, disabled, so the controls don't shift.
  const hasValue = rootVarHasValue(state.root_var);
  const treeSel = document.getElementById("tree-select");
  if (treeSel) treeSel.value = state.root_var;

  const sel = document.getElementById("root-value");
  if (!sel) return;
  sel.innerHTML = "";
  sel.disabled = !hasValue;
  if (!hasValue) {
    const opt = document.createElement("option");
    opt.textContent = "All patients";
    sel.appendChild(opt);
    return;
  }
  const opts = rootValueOptions(state.root_var);
  opts.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = rootValueLabel(v);
    if (v === state.root_value) opt.selected = true;
    sel.appendChild(opt);
  });
}

// --- wire up ---------------------------------------------------------------

function wireUp() {
  // Initialize the root-value select to match state.root_var.
  refreshRootValueSelect();

  document.getElementById("root-value").addEventListener("change", (e) => {
    setRootValue(e.target.value);
  });

  document.querySelectorAll('input[name="outcome"]').forEach(r => {
    r.addEventListener("change", (e) => {
      if (e.target.checked) setOutcome(e.target.value);
    });
  });

  document.getElementById("tree-select").addEventListener("change", (e) => {
    setRootVar(e.target.value);
  });

  document.querySelectorAll('input[name="view"]').forEach(r => {
    r.addEventListener("change", (e) => {
      if (!e.target.checked) return;
      state.interactive = e.target.value === "explore";
      render();
    });
  });

  // Zoom-control buttons for both panels.
  document.querySelectorAll(".zoom-controls button").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = btn.dataset.zoomTarget;
      const action = btn.dataset.zoomAction;
      const pz = pzForTarget(target);
      if (!pz) return;
      const wrapper = document.getElementById(`${target}-wrapper`);
      const rect = wrapper.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      if (action === "in") pz.smoothZoom(cx, cy, 1.5);
      else if (action === "out") pz.smoothZoom(cx, cy, 1 / 1.5);
      else if (action === "reset") {
        if (target === "tree") fitTree(); else resetPanzoom(pz);
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "SELECT" || e.target.tagName === "INPUT")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); advanceDepth(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); retreatDepth(); }
    else if (e.key === "Escape") { hideTooltip(); }
  });

  // Re-layout hot-zones on resize (debounced).
  let resizeT = null;
  window.addEventListener("resize", () => {
    if (resizeT) clearTimeout(resizeT);
    resizeT = setTimeout(() => { renderHotzones(); fitTree(); }, 80);
  });

  // Hide tooltip when interacting outside the tree.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".node-hotzone")) hideTooltip();
  });
}

// --- deep-link from a report row --------------------------------------------

function findSlugForRow(row) {
  const nodes = currentNodes();
  for (const n of nodes) {
    const r = matchingResultRow(n);
    if (r && r.node_id === row.node_id) return n.slug;
  }
  return null;
}

// Address-bar state:
//   family=<outcome>_<tree>   which tree (same keys as the Report view)
//   sub=<root value>          subgroup, for Severity and Virus trees
//   depth=<n>                 levels shown
//   node=<Report node_id>     selected subgroup (as numbered in the Report view)
// A Report "View in tree" link sends only family + node.

function familyFromKey(key) {
  if (!resultsByNode || !Array.isArray(resultsByNode.families)) return null;
  return resultsByNode.families.find(f => f.key === key) || null;
}

// Report rows for virus-level subgroups of a severity tree have no node of
// their own: the virus split is the contour panel. Resolve them to their
// parent subgroup and remember which virus row to highlight.
function parentRow(family, row) {
  const parts = String(row.path || "").split(" > ");
  if (parts.length < 2) return null;
  const parentPath = parts.slice(0, -1).join(" > ");
  return family.rows.find(r => r.path === parentPath) || null;
}

function applyDeepLinkFromParams(params) {
  if (!params) {
    if (typeof window === "undefined" || !window.location) return;
    params = new URLSearchParams(window.location.search);
  }
  const family = familyFromKey(params.get("family"));
  if (!family) return;
  const nodeParam = params.get("node");
  const row = nodeParam !== null ? family.rows.find(r => r.node_id === Number(nodeParam)) : null;

  let root_var, root_value;
  if (["root", "sevvirus", "virsev"].includes(family.stratum)) {
    // Whole-cohort trees: root_value repeats root_var; no label lookup.
    root_var = family.stratum;
    root_value = family.stratum;
  } else {
    root_var = family.stratum === "virus" ? "virus" : "severity";
    if (row) {
      const rootLabel = row.splits && row.splits[family.root_column];
      root_value = rootValueSlugFromLabel(root_var, rootLabel);
    } else {
      root_value = params.get("sub");
    }
    if (!rootValueOptions(root_var).includes(root_value)) root_value = defaultRootValue(root_var);
  }

  state.outcome = family.window;
  state.root_var = root_var;
  state.root_value = root_value;
  state.highlight_virus = null;

  let depth = row ? rowSplitDepth(row, family) : 0;
  const depthParam = params.get("depth");
  if (depthParam !== null && isFinite(Number(depthParam))) depth = Math.max(depth, Number(depthParam));
  state.depth = Math.max(0, Math.min(depth, maxDepth()));

  state.selected_slug = null;
  if (row) {
    state.selected_slug = findSlugForRow(row);
    const virus = row.splits && row.splits.Virus;
    if (!state.selected_slug && family.stratum === "severity" && virus) {
      const parent = parentRow(family, row);
      if (parent) {
        state.selected_slug = findSlugForRow(parent);
        state.highlight_virus = virus;
        state.highlight_node_id = row.node_id;
      }
    }
  }

  syncControls();
}

function syncControls() {
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  document.querySelectorAll('input[name="outcome"]').forEach(r => { r.checked = r.value === state.outcome; });
  document.querySelectorAll('input[name="view"]').forEach(r => {
    r.checked = r.value === (state.interactive ? "explore" : "figure");
  });
  refreshRootValueSelect();
}

// Keep the address bar, the Report tab link, and the cross-tab memory in step
// with what's on screen.
function syncUrl() {
  const params = new URLSearchParams();
  params.set("family", familyKey());
  if (rootVarHasValue(state.root_var)) params.set("sub", state.root_value);
  params.set("depth", String(state.depth));
  const node = currentNodes().find(n => n.slug === state.selected_slug);
  const row = node ? matchingResultRow(node) : null;
  if (state.highlight_virus && state.highlight_node_id !== null) {
    params.set("node", String(state.highlight_node_id));
  } else if (row) {
    params.set("node", String(row.node_id));
  }
  if (!state.interactive) params.set("view", "figure");
  SiteNav.replaceQuery(params);
  SiteNav.remember("family", familyKey());
  SiteNav.remember("trees-query", params.toString());

  const tab = document.getElementById("report-tab");
  if (tab) {
    tab.href = `results_by_node.html?family=${encodeURIComponent(familyKey())}` +
      (params.get("node") ? `&node=${params.get("node")}` : "");
  }
}

// What to open with: the address bar if it names a tree; otherwise the last
// Trees view this tab showed, unless the Report view has since moved to a
// different tree, in which case that tree.
function startupParams() {
  const fromUrl = new URLSearchParams(window.location.search);
  if (fromUrl.get("family")) return fromUrl;
  const lastFamily = SiteNav.recall("family");
  const lastQuery = SiteNav.recall("trees-query");
  if (lastQuery) {
    const q = new URLSearchParams(lastQuery);
    if (!lastFamily || q.get("family") === lastFamily) return q;
  }
  if (lastFamily) return new URLSearchParams({ family: lastFamily });
  return null;
}

// --- init ------------------------------------------------------------------

async function loadJsonOrNull(path) {
  try {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`Failed to load ${path}:`, err.message);
    return null;
  }
}

async function init() {
  try {
    const res = await fetch("tree_topology.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    topology = await res.json();
  } catch (err) {
    console.error("Failed to load tree_topology.json:", err);
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div style="padding:1rem;background:#fee2e2;color:#991b1b;">
        Error loading tree_topology.json: ${err.message}.
        If running locally, serve via <code>python3 -m http.server</code> rather than file://.
      </div>`
    );
    return;
  }

  // Wave 3 artifacts — sibling tracks produce these. Fall back to fixtures so
  // the App layer is testable in isolation before the sibling tracks land.
  coordinates = await loadJsonOrNull("tree_coordinates.json");
  if (!coordinates) {
    coordinates = await loadJsonOrNull("tests/fixtures/tree_coordinates.sample.json");
  }
  // Severity trees use the manuscript's top-down layout; its states replace
  // the inline-forest ones and point at their own image folder.
  const topdown = await loadJsonOrNull("tree_coordinates_topdown.json");
  if (coordinates && topdown && topdown.states) {
    for (const [k, v] of Object.entries(topdown.states)) {
      coordinates.states[k] = { ...v, image_dir: "assets/trees-topdown" };
    }
  }
  contourIndex = await loadJsonOrNull("node_contours_byvirus_index.json");
  resultsByNode = await loadJsonOrNull("results_by_node.json");
  if (!coordinates) coordinates = { states: {} };
  if (!contourIndex) contourIndex = { nodes: {} };
  if (!resultsByNode) resultsByNode = { families: [] };

  const params = startupParams();
  if (params) {
    if (params.get("view") === "figure") state.interactive = false;
    applyDeepLinkFromParams(params);
  }

  wireUp();
  ensurePanzooms();
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// --- exports for tests (no-op in browser; safe to ignore) -----------------
// Node test harness imports this file as a module via dynamic eval; we just
// avoid module syntax to keep the file browser-loadable as a plain script.
if (typeof globalThis !== "undefined") {
  globalThis.__appTest = {
    state,
    setData(data) {
      if (data.topology !== undefined) topology = data.topology;
      if (data.coordinates !== undefined) coordinates = data.coordinates;
      if (data.contourIndex !== undefined) contourIndex = data.contourIndex;
      if (data.resultsByNode !== undefined) resultsByNode = data.resultsByNode;
    },
    familyKey,
    matchingResultRow,
    contourEntryForNode,
    contourByvirusTableHtml,
    currentNodes,
    maxDepth,
    rowSplitDepth,
    rootValueSlugFromLabel,
    findSlugForRow,
    applyDeepLinkFromParams,
  };
}
