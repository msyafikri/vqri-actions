#!/usr/bin/env python3
"""Run the Python reference (mend_ref.py) on all 100 practice checks and
score it with the same semantics as the kit's checker: compare exit code,
stdout bytes, and every file in the directory afterwards.

Usage: python3 check_practice.py [--ref PATH] [--practice PATH] [--only KEY...]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

REF = os.path.expanduser("~/workspace/makefun/hiddenspec/ref/mend_ref.py")
PRACTICE = os.path.expanduser("~/workspace/makefun/hiddenspec/practice.json")


def run_one(check, ref):
    d = tempfile.mkdtemp(prefix="mend-practice-")
    try:
        for p, content in check["files"].items():
            full = os.path.join(d, p)
            parent = os.path.dirname(full)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(full, "w", encoding="utf-8", newline="") as f:
                f.write(content)
        inp = b"" if check["stdin"] is None else check["stdin"].encode("utf-8")
        r = subprocess.run([sys.executable, ref] + list(check["argv"]),
                           cwd=d, input=inp, capture_output=True, timeout=60)
        exp = dict(check["files"])
        for p, v in check["expect"]["changes"].items():
            if v is None:
                exp.pop(p, None)
            else:
                exp[p] = v
        actual = {}
        for dirpath, _dns, fns in os.walk(d):
            for fn in fns:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, d).replace(os.sep, "/")
                with open(full, encoding="utf-8", newline="") as f:
                    actual[rel] = f.read()
        ok_exit = r.returncode == check["expect"]["exit"]
        ok_out = r.stdout.decode("utf-8", errors="surrogateescape") == check["expect"]["stdout"]
        ok_files = actual == exp
        return ok_exit and ok_out and ok_files, {
            "exit": (r.returncode, check["expect"]["exit"], ok_exit),
            "stdout": (r.stdout.decode("utf-8", errors="surrogateescape"),
                       check["expect"]["stdout"], ok_out),
            "files": (actual, exp, ok_files),
            "stderr": r.stderr.decode("utf-8", errors="surrogateescape")[:500],
        }
    finally:
        shutil.rmtree(d, ignore_errors=True)


def main():
    ref = REF
    practice = PRACTICE
    only = None
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--ref":
            ref = args[i + 1]; i += 2
        elif args[i] == "--practice":
            practice = args[i + 1]; i += 2
        elif args[i] == "--only":
            only = set(args[i + 1:]); break
        else:
            i += 1
    data = json.load(open(practice))
    checks = data["checks"]
    # The reference runs with cwd=tempdir, so resolve its path first.
    ref = os.path.abspath(ref)
    total = 0
    passed = 0
    fails = []
    for c in checks:
        if only and c["key"] not in only:
            continue
        total += 1
        ok, det = run_one(c, ref)
        if ok:
            passed += 1
        else:
            fails.append((c, det))
    print("PRACTICE SCORE: %d/%d" % (passed, total))
    for c, det in fails:
        print("FAIL %s %s %s argv=%s" % (c["key"][:8], c["group"], c["family"], c["argv"]))
        if not det["exit"][2]:
            print("  exit: got %s want %s" % (det["exit"][0], det["exit"][1]))
        if not det["stdout"][2]:
            print("  stdout got: %r" % det["stdout"][0])
            print("  stdout want:%r" % det["stdout"][1])
        if not det["files"][2]:
            got, want = det["files"][0], det["files"][1]
            for p in sorted(set(got) | set(want)):
                if got.get(p) != want.get(p):
                    print("  file %s got: %r" % (p, got.get(p)))
                    print("  file %s want:%r" % (p, want.get(p)))
        if det["stderr"]:
            print("  stderr: %s" % det["stderr"])
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
