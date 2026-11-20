'use strict';
/*
 * Captura ML — app web para grabar datos de EMG (Ballena Monitor) o acelerómetro
 * (TactSuit) por Bluetooth (Web Bluetooth, servicio Nordic UART) y exportarlos
 * como CSV para Edge Impulse. Todo se guarda en el navegador (IndexedDB), no en el ESP.
 *
 * Protocolo con el ESP32 (ver README.md):
 *   app -> ESP (RX, write):   "START\n", "STOP\n", "INFO\n"
 *   ESP -> app (TX, notify):  "#INFO,<nombre>,<fs_hz>,<canal1;canal2;...>,<escala>\n"
 *                             "D,<seq>,<v1>,<v2>,...\n"   (enteros; valor real = v / escala;
 *                              con varios canales van intercalados: ax,ay,az,ax,ay,az,...)
 *
 * Proyectos EMG nuevos (PERLA) usan el PROTOCOLO del curso (Report 1):
 *   - cada grabación = N trials: reposo -> aviso -> movimiento -> reposo, con un temporizador en pantalla
 *   - sesiones S01, S02, ... (una sesión = electrodos nuevos); las sesiones de prueba se eligen en el protocolo
 *   - el ZIP sale con la estructura del repositorio: data/raw/, data/metadata.csv, QUALITY-REPORT.md
 *     y edge_impulse/training|testing (separado por sesión, nunca al azar)
 * Proyectos de acelerómetro y proyectos EMG viejos siguen con las carpetas + metrónomo.
 */

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const NUS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // app -> ESP
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // ESP -> app
};
const TZ = 'America/Monterrey';
const MAX_RECS = 30;          // grabaciones máximas por movimiento
const COUNTDOWN_S = 3;        // cuenta regresiva antes de grabar
const MIN_SAVE_S = 1;         // si se detiene antes de esto, no se guarda

// ---- Protocolo EMG (PERLA) ----
// Regla de calidad (fijada ANTES de ver cualquier resultado del modelo):
//   se rechaza un trial si una muestra cruda toca el límite del ADC, o si falta más del 1 % de sus muestras.
const SAT_LOW_MV = 20;        // mismos límites que EMG_Emisor (ADC del ESP32: 0 a ~3.1 V)
const SAT_HIGH_MV = 3050;
const MAX_MISSING = 0.01;
const PHASE_LABELS = ['reposo', 'aviso', 'mover', 'entre'];   // columna "label" de data/raw
const EMG_PROTOCOL_DEFAULT = {
  participant: 'P01',
  movement: 'Cerrar y abrir la mano',
  cue_text: 'CIERRA Y ABRE LA MANO',
  muscle: 'Flexores de los dedos y flexor radial del carpo',
  side: 'derecho',
  rest_s: 4, warning_s: 1, move_s: 3, between_s: 3,
  trials: 5,
  recs_per_session: 4,
  test_sessions: 'S05,S06',
  electrode_type: 'Ag/AgCl desechables con gel, 55 mm',
  electrode_distance_cm: '',
  skin_preparation: 'Alcohol isopropílico',
  sensor_model: 'AD620 + filtros activos (circuito PERLA)',
  gain: '',
  adc_bits: 12,
};
const PROTOCOL_FIELDS = [
  { k: 'participant', label: 'Código de la persona', ph: 'P01' },
  { k: 'movement', label: 'Movimiento', ph: 'Cerrar y abrir la mano' },
  { k: 'cue_text', label: 'Texto en pantalla durante el movimiento', ph: 'CIERRA Y ABRE LA MANO' },
  { k: 'muscle', label: 'Músculo', ph: 'Flexores de los dedos' },
  { k: 'side', label: 'Lado', ph: 'derecho' },
  { k: 'rest_s', label: 'Reposo (s)', num: true },
  { k: 'warning_s', label: 'Aviso (s)', num: true },
  { k: 'move_s', label: 'Movimiento (s)', num: true },
  { k: 'between_s', label: 'Reposo entre trials (s)', num: true },
  { k: 'trials', label: 'Trials por grabación', num: true, int: true },
  { k: 'recs_per_session', label: 'Grabaciones por sesión', num: true, int: true },
  { k: 'test_sessions', label: 'Sesiones de prueba', ph: 'S05,S06' },
  { k: 'electrode_type', label: 'Tipo de electrodo', ph: 'Ag/AgCl con gel' },
  { k: 'electrode_distance_cm', label: 'Distancia entre electrodos (cm)', ph: 'medirla', num: true, optional: true },
  { k: 'skin_preparation', label: 'Preparación de la piel', ph: 'alcohol' },
  { k: 'sensor_model', label: 'Sensor / circuito', ph: 'AD620 ...' },
  { k: 'gain', label: 'Ganancia total', ph: 'p. ej. 10 (AD620)' },
  { k: 'adc_bits', label: 'Bits del ADC', num: true, int: true },
];

// Tipos de dispositivo y movimientos sugeridos (las "carpetas" que se pueden agregar)
const DEVICE_TYPES = {
  emg: {
    label: 'EMG',
    plotSeconds: 3,
    catalog: [
      { id: 'flexion_extension', name: 'Extensión y flexión',
        phases: ['Extensión', 'Flexión'],
        hint: 'Extiende y flexiona la muñeca siguiendo el ritmo: un movimiento por cada pulso.' },
      { id: 'descanso', name: 'Reposo/equilibrio',
        phases: ['Relaja'],
        hint: 'Mano y antebrazo relajados, sin mover. Es la clase de “sin movimiento”.' },
      { id: 'pronacion_supinacion', name: 'Pronación y supinación',
        phases: ['Pronación', 'Supinación'],
        hint: 'Gira el antebrazo (palma abajo / palma arriba) siguiendo el ritmo.' },
    ],
  },
  acc: {
    label: 'Acelerómetro',
    plotSeconds: 10,
    catalog: [
      { id: 'linea_base', name: 'Línea base/equilibrio',
        phases: ['Quieto'],
        hint: 'De pie, quieto y relajado.' },
      { id: 'limites_estabilidad', name: 'Inclinaciones voluntarias',
        phases: ['Inclina', 'Regresa'],
        hint: 'Inclínate lo más posible sin dar un paso y regresa al centro, siguiendo el ritmo.' },
      { id: 'deriva_postural', name: 'Deriva postural inducida',
        phases: ['Deriva', 'Corrige'],
        hint: 'Registra la deriva inducida y la corrección.' },
      { id: 'recuperacion_perturbaciones', name: 'Recuperación de perturbaciones',
        phases: ['Perturbación', 'Recupera'],
        hint: 'Aplica la perturbación y deja que la persona recupere el equilibrio.' },
    ],
  },
};

// Dispositivos que ya vienen en la app. Se pueden agregar más desde la app ("vincular desde código").
const BUILTIN_DEVICES = [
  { id: 'ballena', type: 'emg', name: 'Ballena Monitor', namePrefix: 'Ballena-EMG',
    fs: 1000, channels: ['raw_mV', 'emg_mV'], scale: 10, builtin: true },
  { id: 'tactsuit', type: 'acc', name: 'TactSuit', namePrefix: 'TactSuit',
    fs: 100, channels: ['ax_g', 'ay_g', 'az_g'], scale: 1000, builtin: true },
];
const CH_COLORS = ['#1f7fb0', '#e0575b', '#2f9e6a', '#e8b54a'];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'proyecto';

