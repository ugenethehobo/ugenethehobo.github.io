# Temporary: prints the shape of ESPN's NFL data so the lights app can parse it.
import json, urllib.request, collections

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    raw = urllib.request.urlopen(req, timeout=30).read()
    print(f'## {url}  bytes={len(raw)}')
    return json.loads(raw)

B = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'
sb = get(f'{B}/scoreboard')
print('scoreboard keys', list(sb))
print('week', sb.get('week'), 'season', sb.get('season'))
for e in sb['events']:
    c = e['competitions'][0]
    print(e['id'], c['id'], e['date'], e['shortName'], c['status']['type'], [(x['team']['id'], x['team']['abbreviation'], x.get('score'), x['homeAway']) for x in c['competitors']])
    if c.get('situation'):
        print('  situation', json.dumps(c['situation'])[:1500])
print('event keys', list(sb['events'][0]))
print('competition keys', list(sb['events'][0]['competitions'][0]))
print('competitor sample', json.dumps(sb['events'][0]['competitions'][0]['competitors'][0])[:1500])

sched = get(f'{B}/teams/12/schedule')
print('schedule keys', list(sched))
done = []
for e in sched['events']:
    c = e['competitions'][0]
    st = c['status']['type']
    print(e['id'], e['date'], e['shortName'], st.get('state'), st.get('completed'), st.get('name'))
    if st.get('completed'):
        done.append(e['id'])
print('schedule competition keys', list(sched['events'][0]['competitions'][0]))

ev = done[-1]
s = get(f'{B}/summary?event={ev}')
print('summary keys', {k: len(json.dumps(v)) for k, v in s.items()})
print('header', json.dumps(s['header'])[:2500])
print('drives keys', list(s['drives']))
prev = s['drives']['previous']
print('drive keys', list(prev[0]), json.dumps({k: v for k, v in prev[0].items() if k != 'plays'})[:1500])
plays = [p for d in prev for p in d['plays']]
print('nplays', len(plays))
print('PLAY0', json.dumps(plays[0]))
print('PLAY5', json.dumps(plays[5]))
types = collections.OrderedDict()
for p in plays:
    t = (p['type'].get('id'), p['type'].get('text'), p['type'].get('abbreviation'))
    types.setdefault(t, []).append(p)
for t, ps in types.items():
    p = ps[0]
    print('TYPE', t, 'n=', len(ps), '| score', p.get('scoringPlay'), p.get('scoreValue'), '| start.team', (p.get('start') or {}).get('team'), '|', p.get('text', '')[:160])
pen = [p for p in plays if 'PENALTY' in p.get('text', '').upper()]
print('penalty-text plays', len(pen))
for p in pen[:6]:
    print('  PEN', p['type'], '|', p.get('text', '')[:200], '| keys', [k for k in p if k not in ('text',)])
for p in plays:
    if p.get('scoringPlay'):
        print('SCORING', json.dumps(p)[:1800]); break
print('scoringPlays[0]', json.dumps(s.get('scoringPlays', [None])[0])[:1500])
print('summary plays key?', 'plays' in s)
