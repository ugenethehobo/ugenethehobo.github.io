// Hue Hub: an ESP32 that stands in for the Hue Bridge.
//
// It keeps a WebSocket open to your Home Lights server on Cloudflare and talks
// Bluetooth to Philips Hue Bluetooth lights: it finds and pairs them, keeps
// them connected, sets colour and brightness, runs slow fades for schedules,
// and plays game-day light shows itself so their timing is exact.
//
// First start: join the "Hue-Hub-xxxx" Wi-Fi from your phone, pick your home
// Wi-Fi and enter your server address. Then approve the hub in the app.
// Hold the BOOT button for 5 seconds to start setup again.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <WiFiManager.h>

#include <algorithm>
#include <deque>
#include <set>
#include <string>
#include <vector>

#define FW_VERSION "1.0.0"

// BOOT_PIN (the board's BOOT button) comes from the ESP32 core, per chip.

// How many lights stay connected at once (the Bluetooth stack allows 9;
// one is kept free for pairing). More lights still work: the least recently
// used one is dropped to make room, which adds a second or two of delay.
static const size_t POOL = 8;

// ---------- Hue Bluetooth (GATT) ----------
static const NimBLEUUID HUE_ADV((uint16_t)0xFE0F);
static const NimBLEUUID LIGHT_SVC("932c32bd-0000-47a2-835a-a8d455b859dd");
static const NimBLEUUID CHR_POWER("932c32bd-0002-47a2-835a-a8d455b859dd");  // 1 byte: 0/1
static const NimBLEUUID CHR_BRI("932c32bd-0003-47a2-835a-a8d455b859dd");    // 1 byte: 1-254
static const NimBLEUUID CHR_CT("932c32bd-0004-47a2-835a-a8d455b859dd");     // uint16 mireds, 0xFFFF in colour mode
static const NimBLEUUID CHR_XY("932c32bd-0005-47a2-835a-a8d455b859dd");     // 2 x uint16 (x, y) * 0xFFFF
static const NimBLEUUID CHR_COMBO("932c32bd-0007-47a2-835a-a8d455b859dd");  // type/length/value list
static const NimBLEUUID CHR_NAME("97fe6561-0003-4f62-86e9-b71ee2da3d22");
static const NimBLEUUID DEVINFO_SVC((uint16_t)0x180A);
static const NimBLEUUID CHR_MODEL((uint16_t)0x2A24);

enum Mode : uint8_t { MODE_NONE = 0, MODE_XY = 1, MODE_CT = 2 };

struct LState {
  bool on = false;
  uint8_t bri = 254;
  Mode mode = MODE_NONE;
  float x = 0.4, y = 0.4;
  uint16_t ct = 366;
};

struct Light;

class LightCallbacks : public NimBLEClientCallbacks {
 public:
  Light* light = nullptr;
  void onDisconnect(NimBLEClient* client, int reason) override;
};

struct Light {
  String id;  // "aa:bb:cc:dd:ee:ff"
  uint8_t addrType = 0;
  String name;
  String model;
  bool capXy = true, capCt = true;
  NimBLEClient* client = nullptr;
  NimBLERemoteCharacteristic *power = nullptr, *bri = nullptr, *ct = nullptr, *xy = nullptr, *combo = nullptr;
  LightCallbacks cb;
  volatile bool connected = false;
  volatile bool dropped = false;  // set by the Bluetooth task when the link drops
  bool pendingWrite = false;      // a change is waiting for a connection
  bool standby = false;           // dropped to make room; reconnects when needed
  LState want;                    // the waiting change
  uint32_t lastUse = 0, nextTry = 0, backoff = 2000;
  LState base;   // what the light should show when no show is running
  LState shown;  // what we last wrote
  bool shownValid = false;
  // A slow fade (schedules).
  bool fading = false, fadeOff = false;
  LState fadeFrom, fadeTo;
  uint32_t fadeStart = 0, fadeMs = 0, fadeNext = 0;
};

void LightCallbacks::onDisconnect(NimBLEClient* client, int) {
  // Ignore a late notice from a connection we already replaced.
  if (light && light->client == client) {
    light->connected = false;
    light->dropped = true;
  }
}

struct Frame {
  LState a, b;
  bool hasB = false;
  uint16_t ms = 300;
};

