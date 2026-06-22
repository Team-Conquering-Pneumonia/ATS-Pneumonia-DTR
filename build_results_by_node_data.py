#!/usr/bin/env python3
"""
build_results_by_node_data.py

Generate site/results_by_node.json — the data file behind the browsable
per-node results table page (Track C). This is the T3.5 static workbook made
browsable: 16 tree families (8 strata x 2 mortality windows), one row per node,
the T3.5 columns, with VA <20 small-cell suppression mirrored exactly.

This is a faithful port of the parse/walk logic in
  code/R/build_static_results_workbook.R  (registry T3.5)
which is the source of truth for what each row/column means and how suppression
is applied. The same regexes and the same Signal (Benefit/Harm/Inconclusive)
rule are used here so the page matches the workbook cell-for-cell.

Source of record: Yizhen's published interactive-tree JSONs (FINAL 2026-06-18),
vendored at data/yizhen_interactive_trees/ (the literal source of the live site).

Regenerate (from the site/ directory):
    python3 build_results_by_node_data.py

Output: site/results_by_node.json  (consumed by results_by_node.js)
"""

import json
import os
import re
import sys

# --- paths -----------------------------------------------------------------
SITE_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_DIR = os.path.normpath(os.path.join(SITE_DIR, "..", "data",
                                          "yizhen_interactive_trees"))
OUT_PATH = os.path.join(SITE_DIR, "results_by_node.json")

RUN_LABEL = "run-20260618-final"

WINDOWS = ["30day", "90day"]
STRATA = ["mild", "moderate", "severe", "covid", "flu", "rsv", "none", "others"]

# Human-facing window/stratum labels for the family selector.
WINDOW_LABEL = {"30day": "30-day mortality", "90day": "90-day mortality"}
STRATUM_LABEL = {
    "mild": "Mild", "moderate": "Moderate", "severe": "Severe",
    "covid": "COVID", "flu": "Influenza", "rsv": "RSV",
    "none": "No virus", "others": "Other viruses",
}

# --- JSON title -> split variable (inverse of the builder's TITLE_TO_VAR) ---
TITLE_TO_VAR = {
    "No Lung Disease": "lung_comorbidities",
    "Lung Disease": "lung_comorbidities",
    "No Comorbidity": "comorbidities_not_cpd",
    "Other Comorbidities": "comorbidities_not_cpd",
    "Hypoxemia and Sepsis": "hypoxemia_sepsis",
    "Hypoxemia (No Sepsis)": "hypoxemia_sepsis",
    "Sepsis (No Hypoxemia)": "hypoxemia_sepsis",
    "No Sepsis / No Hypoxemia": "hypoxemia_sepsis",
    "Severe Hypoxemia and Shock": "severe_hypoxemia_shock",
    "Severe Hypoxemia (No Shock)": "severe_hypoxemia_shock",
    "Shock (No S. Hypoxemia)": "severe_hypoxemia_shock",
    "No Shock / No S. Hypoxemia": "severe_hypoxemia_shock",
    "Mild": "pna_severity",
    "Moderate": "pna_severity",
    "Severe": "pna_severity",
    "COVID": "virus",
    "Influenza": "virus",
    "RSV": "virus",
    "None": "virus",
    "Other Viruses": "virus",
}

# Canonical column order + Barb-facing header (matches the builder's VAR_HEADER).
VAR_ORDER = ["pna_severity", "severe_hypoxemia_shock", "hypoxemia_sepsis",
             "lung_comorbidities", "comorbidities_not_cpd", "virus"]
VAR_HEADER = {
    "pna_severity": "Severity (split)",
    "severe_hypoxemia_shock": "Severe hypoxemia / shock",
    "hypoxemia_sepsis": "Hypoxemia / sepsis",
    "lung_comorbidities": "Lung disease",
    "comorbidities_not_cpd": "Other comorbidities",
    "virus": "Virus",
}

SUPP = "<20"   # workbook suppression flag (mirror export <20)


def num1(txt, pat):
    m = re.search(pat, txt)
    if not m:
        return None
    try:
        return float(m.group(1))
    except (ValueError, IndexError):
        return None