const fmtMty = new Intl.DateTimeFormat('es-MX', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function mtyParts(ts) {
  const p = {};
  for (const x of fmtMty.formatToParts(new Date(ts))) p[x.type] = x.value;
  return p;
}
const fmtDate = (ts) => { const p = mtyParts(ts); return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`; };
const fileStamp = (ts) => { const p = mtyParts(ts); return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`; };

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- Protocolo ----
const trialLen = (p) => p.rest_s + p.warning_s + p.move_s + p.between_s;
function phaseAt(t, p) {
  const T = trialLen(p);
  const trial = Math.floor(t / T);
  const u = t - trial * T;
  let ph = 3;
  if (u < p.rest_s) ph = 0;
  else if (u < p.rest_s + p.warning_s) ph = 1;
  else if (u < p.rest_s + p.warning_s + p.move_s) ph = 2;
  return { trial, ph };
}
const isProto = (p) => !!(p && p.type === 'emg' && p.protocol);
const sessId = (n) => 'S' + pad(n);
const sessNum = (sid) => Number(String(sid).replace(/\D/g, '')) || 0;
function sessionSet(p, sid) {
  const test = String(p.protocol.test_sessions || '').toUpperCase().split(/[\s,;]+/).filter(Boolean)
    .map((x) => sessId(sessNum(x)));
  return test.includes(sid) ? 'test' : 'train';
}
const recBase = (r) => `${r.participant}_${r.session}_R${pad(r.n)}`;
const isoDate = (ts) => { const p = mtyParts(ts); return `${p.year}-${p.month}-${p.day}`; };
// Para graficar: si hay señal cruda y filtrada, se muestra solo la filtrada (la cruda tiene ~1650 mV de offset)
function viewChannel(data, channels) {
  const i = channels.indexOf('emg_mV');
  if (i < 0 || channels.length === 1) return { data, nCh: channels.length, names: channels };
  const nCh = channels.length;
  const n = Math.floor(data.length / nCh);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = data[k * nCh + i];
  return { data: out, nCh: 1, names: ['emg_mV'] };
}
// Ventanas de "mover" de una grabación, como fracción del total (para sombrearlas en la gráfica)
function moveBands(rec) {
  if (rec.kind !== 'protocol') return null;
  const p = rec.protocol, T = trialLen(p), total = rec.frames / rec.fs, out = [];
  for (let k = 0; k < rec.trials; k++) {
    const a = k * T + p.rest_s + p.warning_s;
    out.push([a / total, (a + p.move_s) / total]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base de datos local (IndexedDB)
// ---------------------------------------------------------------------------
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('captura-ml', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('recordings')) {
          d.createObjectStore('recordings', { keyPath: 'id' }).createIndex('byProject', 'projectId');
        }
        if (!d.objectStoreNames.contains('devices')) d.createObjectStore('devices', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  put: (store, v) => DB.run(store, 'readwrite', (s) => s.put(v)),
  del: (store, k) => DB.run(store, 'readwrite', (s) => s.delete(k)),
  all: (store) => DB.run(store, 'readonly', (s) => s.getAll()),
  recordings: (pid) => DB.run('recordings', 'readonly', (s) => s.index('byProject').getAll(pid)),
};

// ---------------------------------------------------------------------------
// Flujo de datos (Bluetooth o simulador)
// ---------------------------------------------------------------------------
const stream = {
  mode: null,           // 'ble' | 'sim' | null
  device: null, rx: null, tx: null,
  decoder: new TextDecoder(),
  buf: '',
  fs: 1000, channels: ['emg_mV'], scale: 10, devName: '',
  lastSeq: null, lastFrame: null,
  received: 0, lost: 0, lastDataAt: 0,
  ring: null, ringLen: 0, ringPos: 0, ringFilled: 0,
  simTimer: null, simSeq: 0, simT: 0,

  configure(fs, channels, scale, name) {
    this.fs = fs; this.channels = channels; this.scale = scale;
    if (name) this.devName = name;
    const type = DEVICE_TYPES[state.project?.type || 'emg'];
    this.ringLen = Math.round(fs * type.plotSeconds);
    this.ring = new Float32Array(this.ringLen * channels.length);
    this.ringPos = 0; this.ringFilled = 0;
    this.lastSeq = null; this.lastFrame = null;
    updateStreamInfo();
  },

  onChunk(dataView) {
    this.buf += this.decoder.decode(dataView, { stream: true });
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
    if (this.buf.length > 4096) this.buf = ''; // basura sin '\n'
  },

  onLine(line) {
    if (line.startsWith('#INFO')) {
      const p = line.split(',');
      const fs = Number(p[2]);
      const ch = (p[3] || '').split(';').filter(Boolean);
      const sc = Number(p[4]) || 1;
      if (fs > 0 && ch.length) {
        if (recorder.active) recorder.cancel('El dispositivo cambió su configuración.');
        this.configure(fs, ch, sc, p[1]);
      }
      return;
    }
    if (!line.startsWith('D,')) return; // otros mensajes (JSON, logs) se ignoran
    const p = line.split(',');
    const seq = Number(p[1]);
    const nCh = this.channels.length;
    const nVals = p.length - 2;
    const frames = Math.floor(nVals / nCh);
    if (!frames || !Number.isFinite(seq)) return;

    // Paquetes perdidos: se guardan como huecos (NaN = celda vacía en el CSV), no como ceros ni
    // repitiendo el último valor. Así la escala de tiempo sigue correcta y el hueco queda visible.
    if (this.lastSeq !== null) {
      const missed = (seq - ((this.lastSeq + 1) & 0xffff) + 0x10000) & 0xffff;
      if (missed > 0 && missed < 500) {
        const fill = new Float32Array(missed * frames * nCh).fill(NaN);
        this.lost += missed * frames;
        this.push(fill, missed * frames, true);
      }
    }
    this.lastSeq = seq;

    const arr = new Float32Array(frames * nCh);
    for (let k = 0; k < frames * nCh; k++) arr[k] = Number(p[k + 2]) / this.scale;
    this.lastFrame = arr.slice((frames - 1) * nCh);
    this.push(arr, frames, false);
  },

  push(arr, frames, filled) {
    const nCh = this.channels.length;
    for (let f = 0; f < frames; f++) {
      this.ring.set(arr.subarray(f * nCh, f * nCh + nCh), this.ringPos * nCh);
      this.ringPos = (this.ringPos + 1) % this.ringLen;
    }
    this.ringFilled = Math.min(this.ringLen, this.ringFilled + frames);
    if (!filled) { this.received += frames; this.lastDataAt = performance.now(); }
    recorder.append(arr, frames, filled);
  },

  // copia ordenada (vieja -> nueva) del buffer para graficar
  snapshot() {
    const nCh = this.channels.length;
    const n = this.ringFilled;
    const out = new Float32Array(n * nCh);
    const start = (this.ringPos - n + this.ringLen) % this.ringLen;
    for (let i = 0; i < n; i++) {
      const src = ((start + i) % this.ringLen) * nCh;
      for (let c = 0; c < nCh; c++) out[i * nCh + c] = this.ring[src + c];
    }
    return out;
  },

  async send(cmd) {
    if (this.mode !== 'ble' || !this.rx) return;
    const data = new TextEncoder().encode(cmd + '\n');
    try {
      if (this.rx.writeValueWithoutResponse && this.rx.properties.writeWithoutResponse) await this.rx.writeValueWithoutResponse(data);
      else await this.rx.writeValue(data);
    } catch (e) { console.warn('send', cmd, e); }
  },

  async connectBle() {
    const type = state.device;
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: type.namePrefix }, { services: [NUS.service] }],
      optionalServices: [NUS.service],
    });
    await this.stop();
    setBadge('Conectando…', 'off');
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(NUS.service);
    this.tx = await svc.getCharacteristic(NUS.tx);
    this.rx = await svc.getCharacteristic(NUS.rx);
    this.mode = 'ble';
    this.buf = ''; this.received = 0; this.lost = 0;
    this.configure(type.fs, type.channels, type.scale, device.name || type.namePrefix);
    this.tx.addEventListener('characteristicvaluechanged', (e) => this.onChunk(e.target.value));
    await this.tx.startNotifications();
    await this.send('INFO');
    await this.send('START');
    setBadge('Conectado', 'on');
    toast(`Conectado a ${this.devName}`);
  },

  onDisconnected() {
    if (this.mode !== 'ble') return;
    this.mode = null; this.rx = null; this.tx = null;
    setBadge('Desconectado', 'off');
    if (recorder.active) recorder.stop(true);
    toast('Se perdió la conexión Bluetooth');
    updateStreamInfo();
    updateRecordButton();
  },

  startSim() {
    const type = state.device;
    this.stop();
    this.mode = 'sim';
    this.received = 0; this.lost = 0;
    this.configure(type.fs, type.channels, type.scale, 'Simulador');
    const batch = Math.max(1, Math.round(type.fs * 0.02)); // un paquete cada 20 ms
    this.simSeq = 0; this.simT = 0;
    const isEmg = state.project.type === 'emg';
    this.simTimer = setInterval(() => {
      const vals = [];
      for (let i = 0; i < batch; i++) {
        const t = this.simT; this.simT += 1 / type.fs;
        if (isEmg) {
          let env;
          if (recorder.active && recorder.protocol) {
            // protocolo: actividad solo en la ventana de movimiento
            const { ph } = phaseAt((recorder.pos + i) / type.fs, recorder.protocol);
            env = 6 + (ph === 2 ? 120 : 0);
          } else {
            const period = 60 / (recorder.bpm || 30);
            const ph = (t % period) / period;
            const rest = recorder.active && recorder.movement?.id === 'descanso';
            env = 6 + (rest ? 0 : 140 * Math.max(0, Math.sin(Math.PI * ph)) ** 3);
          }
          const v = env * (Math.random() * 2 - 1) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 80 * t));
          if (this.channels.length === 2) vals.push(Math.round((1650 + v) * type.scale));  // raw_mV
          vals.push(Math.round(v * type.scale));
        } else {
          const ax = 0.08 * Math.sin(2 * Math.PI * 0.25 * t) + 0.01 * (Math.random() - 0.5);
          const ay = 0.06 * Math.cos(2 * Math.PI * 0.18 * t) + 0.01 * (Math.random() - 0.5);
          const az = 1 + 0.01 * (Math.random() - 0.5);
          vals.push(Math.round(ax * type.scale), Math.round(ay * type.scale), Math.round(az * type.scale));
        }
      }
      this.onLine(`D,${this.simSeq},${vals.join(',')}`);
      this.simSeq = (this.simSeq + 1) & 0xffff;
    }, 20);
    setBadge('Simulador', 'sim');
    toast('Simulador activo: datos falsos solo para probar la app');
  },

  async stop() {
    if (this.simTimer) { clearInterval(this.simTimer); this.simTimer = null; }
    if (this.mode === 'ble') {
      const dev = this.device;
      this.mode = null;
      try { await this.send('STOP'); } catch (_) { /* nada */ }
      try { dev?.gatt?.disconnect(); } catch (_) { /* nada */ }
    }
    this.mode = null; this.rx = null; this.tx = null;
    setBadge('Sin conexión', 'off');
    updateStreamInfo();
  },
};

