// TactSuit_IMU_BLE (PLANTILLA): Sistema tactil de orientacion espacial.
// Manda la aceleracion (ax, ay, az en g) por Bluetooth a la app web "Captura ML".
//
// Todavia no hay sensor definido: con SIMULAR = true manda datos de prueba
// (balanceo lento) para probar la app con cualquier ESP32. Cuando elijan el IMU,
// llenar leerIMU() y poner SIMULAR = false.
//
// Bluetooth: se anuncia como "TactSuit-IMU" con el servicio Nordic UART (NUS),
// mismo protocolo que EMG_Captura_BLE:
//   App -> ESP (RX):  START | STOP | INFO
//   ESP -> App (TX):  #INFO,TactSuit-IMU,100,ax_g;ay_g;az_g,1000
//                     D,<seq>,ax,ay,az,ax,ay,az,...   (5 muestras por linea, en mili-g)
//
// Placa en Arduino: "ESP32 Dev Module" (o la que usen). Core de ESP32 3.x.

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <math.h>

// ---- Configuracion ------------------------------------------------------------
constexpr const char *BLE_NAME = "TactSuit-IMU";
constexpr bool SIMULAR = true;       // false cuando leerIMU() lea el sensor real
constexpr uint32_t FS_HZ = 100;      // muestras por segundo
constexpr int SCALE = 1000;          // se mandan mili-g (1000 = 1 g)
constexpr int BATCH = 5;             // muestras por linea (50 ms)
constexpr int NCH = 3;               // ax, ay, az

#define NUS_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_UUID "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_TX_UUID "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// ---- Sensor -------------------------------------------------------------------
void iniciarIMU() {
  // TODO: Wire.begin(SDA, SCL); inicializar el sensor (MPU6050, BNO055, LSM6DS3, ...)
}

// Devuelve la aceleracion en g
void leerIMU(float &ax, float &ay, float &az) {
  if (SIMULAR) {
    float t = millis() / 1000.0f;
    ax = 0.08f * sinf(2 * PI * 0.25f * t) + 0.005f * (random(-100, 100) / 100.0f);
    ay = 0.06f * cosf(2 * PI * 0.18f * t) + 0.005f * (random(-100, 100) / 100.0f);
    az = 1.0f + 0.005f * (random(-100, 100) / 100.0f);
    return;
  }
  // TODO: leer el sensor real y convertir a g
  ax = ay = az = 0;
}

// ---- BLE ---------------------------------------------------------------------------
static BLEServer *server = nullptr;
static BLECharacteristic *txChar = nullptr;
static volatile bool connected = false, justDisconnected = false;
static bool streaming = false;
static uint16_t seq = 0;

static portMUX_TYPE cmdMux = portMUX_INITIALIZER_UNLOCKED;
static char cmdBuf[64];
static volatile bool cmdPending = false;

class ServerCb : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected = true; }
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
  int n = snprintf(b, sizeof(b), "#INFO,%s,%lu,ax_g;ay_g;az_g,%d\n", BLE_NAME, (unsigned long)FS_HZ, SCALE);
  sendText(b, n);
}

static int batchVals[BATCH * NCH];
static int batchCount = 0;

static void handleCommand(char *c) {
  for (int i = strlen(c) - 1; i >= 0 && (c[i] == '\r' || c[i] == '\n' || c[i] == ' '); i--) c[i] = 0;
  Serial.printf("[BLE] Comando: %s\n", c);
  if (strncasecmp(c, "START", 5) == 0) {
    sendInfo();
    seq = 0;
    batchCount = 0;
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
  iniciarIMU();

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
  Serial.printf("[TactSuit] %s, %lu Hz. Anunciando '%s'.\n", SIMULAR ? "SIMULADO" : "IMU real",
                (unsigned long)FS_HZ, BLE_NAME);
}

void loop() {
  if (justDisconnected) {
    justDisconnected = false;
    streaming = false;
    delay(50);
    BLEDevice::startAdvertising();
  }
  if (cmdPending) {
    char c[sizeof(cmdBuf)];
    portENTER_CRITICAL(&cmdMux);
    memcpy(c, cmdBuf, sizeof(c));
    cmdPending = false;
    portEXIT_CRITICAL(&cmdMux);
    handleCommand(c);
  }

  // Muestreo a FS_HZ
  static uint32_t next = micros();
  if ((int32_t)(micros() - next) >= 0) {
    next += 1000000UL / FS_HZ;
    float ax, ay, az;
    leerIMU(ax, ay, az);
    if (streaming && connected) {
      batchVals[batchCount * NCH + 0] = lroundf(ax * SCALE);
      batchVals[batchCount * NCH + 1] = lroundf(ay * SCALE);
      batchVals[batchCount * NCH + 2] = lroundf(az * SCALE);
      if (++batchCount == BATCH) {
        char line[200];
        int n = snprintf(line, sizeof(line), "D,%u", seq++);
        for (int i = 0; i < BATCH * NCH; i++) n += snprintf(line + n, sizeof(line) - n, ",%d", batchVals[i]);
        line[n++] = '\n';
        sendText(line, n);
        batchCount = 0;
      }
    }
  }
}