struct Show {
  bool active = false;
  std::vector<String> ids;
  std::vector<Frame> frames;
  size_t idx = 0;
  uint32_t nextAt = 0;
} show;

static std::vector<Light*> lights;  // touched only by the light task after setup
static Preferences prefs;
static WebSocketsClient ws;
static WiFiManager wm;

static String hubId, server, token;
static String host, path;
static uint16_t port = 443;
static bool secure = true;
static volatile bool wsReady = false, wsPending = false, restartWs = false;

static QueueHandle_t inbox;           // char* messages from the server for the light task
static SemaphoreHandle_t outLock;     // guards outbox
static std::deque<String> outbox;     // messages for the server

// Scanning
static volatile bool scanning = false;
static uint32_t scanUntil = 0;
static std::set<std::string> seen;
static SemaphoreHandle_t seenLock;

// ---------- helpers ----------

static void emit(JsonDocument& doc) {
  String s;
  serializeJson(doc, s);
  xSemaphoreTake(outLock, portMAX_DELAY);
  outbox.push_back(s);
  while (outbox.size() > 40) outbox.pop_front();
  xSemaphoreGive(outLock);
}

static void logLine(const String& text) {
  Serial.println(text);
  JsonDocument d;
  d["t"] = "log";
  d["text"] = text;
  emit(d);
}

static Light* findLight(const String& id) {
  for (auto* l : lights)
    if (l->id.equalsIgnoreCase(id)) return l;
  return nullptr;
}

static uint8_t clampBri(int v) { return (uint8_t)constrain(v, 1, 254); }

static void putState(JsonObject o, const LState& s) {
  o["on"] = s.on;
  o["bri"] = s.bri;
  if (s.mode == MODE_XY) {
    JsonArray a = o["xy"].to<JsonArray>();
    a.add(roundf(s.x * 10000) / 10000);
    a.add(roundf(s.y * 10000) / 10000);
    o["mode"] = "xy";
  } else if (s.mode == MODE_CT) {
    o["ct"] = s.ct;
    o["mode"] = "ct";
  }
}

// Applies {on, bri, xy | ct} from the server on top of a state.
static LState applyJson(LState s, JsonVariantConst j, const Light* l) {
  if (j["on"].is<bool>()) s.on = j["on"].as<bool>();
  if (j["bri"].is<int>()) s.bri = clampBri(j["bri"].as<int>());
  if (j["xy"].is<JsonArrayConst>() && (!l || l->capXy)) {
    s.x = j["xy"][0].as<float>();
    s.y = j["xy"][1].as<float>();
    s.mode = MODE_XY;
  } else if (j["ct"].is<int>() && (!l || l->capCt)) {
    s.ct = (uint16_t)constrain(j["ct"].as<int>(), 153, 500);
    s.mode = MODE_CT;
  } else if (j["xy"].is<JsonArrayConst>() && l && !l->capXy && l->capCt) {
    s.ct = 300;  // colour asked of a white-only light: use a neutral white
    s.mode = MODE_CT;
  }
  return s;
}

// ---------- saving paired lights ----------

static void saveLights() {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (auto* l : lights) {
    JsonObject o = a.add<JsonObject>();
    o["id"] = l->id;
    o["t"] = l->addrType;
    o["n"] = l->name;
    o["m"] = l->model;
    o["x"] = l->capXy;
    o["c"] = l->capCt;
  }
  String s;
  serializeJson(d, s);
  prefs.putString("lights", s);
}

static void loadLights() {
  JsonDocument d;
  if (deserializeJson(d, prefs.getString("lights", "[]"))) return;
  for (JsonObject o : d.as<JsonArray>()) {
    auto* l = new Light();
    l->id = o["id"].as<String>();
    l->addrType = o["t"] | 0;
    l->name = o["n"] | "Hue light";
    l->model = o["m"] | "";
    l->capXy = o["x"] | true;
    l->capCt = o["c"] | true;
    l->cb.light = l;
    lights.push_back(l);
  }
}

// ---------- talking to a light ----------

static bool write(NimBLERemoteCharacteristic* c, const uint8_t* data, size_t len, bool fast) {
  if (!c) return false;
  bool response = !fast || !c->canWriteNoResponse();
  return c->writeValue(data, len, response);
}

