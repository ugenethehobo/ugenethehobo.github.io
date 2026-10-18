# Home Lights

Control your Philips Hue **Bluetooth** lights from your iPhone, from anywhere, without the Hue Bridge and without your PC being on. Runs free on Cloudflare, like Home Climate (the thermostat app).

- **Rooms and lights.** Tap to switch on and off, set brightness, pick any colour or shade of white. "All on / All off" and per-room switches.
- **Easy pairing.** Tap **+**, **Search**, then **Pair** next to a light, and give it a name and room.
- **Schedules.** At a time or at sunrise/sunset (± minutes), on chosen days, for all lights, some rooms or some lights. Turn on (brightness, colour or white) or off, with an optional slow fade (wake-up light, bedtime dim).
- **Chiefs mode.** On game day the game lights turn Chiefs red before kickoff. During the game they react to each play as ESPN reports it: touchdown, field goal, takeaway, sack, flag, kickoff, opponent scores, then a win (or loss) show. After the game they go back to how they were. You choose which lights, which plays get a show, and how far your TV runs behind live, so the lights don't spoil the play.
- **iPhone extras.** A Home Screen widget (all on/off, rooms), Control Center toggles, and Siri: "Turn off Lights", "Go Chiefs with Lights", "Touchdown with Lights".
- **Shared with the household.** Same passcode-and-first-name sign-in as the thermostat. The activity log shows who changed what.

## Why there's a small box at home

Hue Bluetooth lights only talk Bluetooth, which reaches about 10 m. Cloudflare can't speak Bluetooth, and your phone can't control them while you're away. So something at home has to stand in for the dead bridge. Today that's your PC. This replaces it with an **ESP32 board** (about $8, uses about 1 W from any USB charger):

```
 iPhone app ──► Cloudflare (free) ──► ESP32 hub at home ──Bluetooth──► Hue lights
               • settings, schedules    • keeps the lights connected
               • watches the Chiefs game • plays light shows with exact timing
```

The hub keeps a connection open to Cloudflare. Commands reach the lights in well under a second, and the hub plays game-day shows itself, so a slow network can't make them stutter.

**What to buy:** any "ESP32 DevKit" / "ESP32-WROOM-32" board with a USB port (ESP32-S3 and ESP32-C3 boards work too), plus a USB cable that carries data. Put it within about 10 m of your lights. Lights spread across the house? Add a second hub (each one shows up for approval) and pair each light with the hub nearest to it.

One hub keeps up to 8 lights connected at once, for instant response. More lights still work: the hub swaps connections, which adds a second or two when a light hasn't been used for a while.

## Set it up (about 30 minutes)

### 1. Put the server on Cloudflare

Same steps as the thermostat, with a different name and folder:

1. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, pick this repository.
2. Set:
   - **Project / Worker name:** `home-lights` (must match `name` in `wrangler.jsonc`)
   - **Production branch:** the branch with this code
   - **Root directory:** `lights`
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy` (the default)
3. **Deploy.** Your server is at an address like `https://home-lights.<your-name>.workers.dev`.

### 2. Install the iPhone app

Follow [ios/README.md](ios/README.md) (Xcode on a Mac, free Apple ID). Sign in with the server address, your first name and a passcode. On a brand-new server, **the first sign-in sets the household passcode**, so do this right after deploying.

### 3. Install the hub software

On a computer, open your server address in **Chrome or Edge**, plug in the ESP32 with a USB cable, and click **Install hub software**. Choose to erase the device on the first install. Nothing else to install: the page flashes a ready-made build (built automatically by GitHub Actions from `firmware/`).

### 4. Connect the hub to your Wi-Fi

Plug the hub into a USB charger near your lights. On your iPhone, join the Wi-Fi network **Hue-Hub-xxxx**. In the page that opens, tap **Configure WiFi**, pick your home Wi-Fi (2.4 GHz), type its password, and enter your server address. The page also shows the **Hub ID**.

Then in the app, a banner says the hub wants to join. Check the Hub ID and tap **Approve**.

The hub's blue light: slow blink = connecting, double blink = waiting for approval, steady = ready. To start setup over (new Wi-Fi), hold the **BOOT** button for 5 seconds.

### 5. Move your lights over from the PC

