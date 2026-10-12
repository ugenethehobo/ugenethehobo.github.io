# Climate for iPhone

A native SwiftUI app for Home Climate, with widgets:

- **Home Screen widget** (small and medium): inside temperature, target with −/+ buttons, status. The medium size also has mode buttons. The buttons work without opening the app.
- **Lock Screen widgets** (circle, rectangle, inline): inside temperature and target.
- **Controls** for Control Center, the Lock Screen and the Action button: Warmer, Cooler, Thermostat Mode (you pick the mode) and Use Sensor (you pick the sensor).
- **Siri and Shortcuts:** "Make it warmer with Climate", "Set Climate to Cool", "Use Bedroom with Climate", "Resume the Climate schedule". "Set Temperature" is available in the Shortcuts app.

It talks to the same Cloudflare server as the web app. The schedule (including which sensors each time uses) is in the app via the calendar button; other settings open in the web app.

Requires iOS 18 and Xcode 16 or later.

## Install with a free Apple ID

1. **Get the code** on your Mac (Terminal):
   ```sh
   git clone -b thermostat-app https://github.com/ugenethehobo/ugenethehobo.github.io.git
   cd ugenethehobo.github.io/thermostat/ios
   ```
   Already cloned? `git pull` instead.
2. **Install XcodeGen**, which turns `project.yml` into an Xcode project. This needs [Homebrew](https://brew.sh):
   ```sh
   brew install xcodegen
   ```
3. **Pick a unique ID:** open `Config.xcconfig` and change `BUNDLE_PREFIX` to something only you would use, e.g. `com.yourname`.
4. **Create the project and open it:**
   ```sh
   xcodegen && open HomeClimate.xcodeproj
   ```
5. **Sign in to Xcode** with your Apple ID: Xcode → Settings → Accounts → +.
6. **Set the team for both targets:** select the HomeClimate project in the left sidebar, then for each target (**HomeClimate** and **HomeClimateWidgets**) open **Signing & Capabilities** and choose your **Personal Team**. Leave "Automatically manage signing" on.
7. **Prepare the iPhone:** connect it with a cable and tap **Trust**. Turn on **Settings → Privacy & Security → Developer Mode** (the phone restarts).
8. In Xcode's toolbar, make sure the scheme says **HomeClimate** (not HomeClimateWidgets), choose your iPhone as the run destination, and press **▶ Run**.
9. The first time, iOS blocks the app. Go to **Settings → General → VPN & Device Management**, tap your Apple ID under Developer App, and choose **Trust**. Then open Climate.
10. **Sign in** with your server address (e.g. `home-climate.you.workers.dev`), your name and the household passcode.

Then add widgets: long-press the Home Screen or Lock Screen → Edit → Add Widget → Climate. For controls: Control Center → long-press → Add a Control, or Settings → Action Button.

**Every 7 days**, a free Apple ID's apps stop opening ("no longer available"). Connect the phone and press Run in Xcode again. Your sign-in and widgets stay.

## If something goes wrong

- **"Please specify the widget kind… _XCWidgetKind":** the HomeClimateWidgets scheme is selected. Switch the scheme (left of the device name in the toolbar) to **HomeClimate** and Run again.
- **Build errors:** copy the first red error from Xcode's Issue navigator (⌘5) and send it to me.
- **"Personal development teams do not support the App Groups capability"** (or a similar signing error): send it to me. The app and widgets share the sign-in through an App Group, and I'd switch to a different method.
- **Widgets say "Open Climate to sign in"** even after signing in: the App Group isn't working. Same as above.
- **Widgets show old numbers:** iOS refreshes widgets on its own schedule, roughly every 15–30 minutes. Using a widget button, or opening the app, refreshes them right away.
