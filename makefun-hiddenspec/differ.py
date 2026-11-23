#!/usr/bin/env python3
"""Differential fuzzer: random mend checks run against BOTH the Python
reference (mend_ref.py) and the JS engine (lab/main.ts) as a black box,
in fresh temp dirs with identical argv/stdin/files. Compares exit code,
stdout bytes, and all resulting files exactly.

Usage:
  python3 differ.py --ref REF --engine ENGINE [--seed N] [--cases N]
                    [--out DIR] [--start N] [--timeout S]
Divergences are saved as JSON repros under --out (one file per divergence).
Prints a JSON summary line at the end.
"""
import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile

LINE_POOL = [
    "def foo(x):", "    return x + 1", "    if x > 0:", "        return None",
    "x = 1", "", "    # comment", "import os", "class Foo:", "    pass",
    "print(x)", "}", "function bar() {", "  const y = 2;", "  return y;",
    "const a = 1;", "let b = 'hi';", "// note", "# heading", "- item",
    "some text here", "    indented", "\ttabbed", "trailing   ",
    "dup line", "dup line", "dup line ", "  dup line", "return payload_total * 2",
    "    return payload_total * 2", "stage.stock = 318", "    stage.stock = 318",
    "if (a) {", "  }", "else {", "    x += 1", "    ", "  ",
    "module.exports = {}", "export default foo;", "package main",
    "func main() {", "fmt.Println(x)", "    // TODO", "a = b + c",
    "key: value", '"quoted"', "'single'", "    return field.merge(x);",
]

FILE_NAMES = ["a.py", "b.go", "c.js", "doc.md", "x.txt", "src/d.py",
              "lib/e.js", "deep/nest/f.go", "notes.txt", "app/g.py"]
PATCH_NAMES = ["fix.patch", "edit.patch", "change.diff", "patch.txt",
               "reply.md", "p.diff"]
UNSAFE_PATHS = ["../evil.py", "/abs.py", "a//b.py", "a/./b.py", "a\\b.py",
                "", ".", "..", "a/", "./x.py", "a/../b.py"]


def file_parts(text):
    if text == "":
        return [], "\n", False
    i = text.find("\n")
    if i < 0:
        return [text], "\n", False
    br = "\r\n" if i > 0 and text[i - 1] == "\r" else "\n"
    parts = text.split(br)
    if text.endswith(br):
        return parts[:-1], br, True
    return parts, br, False


def gen_tree(rng):
    nfiles = rng.randint(1, 4)
    names = rng.sample(FILE_NAMES, nfiles)
    files = {}
    for name in names:
        nlines = rng.choice([0, 1, 2, 3, 5, 8, 12, 15])
        lines = [rng.choice(LINE_POOL) for _ in range(nlines)]
        crlf = rng.random() < 0.25
        br = "\r\n" if crlf else "\n"
        text = br.join(lines)
        if lines and rng.random() < 0.75:
            text += br
        files[name] = text
    return files


def drift_line(rng, line):
    r = rng.random()
    if r < 0.12:
        return line + rng.choice([" ", "  ", "\t", "   "])
    if r < 0.20 and line.startswith("    "):
        return line[2:]
    if r < 0.26 and line.startswith("  "):
        return "\t" + line[2:]
    if r < 0.30:
        return line.strip(" \t")
    return line


