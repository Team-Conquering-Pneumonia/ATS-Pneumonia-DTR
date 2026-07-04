/*
 * viz-info.js
 *
 * Single source of the plain-language visualization descriptions used in two
 * places:
 *   1. The "Info" popover buttons beside each visual (initInfoButtons()).
 *   2. The About page's "Visualizations" section (about.js reads VIZ_INFO).
 *
 * Each entry: { title, summary (1-2 sentences, shown in the popover),
 *               detail (array of HTML paragraph strings, shown on About) }.
 *
 * Voice: clinical, external audience (/voice-style). First-draft copy — the
 * About page carries the "written with AI assistance, pending author review"
 * caveat while this is refined.
 *
 * Plain script (no module syntax) so it loads via file:// or a static server,
 * matching app.js's convention. Exposes window.VIZ_INFO + window.initInfoButtons.
 */
"use strict";

window.VIZ_INFO = {
  tree: {
    title: "Decision tree",
    summary:
      "Each tree sorts patients into clinically defined subgroups — by pneumonia " +
      "severity, hypoxemia or shock, comorbidities, and viral test result — and " +
      "shows the estimated effect of empiric antibiotics on mortality within each " +
      "subgroup.",
    detail: [
      "Each tree divides the cohort into clinically meaningful subgroups using a " +
      "small set of factors chosen before the analysis: pneumonia severity, severe " +
      "hypoxemia or shock, hypoxemia or sepsis, lung disease, other comorbidities, " +
      "and viral test result. Use the depth control to reveal successive levels of " +
      "the tree.",
      "Inside each node, two bars show the estimated probability of death <em>with</em> " +
      "antibiotics (orange) and <em>without</em> antibiotics (blue), along with the " +
      "average treatment effect (ATE) — the difference in mortality between the two — " +
      "and its 95% credible interval.",
      "Nodes are colored by that interval: green where antibiotics are a credible " +
      "benefit (interval entirely below zero), red where credibly harmful (entirely " +
      "above zero), and grey where the interval crosses zero and the direction is " +
      "uncertain.",
    ],
  },
  contour: {
    title: "Per-virus posterior contours",
    summary:
      "For the selected subgroup, each outline is the 95% posterior region comparing " +
      "predicted mortality with versus without antibiotics, drawn separately for each " +
      "viral test result. Points below the diagonal favor antibiotics.",
    detail: [
      "When you select a node in the tree, this panel shows the joint posterior for " +
      "that subgroup: predicted mortality without antibiotics on the horizontal axis " +
      "versus predicted mortality with antibiotics on the vertical axis. Each colored " +
      "outline is the 95% posterior region for one viral test group.",
      "The dashed diagonal marks equal mortality under both choices. An outline below " +
      "the diagonal favors antibiotics; above it favors withholding antibiotics.",
      "The benefit-or-harm call on the node and in the tables comes from the ATE " +
      "credible interval, which summarizes the treatment effect in one dimension. A " +
      "two-dimensional region is more permissive, so an outline can cross the diagonal " +
      "even when the ATE interval stays on one side; when they differ, use the ATE " +
      "interval. Some deep, small severe subgroups omit viral groups with fewer than " +
      "20 patients.",
    ],
  },
  table1: {
    title: "Table 1 — Cohort characteristics",
    summary:
      "Baseline characteristics of the study cohort of emergency-department pneumonia " +
      "encounters across 120 VA medical centers, overall and by antibiotic treatment.",
    detail: [
      "Table 1 describes the study population: emergency-department encounters with an " +
      "initial diagnosis of pneumonia and positive chest imaging across 120 U.S. " +
      "Veterans Affairs medical centers, 2022–2024. Characteristics are shown overall " +
      "and by whether empiric antibiotics were given in the first 24 hours.",
    ],
  },
  table2: {
    title: "Table 2 — Population strategy comparison",
    summary:
      "Estimated population mortality and antibiotic use under five treatment " +
      "strategies, for 30- and 90-day mortality.",
    detail: [
      "Table 2 compares five population strategies for empiric antibiotics: give to " +
      "all, give to none, follow the ATS 2025 guideline, and two individualized " +
      "strategies that give antibiotics only where the model estimates benefit. For " +
      "each strategy and mortality window it reports the estimated population " +
      "mortality with a 95% credible interval and the fraction of patients who would " +
      "receive antibiotics.",
    ],
  },
  report: {
    title: "Report view",
    summary:
      "A sortable, filterable table of every subgroup (node) in the selected tree, " +
      "with observed and model-estimated mortality, antibiotic use, and the antibiotic " +
      "treatment effect (ATE) with its 95% credible interval.",
    detail: [
      "The Report view lists every subgroup in a selected tree as a row, so you can " +
      "sort and filter across the whole tree. Each row carries the full covariate path " +
      "to the subgroup, its size, the observed antibiotic use and mortality, the " +
      "model-estimated mortality with and without antibiotics, and the ATE with its " +
      "95% credible interval.",
      "The Signal column flags whether antibiotics are a credible benefit, credible " +
      "harm, or inconclusive for each subgroup. Cells showing “&lt;20” are suppressed " +
      "under VA small-cell rules.",
    ],
  },
};

