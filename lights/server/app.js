// The HTTP API for the iPhone app, written against the standard
// Request/Response objects.

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

async function readJson(request) {
  const text = await request.text();
  if (text.length > 100_000) throw Object.assign(new Error('Too large'), { status: 413 });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error('Bad JSON'), { status: 400 });
  }
}

export function createApi({ home, auth }) {
  async function route(request, ip) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;

    if (key === 'GET /api/hello') {
      return json(200, { app: 'home-lights', needsSetup: auth.needsSetup, me: auth.user(request)?.name || null });
    }
    if (key === 'POST /api/setup' || key === 'POST /api/login') {
      const body = await readJson(request);
      const { cookie, name, token } = key === 'POST /api/setup' ? auth.setup(body.passcode, body.name) : auth.login(body.passcode, body.name, ip);
      home.noteTimeZone(request.headers.get('x-time-zone'));
      // Native clients keep the token themselves; browsers only get the cookie.
      return json(200, body.client === 'native' ? { ok: true, name, token } : { ok: true, name }, { 'Set-Cookie': cookie });
    }
    if (key === 'POST /api/logout') {
      return json(200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
    }

    const user = auth.user(request);
    if (!user) return json(401, { error: auth.needsSetup ? 'Set up the household first' : 'Sign in first', needsSetup: auth.needsSetup });
    const by = user.name;
    home.noteTimeZone(request.headers.get('x-time-zone'));
    const done = (extra = {}) => json(200, { ...extra, state: home.snapshot() });

    switch (key) {
      case 'GET /api/state':
        return json(200, { me: by, state: home.snapshot() });

      // Lights and rooms
      case 'POST /api/lights':
        return done(home.control(await readJson(request), by));
      case 'PUT /api/light':
        home.updateLight(await readJson(request), by);
        return done();
      case 'POST /api/light/forget':
        home.forgetLight((await readJson(request)).id, by);
        return done();
      case 'POST /api/light/identify':
        home.identify((await readJson(request)).id);
        return done();
      case 'PUT /api/rooms':
        home.setRooms(await readJson(request), by);
        return done();

      // Finding and pairing lights
      case 'POST /api/scan':
        home.startScan(await readJson(request), by);
        return done();
      case 'POST /api/scan/stop':
        home.stopScan();
        return done();
      case 'POST /api/pair':
        home.pair(await readJson(request), by);
        return done();

      // Hubs
      case 'POST /api/hub/approve':
        home.approveHub((await readJson(request)).id, by);
        return done();
      case 'POST /api/hub/reject':
        home.rejectHub((await readJson(request)).id);
        return done();
      case 'PUT /api/hub':
        home.renameHub(await readJson(request), by);
        return done();
      case 'POST /api/hub/forget':
        home.forgetHub((await readJson(request)).id, by);
        return done();

      // Schedules
      case 'PUT /api/schedules':
        home.setSchedules((await readJson(request)).schedules, by);
        return done();
      case 'POST /api/schedule/run': {
        const id = (await readJson(request)).id;
        const entry = home.config.schedules.find((s) => s.id === id);
        if (!entry) throw Object.assign(new Error('Schedule not found'), { status: 404 });
        home.runSchedule(entry, by);
        home.save();
        return done();
      }

      // Chiefs mode
      case 'PUT /api/chiefs':
        home.setChiefs(await readJson(request), by);
        return done();
      case 'POST /api/chiefs/test':
        home.testEffect((await readJson(request)).kind, by);
        return done();
      case 'POST /api/chiefs/mode':
        if ((await readJson(request)).on) home.startGameMode(by, { manual: true });
        else home.endGameMode(by, `${by} turned game mode off`);
        return done();
      case 'POST /api/chiefs/refresh':
        await home.refreshGame();
        return done();

      // Household
      case 'PUT /api/settings':
        home.setSettings(await readJson(request), by);
        return done();
      case 'POST /api/passcode':
        auth.changePasscode((await readJson(request)).passcode);
        home.log(by, 'Changed the household passcode');
        home.save();
        return json(200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
      case 'POST /api/signout-everyone':
        auth.rotate();
        return json(200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
    }
    return json(404, { error: 'Not found' });
  }

  return async function handle(request, { ip = 'unknown' } = {}) {
    try {
      return await route(request, ip);
    } catch (err) {
      const body = { error: err.message || String(err) };
      if (auth.user(request)) body.state = home.snapshot();
      return json(err.status || 400, body);
    }
  };
}
