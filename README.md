# Captura ML · EMG / Acelerómetro → Edge Impulse

App web para grabar datos de entrenamiento por Bluetooth desde un ESP32 y exportarlos como CSV para **Edge Impulse**.
Sirve para dos proyectos:

| Tipo | Dispositivo incluido | Bluetooth | Señal | Carpetas sugeridas |
|---|---|---|---|---|
| EMG (PERLA) | **Ballena Monitor** | `Ballena-EMG-ML` | 1000 Hz: señal cruda `raw_mV` + filtrada `emg_mV` | No usa carpetas: **protocolo de trials** (ver abajo) |
| Acelerómetro | **TactSuit** (sistema táctil de orientación espacial) | `TactSuit-IMU` | 3 canales, 100 Hz (`ax_g`, `ay_g`, `az_g`) | Línea base/equilibrio · Inclinaciones voluntarias · Deriva postural inducida · Recuperación de perturbaciones |

Se pueden **vincular otros ESP** desde la app (*+ Agregar otro dispositivo*); el ESP debe usar el protocolo de abajo.
Las carpetas se pueden quitar (✕), renombrar (✏️) o agregar (*+ Agregar otra opción*). **El nombre de la carpeta es la etiqueta en Edge Impulse.**

Los datos **no se guardan en el ESP**: se guardan en el navegador que está viendo la señal (IndexedDB).
No se borran al cerrar la página, pero sí si borras los datos del sitio en Chrome. **Descarga el ZIP al terminar cada sesión.**

## Proyectos EMG (PERLA): protocolo del curso

Los proyectos EMG nuevos siguen el método del Report 1 (una persona, **un movimiento**, dos clases: movimiento y reposo):

1. **Nuevo proyecto** → tipo **EMG** → **Crear proyecto**.
2. En **Protocolo** → *Editar protocolo…* se ponen el movimiento (por defecto *Cerrar y abrir la mano*), los tiempos
   del trial, los trials por grabación, las sesiones de prueba y los datos de los electrodos (distancia, ganancia…).
   Todo eso se copia a `data/metadata.csv`. **No cambiarlo a mitad del estudio.**
3. **Conectar** (o **Simulador** para probar).
4. Entra a **Sesión S01**. Coloca electrodos nuevos, toma la foto (sin cara) y presiona **Grabar R01**.
   Tras una cuenta de 3 s, la pantalla guía a la persona en cada trial:
   **Reposo → Prepárate → CIERRA Y ABRE LA MANO (verde) → Reposo**, con un pitido en cada cambio.
5. Repite hasta tener las grabaciones de la sesión (por defecto 4). Para la siguiente colocación de electrodos:
   **+ Nueva sesión (electrodos nuevos)**.
6. Al final, en el proyecto: **Descargar dataset**. El ZIP ya trae la estructura del repositorio del curso:

```
data/raw/P01_S01_R01.csv        señal completa: time_ms, raw_mV, emg_mV, label, trial
data/metadata.csv               una fila por grabación (sesión, fecha, tiempos, electrodos, set train/test, rechazos)
QUALITY-REPORT.md               regla de calidad, trials rechazados por grabación y ruido (RMS reposo vs movimiento)
edge_impulse/training/          ventanas de los trials que pasan la regla, de las sesiones de entrenamiento
edge_impulse/testing/           lo mismo, de las sesiones de prueba
```

- `label` en `data/raw`: `reposo`, `aviso`, `mover`, `entre` (reposo después del movimiento). Las clases del modelo
  son `mover` y `reposo`; `aviso` y `entre` no se usan para entrenar.
- Las muestras perdidas por Bluetooth quedan como **celdas vacías** (hueco), nunca como cero.
- **Regla de calidad** (fija antes de ver resultados): se rechaza un trial si una muestra cruda toca el límite del ADC
  (≤ 20 mV o ≥ 3050 mV) o si le falta más del 1 % de sus muestras.
- La sesión es de **prueba** si está en *Sesiones de prueba* (por defecto S05 y S06). Nunca se mezclan sesiones
  entre entrenamiento y prueba.

### Subir a Edge Impulse (proyectos con protocolo)

1. Descomprime el ZIP.
2. **Data acquisition → Upload data**: sube `edge_impulse/training/` con *Upload into category: **Training***
   y luego `edge_impulse/testing/` con *Upload into category: **Testing***.
3. *Label*: **Infer from filename** (`mover.P01_S01_R01_T1.csv` → `mover`).
4. **No** marques *Automatically split between training and testing*: mezclaría sesiones (leakage).

