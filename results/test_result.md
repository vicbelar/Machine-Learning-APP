# Test result (opened once)

Model: One threshold on the RMS (baseline) (`threshold`), trained on all windows of S01 to S04 (2240 windows), then scored once on the
test sessions S05 and S06 (1120 windows of 250 ms, new electrodes, never seen in training).

| | Value |
|---|---|
| Accuracy | **82.8%** |
| Balanced accuracy | 82.0% |
| Accuracy on S05 | 83.9% |
| Accuracy on S06 | 81.6% |

The model reaches the course goal of more than 75% on sessions it never saw.

Confusion matrix (rows: true class, columns: answer of the model):

| | answered rest | answered movement |
|---|---|---|
| rest (reposo) | 560 | 80 |
| movement (mover) | 113 | 367 |

The model in C for the ESP32: `firmware/emg_model/emg_model.h`. On the training windows the C math gives the same
answer as scikit-learn in 100.0% of the windows.
