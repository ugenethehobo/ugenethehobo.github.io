// Cloudflare Workers entry. Static files in public/ are served by Workers
// Static Assets; /api/* goes to a single Durable Object ("the house") that
// keeps all state and wakes itself up every minute with an alarm to run the
// schedule, Smart mode and air-monitor control.
import { DurableObject } from 'cloudflare:workers';
import { createApi } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { AlexaDriver } from '../server/drivers/alexa.js';
import { MockDriver } from '../server/drivers/mock.js';
import { Engine } from '../server/engine.js';
import { newStore } from '../server/store.js';

export class House extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() => this.#boot());
  }

  async #boot() {
    const { ctx, env } = this;
    const kv = ctx.storage;
    const [store, live, amazon, household] = await Promise.all(
      ['store', 'live', 'amazon', 'household'].map((k) => kv.get(k)),
    );
    const driver =
      env.DRIVER === 'mock'
        ? new MockDriver()
        : new AlexaDriver({
            saved: amazon,
            save: (d) => kv.put('amazon', d),
            amazonPage: env.AMAZON_PAGE || 'amazon.com',
          });
    const engine = new Engine(driver, newStore(store), {
      save: (s, l) => {
        kv.put('store', s);
        kv.put('live', JSON.parse(JSON.stringify(l)));
      },
      schedule: (ms) => this.#wakeIn(ms),
    });
    engine.restoreLive(live);
    const auth = new Auth({
      data: household || {},
      save: (d) => kv.put('household', d),
      passcode: env.HOUSEHOLD_PASSCODE || null,
      secure: true,
    });
    this.engine = engine;
    this.api = createApi({ engine, auth, driver });
    await engine.start({ pollNow: false });
    // Make sure the minute-by-minute loop is running.
    if ((await kv.getAlarm()) == null) await kv.setAlarm(Date.now() + 1000);
  }

  // One alarm at a time: keep whichever wake-up is sooner. While the alarm
  // handler runs, the platform still reports the running alarm, so collect
  // requests and set the next alarm when the handler finishes.
  async #wakeIn(ms) {
    const at = Date.now() + Math.max(ms, 500);
    if (this.inAlarm) {
      this.wantAt = Math.min(this.wantAt ?? Infinity, at);
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    await this.ready;
    this.inAlarm = true;
    this.wantAt = null;
    try {
      await this.engine.poll(); // asks for its next wake-up via #wakeIn
    } finally {
      this.inAlarm = false;
      await this.ctx.storage.setAlarm(this.wantAt ?? Date.now() + 60_000);
    }
  }

  async fetch(request) {
    await this.ready;
    return this.api(request, { ip: request.headers.get('CF-Connecting-IP') || 'unknown' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const house = env.HOUSE.get(env.HOUSE.idFromName('house'));
      return house.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