def gen_unified(rng, files):
    """Returns patch text. May be malformed."""
    parts = []
    if rng.random() < 0.3:
        parts.append(rng.choice(["Some prose here.", "```diff", "Fix stuff:", ""]))
    nsec = rng.randint(1, 3)
    existing = [p for p in files if p not in PATCH_NAMES]
    for _ in range(nsec):
        kind = rng.choices(["change", "create", "delete", "move", "rename"],
                           weights=[55, 15, 10, 10, 10])[0]
        if kind == "create":
            target = rng.choice(["new1.py", "src/new2.go", "created.txt"])
            oldp, newp = "/dev/null", target
            flines = []
        elif kind == "delete":
            target = rng.choice(existing) if existing else "gone.py"
            oldp, newp = target, "/dev/null"
            flines, _br, _e = file_parts(files.get(target, ""))
        elif kind in ("move", "rename"):
            target = rng.choice(existing) if existing else "a.py"
            dest = rng.choice(["moved.py", "src/moved.go", target])
            oldp, newp = target, dest
            flines, _br, _e = file_parts(files.get(target, ""))
        else:
            target = rng.choice(existing) if existing else "a.py"
            oldp, newp = target, target
            flines, _br, _e = file_parts(files.get(target, ""))
        use_git = rng.random() < 0.6
        if use_git:
            if rng.random() < 0.05:
                parts.append("diff --git a/%s" % oldp)  # malformed
            else:
                parts.append("diff --git a/%s b/%s" % (oldp, newp))
            if rng.random() < 0.3:
                parts.append("index abc123..def456 100644")
            if rng.random() < 0.15:
                parts.append("new file mode 100644" if kind == "create"
                             else "deleted file mode 100644"
                             if kind == "delete" else "old mode 100644")
            if kind == "rename" and rng.random() < 0.7:
                parts.append("rename from %s" % oldp)
                parts.append("rename to %s" % newp)
        # ---/+++ header (sometimes bare, sometimes with a/ b/)
        if rng.random() < 0.05 and use_git:
            parts.append("--- %s" % oldp)  # --- without +++ -> parse error
        else:
            def hp(p):
                if p == "/dev/null":
                    return "/dev/null"
                return rng.choice(["%s", "a/%s", "b/%s"]) % p \
                    if rng.random() < 0.5 else p
            parts.append("--- " + hp(oldp))
            parts.append("+++ " + hp(newp))
        if kind == "delete":
            if rng.random() < 0.5:
                parts.append("@@ -1,2 +0,0 @@")
                parts.append(" context")
                parts.append("-gone")
            continue
        # hunks
        nhunks = rng.randint(1, 2) if kind != "create" else rng.randint(1, 2)
        for _h in range(nhunks):
            if kind == "create":
                plus = [rng.choice(LINE_POOL) for _ in range(rng.randint(0, 4))]
                a = 0
                parts.append("@@ -0,0 +1,%d @@%s" % (
                    len(plus), rng.choice(["", " function x"])))
                for pl in plus:
                    parts.append("+" + pl)
                if plus and rng.random() < 0.2:
                    parts.append("\\ No newline at end of file")
                continue
            if not flines:
                parts.append("@@ -0,0 +1,1 @@")
                parts.append("+inserted line")
                continue
            start = rng.randrange(len(flines))
            k = rng.randint(1, min(4, len(flines) - start))
            seg = flines[start:start + k]
            a = start + 1 + rng.choice([0, 0, 0, -2, 2, -5, 7])
            a = max(0, a)
            body = []
            newcount = 0
            oldcount = 0
            for ln in seg:
                r = rng.random()
                dl = drift_line(rng, ln) if rng.random() < 0.3 else ln
                if r < 0.45:
                    body.append(" " + dl)
                    oldcount += 1
                    newcount += 1
                elif r < 0.75:
                    body.append("-" + dl)
                    oldcount += 1
                else:
                    body.append("+" + rng.choice(LINE_POOL))
                    newcount += 1
            for _ in range(rng.randint(0, 2)):
                body.insert(rng.randrange(len(body) + 1),
                            "+" + rng.choice(LINE_POOL))
                newcount += 1
            if rng.random() < 0.08:
                body.append("@@ -x +y @@")  # malformed hunk header inside body? no: ends body
            parts.append("@@ -%d,%d +%d,%d @@%s" % (
                a, oldcount, a, newcount, rng.choice(["", " section"])))
            parts.extend(body)
            if start + k >= len(flines) and rng.random() < 0.4:
                parts.append("\\ No newline at end of file")
        if rng.random() < 0.2:
            parts.append(rng.choice(["", "more prose", "```"]))
    return "\n".join(parts) + ("\n" if rng.random() < 0.9 else "")