// Writes a state. Turning on: power first. Turning off: colour first, then
// power, so the light keeps that colour for next time.
static bool writeState(Light* l, const LState& s, bool fast) {
  if (!l->connected || !l->client || !l->client->isConnected()) return false;
  bool ok = true;
  const LState& was = l->shown;
  uint16_t x = (uint16_t)constrain(lroundf(s.x * 65535.0f), 0, 65535);
  uint16_t y = (uint16_t)constrain(lroundf(s.y * 65535.0f), 0, 65535);
  if (s.on && l->combo) {
    uint8_t buf[16];
    size_t n = 0;
    buf[n++] = 0x01, buf[n++] = 1, buf[n++] = 1;
    buf[n++] = 0x02, buf[n++] = 1, buf[n++] = s.bri;
    if (s.mode == MODE_XY && l->capXy) {
      buf[n++] = 0x04, buf[n++] = 4;
      buf[n++] = x & 0xFF, buf[n++] = x >> 8, buf[n++] = y & 0xFF, buf[n++] = y >> 8;
    } else if (s.mode == MODE_CT && l->capCt) {
      buf[n++] = 0x03, buf[n++] = 2, buf[n++] = s.ct & 0xFF, buf[n++] = s.ct >> 8;
    }
    ok = write(l->combo, buf, n, fast);
  } else {
    bool force = !l->shownValid;
    if (s.on && (force || !was.on)) {
      uint8_t v = 1;
      ok &= write(l->power, &v, 1, fast);
    }
    if (force || s.bri != was.bri) ok &= write(l->bri, &s.bri, 1, fast);
    if (s.mode == MODE_XY && l->capXy && (force || was.mode != MODE_XY || was.x != s.x || was.y != s.y)) {
      uint8_t b[4] = {(uint8_t)(x & 0xFF), (uint8_t)(x >> 8), (uint8_t)(y & 0xFF), (uint8_t)(y >> 8)};
      ok &= write(l->xy, b, 4, fast);
    } else if (s.mode == MODE_CT && l->capCt && (force || was.mode != MODE_CT || was.ct != s.ct)) {
      uint8_t b[2] = {(uint8_t)(s.ct & 0xFF), (uint8_t)(s.ct >> 8)};
      ok &= write(l->ct, b, 2, fast);
    }
    if (!s.on && (force || was.on)) {
      uint8_t v = 0;
      ok &= write(l->power, &v, 1, fast);
    }
  }
  l->shown = s;
  l->shownValid = true;
  return ok;
}

static void readState(Light* l) {
  LState s = l->base;
  if (l->power && l->power->canRead()) {
    NimBLEAttValue v = l->power->readValue();
    if (v.size() >= 1) s.on = v.data()[0] != 0;
  }
  if (l->bri && l->bri->canRead()) {
    NimBLEAttValue v = l->bri->readValue();
    if (v.size() >= 1) s.bri = clampBri(v.data()[0]);
  }
  bool xyValid = false, ctValid = false;
  if (l->xy && l->xy->canRead()) {
    NimBLEAttValue v = l->xy->readValue();
    if (v.size() >= 4) {
      uint16_t x = v.data()[0] | (v.data()[1] << 8), y = v.data()[2] | (v.data()[3] << 8);
      if (!(x == 0xFFFF && y == 0xFFFF)) {
        s.x = x / 65535.0f, s.y = y / 65535.0f;
        xyValid = true;
      }
    }
  }
  if (l->ct && l->ct->canRead()) {
    NimBLEAttValue v = l->ct->readValue();
    if (v.size() >= 2) {
      uint16_t c = v.data()[0] | (v.data()[1] << 8);
      if (c != 0xFFFF && c >= 100 && c <= 1000) {
        s.ct = constrain(c, 153, 500);
        ctValid = true;
      }
    }
  }
  s.mode = ctValid ? MODE_CT : xyValid ? MODE_XY : s.mode;
  l->base = s;
  l->shown = s;
  l->shownValid = true;
}

static void report(Light* l) {
  JsonDocument d;
  d["t"] = "light";
  d["id"] = l->id;
  d["connected"] = (bool)l->connected;
  d["standby"] = l->standby;
  if (l->connected) putState(d.as<JsonObject>(), l->base);
  emit(d);
}