// ---------------------------------------------------------------------------
// Grabación
// ---------------------------------------------------------------------------
const recorder = {
  active: false,        // grabando muestras
  counting: false,      // cuenta regresiva
  movement: null,
  bpm: 30,
  target: 0, pos: 0, data: null, lost: 0,
  startedAt: 0, beatTimer: null, countTimer: null, beatIndex: 0, wakeLock: null,
  audio: null,
  protocol: null, lastPh: -1, lastTrial: -1,   // solo en proyectos con protocolo

  beep(freq = 880, dur = 0.07) {
    if (!$('chkSound').checked) return;
    try {
      this.audio = this.audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = this.audio.createOscillator();
      const g = this.audio.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.15, this.audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.audio.currentTime + dur);
      o.connect(g).connect(this.audio.destination);
      o.start(); o.stop(this.audio.currentTime + dur);
    } catch (_) { /* sin audio */ }
  },

  async begin(movement) {
    if (!stream.mode) { toast('Primero conecta el dispositivo (o usa el simulador)'); return; }
    this.movement = movement;
    let seconds;
    if (isProto(state.project)) {
      this.protocol = { ...state.project.protocol };
      this.bpm = 0;
      seconds = this.protocol.trials * trialLen(this.protocol);
      if (!stream.channels.includes('raw_mV')) {
        toast('Aviso: el ESP no manda la señal cruda (raw_mV). Carga el firmware nuevo para poder revisar la saturación.', 5000);
      }
    } else {
      this.protocol = null;
      this.bpm = Number($('selBpm').value);
      seconds = Number($('selDuration').value);
    }
    this.counting = true;
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) { this.wakeLock = null; }
    setRecordingUI(true);
    let n = COUNTDOWN_S;
    const met = $('metronome');
    met.className = 'metronome count';
    $('phase').textContent = n;
    this.beep(660);
    this.countTimer = setInterval(() => {
      n--;
      if (n > 0) { $('phase').textContent = n; this.beep(660); return; }
      clearInterval(this.countTimer); this.countTimer = null;
      this.counting = false;
      this.startCapture(seconds);
    }, 1000);
  },

  startCapture(seconds) {
    const nCh = stream.channels.length;
    this.fs = stream.fs; this.channels = stream.channels.slice(); this.scale = stream.scale;
    this.target = Math.round(seconds * stream.fs);
    this.data = new Float32Array(this.target * nCh);
    this.pos = 0; this.lost = 0;
    this.startedAt = Date.now();
    this.active = true;
    this.beatIndex = 0;
    $('metronome').className = 'metronome recording';
    if (this.protocol) {
      this.lastPh = -1; this.lastTrial = -1;
      this.updatePhase();
      return;
    }
    this.beep(1200, 0.12);
    this.tick();
    if (this.bpm > 0) this.beatTimer = setInterval(() => this.tick(), 60000 / this.bpm);
    else $('phase').textContent = 'Grabando';
  },

  // Protocolo: la fase sale del número de muestras recibidas, así la etiqueta del CSV
  // y lo que vio la persona en pantalla usan el mismo reloj.
  updatePhase() {
    if (!this.active || !this.protocol) return;
    const p = this.protocol;
    const total = p.trials * trialLen(p);
    const { trial, ph } = phaseAt(Math.min(this.pos / this.fs, total - 1e-6), p);
    if (ph === this.lastPh && trial === this.lastTrial) return;
    this.lastPh = ph; this.lastTrial = trial;
    $('phase').textContent = ['Reposo', 'Prepárate', p.cue_text || 'Movimiento', 'Reposo'][ph];
    $('metronome').className = 'metronome recording' + (ph === 1 ? ' warn' : ph === 2 ? ' move' : '');
    if (ph === 1) this.beep(660);
    else if (ph === 2) this.beep(990, 0.15);
    else if (ph === 3) this.beep(520);
  },

  tick() {
    const phases = movePhases(this.movement);
    if (this.bpm <= 0) return;
    $('phase').textContent = phases[this.beatIndex % phases.length];
    const met = $('metronome');
    met.classList.add('beat');
    setTimeout(() => met.classList.remove('beat'), 180);
    this.beep(this.beatIndex % phases.length === 0 ? 990 : 740);
    this.beatIndex++;
  },

  append(arr, frames, filled) {
    if (!this.active) return;
    const nCh = this.channels.length;
    if (arr.length / frames !== nCh) return;
    const take = Math.min(frames, this.target - this.pos);
    this.data.set(arr.subarray(0, take * nCh), this.pos * nCh);
    this.pos += take;
    if (filled) this.lost += take;
    if (this.pos >= this.target) this.stop(true);
  },

  async stop(save) {
    clearInterval(this.beatTimer); this.beatTimer = null;
    clearInterval(this.countTimer); this.countTimer = null;
    const wasActive = this.active;
    this.active = false; this.counting = false;
    try { await this.wakeLock?.release(); } catch (_) { /* nada */ }
    this.wakeLock = null;
    setRecordingUI(false);
    if (!wasActive || !save) return;
    const nCh = this.channels.length;
    if (this.protocol) { await this.saveProtocol(); return; }
    if (this.pos < MIN_SAVE_S * this.fs) { toast('Grabación muy corta, no se guardó'); return; }
    const existing = (await DB.recordings(state.project.id)).filter((r) => r.label === this.movement.id);
    if (existing.length >= MAX_RECS) { toast(`Ya hay ${MAX_RECS} grabaciones de este movimiento`); return; }
    const n = existing.reduce((m, r) => Math.max(m, r.n), 0) + 1;
    const rec = {
      id: uid(),
      projectId: state.project.id,
      label: this.movement.id,
      n,
      createdAt: this.startedAt,
      fs: this.fs,
      channels: this.channels,
      scale: this.scale,
      frames: this.pos,
      lost: this.lost,
      bpm: this.bpm,
      source: stream.mode === 'sim' ? 'simulador' : stream.devName,
      data: this.data.slice(0, this.pos * nCh),
    };
    await DB.put('recordings', rec);
    this.beep(520, 0.25);
    toast(`Grabación #${n} guardada (${(this.pos / this.fs).toFixed(1)} s)`);
    await renderFolder();
  },

  // Guarda una grabación del protocolo: solo trials completos
  async saveProtocol() {
    const p = this.protocol;
    const nCh = this.channels.length;
    const T = trialLen(p);
    const trials = Math.floor(this.pos / this.fs / T + 1e-9);
    if (trials < 1) { toast('No se completó ni un trial: no se guardó'); return; }
    const frames = Math.min(this.pos, Math.round(trials * T * this.fs));
    const sid = state.movement.id;
    const existing = (await DB.recordings(state.project.id)).filter((r) => r.session === sid);
    const n = existing.reduce((m, r) => Math.max(m, r.n), 0) + 1;
    const data = this.data.slice(0, frames * nCh);
    let lost = 0;
    for (let i = 0; i < frames; i++) if (Number.isNaN(data[i * nCh])) lost++;
    const rec = {
      id: uid(), projectId: state.project.id, kind: 'protocol',
      session: sid, participant: p.participant, n,
      createdAt: this.startedAt, fs: this.fs, channels: this.channels, scale: this.scale,
      frames, lost, trials, protocol: p,
      source: stream.mode === 'sim' ? 'simulador' : stream.devName,
      data,
    };
    await DB.put('recordings', rec);
    this.beep(520, 0.25);
    const q = trialQuality(rec);
    const rej = q.filter((x) => x.rejected).length;
    toast(`${recBase(rec)} guardada: ${trials} trials` + (rej ? ` · ${rej} no pasan la regla de calidad` : ''), 3500);
    await renderFolder();
  },

  cancel(msg) {
    this.stop(false);
    if (msg) toast(msg);
  },
};

// ---------------------------------------------------------------------------
// Exportar (CSV y ZIP para Edge Impulse)
// ---------------------------------------------------------------------------
function recToCsv(rec) {
  if (rec.kind === 'protocol') return protoRecToCsv(rec);
  const nCh = rec.channels.length;
  const dec = Math.max(0, Math.round(Math.log10(rec.scale || 1)));
  const lines = ['timestamp,' + rec.channels.join(',')];
  for (let i = 0; i < rec.frames; i++) {
    const t = Math.round((i * 1000) / rec.fs);
    let row = String(t);
    for (let c = 0; c < nCh; c++) row += ',' + rec.data[i * nCh + c].toFixed(dec);
    lines.push(row);
  }
  return lines.join('\n') + '\n';
}
// Edge Impulse toma la etiqueta de lo que va antes del primer punto: "flexion_extension.xxx.csv"
// La etiqueta sale del nombre actual de la carpeta (si la renombras, cambia la etiqueta)
const moveLabel = (m) => slug(m.name);
const movePhases = (m) => (m.phases && m.phases.length ? m.phases : [m.name]);
function recFileName(rec) {
  if (rec.kind === 'protocol') return `${recBase(rec)}.csv`;
  const m = state.project.movements.find((x) => x.id === rec.label);
  const label = m ? moveLabel(m) : rec.label;
  return `${label}.${slug(state.project.name)}_${pad(rec.n)}_${fileStamp(rec.createdAt)}.csv`;
}

