#!/usr/bin/env bash
# Generic property-verification shard runner.
# Args: campaign shard seed fuzz_runs band_cases shaped_cases
# Produces: result.json (counters only) and forge.log (tail) in the workspace root.
set -u
CAMPAIGN="$1"; SHARD="$2"; SEED="$3"; FUZZ_RUNS="$4"; BAND_CASES="$5"; SHAPED_CASES="$6"
ORACLE_SHA="7525bbd6b536bcd0c283de18af256fe54d629456"
POOL_SHA="ddf8ae0cdb2ad0041c3ff3aebc200cf488d5b0d3"
ROOT="$PWD"

clone_at() { # repo sha dir
  git init -q "$3"
  git -C "$3" remote add origin "https://github.com/$1"
  git -C "$3" fetch -q --depth 1 origin "$2"
  git -C "$3" checkout -q FETCH_HEAD
}
sub_at() { # superdir subpath
  local sha
  sha=$(git -C "$1" ls-tree HEAD "$2" | awk '{print $3}')
  local url
  url=$(git -C "$1" config -f .gitmodules "submodule.$2.url")
  local repo="${url#https://github.com/}"
  clone_at "$repo" "$sha" "$1/$2"
}

write_result() { # status note
  python3 - "$1" "$2" <<'PYEOF'
import json, sys, os
res = {"campaign": os.environ.get("CAMPAIGN"), "shard": os.environ.get("SHARD"),
       "seed": os.environ.get("SEED"), "status": sys.argv[1], "note": sys.argv[2],
       "tests_passed": 0, "tests_failed": 0, "failed_tests": []}
try:
    with open("forge.json") as f:
        data = json.load(f)
    def walk(node):
        if isinstance(node, dict):
            if "status" in node and isinstance(node.get("status"), str):
                yield node
            for v in node.values():
                yield from walk(v)
        elif isinstance(node, list):
            for v in node:
                yield from walk(v)
    for t in walk(data):
        s = t["status"]
        if s == "Success":
            res["tests_passed"] += 1
        elif s in ("Failure", "Failed"):
            res["tests_failed"] += 1
            res["failed_tests"].append(t.get("name", "?"))
except Exception as e:
    res["note"] += f" (forge.json parse: {e})"
with open("result.json", "w") as f:
    json.dump(res, f, indent=1)
print(json.dumps(res))
PYEOF
}
export CAMPAIGN SHARD SEED

if [ "$CAMPAIGN" = "band" ] || [ "$CAMPAIGN" = "codebook" ]; then
  clone_at "Metricxyz/oracle-contracts" "$ORACLE_SHA" src-oracle
  sub_at src-oracle lib/forge-std
  sub_at src-oracle lib/openzeppelin-contracts
  sub_at src-oracle lib/pyth-crosschain
  mkdir -p src-oracle/test/verify
  cp metric-verify/oracle/*.t.sol src-oracle/test/verify/
  cd src-oracle
  if [ "$CAMPAIGN" = "band" ]; then
    python3 ../metric-verify/oracle/model_app.py "$SEED" "$BAND_CASES" "$SHAPED_CASES" test/verify/GenCases.sol || { write_result "gen_failed" "case generation failed"; exit 0; }
    forge test --match-contract BandMathVerifyTest --fuzz-runs "$FUZZ_RUNS" --fuzz-seed "$SEED" --json > ../forge.json 2> ../forge.log
  else
    forge test --match-contract CodebookVerifyTest --json > ../forge.json 2> ../forge.log
  fi
  echo "forge exit: $?" >> ../forge.log
  cd "$ROOT"
  write_result "done" "forge run finished"
elif [ "$CAMPAIGN" = "liquidity" ]; then
  clone_at "Metricxyz/pool-contracts" "$POOL_SHA" src-pool
  sub_at src-pool lib/forge-std
  sub_at src-pool lib/openzeppelin-contracts
  mkdir -p src-pool/test/verify
  cp metric-verify/pool/*.sol src-pool/test/verify/
  cd src-pool
  forge test --match-contract LiquidityConservationTest --fuzz-runs "$FUZZ_RUNS" --fuzz-seed "$SEED" --json > ../forge.json 2> ../forge.log
  echo "forge exit: $?" >> ../forge.log
  cd "$ROOT"
  write_result "done" "forge run finished"
else
  write_result "bad_campaign" "unknown campaign"
fi
tail -n 300 forge.log > forge-tail.log 2>/dev/null || true