def gen_search_replace(rng, files):
    parts = []
    existing = [p for p in files if p not in PATCH_NAMES]
    nblocks = rng.randint(1, 3)
    for bi in range(nblocks):
        if rng.random() < 0.3:
            parts.append(rng.choice(["```diff", "Here is the fix:", ""]))
        kind = rng.choices(["change", "create", "missing", "ambiguous"],
                           weights=[60, 15, 10, 15])[0]
        if kind == "create":
            target = rng.choice(["new1.py", "src/new2.go"])
            old, new = [], [rng.choice(LINE_POOL) for _ in range(rng.randint(0, 3))]
        else:
            target = rng.choice(existing) if existing else "a.py"
            if kind == "missing":
                target = rng.choice(["nope.py", "src/missing.go"])
            flines, _br, _e = file_parts(files.get(target, ""))
            if kind == "ambiguous" and flines:
                old = ["dup line"]
                new = ["replaced dup"]
            elif flines:
                start = rng.randrange(len(flines))
                k = rng.randint(1, min(3, len(flines) - start))
                old = [drift_line(rng, ln) if rng.random() < 0.35 else ln
                       for ln in flines[start:start + k]]
                new = [rng.choice(LINE_POOL) for _ in range(rng.randint(0, 3))]
            else:
                old, new = ["nothing here"], ["x"]
        if bi == 0 and rng.random() < 0.08:
            pass  # no path line on first block -> parse error
        else:
            parts.append(target)
        parts.append("<<<<<<< SEARCH")
        parts.extend(old)
        if rng.random() < 0.05:
            parts.append(">>>>>>> REPLACE")  # missing ======= -> parse error
            continue
        parts.append("=======")
        parts.extend(new)
        if rng.random() < 0.05:
            continue  # missing REPLACE -> parse error
        parts.append(">>>>>>> REPLACE")
    return "\n".join(parts) + ("\n" if rng.random() < 0.9 else "")


def gen_v4a(rng, files):
    parts = ["*** Begin Patch"]
    existing = [p for p in files if p not in PATCH_NAMES]
    nsec = rng.randint(1, 3)
    for _ in range(nsec):
        kind = rng.choices(["add", "delete", "update"],
                           weights=[25, 15, 60])[0]
        if rng.random() < 0.05:
            parts.append("*** Bogus line")  # parse error
        if kind == "add":
            target = rng.choice(["new1.py", "src/new2.go", "created.txt"])
            parts.append("*** Add File: %s" % target)
            for _ in range(rng.randint(0, 4)):
                parts.append("+" + rng.choice(LINE_POOL))
            if rng.random() < 0.3:
                parts.append("")
            continue
        if kind == "delete":
            target = rng.choice(existing) if existing else "gone.py"
            parts.append("*** Delete File: %s" % target)
            continue
        target = rng.choice(existing) if existing else "a.py"
        parts.append("*** Update File: %s" % target)
        move = None
        if rng.random() < 0.2:
            move = rng.choice(["moved.py", "src/moved.go", target])
            parts.append("*** Move to: %s" % move)
        flines, _br, _e = file_parts(files.get(target, ""))
        nchunks = rng.randint(1, 2)
        cursor = 0
        for _c in range(nchunks):
            anchor = None
            if rng.random() < 0.6 and flines:
                anchor = rng.choice(flines[max(0, cursor):] or flines)
                parts.append("@@ %s" % anchor)
                try:
                    cursor = flines.index(anchor, cursor) + 1
                except ValueError:
                    pass
            elif rng.random() < 0.5:
                parts.append("@@")
            else:
                parts.append("@@ nonexistent anchor line")
            if not flines:
                parts.append("+only line")
                continue
            start = rng.randrange(len(flines)) if rng.random() < 0.5 else \
                min(cursor + rng.randint(0, 3), len(flines) - 1)
            k = rng.randint(1, min(3, len(flines) - start))
            seg = flines[start:start + k]
            for ln in seg:
                r = rng.random()
                dl = drift_line(rng, ln) if rng.random() < 0.3 else ln
                if r < 0.45:
                    parts.append(" " + dl)
                elif r < 0.75:
                    parts.append("-" + dl)
                else:
                    parts.append("+" + rng.choice(LINE_POOL))
            for _ in range(rng.randint(0, 1)):
                parts.append("+" + rng.choice(LINE_POOL))
            if rng.random() < 0.2:
                parts.append("*** End of File")
                break
            if rng.random() < 0.15:
                parts.append("")
    if rng.random() < 0.05:
        pass  # missing End Patch -> parse error
    else:
        parts.append("*** End Patch")
    return "\n".join(parts) + ("\n" if rng.random() < 0.9 else "")


