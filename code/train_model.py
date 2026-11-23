"""Train and compare the models of DECISIONS.md (part 8) from data/raw, in VS Code, without Edge Impulse.

Step 1, choose (opens ONLY the training sessions S01 to S04):
    python code/train_model.py

    Cuts every rest and movement window into 250 ms pieces, computes two features (RMS and WL) of emg_mV,
    and compares three models with "leave one session out": train on three training sessions, score on the
    fourth, four times. This tells how well each model works on a session with new electrodes that it did
    not see. Writes results/selection.md.

Step 2, test ONCE at the end (opens S05 and S06):
    python code/train_model.py --test logreg        (or: threshold, mlp)

    Trains the chosen model on all of S01 to S04, scores it on S05 and S06 and writes results/test_result.md.
    It refuses to run a second time, because the test sessions are opened only once. It also writes
    firmware/emg_model/emg_model.h, the model in C for the ESP32 (no library needed).
"""
import argparse
import csv
import os
import sys

import numpy as np
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, confusion_matrix
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
META = os.path.join(ROOT, "data", "metadata.csv")
RESULTS = os.path.join(ROOT, "results")
HEADER = os.path.join(ROOT, "firmware", "emg_model", "emg_model.h")
FS = 1000
WIN = 250                      # samples per window = 250 ms
FEATURES = ["RMS", "WL"]       # DECISIONS.md, part 7
CLASSES = {"reposo": 0, "mover": 1}
GOAL = 0.75                    # the course goal on the test sessions


