// Exercises the Amazon driver against a fake Amazon, so sign-in, discovery,
// polling and commands are checked end to end without a real account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlexaDriver, extractAuthCode, fanModeLabel } from '../server/drivers/alexa.js';

const cap = (namespace, name, value, instance) => JSON.stringify({ namespace, name, value, instance });

function fakeAmazon() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? String(init.body) : '';
    calls.push({ url: u.host + u.pathname, method: init.method || 'GET', headers: init.headers || {}, body });
    const json = (obj, setCookies = []) => {
      const h = new Headers({ 'Content-Type': 'application/json' });
      for (const c of setCookies) h.append('Set-Cookie', c);
      return new Response(JSON.stringify(obj), { status: 200, headers: h });
    };
    switch (u.host + u.pathname) {
      case 'api.amazon.com/auth/register': {
        const b = JSON.parse(body);
        assert.equal(b.auth_data.authorization_code, 'CODE123');
        return json({ response: { success: { tokens: { bearer: { refresh_token: 'Atnr|refresh', access_token: 'Atna|x' } } } } });
      }
      case 'www.amazon.com/ap/exchangetoken/cookies':
        assert.match(body, /source_token=Atnr%7Crefresh/);
        return json({ response: { tokens: { cookies: { '.amazon.com': [{ Name: 'session-id', Value: 's1' }, { Name: 'at-main', Value: 'a1' }] } } } });
      case 'alexa.amazon.com/api/language':
        return new Response('{}', { headers: { 'Set-Cookie': 'csrf=777; Path=/' } });
      case 'alexa.amazon.com/api/endpoints':
        return json({ websiteApiUrl: 'https://alexa.amazon.com' });
      case 'alexa.amazon.com/nexus/v1/graphql':
        return json({
          data: {
            endpoints: {
              items: [
                {
                  endpointId: 'e1',
                  legacyAppliance: {
                    applianceId: 'THERMO',
                    entityId: 'ent-thermo',
                    friendlyName: 'Hallway',
                    applianceTypes: ['THERMOSTAT'],
                    capabilities: [
                      { interfaceName: 'Alexa.ThermostatController' },
                      { interfaceName: 'Alexa.TemperatureSensor' },
                      {
                        interfaceName: 'Alexa.ModeController',
                        instance: 'Thermostat.FanMode',
                        configuration: { supportedModes: [{ value: 'FanMode.Auto' }, { value: 'FanMode.On' }] },
                      },
                    ],
                  },
                },
                {
                  endpointId: 'e2',
                  legacyAppliance: {
                    applianceId: 'AQM',
                    entityId: 'ent-aqm',
                    friendlyName: 'Bedroom monitor',
                    applianceTypes: ['AIR_QUALITY_MONITOR'],
                    capabilities: [
                      { interfaceName: 'Alexa.TemperatureSensor' },
                      { interfaceName: 'Alexa.RangeController', instance: '4', resources: { friendlyNames: [{ value: { text: 'Indoor humidity' } }] } },
                    ],
                  },
                },
                { endpointId: 'e3', legacyAppliance: { applianceId: 'LAMP', capabilities: [{ interfaceName: 'Alexa.PowerController' }] } },
              ],
            },
          },
        });
      case 'alexa.amazon.com/api/phoenix/state':
        assert.equal(init.headers.csrf, '777');
        assert.match(init.headers.Cookie, /session-id=s1/);
        if (init.method === 'PUT') return json({ controlResponses: [{ code: 'SUCCESS' }], errors: [] });
        return json({
          deviceStates: [
            {
              entity: { entityId: 'THERMO' },
              capabilityStates: [
                cap('Alexa.TemperatureSensor', 'temperature', { value: 20.5, scale: 'CELSIUS' }),
                cap('Alexa.ThermostatController', 'targetSetpoint', { value: 70, scale: 'FAHRENHEIT' }),
                cap('Alexa.ThermostatController', 'thermostatMode', 'HEAT'),
                cap('Alexa.ModeController', 'mode', 'FanMode.Auto', 'Thermostat.FanMode'),
              ],
            },
            {
              entity: { entityId: 'AQM' },
              capabilityStates: [cap('Alexa.TemperatureSensor', 'temperature', { value: 67.1, scale: 'FAHRENHEIT' }), cap('Alexa.RangeController', 'rangeValue', 45, '4')],
            },
          ],
          errors: [],
        });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

test('pulls the code out of the pasted Amazon address', () => {
  assert.equal(
    extractAuthCode('https://www.amazon.com/ap/maplanding?openid.assoc_handle=x&openid.oa2.authorization_code=ANabc-123&openid.mode=id_res'),
    'ANabc-123',
  );
  assert.equal(extractAuthCode('hello'), null);
});

test('sign-in, discovery, polling and commands against a fake Amazon', async () => {
  const fake = fakeAmazon();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    let saved = null;
    const d = new AlexaDriver({ save: (x) => (saved = x) });
    await d.connect();
    assert.equal(d.status().state, 'needs-login');

    const url = new URL(await d.startLogin());
    assert.equal(url.host, 'www.amazon.com');
    assert.equal(url.searchParams.get('openid.oa2.code_challenge_method'), 'S256');

    await d.completeLogin(`https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=CODE123&x=1`);
    assert.equal(d.status().state, 'connected');
    assert.equal(saved.refreshToken, 'Atnr|refresh');
    assert.match(saved.cookie, /csrf=777/);

    const found = await d.discover();
    assert.deepEqual(found.thermostats, [{ id: 'THERMO', name: 'Hallway' }]);
    assert.deepEqual(found.sensors.map((s) => s.kind), ['thermostat', 'air-quality']);
    const fan = d.useThermostat('THERMO');
    assert.deepEqual(fan.modes, [{ value: 'FanMode.Auto', label: 'Auto' }, { value: 'FanMode.On', label: 'On' }]);

    const r = await d.poll();
    assert.equal(r.THERMO.temp, 68.9); // 20.5 °C
    assert.equal(r.THERMO.setpoint, 70);
    assert.equal(r.THERMO.mode, 'HEAT');
    assert.equal(r.THERMO.fan, 'FanMode.Auto');
    assert.equal(r.AQM.humidity, 45);

    await d.setSetpoint(72);
    await d.setFan('FanMode.On');
    const puts = fake.calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body).controlRequests[0]);
    assert.equal(puts[0].entityId, 'ent-thermo');
    assert.deepEqual(puts[0].parameters, { action: 'setTargetTemperature', 'targetTemperature.value': '72', 'targetTemperature.scale': 'FAHRENHEIT' });
    assert.deepEqual(puts[1].parameters, { action: 'setModeValue', mode: 'FanMode.On', instance: 'Thermostat.FanMode' });

    // A restart restores devices without rediscovering.
    const d2 = new AlexaDriver({ saved });
    d2.restore(d.snapshot());
    await d2.connect();
    assert.equal(d2.status().state, 'connected');
    assert.equal((await d2.poll()).AQM.temp, 67.1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fan modes reported as numbers get their real names', () => {
  const text = (t) => ({ '@type': 'text', value: { text: t, locale: 'en-US' } });
  const asset = (id) => ({ '@type': 'asset', value: { assetId: id } });
  assert.equal(fanModeLabel({ value: '1', modeResources: { friendlyNames: [text('Auto')] } }), 'Auto');
  assert.equal(fanModeLabel({ value: '3', modeResources: { friendlyNames: [text('fan circulate')] } }), 'Circulate');
  assert.equal(fanModeLabel({ value: '2', modeResources: { friendlyNames: [asset('Alexa.Setting.On')] } }), 'On');
  assert.equal(fanModeLabel({ value: 'FanMode.Auto' }), 'Auto');
  assert.equal(fanModeLabel({ value: '4' }), 'Mode 4');
});

