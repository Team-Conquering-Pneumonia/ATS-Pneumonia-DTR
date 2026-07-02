#!/usr/bin/env python3
"""
build_results_by_node_data.py

Generate site/results_by_node.json, the data file behind the browsable
per-node results table page. This is the T3.5 static workbook made browsable:
16 tree families (3 severity-rooted + 5 virus-rooted families x 2 mortality
windows), one row per node, with VA <20 small-cell suppression mirrored.

Source of record: run-20260702 VINCI export only (D-BR-01). The builder reads
the export-native contracts created by code/R/build_ate_summary_from_export.R:
  * results/current/aim3_ate_summary.csv
  * results/current/aim3_ate_summary_virus.csv

It does not read legacy interactive-tree files or serialized tree objects.

Regenerate (from the site/ directory):
    python3 build_results_by_node_data.py

Output: site/results_by_node.json (consumed by results_by_node.js)
"""

import csv
import json
import os
import sys

# --- paths -----------------------------------------------------------------
SITE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(SITE_DIR, ".."))
DATA_ROOT = os.environ.get("AIM3_DATA_ROOT", PROJECT_ROOT)
RESULTS_CURRENT = os.path.join(DATA_ROOT, "results", "current")
SUMMARY_CSV = os.path.join(RESULTS_CURRENT, "aim3_ate_summary.csv")
VIRUS_CSV = os.path.join(RESULTS_CURRENT, "aim3_ate_summary_virus.csv")
OUT_PATH = os.path.join(SITE_DIR, "results_by_node.json")

RUN_LABEL = "run-20260702"

WINDOWS = ["30day", "90day"]
SEVERITY_STRATA = ["mild", "moderate", "severe"]
VIRUS_STRATA = ["flu", "rsv", "covid", "none", "others"]

WINDOW_LABEL = {"30day": "30-day mortality", "90day": "90-day mortality"}
STRATUM_LABEL = {
    "mild": "Mild",
    "moderate": "Moderate",
    "severe": "Severe",
    "flu": "Influenza",
    "rsv": "RSV",
    "covid": "COVID",
    "none": "No virus",
    "others": "Other viruses",
}

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

VAR_ORDER = [
    "pna_severity",
    "severe_hypoxemia_shock",
    "hypoxemia_sepsis",
    "lung_comorbidities",
    "comorbidities_not_cpd",
    "virus",
]
VAR_HEADER = {
    "pna_severity": "Severity (split)",
    "severe_hypoxemia_shock": "Severe hypoxemia / shock",
    "hypoxemia_sepsis": "Hypoxemia / sepsis",
    "lung_comorbidities": "Lung disease",
    "comorbidities_not_cpd": "Other comorbidities",
    "virus": "Virus",
}

SUPP = "<20"


def read_csv(path):
    if not os.path.exists(path):
        sys.exit("Required export-native contract not found: %s" % path)
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def parse_float(value):
    if value is None:
        return None
    txt = str(value).strip()
    if txt == "" or txt.upper() == "NA" or "<" in txt or ">" in txt:
        return None
    if txt.endswith("%"):
        txt = txt[:-1]
    try:
        return float(txt)
    except ValueError:
        return None


def parse_int(value):
    x = parse_float(value)
    return None if x is None else int(x)


def pct_value(value, blank_if_missing=False):
    x = parse_float(value)
    if x is None:
        return "" if blank_if_missing else SUPP
    return round(x, 1)


def prob_value(value):
    x = parse_float(value)
    return None if x is None else round(x, 3)


def signal_of(ate_lo, ate_hi):
    lo = parse_float(ate_lo)
    hi = parse_float(ate_hi)
    if lo is None or hi is None:
        return ""
    if hi < 0:
        return "Benefit"
    if lo > 0:
        return "Harm"
    return "Inconclusive"


