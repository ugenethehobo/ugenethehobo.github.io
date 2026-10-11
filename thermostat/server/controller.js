// The decision logic, kept pure so it can be tested without a thermostat.
//
// Two ways of running the thermostat:
//  - direct: the program uses only the thermostat's own sensor and plain Heat
//    or Cool. We just hand the thermostat its mode and set point and let it
//    regulate itself. Fewest commands, nothing depends on this server.
//  - driven: the program uses other sensors (air quality monitors) or Smart
//    mode. This server decides when to heat or cool from the chosen sensors and
//    nudges the thermostat's set point above or below its own reading so it
//    turns the equipment on or off. Nudges are capped at `maxOffset` from the
//    target, so if this server stops, the house stays within that band.

const MIN = 60 * 1000;

export function measure(program, readings, thermostatId, settings, now) {
  const staleMs = (settings.staleMinutes ?? 20) * MIN;
  const wanted = program.sensors?.length ? program.sensors : [thermostatId];
  const used = [];
  const stale = [];
  let sum = 0;
  for (const id of wanted) {
    const r = readings[id];
    if (r && typeof r.temp === 'number' && r.reachable !== false && now - r.at <= staleMs) {
      used.push(id);
      sum += r.temp;
    } else {
      stale.push(id);
    }
  }
  if (used.length) return { temp: sum / used.length, used, stale, fallback: false };
  const t = readings[thermostatId];
  if (t && typeof t.temp === 'number') {
    return { temp: t.temp, used: [thermostatId], stale, fallback: true };
  }
  return { temp: null, used: [], stale, fallback: true };
}

function fmt(n) {
  return (Math.round(n * 10) / 10).toString();
}

export function decide({ program, measured, thermostat, runtime, settings, now }) {
  const rt = { action: 'idle', since: now, lastHeatEnd: 0, lastCoolEnd: 0, context: null, ...runtime };
  const target = program.target;
  const swing = settings.swing ?? 0.5;
  const maxOffset = settings.maxOffset ?? 5;
  const threshold = settings.smart?.threshold ?? 1;
  const delayMs = (settings.smart?.changeoverDelayMin ?? 10) * MIN;
  const m = measured.temp;
  const t0 = thermostat.temp;

  const setAction = (action) => {
    if (action === rt.action) return;
    if (rt.action === 'heating' && !rt.inferred) rt.lastHeatEnd = now;
    if (rt.action === 'cooling' && !rt.inferred) rt.lastCoolEnd = now;
    rt.inferred = false;
    rt.action = action;
    rt.since = now;
    if (action === 'heating') rt.context = 'heat';
    if (action === 'cooling') rt.context = 'cool';
  };

  if (program.mode === 'off') {
    setAction('idle');
    return { action: 'off', driven: false, reason: 'System is off', want: { mode: 'OFF', setpoint: null }, runtime: rt };
  }

  const onlyThermostat =
    measured.used.length === 1 && measured.used[0] === thermostat.id && !measured.stale.length;
  const direct = onlyThermostat && (program.mode === 'heat' || program.mode === 'cool');

  if (direct) {
    const mode = program.mode === 'heat' ? 'HEAT' : 'COOL';
    // The thermostat regulates itself; we can only infer what it's doing.
    let action = 'idle';
    if (typeof t0 === 'number') {
      if (mode === 'HEAT' && t0 < target) action = 'heating';
      if (mode === 'COOL' && t0 > target) action = 'cooling';
    }
    // Inferred, so it doesn't start Smart mode's changeover clock.
    if (action !== rt.action) Object.assign(rt, { action, since: now });
    rt.inferred = true;
    rt.context = program.mode;
    return {
      action,
      inferred: true,
      driven: false,
      reason: `Thermostat is regulating to ${fmt(target)}° on its own sensor`,
      want: { mode, setpoint: target },
      runtime: rt,
    };
  }

  if (typeof m !== 'number') {
    // No readings at all: fall back to letting the thermostat hold the target.
    const mode = program.mode === 'cool' ? 'COOL' : 'HEAT';
    setAction('idle');
    return {
      action: 'unknown',
      driven: false,
      reason: 'No temperature readings yet. The thermostat is holding the target on its own.',
      want: { mode, setpoint: target },
      runtime: rt,
    };
  }

  let reason = '';
  if (program.mode === 'heat') {
    if (rt.action === 'cooling') setAction('idle');
    if (rt.action !== 'heating' && m <= target - swing) {
      setAction('heating');
      reason = `${fmt(m)}° is below ${fmt(target - swing)}°, heating to ${fmt(target + swing)}°`;
    } else if (rt.action === 'heating' && m >= target + swing) {
      setAction('idle');
      reason = `Reached ${fmt(m)}°, heat off until ${fmt(target - swing)}°`;
    } else {
      reason = rt.action === 'heating'
        ? `Heating to ${fmt(target + swing)}°`
        : `Heat starts at ${fmt(target - swing)}°`;
    }
    rt.context = 'heat';
  } else if (program.mode === 'cool') {
    if (rt.action === 'heating') setAction('idle');
    if (rt.action !== 'cooling' && m >= target + swing) {
      setAction('cooling');
      reason = `${fmt(m)}° is above ${fmt(target + swing)}°, cooling to ${fmt(target - swing)}°`;
    } else if (rt.action === 'cooling' && m <= target - swing) {
      setAction('idle');
      reason = `Reached ${fmt(m)}°, A/C off until ${fmt(target + swing)}°`;
    } else {
      reason = rt.action === 'cooling'
        ? `Cooling to ${fmt(target - swing)}°`
        : `A/C starts at ${fmt(target + swing)}°`;
    }
    rt.context = 'cool';
  } else if (program.mode === 'smart') {
    const coolAt = target + threshold;
    const heatAt = target - threshold;
    if (rt.action === 'heating' && m >= target) {
      setAction('idle');
      reason = `Reached ${fmt(target)}°, heat off`;
    } else if (rt.action === 'cooling' && m <= target) {
      setAction('idle');
      reason = `Reached ${fmt(target)}°, A/C off`;
    }
    if (rt.action === 'idle') {
      const wantCool = m >= coolAt;
      const wantHeat = m <= heatAt;
      if (wantCool || wantHeat) {
        const lastOther = wantCool ? rt.lastHeatEnd : rt.lastCoolEnd;
        const wait = lastOther ? lastOther + delayMs - now : 0;
        if (wait > 0) {
          reason = `Waiting ${Math.ceil(wait / MIN)} min before switching to ${wantCool ? 'cooling' : 'heating'}`;
        } else {
          setAction(wantCool ? 'cooling' : 'heating');
          reason = wantCool
            ? `${fmt(m)}° reached ${fmt(coolAt)}°, cooling to ${fmt(target)}°`
            : `${fmt(m)}° fell to ${fmt(heatAt)}°, heating to ${fmt(target)}°`;
        }
      } else if (!reason) {
        reason = `Comfortable. A/C at ${fmt(coolAt)}°, heat at ${fmt(heatAt)}°`;
      }
    } else if (!reason) {
      reason = rt.action === 'heating' ? `Heating to ${fmt(target)}°` : `Cooling to ${fmt(target)}°`;
    }
    if (!rt.context) rt.context = m > target ? 'cool' : 'heat';
  }

  return {
    action: rt.action,
    driven: true,
    reason,
    want: drivenWant(rt, target, t0, maxOffset),
    runtime: rt,
  };
}