static String readText(NimBLERemoteCharacteristic* c) {
  if (!c->canRead()) return "";
  NimBLEAttValue v = c->readValue();
  std::string s(reinterpret_cast<const char*>(v.data()), v.size());
  return String(s.c_str());
}

static NimBLERemoteCharacteristic* findChar(NimBLEClient* c, const NimBLEUUID& uuid) {
  for (auto* svc : c->getServices(false)) {
    if (auto* ch = svc->getCharacteristic(uuid)) return ch;
  }
  return nullptr;
}

static bool bindChars(Light* l) {
  NimBLERemoteService* svc = l->client->getService(LIGHT_SVC);
  if (!svc) return false;
  l->power = svc->getCharacteristic(CHR_POWER);
  l->bri = svc->getCharacteristic(CHR_BRI);
  l->ct = svc->getCharacteristic(CHR_CT);
  l->xy = svc->getCharacteristic(CHR_XY);
  l->combo = svc->getCharacteristic(CHR_COMBO);
  if (l->combo && !(l->combo->canWrite() || l->combo->canWriteNoResponse())) l->combo = nullptr;
  l->capXy = l->xy != nullptr;
  l->capCt = l->ct != nullptr;
  return l->power != nullptr;
}

static void freeClient(Light* l) {
  if (l->client) {
    l->client->setClientCallbacks(nullptr, false);  // no notices from this one any more
    if (l->client->isConnected()) l->client->disconnect();
    NimBLEDevice::deleteClient(l->client);
    l->client = nullptr;
  }
  l->power = l->bri = l->ct = l->xy = l->combo = nullptr;
  l->connected = false;
  l->shownValid = false;
}

static size_t connectedCount() {
  size_t n = 0;
  for (auto* l : lights)
    if (l->connected) n++;
  return n;
}

// Drops the least recently used connection to make room.
static bool makeRoom(Light* except) {
  Light* victim = nullptr;
  for (auto* l : lights) {
    if (!l->connected || l == except || l->pendingWrite) continue;
    if (!victim || l->lastUse < victim->lastUse) victim = l;
  }
  if (!victim) return false;
  freeClient(victim);
  victim->standby = true;
  victim->nextTry = millis() + 10 * 60 * 1000;  // don't take the slot straight back
  report(victim);
  return true;
}

static bool connectLight(Light* l, uint32_t timeoutMs, String* error) {
  if (connectedCount() >= POOL && !makeRoom(l)) {
    if (error) *error = "Too many lights on this hub";
    return false;
  }
  if (!l->client) {
    l->client = NimBLEDevice::createClient(NimBLEAddress(std::string(l->id.c_str()), l->addrType));
    if (!l->client) {
      if (error) *error = "No free Bluetooth slot";
      return false;
    }
    l->client->setClientCallbacks(&l->cb, false);
    l->client->setConnectionParams(12, 24, 0, 400);
  }
  l->client->setConnectTimeout(timeoutMs);
  l->dropped = false;
  if (!l->client->connect(true, false, false)) {
    if (error) *error = "The light didn't answer";
    freeClient(l);
    return false;
  }
  // Hue lights only take commands over an encrypted (bonded) link.
  if (!l->client->secureConnection()) {
    if (error) *error = "The light refused to pair";
    freeClient(l);
    return false;
  }
  if (!bindChars(l)) {
    if (error) *error = "That isn't a Hue Bluetooth light";
    freeClient(l);
    return false;
  }
  l->connected = true;
  l->dropped = false;
  l->standby = false;
  l->backoff = 2000;
  return true;
}

// ---------- shows and fades ----------

static void stopShowFor(const String& id) {
  if (!show.active) return;
  for (auto& s : show.ids)
    if (s.equalsIgnoreCase(id)) s = "";
}

static void endShow() {
  for (auto& id : show.ids) {
    if (Light* l = findLight(id)) writeState(l, l->base, false);
  }
  show = Show();
}

static void runShow() {
  if (!show.active || (int32_t)(millis() - show.nextAt) < 0) return;
  if (show.idx >= show.frames.size()) {
    endShow();
    return;
  }
  const Frame& f = show.frames[show.idx];
  uint32_t start = millis();
  for (size_t i = 0; i < show.ids.size(); i++) {
    if (show.ids[i].isEmpty()) continue;
    Light* l = findLight(show.ids[i]);
    if (!l || !l->connected) continue;
    l->lastUse = start;
    writeState(l, (f.hasB && (i % 2 == 1)) ? f.b : f.a, true);
  }
  show.nextAt = start + f.ms;
  show.idx++;
}