def gen_json(rng, files):
    existing = [p for p in files if p not in PATCH_NAMES]
    nedits = rng.randint(1, 3)
    edits = []
    for _ in range(nedits):
        kind = rng.choices(["create", "str_replace", "insert"],
                           weights=[25, 45, 30])[0]
        if kind == "create":
            e = {"command": "create",
                 "path": rng.choice(["new1.py", "src/new2.go", "a.py",
                                     rng.choice(UNSAFE_PATHS)]),
                 "file_text": rng.choice(["hello\n", "x = 1\nno newline",
                                          "a\r\nb\r\n", ""])}
        elif kind == "str_replace":
            target = rng.choice(existing) if existing else "a.py"
            text = files.get(target, "")
            if text and rng.random() < 0.7:
                i = rng.randrange(len(text))
                j = min(len(text), i + rng.randint(1, 12))
                old = text[i:j]
            elif rng.random() < 0.3:
                old = "dup"
            else:
                old = "absent-substring-xyz"
            e = {"command": "str_replace", "path": target,
                 "old_str": old,
                 "new_str": rng.choice(["NEW", "", "multi\nline\n", "x\ry"])}
            if rng.random() < 0.08:
                e["old_str"] = ""  # parse fault
            if rng.random() < 0.06:
                e["insert_line"] = "bad"  # extra key, ignored
        else:
            target = rng.choice(existing) if existing else "a.py"
            flines, _br, _e = file_parts(files.get(target, ""))
            il = rng.choice([0, len(flines), len(flines) + 1, -1,
                             rng.randint(0, len(flines))])
            e = {"command": "insert", "path": target,
                 "insert_line": il,
                 "new_str": rng.choice(["ins\n", "", "a\nb", "x\r\ny\r\n"])}
            if rng.random() < 0.06:
                e["insert_line"] = 1.5  # mistyped -> parse fault
            if rng.random() < 0.06:
                del e["new_str"]  # missing key -> parse fault
        if rng.random() < 0.05:
            e["command"] = "bogus"  # parse fault
        edits.append(e)
    if rng.random() < 0.5:
        if rng.random() < 0.06:
            return "[not json"  # malformed array
        if rng.random() < 0.05:
            return "[]"
        return json.dumps(edits)
    lines = []
    for e in edits:
        if rng.random() < 0.05:
            lines.append("{bad json")
        else:
            lines.append(json.dumps(e))
        if rng.random() < 0.1:
            lines.append("")
    return "\n".join(lines) + "\n"


def gen_case(rng):
    files = gen_tree(rng)
    fmt = rng.choices(["unified", "search-replace", "v4a", "json"],
                      weights=[30, 25, 25, 20])[0]
    if fmt == "unified":
        patch = gen_unified(rng, files)
    elif fmt == "search-replace":
        patch = gen_search_replace(rng, files)
    elif fmt == "v4a":
        patch = gen_v4a(rng, files)
    else:
        patch = gen_json(rng, files)
    if rng.random() < 0.04:
        patch = rng.choice(["", "hello world\n", "```\nrandom\n",
                            "diff --git a/x b/y\n", "\n\n\n"])
        fmt = "garbage"
    pname = rng.choice(PATCH_NAMES)
    # argv variants
    r = rng.random()
    if r < 0.55:
        argv = [pname]
    elif r < 0.65:
        argv = ["-"]
    elif r < 0.70:
        argv = []
    elif r < 0.78:
        argv = [rng.choice(["--check", "--strict"]), pname]
    elif r < 0.84:
        argv = ["--format=%s" % rng.choice(
            ["auto", "unified", "search-replace", "v4a", "json", "git",
             "unified"]), pname]
    elif r < 0.88:
        argv = [rng.choice(["--check", "--check", "--bogus", "--dry-run",
                            "--format", "--format="]), pname]
    elif r < 0.92:
        argv = ["--", pname]
    elif r < 0.95:
        argv = [pname, "extra"]
    elif r < 0.98:
        argv = ["missing.patch"]
    else:
        argv = ["--strict", "-"]
    use_stdin = ("-" in argv) or (not argv) or \
        (len(argv) == 2 and argv[0] in ("--check", "--strict") and argv[1] == "-")
    if not use_stdin and rng.random() < 0.1:
        pass  # patch file delivery as usual
    stdin = patch if use_stdin else (b"" if rng.random() < 0.8
                                     else b"ignored stdin bytes\n")
    if isinstance(stdin, str):
        stdin = stdin.encode("utf-8")
    if not use_stdin:
        files = dict(files)
        files[pname] = patch
    return {"format": fmt, "argv": argv, "stdin": stdin.decode(
        "utf-8", errors="surrogateescape") if isinstance(stdin, bytes) else stdin,
        "files": files}


