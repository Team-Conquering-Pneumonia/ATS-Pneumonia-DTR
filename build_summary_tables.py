#!/usr/bin/env python3
"""
build_summary_tables.py

Rewrite the Table 1 and Table 2 blocks of site/tables.html in place from the
promoted VINCI export. Companion to build_results_by_node_data.py, and follows
the same rule: the run is whatever results/current points at, resolved
dynamically — never a hardcoded run id.

WHY THIS EXISTS
---------------
Until 2026-07-25 the site's Table 1 <tbody> was pasted by hand from a fragment
emitted by code/R/pipeline/table1_placeholder_barb.R, which walks the row roster
in table1_variable_data.R. That roster carries values TRANSCRIBED from Jian's
2026-06 V3 docx against the superseded N = 134,916 cohort, and its own header
says those values "must never be the source of a manuscript number". Because the
paste was manual and tables.html carries no run identifier, the site silently
kept serving the old cohort after the corrected 130,265 cohort landed — a
provenance audit that grepped for a stale run string could not see it.

This script removes the transcription from the path entirely. Numbers come from
the export; the roster's job (row order, labels, section grouping, stage tags)
is now also served by the export, which carries section/stage/label/display_stat
columns because 01_table1_export.R pulls the roster itself.

Sources (all under results/current/):
  * table1_full_export.xlsx  sheet "Table 1 full export"  <- 01_table1_export.R
  * cohort_report.xlsx       sheet "Manuscript numbers"   <- 02_cohort_report.R
  * ../../output/tables/table2_regime_comparison.csv      <- render_table2_regime_comparison.R (T3.4)

Run:
    python3 site/build_summary_tables.py [--check]

--check exits non-zero without writing if tables.html is already current; use it
to detect drift in CI. Self-checks always run (see verify()).
"""

import argparse
import csv
import html
import os
import re
import sys
import zipfile

SITE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(SITE_DIR, ".."))
DATA_ROOT = os.environ.get("AIM3_DATA_ROOT", PROJECT_ROOT)
RESULTS_CURRENT = os.path.join(DATA_ROOT, "results", "current")
TABLE1_XLSX = os.path.join(RESULTS_CURRENT, "table1_full_export.xlsx")
COHORT_XLSX = os.path.join(RESULTS_CURRENT, "cohort_report.xlsx")
TABLE2_CSV = os.path.join(DATA_ROOT, "output", "tables", "table2_regime_comparison.csv")
TABLES_HTML = os.path.join(SITE_DIR, "tables.html")

# (Descriptive-reframe: the ATS/IDSA/individualized recommendation regimes were
# gated off the production export, so Table 2 no longer surfaces the IDSA caveat.
# The former D-PIR-02 caveat mirror + its figure_rule_tree.R drift guard were
# removed with the footnote; figure_rule_tree.R keeps the constant for its own
# exclude-but-keep figure path.)


def run_label():
    return os.path.basename(os.path.realpath(RESULTS_CURRENT).rstrip(os.sep)) or "run-unknown"


# --- xlsx reading ----------------------------------------------------------
# The R writer emits a drawing relationship whose part is absent; openpyxl hard-
# fails on it. Strip drawings into a temp copy rather than patching the export.
def load_sheet(path, sheet):
    import openpyxl

    tmp = path + ".nodrawing.xlsx"
    zin = zipfile.ZipFile(path)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if "/drawings/" in item.filename:
                continue
            data = zin.read(item.filename)
            if item.filename.endswith(".rels"):
                data = re.sub(
                    rb'<Relationship[^>]*Type="[^"]*/drawing"[^>]*/>', b"", data
                )
            zout.writestr(item, data)
    zin.close()
    try:
        wb = openpyxl.load_workbook(tmp, data_only=True)
        rows = [list(r) for r in wb[sheet].iter_rows(values_only=True)]
    finally:
        os.unlink(tmp)
    return rows


def demojibake(s):
    """The export's strings are UTF-8 bytes that were decoded as cp1252 upstream.

    Round-tripping through cp1252 restores them ('Sepsis â€” clinical' -> 'Sepsis
    — clinical'). Strings that never took that trip fail the encode and pass
    through untouched.
    """
    if not isinstance(s, str):
        return s
    try:
        return s.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


