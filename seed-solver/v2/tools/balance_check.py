#!/usr/bin/env python3
"""Balance checker for `seed_solver --hunt` output.

Reads survivor lines "<rank> <base58 address>" (stdin or --input FILE),
batches them 100 at a time into Solana JSON-RPC getMultipleAccounts calls
spread across several public endpoints, and prints one line per FUNDED
account:

    HIT rank=<rank> address=<addr> lamports=<n>

At end of input it prints exactly one coverage line:

    COVERAGE total=<n> checked=<n> failed=<n> hits=<n> \
        endpoints_ok=<k>/<m> status=OK|UNVERIFIED

An address counts as "checked" only when an endpoint actually answered
for it (a null account entry is a verified zero balance — the account
does not exist). Addresses in a batch that every endpoint failed to
answer after all retries count as "failed", and any nonzero failed count
(or an endpoint that never succeeded) flips status to UNVERIFIED: a
failed read is never silently treated as a zero balance.

Retries use exponential backoff and rotate endpoints; each endpoint is
paced to --rate requests/second (default 5). Standard library only.

--stub-funded ADDR[,ADDR...] replaces the network entirely (tests): the
listed addresses report --stub-lamports, everything else a verified 0.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_ENDPOINTS = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.drpc.org",
    "https://solana.api.onfinality.io/public",
    "https://solana-mainnet.rpc.extrnode.com",
]

MAX_ATTEMPTS = 8          # per batch, rotating endpoints
REQ_TIMEOUT = 20.0        # seconds per HTTP request
COOLDOWN = 30.0           # endpoint rest after repeated failures


class Endpoint:
    def __init__(self, url, rate):
        self.url = url
        self.min_interval = 1.0 / rate if rate > 0 else 0.0
        self.last_req = 0.0
        self.ok = 0
        self.fail = 0
        self.consec_fail = 0
        self.down_until = 0.0

    def pace(self):
        now = time.monotonic()
        wait = self.last_req + self.min_interval - now
        if wait > 0:
            time.sleep(wait)
        self.last_req = time.monotonic()


class Checker:
    def __init__(self, endpoints, rate, batch_size):
        self.eps = [Endpoint(u, rate) for u in endpoints]
        self.rr = 0
        self.batch_size = batch_size
        self.total = 0
        self.checked = 0
        self.failed = 0
        self.hits = 0

    def _rpc_once(self, ep, addresses):
        ep.pace()
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getMultipleAccounts",
            "params": [addresses, {"encoding": "base64"}],
        }).encode()
        req = urllib.request.Request(
            ep.url, data=body,
            headers={"Content-Type": "application/json",
                     "User-Agent": "seed-hunt-balance-check/1.0"})
        with urllib.request.urlopen(req, timeout=REQ_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode())
        if "error" in payload:
            raise RuntimeError(f"rpc error: {payload['error']}")
        value = payload["result"]["value"]
        if len(value) != len(addresses):
            raise RuntimeError("short result")
        return value

    def check_batch(self, items):
        """items: list of (rank, address). Prints HITs; updates counters."""
        addresses = [a for _, a in items]
        backoff = 1.0
        for attempt in range(MAX_ATTEMPTS):
            # pick the next endpoint that is not cooling down
            ep = None
            for _ in range(len(self.eps)):
                cand = self.eps[self.rr % len(self.eps)]
                self.rr += 1
                if cand.down_until <= time.monotonic():
                    ep = cand
                    break
            if ep is None:  # all cooling down: wait for the earliest
                wait = min(e.down_until for e in self.eps) - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                continue
            try:
                value = self._rpc_once(ep, addresses)
            except Exception as e:  # noqa: BLE001 - any failure rotates
                ep.fail += 1
                ep.consec_fail += 1
                if ep.consec_fail >= 3:
                    ep.down_until = time.monotonic() + COOLDOWN
                    ep.consec_fail = 0
                print(f"[check] {ep.url} attempt {attempt + 1} failed: {e}",
                      file=sys.stderr)
                if attempt + 1 < MAX_ATTEMPTS:
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
                continue
            ep.ok += 1
            ep.consec_fail = 0
            self.checked += len(items)
            for (rank, addr), entry in zip(items, value):
                if entry is not None and entry.get("lamports", 0) > 0:
                    self.hits += 1
                    print(f"HIT rank={rank} address={addr} "
                          f"lamports={entry['lamports']}", flush=True)
            return
        # every endpoint/attempt failed: these addresses are UNVERIFIED,
        # never silently zero.
        self.failed += len(items)
        print(f"[check] batch of {len(items)} UNVERIFIED after "
              f"{MAX_ATTEMPTS} attempts", file=sys.stderr)

    def coverage_line(self):
        ok_eps = sum(1 for e in self.eps if e.ok > 0)
        status = "OK"
        if self.failed > 0 or (self.total > 0 and ok_eps == 0):
            status = "UNVERIFIED"
        return (f"COVERAGE total={self.total} checked={self.checked} "
                f"failed={self.failed} hits={self.hits} "
                f"endpoints_ok={ok_eps}/{len(self.eps)} status={status}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="-", help="input file ('-' = stdin)")
    ap.add_argument("--endpoints", default=",".join(DEFAULT_ENDPOINTS),
                    help="comma-separated RPC endpoint URLs")
    ap.add_argument("--rate", type=float, default=5.0,
                    help="max requests/second per endpoint")
    ap.add_argument("--batch", type=int, default=100,
                    help="addresses per getMultipleAccounts call (max 100)")
    ap.add_argument("--stub-funded", default="",
                    help="TEST ONLY: comma-separated addresses treated as "
                         "funded; no network calls are made")
    ap.add_argument("--stub-lamports", type=int, default=1_000_000)
    args = ap.parse_args()
    if args.batch < 1 or args.batch > 100:
        print("--batch must be 1..100", file=sys.stderr)
        return 2

    src = sys.stdin if args.input == "-" else open(args.input)
    stub = None
    if args.stub_funded:
        stub = {a.strip() for a in args.stub_funded.split(",") if a.strip()}

    if stub is not None:
        total = checked = hits = 0
        for line in src:
            parts = line.split()
            if len(parts) != 2:
                continue
            rank, addr = parts
            total += 1
            checked += 1
            if addr in stub:
                hits += 1
                print(f"HIT rank={rank} address={addr} "
                      f"lamports={args.stub_lamports}", flush=True)
        print(f"COVERAGE total={total} checked={checked} failed=0 "
              f"hits={hits} endpoints_ok=stub status=OK")
        return 0

    endpoints = [u.strip() for u in args.endpoints.split(",") if u.strip()]
    if not endpoints:
        print("no endpoints", file=sys.stderr)
        return 2
    chk = Checker(endpoints, args.rate, args.batch)
    buf = []
    for line in src:
        parts = line.split()
        if len(parts) != 2:
            continue
        buf.append((parts[0], parts[1]))
        chk.total += 1
        if len(buf) >= args.batch:
            chk.check_batch(buf)
            buf = []
    if buf:
        chk.check_batch(buf)
    print(chk.coverage_line())
    return 0


if __name__ == "__main__":
    sys.exit(main())