// ---- Exportar: protocolo (estructura del repositorio del curso) ----
const csvCell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const fmtVal = (v, dec) => (Number.isNaN(v) ? '' : v.toFixed(dec));

// data/raw: time_ms, canales (raw_mV, emg_mV), label (reposo/aviso/mover/entre), trial (1..N).
// Las muestras perdidas por Bluetooth quedan como celdas vacías (hueco, no cero).
function protoRecToCsv(rec) {
  const nCh = rec.channels.length;
  const dec = Math.max(0, Math.round(Math.log10(rec.scale || 1)));
  const lines = ['time_ms,' + rec.channels.join(',') + ',label,trial'];
  for (let i = 0; i < rec.frames; i++) {
    const { trial, ph } = phaseAt(i / rec.fs, rec.protocol);
    let row = String(Math.round((i * 1000) / rec.fs));
    for (let c = 0; c < nCh; c++) row += ',' + fmtVal(rec.data[i * nCh + c], dec);
    lines.push(row + ',' + PHASE_LABELS[ph] + ',' + (trial + 1));
  }
  return lines.join('\n') + '\n';
}

// Regla de calidad por trial
function trialQuality(rec) {
  const p = rec.protocol, nCh = rec.channels.length;
  const per = Math.round(trialLen(p) * rec.fs);
  const ri = rec.channels.indexOf('raw_mV');
  const out = [];
  for (let k = 0; k < rec.trials; k++) {
    let miss = 0, sat = 0;
    const end = Math.min(rec.frames, (k + 1) * per);
    for (let i = k * per; i < end; i++) {
      if (Number.isNaN(rec.data[i * nCh])) { miss++; continue; }
      if (ri >= 0) {
        const v = rec.data[i * nCh + ri];
        if (v <= SAT_LOW_MV || v >= SAT_HIGH_MV) sat++;
      }
    }
    const missFrac = miss / per;
    const reasons = [];
    if (sat > 0) reasons.push('samples at the limit of the converter');
    if (missFrac > MAX_MISSING) reasons.push(`${(missFrac * 100).toFixed(1)} % of the samples missing`);
    out.push({ k: k + 1, miss, missFrac, sat, rejected: reasons.length > 0, reasons, checkedSat: ri >= 0 });
  }
  return out;
}

// Segmento de un canal (con huecos interpolados: solo para Edge Impulse, data/raw queda intacto)
function segment(rec, ch, start, len) {
  const nCh = rec.channels.length;
  const v = new Float32Array(len);
  for (let i = 0; i < len; i++) v[i] = rec.data[(start + i) * nCh + ch];
  let last = -1;
  for (let i = 0; i <= len; i++) {
    if (i < len && Number.isNaN(v[i])) continue;
    if (i - last > 1) {
      const a = last >= 0 ? v[last] : (i < len ? v[i] : 0);
      const b = i < len ? v[i] : a;
      for (let j = last + 1; j < i; j++) v[j] = a + ((b - a) * (j - last)) / (i - last);
    }
    last = i;
  }
  return v;
}
function rms(v) {
  let s = 0, n = 0;
  for (const x of v) if (!Number.isNaN(x)) { s += x * x; n++; }
  return n ? Math.sqrt(s / n) : NaN;
}

function buildDataset(project, recs) {
  const p0 = project.protocol;
  const files = [];
  const meta = [];
  const qRows = [];
  const noise = {};   // sesión -> {rest:[], move:[]}
  let tot = 0, rejSat = 0, rejGap = 0, keptTrain = 0, keptTest = 0, noSat = false;
  const cols = ['file_name', 'participant', 'session', 'date', 'recording', 'trials', 'rest_s', 'warning_s', 'move_s',
    'between_s', 'fs_hz', 'movement', 'muscle', 'side', 'electrode_type', 'electrode_distance_cm', 'skin_preparation',
    'sensor_model', 'gain', 'adc_bits', 'channels', 'cue', 'set', 'samples', 'missing_samples', 'trials_rejected', 'notes'];
  recs.sort((a, b) => sessNum(a.session) - sessNum(b.session) || a.n - b.n);
  for (const r of recs) {
    const p = r.protocol;
    const set = sessionSet(project, r.session);
    const q = trialQuality(r);
    const base = recBase(r);
    files.push({ name: `data/raw/${base}.csv`, data: protoRecToCsv(r) });
    const rejected = q.filter((x) => x.rejected);
    const notes = rejected.length ? rejected.map((x) => `trial ${x.k}: ${x.reasons.join(' and ')}`).join('; ') : 'kept';
    if (!q[0]?.checkedSat) noSat = true;
    meta.push([`${base}.csv`, r.participant, r.session, isoDate(r.createdAt), r.n, r.trials, p.rest_s, p.warning_s,
      p.move_s, p.between_s, r.fs, p.movement, p.muscle, p.side, p.electrode_type, p.electrode_distance_cm,
      p.skin_preparation, p.sensor_model, p.gain, p.adc_bits, r.channels.join(';'),
      'Captura ML app, on-screen trial timer', set, r.frames, r.lost, rejected.length, notes]);
    qRows.push(`| ${base}.csv | ${r.session} | ${set} | ${r.trials} | ${rejected.length} | ${rejected.length ? rejected.map((x) => `trial ${x.k}: ${x.reasons.join(' and ')}`).join('; ') : 'kept'} |`);
    // Edge Impulse: por cada trial que pasa la regla, una ventana de reposo y una de movimiento
    const ch = Math.max(0, r.channels.indexOf('emg_mV'));
    const per = Math.round(trialLen(p) * r.fs);
    const folder = set === 'test' ? 'testing' : 'training';
    noise[r.session] = noise[r.session] || { rest: [], move: [] };
    for (const t of q) {
      tot++;
      if (t.rejected) { if (t.sat > 0) rejSat++; else rejGap++; continue; }
      if (set === 'test') keptTest++; else keptTrain++;
      const s0 = (t.k - 1) * per;
      const wins = [
        ['reposo', s0, Math.round(p.rest_s * r.fs)],
        ['mover', s0 + Math.round((p.rest_s + p.warning_s) * r.fs), Math.round(p.move_s * r.fs)],
      ];
      for (const [label, start, len] of wins) {
        const v = segment(r, ch, start, len);
        (label === 'mover' ? noise[r.session].move : noise[r.session].rest).push(rms(v));
        const lines = ['timestamp,emg_mV'];
        for (let i = 0; i < len; i++) lines.push(Math.round((i * 1000) / r.fs) + ',' + v[i].toFixed(1));
        files.push({ name: `edge_impulse/${folder}/${label}.${base}_T${t.k}.csv`, data: lines.join('\n') + '\n' });
      }
    }
  }
  files.push({ name: 'data/metadata.csv', data: [cols.join(','), ...meta.map((row) => row.map(csvCell).join(','))].join('\n') + '\n' });

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const noiseRows = Object.keys(noise).sort((a, b) => sessNum(a) - sessNum(b)).map((sid) => {
    const r = mean(noise[sid].rest), m = mean(noise[sid].move);
    return `| ${sid} | ${r.toFixed(1)} | ${m.toFixed(1)} | ${(m / r).toFixed(1)} |`;
  });
  const kept = keptTrain + keptTest;
  const report = `# Quality report

Rule, written before any model score: reject a trial if one raw sample sits at the limit of the converter (raw_mV ≤ ${SAT_LOW_MV} mV or ≥ ${SAT_HIGH_MV} mV; the ESP32 ADC reads about 0 to 3.1 V), or if more than ${MAX_MISSING * 100} % of its samples are missing (packets lost over Bluetooth). Missing samples stay as empty cells in \`data/raw/\`; they are never replaced by zeros.
${noSat ? '\n> Some recordings have no raw_mV channel (old firmware), so saturation could not be checked in them.\n' : ''}
Generated by the Captura ML app on ${fmtDate(Date.now())} (Monterrey time).

| File | Session | Set | Trials | Rejected | Reason |
|---|---|---|---|---|---|
${qRows.join('\n')}

**Totals.** ${tot} trials recorded. ${rejSat + rejGap} rejected: ${rejSat} for samples at the limit of the converter (an artifact), ${rejGap} for missing samples (a gap). ${kept} kept: ${keptTrain} for training, ${keptTest} for the test.

**Noise.** RMS of the filtered signal (emg_mV) in the rest window and in the movement window of the kept trials, mean per session:

| Session | Rest RMS (mV) | Movement RMS (mV) | Movement / rest |
|---|---|---|---|
${noiseRows.join('\n')}

**Outliers.** Write here any recording that is far from the others of its class, and whether it is an error or a real rare case.
`;
  files.push({ name: 'QUALITY-REPORT.md', data: report });
  files.push({ name: 'edge_impulse/LEEME.txt', data: `Proyecto: ${project.name}
Exportado: ${fmtDate(Date.now())} (hora MTY)

Cada archivo es UNA ventana de un trial que pasó la regla de calidad:
  reposo.<persona>_<sesión>_R<grabación>_T<trial>.csv   -> ${p0.rest_s} s de reposo
  mover.<persona>_<sesión>_R<grabación>_T<trial>.csv    -> ${p0.move_s} s de movimiento
La señal es emg_mV (filtrada en el ESP32, la misma que usa la ballena).

Edge Impulse > Data acquisition > Upload data:
1. Sube la carpeta "training" con "Upload into category: Training".
2. Sube la carpeta "testing" con "Upload into category: Testing".
3. Label: "Infer from filename" (la etiqueta es lo que va antes del primer punto).
NO uses "Automatically split between training and testing": mezclaría sesiones
(leakage). Las sesiones de prueba (${p0.test_sessions}) nunca deben entrar al entrenamiento.
` });
  return { files, tot, kept };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// ZIP sin compresión (método "store"), suficiente para CSV
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Gráficas
// ---------------------------------------------------------------------------
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(cv.clientWidth * dpr));
  const h = Math.max(10, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w, h, dpr };
}