# --- label handling (ported from table1_placeholder_barb.R) ----------------
# PI-facing site strips analysis-detail annotations; the docx keeps the full
# label. Legit annotations — (SD), (years), (RSV), (categorical) — carry none of
# these markers and pass through.
JARGON = r"SAP|BART|composite|variable|covariate|tree|REMOVED|code|_"


def sanitize_label(label):
    label = re.sub(r"\s*\[[^\]]*(?:%s)[^\]]*\]" % JARGON, "", label, flags=re.I)
    label = re.sub(r"\s*\([^)]*(?:%s)[^)]*\)" % JARGON, "", label, flags=re.I)
    return label.strip()


STAGE_CLASS = {"S2": "stage-s2", "S1": "stage-s1", "REM": "stage-rem"}


def esc(x):
    return html.escape(str(x), quote=False)


# VA small-cell rule: the exporter writes the literal "<20" instead of a count.
# It is a refusal, not a number — carry it through verbatim, never impute.
SUPPRESSED = "<20"


def parse_val(v):
    """Export columns are mixed-typed (some numeric, some string). Return a
    number, the suppression marker, or None — never a bare numeric string."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip()
    if not s:
        return None
    if s.replace(",", "") == SUPPRESSED or s.startswith("<"):
        return SUPPRESSED
    try:
        return float(s)
    except ValueError:
        return s


def fmt_count(n):
    if n == SUPPRESSED:
        return "&lt;20"
    return "{:,}".format(int(n))


def fmt_num(x, dp=2):
    return "{:.{dp}f}".format(float(x), dp=dp)


def cell(row, ix, arm, display_stat):
    """Render one arm's cell for a row, per the export's declared display_stat.

    display_stat is the schema's pre-specified choice (mean_sd vs median_iqr) —
    this renders it, it does not decide it.
    """
    g = lambda col: parse_val(row[ix[col + "_" + arm]])
    if display_stat == "n_pct":
        n, pct = g("n"), g("pct")
        if n is None:
            return ""
        # A suppressed count publishes no percentage either — a percentage plus a
        # known denominator reconstructs the very cell the rule withholds.
        if n == SUPPRESSED:
            return fmt_count(n)
        return "%s (%s%%)" % (fmt_count(n), fmt_num(pct, 1)) if pct is not None else fmt_count(n)
    if display_stat == "mean_sd":
        m, sd = g("mean"), g("sd")
        if m is None or m == SUPPRESSED:
            return "&lt;20" if m == SUPPRESSED else ""
        return "%s (%s)" % (fmt_num(m), fmt_num(sd)) if isinstance(sd, float) else fmt_num(m)
    if display_stat == "median_iqr":
        med, q1, q3 = g("median"), g("q1"), g("q3")
        if med is None or med == SUPPRESSED:
            return "&lt;20" if med == SUPPRESSED else ""
        if not isinstance(q1, float) or not isinstance(q3, float):
            return fmt_num(med, 1)
        return "%s (%s&ndash;%s)" % (fmt_num(med, 1), fmt_num(q1, 1), fmt_num(q3, 1))
    return ""


def missing_cell(row, ix):
    n, pct = parse_val(row[ix["n_missing_all"]]), parse_val(row[ix["pct_missing_all"]])
    if n is None:
        return ""
    if n == SUPPRESSED:
        return fmt_count(n)
    return "%s (%s%%)" % (fmt_count(n), fmt_num(pct, 1) if pct is not None else "0.0")


# --- Table 1 ---------------------------------------------------------------
def build_table1():
    rows = load_sheet(TABLE1_XLSX, "Table 1 full export")
    ix = {h: i for i, h in enumerate(rows[0])}
    out, current_section = [], None
    n_data = n_sub = 0

    for r in rows[1:]:
        section = demojibake(r[ix["section"]])
        if section and section != current_section:
            current_section = section
            out.append('<tr class="section"><th colspan="5">%s</th></tr>' % esc(section))

        label = sanitize_label(demojibake(r[ix["label"]]) or "")
        cls = STAGE_CLASS.get(r[ix["stage"]], "stage-rem")
        stat = r[ix["display_stat"]]

        all_c = cell(r, ix, "all", stat)
        no_c = cell(r, ix, "no_abx", stat)
        abx_c = cell(r, ix, "abx", stat)

        # A categorical parent carries no numbers of its own — it introduces its
        # levels. Render as the label-only sub-header the site already styles.
        if not any((all_c, no_c, abx_c)):
            n_sub += 1
            out.append(
                '<tr class="%s subhdr"><td class="varname">%s</td>'
                "<td></td><td></td><td></td><td></td></tr>" % (cls, esc(label))
            )
            continue

        n_data += 1
        out.append(
            '<tr class="%s"><td class="varname">%s</td><td>%s</td>'
            "<td>%s</td><td>%s</td><td>%s</td></tr>"
            % (cls, esc(label), missing_cell(r, ix), all_c, no_c, abx_c)
        )

    return "\n".join(out), n_data, n_sub, rows, ix


def cohort_numbers():
    rows = load_sheet(COHORT_XLSX, "Manuscript numbers")
    vals = {}
    for r in rows:
        if r and r[0]:
            vals[str(r[0]).strip()] = r[2]
    need = ["n_screened_cohort", "n_abx_24h", "n_no_abx_24h", "pct_abx_24h",
            "crude_mortality_30d_overall"]
    missing = [k for k in need if k not in vals]
    if missing:
        sys.exit("cohort_report.xlsx is missing required keys: %s" % ", ".join(missing))
    return {k: float(vals[k]) for k in need}


# --- Table 2 ---------------------------------------------------------------
# Descriptive-reframe: the recommendation layer (ATS 2025 / IDSA-aligned /
# individualized-optimal regimes) was gated off the production export, so Table 2
# is now the three descriptive population strategies only.
ORDER = ["observed", "abx_all", "abx_none"]


def build_table2(window):
    with open(TABLE2_CSV) as f:
        rows = [r for r in csv.DictReader(f) if r["mortality_window"] == window]
    by_key = {r["regime"]: r for r in rows}
    missing = [k for k in ORDER if k not in by_key]
    if missing:
        sys.exit("table2_regime_comparison.csv is missing regimes: %s" % ", ".join(missing))

    out = []
    for key in ORDER:
        r = by_key[key]
        pe = float(r["point_estimate"]) * 100
        lo = float(r["cri_lower"]) * 100
        hi = float(r["cri_upper"]) * 100
        abx = float(r["abx_use_fraction"]) * 100
        out.append(
            '<tr><td class="varname">%s</td><td>%s (%s&ndash;%s)</td><td>%s%%</td></tr>'
            % (esc(demojibake(r["regime_label"])), fmt_num(pe), fmt_num(lo),
               fmt_num(hi), fmt_num(abx, 1))
        )
    return "\n".join(out)


# --- html patching ---------------------------------------------------------
def replace_between(text, start_pat, end_pat, new_inner, what):
    m = re.search(start_pat + r"(.*?)" + end_pat, text, re.S)
    if not m:
        sys.exit("could not locate %s in tables.html" % what)
    return text[: m.start(1)] + new_inner + text[m.end(1):]


def verify(t1_html, coh, rows, ix):
    """Fail loudly rather than ship a table that disagrees with the run."""
    # 1. severity levels must partition the cohort. Key off `var`, not `label` —
    # "Moderate"/"Severe" also label the hypoxemia levels, and matching on the
    # label silently sums the wrong block.
    sev = {}
    for r in rows[1:]:
        var = r[ix["var"]]
        if var in ("pna_severity_mild", "pna_severity_moderate", "pna_severity_severe"):
            n = parse_val(r[ix["n_all"]])
            if not isinstance(n, float) and not isinstance(n, int):
                sys.exit("severity level %s has a non-numeric n: %r" % (var, n))
            sev[var.rsplit("_", 1)[1].capitalize()] = int(n)
    if len(sev) != 3:
        sys.exit("expected 3 pna_severity levels, found %d: %s" % (len(sev), sorted(sev)))
    total = sum(sev.values())
    if total != int(coh["n_screened_cohort"]):
        sys.exit("severity levels sum to %d but cohort N is %d (%s)"
                 % (total, int(coh["n_screened_cohort"]), sev))

    # 2. arms must partition the cohort
    if int(coh["n_abx_24h"]) + int(coh["n_no_abx_24h"]) != int(coh["n_screened_cohort"]):
        sys.exit("abx + no-abx arms do not sum to the cohort N")

    # 3. the stale cohort must not survive anywhere in the rendered table
    for stale in ("134,916", "114,004", "20,912"):
        if stale in t1_html:
            sys.exit("superseded cohort value %s present in generated Table 1" % stale)

    # (D-PIR-02 IDSA-caveat drift guard removed with the Table 2 footnote in the
    # descriptive reframe; the site no longer surfaces the IDSA regime.)
    return total, sev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if tables.html is out of date; write nothing")
    args = ap.parse_args()

    label = run_label()
    t1_html, n_data, n_sub, rows, ix = build_table1()
    coh = cohort_numbers()
    total, sev = verify(t1_html, coh, rows, ix)

    n_all = int(coh["n_screened_cohort"])
    n_abx = int(coh["n_abx_24h"])
    n_no = int(coh["n_no_abx_24h"])
    pct_abx = coh["pct_abx_24h"]
    pct_no = 100.0 - pct_abx

    text = original = open(TABLES_HTML, encoding="utf-8").read()

    desc = (
        "Cohort: %s ED encounters (empiric abx within 24h: %s / %s%%; no empiric abx: "
        "%s / %s%%). Columns report n (%%), mean (SD) or median (IQR) as pre-specified "
        "per variable, split by antibiotic group. Variables are organized by clinical "
        "domain (demographics, illness severity, comorbidities, viral testing, "
        "processes of care, outcomes, additional confounders); row shading indicates "
        "model-stage membership (green = Stage 2 decision covariate, blue = Stage 1 "
        "confounder, yellow = other). Counts below 20 are suppressed. Generated from "
        "%s."
        % (fmt_count(n_all), fmt_count(n_abx), fmt_num(pct_abx, 1),
           fmt_count(n_no), fmt_num(pct_no, 1), label)
    )

    text = replace_between(
        text, r'<p class="table-desc">', r'</p>\s*\n\s*<div class="table-scroll">',
        desc, "Table 1 description")

    head = (
        "\n              <th>Variable</th>\n"
        "              <th>Missing<br>n (%)</th>\n"
        "              <th>All<br>N = {all}</th>\n"
        "              <th>No Abx<br>N = {no}</th>\n"
        "              <th>Abx<br>N = {abx}</th>\n            "
    ).format(all=fmt_count(n_all), no=fmt_count(n_no), abx=fmt_count(n_abx))
    text = replace_between(text, r'<table class="data-table t1">\s*<thead>\s*<tr>',
                           r"</tr>\s*</thead>", head, "Table 1 header")

    text = replace_between(text, r'<table class="data-table t1">.*?<tbody>\s*\n',
                           r"\n\s*</tbody>", t1_html, "Table 1 body")

    # Table 2 — two windows, in document order
    t2_desc = (
        "Population mean mortality (posterior mean + 95%% credible interval over 1,000 "
        "draws) and population antibiotic-use fraction under three population "
        "strategies (observed care, antibiotics for all, antibiotics for none), by "
        "mortality window. Generated from %s." % label
    )
    text = replace_between(
        text,
        r'<h2 id="t2-heading">.*?<p class="table-desc">',
        r"</p>", t2_desc, "Table 2 description")

    for window, heading in (("30day", "30-day mortality"), ("90day", "90-day mortality")):
        text = replace_between(
            text,
            r'<h3 class="window-heading">%s</h3>.*?<tbody>\s*\n' % re.escape(heading),
            r"\n\s*</tbody>", build_table2(window), "Table 2 %s body" % window)

    prov = ("Tables 1 and 2 are generated from %s, the currently promoted analysis run. "
            "Mortality is on a scale where lower is better." % label)
    text = replace_between(text, r'<p class="provenance">', r"</p>", prov, "provenance line")

    if args.check:
        if text != original:
            sys.exit("tables.html is OUT OF DATE with %s — run without --check" % label)
        print("tables.html is current with %s" % label)
        return

    with open(TABLES_HTML, "w", encoding="utf-8") as f:
        f.write(text)

    print("Wrote %s from %s" % (TABLES_HTML, label))
    print("  Table 1: %d data rows, %d sub-headers" % (n_data, n_sub))
    print("  cohort N = %s (mild %s + moderate %s + severe %s)"
          % (fmt_count(total), fmt_count(sev["Mild"]), fmt_count(sev["Moderate"]),
             fmt_count(sev["Severe"])))
    print("  arms: abx %s (%s%%) + no-abx %s = %s"
          % (fmt_count(n_abx), fmt_num(pct_abx, 1), fmt_count(n_no), fmt_count(n_all)))
    print("  Table 2: %d regimes x 2 windows" % len(ORDER))


if __name__ == "__main__":
    main()
