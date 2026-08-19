#!/usr/bin/env python3
"""
build_results_by_node_data.py

Generate site/results_by_node.json, the data file behind the browsable
per-node results table page. This is the T3.5 static workbook made browsable:
5 tree-family views per window (root, virus->severity, severity->virus, and the
merged deep severity + virus trees), one row per node, with VA <20 small-cell
suppression mirrored.

Source of record: the promoted VINCI export only (D-BR-01) — whichever run
results/current points at, resolved dynamically by resolve_run_label() below.
Do not restate a run id here; a hardcoded one goes stale silently. The builder reads
the export-native contracts created by code/R/build_ate_summary_from_export.R:
  * results/current/aim3_ate_summary.csv          (deep severity trees)
  * results/current/aim3_ate_summary_virus.csv    (deep virus trees)
  * results/current/aim3_ate_summary_root.csv     (whole-cohort root)
  * results/current/aim3_ate_summary_sevvirus.csv (severity -> virus)
  * results/current/aim3_ate_summary_virsev.csv   (virus -> severity)

It does not read legacy interactive-tree files or serialized tree objects.

Regenerate (from the site/ directory):
    python3 build_results_by_node_data.py

Output: site/results_by_node.json (consumed by results_by_node.js)
"""

import csv
import json
import os
import re
import sys

# --- paths -----------------------------------------------------------------
SITE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(SITE_DIR, ".."))
DATA_ROOT = os.environ.get("AIM3_DATA_ROOT", PROJECT_ROOT)
RESULTS_CURRENT = os.path.join(DATA_ROOT, "results", "current")
SUMMARY_CSV = os.path.join(RESULTS_CURRENT, "aim3_ate_summary.csv")
VIRUS_CSV = os.path.join(RESULTS_CURRENT, "aim3_ate_summary_virus.csv")
# Descriptive-reframe additions (manuscript trees #1 root-only + #3 sev->virus).
ROOT_CSV = os.path.join(RESULTS_CURRENT, "aim3_ate_summary_root.csv")
SEVVIRUS_CSV = os.path.join(RESULTS_CURRENT, "aim3_ate_summary_sevvirus.csv")
VIRSEV_CSV = os.path.join(RESULTS_CURRENT, "aim3_ate_summary_virsev.csv")
OUT_PATH = os.path.join(SITE_DIR, "results_by_node.json")


def resolve_run_label():
    """Run label = the promoted run in results/current, read dynamically.

    results/current is a symlink to runs/<run-id>; the label must track whatever
    run is currently promoted (never a hardcoded constant), so a re-ingest after
    a run advances stamps the correct run and the delivery stays self-describing.
    """
    real = os.path.realpath(RESULTS_CURRENT)
    label = os.path.basename(real.rstrip(os.sep))
    return label or "run-unknown"


RUN_LABEL = resolve_run_label()

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
    "root": "Overall cohort",
    "sevvirus": "Severity then virus",
    "virsev": "Virus then severity",
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
VAR_BY_HEADER = {label: var for var, label in VAR_HEADER.items()}
SEVERITY_CANONICAL_VARS = [
    "severe_hypoxemia_shock",
    "hypoxemia_sepsis",
    "lung_comorbidities",
    "comorbidities_not_cpd",
    "virus",
]

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


def full_path_label(node_path):
    """Full covariate path to the node, matching the interactive contour title.

    The stored path is a ' > '-joined chain of node titles whose root segment
    carries a redundant '(NN-day mortality)' window annotation (the report is
    already grouped by window). Strip that annotation from the root and
    tidy-case it; keep the covariate chain verbatim so it matches the
    interactive tree's node breadcrumb.
    """
    segs = [s.strip() for s in str(node_path or "").split(" > ") if s.strip()]
    if not segs:
        return ""
    root = re.sub(r"\s*\(\d+-day mortality\)\s*$", "", segs[0]).strip()
    if root and root[0].islower():
        root = root[0].upper() + root[1:]
    segs[0] = root
    return " > ".join(segs)


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
    # Order the split columns by the depth at which each variable first splits,
    # so a virus-rooted-then-severity tree (virsev) shows Virus before Severity.
    # For every other family the first-split depth already matches VAR_ORDER, so
    # this is behavior-preserving there (VAR_ORDER breaks ties).
    first_depth = {}
    for (_, row), path_map in zip(sub, path_maps):
        d = parse_int(row.get("depth")) or 0
        for var in path_map:
            if var not in first_depth or d < first_depth[var]:
                first_depth[var] = d
    present = sorted(
        (var for var in VAR_ORDER if var in first_depth),
        key=lambda v: (first_depth[v], VAR_ORDER.index(v)),
    )

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
            "path": full_path_label(row.get("node_path")),
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


