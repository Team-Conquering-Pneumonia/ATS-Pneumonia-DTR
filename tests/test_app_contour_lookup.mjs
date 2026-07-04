/*
 * test_app_contour_lookup.mjs
 *
 * Regression test for app.js's Interactive-mode by-virus contour lookup
 * (familyKey -> matchingResultRow -> contourEntryForNode). This path reads
 * two separately-built artifacts — results_by_node.json (Report view /
 * per-node table) and node_contours_byvirus_index.json (contour images) —
 * and has previously broken silently when the two diverged:
 *   - results_by_node.json families were renamed from per-stratum keys
 *     ("30day_moderate") to per-root_var keys ("30day_severity"), which
 *     familyKey() didn't know about (every lookup failed for every node).
 *   - results_by_node.json switched to a single global node_id per merged
 *     family, while node_contours_byvirus_index.json still numbers nodes
 *     locally per root_value (and, for "severe", with gaps where small-N
 *     nodes are omitted) — a node_id (or naive position) does not equal the
 *     contour index's local key.
 *   - the merged rows' `depth` field became a Report-view "canonical depth"
 *     aligned across root values, diverging from the tree page's own
 *     depth (path-segment count), breaking non-root node matching.
 *
 * Loads the REAL app.js logic against the REAL site JSON data files (no
 * DOM/init/render — just the pure lookup functions) and checks every node
 * of every severity-rooted tree resolves a real contour entry.
 *
 * Run from site/:  node tests/test_app_contour_lookup.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, "..");

const consoleErrors = [];
global.console = {
  log: (...a) => process.stdout.write(a.join(" ") + "\n"),
  error: (...a) => { consoleErrors.push(a.join(" ")); },
  warn: () => {},
};
// app.js auto-runs init() unless document.readyState is "loading"; keep it
// "loading" and swallow the DOMContentLoaded registration so init() (which
// needs fetch + a full DOM) never actually fires. We drive the pure lookup
// functions directly via globalThis.__appTest instead.
global.document = { readyState: "loading", addEventListener() {} };

const src = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
new Function(src).call(globalThis);
const api = globalThis.__appTest;

const resultsByNode = JSON.parse(fs.readFileSync(path.join(SITE, "results_by_node.json"), "utf8"));
const contourIndex = JSON.parse(fs.readFileSync(path.join(SITE, "node_contours_byvirus_index.json"), "utf8"));
const coordinates = JSON.parse(fs.readFileSync(path.join(SITE, "tree_coordinates.json"), "utf8"));
const topology = JSON.parse(fs.readFileSync(path.join(SITE, "tree_topology.json"), "utf8"));
api.setData({ resultsByNode, contourIndex, coordinates, topology });

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

// --- default state: root node of the default tree (moderate/30day) --------
Object.assign(api.state, { outcome: "30day", root_var: "severity", root_value: "moderate", depth: 0 });
check("familyKey() matches a real family in results_by_node.json",
      !!resultsByNode.families.find(f => f.key === api.familyKey()),
      `familyKey=${api.familyKey()}`);

const rootNodes = api.currentNodes();
const root = rootNodes.find(n => n.is_root) || rootNodes[0];
const rootIdx = api.contourEntryForNode(root);
check("default root node resolves a real contour entry with an image",
      !!(rootIdx && rootIdx.image),
      `idx=${JSON.stringify(rootIdx && { node_id: rootIdx.node_id, image: rootIdx.image })}`);

// --- exhaustive sweep: every node of every severity tree, both outcomes ---
let total = 0, found = 0;
const misses = [];
["30day", "90day"].forEach((outcome) => {
  ["mild", "moderate", "severe"].forEach((rootValue) => {
    Object.assign(api.state, { outcome, root_var: "severity", root_value: rootValue });
    for (let depth = 0; depth <= api.maxDepth(); depth++) {
      api.state.depth = depth;
      api.currentNodes().forEach((node) => {
        total++;
        const idx = api.contourEntryForNode(node);
        if (idx && idx.image) found++;
        else misses.push(`${outcome}/${rootValue}/depth${depth}: ${node.label} (N=${node.N})`);
      });
    }
  });
});
check("every severity-tree node (both outcomes, all depths) resolves a contour entry",
      total > 0 && found === total,
      `found=${found}/${total}` + (misses.length ? `; misses: ${misses.slice(0, 5).join(" | ")}` : ""));

// --- virus-rooted trees: contourIndex has no virus-rooted entries, so this
// path should cleanly return null rather than mis-resolving a severity entry.
Object.assign(api.state, { outcome: "30day", root_var: "virus", root_value: "flu", depth: 0 });
const virusNodes = api.currentNodes();
check("virus-rooted nodes cleanly return null (no by-virus contour data for those trees)",
      virusNodes.length > 0 && virusNodes.every((n) => api.contourEntryForNode(n) === null),
      `n=${virusNodes.length}`);

// --- report ----------------------------------------------------------------
let allPass = true;
for (const r of results) {
  process.stdout.write(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}  (${r.detail})\n`);
  if (!r.pass) allPass = false;
}
process.stdout.write(`\nconsole.error count: ${consoleErrors.length}\n`);
consoleErrors.forEach((e) => process.stdout.write("  ERROR: " + e + "\n"));
process.stdout.write(`\nOVERALL: ${allPass && consoleErrors.length === 0 ? "PASS" : "FAIL"}\n`);
process.exit(allPass && consoleErrors.length === 0 ? 0 : 1);