function drivenWant(rt, target, t0, maxOffset) {
  const hi = target + maxOffset;
  const lo = target - maxOffset;
  const known = typeof t0 === 'number';
  const heatContext = rt.action === 'heating' || (rt.action === 'idle' && rt.context === 'heat');
  const mode = heatContext ? 'HEAT' : 'COOL';
  let setpoint;
  let call; // whether the thermostat should be running the equipment
  if (rt.action === 'heating') {
    setpoint = known ? Math.min(hi, Math.max(target, Math.ceil(t0) + 2)) : hi;
    call = true;
  } else if (rt.action === 'cooling') {
    setpoint = known ? Math.max(lo, Math.min(target, Math.floor(t0) - 2)) : lo;
    call = true;
  } else if (heatContext) {
    setpoint = known ? Math.max(lo, Math.min(target, Math.floor(t0) - 2)) : lo;
    call = false;
  } else {
    setpoint = known ? Math.min(hi, Math.max(target, Math.ceil(t0) + 2)) : hi;
    call = false;
  }
  return { mode, setpoint, call, bounds: [lo, hi] };
}

// Which commands to send so the thermostat matches `want`. Avoids resending
// when the thermostat is already in a state that produces the right result.
export function commandsFor(want, thermostat, program, step = 1) {
  const cmds = {};
  if (want.mode && thermostat.mode !== want.mode) cmds.mode = want.mode;
  if (want.setpoint != null) {
    const sp = thermostat.setpoint;
    const t0 = thermostat.temp;
    let ok = typeof sp === 'number' && !cmds.mode;
    if (ok && want.call !== undefined && typeof t0 === 'number') {
      const [lo, hi] = want.bounds;
      const inBounds = sp >= lo - 0.01 && sp <= hi + 0.01;
      if (want.mode === 'HEAT') ok = inBounds && (want.call ? sp >= t0 + step / 2 : sp <= t0 - step / 2);
      else ok = inBounds && (want.call ? sp <= t0 - step / 2 : sp >= t0 + step / 2);
    } else if (ok) {
      ok = Math.abs(sp - want.setpoint) < step / 2;
    }
    if (!ok) cmds.setpoint = want.setpoint;
  }
  if (program.fan && thermostat.fanSupported && thermostat.fan && thermostat.fan !== program.fan) {
    cmds.fan = program.fan;
  }
  return cmds;
}