function drawSignal(cv, data, nCh, opts = {}) {
  const { w, h, dpr } = fitCanvas(cv);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const frames = Math.floor(data.length / nCh);
  if (!opts.thumb) {
    ctx.strokeStyle = '#d4e5ee'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  }
  if (frames < 2) return;
  const totalFrames = opts.totalFrames || frames;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }  // NaN se ignora solo
  if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
  if (opts.symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-6); lo = -m; hi = m; }
  if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
  const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  const usedW = Math.round((frames / totalFrames) * w);
  if (opts.bands) {   // ventanas de movimiento sombreadas
    ctx.fillStyle = 'rgba(47, 158, 106, .14)';
    for (const [a, b] of opts.bands) ctx.fillRect(a * usedW, 0, (b - a) * usedW, h);
  }
  for (let c = 0; c < nCh; c++) {
    ctx.strokeStyle = CH_COLORS[c % CH_COLORS.length];
    ctx.lineWidth = (opts.thumb ? 1 : 1.2) * dpr;
    ctx.beginPath();
    let pen = false;
    for (let x = 0; x < usedW; x++) {
      const a = Math.floor((x / usedW) * frames);
      const b = Math.max(a + 1, Math.floor(((x + 1) / usedW) * frames));
      let mn = Infinity, mx = -Infinity;
      for (let i = a; i < b && i < frames; i++) { const v = data[i * nCh + c]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mn === Infinity) { pen = false; continue; }   // hueco (muestras perdidas)
      if (!pen) { ctx.moveTo(x, y(mn)); pen = true; } else ctx.lineTo(x, y(mn));
      if (mx !== mn) ctx.lineTo(x, y(mx));
    }
    ctx.stroke();
  }
  if (!opts.thumb) {
    ctx.fillStyle = '#5f7d90'; ctx.font = `${11 * dpr}px Nunito, system-ui`;
    ctx.fillText(hi.toFixed(2), 4 * dpr, 12 * dpr);
    ctx.fillText(lo.toFixed(2), 4 * dpr, h - 4 * dpr);
  }
}

function plotLoop() {
  const isEmg = state.project?.type === 'emg';
  if (state.view === 'project' || state.view === 'folder') {
    const cv = state.view === 'project' ? $('livePlot') : $('folderPlot');
    if (stream.ring) {
      const vc = viewChannel(stream.snapshot(), stream.channels);
      drawSignal(cv, vc.data, vc.nCh, { symmetric: isEmg, totalFrames: stream.ringLen });
    }
    if (state.view === 'folder' && recorder.active) {
      recorder.updatePhase();
      const pct = (recorder.pos / recorder.target) * 100;
      $('progressBar').style.width = pct + '%';
      const left = (recorder.target - recorder.pos) / recorder.fs;
      const stalled = performance.now() - stream.lastDataAt > 1500;
      const trialTxt = recorder.protocol ? `Trial ${Math.max(1, recorder.lastTrial + 1)} / ${recorder.protocol.trials} · ` : '';
      $('recStatus').textContent = stalled
        ? 'No llegan datos del dispositivo…'
        : `${trialTxt}Grabando · faltan ${left.toFixed(0)} s` + (recorder.lost ? ` · ${recorder.lost} muestras perdidas` : '');
    }
  }
  requestAnimationFrame(plotLoop);
}

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------
const state = { view: 'home', project: null, movement: null, device: null };

// ---- Dispositivos y proyectos ---------------------------------------------------
async function getDevices(type) {
  const custom = (await DB.all('devices')).filter((d) => d.type === type).sort((a, b) => a.createdAt - b.createdAt);
  return [...BUILTIN_DEVICES.filter((d) => d.type === type), ...custom];
}
async function findDevice(id, type) {
  return (await getDevices(type)).find((d) => d.id === id) || BUILTIN_DEVICES.find((d) => d.type === type);
}
// Proyectos de la versión anterior: se les asigna dispositivo y todas las carpetas sugeridas
async function normalizeProject(p) {
  let changed = false;
  if (!p.deviceId) { p.deviceId = BUILTIN_DEVICES.find((d) => d.type === p.type).id; changed = true; }
  if (!Array.isArray(p.movements)) { p.movements = DEVICE_TYPES[p.type].catalog.map((m) => ({ ...m })); changed = true; }
  if (changed) await DB.put('projects', p);
  return p;
}
const saveProject = () => DB.put('projects', state.project);

function newCustomMove(name) {
  return { id: 'm_' + uid().replace(/-/g, '').slice(0, 10), name, phases: [], hint: 'Movimiento agregado por ti.', custom: true };
}
// Pide un nombre y revisa que no choque con otra carpeta (Edge Impulse usa el nombre como etiqueta)
function askMoveName(current, others, title) {
  const v = prompt(title, current || '');
  if (v === null) return null;
  const name = v.trim().slice(0, 50);
  if (!name) { toast('El nombre no puede ir vacío'); return null; }
  if (!slug(name).length) { toast('Usa letras o números en el nombre'); return null; }
  if (others.some((m) => moveLabel(m) === slug(name))) { toast('Ya hay una carpeta con ese nombre'); return null; }
  return name;
}

function setBadge(text, cls) {
  const b = $('bleBadge');
  b.textContent = text;
  b.className = 'badge ' + cls;
}

function updateStreamInfo() {
  const el = $('streamInfo');
  if (!el) return;
  if (!stream.mode) { el.textContent = 'Sin señal — conecta el ESP32 o usa el simulador'; $('plotLegend').textContent = ''; }
  else {
    el.textContent = `${stream.devName} · ${stream.fs} Hz · ${stream.channels.length} canal(es)`;
    $('plotLegend').innerHTML = viewChannel(new Float32Array(0), stream.channels).names
      .map((c, i) => `<span class="swatch" style="background:${CH_COLORS[i % CH_COLORS.length]}"></span> ${esc(c)}`).join('&nbsp;&nbsp;') +
      (stream.channels.includes('raw_mV') ? ' <span class="muted">(se graba también raw_mV)</span>' : '');
  }
  $('btnConnect').textContent = stream.mode === 'ble' ? 'Desconectar' : 'Conectar';
  $('btnSim').textContent = stream.mode === 'sim' ? 'Detener simulador' : 'Simulador';
  $('projDeviceSel').disabled = !!stream.mode;
}

function show(view, push = true) {
  state.view = view;
  for (const v of ['Home', 'Project', 'Folder']) $('view' + v).hidden = v.toLowerCase() !== view;
  $('btnBack').hidden = view === 'home';
  $('bleBadge').hidden = view === 'home';
  if (push) history.pushState({ view, pid: state.project?.id, mid: state.movement?.id }, '');
  window.scrollTo(0, 0);
}

// ---- Pantalla 1: nuevo proyecto + lista ----------------------------------------
const form = { type: 'emg', deviceId: 'ballena', moves: [] };

function resetFormMoves() {
  form.moves = DEVICE_TYPES[form.type].catalog.map((m) => ({ ...m, on: true }));
}