## Cómo se usa (acelerómetro y proyectos EMG anteriores)

1. Abre la app en **Chrome** (Android o computadora). En iPhone no funciona porque Safari no tiene Web Bluetooth.
2. **Nuevo proyecto** → nombre (p. ej. *EMG Ballena*) → 1) tipo (EMG o Acelerómetro) → 2) dispositivo a vincular → 3) movimientos que entran al machine learning.
3. **Conectar** → elige `Ballena-EMG-ML` o `TactSuit-IMU` (o el que hayas agregado). Si no tienes el ESP a la mano, usa **Simulador** para probar (datos falsos).
4. Entra a la **carpeta** del movimiento → elige duración (máx. 60 s) y ritmo → **Grabar**.
   Hay una cuenta regresiva de 3 s y luego el metrónomo marca cada movimiento (p. ej. *Flexión* / *Extensión*).
5. Al terminar, la grabación aparece con **fecha y hora de Monterrey**. Vuelve a grabar; máximo **30 por movimiento**.
6. En el proyecto: **Descargar todo (ZIP para Edge Impulse)**.

## Subir a Edge Impulse

1. Descomprime el ZIP.
2. Edge Impulse → **Data acquisition** → **Upload data** → selecciona los `.csv`.
3. En *Label* elige **Infer from filename**. La etiqueta es lo que va antes del primer punto:
   `extension_y_flexion.emg_ballena_03_20261117-115230.csv` → etiqueta `extension_y_flexion`.
   (Sin acentos ni espacios; el `LEEME.txt` del ZIP trae la lista de etiquetas.)
4. Deja marcado *Automatically split between training and testing* (80 % entrenamiento / 20 % prueba).
5. Si Edge Impulse abre el **CSV Wizard** la primera vez: la columna de tiempo es `timestamp` (milisegundos) y las demás son los valores.

Formato de cada CSV:

```
timestamp,emg_mV
0,0.4
1,3.6
...
```

## Firmware

| Carpeta | Para qué |
|---|---|
| `firmware/EMG_Captura_BLE/` | ESP32 de la EMG (pin D34). Manda por BLE la señal **cruda** del ADC (`raw_mV`, para `data/raw` y para detectar saturación) y la **filtrada** (`emg_mV`), con la misma cadena que `EMG_Emisor` de BallenaMonitor (notch 60 Hz, pasa-altas 20 Hz, pasa-bajas 300 Hz, rechazo de artefactos). Se carga **solo para grabar datos**; para jugar con la ballena vuelve a cargar `EMG_Emisor`. |
| `firmware/TactSuit_IMU_BLE/` | **Plantilla.** Con `SIMULAR = true` manda datos de prueba. Cuando elijan el sensor, se llena `leerIMU()`. |

Placa: *ESP32 Dev Module*, core ESP32 3.x en Arduino IDE.

### Protocolo Bluetooth (Nordic UART)

| | UUID |
|---|---|
| Servicio | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| RX (app → ESP, write) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| TX (ESP → app, notify) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

Todo es texto, una línea por mensaje (`\n`):

- La app manda `START`, `STOP` o `INFO`.
- El ESP responde `#INFO,<nombre>,<fs_hz>,<canal1;canal2;...>,<escala>`, por ejemplo `#INFO,Ballena-EMG-ML,1000,emg_mV,10`.
- Los datos van así: `D,<seq>,<v1>,<v2>,...`. Son enteros y el valor real es `v / escala`. Si hay varios canales, van intercalados: `ax,ay,az,ax,ay,az,…`.
- `seq` aumenta 1 en cada línea (0–65535). Si la app detecta que faltan líneas, rellena repitiendo el último valor para no romper la escala de tiempo, y lo marca como “muestras perdidas” en la grabación.

Para agregar otro sensor, basta con mandar otro `#INFO` (otros canales o frecuencia). La app se adapta sola.

## Publicar en GitHub Pages

Repo → **Settings** → **Pages** → *Deploy from a branch* → `main` / `(root)`.
La app queda en `https://<usuario>.github.io/Machine-Learning-APP/`. Web Bluetooth necesita HTTPS, y GitHub Pages ya lo da.

## Probar en la computadora

Abre el link de GitHub Pages en Chrome; con Bluetooth en la laptop también se conecta al ESP.
Para probar sin internet: `python3 -m http.server` dentro de la carpeta y abre `http://localhost:8000`.

## Archivos

- `index.html`, `style.css`, `app.js`: la app completa, sin dependencias.
- `firmware/`: sketches de Arduino para los ESP32.
