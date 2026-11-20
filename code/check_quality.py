"""Check the cleaning rule again from data/raw/, without the app.

Rule (written before any model score): reject a trial if one raw_mV sample sits at the
limit of the converter (<= 20 mV or >= 3050 mV), or if more than 1 % of its samples are
missing (empty cells). It must give the same counts as QUALITY-REPORT.md.

Use, from the root of the repository:
    python code/check_quality.py
Only the Python standard library is needed.
"""
import csv
import glob
import os
from collections import defaultdict

SAT_LOW_MV = 20.0
SAT_HIGH_MV = 3050.0
MAX_MISSING = 0.01


def check_file(path):
    trials = defaultdict(lambda: {"n": 0, "missing": 0, "sat": 0})
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        has_raw = "raw_mV" in reader.fieldnames
        for row in reader:
            t = trials[int(row["trial"])]
            t["n"] += 1
            raw = row.get("raw_mV", "")
            emg = row.get("emg_mV", "")
            if (has_raw and raw == "") or (not has_raw and emg == ""):
                t["missing"] += 1
                continue
            if has_raw and not (SAT_LOW_MV < float(raw) < SAT_HIGH_MV):
                t["sat"] += 1
    result = []
    for k in sorted(trials):
        t = trials[k]
        reasons = []
        if t["sat"]:
            reasons.append("samples at the limit of the converter")
        frac = t["missing"] / t["n"] if t["n"] else 1.0
        if frac > MAX_MISSING:
            reasons.append(f"{frac * 100:.1f} % of the samples missing")
        result.append((k, reasons))
    return result, has_raw


def main():
    files = sorted(glob.glob(os.path.join("data", "raw", "*.csv")))
    if not files:
        print("No files in data/raw/")
        return
    total = rejected = 0
    print("| File | Trials | Rejected | Reason |")
    print("|---|---|---|---|")
    for path in files:
        result, has_raw = check_file(path)
        bad = [(k, r) for k, r in result if r]
        total += len(result)
        rejected += len(bad)
        reason = "; ".join(f"trial {k}: {' and '.join(r)}" for k, r in bad) or "kept"
        if not has_raw:
            reason += " (no raw_mV: saturation not checked)"
        print(f"| {os.path.basename(path)} | {len(result)} | {len(bad)} | {reason} |")
    print(f"\n{total} trials, {rejected} rejected, {total - rejected} kept.")


if __name__ == "__main__":
    main()
