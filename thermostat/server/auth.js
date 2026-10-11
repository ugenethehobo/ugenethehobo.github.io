// Household sign-in: everyone shares one passcode and gives their first name,
// so the activity log can say who changed what. Sessions are signed cookies.
import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';

const COOKIE = 'hc_session';
const YEAR = 365 * 24 * 3600;

export class Auth {
  constructor() {
    const saved = readJson('household.json', {});
    this.secret = saved.secret || crypto.randomBytes(32).toString('hex');
    this.passcode = process.env.HOUSEHOLD_PASSCODE || saved.passcode || String(crypto.randomInt(100000, 999999));
    this.generated = !process.env.HOUSEHOLD_PASSCODE && !saved.passcode;
    this.attempts = new Map();
    this.#save();
  }

  #save() {
    writeJson('household.json', { secret: this.secret, passcode: process.env.HOUSEHOLD_PASSCODE ? undefined : this.passcode });
  }

  #sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  login(passcode, name, ip) {
    const now = Date.now();
    const a = (this.attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (a.length >= 10) throw Object.assign(new Error('Too many tries. Wait a few minutes.'), { status: 429 });
    a.push(now);
    this.attempts.set(ip, a);
    const ok =
      typeof passcode === 'string' &&
      passcode.length === this.passcode.length &&
      crypto.timingSafeEqual(Buffer.from(passcode), Buffer.from(this.passcode));
    if (!ok) throw Object.assign(new Error('That passcode is not right'), { status: 401 });
    const n = String(name || '').trim().slice(0, 24) || 'Someone';
    const payload = Buffer.from(JSON.stringify({ n, i: now })).toString('base64url');
    return { cookie: `${COOKIE}=${payload}.${this.#sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}`, name: n };
  }

  user(req) {
    const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    if (!raw) return null;
    const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
    if (!payload || !sig) return null;
    const expected = this.#sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      return { name: JSON.parse(Buffer.from(payload, 'base64url').toString()).n };
    } catch {
      return null;
    }
  }

  logoutCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  // Signs out every phone (e.g. after someone moves out).
  rotate() {
    this.secret = crypto.randomBytes(32).toString('hex');
    this.#save();
  }
}
