/* Propensity view for the Trees tab.
 *
 * Data: ps_overlap.json (code/R/build_site_ps_overlap.R in the analysis repo): every
 * node of the propensity-score trees with its status, and for graded nodes the
 * statistics behind the four overlap criteria, OVL, BC and a density-panel image.
 * The grade is computed here from those statistics, so the cutoffs can be changed
 * on the page; at the defaults it must equal r_grade (code/R/ps_overlap_grades.R).
 *
 * app.js owns the page state and calls in:
 *   PsView.load()                       once, before the first render
 *   PsView.treeFor(state)               PS tree key for the current tree, or null
 *   PsView.renderChips(layer, nodes, scale, state)   grade chips over the tree image
 *   PsView.renderDetail(node, state)    right panel for the selected node
 *   PsView.tooltipRows(node, state)     extra tooltip rows in this view
 *   PsView.onChange(fn)                 called when the cutoffs change
 */

"use strict";

const PsView = (() => {
  let data = null;
  let index = null;     // "<tree>|<n>|<depth>" -> node (virus rows excluded)
  let children = null;  // "<tree>|<node_id>" -> virus-row children
  let T = null;         // cutoffs in use
  let listener = null;
  const STORE_KEY = "ps-cutoffs";

  const FIELDS = [
    ["c3_substantial", "C3 substantial: % treated above untreated 99th percentile, at least", 0.5],
    ["c3_small", "C3 small tail: ... at least", 0.5],
    ["c2_many", "C2 many: % treated with PS > 0.95, at least", 1],
    ["c2_some", "C2 some: ... at least", 1],
    ["c4_ratio", "C4 rare: untreated share above 0.95 below this x treated share", 0.05],
    ["c1_shift", "C1 shifted: gap between the arms' median PS, at least", 0.01],
  ];
  const GRADE_LABEL = { good: "Good", moderate: "Moderate", poor: "Poor", na: "Not assessed" };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f1 = (v) => (v == null ? "-" : `${v.toFixed(1)}%`);
  const f2 = (v) => (v == null ? "-" : v.toFixed(2));
  const f3 = (v) => (v == null ? "-" : v.toFixed(3));
  const fN = (v) => (v == null ? "-" : Number(v).toLocaleString("en-US"));

  function loadCutoffs() {
    try {
      return { ...data.defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
    } catch (err) {
      return { ...data.defaults };
    }
  }
  function saveCutoffs() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(T)); } catch (err) { /* private window */ }
  }

  async function load() {
    try {
      const res = await fetch("ps_overlap.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      console.warn("Failed to load ps_overlap.json:", err.message);
      data = null;
      return false;
    }
    index = {};
    children = {};
    for (const n of data.nodes) {
      if (n.virus_row) {
        const k = `${n.tree}|${n.parent_id}`;
        (children[k] = children[k] || []).push(n);
      } else {
        index[`${n.tree}|${n.n}|${n.depth}`] = n;
      }
    }
    T = loadCutoffs();
    const off = data.nodes.filter((n) => n.status === "graded" && classify(n, data.defaults).grade !== n.r_grade);
    if (off.length) console.error("ps.js grade rule disagrees with ps_overlap_grades.R on", off.map((n) => n.node_id));
    renderCutoffs();
    return true;
  }

  // Same rule as code/R/ps_overlap_grades.R. Returns the answers, the grade and
  // the ids of the rule-figure elements on the path.
  function classify(n, t) {
    const C1 = Math.abs(n.med_abx - n.med_noabx) >= t.c1_shift ? "shifted" : "close";
    const C2 = n.gt95_abx >= t.c2_many ? "many" : n.gt95_abx >= t.c2_some ? "some" : "few";
    const C3 = n.tail_p99 >= t.c3_substantial ? "substantial" : n.tail_p99 >= t.c3_small ? "small tail" : "none";
    const C4 = C2 !== "many" ? "n/a" : n.gt95_noabx < t.c4_ratio * n.gt95_abx ? "rare or absent" : "present";
    const p = ["q1"];
    let grade;
    if (C3 === "substantial") { p.push("e1yes", "oP1"); grade = "poor"; }
    else {
      p.push("e1no", "q2");
      if (C2 === "many") {
        p.push("e2many", "q3");
        if (C4 === "rare or absent") { p.push("e3yes", "oP3"); grade = "poor"; }
        else { p.push("e3no", "oM3"); grade = "moderate"; }
      } else if (C2 === "some") { p.push("e2some", "oM2"); grade = "moderate"; }
      else {
        p.push("e2few", "q4");
        if (C1 === "shifted") { p.push("e4no", "oM4"); grade = "moderate"; }
        else {
          p.push("e4yes", "q5");
          if (C3 === "none") { p.push("e5yes", "oG"); grade = "good"; }
          else { p.push("e5no", "oM5"); grade = "moderate"; }
        }
      }
    }
    return { C1, C2, C3, C4, grade, path: p };
  }

  // { key: good|moderate|poor|na, label } for a PS node, or null for no chip.
  function gradeOf(n) {
    if (!n) return null;
    if (n.status === "graded") { const g = classify(n, T).grade; return { key: g, label: GRADE_LABEL[g] }; }
    if (n.status === "no_untreated") return { key: "poor", label: "Poor", note: "no untreated" };
    if (n.status === "not_assessed") return { key: "na", label: GRADE_LABEL.na };
    return null;
  }

  function treeFor(state) {
    if (!data) return null;
    if (state.root_var === "severity" || state.root_var === "virus") return state.root_value;
    if (state.root_var === "root") return "root";
    return null;
  }

  function psNode(siteNode, state) {
    const tree = treeFor(state);
    if (!tree || !siteNode) return null;
    const depth = String(siteNode.node_id || "").split(" > ").length - 1;
    return index[`${tree}|${siteNode.N}|${depth}`] || null;
  }

  // --- chips over the tree image ----------------------------------------------

  function chipHtml(g, extraClass) {
    if (!g) return "";
    const title = g.note ? `${g.label} (${g.note})` : g.label;
    return `<span class="ps-chip ps-chip--${g.key}${extraClass ? " " + extraClass : ""}" title="${esc(title)}">${esc(g.label)}</span>`;
  }

  function renderChips(layer, nodes, scale, state) {
    if (!layer) return;
    layer.innerHTML = "";
    if (!data || !treeFor(state)) return;
    const fontPx = Math.max(7, 12 * scale);
    for (const node of nodes) {
      const bb = node.bbox_px || {};
      if ([bb.x, bb.y, bb.w, bb.h].some((v) => typeof v !== "number" || !isFinite(v))) continue;
      const g = gradeOf(psNode(node, state));
      if (!g) continue;
      const el = document.createElement("div");
      el.className = "ps-chip-anchor";
      // Density trees reserve a chip slot (ps_chip); otherwise sit under the node.
      const slot = node.ps_chip;
      el.style.left = (slot ? slot.x : bb.x + bb.w / 2) * scale + "px";
      el.style.top = (slot ? slot.y : bb.y + bb.h + 3) * scale + "px";
      // In a chip slot the chip scales with the image, like the text around it.
      el.style.fontSize = (slot ? 10 * scale : fontPx) + "px";
      el.dataset.slug = node.slug;
      el.innerHTML = chipHtml(g);
      layer.appendChild(el);
    }
  }

  // --- right panel --------------------------------------------------------------

  const RULE_SVG = `
<svg class="ps-rule" viewBox="0 0 600 592" xmlns="http://www.w3.org/2000/svg" text-anchor="middle" role="img" aria-label="Grade rule with this subgroup's path">
  <defs>
    <marker id="ps-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#9ca3af"/></marker>
    <marker id="ps-arrOn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#1e40af"/></marker>
  </defs>
  <g class="q" data-id="q1"><rect x="150" y="8" width="260" height="62" rx="8"/>
    <text x="280" y="28"><tspan class="c">C3</tspan> Treated above the untreated</text>
    <text x="280" y="46">99th percentile: at least <tspan data-t="c3_substantial"></tspan>%?</text>
    <text class="val" x="280" y="64" data-v="q1"></text></g>
  <path class="e" data-id="e1yes" d="M410,39 L448,39"/><text class="lab" x="429" y="32">yes</text>
  <g class="o poor" data-id="oP1"><rect x="450" y="25" width="140" height="28" rx="14"/><text x="520" y="44">Poor</text></g>
  <path class="e" data-id="e1no" d="M280,70 L280,106"/><text class="lab" x="292" y="92">no</text>

  <g class="q" data-id="q2"><rect x="150" y="108" width="260" height="62" rx="8"/>
    <text x="280" y="128"><tspan class="c">C2</tspan> Treated with PS above 0.95</text>
    <text x="280" y="146">(many &#8805; <tspan data-t="c2_many"></tspan>%, some &#8805; <tspan data-t="c2_some"></tspan>%)</text>
    <text class="val" x="280" y="164" data-v="q2"></text></g>
  <path class="e" data-id="e2some" d="M410,139 L448,139"/><text class="lab" x="429" y="132">some</text>
  <g class="o moderate" data-id="oM2"><rect x="450" y="125" width="140" height="28" rx="14"/><text x="520" y="144">Moderate</text></g>
  <path class="e" data-id="e2many" d="M150,139 L70,139 L70,466"/><text class="lab" x="110" y="132">many</text>
  <path class="e" data-id="e2few" d="M280,170 L280,206"/><text class="lab" x="294" y="192">few</text>

  <g class="q" data-id="q4"><rect x="150" y="208" width="260" height="62" rx="8"/>
    <text x="280" y="228"><tspan class="c">C1</tspan> Median PS of the two arms</text>
    <text x="280" y="246">differ by less than <tspan data-t="c1_shift"></tspan>?</text>
    <text class="val" x="280" y="264" data-v="q4"></text></g>
  <path class="e" data-id="e4no" d="M410,239 L448,239"/><text class="lab" x="429" y="232">no</text>
  <g class="o moderate" data-id="oM4"><rect x="450" y="225" width="140" height="28" rx="14"/><text x="520" y="244">Moderate</text></g>
  <path class="e" data-id="e4yes" d="M280,270 L280,306"/><text class="lab" x="292" y="292">yes</text>

  <g class="q" data-id="q5"><rect x="150" y="308" width="260" height="62" rx="8"/>
    <text x="280" y="328"><tspan class="c">C3</tspan> Treated above the untreated</text>
    <text x="280" y="346">99th percentile: under <tspan data-t="c3_small"></tspan>%?</text>
    <text class="val" x="280" y="364" data-v="q5"></text></g>
  <path class="e" data-id="e5no" d="M410,339 L448,339"/><text class="lab" x="429" y="332">no</text>
  <g class="o moderate" data-id="oM5"><rect x="450" y="325" width="140" height="28" rx="14"/><text x="520" y="344">Moderate</text></g>
  <path class="e" data-id="e5yes" d="M280,370 L280,404"/><text class="lab" x="292" y="390">yes</text>
  <g class="o good" data-id="oG"><rect x="210" y="406" width="140" height="28" rx="14"/><text x="280" y="425">Good</text></g>

  <g class="q" data-id="q3"><rect x="10" y="468" width="280" height="62" rx="8"/>
    <text x="150" y="488"><tspan class="c">C4</tspan> Untreated with PS above 0.95</text>
    <text x="150" y="506">less than <tspan data-t="c4_ratio"></tspan> x the treated share?</text>
    <text class="val" x="150" y="524" data-v="q3"></text></g>
  <path class="e" data-id="e3yes" d="M290,499 L448,499"/><text class="lab" x="370" y="492">yes</text>
  <g class="o poor" data-id="oP3"><rect x="450" y="485" width="140" height="28" rx="14"/><text x="520" y="504">Poor</text></g>
  <path class="e" data-id="e3no" d="M150,530 L150,556"/><text class="lab" x="162" y="548">no</text>
  <g class="o moderate" data-id="oM3"><rect x="80" y="558" width="140" height="28" rx="14"/><text x="150" y="577">Moderate</text></g>
</svg>`;

  function ruleHtml(n) {
    const r = classify(n, T);
    const on = new Set(r.path);
    const wrap = document.createElement("div");
    wrap.innerHTML = RULE_SVG;
    const svg = wrap.firstElementChild;
    svg.querySelectorAll("[data-id]").forEach((el) => el.classList.toggle("on", on.has(el.dataset.id)));
    svg.querySelectorAll("[data-t]").forEach((el) => { el.textContent = T[el.dataset.t]; });
    const gap = Math.abs(n.med_abx - n.med_noabx);
    const val = { q1: `this subgroup: ${f1(n.tail_p99)}`, q2: `this subgroup: ${f1(n.gt95_abx)}`,
      q3: `${f1(n.gt95_noabx)} vs ${f1(n.gt95_abx)}`, q4: `this subgroup: ${f2(gap)}`, q5: `this subgroup: ${f1(n.tail_p99)}` };
    svg.querySelectorAll("[data-v]").forEach((el) => {
      el.textContent = on.has(el.dataset.v) ? val[el.dataset.v] : "";
    });
    return { html: svg.outerHTML, r };
  }

  function metricsHtml(n, r) {
    return `
      <table class="data-table ps-metrics" aria-label="Overlap statistics for the selected subgroup">
        <thead><tr><th>Criterion</th><th>Value</th><th>Answer</th></tr></thead>
        <tbody>
          <tr><td>C1 median PS, treated vs untreated</td><td>${f2(n.med_abx)} vs ${f2(n.med_noabx)}</td><td>${esc(r.C1)}</td></tr>
          <tr><td>C2 treated with PS &gt; 0.95</td><td>${f1(n.gt95_abx)}</td><td>${esc(r.C2)}</td></tr>
          <tr><td>C3 treated above untreated 99th percentile</td><td>${f1(n.tail_p99)}</td><td>${esc(r.C3)}</td></tr>
          <tr><td>C4 untreated with PS &gt; 0.95</td><td>${f1(n.gt95_noabx)}</td><td>${esc(r.C4)}</td></tr>
          <tr><td>OVL, shared density area</td><td colspan="2">${f3(n.ovl[0])} (${f3(n.ovl[1])} to ${f3(n.ovl[2])})</td></tr>
          <tr><td>BC, Bhattacharyya coefficient</td><td colspan="2">${f3(n.bc[0])} (${f3(n.bc[1])} to ${f3(n.bc[2])})</td></tr>
        </tbody>
      </table>
      <p class="table-foot">OVL and BC: posterior median (95% interval); shown beside the grade, not used in it.</p>`;
  }

  function byVirusHtml(n) {
    const kids = children[`${n.tree}|${n.node_id}`];
    if (!kids || !kids.length) return "";
    const rows = kids.map((k) => `
      <tr><td>${esc(k.title)}</td><td>${k.n < 20 ? "&lt;20" : fN(k.n)}</td><td>${chipHtml(gradeOf(k), "ps-chip--inline") || "-"}</td></tr>`).join("");
    return `
      <table class="data-table ps-byvirus" aria-label="Overlap grade by virus">
        <thead><tr><th>Virus</th><th>N</th><th>Grade</th></tr></thead><tbody>${rows}</tbody>
      </table>`;
  }

  // variant "rule": the Propensity view's panel (grade rule, statistics; the tree
  // already shows the densities). "density": the Outcomes view's alternative
  // (grade and the subgroup's density plot).
  function renderDetail(el, siteNode, state, variant = "rule") {
    if (!el) return;
    if (!data) { el.innerHTML = `<p class="ps-msg">Propensity data could not be loaded.</p>`; return; }
    if (!treeFor(state)) {
      el.innerHTML = `<p class="ps-msg">The propensity view is available for the Severity, Virus and Whole cohort trees.</p>`;
      return;
    }
    const n = psNode(siteNode, state);
    if (!n) { el.innerHTML = `<p class="ps-msg">No propensity data for this subgroup.</p>`; return; }
    const g = gradeOf(n);
    const head = `<div class="ps-head">${chipHtml(g, "ps-chip--large")}
      <span class="ps-counts">N ${fN(n.n)} &middot; ${n.pct_abx.toFixed(0)}% given antibiotics</span></div>`;
    if (n.status !== "graded") {
      const why = {
        no_untreated: "No patient in this subgroup went without antibiotics, so every treated patient is outside the untreated range (C3 = 100%): poor.",
        not_assessed: "One arm has fewer than 20 patients, so its propensity scores were not exported and the subgroup is not graded.",
        small: "Fewer than 20 patients.",
      }[n.status];
      el.innerHTML = `${head}<p class="ps-msg">${esc(why)}</p>${byVirusHtml(n)}`;
      return;
    }
    const arms = `<div class="ps-arms"><span class="ps-abx">${fN(n.n_abx)} antibiotics</span> / <span class="ps-noabx">${fN(n.n_noabx)} no antibiotics</span></div>`;
    if (variant === "density") {
      el.innerHTML = `${head}${arms}
        <img class="ps-panel-img" src="${esc(n.img)}" alt="Propensity score densities, antibiotics vs no antibiotics" />
        <p class="table-foot">Propensity score, P(antibiotics | covariates). OVL ${f3(n.ovl[0])}, BC ${f3(n.bc[0])}. Grade: proposed rule; see the Propensity view.</p>`;
      return;
    }
    const { html, r } = ruleHtml(n);
    el.innerHTML = `${head}${arms}
      ${html}
      ${metricsHtml(n, r)}
      ${byVirusHtml(n)}`;
  }

  function tooltipRows(siteNode, state) {
    const n = psNode(siteNode, state);
    if (!n) return "";
    const g = gradeOf(n);
    const rows = [`<div class="tt-row"><span class="tt-key">Overlap grade</span><span>${g ? esc(g.label + (g.note ? ` (${g.note})` : "")) : "-"}</span></div>`];
    if (n.status === "graded") {
      rows.push(`<div class="tt-row"><span class="tt-key">OVL</span><span>${f3(n.ovl[0])}</span></div>`);
      rows.push(`<div class="tt-row"><span class="tt-key">BC</span><span>${f3(n.bc[0])}</span></div>`);
    }
    return rows.join("");
  }

  // --- cutoffs bar ----------------------------------------------------------------

  function tally() {
    const k = { good: 0, moderate: 0, poor: 0 };
    data.nodes.forEach((n) => { if (n.status === "graded") k[classify(n, T).grade] += 1; });
    return k;
  }

  function renderCutoffs() {
    const fields = document.getElementById("ps-cutoff-fields");
    if (!fields || !data) return;
    fields.innerHTML = FIELDS.map(([k, l, s]) =>
      `<label>${esc(l)} <input type="number" step="${s}" data-k="${k}" value="${T[k]}"></label>`).join("");
    renderTally();
  }

  function renderTally() {
    const el = document.getElementById("ps-cutoff-tally");
    if (!el || !data) return;
    const k = tally();
    const changed = Object.keys(data.defaults).some((key) => T[key] !== data.defaults[key]);
    el.textContent = `${changed ? "custom" : "defaults"}; all graded subgroups: good ${k.good}, moderate ${k.moderate}, poor ${k.poor}`;
  }

  function wireCutoffs() {
    const fields = document.getElementById("ps-cutoff-fields");
    const reset = document.getElementById("ps-cutoff-reset");
    if (fields) fields.addEventListener("change", (e) => {
      const k = e.target.dataset.k;
      const v = Number(e.target.value);
      if (!k || !Number.isFinite(v)) return;
      T = { ...T, [k]: v };
      saveCutoffs();
      renderTally();
      if (listener) listener();
    });
    if (reset) reset.addEventListener("click", () => {
      T = { ...data.defaults };
      try { localStorage.removeItem(STORE_KEY); } catch (err) { /* private window */ }
      renderCutoffs();
      if (listener) listener();
    });
  }

  return {
    load: async () => { const ok = await load(); wireCutoffs(); return ok; },
    treeFor, renderChips, renderDetail, tooltipRows,
    onChange: (fn) => { listener = fn; },
    _test: { classify, gradeOf, psNode },
  };
})();
