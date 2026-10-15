# Lights for iPhone

A native SwiftUI app for Home Lights:

- **Rooms and lights:** tap a bulb to switch it, tap the tile for brightness, colour and white. Room switches and "All on / All off".
- **+ Add lights:** search and pair with your hubs.
- **Schedules** (calendar button) and **Chiefs mode** (football button).
- **Home Screen widget** (small and medium): lights on, All on / All off, a button per room. Buttons work without opening the app.
- **Controls** for Control Center, the Lock Screen and the Action button: All Lights (a switch) and Chiefs Colors.
- **Siri and Shortcuts:** "Turn on Lights", "Turn off Lights", "Go Chiefs with Lights", "Touchdown with Lights". Turning one room on or off is in the Shortcuts app.

Requires iOS 18 and Xcode 16 or later.

## Install with a free Apple ID

1. **Get the code** on your Mac (Terminal):
   ```sh
   git clone -b claude/determined-lamport-lngf9w https://github.com/ugenethehobo/ugenethehobo.github.io.git home-lights
   cd home-lights/lights/ios
   ```
   Already cloned? `git pull` instead.
2. **Install XcodeGen** (you have it already if you installed the thermostat app): `brew install xcodegen`
3. **Pick a unique ID:** open `Config.xcconfig` and change `BUNDLE_PREFIX` to the same value you used for the thermostat, e.g. `com.yourname`.
4. **Create the project and open it:**
   ```sh
   xcodegen && open HomeLights.xcodeproj
   ```
5. **Set the team for both targets:** select the HomeLights project in the left sidebar, then for each target (**HomeLights** and **HomeLightsWidgets**) open **Signing & Capabilities** and choose your **Personal Team**.
6. Connect your iPhone, make sure the scheme says **HomeLights**, choose your iPhone as the run destination, and press **▶ Run**.
7. Open **Lights** and sign in with your server address (e.g. `home-lights.you.workers.dev`), your name and the household passcode. On a brand-new server, the passcode you type becomes the household passcode.

Then add the widget: long-press the Home Screen → Edit → Add Widget → Lights. For controls: Control Center → long-press → Add a Control.

**Free Apple ID limits:** apps stop opening after 7 days. Connect the phone and press Run again; your sign-in and widgets stay. A free Apple ID can have 3 sideloaded apps at once (the thermostat and Lights count as 2).

## If something goes wrong

- **Build errors:** copy the first red error from Xcode's Issue navigator (⌘5) and send it to me.
- **"That address isn't a Home Lights server":** you entered the thermostat's address. The lights server has its own (`home-lights.…`).
- **Widgets say "Open Lights to sign in"** even after signing in: the App Group isn't working. Send me the signing error from Xcode.