static LState mix(const LState& a, const LState& b, float t) {
  LState s = b;
  s.on = true;
  s.bri = clampBri(lroundf(a.bri + (b.bri - a.bri) * t));
  if (a.mode == b.mode && b.mode == MODE_XY) {
    s.x = a.x + (b.x - a.x) * t;
    s.y = a.y + (b.y - a.y) * t;
  } else if (a.mode == b.mode && b.mode == MODE_CT) {
    s.ct = (uint16_t)lroundf(a.ct + (b.ct - a.ct) * t);
  }
  return s;
}

static void startFade(Light* l, const LState& target, uint32_t ms) {
  LState from = l->shownValid ? l->shown : l->base;
  if (!from.on) {
    from = target;  // fading in from off: start dim in the target colour
    from.bri = 1;
    from.on = true;
  }
  l->fadeFrom = from;
  l->fadeTo = target;
  l->fadeOff = !target.on;
  if (l->fadeOff) {
    l->fadeTo = from;
    l->fadeTo.bri = 1;
  }
  l->fadeStart = millis();
  l->fadeMs = ms;
  l->fadeNext = 0;
  l->fading = true;
}

static void runFades() {
  uint32_t now = millis();
  for (auto* l : lights) {
    if (!l->fading || !l->connected || (int32_t)(now - l->fadeNext) < 0) continue;
    float t = (float)(now - l->fadeStart) / (float)l->fadeMs;
    if (t >= 1) {
      l->fading = false;
      if (l->fadeOff) {
        LState off = l->fadeTo;
        off.on = false;
        writeState(l, off, false);
      } else {
        writeState(l, l->fadeTo, false);
      }
      continue;
    }
    LState s = mix(l->fadeFrom, l->fadeTo, t);
    if (!l->shownValid || s.bri != l->shown.bri || s.ct != l->shown.ct || fabsf(s.x - l->shown.x) > 0.002f || fabsf(s.y - l->shown.y) > 0.002f) {
      writeState(l, s, false);
    }
    l->fadeNext = now + std::max<uint32_t>(400, l->fadeMs / 300);
  }
}

// ---------- commands from the server ----------

static void cmdSet(JsonDocument& m) {
  uint32_t ms = m["ms"] | 0;
  for (JsonVariantConst idv : m["ids"].as<JsonArrayConst>()) {
    Light* l = findLight(idv.as<String>());
    if (!l) continue;
    stopShowFor(l->id);
    l->fading = false;
    l->base = applyJson(l->base, m["s"], l);
    l->lastUse = millis();
    if (!l->connected) {
      l->want = l->base;
      l->pendingWrite = true;
      l->nextTry = 0;
      l->backoff = 2000;
      continue;
    }
    if (ms > 1500) startFade(l, l->base, ms);
    else writeState(l, l->base, false);
  }
}

static void cmdShow(JsonDocument& m) {
  if (show.active) endShow();
  Show s;
  for (JsonVariantConst idv : m["ids"].as<JsonArrayConst>()) {
    Light* l = findLight(idv.as<String>());
    if (!l) continue;
    l->fading = false;
    s.ids.push_back(l->id);
  }
  for (JsonVariantConst f : m["steps"].as<JsonArrayConst>()) {
    if (s.frames.size() >= 120) break;
    Frame fr;
    fr.a = applyJson(LState(), f["a"], nullptr);
    if (!f["b"].isNull()) {
      fr.b = applyJson(LState(), f["b"], nullptr);
      fr.hasB = true;
    }
    fr.ms = (uint16_t)constrain(f["ms"] | 300, 50, 10000);
    s.frames.push_back(fr);
  }
  if (s.ids.empty() || s.frames.empty()) return;
  s.active = true;
  s.nextAt = millis();
  show = s;
}

static void cmdScan(int sec) {
  NimBLEScan* scan = NimBLEDevice::getScan();
  if (sec <= 0) {
    scan->stop();
    scanning = false;
    return;
  }
  xSemaphoreTake(seenLock, portMAX_DELAY);
  seen.clear();
  xSemaphoreGive(seenLock);
  scan->clearResults();
  scanning = scan->start(sec * 1000, false, true);
  scanUntil = millis() + sec * 1000;
  logLine(scanning ? "Searching for Hue lights" : "Couldn't start searching");
}

