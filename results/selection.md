# Model selection (training sessions only)

Made with `code/train_model.py`. Windows of 250 ms of `emg_mV`, features RMS, WL. 2240 windows from S01, S02, S03, S04: 1280 rest, 960 movement. The test sessions (S05, S06) are not opened here.

Leave one session out: train on three sessions, score on the fourth. Balanced accuracy is the mean of the accuracy of each class, so the extra rest windows do not help a model that says 'rest' too often.

| Model | left out S01 | left out S02 | left out S03 | left out S04 | Mean accuracy | Mean balanced accuracy |
|---|---|---|---|---|---|---|
| One threshold on the RMS (baseline) (`threshold`) | 90% | 90% | 89% | 70% | 84.5% | 83.7% ± 7.7% |
| Logistic regression (a straight border) (`logreg`) | 86% | 89% | 86% | 68% | 82.4% | 81.9% ± 6.9% |
| Small neural network (1 hidden layer of 8) (`mlp`) | 90% | 90% | 88% | 68% | 84.0% | 83.5% ± 8.0% |

Highest mean balanced accuracy: `threshold`. A simpler model is worth keeping when the difference is small: it is easier to explain and to run on the ESP32.

Next step, once: `python code/train_model.py --test <model>`.
