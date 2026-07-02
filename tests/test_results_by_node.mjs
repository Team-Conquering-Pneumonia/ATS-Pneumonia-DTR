/*
 * test_results_by_node.mjs
 *
 * Headless interaction test for the browsable per-node results page (Track C).
 * Loads the REAL results_by_node.js logic and the REAL results_by_node.json,
 * under a minimal DOM + fetch shim, and exercises the three DoD #6 interactions:
 *   1. tree-family selector changes the rows
 *   2. Signal filter narrows the rows
 *   3. a column sort reorders the rows
 * Any thrown error is recorded as a console error (gate = clean console).
 *
 * Run from site/:  node tests/test_results_by_node.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, "..");

const consoleErrors = [];
const consoleWarns = [];

// --- minimal DOM shim ------------------------------------------------------
function makeEl(tag) {
  return {
    tagName: tag, children: [], _text: "", classListSet: new Set(),
    dataset: {}, attrs: {}, style: {}, _value: "",
    classList: {
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      contains(c) { return this._set.has(c); },
      _set: new Set(),
    },
    set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; },
    get textContent() { return this._text; },
    set innerHTML(v) { if (v === "") this.children = []; },
    get innerHTML() { return ""; },
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML() {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this._listeners ||= {})[type] ||= []; this._listeners[type].push(fn); },
    get value() { return this._value; },
    set value(v) { this._value = v; },
    fire(type, ev) { (this._listeners?.[type] || []).forEach((fn) => fn(ev || { target: this })); },
  };
}

const registry = {};
function reg(id) { return (registry[id] ||= makeEl("div")); }

// Pre-create the ids the script touches.
["results-thead", "results-tbody", "family-select", "row-count", "table-foot"]
  .forEach((id) => reg(id));

const radios = ["all", "Benefit", "Harm", "Inconclusive"].map((v) => {
  const r = makeEl("input"); r._value = v; r.attrs.name = "signal"; return r;
});

global.document = {
  readyState: "complete",
  getElementById: (id) => reg(id),
  createElement: (t) => makeEl(t),
  createDocumentFragment: () => makeEl("frag"),
  querySelectorAll: (sel) => (sel.includes('name="signal"') ? radios : []),
  body: makeEl("body"),
  addEventListener() {},
};
global.console = {
  log: (...a) => process.stdout.write(a.join(" ") + "\n"),
  error: (...a) => { consoleErrors.push(a.join(" ")); },
  warn: (...a) => { consoleWarns.push(a.join(" ")); },
};

const dataJson = JSON.parse(fs.readFileSync(path.join(SITE, "results_by_node.json"), "utf8"));
global.fetch = async () => ({ ok: true, status: 200, json: async () => dataJson });

// --- load the real script --------------------------------------------------
const src = fs.readFileSync(path.join(SITE, "results_by_node.js"), "utf8");
// The script defines top-level functions + auto-inits at the bottom. Wrap so we
// can reach the internals (setFamily/setSort + globals) after init runs.
const wrapped = src + "\nglobalThis.__t = { setFamily, setSort, visibleRows, get DATA(){return DATA;}, get currentFamily(){return currentFamily;}, get sortDir(){return sortDir;}, get sortKey(){return sortKey;} };\n";
const mod = new Function(wrapped);

// --- assertions ------------------------------------------------------------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

await (async () => {
  mod.call(globalThis);
  // init() is async (awaits fetch). Give the microtask queue a tick.
  await new Promise((r) => setTimeout(r, 50));
  const t = globalThis.__t;

  check("data loaded: 16 families / 750 nodes",
        t.DATA && t.DATA.families.length === 16 && t.DATA.n_nodes === 750,
        `families=${t.DATA?.families?.length} nodes=${t.DATA?.n_nodes}`);

  // Interaction 1: family selector changes the rows.
  t.setFamily("30day_moderate");
  const modRows = t.visibleRows().length;
  t.setFamily("30day_mild");
  const mildRows = t.visibleRows().length;
  check("Interaction 1 — family selector changes row count",
        modRows !== mildRows && modRows > 0 && mildRows > 0,
        `30day_moderate=${modRows} rows, 30day_mild=${mildRows} rows`);

  // Interaction 2: Signal filter narrows the rows.
  t.setFamily("30day_moderate");
  const allRows = t.visibleRows().length;
  radios.find((r) => r._value === "Benefit").fire("change", { target: { value: "Benefit" } });
  const benRows = t.visibleRows().length;
  const allBenefit = t.visibleRows().every((r) => r.signal === "Benefit");
  check("Interaction 2 — Signal=Benefit narrows rows and all are Benefit",
        benRows < allRows && benRows > 0 && allBenefit,
        `all=${allRows}, Benefit=${benRows}, every-row-Benefit=${allBenefit}`);
  // reset filter
  radios.find((r) => r._value === "all").fire("change", { target: { value: "all" } });

  // Interaction 3: column sort reorders rows. Sort by ATE asc then desc.
  t.setSort("ate");
  const asc = t.visibleRows().map((r) => r.ate).filter((v) => v != null);
  const ascSorted = asc.every((v, i) => i === 0 || asc[i - 1] <= v);
  t.setSort("ate"); // toggle to desc
  const desc = t.visibleRows().map((r) => r.ate).filter((v) => v != null);
  const descSorted = desc.every((v, i) => i === 0 || desc[i - 1] >= v);
  check("Interaction 3 — ATE column sort reorders (asc then desc)",
        ascSorted && descSorted && asc.length > 1 &&
          JSON.stringify(asc) !== JSON.stringify(desc),
        `asc-monotonic=${ascSorted}, desc-monotonic=${descSorted}, n=${asc.length}`);

  // Suppression integrity: no fully-suppressed node leaks a numeric estimate.
  let leaks = 0;
  for (const fam of t.DATA.families) {
    for (const r of fam.rows) {
      if (r.suppressed && (r.ate != null || r.p_abx != null || r.p_noabx != null || r.ci !== "")) leaks++;
      if (r.suppressed && r.n !== "<20") leaks++;
    }
  }
  check("Suppression — no suppressed node leaks a number", leaks === 0, `leaks=${leaks}`);
})();

// --- report ----------------------------------------------------------------
let allPass = true;
for (const r of results) {
  process.stdout.write(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}  (${r.detail})\n`);
  if (!r.pass) allPass = false;
}
process.stdout.write(`\nconsole.error count: ${consoleErrors.length}\n`);
consoleErrors.forEach((e) => process.stdout.write("  ERROR: " + e + "\n"));
process.stdout.write(`console.warn count: ${consoleWarns.length}\n`);
consoleWarns.forEach((e) => process.stdout.write("  WARN: " + e + "\n"));
process.stdout.write(`\nOVERALL: ${allPass && consoleErrors.length === 0 ? "PASS" : "FAIL"}\n`);
process.exit(allPass && consoleErrors.length === 0 ? 0 : 1);
