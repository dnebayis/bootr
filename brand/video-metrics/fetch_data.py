# Reads the public indexer and Base once and writes data.json, the only source of every figure in the film.
# Run: python3 fetch_data.py   (then python3 build.py)
import json, urllib.request, datetime
IDX = 'https://indexer.bootr.fun'
BOOTR = '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c'
DEAD = '000000000000000000000000000000000000dEaD'

def post(url, body, headers=None):
    req = urllib.request.Request(url, json.dumps(body).encode(), {'content-type': 'application/json', 'user-agent': 'bootr-brand-film', **(headers or {})})
    return json.load(urllib.request.urlopen(req, timeout=30))

q = '''{ platformStats(id: "global") { tokens volume24hUsd feesTotalUsd }
  dailyStats(orderBy: "id", orderDirection: "desc", limit: 3) { items { id volumeUsd } }
  tokens(orderBy: "volume24hUsd", orderDirection: "desc", limit: 4) { items { name symbol source volume24hUsd holders } }
  all: tokens(limit: 100) { items { source agentId } } }'''
g = post(IDX + '/graphql', {'query': q})['data']
fees = json.load(urllib.request.urlopen(urllib.request.Request(IDX + '/platform/fees', headers={'user-agent': 'bootr-brand-film'}), timeout=30))
feed = json.load(urllib.request.urlopen(urllib.request.Request(IDX + '/platform/feed?since=%d' % (int(datetime.datetime.now().timestamp()) - 3600), headers={'user-agent': 'bootr-brand-film'}), timeout=30))

def call(data):
    r = post('https://mainnet.base.org', {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [{'to': BOOTR, 'data': data}, 'latest']})
    return int(r['result'], 16)
burned = call('0x70a08231000000000000000000000000' + DEAD) / 1e18
supply = call('0x18160ddd') / 1e18

k = fees['total']['byKind']
total = fees['total']['feesTotalUsd']
launcher = total - sum(k.values())
src = {}
for t in g['all']['items']: src[t['source']] = src.get(t['source'], 0) + 1
day = {d['id']: d['volumeUsd'] for d in g['dailyStats']['items']}
today = max(day)
out = {
    'observedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'coins': g['platformStats']['tokens'],
    'agents': len({t['agentId'] for t in g['all']['items']}),
    'bySource': src,
    'volumeTotalUsd': fees['total']['volumeTotalUsd'],
    'volumeTodayUsd': day[today], 'today': today,
    'feesTotalUsd': total,
    'slots': {'creator': k['creator'], 'platform': k['platform'], 'launchers': launcher, 'burn': k['burn'], 'agent': k['agent']},
    'top24h': [{'name': t['name'], 'symbol': t['symbol'], 'volume24hUsd': t['volume24hUsd'], 'holders': t['holders']} for t in g['tokens']['items']],
    'bootrBurned': burned, 'bootrSupply': supply, 'bootrBurnedPct': burned / supply * 100,
}
json.dump(out, open('data.json', 'w'), indent=2)
print(json.dumps(out, indent=2))
