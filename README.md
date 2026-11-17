# Captura ML · EMG / Acelerómetro → Edge Impulse

App web para grabar datos de entrenamiento por Bluetooth desde un ESP32 y exportarlos como CSV para **Edge Impulse**.
Sirve para dos proyectos:

| Proyecto | Dispositivo | Bluetooth | Señal | Carpetas (etiquetas) |
|---|---|---|---|---|
| **Ballena Monitor** | EMG | `Ballena-EMG-ML` | 1 canal, filtrada, 1000 Hz (`emg_mV`) | `flexion_extension`, `pronacion_supinacion`, `descanso` |
| **TactSuit** (sistema táctil de orientación espacial) | Acelerómetro | `TactSuit-IMU` | 3 canales, 100 Hz (`ax_g`, `ay_g`, `az_g`) | `limites_estabilidad`, `linea_base`, `deriva_postural`, `recuperacion_perturbaciones` |

Los datos **no se guardan en el ESP**: se guardan en el navegador que está viendo la señal (IndexedDB).
No se borran al cerrar la página, pero sí si borras los datos del sitio en Chrome. **Descarga el ZIP al terminar cada sesión.**

## Cómo se usa

1. Abre la app en **Chrome** (Android o computadora). En iPhone no funciona porque Safari no tiene Web Bluetooth.
2. **Nuevo proyecto** → nombre + dispositivo (EMG o Acelerómetro).
3. **Conectar** → elige `Ballena-EMG-ML` o `TactSuit-IMU`. Si no tienes el ESP a la mano, usa **Simulador** para probar (datos falsos).
4. Entra a la **carpeta** del movimiento → elige duración (máx. 60 s) y ritmo → **Grabar**.
   Hay una cuenta regresiva de 3 s y luego el metrónomo marca cada movimiento (p. ej. *Flexión* / *Extensión*).
5. Al terminar, la grabación aparece con **fecha y hora de Monterrey**. Vuelve a grabar; máximo **30 por movimiento**.
6. En el proyecto: **Descargar todo (ZIP para Edge Impulse)**.

## Subir a Edge Impulse

1. Descomprime el ZIP.
2. Edge Impulse → **Data acquisition** → **Upload data** → selecciona los `.csv`.
3. En *Label* elige **Infer from filename**. La etiqueta es lo que va antes del primer punto:
   `flexion_extension.sujeto_01_03_20261117-115230.csv` → etiqueta `flexion_extension`.
4. Si Edge Impulse abre el **CSV Wizard** la primera vez: la columna de tiempo es `timestamp` (milisegundos) y las demás son los valores.

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
| `firmware/EMG_Captura_BLE/` | ESP32 de la EMG (pin D34). Misma cadena de filtros que `EMG_Emisor` de BallenaMonitor (notch 60 Hz, pasa-altas 20 Hz, pasa-bajas 300 Hz, rechazo de artefactos), pero manda la señal filtrada por BLE en vez de ESP-NOW. Se carga **solo para grabar datos**; para jugar con la ballena vuelve a cargar `EMG_Emisor`. |
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
