# Temporary: dumps a compact play-by-play of the last finished Chiefs game as a test fixture.
import json, urllib.request

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

B = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'
sched = get(f'{B}/teams/12/schedule')
done = [e['id'] for e in sched['events'] if e['competitions'][0]['status']['type'].get('completed')]
s = get(f'{B}/summary?event={done[-1]}')
c = s['header']['competitions'][0]
print('STATUS', json.dumps(c['status']))
print('COMPETITORS', json.dumps([{k: x.get(k) for k in ('id', 'homeAway', 'score', 'winner')} | {'abbr': x['team']['abbreviation'], 'color': x['team'].get('color'), 'alt': x['team'].get('alternateColor')} for x in c['competitors']]))
keep = ('id', 'sequenceNumber', 'type', 'text', 'awayScore', 'homeScore', 'period', 'clock', 'scoringPlay', 'wallclock', 'isPenalty', 'isTurnover', 'statYardage', 'scoringType')
out = []
for d in s['drives']['previous']:
    for p in d['plays']:
        q = {k: p[k] for k in keep if k in p}
        q['type'] = {'id': p['type'].get('id'), 'text': p['type'].get('text')}
        q['start'] = {'team': (p.get('start') or {}).get('team')}
        q['end'] = {'team': (p.get('end') or {}).get('team')}
        q['teamParticipants'] = [{'id': t.get('id'), 'type': t.get('type')} for t in p.get('teamParticipants', [])]
        if 'penalty' in p: q['penalty'] = {k: v for k, v in p['penalty'].items() if k in ('status', 'type', 'team', 'yards')}
        out.append(q)
    print('DRIVE', d['id'], d['team']['id'], len(d['plays']))
import os
os.makedirs('lights/test/fixtures', exist_ok=True)
home = next(x for x in c['competitors'] if x['homeAway'] == 'home')
away = next(x for x in c['competitors'] if x['homeAway'] == 'away')
fixture = {
    'event': done[-1],
    'home': {'id': home['id'], 'abbr': home['team']['abbreviation'], 'color': home['team'].get('color'), 'score': home.get('score')},
    'away': {'id': away['id'], 'abbr': away['team']['abbreviation'], 'color': away['team'].get('color'), 'score': away.get('score')},
    'status': c['status'],
    'plays': out,
}
with open('lights/test/fixtures/kc-game.json', 'w') as f:
    json.dump(fixture, f, separators=(',', ':'))
print('wrote', len(out), 'plays')
