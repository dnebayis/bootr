# Writes data.json: every payment the $BOOTR agent's spender made in USDC in the window below, read from Base logs,
# plus the two facts pinned from the indexer's /platform/feed. Run once: python3 fetch_data.py
# Blocks on Base are 2 s apart, so a log's time is head time minus 2 s per block; first and last were checked against their blocks.
import json, time, urllib.request, datetime as D

SPENDER = '0xf79332ffbea9f595e609bac4dd2d91c6b78eab25'
PLATFORM = '0x55e66c7f30ac6d5c0c757fddaf56d66506439d82'  # the coin's platformRecipient; the only recipient in the window
USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
RPCS = ['https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://mainnet.base.org']
utc = lambda *a: int(D.datetime(*a, tzinfo=D.timezone.utc).timestamp())
START, END = utc(2026, 11, 5, 0), utc(2026, 11, 5, 7)
# Pinned from /platform/feed, read 2026-11-05 07:28 utc.
LAST_POST_AT = 1793852229
CLAIM = {'at': 1793862763, 'usd': 47.314009, 'tx': '0x6ff44dab4d53221cf751ff49bd89303159279a9ee1163b58dcd7be60d6f10955'}


def call(method, params):
    for i in range(9):
        try:
            body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
            req = urllib.request.Request(RPCS[i % 3], data=body, headers={'content-type': 'application/json', 'user-agent': 'bootr-brand'})
            res = json.load(urllib.request.urlopen(req, timeout=25))
            if 'result' in res:
                return res['result']
        except Exception as err:
            print('retry', err)
        time.sleep(2)
    raise SystemExit('rpc failed')


head = call('eth_getBlockByNumber', ['latest', False])
head_n, head_t = int(head['number'], 16), int(head['timestamp'], 16)
block = lambda t: head_n - (head_t - t) // 2
topic = '0x' + '0' * 24 + SPENDER[2:]
rows, b, end_b = [], block(START), block(END)
while b <= end_b:
    logs = call('eth_getLogs', [{'address': USDC, 'fromBlock': hex(b), 'toBlock': hex(min(b + 4999, end_b)), 'topics': [TRANSFER, topic]}])
    for log in logs:
        t = head_t - (head_n - int(log['blockNumber'], 16)) * 2
        if START <= t < END:
            rows.append({'at': t, 'usdc': int(log['data'], 16) / 1e6, 'tx': log['transactionHash'], 'to': '0x' + log['topics'][2][-40:]})
    b += 5000
    time.sleep(0.5)
assert {r['to'] for r in rows} == {PLATFORM}, 'a payment went somewhere else'
json.dump({'start': START, 'end': END, 'spender': SPENDER, 'paidTo': PLATFORM, 'lastPostAt': LAST_POST_AT, 'claim': CLAIM, 'count': len(rows),
           'totalUsdc': round(sum(r['usdc'] for r in rows), 6), 'payments': rows}, open('data.json', 'w'), indent=0)
print(len(rows), 'payments', round(sum(r['usdc'] for r in rows), 4))
