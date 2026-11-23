"""Make the two figures of the report from data/raw, without the app.

    python code/make_figures.py

figures/one_recording_marked.png  one recording (P01_S01_R01) with the movement windows shaded
figures/two_features.png          RMS and waveform length (WL) of 250 ms windows of emg_mV, movement vs rest,
                                  from the TRAINING sessions only (S01 to S04). The test sessions are not opened.
"""
import csv
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
FIG = os.path.join(ROOT, "figures")
TRAIN_SESSIONS = ("S01", "S02", "S03", "S04")
WIN = 250  # samples = 250 ms at 1000 Hz
COLORS = {"reposo": "#1f7fb0", "mover": "#e0575b"}


def load(name):
    """Return emg (float array, NaN for missing samples) and label (str array) of one file of data/raw."""
    emg, label = [], []
    with open(os.path.join(RAW, name), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            emg.append(float(row["emg_mV"]) if row["emg_mV"] else np.nan)
            label.append(row["label"])
    return np.array(emg), np.array(label)


def segments(label, name):
    """Start and end index of each continuous run of one label."""
    idx = np.flatnonzero(label == name)
    if idx.size == 0:
        return []
    cuts = np.flatnonzero(np.diff(idx) > 1)
    starts = np.r_[idx[0], idx[cuts + 1]]
    ends = np.r_[idx[cuts], idx[-1]] + 1
    return list(zip(starts, ends))


def figure_one_recording():
    name = "P01_S01_R01.csv"
    emg, label = load(name)
    t = np.arange(emg.size) / 1000.0
    fig, ax = plt.subplots(figsize=(11, 3.4))
    for a, b in segments(label, "mover"):
        ax.axvspan(t[a], t[b - 1], color="#2f9e6a", alpha=0.18, lw=0)
    ax.plot(t, emg, color="#133b57", lw=0.5)
    ax.set_xlabel("time (s)")
    ax.set_ylabel("emg_mV (filtered)")
    ax.set_title(f"{name}: 5 trials, movement windows (contraction) shaded in green")
    ax.set_xlim(0, t[-1])
    ax.grid(alpha=0.3)
    fig.tight_layout()
    out = os.path.join(FIG, "one_recording_marked.png")
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out


def figure_two_features():
    feats = {"reposo": [], "mover": []}
    files = sorted(f for f in os.listdir(RAW) if f.endswith(".csv") and f.split("_")[1] in TRAIN_SESSIONS)
    for name in files:
        emg, label = load(name)
        for cls in feats:
            for a, b in segments(label, cls):
                for s in range(a, b - WIN + 1, WIN):   # windows that do not overlap
                    w = emg[s:s + WIN]
                    if np.isnan(w).any():
                        continue
                    feats[cls].append((np.sqrt(np.mean(w ** 2)), np.sum(np.abs(np.diff(w)))))
    fig, ax = plt.subplots(figsize=(6.4, 5))
    for cls, pts in feats.items():
        p = np.array(pts)
        ax.scatter(p[:, 0], p[:, 1], s=6, alpha=0.35, color=COLORS[cls],
                   label=f"{'rest' if cls == 'reposo' else 'movement'} ({cls}), {len(p)} windows")
    ax.set_xlabel("RMS (mV)")
    ax.set_ylabel("waveform length, WL (mV)")
    ax.set_title(f"250 ms windows, training only ({TRAIN_SESSIONS[0]}-{TRAIN_SESSIONS[-1]}, {len(files)} recordings)", fontsize=10)
    ax.legend(markerscale=3, fontsize=8)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    out = os.path.join(FIG, "two_features.png")
    fig.savefig(out, dpi=150)
    plt.close(fig)
    summary = {cls: np.median(np.array(p), axis=0) for cls, p in feats.items()}
    return out, {cls: len(p) for cls, p in feats.items()}, summary


if __name__ == "__main__":
    os.makedirs(FIG, exist_ok=True)
    print(figure_one_recording())
    out, counts, med = figure_two_features()
    print(out, counts)
    for cls, (r, wl) in med.items():
        print(f"median {cls}: RMS {r:.1f} mV, WL {wl:.0f} mV")
