# Changelog

## 2026-11-21
- Removed the accelerometer (TactSuit) part from the app: the device-type choice is gone and the app is EMG only.
  Accelerometer projects already saved in a browser are hidden, not deleted.

## v1-report, [TODO date]
- Added sessions S03 to S06, the quality report, the metadata of every recording and the split by session.
- Why: the test needs sessions with new electrodes that the model never saw.

## v0-first, [TODO date]
- First version: protocol, cue, the app Captura ML with the trial timer, and the first recordings (S01, S02).
- The ESP32 now sends the raw signal of the converter (`raw_mV`) as well as the filtered one, so we can check saturation.