async function renderDeviceList() {
  const list = $('deviceList');
  const devices = await getDevices(form.type);
  if (!devices.some((d) => d.id === form.deviceId)) form.deviceId = devices[0].id;
  list.innerHTML = '';
  for (const d of devices) {
    const el = document.createElement('div');
    el.className = 'item dev' + (d.id === form.deviceId ? ' selected' : '');
    el.innerHTML = `<span class="radio"></span><div class="grow"><div class="title">${esc(d.name)}</div>
      <div class="small muted">Bluetooth: “${esc(d.namePrefix)}…” · ${d.fs} Hz · ${esc(d.channels.join(', '))}${d.builtin ? '' : ' · agregado por ti'}</div></div>
      ${d.builtin ? '' : '<button class="x-btn" title="Quitar dispositivo">✕</button>'}`;
    el.onclick = () => { form.deviceId = d.id; renderDeviceList(); };
    const x = el.querySelector('.x-btn');
    if (x) x.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Quitar el dispositivo “${d.name}”?`)) return;
      await DB.del('devices', d.id);
      renderDeviceList();
    };
    list.appendChild(el);
  }
}

function renderMoveRows() {
  $('movesStep').hidden = form.type === 'emg';
  $('emgProtoNote').hidden = form.type !== 'emg';
  const list = $('moveRows');
  list.innerHTML = '';
  for (const m of form.moves) {
    const el = document.createElement('div');
    el.className = 'item move-row' + (m.on ? '' : ' off');
    el.innerHTML = `<span class="name">${esc(m.name)}</span>
      <button class="ed-btn">Renombrar</button>
      ${m.on ? '<button class="x-btn" title="Quitar">✕</button>' : '<button class="add-btn">+ Agregar</button>'}`;
    el.querySelector('.ed-btn').onclick = () => {
      const name = askMoveName(m.name, form.moves.filter((x) => x !== m), 'Nombre de la carpeta:');
      if (name) { m.name = name; renderMoveRows(); }
    };
    const x = el.querySelector('.x-btn');
    if (x) x.onclick = () => {
      if (m.custom) form.moves = form.moves.filter((y) => y !== m); else m.on = false;
      renderMoveRows();
    };
    const add = el.querySelector('.add-btn');
    if (add) add.onclick = () => { m.on = true; renderMoveRows(); };
    list.appendChild(el);
  }
}

async function renderHome() {
  $('title').textContent = 'PERLA · Captura ML';
  $('subtitle').textContent = 'Datos de EMG para Edge Impulse';
  await renderDeviceList();
  renderMoveRows();
  const projects = (await DB.all('projects')).sort((a, b) => b.createdAt - a.createdAt);
  const recs = await DB.all('recordings').catch(() => []);
  const list = $('projectList');
  list.innerHTML = '';
  $('noProjects').hidden = projects.length > 0;
  for (const p0 of projects) {
    const p = await normalizeProject(p0);
    const dev = await findDevice(p.deviceId, p.type);
    const count = recs.filter((r) => r.projectId === p.id).length;
    const el = document.createElement('div');
    el.className = 'item clickable';
    el.innerHTML = `<div class="grow"><div class="title">${esc(p.name)}</div>
      <div class="small muted">${DEVICE_TYPES[p.type].label} · ${esc(dev.name)} · ${isProto(p) ? 'protocolo de trials' : p.movements.length + ' carpetas'} · ${count} grabaciones · creado ${fmtDate(p.createdAt)}</div></div>
      <span class="muted">›</span>`;
    el.onclick = () => openProject(p);
    list.appendChild(el);
  }
}

// ---- Pantalla 2: proyecto -------------------------------------------------------
async function openProject(p, push = true) {
  state.project = await normalizeProject(p);
  state.movement = null;
  state.device = await findDevice(p.deviceId, p.type);
  const type = DEVICE_TYPES[p.type];
  $('title').textContent = p.name;
  $('subtitle').textContent = `${type.label} · ${state.device.name}`;
  const d = state.device;
  if (!stream.mode && (!stream.ring || stream.channels.join() !== d.channels.join() || stream.fs !== d.fs)) {
    stream.configure(d.fs, d.channels, d.scale);
  }
  show('project', push);
  await renderProject();
}

async function renderProject() {
  const p = state.project;
  const d = state.device;
  $('projDevice').textContent = `Al conectar, busca dispositivos que empiecen con “${d.namePrefix}”`;
  const sel = $('projDeviceSel');
  sel.innerHTML = (await getDevices(p.type))
    .map((x) => `<option value="${esc(x.id)}"${x.id === d.id ? ' selected' : ''}>${esc(x.name)} (${esc(x.namePrefix)}…)</option>`).join('');
  updateStreamInfo();

  const recs = await DB.recordings(p.id);
  const proto = isProto(p);
  $('protoCard').hidden = !proto;
  $('sessionGrid').hidden = !proto;
  $('btnNewSession').hidden = !proto;
  $('folderGrid').hidden = proto;
  $('addMoves').hidden = proto;
  $('foldersTitle').textContent = proto ? 'Sesiones · cada sesión = electrodos nuevos, colocados desde cero' : 'Carpetas · elige el movimiento a grabar';
  $('btnZip').textContent = proto ? 'Descargar dataset (ZIP con data/raw, metadata, calidad y Edge Impulse)' : 'Guardar ZIP para Edge Impulse';
  if (proto) {
    renderProtocolForm(recs.some((r) => r.kind === 'protocol'));
    renderSessions(recs.filter((r) => r.kind === 'protocol'));
    $('btnZip').disabled = !recs.some((r) => r.kind === 'protocol');
    return;
  }
  const grid = $('folderGrid');
  grid.innerHTML = '';
  for (const m of p.movements) {
    const n = recs.filter((r) => r.label === m.id).length;
    const b = document.createElement('div');
    b.className = 'folder' + (n >= MAX_RECS ? ' full' : '');
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.innerHTML = `<span class="name">${esc(m.name)}</span>
      <span class="small muted">${n} / ${MAX_RECS} grabaciones</span>
      <div class="bar"><div style="width:${(n / MAX_RECS) * 100}%"></div></div>
      <div class="folder-actions"><button class="ed-btn">Renombrar</button><button class="x-btn" title="Quitar carpeta">✕</button></div>`;
    b.onclick = () => openFolder(m);
    b.onkeydown = (e) => { if (e.key === 'Enter') openFolder(m); };
    b.querySelector('.ed-btn').onclick = async (e) => {
      e.stopPropagation();
      const name = askMoveName(m.name, p.movements.filter((x) => x !== m), 'Nuevo nombre de la carpeta (también es la etiqueta en Edge Impulse):');
      if (!name) return;
      m.name = name;
      await saveProject();
      renderProject();
    };
    b.querySelector('.x-btn').onclick = async (e) => {
      e.stopPropagation();
      const msg = n ? `La carpeta “${m.name}” tiene ${n} grabaciones. ¿Quitarla y borrar sus grabaciones?` : `¿Quitar la carpeta “${m.name}”?`;
      if (!confirm(msg)) return;
      for (const r of recs.filter((r) => r.label === m.id)) await DB.del('recordings', r.id);
      p.movements = p.movements.filter((x) => x !== m);
      await saveProject();
      renderProject();
    };
    grid.appendChild(b);
  }
  if (!p.movements.length) grid.innerHTML = '<p class="muted small">No hay carpetas. Agrega una abajo.</p>';

  // Opciones para agregar: sugeridas que faltan + otra opción
  const add = $('addMoves');
  add.innerHTML = '';
  for (const m of DEVICE_TYPES[p.type].catalog.filter((c) => !p.movements.some((x) => x.id === c.id))) {
    const b = document.createElement('button');
    b.className = 'add-btn';
    b.textContent = `+ ${m.name}`;
    b.onclick = async () => {
      if (p.movements.some((x) => moveLabel(x) === moveLabel(m))) { toast('Ya hay una carpeta con ese nombre'); return; }
      p.movements.push({ ...m });
      await saveProject();
      renderProject();
    };
    add.appendChild(b);
  }
  const other = document.createElement('button');
  other.className = 'add-btn';
  other.textContent = '+ Agregar otra opción';
  other.onclick = async () => {
    const name = askMoveName('', p.movements, 'Nombre del nuevo movimiento:');
    if (!name) return;
    p.movements.push(newCustomMove(name));
    await saveProject();
    renderProject();
  };
  add.appendChild(other);
  $('btnZip').disabled = recs.length === 0;
}

// ---- Protocolo y sesiones (proyectos EMG nuevos) ------------------------------
function protoSummary(p) {
  const T = trialLen(p);
  return `${p.trials} trials × ${T} s = ${p.trials * T} s por grabación · ${p.recs_per_session} grabaciones por sesión · ` +
    `trial: reposo ${p.rest_s} s → aviso ${p.warning_s} s → movimiento ${p.move_s} s → reposo ${p.between_s} s · prueba: ${p.test_sessions}`;
}

function renderProtocolForm(hasRecs) {
  const p = state.project;
  $('protoSummary').textContent = protoSummary(p.protocol);
  $('protoWarn').hidden = !hasRecs;
  const box = $('protoForm');
  box.innerHTML = '';
  for (const f of PROTOCOL_FIELDS) {
    const lab = document.createElement('label');
    lab.className = 'field';
    lab.textContent = f.label;
    const inp = document.createElement('input');
    inp.type = f.num ? 'number' : 'text';
    if (f.num) { inp.min = '0'; inp.step = f.int ? '1' : '0.1'; }
    inp.placeholder = f.ph || '';
    inp.value = p.protocol[f.k] ?? '';
    inp.onchange = async () => {
      let v = inp.value.trim();
      if (f.num && !(f.optional && v === '')) {
        v = Number(v);
        if (!Number.isFinite(v) || v < 0 || (f.int && !Number.isInteger(v)) || (['trials', 'recs_per_session', 'adc_bits'].includes(f.k) && v < 1)) {
          toast('Valor no válido'); inp.value = p.protocol[f.k]; return;
        }
      }
      if (f.k === 'participant') v = (v || 'P01').toUpperCase();
      p.protocol[f.k] = v;
      if (trialLen(p.protocol) <= 0) { toast('El trial tiene que durar más de 0 s'); }
      await saveProject();
      $('protoSummary').textContent = protoSummary(p.protocol);
      if (f.k === 'test_sessions' || f.k === 'recs_per_session') renderProject();
    };
    lab.appendChild(inp);
    box.appendChild(lab);
  }
}

function renderSessions(recs) {
  const p = state.project;
  const ids = new Set(recs.map((r) => r.session));
  ids.add(p.currentSession || 'S01');
  const grid = $('sessionGrid');
  grid.innerHTML = '';
  for (const sid of [...ids].sort((a, b) => sessNum(a) - sessNum(b))) {
    const rs = recs.filter((r) => r.session === sid);
    const set = sessionSet(p, sid);
    const date = rs.length ? isoDate(Math.min(...rs.map((r) => r.createdAt))) : 'sin grabaciones';
    const target = p.protocol.recs_per_session;
    const b = document.createElement('div');
    b.className = 'folder' + (rs.length >= target ? ' full' : '');
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.innerHTML = `<span class="name">Sesión ${esc(sid)} <span class="set-tag ${set}">${set === 'test' ? 'Prueba' : 'Entrenamiento'}</span></span>
      <span class="small muted">${rs.length} / ${target} grabaciones · ${esc(date)}</span>
      <div class="bar"><div style="width:${Math.min(100, (rs.length / target) * 100)}%"></div></div>`;
    b.onclick = () => openSession(sid);
    b.onkeydown = (e) => { if (e.key === 'Enter') openSession(sid); };
    grid.appendChild(b);
  }
}

async function openSession(sid, push = true) {
  const p = state.project;
  p.currentSession = sid;
  await saveProject();
  state.movement = { id: sid, session: true, name: `Sesión ${sid}` };
  const set = sessionSet(p, sid);
  $('title').textContent = `Sesión ${sid}`;
  $('subtitle').textContent = `${p.name} · ${set === 'test' ? 'PRUEBA' : 'entrenamiento'}`;
  $('folderHint').textContent = `1) Coloca electrodos NUEVOS desde cero y toma una foto sin cara (figures/placement_${sid}.jpg). ` +
    `2) Graba ${p.protocol.recs_per_session} veces, con 1 minuto de pausa entre grabaciones. ` +
    `La persona sigue la pantalla: ${protoSummary(p.protocol)}.`;
  $('fieldDuration').hidden = true;
  $('fieldBpm').hidden = true;
  $('phase').textContent = 'Listo';
  $('metronome').className = 'metronome';
  $('progressBar').style.width = '0';
  $('recStatus').textContent = '';
  show('folder', push);
  await renderFolder();
}

// ---- Pantalla 3: carpeta --------------------------------------------------------
async function openFolder(m, push = true) {
  state.movement = m;
  $('title').textContent = m.name;
  $('subtitle').textContent = state.project.name;
  $('folderHint').textContent = m.hint || '';
  $('fieldDuration').hidden = false;
  $('fieldBpm').hidden = false;
  $('phase').textContent = 'Listo';
  $('metronome').className = 'metronome';
  $('progressBar').style.width = '0';
  $('recStatus').textContent = '';
  show('folder', push);
  await renderFolder();
}

async function renderSessionRecs() {
  const sid = state.movement.id;
  const p = state.project;
  const recs = (await DB.recordings(p.id)).filter((r) => r.kind === 'protocol' && r.session === sid).sort((a, b) => b.n - a.n);
  $('folderCount').textContent = `${recs.length} / ${p.protocol.recs_per_session}`;
  $('noRecs').hidden = recs.length > 0;
  $('noRecs').textContent = 'Aún no hay grabaciones en esta sesión.';
  const list = $('recList');
  list.innerHTML = '';
  for (const r of recs) {
    const q = trialQuality(r);
    const rej = q.filter((x) => x.rejected);
    const el = document.createElement('div');
    el.className = 'item rec';
    el.innerHTML = `<span class="num">R${pad(r.n)}</span><canvas></canvas>
      <div class="grow"><div class="title">${fmtDate(r.createdAt)}</div>
      <div class="small muted">${r.trials} trials · ${(r.frames / r.fs).toFixed(0)} s${r.lost ? ` · ${r.lost} muestras perdidas` : ''}${r.source === 'simulador' ? ' · simulador' : ''}</div>
      <div class="small ${rej.length ? 'warn' : 'ok'}">${rej.length ? `${rej.length} trial(s) rechazado(s): ` + esc(rej.map((x) => 'T' + x.k + ' ' + x.reasons.join(', ')).join('; ')) : 'Todos los trials pasan la regla de calidad'}${q[0] && !q[0].checkedSat ? ' · sin raw_mV: no se revisó saturación' : ''}</div></div>
      <div class="actions">
        <button class="btn" data-a="ver">Ver</button>
        <button class="btn" data-a="csv">CSV</button>
        <button class="btn danger ghost" data-a="del">Borrar</button>
      </div>`;
    list.appendChild(el);
    const vc = viewChannel(r.data, r.channels);
    drawSignal(el.querySelector('canvas'), vc.data, vc.nCh, { thumb: true, symmetric: true, bands: moveBands(r) });
    el.querySelector('[data-a=ver]').onclick = () => preview(r);
    el.querySelector('[data-a=csv]').onclick = () => download(new Blob([recToCsv(r)], { type: 'text/csv' }), recFileName(r));
    el.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`¿Borrar ${recBase(r)}?`)) return;
      await DB.del('recordings', r.id);
      renderFolder();
    };
  }
  updateRecordButton(recs.length, recs.reduce((m, r) => Math.max(m, r.n), 0) + 1);
}

async function renderFolder() {
  if (!state.movement) return;
  if (state.movement.session) return renderSessionRecs();
  $('noRecs').textContent = 'Aún no hay grabaciones de este movimiento.';
  const recs = (await DB.recordings(state.project.id))
    .filter((r) => r.label === state.movement.id)
    .sort((a, b) => b.n - a.n);
  $('folderCount').textContent = `${recs.length} / ${MAX_RECS}`;
  $('noRecs').hidden = recs.length > 0;
  const list = $('recList');
  list.innerHTML = '';
  const sym = state.project.type === 'emg';
  for (const r of recs) {
    const el = document.createElement('div');
    el.className = 'item rec';
    const secs = (r.frames / r.fs).toFixed(1);
    el.innerHTML = `<span class="num">#${r.n}</span><canvas></canvas>
      <div class="grow"><div class="title">${fmtDate(r.createdAt)}</div>
      <div class="small muted">hora MTY · ${secs} s · ${r.frames.toLocaleString('es-MX')} muestras · ${r.fs} Hz${r.lost ? ` · ${r.lost} muestras perdidas` : ''}${r.source === 'simulador' ? ' · simulador' : ''}</div></div>
      <div class="actions">
        <button class="btn" data-a="ver">Ver</button>
        <button class="btn" data-a="csv">CSV</button>
        <button class="btn danger ghost" data-a="del">Borrar</button>
      </div>`;
    list.appendChild(el);
    drawSignal(el.querySelector('canvas'), r.data, r.channels.length, { thumb: true, symmetric: sym });
    el.querySelector('[data-a=ver]').onclick = () => preview(r);
    el.querySelector('[data-a=csv]').onclick = () => download(new Blob([recToCsv(r)], { type: 'text/csv' }), recFileName(r));
    el.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`¿Borrar la grabación #${r.n}?`)) return;
      await DB.del('recordings', r.id);
      renderFolder();
    };
  }
  updateRecordButton(recs.length);
}