// --- Info popover buttons --------------------------------------------------
// Wires every element with [data-info="<key>"] to show VIZ_INFO[key] in a
// popover: hover on desktop (pointer: fine), tap/click toggle everywhere
// (touch fallback). Escape and outside-click close it.
window.initInfoButtons = function initInfoButtons() {
  const info = window.VIZ_INFO || {};
  const buttons = Array.from(document.querySelectorAll("[data-info]"));
  let openPopover = null;

  function closeOpen() {
    if (openPopover) {
      openPopover.el.classList.remove("visible");
      openPopover.btn.setAttribute("aria-expanded", "false");
      openPopover = null;
    }
  }

  buttons.forEach((btn) => {
    const key = btn.getAttribute("data-info");
    const entry = info[key];
    if (!entry) return;

    const pop = document.createElement("div");
    pop.className = "info-popover";
    pop.setAttribute("role", "tooltip");
    pop.innerHTML =
      '<div class="info-pop-title"></div><div class="info-pop-body"></div>';
    pop.querySelector(".info-pop-title").textContent = entry.title;
    pop.querySelector(".info-pop-body").textContent = entry.summary;

    // Anchor the popover next to the button.
    const wrap = document.createElement("span");
    wrap.className = "info-anchor";
    btn.parentNode.insertBefore(wrap, btn);
    wrap.appendChild(btn);
    wrap.appendChild(pop);

    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "About this visualization: " + entry.title);

    function show() {
      if (openPopover && openPopover.el !== pop) closeOpen();
      wrap.classList.remove("flip-right");
      pop.classList.add("visible");
      btn.setAttribute("aria-expanded", "true");
      openPopover = { el: pop, btn };
      // Flip to the right edge if the popover would overflow the viewport.
      const r = pop.getBoundingClientRect();
      if (r.right > document.documentElement.clientWidth - 4) {
        wrap.classList.add("flip-right");
      }
    }
    function hide() {
      pop.classList.remove("visible");
      btn.setAttribute("aria-expanded", "false");
      if (openPopover && openPopover.el === pop) openPopover = null;
    }
    function toggle() {
      if (pop.classList.contains("visible")) hide();
      else show();
    }

    // Click / tap toggles (primary, works on touch + desktop).
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggle();
    });
    // Desktop hover convenience (only for fine pointers).
    if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
      wrap.addEventListener("mouseenter", show);
      wrap.addEventListener("mouseleave", hide);
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".info-anchor")) closeOpen();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOpen();
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", window.initInfoButtons);
} else {
  window.initInfoButtons();
}
