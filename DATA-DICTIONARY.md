# Data dictionary

## `data/metadata.csv`
One row describes one recording. The app Captura ML writes this file.

| Column | Meaning | Unit or allowed values |
|---|---|---|
| file_name | the file in `data/raw/` | participant_session_recording.csv, e.g. `P01_S01_R01.csv` |
| participant | the code of the person | P01, ... never a name |
| session | one electrode placement | S01 to S06 |
| date | the day of the session | year-month-day |
| recording | the number of the recording inside its session | 1, 2, ... |
| trials | complete trials in the recording | count |
| rest_s, warning_s, move_s, between_s | the windows of one trial | seconds |
| fs_hz | sampling frequency | hertz |
| movement, muscle, side | the task and where the sensor sits | text |
| electrode_type, electrode_distance_cm | the electrodes and the distance between them | text, centimetres |
| skin_preparation | how the skin was cleaned | text |
| sensor_model, gain | the circuit and its gain | text |
| adc_bits | the bits of the converter | 12 |
| channels | the channels in the file | `raw_mV;emg_mV` |
| cue | the cue the person watched | text |
| set | the use of the recording | `train` (S01 to S04) or `test` (S05, S06) |
| samples | samples in the file | count |
| missing_samples | samples lost over Bluetooth (empty cells) | count |
| trials_rejected | trials that the cleaning rule rejected | count |
| notes | the reason for each rejection, or `kept` | text |

## `data/raw/*.csv`
One row is one sample, 1 ms apart.

| Column | Meaning | Unit or allowed values |
|---|---|---|
| time_ms | time from the start of the recording, from the sample index | milliseconds |
| raw_mV | input of the converter, no digital filter (after the analog circuit, with its 1.65 V offset) | millivolts, 0 to about 3100; empty = missing |
| emg_mV | the same signal after the digital filters of `PROTOCOL.md` | millivolts, centered on 0; empty = missing |
| label | the window of the trial at this sample | `reposo`, `aviso`, `mover`, `entre` |
| trial | the trial number inside the recording | 1 to 5 |

The two classes of the model are `mover` (movement) and `reposo` (rest). The windows `aviso` (warning) and `entre` (rest just after the movement) are kept in the raw file but not used to train.

## `edge_impulse/{training,testing}/*.csv`
One file is one window of one kept trial: `label.P01_Sxx_Ryy_Tk.csv`, with the columns `timestamp` (ms) and `emg_mV`. The label is the text before the first dot. Missing samples inside a kept trial (at most 1 %) are filled by straight lines between neighbors only in these files; `data/raw/` keeps the gaps.
