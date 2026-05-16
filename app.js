/* ATS Poster Interactive Site — Wave 3 (node-driven interaction model)
 *
 * Tree PNG path:           assets/trees/severity={...}_outcome=30day_depth={d}.png
 * Per-node contour PNG:    assets/node-contours/<slug>.png   (from contour_index.json)
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
  outcome: "30day",
  root_var: "severity",
  root_value: "moderate",
  depth: 0,
  selected_slug: null
};

let topology = null;          // tree_topology.json (depth/columns metadata)
let coordinates = null;       // tree_coordinates.json (node bboxes per state)
let contourIndex = null;      // contour_index.json (per-slug contour metadata)
let treePanzoom = null;
let contourPanzoom = null;

// --- panzoom ---------------------------------------------------------------

const PANZOOM_OPTS = {
  minZoom: 1,
  maxZoom: 8,
  smoothScroll: false,
  bounds: true,
  boundsPadding: 0.1,
  zoomDoubleClickSpeed: 1 // disable panzoom's double-click zoom
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
  return ["mild", "moderate", "severe"];
}

function rootValueLabel(v) {
  const labels = {
    mild: "Mild", moderate: "Moderate", severe: "Severe",
    flu: "Flu", rsv: "RSV", covid: "COVID", others: "Other virus", none: "No virus"
  };
  return labels[v] || v;
}

function defaultRootValue(root_var) {
  return root_var === "virus" ? "flu" : "moderate";
}

function stateKey() {
  return `${treeKey()}_depth=${state.depth}`;
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
    if (imgEl.id === "tree-img") resetPanzoom(treePanzoom);
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
  return (v * 100).toFixed(1) + "%";
}
function fmtAte(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "−";
  return sign + (Math.abs(v) * 100).toFixed(1) + " pp";
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
    <div class="tt-label">${escapeHtml(node.label || node.node_id)}</div>
    <div class="tt-row"><span class="tt-key">N</span><span>${fmtN(node.N)}</span></div>
    <div class="tt-row"><span class="tt-key">% abx</span><span>${fmtPct(node.abx_pct)}</span></div>
    <div class="tt-row"><span class="tt-key">ATE</span><span>${fmtAte(node.ate)}</span></div>
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

// --- selection -------------------------------------------------------------

function selectNode(slug) {
  if (!slug) return;
  state.selected_slug = slug;
  // Update hot-zone selection class without full re-render.
  document.querySelectorAll(".node-hotzone").forEach(el => {
    el.classList.toggle("selected", el.dataset.slug === slug);
  });
  renderContourPanel();
}

function ensureSelectionValid() {
  const nodes = currentNodes();
  const slugs = new Set(nodes.map(n => n.slug));
  if (!state.selected_slug || !slugs.has(state.selected_slug)) {
    state.selected_slug = rootSlugForCurrentState();
  }
}

// --- right panel: single contour ------------------------------------------

function renderContourPanel() {
  const breadcrumb = document.getElementById("contour-breadcrumb");
  const meta = document.getElementById("contour-meta");
  const img = document.getElementById("contour-img");
  if (!breadcrumb || !meta || !img) return;

  const slug = state.selected_slug;
  const node = currentNodes().find(n => n.slug === slug);
  // contour_index.json is keyed by (slug, outcome): 30day → slug; 90day → slug + "__90day".
  const idxKey = slug ? (state.outcome === "30day" ? slug : slug + "__90day") : null;
  const idxEntry = (contourIndex && contourIndex.nodes && idxKey) ? contourIndex.nodes[idxKey] : null;

  if (!slug) {
    breadcrumb.textContent = "";
    meta.innerHTML = "";
    img.style.display = "none";
    return;
  }

  const breadcrumbText = (idxEntry && idxEntry.node_id) || (node && node.node_id) || slug;
  breadcrumb.textContent = breadcrumbText;
  breadcrumb.title = breadcrumbText;

  // Build meta block from contour_index (preferred) + node fallback.
  const N = node ? node.N : null;
  const aggAte = idxEntry ? idxEntry.agg_ate : (node ? node.ate : null);
  const nLeaves = idxEntry ? idxEntry.n_leaves_aggregated : null;
  meta.innerHTML = [
    N != null ? `<span><span class="meta-key">N</span>${fmtN(N)}</span>` : "",
    aggAte != null ? `<span><span class="meta-key">Agg ATE</span>${fmtAte(aggAte)}</span>` : "",
    nLeaves != null ? `<span><span class="meta-key">Leaves aggregated</span>${nLeaves}</span>` : ""
  ].filter(Boolean).join("");

  // Defensive: if missing from index, fall back to the outcome-suffixed filename.
  const src = idxEntry
    ? idxEntry.image
    : `assets/node-contours/${idxKey}.png`;
  setImage(img, "contour-wrapper", src, `Contour for ${breadcrumbText}`);
}

// --- outline + depth display ----------------------------------------------

function renderOutline() {
  const container = document.getElementById("outline-columns");
  container.innerHTML = "";

  const cur = currentColumns();
  const full = fullColumns();
  const pending = full.slice(cur.length);

  cur.forEach((label, idx) => {
    const el = document.createElement("div");
    el.className = "outline-col active";
    el.textContent = label;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.dataset.depth = String(idx);
    el.addEventListener("click", () => setDepth(idx));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDepth(idx); }
    });
    container.appendChild(el);
  });

  if (pending.length > 0) {
    const gap = document.createElement("div");
    gap.className = "outline-gap";
    gap.setAttribute("aria-hidden", "true");
    container.appendChild(gap);

    pending.forEach((label, i) => {
      const targetDepth = cur.length + i;
      const el = document.createElement("div");
      el.className = "outline-col pending";
      el.textContent = label;
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.dataset.depth = String(targetDepth);
      el.addEventListener("click", () => setDepth(targetDepth));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDepth(targetDepth); }
      });
      container.appendChild(el);
    });
  }
}

function renderDepthDisplay() {
  document.getElementById("depth-display").textContent = `${state.depth} / ${maxDepth()}`;
  document.getElementById("depth-minus").disabled = state.depth <= 0;
  document.getElementById("depth-plus").disabled = state.depth >= maxDepth();
}

function renderTreeImage() {
  const key = treeKey();
  const treeSrc = `assets/trees/${key}_depth=${state.depth}.png`;
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
  ensureSelectionValid();
  renderOutline();
  renderDepthDisplay();
  renderTreeImage();
  renderContourPanel();
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
  render();
}

function advanceDepth() { setDepth(state.depth + 1); }
function retreatDepth() { setDepth(state.depth - 1); }

function setRootValue(v) {
  if (!rootValueOptions(state.root_var).includes(v)) return;
  state.root_value = v;
  state.depth = 0;
  state.selected_slug = null;
  render();
}

function setRootVar(rv) {
  if (!["severity", "virus"].includes(rv)) return;
  if (rv === state.root_var) return;
  state.root_var = rv;
  state.root_value = defaultRootValue(rv);
  state.depth = 0;
  state.selected_slug = null;
  refreshRootValueSelect();
  render();
}

function setOutcome(o) {
  if (!["30day", "90day"].includes(o)) return;
  if (o === state.outcome) return;
  state.outcome = o;
  state.depth = 0;
  state.selected_slug = null;
  render();
}

function refreshRootValueSelect() {
  const sel = document.getElementById("root-value");
  if (!sel) return;
  const opts = rootValueOptions(state.root_var);
  sel.innerHTML = "";
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

  document.querySelectorAll('input[name="root_var"]').forEach(r => {
    r.addEventListener("change", (e) => {
      if (e.target.checked) setRootVar(e.target.value);
    });
  });

  document.getElementById("depth-plus").addEventListener("click", advanceDepth);
  document.getElementById("depth-minus").addEventListener("click", retreatDepth);

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
      else if (action === "reset") resetPanzoom(pz);
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
    resizeT = setTimeout(renderHotzones, 80);
  });

  // Hide tooltip when interacting outside the tree.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".node-hotzone")) hideTooltip();
  });
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
  contourIndex = await loadJsonOrNull("contour_index.json");
  if (!contourIndex) {
    contourIndex = await loadJsonOrNull("tests/fixtures/contour_index.sample.json");
  }
  if (!coordinates) coordinates = { states: {} };
  if (!contourIndex) contourIndex = { nodes: {} };

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
