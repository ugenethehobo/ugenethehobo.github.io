# Home Climate

A fast, private phone app for the Amazon Smart Thermostat, built to replace the Alexa app's thermostat screens.

- **Fast and clear.** Big −/+ buttons with the target front and center. Every change shows its progress: *Sending… → Sent · waiting for thermostat → ✓ Thermostat confirmed*. If it fails you see why, with a **Retry** button. A status pill at the top always shows whether the data is live and how old it is.
- **Pick your temperature sensor in one tap.** Each sensor (the thermostat and each Air Quality Monitor) is a card showing its live reading. Tap a card to follow that sensor, or tap its **+** to average several.
- **Schedules that don't lock you out.** Each scheduled time sets temperature, mode, fan, *and which sensor to follow*. A manual change holds until the next scheduled time, then the schedule takes over again. **Resume schedule** ends a hold early.
- **Smart mode (automatic heat/cool changeover).** Set 69° with a ±1° range and the A/C comes on at 70°, the heat at 68°. Each runs until the room is back at 69°. The range and a minimum wait between heating and cooling are both adjustable.
- **Shared with your household, not the public.** It runs on a computer in your home, everyone signs in with a shared passcode and their first name, and the activity log shows who changed what. Changes appear on every phone instantly.

## How it works

```
 iPhone (home-screen web app) ──► Home Climate server (always-on computer at home) ──► Amazon Alexa cloud ──► thermostat
                                    • reads thermostat + air monitors every 60 s
                                    • runs schedules, holds, Smart mode
```

Amazon has no public thermostat API. This app uses the same private endpoints as the Alexa app, through [`alexa-remote2`](https://github.com/Apollon77/alexa-remote), the community library behind the ioBroker and Node-RED Alexa integrations:

| What | Endpoint |
|---|---|
| List devices and their capabilities | `POST /nexus/v1/graphql` |
| Read temperatures, mode, set point | `POST /api/phoenix/state` |
| Set mode / set point / fan | `PUT /api/phoenix/state` (`setThermostatMode`, `setTargetTemperature`, `setModeValue`) |

Everything Amazon-specific is in `server/drivers/alexa.js`.

**Following an air monitor instead of the thermostat.** The thermostat only senses temperature at its own location. When you choose an air monitor (or Smart mode), the server decides when the room needs heating or cooling, then moves the thermostat's set point just past the thermostat's own reading so it switches the equipment on or off. Those adjustments never go more than the **safety band** (default 5°) from your target. If the server goes down, the thermostat keeps running on its last set point, which is always within that band.

When you use only the thermostat's own sensor in plain Heat or Cool, the app just sends your target and the thermostat regulates itself.

## Setup (about 15 minutes)

You need a computer that's always on at home: a Raspberry Pi, a NAS that runs Docker, or an old laptop.

### 1. Run it

With Docker (recommended):

```sh
# edit HOUSEHOLD_PASSCODE, PROXY_HOST (this computer's LAN IP) and TZ first
docker compose up -d
```

Or with Node.js 20+:

```sh
npm install
HOUSEHOLD_PASSCODE=482913 PROXY_HOST=192.168.1.50 npm start
```

### 2. Link Amazon (once)

Open `http://<computer-ip>:8080` on your phone (on home Wi-Fi), sign in with the passcode, and tap **Sign in to Amazon**. That opens Amazon's real login page through a local proxy on port 3457. Two-step verification works. When the login finishes, the app connects and finds your thermostat and air monitors.

The login is saved in `data/amazon.json` and refreshes itself automatically. **Treat that file like a password.** It's git-ignored, so never commit it.

### 3. Add it to everyone's home screen

In Safari, tap **Share → Add to Home Screen**. It opens full-screen like a regular app.

### 4. Use it away from home (optional, but recommended)

Install [Tailscale](https://tailscale.com) (free for personal use) on the server and on each household phone, then open `http://<server-tailscale-name>:8080`. Nothing is exposed to the internet. Don't port-forward the app on your router.

## Try it without a thermostat

```sh
npm install
npm run demo          # simulated house, passcode "demo", http://localhost:8080
MOCK_SPEED=60 npm run demo   # 1 real second = 1 simulated minute
```

## Configuration

| Variable | Default | |
|---|---|---|
| `HOUSEHOLD_PASSCODE` | random, printed at startup | Shared household passcode |
| `PROXY_HOST` | `localhost` | LAN IP that phones use to reach the Amazon sign-in proxy |
| `PROXY_PORT` | `3457` | Port for the Amazon sign-in proxy |
| `AMAZON_PAGE` | `amazon.com` | e.g. `amazon.co.uk`, `amazon.ca` |
| `PORT` | `8080` | App port |
| `DATA_DIR` | `./data` | Where settings, schedule and the Amazon login are saved |
| `TZ` | system | Time zone that schedules run in |
| `DRIVER` | `alexa` | `mock` for the simulator |
| `DEBUG_ALEXA` | | Set to `1` to log Amazon traffic |

In-app settings: Smart-mode switch range and changeover wait, swing, safety band, °F/°C, sensor nicknames.

## Caveats

- **This uses an unofficial API.** Amazon can change it at any time. If something stops working, check for an `alexa-remote2` update first (`npm update alexa-remote2`).
- **Fan control** only appears if your thermostat exposes it to Alexa. If the Fan row is missing, open **Settings → Device inspector** and look for a fan capability on the thermostat. The driver detects fan controls by name, so a different name may need a small change in `useThermostat()`.
- **Polling.** Readings refresh every 60 s, immediately when you open the app, and about 5 s after each change to confirm it. Don't set the interval much lower, or Amazon may throttle the account.
- **Turn off the Alexa app's own schedule** for the thermostat so the two don't fight.
- **Heating/cooling status** in plain Heat/Cool on the thermostat's own sensor is inferred from the temperatures, since Alexa doesn't report whether the equipment is running.

## Development

```sh
npm test   # schedule + control logic
```

```
server/
  index.js          HTTP API, live updates (Server-Sent Events), static files
  engine.js         polling loop, holds, sending commands and confirming them
  controller.js     pure decision logic: sensor averaging, hysteresis, Smart mode
  schedule.js       weekly schedule math
  auth.js           household passcode + signed session cookies
  drivers/alexa.js  Amazon Alexa private API
  drivers/mock.js   simulated house
public/             the phone app (no build step)
```