static void cmdPair(const String& idIn, int addrType) {
  String id = idIn;
  id.toLowerCase();
  NimBLEDevice::getScan()->stop();
  scanning = false;
  JsonDocument d;
  d["t"] = "paired";
  d["id"] = id;

  Light* l = findLight(id);
  bool isNew = !l;
  if (isNew) {
    l = new Light();
    l->id = id;
    l->addrType = addrType >= 0 ? addrType : 0;
    l->cb.light = l;
  } else {
    freeClient(l);
  }
  String error;
  bool ok = connectLight(l, 8000, &error);
  if (!ok && error == "The light refused to pair") {
    NimBLEDevice::deleteBond(NimBLEAddress(std::string(id.c_str()), l->addrType));
  }
  if (!ok) {
    d["ok"] = false;
    d["error"] = error + ". Make sure the Hue app on your PC is closed, the light is near the hub, and the light is in pairing mode (see the app).";
    if (isNew) delete l;
    emit(d);
    return;
  }
  // Model and name, for the app.
  if (auto* svc = l->client->getService(DEVINFO_SVC)) {
    if (auto* c = svc->getCharacteristic(CHR_MODEL)) l->model = readText(c);
  }
  if (auto* c = findChar(l->client, CHR_NAME)) {
    String n = readText(c);
    if (n.length()) l->name = n;
  }
  if (!l->name.length()) l->name = "Hue light";
  readState(l);
  l->lastUse = millis();
  if (isNew) lights.push_back(l);
  saveLights();
  d["ok"] = true;
  d["name"] = l->name;
  d["model"] = l->model;
  d["caps"]["xy"] = l->capXy;
  d["caps"]["ct"] = l->capCt;
  putState(d.as<JsonObject>(), l->base);
  emit(d);
  logLine("Paired " + l->name);
}

static void cmdForget(const String& id) {
  for (size_t i = 0; i < lights.size(); i++) {
    Light* l = lights[i];
    if (!l->id.equalsIgnoreCase(id)) continue;
    stopShowFor(l->id);
    freeClient(l);
    NimBLEDevice::deleteBond(NimBLEAddress(std::string(l->id.c_str()), l->addrType));
    lights.erase(lights.begin() + i);
    delete l;
    saveLights();
    return;
  }
}

static void cmdRename(const String& id, const String& name) {
  Light* l = findLight(id);
  if (!l) return;
  l->name = name;
  saveLights();
  if (l->connected) {
    if (auto* c = findChar(l->client, CHR_NAME)) c->writeValue((const uint8_t*)name.c_str(), name.length(), true);
  }
}

static void sendHello() {
  JsonDocument d;
  d["t"] = "hello";
  d["fw"] = FW_VERSION;
  d["pool"] = POOL;
  JsonArray a = d["lights"].to<JsonArray>();
  for (auto* l : lights) {
    JsonObject o = a.add<JsonObject>();
    o["id"] = l->id;
    o["name"] = l->name;
    o["model"] = l->model;
    o["caps"]["xy"] = l->capXy;
    o["caps"]["ct"] = l->capCt;
    o["connected"] = (bool)l->connected;
    o["standby"] = l->standby;
    if (l->connected) putState(o, l->base);
  }
  emit(d);
}

static void handle(char* text) {
  JsonDocument m;
  if (deserializeJson(m, text)) return;
  String t = m["t"] | "";
  if (t == "set") cmdSet(m);
  else if (t == "fx") cmdShow(m);
  else if (t == "scan") cmdScan(m["sec"] | 30);
  else if (t == "pair") cmdPair(m["id"] | "", m["addrType"].isNull() ? -1 : (int)m["addrType"]);
  else if (t == "forget") cmdForget(m["id"] | "");
  else if (t == "rename") cmdRename(m["id"] | "", m["name"] | "");
  else if (t == "hello") sendHello();
}

// ---------- keeping lights connected ----------