def run_impl(cmd, argv, stdin_bytes, files, timeout):
    d = tempfile.mkdtemp(prefix="mend-fuzz-")
    try:
        for p, content in files.items():
            full = os.path.join(d, p)
            parent = os.path.dirname(full)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(full, "w", encoding="utf-8", newline="") as f:
                f.write(content)
        try:
            r = subprocess.run(cmd + list(argv), cwd=d, input=stdin_bytes,
                               capture_output=True, timeout=timeout)
            timed_out = False
            exit_code, stdout = r.returncode, r.stdout
            crash = b"Traceback" in r.stderr
        except subprocess.TimeoutExpired:
            timed_out = True
            exit_code, stdout, crash = None, None, False
        final = {}
        if not timed_out:
            for dirpath, _dns, fns in os.walk(d):
                for fn in fns:
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, d).replace(os.sep, "/")
                    with open(full, "rb") as f:
                        final[rel] = f.read().decode(
                            "utf-8", errors="surrogateescape")
        return {"exit": exit_code, "stdout": None if stdout is None else
                stdout.decode("utf-8", errors="surrogateescape"),
                "files": final, "timeout": timed_out, "crash": crash}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def same(a, b):
    return a["exit"] == b["exit"] and a["stdout"] == b["stdout"] \
        and a["files"] == b["files"] and a["timeout"] == b["timeout"]


def minimize(ref_cmd, js_cmd, case, ref_res, js_res, timeout):
    """Greedy: drop each non-patch starting file; keep the drop if the
    divergence persists. Returns (case, ref_res, js_res)."""
    argv = case["argv"]
    pname = None
    for a in argv:
        if a and not a.startswith("-") and a != "--":
            pname = a
            break
    cur = dict(case)
    cur_files = dict(case["files"])
    for p in list(cur_files.keys()):
        if p == pname:
            continue
        trial = dict(cur_files)
        del trial[p]
        trial_case = dict(cur)
        trial_case["files"] = trial
        rr = run_impl(ref_cmd, argv, _stdin_bytes(trial_case), trial, timeout)
        jj = run_impl(js_cmd, argv, _stdin_bytes(trial_case), trial, timeout)
        if not same(rr, jj):
            cur_files = trial
            cur = trial_case
            ref_res, js_res = rr, jj
    cur["files"] = cur_files
    return cur, ref_res, js_res


def _stdin_bytes(case):
    s = case["stdin"]
    if s is None:
        return b""
    return s.encode("utf-8", errors="surrogateescape")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--cases", type=int, default=100)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--out", default="")
    ap.add_argument("--timeout", type=int, default=15)
    ap.add_argument("--no-minimize", action="store_true")
    args = ap.parse_args()
    ref_cmd = [sys.executable, args.ref]
    js_cmd = ["node", args.engine]
    outdir = args.out
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    total = 0
    divs = 0
    by_fmt = {}
    ref_crashes = 0
    timeouts = 0
    for idx in range(args.start, args.start + args.cases):
        rng = random.Random(args.seed * 1000003 + idx)
        case = gen_case(rng)
        total += 1
        by_fmt[case["format"]] = by_fmt.get(case["format"], 0) + 1
        stdin_b = _stdin_bytes(case)
        rr = run_impl(ref_cmd, case["argv"], stdin_b, case["files"], args.timeout)
        jj = run_impl(js_cmd, case["argv"], stdin_b, case["files"], args.timeout)
        if rr["crash"]:
            ref_crashes += 1
        if rr["timeout"] or jj["timeout"]:
            timeouts += 1
        if not same(rr, jj):
            divs += 1
            if not args.no_minimize:
                case, rr, jj = minimize(ref_cmd, js_cmd, case, rr, jj,
                                        args.timeout)
            repro = {"seed": args.seed, "case": idx, "format": case["format"],
                     "argv": case["argv"], "stdin": case["stdin"],
                     "files": case["files"], "ref": rr, "js": jj}
            if outdir:
                fn = os.path.join(outdir, "div-%d-%d.json" % (args.seed, idx))
                with open(fn, "w", encoding="utf-8") as f:
                    json.dump(repro, f, indent=1, sort_keys=True)
            print("DIVERGENCE seed=%d case=%d fmt=%s argv=%s" % (
                args.seed, idx, case["format"], case["argv"]), flush=True)
            print("  ref exit=%s stdout=%r" % (rr["exit"], rr["stdout"]), flush=True)
            print("  js  exit=%s stdout=%r" % (jj["exit"], jj["stdout"]), flush=True)
    print(json.dumps({"seed": args.seed, "start": args.start,
                      "cases": total, "divergences": divs,
                      "by_format": by_fmt, "ref_crashes": ref_crashes,
                      "timeouts": timeouts}))
    return 1 if divs else 0


if __name__ == "__main__":
    sys.exit(main())
