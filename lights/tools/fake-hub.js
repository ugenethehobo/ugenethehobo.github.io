// A pretend hub with three pretend lights, for trying the app without the
// ESP32: `node tools/fake-hub.js http://localhost:8787` (after `npm run dev`).
// Approve it in the app the first time; it remembers its token in memory only.

const server = (process.argv[2] || 'http://localhost:8787').replace(/^http/, 'ws').replace(/\/$/, '');
const id = process.argv[3] || 'fake-hub-1';
let token = process.env.HUB_TOKEN || '';

const lights = new Map(
  [
    ['aa:bb:cc:dd:ee:01', 'Hue color lamp 1'],
    ['aa:bb:cc:dd:ee:02', 'Hue color lamp 2'],
  ].map(([lid, name]) => [lid, { id: lid, name, model: 'LCA001', caps: { xy: true, ct: true }, connected: true, on: false, bri: 254, ct: 366, mode: 'ct' }]),
);
const nearby = { id: 'aa:bb:cc:dd:ee:03', name: 'Hue go', rssi: -58, addrType: 0 };

function connect() {
  const ws = new WebSocket(`${server}/api/hub?id=${id}&fw=fake-1.0${token ? `&token=${token}` : ''}`);
  const send = (m) => ws.send(JSON.stringify(m));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    console.log('←', JSON.stringify(m).slice(0, 160));
    if (m.t === 'pending') console.log('Waiting for approval in the app…');
    if (m.t === 'welcome') {
      // Approved: reconnect with the token, like the real hub does.
      token = m.token;
      ws.onclose = null;
      ws.close();
      setTimeout(connect, 300);
    }
    if (m.t === 'ready') send({ t: 'hello', fw: 'fake-1.0', lights: [...lights.values()] });
    if (m.t === 'set') {
      for (const lid of m.ids) {
        const l = lights.get(lid);
        if (!l) continue;
        Object.assign(l, m.s, m.s.xy ? { mode: 'xy' } : m.s.ct ? { mode: 'ct' } : {});
        send({ t: 'light', id: lid, connected: true, on: l.on, bri: l.bri, xy: l.xy, ct: l.ct, mode: l.mode });
      }
    }
    if (m.t === 'scan' && m.sec > 0) setTimeout(() => send({ t: 'found', ...nearby }), 500);
    if (m.t === 'pair') {
      setTimeout(() => {
        lights.set(m.id, { ...nearby, model: 'LLC020', caps: { xy: true, ct: true }, connected: true, on: true, bri: 254, ct: 300, mode: 'ct' });
        send({ t: 'paired', ok: true, ...lights.get(m.id) });
      }, 800);
    }
    if (m.t === 'forget') lights.delete(m.id);
  };
  ws.onclose = (e) => {
    console.log('closed', e.code, e.reason, '— reconnecting');
    setTimeout(connect, e.code === 4001 ? 200 : 2000);
  };
  ws.onerror = () => {};
}
connect();
