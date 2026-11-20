// EMG_Captura_BLE: ESP32 que lee el circuito EMG (pin D34) y manda por Bluetooth, a 1 kHz,
// la senal CRUDA del ADC y la senal FILTRADA a la app web "Captura ML" (dataset de PERLA).
//
// Es la misma cadena que EMG_Emisor (BallenaMonitor):
//   ADC 1 kHz (x4 promediado, mV calibrados) -> notch 60 Hz -> pasa-altas 20 Hz
//   -> pasa-bajas 300 Hz -> rechazo de artefactos (|y| > 1 V = 0)
// pero en vez de ESP-NOW usa BLE. Este sketch es SOLO para grabar datos:
// para jugar con la ballena vuelve a cargar EMG_Emisor.
//
// Bluetooth: se anuncia como "Ballena-EMG-ML" con el servicio Nordic UART (NUS).
//   App -> ESP (RX):  START  (empieza a mandar)  |  STOP  |  INFO
//   ESP -> App (TX):  #INFO,Ballena-EMG-ML,1000,raw_mV;emg_mV,10
//                     D,<seq>,raw1,emg1,raw2,emg2,...   (20 muestras = 20 ms por linea)
//   raw_mV = entrada del ADC sin filtrar (promedio de 4 lecturas, mV calibrados): es la
//            que va a data/raw y la que se usa para detectar saturacion (0 V / 3.3 V).
//   emg_mV = misma senal despues de notch 60 Hz, pasa-altas 20 Hz, pasa-bajas 300 Hz y
//            rechazo de artefactos (|y| > 1 V = 0): la misma que usa la ballena (EMG_Emisor).
//   Los valores van en decimas de mV (entero): 123 = 12.3 mV. seq cuenta las lineas
//   (0..65535) para que la app detecte paquetes perdidos.
//
// Placa en Arduino: "ESP32 Dev Module". Core de ESP32 3.x (igual que BallenaMonitor).
// Particion recomendada: "Huge APP (3MB No OTA)" si no cabe con la de defecto.
// Serial Monitor (115200): imprime el estado cada 5 s; 'p' = plot de la senal.

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <esp_timer.h>
#include <math.h>

// ---- Configuracion ------------------------------------------------------------
constexpr const char *BLE_NAME = "Ballena-EMG-ML";
constexpr int EMG_PIN = 34;            // ADC1
constexpr uint32_t FS_HZ = 1000;       // los filtros estan calculados para 1 kHz
constexpr int OVERSAMPLE = 4;
constexpr float ARTIFACT_MV = 1000.0f;
constexpr int SCALE = 10;              // se mandan decimas de mV
constexpr int BATCH = 20;              // muestras por linea
constexpr uint32_t RING = 4096;        // buffer de muestras (4 s)

#define NUS_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_UUID "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_TX_UUID "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// ---- Filtros (fs = 1000 Hz), iguales al codigo del equipo -------------------------
struct Biquad {
  float b0, b1, b2, a1, a2;
  float x1, x2, y1, y2;
  float process(float x) {
    float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  }
};
static Biquad notch60 = {0.97618f, -1.81526f, 0.97618f, -1.80379f, 0.94090f, 0, 0, 0, 0};
static Biquad hp20    = {0.91497f, -1.82994f, 0.91497f, -1.82272f, 0.83718f, 0, 0, 0, 0};
static Biquad lp300   = {0.39134f,  0.78268f, 0.39134f,  0.36953f, 0.19582f, 0, 0, 0, 0};

// ---- Buffer circular (lo escribe el timer, lo lee loop) ---------------------------
// 2 valores por muestra: [cruda, filtrada] (int32 porque 3300 mV x 10 no cabe en int16)
static int32_t ring[RING * 2];
static volatile uint32_t wIdx = 0;  // muestras escritas (solo el timer)
static uint32_t rIdx = 0;           // muestras leidas (solo loop)
static volatile float lastMv = 0;

static void sampleCb(void *) {
  uint32_t acc = 0;
  for (int i = 0; i < OVERSAMPLE; i++) acc += analogReadMilliVolts(EMG_PIN);
  float v = (float)acc / OVERSAMPLE;
  float y = lp300.process(hp20.process(notch60.process(v)));
  float ym = (fabsf(y) > ARTIFACT_MV) ? 0 : y;
  lastMv = ym;
  uint32_t k = (wIdx % RING) * 2;
  ring[k] = lroundf(v * SCALE);       // cruda
  ring[k + 1] = lroundf(ym * SCALE);  // filtrada
  wIdx = wIdx + 1;
}

// ---- BLE ---------------------------------------------------------------------------
static BLEServer *server = nullptr;
static BLECharacteristic *txChar = nullptr;
static volatile bool connected = false, justConnected = false, justDisconnected = false;
static bool streaming = false;
static uint16_t seq = 0;
static uint32_t linesSent = 0, overflows = 0;

static portMUX_TYPE cmdMux = portMUX_INITIALIZER_UNLOCKED;
static char cmdBuf[64];
static volatile bool cmdPending = false;

class ServerCb : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected = true; justConnected = true; }
  void onDisconnect(BLEServer *) override { connected = false; justDisconnected = true; }
};

class RxCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = c->getValue();
    portENTER_CRITICAL(&cmdMux);
    strncpy(cmdBuf, v.c_str(), sizeof(cmdBuf) - 1);
    cmdBuf[sizeof(cmdBuf) - 1] = 0;
    cmdPending = true;
    portEXIT_CRITICAL(&cmdMux);
  }
};

// Manda texto en pedazos del tamano que permite la conexion (MTU)
static void sendText(const char *s, size_t len) {
  if (!connected) return;
  uint16_t mtu = server->getPeerMTU(server->getConnId());
  size_t chunk = (mtu > 23) ? mtu - 3 : 20;
  if (chunk > 244) chunk = 244;
  for (size_t pos = 0; pos < len; pos += chunk) {
    size_t n = len - pos < chunk ? len - pos : chunk;
    txChar->setValue((uint8_t *)s + pos, n);
    txChar->notify();
  }
}

static void sendInfo() {
  char b[80];
  int n = snprintf(b, sizeof(b), "#INFO,%s,%lu,raw_mV;emg_mV,%d\n", BLE_NAME, (unsigned long)FS_HZ, SCALE);
  sendText(b, n);
}

static void handleCommand(char *c) {
  for (int i = strlen(c) - 1; i >= 0 && (c[i] == '\r' || c[i] == '\n' || c[i] == ' '); i--) c[i] = 0;
  Serial.printf("[BLE] Comando: %s\n", c);
  if (strncasecmp(c, "START", 5) == 0) {
    sendInfo();
    rIdx = wIdx;  // empezar desde "ahora"
    seq = 0;
    streaming = true;
  } else if (strncasecmp(c, "STOP", 4) == 0) {
    streaming = false;
  } else if (strncasecmp(c, "INFO", 4) == 0) {
    sendInfo();
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  analogReadResolution(12);
  analogSetPinAttenuation(EMG_PIN, ADC_11db);
  analogReadMilliVolts(EMG_PIN);

  BLEDevice::init(BLE_NAME);
  BLEDevice::setMTU(247);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  BLEService *svc = server->createService(NUS_SERVICE_UUID);
  txChar = svc->createCharacteristic(NUS_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic *rx = svc->createCharacteristic(
      NUS_RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCb());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  esp_timer_handle_t timer;
  esp_timer_create_args_t args = {};
  args.callback = sampleCb;
  args.name = "emg";
  esp_timer_create(&args, &timer);
  esp_timer_start_periodic(timer, 1000000ULL / FS_HZ);

  Serial.printf("[EMG_Captura_BLE] Pin D%d, %lu Hz. Anunciando '%s'. Abre la app y presiona Conectar.\n",
                EMG_PIN, (unsigned long)FS_HZ, BLE_NAME);
}

void loop() {
  if (justDisconnected) {
    justDisconnected = false;
    streaming = false;
    Serial.println("[BLE] App desconectada");
    delay(50);
    BLEDevice::startAdvertising();
  }
  if (justConnected) {
    justConnected = false;
    Serial.println("[BLE] App conectada");
  }
  if (cmdPending) {
    char c[sizeof(cmdBuf)];
    portENTER_CRITICAL(&cmdMux);
    memcpy(c, cmdBuf, sizeof(c));
    cmdPending = false;
    portEXIT_CRITICAL(&cmdMux);
    handleCommand(c);
  }

  if (streaming && connected) {
    uint32_t w = wIdx;
    // Si la app no alcanzo a recibir (buffer lleno), se saltan lineas completas y
    // seq avanza igual: la app sabe cuantas muestras faltan.
    if (w - rIdx > RING - BATCH) {
      uint32_t skip = ((w - rIdx) - RING / 2) / BATCH;
      rIdx += skip * BATCH;
      seq += skip;
      overflows++;
    }
    int lines = 0;
    while (w - rIdx >= (uint32_t)BATCH && lines < 4) {
      char line[420];   // 20 muestras x 2 valores x hasta 7 caracteres
      int n = snprintf(line, sizeof(line), "D,%u", seq);
      for (int i = 0; i < BATCH; i++) {
        uint32_t k = ((rIdx + i) % RING) * 2;
        n += snprintf(line + n, sizeof(line) - n, ",%ld,%ld", (long)ring[k], (long)ring[k + 1]);
      }
      line[n++] = '\n';
      sendText(line, n);
      rIdx += BATCH;
      seq++;
      linesSent++;
      lines++;
    }
  }

  // Serial: estado y plot
  static bool plotOn = false;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == 'p' || ch == 'P') plotOn = !plotOn;
  }
  static uint32_t lastPlot = 0, lastStat = 0;
  uint32_t now = millis();
  if (plotOn && now - lastPlot >= 20) {
    lastPlot = now;
    Serial.printf("EMG_mV:%.1f\n", (double)lastMv);
  }
  if (!plotOn && now - lastStat >= 5000) {
    lastStat = now;
    uint16_t mtu = connected ? server->getPeerMTU(server->getConnId()) : 0;
    Serial.printf("[ESTADO] conectado=%d enviando=%d MTU=%u lineas=%lu desbordes=%lu\n", connected, streaming, mtu,
                  (unsigned long)linesSent, (unsigned long)overflows);
  }
  delay(1);
}
