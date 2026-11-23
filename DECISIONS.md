# Decisions about what comes next

For each part we write three short lines: what we, or our AI tool, chose. The reason, in our own words. What we still do not understand.
We choose with the training sessions (S01 to S04) only, and we open the test sessions (S05 and S06) once, at the end.

## Tool: Python in VS Code, not Edge Impulse
**Chose.** We do the whole machine learning part with our own Python code in VS Code (`code/`), with NumPy, scikit-learn and matplotlib. We do not use Edge Impulse.
**Reason, in our own words.**
- We see every step. In Edge Impulse the features and the model live inside blocks that we only set with buttons. In our code each step is a few lines that we can read: how we cut the 250 ms windows, how we compute the RMS and the WL, how we split by session.
- We see the exact change. The code and its results (`results/`, `figures/`) are files in this repository, so every change to a feature or to the model is one commit on GitHub, and we can compare the numbers before and after. In Edge Impulse a change in the web page leaves no trace in our repository.
- Changing or adding a feature is easy. A new feature is a new function in `code/train_model.py`; we run the script again and get a new `results/selection.md`. We can ask our AI tool to explain, write or check that function in the same editor, and we read the code it writes before we keep it.
- The split stays fair by construction. The script reads the column `set` of `data/metadata.csv` and opens S05 and S06 only with `--test`, and only once. We do not have to remember to upload folders into the right category or to turn off the automatic 80/20 split, which would mix sessions (leakage).
- We repeat everything without an account. Anyone can run `python code/train_model.py` on `data/raw/` and get the same numbers. Nothing depends on a project in a web page that only one member can open.
- The model goes to the ESP32 without a library. The script writes the chosen model as plain C (`firmware/emg_model/emg_model.h`) and checks that the C math gives the same answer as Python. Our recording firmware already uses 35 % of the program space, so a few lines of C fit better than a full exported library.
**Not understood yet.** Whether we will need a tool like Edge Impulse later, if we move to bigger models or many more features.

## 7. Features
**Chose.** Start with two numbers per window of 250 ms of `emg_mV`: the root mean square (RMS) and the waveform length (WL). Both are computed in `code/train_model.py`, so we know the exact math of each one. If they are not enough, we add more features there, one function each (for example a frequency feature), and compare the new `results/selection.md` with the old one.
**Reason, in our own words.** PERLA already moves the turtle with the RMS, so we know it rises when the forearm muscles contract. WL also grows with the size and speed of the signal. In `figures/two_features.png` (250 ms windows of the training sessions S01 to S04 only; made with `code/make_figures.py`) movement sits higher than rest: median RMS 49.7 mV against 26.0 mV. The classes overlap at low values, because a movement window also holds the start and the end of the contraction. RMS and WL rise together, so WL may add little. On these training windows one RMS threshold (37 mV) puts 85 % of the windows in the right class; this number is optimistic, because it is measured on the same data that chose the threshold.
**Not understood yet.** Whether a feature about frequency adds anything when we only have two classes.
**Sources.** Hudgins B, Parker P, Scott RN. A new strategy for multifunction myoelectric control. *IEEE Trans Biomed Eng* 40(1):82–94, 1993. https://doi.org/10.1109/10.204774 · Phinyomark A, Phukpattaranont P, Limsakul C. Feature reduction and selection for EMG signal classification. *Expert Syst Appl* 39(8):7420–7431, 2012. https://doi.org/10.1016/j.eswa.2012.01.102

## 8. Model
We compare three kinds of model, from the simplest to the most flexible, all trained on S01 to S04 with `code/train_model.py` (scikit-learn).

| Option | In plain words | What it keeps after training |
|---|---|---|
| One threshold on the RMS | what PERLA does today: "movement if the size is above this number" | one number |
| Logistic regression | a straight border between the two classes | a few numbers |
| Small neural network (scikit-learn, 1 hidden layer of 8) | a few neurons that learn a curved border | some dozens of weights |

The threshold is our baseline: a model is only worth it if it beats the threshold on S05 and S06. Goal: more than 75 % right on those sessions.
**Reason, in our own words.** With two classes that sit apart, the simple options may be enough, and they are easy to run on the ESP32.
**First comparison, training sessions only** (`code/train_model.py`, details in `results/selection.md`). We train on three of S01 to S04 and score on the fourth, four times. Mean balanced accuracy: threshold 83.7 %, logistic regression 81.9 %, small network 83.5 %. The three are close; all of them drop to about 70 % when S04 is left out, the session with the most noise at rest. A more flexible model does not help with two features, so the threshold stays the strongest candidate. The test sessions are still closed.
**Chose, and tested once.** The RMS threshold (37.2 mV on 250 ms windows), trained on S01 to S04. We then opened S05 and S06 once: **82.8 % right** (S05 83.9 %, S06 81.6 %; balanced 82.0 %), above the goal of 75 %. Most errors are movement windows called rest (113 of 480), likely the start and end of each contraction. Details in `results/test_result.md`; the model in C is `firmware/emg_model/emg_model.h`.
**Not understood yet.** How the logistic regression and the network find the border, and how to know that a better score is not luck.
**Sources.** scikit-learn user guide, https://scikit-learn.org/stable/user_guide.html · NumPy user guide, https://numpy.org/doc/stable/user/ · Wilson G and others. Good enough practices in scientific computing. *PLOS Comput Biol* 13(6):e1005510, 2017. https://doi.org/10.1371/journal.pcbi.1005510

## 9. Route
**Chose.** The model runs on the ESP32 as TinyML: `code/train_model.py` writes it as plain C in `firmware/emg_model/emg_model.h`, with no library. The next step is to include that file in the firmware of the board. After each measurement, the board saves one record in **Firebase Cloud Firestore**, the database that PERLA already uses for its sessions: date and time, session, the code of the person, the features, and the answer of the model.
**Reason, in our own words.** The board answers fast and works without a computer. The chosen model is one threshold on the RMS, so in C it is a few lines and one number, and we can read it and check it against Python. And PERLA already sends its sessions to Firestore through the screen of the whale, so the doctor sees everything in the same app.
**Proof.** Board of the EMG: ESP32 Dev Module (ESP32 with 520 KB of RAM and 4 MB of flash). Our recording firmware already uses 35 % of the program space and 22 % of the RAM for global variables, so the model has to be small. The screen of the whale is a WT32-SC01 Plus (ESP32-S3 with 2 MB of PSRAM). Not done yet: a screenshot of Firestore with one saved record and its metadata, made with the account of a member.
**Not understood yet.** Whether the model should run on the ESP32 of the EMG or on the ESP32-S3 of the screen, and how much RAM the model needs.