let folderCountCache = 0, nextRecCache = 1;
function updateRecordButton(count, nextN) {
  if (typeof count === 'number') folderCountCache = count;
  if (typeof nextN === 'number') nextRecCache = nextN;
  const session = !!state.movement?.session;
  const full = !session && folderCountCache >= MAX_RECS;
  const busy = recorder.active || recorder.counting;
  $('btnRecord').disabled = full || !stream.mode;
  $('btnRecord').textContent = session ? `Grabar R${pad(nextRecCache)}`
    : full ? `Llegaste a ${MAX_RECS} grabaciones` : (folderCountCache ? 'Grabar otra vez' : 'Grabar');
  $('btnRecord').hidden = busy;
  if (!busy && state.view === 'folder') {
    $('recStatus').textContent = !stream.mode ? 'Regresa y conecta el dispositivo (o el simulador) para grabar.' : '';
  }
}

function setRecordingUI(on) {
  $('btnRecord').hidden = on;
  $('btnStop').hidden = !on;
  $('btnCancel').hidden = !on;
  $('selDuration').disabled = on;
  $('selBpm').disabled = on;
  $('btnBack').disabled = on;
  if (!on) {
    $('metronome').className = 'metronome';
    $('phase').textContent = 'Listo';
    $('progressBar').style.width = '0';
    updateRecordButton();
  }
}

