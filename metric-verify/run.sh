#!/usr/bin/env bash
# Generic property-verification shard runner (v2).
# Args: campaign shard seed fuzz_runs band_cases shaped_cases
# Produces: result.json (counters only), forge-tail.log, gen.log in the workspace root.
set -u
CAMPAIGN="$1"; SHARD="$2"; SEED="$3"; FUZZ_RUNS="$4"; BAND_CASES="$5"; SHAPED_CASES="$6"
ORACLE_SHA="7525bbd6b536bcd0c283de18af256fe54d629456"
POOL_SHA="ddf8ae0cdb2ad0041c3ff3aebc200cf488d5b0d3"
ROOT="$PWD"
export CAMPAIGN SHARD SEED
FORGE_EXIT=""

clone_at() { # repo sha dir
  git init -q "$3"
  git -C "$3" remote add origin "https://github.com/$1"
  git -C "$3" fetch -q --depth 1 origin "$2"
  git -C "$3" checkout -q FETCH_HEAD
}
sub_at() { # superdir subpath
  local sha url repo
  sha=$(git -C "$1" ls-tree HEAD "$2" | awk '{print $3}')
  url=$(git -C "$1" config -f .gitmodules --get-regexp 'submodule\..*\.url' | grep -i "$(basename "$2")" | head -1 | awk '{print $2}')
  if [ -z "$url" ]; then url=$(git -C "$1" config -f .gitmodules "submodule.$2.url"); fi
  repo="${url#https://github.com/}"
  clone_at "$repo" "$sha" "$1/$2"
}

write_result() { # status note
  FORGE_EXIT_VAL="${FORGE_EXIT:-}" python3 - "$1" "$2" <<'PYEOF'
import json, sys, os
res = {"campaign": os.environ.get("CAMPAIGN"), "shard": os.environ.get("SHARD"),
       "seed": os.environ.get("SEED"), "status": sys.argv[1], "note": sys.argv[2],
       "forge_exit": os.environ.get("FORGE_EXIT_VAL", ""),
       "tests_passed": 0, "tests_failed": 0, "failed_tests": []}
try:
    with open("forge.json") as f:
        data = json.load(f)
    suites = data.get("test_results", data) if isinstance(data, dict) else {}
    if isinstance(suites, dict):
        for suite_name, suite in suites.items():
            if not isinstance(suite, dict):
                continue
            trs = suite.get("test_results", {})
            if isinstance(trs, dict):
                for tname, t in trs.items():
                    if not isinstance(t, dict):
                        continue
                    st = t.get("status")
                    if st == "Success":
                        res["tests_passed"] += 1
                    elif st in ("Failure", "Failed"):
                        res["tests_failed"] += 1
                        res["failed_tests"].append(tname)
except Exception as e:
    res["note"] += f" (forge.json parse: {e})"
with open("result.json", "w") as f:
    json.dump(res, f, indent=1)
print(json.dumps(res))
PYEOF
}

if [ "$CAMPAIGN" = "band" ] || [ "$CAMPAIGN" = "codebook" ]; then
  clone_at "Metricxyz/oracle-contracts" "$ORACLE_SHA" src-oracle
  sub_at src-oracle lib/forge-std
  sub_at src-oracle lib/openzeppelin-contracts
  sub_at src-oracle lib/openzeppelin-contracts-upgradeable
  sub_at src-oracle lib/pyth-crosschain
  mkdir -p src-oracle/test/verify
  cd src-oracle
  if [ "$CAMPAIGN" = "band" ]; then
    cp ../metric-verify/oracle/BandMathVerify.t.sol test/verify/
    python3 ../metric-verify/oracle/model_app.py "$SEED" "$BAND_CASES" "$SHAPED_CASES" test/verify/GenCases.sol > ../gen.log 2>&1
    ls -la test/verify/ >> ../gen.log 2>&1
    if [ ! -s test/verify/GenCases.sol ]; then
      cd "$ROOT"
      write_result "gen_failed" "case generation produced no file"
      tail -n 50 forge.log > forge-tail.log 2>/dev/null || echo "no forge log" > forge-tail.log
      exit 0
    fi
    forge test --match-contract BandMathVerifyTest --fuzz-runs "$FUZZ_RUNS" --fuzz-seed "$SEED" --json > ../forge.json 2> ../forge.log
    FORGE_EXIT=$?
  else
    cp ../metric-verify/oracle/CodebookVerify.t.sol test/verify/
    echo "codebook: no generation" > ../gen.log
    forge test --match-contract CodebookVerifyTest --json > ../forge.json 2> ../forge.log
    FORGE_EXIT=$?
  fi
  echo "forge exit: $FORGE_EXIT" >> ../forge.log
  cd "$ROOT"
  if [ "$FORGE_EXIT" != "0" ]; then
    write_result "forge_failed" "forge exited nonzero"
  else
    write_result "done" "forge run finished"
  fi
elif [ "$CAMPAIGN" = "liquidity" ]; then
  clone_at "Metricxyz/pool-contracts" "$POOL_SHA" src-pool
  sub_at src-pool lib/forge-std
  sub_at src-pool lib/openzeppelin-contracts
  mkdir -p src-pool/test/verify
  cp metric-verify/pool/*.sol src-pool/test/verify/
  echo "liquidity: no generation" > gen.log
  cd src-pool
  forge test --match-contract LiquidityConservationTest --fuzz-runs "$FUZZ_RUNS" --fuzz-seed "$SEED" --json > ../forge.json 2> ../forge.log
  FORGE_EXIT=$?
  echo "forge exit: $FORGE_EXIT" >> ../forge.log
  cd "$ROOT"
  if [ "$FORGE_EXIT" != "0" ]; then
    write_result "forge_failed" "forge exited nonzero"
  else
    write_result "done" "forge run finished"
  fi
else
  echo "unknown campaign" > gen.log
  write_result "bad_campaign" "unknown campaign"
fi
tail -n 300 forge.log > forge-tail.log 2>/dev/null || true