1. **Turn off Bluetooth on your PC** (Settings → Bluetooth & devices), not just the app. Windows stays connected to lights it's paired with, and a light that's connected to something else doesn't show up for the hub at all.
2. **Put each light in pairing mode.** A Hue light that's already paired with a device only accepts a new one after it's made discoverable. In the Philips Hue phone app (Bluetooth mode, no bridge needed): **Settings → Voice assistants → Amazon Alexa (or Google Home) → Make discoverable**, then close the Hue app so it lets go of the light. A factory-reset light is in pairing mode on its own (resetting gives it a new Bluetooth address).
3. In the Lights app tap **+ → Search for lights**, then **Pair**, and give it a name and room.

A light missing from the list (Play bars, for example, may not say they're Hue lights in every advertisement): turn on **Show all Bluetooth devices** and search again. The **What the hub is doing** list on the same screen shows each pairing step and the exact error.

### 6. Turn on Chiefs mode

Chiefs mode is on by default. Open the 🏈 screen:

- **Game lights:** all lights, or pick some.
- **My TV is behind by:** streaming TV runs 20–60 seconds behind the stadium, cable about 5–10. If the lights flash before you see the play, tap **Lights too early: +5 s** until they line up. The app shows how quickly ESPN posted the last play.
- **Light shows:** switch off any you don't want, and tap ▶︎ to preview one.

## How the free plan is kept free

Everything runs on Cloudflare's free Workers plan in one Durable Object. Nothing runs on a timer when nothing is happening:

| What | Cost on the free plan |
|---|---|
| Hub connection | Held open with the WebSocket Hibernation API: idle time and keep-alive pings are free. Each message from the hub counts as 1/20 of a request. |
| Schedules | The server sleeps until the next scheduled time: one wake-up per run. |
| Finding the next Chiefs game | One look at ESPN's scoreboard every 6 hours. |
| Game day | One look at the play-by-play every 8 s (every 60 s until just before kickoff), from 10 minutes before kickoff to the final whistle. About 1,800 wake-ups and 4,000 storage writes per game. |
| The iPhone app | Refreshes every 3 s while it's open on screen (1.5 s while searching for lights or during a game), nothing in the background. |

A busy day (a game, a few schedules, the app open for an hour) uses roughly 5–10% of the free daily limits (100,000 requests, 100,000 storage writes). That leaves plenty for the thermostat on the same account. If a limit were ever hit, Cloudflare refuses further requests until midnight UTC; it never bills you on the free plan.

## Caveats

- **Game feeds.** Each check reads two separate ESPN feeds at once (the play-by-play and the scoreboard) and whichever shows a play or score first sets off the lights; duplicates are ignored, and the game keeps going if one feed fails. The app's 🏈 screen shows each feed's health. Both are ESPN's public feeds (no key), so an ESPN-wide outage still stops them; another provider with an official API can be added as a third feed (`gameSources` in `server/home.js`). The parsing is in `server/game.js`, tested against a recorded Chiefs game.
- **Plays show up when ESPN posts them**, usually 5–30 seconds after they happen. The TV delay setting covers the rest. Flags that are picked up or offset may still flash.
- **Hub security.** The hub's connection to Cloudflare is encrypted, but the hub doesn't check the server's certificate (it can't keep a list of certificate authorities up to date). Someone on your own Wi-Fi could pretend to be the server; nobody outside your home can.
- **One hub, one board.** If a hub dies, flash a new board, approve it, and pair the lights again.

## Development

```sh
npm install
npm test                        # game parsing (recorded Chiefs game), schedules, game day, pairing
npm run dev                     # local server at http://localhost:8787
node tools/fake-hub.js          # a pretend hub with pretend lights, for trying the app
```

```
worker/index.js        Cloudflare entry: Worker + the "Home" Durable Object (storage, alarm, hub WebSockets)
server/
  home.js              lights, rooms, hubs, pairing, schedules, Chiefs mode
  game.js              ESPN scoreboard and play-by-play → game events
  effects.js           the light shows for each event
  schedule.js          weekly schedules, sunrise/sunset, in the household time zone
  app.js               HTTP API for the iPhone app
  auth.js              household passcode + signed sessions (same as the thermostat)
firmware/hue-hub/      ESP32 hub (Arduino): Wi-Fi setup page, WebSocket to the server, Bluetooth to the lights
ios/                   the iPhone app (SwiftUI, widgets, Siri)
public/                the server's web page and hub installer
```

The hub talks to the lights with the Hue Bluetooth GATT service `932c32bd-0000-47a2-835a-a8d455b859dd` (power, brightness, colour temperature, XY colour, and the combined control characteristic), as documented by the open-source [HueBLE](https://github.com/flip-dots/HueBLE) project.
