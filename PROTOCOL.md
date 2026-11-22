# Protocol

Written so that a person outside the group can repeat the recording.

1. **Sensor and site.** Disposable Ag/AgCl gel electrodes (55 mm), [TODO] cm apart, over the finger flexors and the flexor carpi radialis, in the upper third of the right forearm, along the muscle fibers. The reference electrode on [TODO: e.g. the bony part of the elbow]. The skin is cleaned with isopropyl alcohol first. Circuit: PERLA EMG board, AD620 instrumentation amplifier, total gain [TODO]. Source for the position: Hermens and others, 2000 (SENIAM) [1], and the placement we already use in PERLA.
2. **Posture.** Seated. Forearm on the table, palm up, elbow at about 90°.
3. **Task.** During the action window, contract the muscles of the right forearm (*contracción*) and hold the contraction until the window ends (3 s), with a steady, comfortable force. Relax during rest. These are the muscles the child uses in the PERLA game.
4. **Trial.** Rest 4 s, warning cue 1 s, action 3 s, rest 3 s. Total 11 s.
5. **Recording.** 5 trials without a pause. Total 55 s. One minute of pause between recordings.
6. **Cue.** The person watches the timer of the app Captura ML (`cue/cue-video.mp4` is a screen recording of it). The text and the color change in each window, with a beep: Reposo, Prepárate (yellow), CONTRACCIÓN (green), Reposo. During the green window a beat sounds at a fixed rhythm (30 beats per minute by default, one every 2 s, with two alternating tones) that only marks the time: the person holds the contraction during the whole window and does not contract again with each beat. The rhythm is counted with the received samples, the same clock as the labels. The same cue for every recording.
7. **Session.** New electrodes at the start, placed again from zero. [TODO 4] recordings. Six sessions on three days, two per day. Sessions S05 and S06 are the test sessions.
8. **Settings.** Sampling at 1000 Hz with a hardware timer of the ESP32 (12-bit converter, each sample is the mean of 4 readings, in calibrated millivolts). Each file in `data/raw/` has the columns `time_ms`, `raw_mV`, `emg_mV`, `label` and `trial`. `time_ms` comes from the sample index (1 ms per sample); a sample lost over Bluetooth stays as an empty cell, so the time column never jumps.
9. **Filters.** In this order:

   | Stage | Type and order | Limits | Where |
   |---|---|---|---|
   | Instrumentation amplifier | AD620 | gain [TODO] | analog |
   | Band-pass | Sallen-Key Butterworth, 8th order | 10 to 300 Hz | analog |
   | Notch | 8th order | 58 to 63 Hz | analog |
   | Offset | summing amplifier | +1.65 V, to fit the 0–3.3 V converter | analog |
   | → `raw_mV` is taken here | | | |
   | Notch | IIR biquad, 2nd order | 60 Hz, Q ≈ 6 | ESP32 |
   | High-pass | Butterworth biquad, 2nd order | 20 Hz | ESP32 |
   | Low-pass | Butterworth biquad, 2nd order | 300 Hz | ESP32 |
   | Artifact rejection | a sample with \|y\| > 1000 mV is set to 0 | | ESP32 |
   | → `emg_mV` is taken here | | | |

   The upper limit (300 Hz) is below half of the sampling rate (500 Hz). The high-pass at 20 Hz removes movement artifacts and the baseline drift [2]; the useful energy of surface EMG lies roughly between 20 and 400 to 500 Hz [3]. The notch removes the 60 Hz power line of Mexico. The signal is not smoothed into an envelope: both channels are the full signal.
10. **Repeat a recording when** the person moves at the wrong time, an electrode comes loose, or the app shows many lost samples. Write it in the notes of the session; we do not delete files from `data/raw/`.
11. **Consent.** Each participant agreed to the recording. We use codes, never names.

## Sources
1. Hermens HJ, Freriks B, Disselhorst-Klug C, Rau G. Development of recommendations for SEMG sensors and sensor placement procedures. *J Electromyogr Kinesiol* 10(5):361–374, 2000. https://doi.org/10.1016/S1050-6411(00)00027-4
2. De Luca CJ, Gilmore LD, Kuznetsov M, Roy SH. Filtering the surface EMG signal: movement artifact and baseline noise contamination. *J Biomech* 43(8):1573–1579, 2010. https://doi.org/10.1016/j.jbiomech.2010.01.027
3. Merletti R, Cerone GL. Tutorial: surface EMG detection, conditioning and pre-processing: best practices. *J Electromyogr Kinesiol* 54:102440, 2020. https://doi.org/10.1016/j.jelekin.2020.102440

## We read the method and we agree
Each member adds their own line from their own GitHub account.

- M03, [TODO date], I read the method and I agree.
- M01, 2026-11-21, I read the method and I agree.
