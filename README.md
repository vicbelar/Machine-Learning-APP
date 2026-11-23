# PERLA · Report 1: the data stage

Course: M6 Machine Learning and IoT apps. Team 6, group 604.

Project: **PERLA** (Plataforma Electromiográfica de Rehabilitación Lúdica Adaptativa), a rehabilitation game for children with cerebral palsy at Instituto Nuevo Amanecer. In PERLA, the child closes the hand and a robotic turtle moves. Today the turtle moves when the RMS of one surface EMG channel passes a threshold. Here we build the data to replace that threshold with a model: **tell a contraction of the forearm muscles from rest, with one muscle signal of the forearm.**

> Lines marked `[TODO]` are filled after the recordings. Remove the marks before the tag `v1-report`.

## The team

| Member code | GitHub user | In charge of | AI tool |
|---|---|---|---|
| M01 | @LupitaMotaReyes | data and metadata | Claude |
| M02 | @vicbelar | recording app (Captura ML) | Claude |
| M03 | @a00842656-spec | ESP32 firmware, trial protocol in the app, quality report | Claude |
| M04 | @[TODO] | protocol, cue video and photos | [TODO] |

Every member has at least one commit. See the commit list of this repository. We measure one person, member [TODO M0x]. In the data that person has the code P01.

## The six parts