test('device info saved by an older version is rediscovered', () => {
  const d = new AlexaDriver();
  assert.equal(d.restore({ devices: [{ id: 'x' }], fan: { supported: true, modes: [{ value: '1', label: '1' }] } }), false);
  assert.equal(d.devices.size, 0);
});

test('probe reads the paired temperature sensors endpoint', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/nexus/v1/graphql')) return new Response(JSON.stringify({ data: { endpoints: { items: [{ id: 'amzn1.alexa.endpoint.T', legacyAppliance: { applianceId: 'T' } }] } } }));
    if (u === 'https://na-api-alexa.amazon.com/api/shNetworking/v1/temperatureSensor/pairedTemperatureSensors/amzn1.alexa.endpoint.T') {
      return new Response(JSON.stringify({ pairedSensors: ['amzn1.alexa.endpoint.AQ'] }));
    }
    return new Response('nope', { status: 404 });
  };
  try {
    const d = new AlexaDriver({ saved: { refreshToken: 'r', cookie: 'csrf=1', cookieAt: Date.now() } });
    d.restore({ version: 2, devices: [{ id: 'T', entityId: 'T', name: 'Thermostat' }], thermostatId: 'T', fan: { supported: false, modes: [] } });
    const out = await d.probe();
    const get = out.find((o) => o.label === 'GET na-api-alexa.amazon.com');
    assert.equal(get.status, 200);
    assert.match(get.body, /pairedSensors/);
    assert.equal(out.filter((o) => o.label.startsWith('GET')).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