def merge_severity_families(rows, win):
    merged_rows = []
    canonical_depth = {
        var: idx + 1 for idx, var in enumerate(SEVERITY_CANONICAL_VARS)
    }
    for stratum in SEVERITY_STRATA:
        fam = build_family(rows, win, stratum)
        present = []
        for label in fam["split_columns"]:
            if label not in VAR_BY_HEADER:
                sys.exit("Cannot reverse-map split column label: %s" % label)
            present.append(VAR_BY_HEADER[label])

        for row in fam["rows"]:
            depth = row["depth"]
            if depth > 0:
                if depth > len(present):
                    sys.exit("Family %s row depth %d exceeds split columns" %
                             (fam["key"], depth))
                var = present[depth - 1]
                if var not in canonical_depth:
                    sys.exit("No severity canonical depth for variable: %s" % var)
                row["depth"] = canonical_depth[var]
            row["splits"]["Severity (root)"] = STRATUM_LABEL[stratum]
            merged_rows.append(row)

    for node_idx, row in enumerate(merged_rows, start=1):
        row["node_id"] = node_idx

    return {
        "key": "%s_severity" % win,
        "window": win,
        "stratum": "severity",
        "label": "Severity - %s" % WINDOW_LABEL[win],
        "split_columns": [VAR_HEADER[var] for var in SEVERITY_CANONICAL_VARS],
        "root_column": "Severity (root)",
        "rows": merged_rows,
    }


def merge_virus_families(rows, win):
    merged_rows = []
    split_columns = None
    for stratum in VIRUS_STRATA:
        fam = build_family(rows, win, stratum)
        if split_columns is None:
            split_columns = fam["split_columns"]
        elif fam["split_columns"] != split_columns:
            sys.exit("Virus split-column mismatch for %s: %r != %r" %
                     (fam["key"], fam["split_columns"], split_columns))

        for row in fam["rows"]:
            row["splits"]["Virus (root)"] = STRATUM_LABEL[stratum]
            merged_rows.append(row)

    for node_idx, row in enumerate(merged_rows, start=1):
        row["node_id"] = node_idx

    return {
        "key": "%s_virus" % win,
        "window": win,
        "stratum": "virus",
        "label": "Virus - %s" % WINDOW_LABEL[win],
        "split_columns": split_columns or [],
        "root_column": "Virus (root)",
        "rows": merged_rows,
    }


def depth0_n(families, strata):
    total = 0
    for fam in families:
        if fam["stratum"] not in strata:
            continue
        roots = [row for row in fam["rows"] if row["depth"] == 0]
        if not roots:
            sys.exit("Family %s has no depth-0 roots" % fam["key"])
        for root in roots:
            try:
                total += int(root["n"])
            except ValueError:
                sys.exit("Family %s depth-0 n is not an integer: %r" %
                         (fam["key"], root["n"]))
    return total


def main():
    severity_rows = read_csv(SUMMARY_CSV)
    virus_rows = read_csv(VIRUS_CSV)
    root_rows = read_csv(ROOT_CSV)
    sevvirus_rows = read_csv(SEVVIRUS_CSV)
    virsev_rows = read_csv(VIRSEV_CSV)

    # Family order per window matches the revised manuscript's tree list:
    # (1) root-only, (2) virus->severity, (3) severity->virus, then the deep
    # severity + virus trees.
    families = []
    total_nodes = 0
    for win in WINDOWS:
        for fam in (
            build_family(root_rows, win, "root"),
            build_family(virsev_rows, win, "virsev"),
            build_family(sevvirus_rows, win, "sevvirus"),
            merge_severity_families(severity_rows, win),
            merge_virus_families(virus_rows, win),
        ):
            families.append(fam)
            total_nodes += len(fam["rows"])

    # Every tree's whole-cohort depth-0 total must agree (same cohort, N=130,265
    # per window -> 260,530 across the two windows).
    severity_n = depth0_n(families, ["severity"])
    virus_n = depth0_n(families, ["virus"])
    root_n = depth0_n(families, ["root"])
    sevvirus_n = depth0_n(families, ["sevvirus"])
    virsev_n = depth0_n(families, ["virsev"])
    if not (severity_n == virus_n == root_n == sevvirus_n == virsev_n):
        sys.exit("Depth-0 cohort mismatch: severity=%d virus=%d root=%d "
                 "sevvirus=%d virsev=%d"
                 % (severity_n, virus_n, root_n, sevvirus_n, virsev_n))

    out = {
        "run": RUN_LABEL,
        "source": (
            "%s export-native contracts: "
            "results/current/aim3_ate_summary.csv and "
            "results/current/aim3_ate_summary_virus.csv" % RUN_LABEL
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
