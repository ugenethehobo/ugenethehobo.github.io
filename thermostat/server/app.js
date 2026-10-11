// The HTTP API, written against the standard Request/Response objects so the
// same code runs on Cloudflare Workers and on Node.

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

export function createApi({ engine, auth, driver }) {
  // Live updates over Server-Sent Events, so every phone in the house sees a
  // change the moment anyone makes it.
  const clients = new Set();
  const enc = new TextEncoder();
  let pushTimer = null;
  let pingTimer = null;

  const broadcast = (chunk) => {
    for (const w of clients) {
      w.write(enc.encode(chunk)).catch(() => clients.delete(w));
    }
  };

  engine.on('update', () => {
    if (pushTimer || !clients.size) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      broadcast(`event: state\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
    }, 50);
  });

  function openStream(request) {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    clients.add(w);
    w.write(enc.encode(`retry: 3000\nevent: state\ndata: ${JSON.stringify(engine.snapshot())}\n\n`)).catch(() => {});
    pingTimer ||= setInterval(() => {
      if (!clients.size) {
        clearInterval(pingTimer);
        pingTimer = null;
        return;
      }
      broadcast(': ping\n\n');
    }, 25000);
    request.signal?.addEventListener('abort', () => {
      clients.delete(w);
      w.close().catch(() => {});
    });
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  async function route(request, ip) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;

    if (key === 'GET /api/hello') {
      return json(200, { needsSetup: auth.needsSetup, me: auth.user(request)?.name || null });
    }
    if (key === 'POST /api/setup') {
      const body = await readJson(request);
      const { cookie, name } = auth.setup(body.passcode, body.name);
      return json(200, { ok: true, name }, { 'Set-Cookie': cookie });
    }
    if (key === 'POST /api/login') {
      const body = await readJson(request);
      const { cookie, name } = auth.login(body.passcode, body.name, ip);
      return json(200, { ok: true, name }, { 'Set-Cookie': cookie });
    }
    if (key === 'POST /api/logout') {
      return json(200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
    }

    const user = auth.user(request);
    if (!user) return json(401, { error: auth.needsSetup ? 'Set up the household first' : 'Sign in first', needsSetup: auth.needsSetup });
    const by = user.name;
    const reply = async (p) => json(200, { results: await p, state: engine.snapshot() });

    switch (key) {
      case 'GET /api/state':
        return json(200, { me: by, state: engine.snapshot() });
      case 'GET /api/events':
        return openStream(request);
      case 'POST /api/control':
        return reply(engine.control(await readJson(request), by));
      case 'POST /api/resume':
        return reply(engine.resume(by));
      case 'PUT /api/schedule':
        return reply(engine.setSchedule(await readJson(request), by));
      case 'PUT /api/settings':
        return reply(engine.setSettings(await readJson(request), by));
      case 'POST /api/refresh':
        await engine.refresh();
        return json(200, { state: engine.snapshot() });
      case 'POST /api/rediscover':
        await engine.discover();
        await engine.refresh();
        return json(200, { state: engine.snapshot() });
      case 'POST /api/amazon/start':
        if (!driver.startLogin) throw Object.assign(new Error('Not available in demo mode'), { status: 400 });
        return json(200, { url: await driver.startLogin() });
      case 'POST /api/amazon/finish': {
        const body = await readJson(request);
        await driver.completeLogin(body.url);
        engine.logEvent(by, 'Linked the Amazon account');
        return json(200, { state: engine.snapshot() });
      }
      case 'POST /api/amazon/unlink':
        await driver.unlink?.();
        engine.logEvent(by, 'Unlinked the Amazon account');
        return json(200, { state: engine.snapshot() });
      case 'POST /api/passcode':
        auth.changePasscode((await readJson(request)).passcode);
        engine.logEvent(by, 'Changed the household passcode');
        return json(200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
      case 'POST /api/signout-everyone':
        auth.rotate();
        return json(200, { ok: true }, { 'Set-Cookie': auth.logoutCookie() });
      case 'POST /api/debug/probe':
        if (!driver.probe) throw Object.assign(new Error('Not available in demo mode'), { status: 400 });
        return json(200, { probe: await driver.probe() });
      case 'GET /api/debug/devices':
        return new Response(JSON.stringify(await driver.raw(), null, 2), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }
    return json(404, { error: 'Not found' });
  }

  return async function handle(request, { ip = 'unknown' } = {}) {
    try {
      return await route(request, ip);
    } catch (err) {
      const body = { error: err.message || String(err) };
      if (auth.user(request)) body.state = engine.snapshot();
      return json(err.status || 400, body);
    }
  };
}