static void maintain() {
  uint32_t now = millis();
  for (auto* l : lights) {
    if (l->dropped) {
      l->dropped = false;
      freeClient(l);
      l->nextTry = now + 1000;
      report(l);
    }
  }
  if (show.active || scanning) return;  // connecting blocks; don't stutter a show
  // One connection attempt per pass: lights with a waiting change first,
  // then the most recently used.
  Light* best = nullptr;
  for (auto* l : lights) {
    if (l->connected || (int32_t)(now - l->nextTry) < 0) continue;
    if (!l->pendingWrite && connectedCount() >= POOL) continue;
    if (!best || (l->pendingWrite && !best->pendingWrite) || (l->pendingWrite == best->pendingWrite && l->lastUse > best->lastUse)) best = l;
  }
  if (!best) return;
  String error;
  if (connectLight(best, 5000, &error)) {
    readState(best);
    if (best->pendingWrite) {
      best->pendingWrite = false;
      best->base = best->want;
      writeState(best, best->base, false);
    }
    report(best);
  } else {
    best->nextTry = millis() + best->backoff;
    best->backoff = std::min<uint32_t>(best->backoff * 2, 60000);
    if (best->pendingWrite && best->backoff >= 16000) best->pendingWrite = false;  // give up on stale changes
  }
}

static void lightTask(void*) {
  for (;;) {
    char* msg = nullptr;
    while (xQueueReceive(inbox, &msg, 0) == pdTRUE) {
      handle(msg);
      free(msg);
    }
    if (scanning && (int32_t)(millis() - scanUntil) >= 0) {
      scanning = false;
      JsonDocument d;
      d["t"] = "scanDone";
      emit(d);
    }
    runShow();
    runFades();
    maintain();
    vTaskDelay(pdMS_TO_TICKS(show.active ? 5 : 20));
  }
}

class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* dev) override {
    bool hue = dev->isAdvertisingService(HUE_ADV);
    for (uint8_t i = 0; !hue && i < dev->getServiceDataCount(); i++) hue = dev->getServiceDataUUID(i) == HUE_ADV;
    std::string name = dev->getName();
    if (!hue && name.rfind("Hue", 0) != 0) return;
    std::string addr = dev->getAddress().toString();
    xSemaphoreTake(seenLock, portMAX_DELAY);
    bool fresh = seen.insert(addr).second;
    xSemaphoreGive(seenLock);
    if (!fresh) return;
    JsonDocument d;
    d["t"] = "found";
    d["id"] = addr.c_str();
    d["name"] = name.length() ? name.c_str() : "Hue light";
    d["rssi"] = dev->getRSSI();
    d["addrType"] = dev->getAddress().getType();
    emit(d);
  }
  void onScanEnd(const NimBLEScanResults&, int) override { scanning = false; }
} scanCallbacks;

// ---------- the server connection ----------

static void parseServer() {
  String s = server;
  s.trim();
  secure = !s.startsWith("http://");
  if (s.startsWith("https://")) s = s.substring(8);
  if (s.startsWith("http://")) s = s.substring(7);
  int slash = s.indexOf('/');
  if (slash >= 0) s = s.substring(0, slash);
  int colon = s.indexOf(':');
  port = secure ? 443 : 80;
  if (colon >= 0) {
    port = s.substring(colon + 1).toInt();
    s = s.substring(0, colon);
  }
  host = s;
}

static void startWs() {
  parseServer();
  path = "/api/hub?id=" + hubId + "&fw=" FW_VERSION;
  if (token.length()) path += "&token=" + token;
  wsReady = false;
  wsPending = false;
  if (secure) ws.beginSSL(host.c_str(), port, path.c_str());
  else ws.begin(host.c_str(), port, path.c_str());
  ws.setReconnectInterval(5000);
  ws.enableHeartbeat(15000, 5000, 2);
}

static void onWs(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("Connected to server");
      break;
    case WStype_DISCONNECTED:
      wsReady = false;
      wsPending = false;
      break;
    case WStype_TEXT: {
      JsonDocument m;
      if (deserializeJson(m, (const char*)payload, length)) return;
      String t = m["t"] | "";
      if (t == "pending") {
        wsPending = true;
        Serial.println("Waiting for approval in the app. Hub ID: " + hubId);
      } else if (t == "welcome") {
        token = m["token"] | "";
        prefs.putString("token", token);
        restartWs = true;  // reconnect with the token
      } else if (t == "ready") {
        wsReady = true;
        wsPending = false;
        const char hello[] = "{\"t\":\"hello\"}";
        char* copy = strdup(hello);
        if (copy && xQueueSend(inbox, &copy, 0) != pdTRUE) free(copy);
      } else if (wsReady) {
        char* copy = (char*)malloc(length + 1);
        if (!copy) return;
        memcpy(copy, payload, length);
        copy[length] = 0;
        if (xQueueSend(inbox, &copy, 0) != pdTRUE) free(copy);
      }
      break;
    }
    default:
      break;
  }
}

