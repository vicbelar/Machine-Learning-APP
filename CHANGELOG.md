# Changelog

## 2026-11-23
- Added the dataset: `data/raw/` (24 recordings, untouched), `data/metadata.csv`, `QUALITY-REPORT.md` and `edge_impulse/` (160 training and 80 testing windows), exported by the app.
- Corrected `data/metadata.csv` by hand, not the raw files: `movement` said "Cerrar y abrir la mano", the old default text of the app, but the person held a contraction, so it now says "Contracción sostenida"; `electrode_distance_cm` was empty and is now 2 (about 2 cm in every session); `gain` was empty and is now 10 (total gain of the circuit; AD620 with RG = 5.6 kΩ); added `move_bpm` = 0 (no rhythm beat was used).
- The app now uses "Contracción sostenida" and no rhythm beat (`move_bpm` = 0) by default, the same as our recordings.

## 2026-11-21
- Removed the accelerometer (TactSuit) part from the app: the device-type choice is gone and the app is EMG only.
  Accelerometer projects already saved in a browser are hidden, not deleted.

## v1-report, [TODO date]
- Added sessions S03 to S06, the quality report, the metadata of every recording and the split by session.
- Why: the test needs sessions with new electrodes that the model never saw.

## v0-first, [TODO date]
- First version: protocol, cue, the app Captura ML with the trial timer, and the first recordings (S01, S02).
- The ESP32 now sends the raw signal of the converter (`raw_mV`) as well as the filtered one, so we can check saturation.