function preview(r) {
  const vc = viewChannel(r.data, r.channels);
  $('previewTitle').textContent = r.kind === 'protocol' ? `${recBase(r)} · ${r.trials} trials` : `#${r.n} · ${state.movement.name}`;
  $('previewInfo').innerHTML = `${fmtDate(r.createdAt)} (hora MTY) · ${(r.frames / r.fs).toFixed(1)} s · ${r.fs} Hz · ` +
    vc.names.map((c, i) => `<span class="swatch" style="background:${CH_COLORS[i % CH_COLORS.length]}"></span> ${esc(c)}`).join(' ') +
    (r.kind === 'protocol' ? ' · en verde: ventanas de movimiento' : '') +
    `<br>Archivo: ${esc(recFileName(r))}`;
  $('previewDlg').showModal();
  requestAnimationFrame(() => drawSignal($('previewPlot'), vc.data, vc.nCh, { symmetric: state.project.type === 'emg', bands: moveBands(r) }));
}

// ---- Navegación (botón atrás de Android incluido) -------------------------------
async function goBack() {
  if (recorder.active || recorder.counting) return;
  history.back();
}

async function handleNav(st) {
  if (recorder.active || recorder.counting) recorder.cancel('Grabación cancelada');
  if (!st || st.view === 'home') {
    await stream.stop();
    state.project = null; state.movement = null; state.device = null;
    show('home', false);
    await renderHome();
    return;
  }
  const p = state.project?.id === st.pid ? state.project : (await DB.all('projects')).find((x) => x.id === st.pid);
  if (!p) return handleNav(null);
  if (st.view === 'project') {
    if (state.project?.id === p.id) {
      state.movement = null;
      $('title').textContent = p.name;
      $('subtitle').textContent = `${DEVICE_TYPES[p.type].label} · ${state.device.name}`;
      show('project', false);
      await renderProject();
    } else await openProject(p, false);
  }
  if (st.view === 'folder') {
    if (state.project?.id !== p.id) await openProject(p, false);
    if (isProto(state.project)) { await openSession(st.mid || state.project.currentSession || 'S01', false); return; }
    const m = state.project.movements.find((x) => x.id === st.mid);
    if (m) await openFolder(m, false); else history.back();
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function bindEvents() {
  for (const r of document.querySelectorAll('input[name=newType]')) {
    r.onchange = () => {
      form.type = r.value;
      form.deviceId = BUILTIN_DEVICES.find((d) => d.type === form.type).id;
      resetFormMoves();
      renderDeviceList();
      renderMoveRows();
    };
  }
  $('btnNewMoveCustom').onclick = () => {
    const name = askMoveName('', form.moves, 'Nombre del nuevo movimiento:');
    if (name) { form.moves.push({ ...newCustomMove(name), on: true }); renderMoveRows(); }
  };

  // Agregar dispositivo ("vincular desde código")
  $('btnAddDevice').onclick = () => {
    const isEmg = form.type === 'emg';
    $('devName').value = '';
    $('devPrefix').value = '';
    $('devFs').value = isEmg ? 1000 : 100;
    $('devScale').value = isEmg ? 10 : 1000;
    $('devChannels').value = isEmg ? 'emg_mV' : 'ax_g, ay_g, az_g';
    $('deviceDlg').showModal();
  };
  $('devSave').onclick = async (e) => {
    e.preventDefault();
    const name = $('devName').value.trim();
    const prefix = $('devPrefix').value.trim();
    const fs = Number($('devFs').value);
    const scale = Number($('devScale').value) || 1;
    const channels = $('devChannels').value.split(',').map((c) => c.trim().replace(/[^\w.-]/g, '_')).filter(Boolean);
    if (!name || !prefix) { toast('Escribe el nombre y el nombre Bluetooth'); return; }
    if (!(fs > 0) || !channels.length) { toast('Revisa la frecuencia y los canales'); return; }
    const d = { id: 'd_' + uid().replace(/-/g, '').slice(0, 10), type: form.type, name, namePrefix: prefix, fs, channels, scale, createdAt: Date.now() };
    await DB.put('devices', d);
    form.deviceId = d.id;
    $('deviceDlg').close();
    renderDeviceList();
    toast(`Dispositivo “${name}” agregado`);
  };

  $('btnCreate').onclick = async () => {
    const name = $('newName').value.trim();
    if (!name) { toast('Escribe un nombre para el proyecto'); $('newName').focus(); return; }
    const emg = form.type === 'emg';
    const moves = emg ? [] : form.moves.filter((m) => m.on).map(({ on, ...m }) => m);
    if (!emg && !moves.length) { toast('Agrega al menos un movimiento'); return; }
    const p = { id: uid(), name, type: form.type, deviceId: form.deviceId, movements: moves, createdAt: Date.now() };
    if (emg) { p.protocol = { ...EMG_PROTOCOL_DEFAULT }; p.currentSession = 'S01'; }
    await DB.put('projects', p);
    $('newName').value = '';
    resetFormMoves();
    openProject(p);
  };
  $('newName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnCreate').click(); });

  $('projDeviceSel').onchange = async () => {
    const d = await findDevice($('projDeviceSel').value, state.project.type);
    state.device = d;
    state.project.deviceId = d.id;
    await saveProject();
    stream.configure(d.fs, d.channels, d.scale);
    $('subtitle').textContent = `${DEVICE_TYPES[state.project.type].label} · ${d.name}`;
    renderProject();
  };

  $('btnBack').onclick = goBack;
  window.addEventListener('popstate', (e) => handleNav(e.state));

  $('btnConnect').onclick = async () => {
    if (stream.mode === 'ble') { await stream.stop(); return; }
    if (!navigator.bluetooth) { toast('Este navegador no tiene Web Bluetooth. Usa Chrome (Android o computadora).', 4000); return; }
    try { await stream.connectBle(); } catch (e) {
      if (e.name !== 'NotFoundError') toast('No se pudo conectar: ' + e.message, 4000);
      if (stream.mode !== 'ble') setBadge('Sin conexión', 'off');
    }
    updateStreamInfo();
  };
  $('btnSim').onclick = async () => {
    if (stream.mode === 'sim') await stream.stop(); else stream.startSim();
    updateStreamInfo();
  };

  $('btnRecord').onclick = () => recorder.begin(state.movement);
  $('btnStop').onclick = () => {
    if (recorder.counting) recorder.cancel(); else recorder.stop(true);
  };
  $('btnCancel').onclick = () => recorder.cancel('Grabación cancelada');

  $('btnNewSession').onclick = async () => {
    const recs = (await DB.recordings(state.project.id)).filter((r) => r.kind === 'protocol');
    const used = [...recs.map((r) => sessNum(r.session)), sessNum(state.project.currentSession || 'S01')];
    const cur = state.project.currentSession || 'S01';
    const curHasRecs = recs.some((r) => r.session === cur);
    const next = curHasRecs ? Math.max(...used) + 1 : sessNum(cur);
    await openSession(sessId(next));
  };

  $('btnZip').onclick = async () => {
    if (isProto(state.project)) {
      const recs = (await DB.recordings(state.project.id)).filter((r) => r.kind === 'protocol');
      if (!recs.length) return;
      const { files, tot, kept } = buildDataset(state.project, recs);
      download(makeZip(files), `${slug(state.project.name)}_dataset_${fileStamp(Date.now())}.zip`);
      toast(`ZIP listo: ${recs.length} grabaciones, ${kept} de ${tot} trials pasan la regla de calidad`, 4000);
      return;
    }
    const recs = await DB.recordings(state.project.id);
    if (!recs.length) return;
    const files = recs.sort((a, b) => a.label.localeCompare(b.label) || a.n - b.n)
      .map((r) => ({ name: recFileName(r), data: recToCsv(r) }));
    const labels = state.project.movements.map((m) => `  ${moveLabel(m)}  =  ${m.name}`).join('\n');
    const readme = `Proyecto: ${state.project.name}\nDispositivo: ${state.device.name} (${DEVICE_TYPES[state.project.type].label})\n` +
      `Exportado: ${fmtDate(Date.now())} (hora MTY)\n\nEtiquetas:\n${labels}\n\n` +
      `Edge Impulse > Data acquisition > Upload data:\n` +
      `1. Descomprime este ZIP.\n2. Selecciona todos los .csv.\n` +
      `3. En "Label" elige "Infer from filename" (la etiqueta es lo que va antes del primer punto).\n` +
      `4. "Automatically split between training and testing" (80/20).\n`;
    files.push({ name: 'LEEME.txt', data: readme });
    download(makeZip(files), `${slug(state.project.name)}_${fileStamp(Date.now())}.zip`);
  };
  $('btnDeleteProject').onclick = async () => {
    if (!confirm(`¿Borrar el proyecto “${state.project.name}” y todas sus grabaciones?`)) return;
    for (const r of await DB.recordings(state.project.id)) await DB.del('recordings', r.id);
    await DB.del('projects', state.project.id);
    history.back();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recorder.active) toast('Mantén la app abierta mientras grabas');
  });
}

// ---------------------------------------------------------------------------
async function main() {
  $('bleWarning').hidden = !!navigator.bluetooth;
  await DB.open();
  try { await navigator.storage?.persist?.(); } catch (_) { /* nada */ }
  resetFormMoves();
  bindEvents();
  history.replaceState({ view: 'home' }, '');
  await renderHome();
  requestAnimationFrame(plotLoop);
}
main().catch((e) => { console.error(e); toast('Error: ' + e.message, 6000); });

// Para pruebas desde la consola
window._captura = { stream, recorder, DB, recToCsv, makeZip, buildDataset, trialQuality, phaseAt };