def path_map_of(node_path):
    segs = str(node_path or "").split(" > ")
    out = {}
    for title in segs[1:]:
        var = TITLE_TO_VAR.get(title)
        if var:
            out[var] = title
    return out


def build_family(rows, win, stratum):
    sub = [
        (i, row) for i, row in enumerate(rows)
        if row.get("mortality_window") == win and row.get("severity") == stratum
    ]
    if not sub:
        sys.exit("No rows for %s_%s in export-native contracts" % (win, stratum))

    # Match the static workbook: root first, then stable within depth.
    sub.sort(key=lambda item: parse_int(item[1].get("depth")) or 0)
    path_maps = [path_map_of(row.get("node_path")) for _, row in sub]
    present = [
        var for var in VAR_ORDER
        if any(var in path_map for path_map in path_maps)
    ]

    out_rows = []
    for node_idx, ((_, row), path_map) in enumerate(zip(sub, path_maps), start=1):
        n = parse_int(row.get("N"))
        ate = prob_value(row.get("ate_mean"))
        ate_lo = parse_float(row.get("ate_lo"))
        ate_hi = parse_float(row.get("ate_hi"))
        suppressed = n is None or ate is None
        out_rows.append({
            "node_id": node_idx,
            "label": row.get("node_title") or "",
            "depth": parse_int(row.get("depth")) or 0,
            "splits": {
                VAR_HEADER[var]: path_map.get(var)
                for var in present
            },
            "n": SUPP if n is None else str(n),
            "pct_obs_abx": pct_value(row.get("obs_abx_pct")),
            "pct_obs_mort": pct_value(row.get("obs_death"), blank_if_missing=True),
            "p_abx": prob_value(row.get("abx_mort_mean")),
            "p_noabx": prob_value(row.get("noabx_mort_mean")),
            "ate": ate,
            "ci": "" if ate_lo is None or ate_hi is None
                  else "(%.3f, %.3f)" % (ate_lo, ate_hi),
            "signal": signal_of(row.get("ate_lo"), row.get("ate_hi")),
            "suppressed": suppressed,
        })

    return {
        "key": "%s_%s" % (win, stratum),
        "window": win,
        "stratum": stratum,
        "label": "%s - %s" % (STRATUM_LABEL[stratum], WINDOW_LABEL[win]),
        "split_columns": [VAR_HEADER[var] for var in present],
        "rows": out_rows,
    }


def depth0_n(families, strata):
    total = 0
    for fam in families:
        if fam["stratum"] not in strata:
            continue
        roots = [row for row in fam["rows"] if row["depth"] == 0]
        if len(roots) != 1:
            sys.exit("Family %s has %d depth-0 roots; expected 1" %
                     (fam["key"], len(roots)))
        try:
            total += int(roots[0]["n"])
        except ValueError:
            sys.exit("Family %s depth-0 n is not an integer: %r" %
                     (fam["key"], roots[0]["n"]))
    return total


def main():
    severity_rows = read_csv(SUMMARY_CSV)
    virus_rows = read_csv(VIRUS_CSV)

    families = []
    total_nodes = 0
    for win in WINDOWS:
        for stratum in SEVERITY_STRATA:
            fam = build_family(severity_rows, win, stratum)
            families.append(fam)
            total_nodes += len(fam["rows"])
        for stratum in VIRUS_STRATA:
            fam = build_family(virus_rows, win, stratum)
            families.append(fam)
            total_nodes += len(fam["rows"])

    severity_n = depth0_n(families, SEVERITY_STRATA)
    virus_n = depth0_n(families, VIRUS_STRATA)
    if severity_n != virus_n:
        sys.exit("Depth-0 cohort mismatch: severity=%d virus=%d" %
                 (severity_n, virus_n))

    out = {
        "run": RUN_LABEL,
        "source": (
            "run-20260702 export-native contracts: "
            "results/current/aim3_ate_summary.csv and "
            "results/current/aim3_ate_summary_virus.csv"
        ),
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
