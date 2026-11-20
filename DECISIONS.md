# Decisions about what comes next

For each part we write three short lines: what we, or our AI tool, chose. The reason, in our own words. What we still do not understand.
We choose with the training sessions (S01 to S04) only, and we open the test sessions (S05 and S06) once, at the end.

## 7. Features
**Chose.** Start with two numbers per window of 250 ms of `emg_mV`: the root mean square (RMS) and the waveform length (WL). Then compare them with the "Spectral analysis" block of Edge Impulse.
**Reason, in our own words.** PERLA already moves the turtle with the RMS, so we know it rises when the hand closes. WL also grows with the size and speed of the signal. We check in a plot of S01 that movement and rest sit apart ([TODO] `figures/two_features.png`).
**Not understood yet.** Whether a feature about frequency adds anything when we only have two classes.
**Sources.** Hudgins B, Parker P, Scott RN. A new strategy for multifunction myoelectric control. *IEEE Trans Biomed Eng* 40(1):82–94, 1993. https://doi.org/10.1109/10.204774 · Phinyomark A, Phukpattaranont P, Limsakul C. Feature reduction and selection for EMG signal classification. *Expert Syst Appl* 39(8):7420–7431, 2012. https://doi.org/10.1016/j.eswa.2012.01.102

## 8. Model
**Not decided yet.** We compare three kinds of model, from the simplest to the most flexible, all trained on S01 to S04.

| Option | In plain words | What it keeps after training |
|---|---|---|
| One threshold on the RMS | what PERLA does today: "movement if the size is above this number" | one number |
| Logistic regression | a straight border between the two classes | a few numbers |
| Small neural network (Edge Impulse classifier) | a few layers that learn the border | some kilobytes of weights |

The threshold is our baseline: a model is only worth it if it beats the threshold on S05 and S06. Goal: more than 75 % right on those sessions.
**Reason, in our own words.** With two classes that sit apart, the simple options may be enough, and they are easy to run on the ESP32.
**Not understood yet.** How the logistic regression and the network find the border, and how to know that a better score is not luck.
**Sources.** scikit-learn user guide, https://scikit-learn.org/stable/user_guide.html · Edge Impulse documentation, https://docs.edgeimpulse.com/

## 9. Route
**Chose.** The model runs on the ESP32 as TinyML: Edge Impulse exports it as an Arduino library. After each measurement, the board saves one record in **Firebase Cloud Firestore**, the database that PERLA already uses for its sessions: date and time, session, the code of the person, the features, and the answer of the model.
**Reason, in our own words.** The board answers fast and works without a computer, and PERLA already sends its sessions to Firestore through the screen of the whale, so the doctor sees everything in the same app.
**Proof.** [TODO] the name of the board and its memory (ESP32: 520 KB of RAM; WT32-SC01 Plus: ESP32-S3 with 2 MB of PSRAM), and a screenshot of Firestore with one saved record and its metadata, made with the account of a member.
**Not understood yet.** Whether the model should run on the ESP32 of the EMG or on the ESP32-S3 of the screen, and how much RAM the model needs.
