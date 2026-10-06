/*
 * site-nav.js
 *
 * Shared by the Trees (app.js) and Report (results_by_node.js) pages:
 *   - one label table for trees, tree levels, and signals, so both pages name
 *     things the same way;
 *   - effect / mortality formatting (percentage points and percent);
 *   - remembering the last tree across tabs (sessionStorage) and keeping the
 *     address bar in step with the page (history.replaceState).
 *
 * Plain script (no module syntax), loaded before app.js / results_by_node.js.
 * Exposes globalThis.SiteNav.
 */
"use strict";

(function (g) {
  // Tree choices, in the order both pages list them.
  const TREE_ORDER = ["severity", "virus", "root", "sevvirus", "virsev"];
  const TREE_LABELS = {
    severity: "Severity",
    virus: "Virus",
    root: "Whole cohort",
    sevvirus: "Severity → virus",
    virsev: "Virus → severity",
  };

  // The data files carry Signal = Benefit / Harm / Inconclusive.
  const SIGNAL_LABELS = { Benefit: "Benefit", Harm: "Harm", Inconclusive: "Uncertain" };

  // Tree-level (split variable) and stratum names, keyed by the spellings the
  // data files use (tree_topology.json outline columns, results_by_node.json
  // split columns). Anything not listed passes through unchanged.
  const LEVEL_LABELS = {
    "Severity (root)": "Severity",
    "Severity (split)": "Severity",
    "Virus (root)": "Virus",
    "Severe Hypoxemia / Shock": "Severe hypoxemia / shock",
    "Hypoxemia / Sepsis": "Hypoxemia / sepsis",
    "Hypoxemia / Sepsis / Shock": "Hypoxemia / sepsis / shock",
    "Lung Comorbidities": "Lung disease",
    "Other Comorbidities": "Other comorbidities",
    "Overall Cohort": "Whole cohort",
    "Mild Pneumonia": "Mild pneumonia",
    "Moderate Pneumonia": "Moderate pneumonia",
    "Severe Pneumonia": "Severe pneumonia",
    "Other Viruses": "Other viruses",
    "No Virus": "No virus",
  };

  function levelLabel(s) {
    return Object.prototype.hasOwnProperty.call(LEVEL_LABELS, s) ? LEVEL_LABELS[s] : s;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  // Effect on the probability scale -> signed percentage points, 1 decimal.
  // "−" is a true minus sign.
  function fmtPp(v) {
    if (!isNum(v)) return "—";
    const tenths = Math.round(Math.abs(v) * 1000);
    if (tenths === 0) return "0.0";
    return (v < 0 ? "−" : "+") + (tenths / 10).toFixed(1);
  }

  function fmtPpRange(lo, hi) {
    if (!isNum(lo) || !isNum(hi)) return "—";
    return fmtPp(lo) + " to " + fmtPp(hi);
  }

  // Probability -> percent, 1 decimal, no sign.
  function fmtPct(v) {
    if (!isNum(v)) return "—";
    return (Math.round(v * 1000) / 10).toFixed(1);
  }

  // --- remembering the last tree across tabs ------------------------------
  const STORE_PREFIX = "aim3-site.";

  function remember(key, value) {
    try { g.sessionStorage.setItem(STORE_PREFIX + key, value); } catch (e) { /* storage off */ }
  }

  function recall(key) {
    try { return g.sessionStorage.getItem(STORE_PREFIX + key); } catch (e) { return null; }
  }

  // Replace the address bar's query string without adding a history entry.
  function replaceQuery(params) {
    try {
      const qs = params.toString();
      const url = g.location.pathname + (qs ? "?" + qs : "") + g.location.hash;
      g.history.replaceState(null, "", url);
    } catch (e) { /* no history API (tests) */ }
  }

  g.SiteNav = {
    TREE_ORDER, TREE_LABELS, SIGNAL_LABELS,
    levelLabel, fmtPp, fmtPpRange, fmtPct,
    remember, recall, replaceQuery,
  };
})(globalThis);
