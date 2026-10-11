// Household sign-in: everyone shares one passcode and gives their first name,
// so the activity log can say who changed what. Sessions are signed cookies.
//
// The first person to open a fresh install chooses the passcode (unless
// HOUSEHOLD_PASSCODE is set), so do that right after deploying.
import crypto from 'node:crypto';

const COOKIE = 'hc_session';
const YEAR = 365 * 24 * 3600;
const MIN_PASSCODE = 6;

const err = (message, status) => Object.assign(new Error(message), { status });

export class Auth {
  // data: what save() last received. passcode: optional fixed passcode.
  constructor({ data = {}, save = () => {}, passcode = null, secure = false } = {}) {
    this.persist = save;
    this.secret = data.secret || crypto.randomBytes(32).toString('hex');
    this.fixed = passcode || null;
    this.passcode = this.fixed || data.passcode || null;
    this.secure = secure;
    this.attempts = new Map(); // ip -> [timestamps]
    this.failures = []; // all failed tries, to slow down attacks from many IPs
    if (!data.secret) this.#save();
  }

  get needsSetup() {
    return !this.passcode;
  }

  #save() {
    this.persist({ secret: this.secret, passcode: this.fixed ? undefined : this.passcode });
  }

  #sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  #session(name) {
    const n = String(name || '').trim().slice(0, 24) || 'Someone';
    const payload = Buffer.from(JSON.stringify({ n, i: Date.now() })).toString('base64url');
    const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}${this.secure ? '; Secure' : ''}`;
    return { cookie: `${COOKIE}=${payload}.${this.#sign(payload)}; ${flags}`, name: n };
  }

  setup(passcode, name) {
    if (!this.needsSetup) throw err('This household is already set up', 409);
    const p = String(passcode || '');
    if (p.length < MIN_PASSCODE) throw err(`Use at least ${MIN_PASSCODE} characters`, 400);
    this.passcode = p;
    this.#save();
    return this.#session(name);
  }

  login(passcode, name, ip) {
    if (this.needsSetup) throw err('Set a household passcode first', 409);
    const now = Date.now();
    const mine = (this.attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    this.failures = this.failures.filter((t) => now - t < 60 * 60 * 1000);
    if (mine.length >= 10) throw err('Too many tries. Wait a few minutes.', 429);
    if (this.failures.length >= 50) throw err('Too many wrong passcodes recently. Try again in an hour.', 429);
    const a = Buffer.from(String(passcode || ''));
    const b = Buffer.from(this.passcode);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      mine.push(now);
      this.attempts.set(ip, mine);
      this.failures.push(now);
      throw err('That passcode is not right', 401);
    }
    return this.#session(name);
  }

  user(req) {
    const raw = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
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
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secure ? '; Secure' : ''}`;
  }

  // Signs out every phone (e.g. after someone moves out).
  rotate() {
    this.secret = crypto.randomBytes(32).toString('hex');
    this.#save();
  }

  changePasscode(passcode) {
    if (this.fixed) throw err('The passcode is set by the server configuration', 409);
    const p = String(passcode || '');
    if (p.length < MIN_PASSCODE) throw err(`Use at least ${MIN_PASSCODE} characters`, 400);
    this.passcode = p;
    this.secret = crypto.randomBytes(32).toString('hex');
    this.#save();
  }
}
