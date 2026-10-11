# Home Climate

A fast, private phone app for the Amazon Smart Thermostat, built to replace the Alexa app's thermostat screens. It runs free on Cloudflare, with no computer at home.

- **Fast and clear.** Big −/+ buttons with the target front and center. Every change shows its progress: *Sending… → Sent · waiting for thermostat → ✓ Thermostat confirmed*. If it fails you see why, with a **Retry** button. A status pill always shows whether the data is live and how old it is.
- **Pick your temperature sensor in one tap.** Each sensor (the thermostat and each Air Quality Monitor) is a card showing its live reading. Tap a card to follow that sensor, or tap its **+** to average several.
- **Schedules that don't lock you out.** Each scheduled time sets temperature, mode, fan, *and which sensor to follow*. A manual change holds until the next scheduled time, then the schedule takes over again. **Resume schedule** ends a hold early.
- **Smart mode (automatic heat/cool changeover).** Set 69° with a ±1° range and the A/C comes on at 70°, the heat at 68°. Each runs until the room is back at 69°. The range and a minimum wait between heating and cooling are adjustable.
- **Shared with your household.** Everyone signs in with a household passcode and their first name. Changes appear on every phone instantly, and the activity log shows who changed what.

## Set it up from your phone (about 10 minutes)

You need a free Cloudflare account and this GitHub repo.

1. **Create a Cloudflare account** at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). The free plan is enough.
2. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a repository**. Connect GitHub when asked, and allow Cloudflare to see the repository with this code.
3. Pick the repository, then set:
   - **Project / Worker name:** `home-climate` (must match `name` in `wrangler.jsonc`)
   - **Production branch:** the branch with this code
   - **Root directory** (sometimes under *Advanced*): `thermostat`
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy` (the default)

   Then tap **Deploy**. It takes a minute or two. Every later push to that branch redeploys automatically.
4. **Open your app** at the address Cloudflare shows, something like `https://home-climate.<your-name>.workers.dev`. Use Safari.
5. **Create the household passcode** (6+ characters). Do this right away, because the first visitor gets to set it.
6. **Link Amazon:** tap **Link Amazon account** → **Open Amazon sign-in** and sign in on Amazon's page. You'll end up on a page that may say *"Page not found"*. That's expected. Copy that page's full address (tap the address bar, then Copy), switch back to the app's tab, paste it, and tap **Link account**. Your thermostat and air monitors appear within a few seconds.
7. **Add to Home Screen:** Share → **Add to Home Screen**. Send the address and passcode to the people in your house.

Then turn off any thermostat schedule in the Alexa app, so the two don't fight.

## How it works

```
 phones ──► Cloudflare Worker ──► one Durable Object ("the house") ──► Amazon Alexa cloud ──► thermostat
             (the app's files)     • keeps settings, schedule, Amazon sign-in
                                   • wakes every 60 s: read sensors, run schedule / Smart mode, send commands
```

- **Cloudflare free plan:** a Worker serves the app, and a single [Durable Object](https://developers.cloudflare.com/durable-objects/) holds all state and wakes itself every minute with an alarm. One house uses a small fraction of the free daily limits.
- **Amazon:** there's no public thermostat API, so this uses the same private endpoints as the Alexa app. The sign-in follows the device-registration flow worked out by the community [`alexa-cookie2`](https://github.com/Apollon77/alexa-cookie) and [`alexa-remote2`](https://github.com/Apollon77/alexa-remote) projects. The only change is that you paste the final sign-in address instead of using a local proxy. Your Amazon password never passes through this app. It keeps only the device token Amazon issues, as the Alexa app does on a new phone.

| What | Endpoint |
|---|---|
| List devices and capabilities | `POST /nexus/v1/graphql` |
| Read temperatures, mode, set point | `POST /api/phoenix/state` |
| Set mode / set point / fan | `PUT /api/phoenix/state` (`setThermostatMode`, `setTargetTemperature`, `setModeValue`) |

**Following an air monitor instead of the thermostat.** The thermostat only senses temperature where it's mounted. When you choose an air monitor (or Smart mode), the app decides when the room needs heating or cooling. It then moves the thermostat's set point just past the thermostat's own reading, so the equipment switches on or off. Those adjustments never go more than the **safety band** (default 5°) from your target. If the service ever stops, the thermostat keeps running on its last set point, which is always within that band.

When you use only the thermostat's own sensor in plain Heat or Cool, the app just sends your target and the thermostat regulates itself.

**Time zone.** Cloudflare's clock is UTC, so schedules use the household time zone, which is taken from the first phone that opens the app (shown in Settings). Daylight-saving changes are handled.

## Caveats

- **Unofficial API.** Amazon can change it without notice. If something breaks, the fix is usually in `server/drivers/alexa.js`.
- **Cloud sign-in.** Amazon sees requests from Cloudflare's network rather than your home. Projects like this usually work fine that way, but Amazon could occasionally ask you to link again. The app tells you if so.
- **Fan control** only appears if your thermostat exposes it to Alexa. If the Fan row is missing, open **Settings → Device inspector** and look for a fan capability on the thermostat. The driver detects fan controls by name in `useThermostat()`.
- **Heating/cooling status** in plain Heat/Cool on the thermostat's own sensor is inferred from the temperatures, since Alexa doesn't report whether the equipment is running.
- **Public address, private access.** Anyone can load the sign-in page. Only people with the passcode get further. Wrong guesses are rate-limited (10 per device per 10 minutes, 50 per hour overall). **Settings → Change household passcode** signs everyone out.

## Other ways to run it

- **Your own computer:** `npm start` (Node 20+), or `docker compose up -d`. Data is saved in `./data`.
- **Try it with a simulated house:** `npm install && npm run dev` (Cloudflare runtime, locally) or `npm run demo` (Node). Then open the printed address.

## Development

```sh
npm test       # schedule, time zone, control logic, Amazon driver (against a fake Amazon)
npm run dev    # local Cloudflare runtime with the simulated house
```

```
worker/index.js     Cloudflare entry: Worker + the "House" Durable Object (storage, minute alarm)
server/
  app.js            HTTP API (standard Request/Response) + live updates (Server-Sent Events)
  engine.js         polling, holds, sending commands and confirming them
  controller.js     decision logic: sensor averaging, hysteresis, Smart mode
  schedule.js       weekly schedule math in the household time zone
  auth.js           household passcode + signed session cookies
  drivers/alexa.js  Amazon sign-in and the Alexa smart home API (fetch only)
  drivers/mock.js   simulated house
  index.js          Node entry (run on your own computer)
public/             the phone app (no build step)
```