# ---------------------------------------------------------------- data
def kept_trials():
    """Recordings and the trials that passed the quality rule, from metadata.csv (notes: 'kept' or 'trial k: ...')."""
    out = []
    with open(META, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rejected = {int(p.split(":")[0].split()[1]) for p in row["notes"].split(";") if p.strip().startswith("trial ")}
            kept = [k for k in range(1, int(row["trials"]) + 1) if k not in rejected]
            out.append((row["file_name"], row["session"], row["set"], kept))
    return out


def features(w):
    """RMS and waveform length of one window. The same math is in the C header."""
    return [float(np.sqrt(np.mean(w ** 2))), float(np.sum(np.abs(np.diff(w))))]


def load_windows(sets):
    """X (n windows x 2 features), y (0 rest, 1 movement), session of each window. Only the sets asked for."""
    X, y, sess = [], [], []
    for name, session, set_, kept in kept_trials():
        if set_ not in sets:
            continue
        emg, label, trial = [], [], []
        with open(os.path.join(RAW, name), newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                emg.append(float(row["emg_mV"]) if row["emg_mV"] else np.nan)
                label.append(row["label"])
                trial.append(int(row["trial"]))
        emg, label, trial = np.array(emg), np.array(label), np.array(trial)
        for k in kept:
            for cls, target in CLASSES.items():
                idx = np.flatnonzero((trial == k) & (label == cls))
                for s in range(0, idx.size - WIN + 1, WIN):        # windows that do not overlap
                    w = emg[idx[s:s + WIN]]
                    if np.isnan(w).any():                         # a gap: skip the window, never fill it
                        continue
                    X.append(features(w)); y.append(target); sess.append(session)
    return np.array(X), np.array(y), np.array(sess)


# ---------------------------------------------------------------- models
class RMSThreshold(BaseEstimator, ClassifierMixin):
    """What PERLA does today: movement if the RMS is above one number. The number is the one that puts most
    training windows in the right class."""

    def fit(self, X, y):
        r = X[:, 0]
        cands = np.unique(r)
        acc = [np.mean((r > t) == y) for t in cands]
        self.t_ = float(cands[int(np.argmax(acc))])
        self.classes_ = np.array([0, 1])
        return self

    def predict(self, X):
        return (X[:, 0] > self.t_).astype(int)


MODELS = {
    "threshold": ("One threshold on the RMS (baseline)", lambda: RMSThreshold()),
    "logreg": ("Logistic regression (a straight border)", lambda: make_pipeline(StandardScaler(), LogisticRegression())),
    "mlp": ("Small neural network (1 hidden layer of 8)",
            lambda: make_pipeline(StandardScaler(), MLPClassifier((8,), max_iter=3000, random_state=0))),
}


# ---------------------------------------------------------------- step 1
def select():
    X, y, sess = load_windows({"train"})
    sessions = sorted(str(s) for s in set(sess))
    lines = [
        "# Model selection (training sessions only)", "",
        f"Made with `code/train_model.py`. Windows of {WIN} ms of `emg_mV`, features {', '.join(FEATURES)}. "
        f"{len(y)} windows from {', '.join(sessions)}: {int((y == 0).sum())} rest, {int((y == 1).sum())} movement. "
        "The test sessions (S05, S06) are not opened here.", "",
        "Leave one session out: train on three sessions, score on the fourth. Balanced accuracy is the mean of the "
        "accuracy of each class, so the extra rest windows do not help a model that says 'rest' too often.", "",
        "| Model | " + " | ".join(f"left out {s}" for s in sessions) + " | Mean accuracy | Mean balanced accuracy |",
        "|---" * (len(sessions) + 3) + "|",
    ]
    print(f"{len(y)} training windows ({int((y == 0).sum())} rest, {int((y == 1).sum())} movement), sessions {sessions}\n")
    best = None
    for key, (title, make) in MODELS.items():
        accs, baccs = [], []
        for s in sessions:
            tr, te = sess != s, sess == s
            m = make().fit(X[tr], y[tr])
            p = m.predict(X[te])
            accs.append(accuracy_score(y[te], p)); baccs.append(balanced_accuracy_score(y[te], p))
        mean_b = float(np.mean(baccs))
        print(f"{key:9s} {title}")
        print("          " + "  ".join(f"{s}:{a:.0%}" for s, a in zip(sessions, accs))
              + f"  | mean {np.mean(accs):.1%}  balanced {mean_b:.1%} (sd {np.std(baccs):.1%})")
        lines.append(f"| {title} (`{key}`) | " + " | ".join(f"{a:.0%}" for a in accs)
                     + f" | {np.mean(accs):.1%} | {mean_b:.1%} ± {np.std(baccs):.1%} |")
        if best is None or mean_b > best[1] + 1e-9:
            best = (key, mean_b)
    lines += ["", f"Highest mean balanced accuracy: `{best[0]}`. A simpler model is worth keeping when the difference "
              "is small: it is easier to explain and to run on the ESP32.", "",
              f"Next step, once: `python code/train_model.py --test <model>`."]
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, "selection.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nHighest mean balanced accuracy: {best[0]}. Written: results/selection.md")
    print("When you have chosen, test ONCE: python code/train_model.py --test <model>")


# ---------------------------------------------------------------- step 2
def fmt(v):
    return f"{float(np.float32(v)):.9g}f"


def c_model(key, m):
    """C code of the model: returns (code, python function that runs the same numbers, to check the code)."""
    if key == "threshold":
        t = np.float32(m.t_)
        code = f"#define EMG_MODEL_RMS_THRESHOLD {fmt(t)}\n\nstatic inline int emg_model_predict(const float f[2]) {{\n" \
               "  return f[0] > EMG_MODEL_RMS_THRESHOLD ? 1 : 0;\n}\n"
        return code, lambda F: (F[:, 0].astype(np.float32) > t).astype(int)
    sc = m[0]
    mu, sd = sc.mean_.astype(np.float32), sc.scale_.astype(np.float32)
    arr = lambda a: "{" + ", ".join(fmt(v) for v in np.ravel(a)) + "}"
    head = f"static const float EMG_MEAN[2] = {arr(mu)};\nstatic const float EMG_SCALE[2] = {arr(sd)};\n"
    if key == "logreg":
        lr = m[1]
        w, b = lr.coef_[0].astype(np.float32), np.float32(lr.intercept_[0])
        code = head + f"static const float EMG_W[2] = {arr(w)};\nstatic const float EMG_B = {fmt(b)};\n\n" \
            "static inline int emg_model_predict(const float f[2]) {\n  float z = EMG_B;\n" \
            "  for (int i = 0; i < 2; i++) z += EMG_W[i] * (f[i] - EMG_MEAN[i]) / EMG_SCALE[i];\n" \
            "  return z > 0.0f ? 1 : 0;\n}\n"
        return code, lambda F: ((((F.astype(np.float32) - mu) / sd) @ w + b) > 0).astype(int)
    mlp = m[1]
    W1, b1 = mlp.coefs_[0].astype(np.float32), mlp.intercepts_[0].astype(np.float32)   # 2 x H
    W2, b2 = mlp.coefs_[1][:, 0].astype(np.float32), np.float32(mlp.intercepts_[1][0])
    H = W1.shape[1]
    code = head + f"#define EMG_HIDDEN {H}\nstatic const float EMG_W1[2][EMG_HIDDEN] = {{{arr(W1[0])}, {arr(W1[1])}}};\n" \
        f"static const float EMG_B1[EMG_HIDDEN] = {arr(b1)};\nstatic const float EMG_W2[EMG_HIDDEN] = {arr(W2)};\n" \
        f"static const float EMG_B2 = {fmt(b2)};\n\nstatic inline int emg_model_predict(const float f[2]) {{\n" \
        "  float x[2], z = EMG_B2;\n  for (int i = 0; i < 2; i++) x[i] = (f[i] - EMG_MEAN[i]) / EMG_SCALE[i];\n" \
        "  for (int j = 0; j < EMG_HIDDEN; j++) {\n    float h = EMG_B1[j] + x[0] * EMG_W1[0][j] + x[1] * EMG_W1[1][j];\n" \
        "    if (h > 0.0f) z += h * EMG_W2[j];   /* ReLU */\n  }\n  return z > 0.0f ? 1 : 0;\n}\n"

    def run(F):
        x = (F.astype(np.float32) - mu) / sd
        return ((np.maximum(x @ W1 + b1, 0) @ W2 + b2) > 0).astype(int)
    return code, run


def write_header(key, m, Xtr):
    code, run = c_model(key, m)
    same = float(np.mean(run(Xtr) == m.predict(Xtr)))
    os.makedirs(os.path.dirname(HEADER), exist_ok=True)
    with open(HEADER, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"""// emg_model.h: generated by code/train_model.py ({key}, trained on S01-S04). Do not edit by hand.
// Use: collect EMG_MODEL_WINDOW samples of emg_mV (the filtered signal, 1000 Hz), then
//   float f[2]; emg_features(window, EMG_MODEL_WINDOW, f); int moving = emg_model_predict(f);  // 1 = mover, 0 = reposo
#pragma once
#include <math.h>

#define EMG_MODEL_WINDOW {WIN}   // samples = {WIN} ms at {FS} Hz

// RMS and waveform length (WL) of one window, the same as in Python
static inline void emg_features(const float *x, int n, float f[2]) {{
  float s2 = 0.0f, wl = 0.0f;
  for (int i = 0; i < n; i++) {{
    s2 += x[i] * x[i];
    if (i > 0) wl += fabsf(x[i] - x[i - 1]);
  }}
  f[0] = sqrtf(s2 / n);
  f[1] = wl;
}}

{code}""")
    return same


def test(key, force):
    out = os.path.join(RESULTS, "test_result.md")
    if os.path.exists(out) and not force:
        sys.exit("results/test_result.md already exists: the test sessions were already opened once.\n"
                 "Opening them again to try other models would be leakage. (--force only if you know why.)")
    Xtr, ytr, _ = load_windows({"train"})
    title, make = MODELS[key]
    m = make().fit(Xtr, ytr)
    Xte, yte, ste = load_windows({"test"})
    p = m.predict(Xte)
    acc, bacc = accuracy_score(yte, p), balanced_accuracy_score(yte, p)
    cm = confusion_matrix(yte, p, labels=[0, 1])
    per = {s: accuracy_score(yte[ste == s], p[ste == s]) for s in sorted(set(ste))}
    same = write_header(key, m, Xtr)
    verdict = "reaches" if acc > GOAL else "does not reach"
    text = f"""# Test result (opened once)

Model: {title} (`{key}`), trained on all windows of S01 to S04 ({len(ytr)} windows), then scored once on the
test sessions S05 and S06 ({len(yte)} windows of {WIN} ms, new electrodes, never seen in training).

| | Value |
|---|---|
| Accuracy | **{acc:.1%}** |
| Balanced accuracy | {bacc:.1%} |
{chr(10).join(f'| Accuracy on {s} | {a:.1%} |' for s, a in per.items())}

The model {verdict} the course goal of more than {GOAL:.0%} on sessions it never saw.

Confusion matrix (rows: true class, columns: answer of the model):

| | answered rest | answered movement |
|---|---|---|
| rest (reposo) | {cm[0, 0]} | {cm[0, 1]} |
| movement (mover) | {cm[1, 0]} | {cm[1, 1]} |

The model in C for the ESP32: `firmware/emg_model/emg_model.h`. On the training windows the C math gives the same
answer as scikit-learn in {same:.1%} of the windows.
"""
    os.makedirs(RESULTS, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(text)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--test", choices=list(MODELS), help="test ONCE on S05 and S06 with this model")
    ap.add_argument("--force", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()
    test(a.test, a.force) if a.test else select()