def parse_details(details):
    """Port of build_static_results_workbook.R::parse_details."""
    if isinstance(details, list):
        txt = " ; ".join(str(x) for x in details)
    else:
        txt = str(details)

    n = num1(txt, r"N\s*=\s*(\d+)")
    # Fully suppressed node: no N, no estimates.
    if n is None:
        return {
            "n": SUPP, "pct_obs_abx": SUPP, "pct_obs_mort": SUPP,
            "p_abx": None, "p_noabx": None,
            "ate": None, "ate_lo": None, "ate_hi": None,
            "ci": "", "signal": "",
        }

    obs_mort = num1(txt, r"Observed death\s+([0-9.]+)%")
    obs_abx = num1(txt, r"Observed ABX\s+([0-9.]+)%")
    p_abx = num1(txt, r"ABX mort\s+([0-9.]+)")
    p_noabx = num1(txt, r"No-ABX mort\s+([0-9.]+)")
    ate = num1(txt, r"\bATE\s+(-?[0-9.]+)")
    m_ci = re.search(r"\bATE\s+-?[0-9.]+\s*\((-?[0-9.]+),\s*(-?[0-9.]+)\)", txt)
    ate_lo = float(m_ci.group(1)) if m_ci else None
    ate_hi = float(m_ci.group(2)) if m_ci else None
    ci_str = "(%.3f, %.3f)" % (ate_lo, ate_hi) if ate_lo is not None else ""

    # Benefit/harm signal — SAME rule as the inline-forest tree + the workbook:
    #   CI entirely < 0 -> "Benefit"; CI entirely > 0 -> "Harm"; else "Inconclusive".
    if ate_lo is None or ate is None:
        signal = ""
    elif ate_hi < 0:
        signal = "Benefit"
    elif ate_lo > 0:
        signal = "Harm"
    else:
        signal = "Inconclusive"

    return {
        "n": str(int(n)),
        "pct_obs_abx": SUPP if obs_abx is None else obs_abx,
        "pct_obs_mort": SUPP if obs_mort is None else obs_mort,
        "p_abx": p_abx,
        "p_noabx": p_noabx,
        "ate": ate,
        "ate_lo": ate_lo,
        "ate_hi": ate_hi,
        "ci": ci_str,
        "signal": signal,
    }


def walk_tree(node, depth=0, path_map=None, ctr=None, recs=None):
    """DFS walk — port of build_static_results_workbook.R::walk_tree.

    node_id is the DFS ordinal (1-based), matching the workbook.
    """
    if recs is None:
        recs = []
        ctr = [0]
        path_map = {}
    ctr[0] += 1
    recs.append({
        "node_id": ctr[0],
        "label": node.get("title"),
        "depth": depth,
        "path": dict(path_map),
        "vals": parse_details(node.get("details")),
    })
    for ch in (node.get("children") or []):
        title = ch.get("title")
        var = TITLE_TO_VAR.get(title)
        pm = dict(path_map)
        if var is not None:
            pm[var] = title
        walk_tree(ch, depth + 1, pm, ctr, recs)
    return recs


def round3(x):
    return None if x is None else round(x, 3)


def build_family(win, stratum):
    json_path = os.path.join(JSON_DIR, "%s_%s.json" % (win, stratum))
    with open(json_path) as f:
        j = json.load(f)
    recs = walk_tree(j)

    # Which split variables actually appear in this tree (canonical order).
    present = [v for v in VAR_ORDER
               if any(v in r["path"] for r in recs)]

    rows = []
    for r in recs:
        v = r["vals"]
        row = {
            "node_id": r["node_id"],
            "label": r["label"],
            "depth": r["depth"],
            "splits": {VAR_HEADER[var]: r["path"].get(var) for var in present},
            "n": v["n"],                       # int-as-string OR "<20"
            "pct_obs_abx": v["pct_obs_abx"],   # number OR "<20"
            "pct_obs_mort": v["pct_obs_mort"], # number OR "<20"
            "p_abx": round3(v["p_abx"]),
            "p_noabx": round3(v["p_noabx"]),
            "ate": round3(v["ate"]),
            "ci": v["ci"],
            "signal": v["signal"],
            "suppressed": v["n"] == SUPP,
        }
        rows.append(row)

    return {
        "key": "%s_%s" % (win, stratum),
        "window": win,
        "stratum": stratum,
        "label": "%s — %s" % (STRATUM_LABEL[stratum], WINDOW_LABEL[win]),
        "split_columns": [VAR_HEADER[v] for v in present],
        "rows": rows,
    }


def main():
    if not os.path.isdir(JSON_DIR):
        sys.exit("JSON input dir not found: %s" % JSON_DIR)

    families = []
    total_nodes = 0
    for win in WINDOWS:
        for s in STRATA:
            fam = build_family(win, s)
            total_nodes += len(fam["rows"])
            families.append(fam)

    out = {
        "run": RUN_LABEL,
        "source": ("Yizhen's published interactive-tree JSONs (FINAL 2026-06-18); "
                   "parse logic mirrors code/R/build_static_results_workbook.R (T3.5)"),
        "generated_by": "site/build_results_by_node_data.py",
        "n_families": len(families),
        "n_nodes": total_nodes,
        "families": families,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("Wrote %s (%d families, %d nodes)" %
          (OUT_PATH, len(families), total_nodes))


if __name__ == "__main__":
    main()