// ---------- setup portal, button and LED ----------

static void setLed(bool on) {
#if defined(LED_BUILTIN)
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
#else
  (void)on;
#endif
}

static void blinkLed() {
  uint32_t t = millis();
  bool on;
  if (wsReady) on = true;                                  // steady: all good
  else if (wsPending) on = (t % 1000) < 100 || ((t % 1000) > 200 && (t % 1000) < 300);  // double blink: approve me
  else on = (t % 1000) < 500;                               // slow blink: connecting
  setLed(on);
}

static void runPortal(bool force) {
  static String introHtml = "<p>Hub ID: <b>" + hubId + "</b></p>";
  WiFiManagerParameter intro(introHtml.c_str());
  WiFiManagerParameter pServer("server", "Server address (e.g. home-lights.you.workers.dev)", server.c_str(), 120);
  wm.addParameter(&intro);
  wm.addParameter(&pServer);
  wm.setTitle("Hue Hub");
  wm.setSaveParamsCallback([&]() {
    server = pServer.getValue();
    server.trim();
    prefs.putString("server", server);
  });
  wm.setSaveConfigCallback([&]() {
    server = pServer.getValue();
    server.trim();
    prefs.putString("server", server);
  });
  String ap = "Hue-Hub-" + hubId.substring(hubId.length() - 4);
  bool ok;
  if (force) {
    wm.setConfigPortalTimeout(0);
    ok = wm.startConfigPortal(ap.c_str());
  } else {
    wm.setConfigPortalTimeout(180);
    wm.setConnectTimeout(30);
    ok = wm.autoConnect(ap.c_str());
  }
  if (!ok) ESP.restart();
}

static void checkButton() {
  static uint32_t downSince = 0;
  if (digitalRead(BOOT_PIN) == LOW) {
    if (!downSince) downSince = millis();
    if (millis() - downSince > 5000) {
      Serial.println("Resetting setup");
      setLed(true);
      prefs.remove("server");
      prefs.remove("token");
      wm.resetSettings();
      delay(500);
      ESP.restart();
    }
  } else {
    downSince = 0;
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(BOOT_PIN, INPUT_PULLUP);
#if defined(LED_BUILTIN)
  pinMode(LED_BUILTIN, OUTPUT);
#endif
  prefs.begin("hub", false);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char idbuf[16];
  snprintf(idbuf, sizeof idbuf, "hub-%02x%02x%02x", mac[3], mac[4], mac[5]);
  hubId = idbuf;
  server = prefs.getString("server", "");
  token = prefs.getString("token", "");
  Serial.printf("Hue Hub %s, firmware %s\n", hubId.c_str(), FW_VERSION);

  runPortal(server.isEmpty());

  inbox = xQueueCreate(16, sizeof(char*));
  outLock = xSemaphoreCreateMutex();
  seenLock = xSemaphoreCreateMutex();

  NimBLEDevice::init("Hue Hub");
  NimBLEDevice::setPower(9);
  NimBLEDevice::setSecurityAuth(true, false, true);  // bond, no PIN, secure connections
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&scanCallbacks, false);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(80);

  loadLights();
  Serial.printf("%u paired lights\n", (unsigned)lights.size());
  xTaskCreate(lightTask, "lights", 10240, nullptr, 2, nullptr);

  ws.onEvent(onWs);
  startWs();
}

void loop() {
  checkButton();
  ws.loop();
  if (restartWs) {
    restartWs = false;
    ws.disconnect();
    startWs();
  }
  if (wsReady) {
    for (int i = 0; i < 8; i++) {
      String s;
      xSemaphoreTake(outLock, portMAX_DELAY);
      if (!outbox.empty()) {
        s = outbox.front();
        outbox.pop_front();
      }
      xSemaphoreGive(outLock);
      if (s.isEmpty()) break;
      ws.sendTXT(s);
    }
  }
  blinkLed();
  delay(2);
}
