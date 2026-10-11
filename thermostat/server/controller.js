// The decision logic, kept pure so it can be tested without a thermostat.
//
// The thermostat always gets your real target. It regulates on its own
// sensor, or on the sensors chosen for it in Alexa ("Selected temperature
// sensors"), so the app never adjusts set points to steer it. The only thing
// decided here is Smart mode's switch between Cool and Heat.

const MIN = 60 * 1000;

function fmt(n) {
  return (Math.round(n * 10) / 10).toString();
}

// The temperature the thermostat is regulating on, and where it comes from.
export function effectiveTemp(t) {
  if (t.sensing === 'EXTERNAL' && typeof t.externalTemp === 'number') return { temp: t.externalTemp, source: 'selected' };
  if (typeof t.temp === 'number') return { temp: t.temp, source: 'thermostat' };
  return { temp: null, source: null };
}

// Clamp to what the thermostat accepts in that mode, when it tells us.
function clampTarget(target, mode, allowed) {
  const r = mode === 'HEAT' ? allowed?.heat : mode === 'COOL' ? allowed?.cool : null;
  if (!r || r.some((x) => typeof x !== 'number')) return target;
  return Math.min(r[1], Math.max(r[0], target));
}

// Whether the equipment is running, from the thermostat's own report.
function runningAction(t) {
  const on = (v) => v && v !== 'OFF';
  if (on(t.cooler)) return 'cooling';
  if (on(t.heater)) return 'heating';
  if (t.cooler !== undefined || t.heater !== undefined) return 'idle';
  return null;
}

export function decide({ program, thermostat: t, runtime, settings, now }) {
  const rt = { context: null, contextSince: 0, ...runtime };
  const target = program.target;
  const threshold = settings.smart?.threshold ?? 1;
  const delayMs = (settings.smart?.changeoverDelayMin ?? 10) * MIN;
  const { temp: m } = effectiveTemp(t);
  const reported = runningAction(t);

  if (program.mode === 'off') {
    return { action: 'off', reason: 'System is off', want: { mode: 'OFF', setpoint: null }, runtime: rt };
  }

  let mode;
  let reason = '';
  if (program.mode === 'heat' || program.mode === 'cool') {
    mode = program.mode === 'heat' ? 'HEAT' : 'COOL';
    rt.context = program.mode;
  } else {
    // Smart: stay in the current direction until the temperature passes the
    // range on the other side, and wait out the changeover delay.
    const coolAt = target + threshold;
    const heatAt = target - threshold;
    let ctx = rt.context === 'cool' || rt.context === 'heat' ? rt.context : typeof m === 'number' && m > target ? 'cool' : 'heat';
    if (typeof m === 'number') {
      const flip = ctx === 'heat' && m >= coolAt ? 'cool' : ctx === 'cool' && m <= heatAt ? 'heat' : null;
      if (flip) {
        const wait = (rt.contextSince || 0) + delayMs - now;
        if (wait > 0) {
          reason = `Waiting ${Math.ceil(wait / MIN)} min before switching to ${flip === 'cool' ? 'cooling' : 'heating'}`;
        } else {
          ctx = flip;
          rt.contextSince = now;
          reason = flip === 'cool' ? `${fmt(m)}° reached ${fmt(coolAt)}°, switched to cooling` : `${fmt(m)}° fell to ${fmt(heatAt)}°, switched to heating`;
        }
      }
    }
    if (ctx !== rt.context && !rt.contextSince) rt.contextSince = now;
    rt.context = ctx;
    mode = ctx === 'cool' ? 'COOL' : 'HEAT';
    if (!reason) {
      reason = ctx === 'cool'
        ? `Cooling to ${fmt(target)}° as needed. Heat takes over at ${fmt(heatAt)}°`
        : `Heating to ${fmt(target)}° as needed. A/C takes over at ${fmt(coolAt)}°`;
    }
  }

  // Without a report from the thermostat, infer from the temperatures.
  let action = reported;
  const inferred = !reported;
  if (!action) {
    action = typeof m !== 'number' ? 'unknown' : mode === 'COOL' ? (m > target ? 'cooling' : 'idle') : m < target ? 'heating' : 'idle';
  }
  return { action, inferred, reason, want: { mode, setpoint: clampTarget(target, mode, t.allowed) }, runtime: rt };
}

// Which commands to send so the thermostat matches `want`.
export function commandsFor(want, thermostat, program, step = 1) {
  const cmds = {};
  if (want.mode && thermostat.mode !== want.mode) cmds.mode = want.mode;
  if (want.setpoint != null) {
    const sp = thermostat.setpoint;
    if (cmds.mode || typeof sp !== 'number' || Math.abs(sp - want.setpoint) >= step / 2) cmds.setpoint = want.setpoint;
  }
  if (program.fan && thermostat.fanSupported && thermostat.fan && thermostat.fan !== program.fan) {
    cmds.fan = program.fan;
  }
  return cmds;
}