### 1. Data acquisition
24 recordings, 120 trials, 6 sessions, 1 person. Disposable Ag/AgCl gel electrodes about 2 cm apart. One channel of surface EMG on the finger flexors and the flexor carpi radialis of the right forearm, with the PERLA circuit (AD620 instrumentation amplifier with a total gain of 10, 8th-order band-pass 10 to 300 Hz, 8th-order notch at 60 Hz, offset to 1.65 V) and an ESP32 that samples at **1000 Hz** with a hardware timer. The ESP32 sends two channels over Bluetooth to our web app [Captura ML](https://vicbelar.github.io/Machine-Learning-APP/) (its code is in this repository, see `APP.md`):

- `raw_mV`: the input of the converter, in millivolts, with no digital filter. It is the analog output of the circuit, so it is already filtered by the analog stage.
- `emg_mV`: the same signal after the digital filters of PERLA (see `PROTOCOL.md`).

The app stores every sample in the browser and exports the files. Nothing is saved on the ESP32.

**Evidence:** `data/raw/` (24 files), `data/metadata.csv` (24 rows), `cue/`, the app (`index.html`, `app.js`, `style.css`) and the firmware (`firmware/EMG_Captura_BLE/`).

### 2. Task
The person contracts the muscles of the right forearm (*contracción*) and holds the contraction during the whole action window (3 s), then relaxes. These are the muscles a child uses to move the turtle in PERLA. Two classes: **movement** (`mover`) and **rest** (`reposo`). The person sits, with the forearm on the table and the palm up.

**Evidence:** `PROTOCOL.md`, `figures/placement_S01.jpg`.

### 3. Trial and cue timing
| Window | Seconds | What the person sees in the app |
|---|---|---|
| Rest before | 0 to 4 | Reposo |
| Warning cue | 4 to 5 | Prepárate (yellow, beep) |
| Action window | 5 to 8 | CONTRACCIÓN (green, beep) |
| Rest between trials | 8 to 11 | Reposo (beep) |

One recording holds 5 trials, so it lasts 55 s. The app shows the cue from the count of received samples, so the label in the file and the cue on the screen use the same clock.

**Evidence:** `cue/cue-video.mp4`, the columns `rest_s`, `warning_s`, `move_s`, `between_s` of `data/metadata.csv`, the columns `label` and `trial` of each file in `data/raw/`, `figures/one_recording_marked.png`.

### 4. Sessions
1 person. 6 sessions on 3 different days: 19 November 2026 (S01, S02), 20 November (S03, S04) and 21 November (S05, S06). Every session starts with new electrodes, placed again from zero. Each session has 4 recordings, with one minute of pause between recordings.

**Evidence:** the columns `participant`, `session` and `date` of `data/metadata.csv`, one photo per session in `figures/`.

### 5. Cleaning
Filters: the analog band-pass and notch of the PERLA circuit, then a digital notch at 60 Hz (the power line in Mexico), a high-pass at 20 Hz and a low-pass at 300 Hz in the ESP32. The type, order and limits of each filter, with their source, are in `PROTOCOL.md`. The upper limit, 300 Hz, is below half of our sampling rate (500 Hz).

Rule to reject a trial, written before we looked at any score: reject it if one sample of `raw_mV` sits at the limit of the converter (≤ 20 mV or ≥ 3050 mV), or if more than 1 % of its samples are missing. Samples lost over Bluetooth stay as empty cells, never as zeros.

Result: 0 of 120 trials rejected. 120 remain. The raw files are untouched.

**Evidence:** `QUALITY-REPORT.md`, `code/check_quality.py`, the columns `trials_rejected` and `notes` of `data/metadata.csv`.

### 6. Fair split
Training: sessions S01 to S04, 80 trials (160 windows in Edge Impulse: 80 `mover`, 80 `reposo`). Test: sessions S05 and S06, 40 trials (80 windows: 40 `mover`, 40 `reposo`), recorded on another day with new electrodes. The model never sees these two sessions in training. We do not use the automatic 80/20 split of Edge Impulse: we upload `edge_impulse/training/` and `edge_impulse/testing/` into each category by hand. We do not cut windows of one recording into both sets.

Limit: the model is built and tested on one adult and one movement. We do not claim that it works for other people, and not for the children of PERLA.

**Evidence:** the column `set` of `data/metadata.csv`, the folders `edge_impulse/training/` and `edge_impulse/testing/`.

## What comes next
Our decisions about features, the model and the route are in `DECISIONS.md`. The rationale of each member is in `rationale/`, and a screenshot of each member's AI tool is in `ai-tools/`.

## How to repeat our recording
Read `PROTOCOL.md`. Load `firmware/EMG_Captura_BLE` on the ESP32, open the app [Captura ML](https://vicbelar.github.io/Machine-Learning-APP/) in Chrome (how to use it: `APP.md`), and use the same protocol values. It is enough to record the same way without asking us.

## Files

| Path | What it holds |
|---|---|
| `data/raw/P01_Sxx_Ryy.csv` | one recording: `time_ms`, `raw_mV`, `emg_mV`, `label` (reposo, aviso, mover, entre), `trial` |
| `data/metadata.csv` | one row per recording, see `DATA-DICTIONARY.md` |
| `edge_impulse/` | the windows of the kept trials, split by session, ready for Edge Impulse |
| `QUALITY-REPORT.md` | rejected trials and the reason, noise at rest and in movement |
| `code/check_quality.py` | checks the rule again from `data/raw/`, without the app |
| `code/make_figures.py` | makes `figures/one_recording_marked.png` and `figures/two_features.png` from `data/raw/` (training sessions only) |
| `index.html`, `app.js`, `style.css`, `APP.md` | the recording app Captura ML and how to use it |
| `firmware/` | the ESP32 code that reads the EMG and sends it to the app |
| `cue/`, `figures/` | cue video, electrode photos (no faces), figures |

## Versions
Two versions are marked on GitHub: **v0-first** and **v1-report**. See `CHANGELOG.md`.

## Where we searched
- Merletti R. *Standards for Reporting EMG Data*. ISEK, 1999. And Merletti R, Cerone GL. Tutorial: surface EMG detection, conditioning and pre-processing: best practices. *J Electromyogr Kinesiol* 54:102440, 2020. https://doi.org/10.1016/j.jelekin.2020.102440
- Hermens HJ and others. Development of recommendations for SEMG sensors and sensor placement procedures. *J Electromyogr Kinesiol* 10(5):361–374, 2000. https://doi.org/10.1016/S1050-6411(00)00027-4
- Riascos Salas J, Molinas M, Lotte F. Machine learning methods for BCI: challenges, pitfalls and promises. ESANN 2024. https://www.esann.org/sites/default/files/proceedings/2024/ES2024-4.pdf
- Wilson G and others. Good enough practices in scientific computing. *PLOS Comput Biol* 13(6):e1005510, 2017. https://doi.org/10.1371/journal.pcbi.1005510
