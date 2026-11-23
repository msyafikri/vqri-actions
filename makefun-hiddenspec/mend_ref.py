#!/usr/bin/env python3
"""mend: independent Python reference implementation, written from SPEC.md alone.

Implements SPEC.md sections 1-10 exactly: CLI parsing, exit codes/output,
safe paths, format detection, 3-tier matching, unified diffs, SEARCH/REPLACE,
V4A, JSON edits, atomicity. Standard library only.
"""

import json
import os
import re
import sys

_UNSET = object()


class ParseError(Exception):
    """error: parse <N>"""

    def __init__(self, line):
        super().__init__(line)
        self.line = line


class EditFail(Exception):
    """One edit failed with (code, path)."""

    def __init__(self, code, path):
        super().__init__(code, path)
        self.code = code
        self.path = path


# ---------------------------------------------------------------- files/lines

def split_patch_lines(text):
    """SPEC section 3: patch lines are text split at \\n, one trailing \\r
    removed from each, without the empty piece after a final \\n."""
    if text == "":
        return []
    parts = text.split("\n")
    if text.endswith("\n"):
        parts.pop()
    out = []
    for p in parts:
        if p.endswith("\r"):
            p = p[:-1]
        out.append(p)
    return out


def file_parts(text):
    """SPEC section 3: (lines, break, ends_with_break) of a file's text.

    The break is CRLF when the first line feed follows a carriage return,
    LF otherwise. An empty file has no lines and no trailing break.
    """
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


def join_file(lines, br, ends):
    """Write lines back with br between them, and a final br iff ends.
    A file of no lines is written empty."""
    if not lines:
        return ""
    s = br.join(lines)
    if ends:
        s += br
    return s


def is_safe(p):
    """SPEC section 3: a path is safe when not empty, not starting with '/',
"""
    if p == "":
        return False
    if p.startswith("/"):
        return False
    if "\\" in p:
        return False
    for seg in p.split("/"):
        if seg == "" or seg == "." or seg == "..":
            return False
    return True


# ---------------------------------------------------------------- matching

def line_eq(a, b, tier):
    if tier == 0:
        return a == b
    if tier == 1:
        return a.rstrip(" \t") == b.rstrip(" \t")
    return a.strip(" \t") == b.strip(" \t")


def occurrences(lines, old, tier, start=0):
    """0-based start positions where old matches lines[start:] at tier."""
    out = []
    n = len(old)
    if n == 0:
        return out
    for i in range(start, len(lines) - n + 1):
        ok = True
        for j in range(n):
            if not line_eq(lines[i + j], old[j], tier):
                ok = False
                break
        if ok:
            out.append(i)
    return out


def first_tier(lines, old, strict, start=0):
    """(tier, occurrences) at the first tier with at least one occurrence,
    or (None, []) when there is none. --strict tries tier 0 only."""
    tiers = [0] if strict else [0, 1, 2]
    for t in tiers:
        occ = occurrences(lines, old, t, start)
        if occ:
            return t, occ
    return None, []


def leading_ws(s):
    i = 0
    while i < len(s) and s[i] in " \t":
        i += 1
    return s[:i]


def map_new_lines(file_lines, pos, old, new, tier):
    """Build the replacement lines for N (list of (text, is_context, o_idx)).

    A context line is written as the file's own matched line. At tier 2
    every other non-empty, non-whitespace-only line starting with P (the
    leading spaces/tabs of old's first line) has that P replaced by F (the
    leading spaces/tabs of the file's first matched line)."""
    out = []
    if tier == 2 and old:
        f = leading_ws(file_lines[pos]) if pos < len(file_lines) else ""
        p = leading_ws(old[0])
    else:
        f = p = None
    for text, is_ctx, oi in new:
        if is_ctx:
            out.append(file_lines[pos + oi])
        elif tier == 2 and old:
            if text != "" and text.strip(" \t") != "" and text.startswith(p):
                out.append(f + text[len(p):])
            else:
                out.append(text)
        else:
            out.append(text)
    return out


# ---------------------------------------------------------------- CLI parsing

FORMATS = ("auto", "unified", "search-replace", "v4a", "json")


def parse_cli(argv):
    """Returns (format, check, strict, patch) or raises ParseError(0) for a
    usage error (reported as `error: usage`)."""
    fmt = "auto"
    check = False
    strict = False
    seen = set()
    positionals = []
    end_opts = False
    for arg in argv:
        if not end_opts and arg == "--":
            end_opts = True
            continue
        if not end_opts and arg.startswith("-") and arg != "-":
            if arg == "--check":
                if "check" in seen:
                    raise ParseError(0)
                seen.add("check")
                check = True
            elif arg == "--strict":
                if "strict" in seen:
                    raise ParseError(0)
                seen.add("strict")
                strict = True
            elif arg.startswith("--format="):
                if "format" in seen:
                    raise ParseError(0)
                seen.add("format")
                val = arg[len("--format="):]
                if val not in FORMATS:
                    raise ParseError(0)
                fmt = val
            else:
                raise ParseError(0)
        else:
            positionals.append(arg)
    if len(positionals) > 1:
        raise ParseError(0)
    patch = positionals[0] if positionals else None
    return fmt, check, strict, patch


# ---------------------------------------------------------------- detection

def detect_format(lines):
    """SPEC section 4. Returns a format name or None."""
    first = None
    for idx, line in enumerate(lines):
        if line.strip() != "":
            first = idx
            break
    if first is None:
        return None
    if lines[first].strip() == "*** Begin Patch":
        return "v4a"
    s = lines[first].lstrip()
    if s and s[0] in "[{":
        return "json"
    for line in lines:
        if line.rstrip() == "<<<<<<< SEARCH":
            return "search-replace"
    for idx, line in enumerate(lines):
        if line.startswith("diff --git "):
            return "unified"
        if line.startswith("--- ") and idx + 1 < len(lines) \
                and lines[idx + 1].startswith("+++ "):
            return "unified"
    return None


# ---------------------------------------------------------------- unified diffs

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
DIFF_PREFIX = "diff --git "


def parse_diff_git(line, lineno):
    rest = line[len(DIFF_PREFIX):]
    if not rest.startswith("a/"):
        raise ParseError(lineno)
    sep = rest.rfind(" b/")
    if sep < 0:
        raise ParseError(lineno)
    x = rest[2:sep]
    y = rest[sep + 3:]
    if x == "" or y == "":
        raise ParseError(lineno)
    return x, y


def header_path(line):
    """Path from a `--- ` / `+++ ` line: text after the four characters, up
    to the first tab, with surrounding spaces removed; /dev/null means no
    file; a leading a/ or b/ is removed. Returns None for no file."""
    t = line[4:]
    tab = t.find("\t")
    if tab >= 0:
        t = t[:tab]
    t = t.strip()
    if t == "/dev/null":
        return None
    if t.startswith("a/") or t.startswith("b/"):
        t = t[2:]
    return t


def build_hunk(a, body):
    """Body lines -> hunk dict. O is context + `-` lines, N is context +
    `+` lines in body order. no_nl: a `\\` line follows the hunk's last
    context or `+` line. plus_no_nl: a `\\` line follows its last `+` line."""
    last_cp = -1
    last_plus = -1
    for idx, line in enumerate(body):
        if line.startswith(" ") or line.startswith("+"):
            last_cp = idx
        if line.startswith("+"):
            last_plus = idx
    no_nl = (last_cp >= 0 and last_cp + 1 < len(body)
             and body[last_cp + 1].startswith("\\"))
    plus_no_nl = (last_plus >= 0 and last_plus + 1 < len(body)
                  and body[last_plus + 1].startswith("\\"))
    old = []
    new = []
    for line in body:
        if line.startswith(" "):
            t = line[1:]
            old.append(t)
            new.append((t, True, len(old) - 1))
        elif line.startswith("-"):
            old.append(line[1:])
        elif line.startswith("+"):
            new.append((line[1:], False, None))
        elif line == "":
            old.append("")
            new.append(("", True, len(old) - 1))
        # lines starting with `\` refer to the body line before them
    return {"A": a, "O": old, "N": new, "no_nl": no_nl,
            "plus_no_nl": plus_no_nl}


def _new_section():
    return {"old_pair": _UNSET, "new_pair": _UNSET,
            "old_rename": None, "new_rename": None,
            "old_diff": None, "new_diff": None,
            "new_file": False, "del_file": False, "hunks": []}


def parse_unified(lines):
    sections = []
    cur = None
    in_header = False
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.startswith(DIFF_PREFIX):
            x, y = parse_diff_git(line, i + 1)
            cur = _new_section()
            cur["old_diff"] = x
            cur["new_diff"] = y
            sections.append(cur)
            in_header = True
            i += 1
            continue
        if line.startswith("--- "):
            nxt = lines[i + 1] if i + 1 < n else None
            if nxt is not None and nxt.startswith("+++ "):
                if cur is None or (not in_header):
                    # a new section starts at this ---/+++ pair
                    cur = _new_section()
                    cur["old_pair"] = header_path(line)
                    cur["new_pair"] = header_path(nxt)
                    sections.append(cur)
                    in_header = True
                    i += 2
                    continue
                # a ---/+++ pair inside a section's header names the
                # section's paths; a later pair overwrites (last wins)
                cur["old_pair"] = header_path(line)
                cur["new_pair"] = header_path(nxt)
                i += 2
                continue
            if cur is not None and in_header:
                raise ParseError(i + 2)
            i += 1
            continue
        if line.startswith("@@"):
            if cur is None:
                raise ParseError(i + 1)
            m = HUNK_RE.match(line)
            if not m:
                raise ParseError(i + 1)
            a = int(m.group(1))
            j = i + 1
            body = []
            while j < n:
                l = lines[j]
                if l.startswith(DIFF_PREFIX):
                    break
                if l.startswith("--- ") and j + 1 < n \
                        and lines[j + 1].startswith("+++ "):
                    break
                if l == "" or l[0] in " +-\\":
                    body.append(l)
                    j += 1
                else:
                    break
            while body and body[-1] in ("", " "):
                # empty lines at the end of a body are not part of it:
                # a zero-length line, or a single space, is a context
                # line whose text is empty; "  " is a context line " "
                body.pop()
            cur["hunks"].append(build_hunk(a, body))
            in_header = False
            i = j
            continue
        if cur is not None and in_header:
            if line.startswith("+++ "):
                cur["new_pair"] = header_path(line)
            elif line.startswith("rename from "):
                cur["old_rename"] = line[len("rename from "):].strip()
            elif line.startswith("rename to "):
                cur["new_rename"] = line[len("rename to "):].strip()
            elif line.startswith("new file mode"):
                cur["new_file"] = True
            elif line.startswith("deleted file mode"):
                cur["del_file"] = True
            # index, old/new mode, similarity/dissimilarity, Index: and
            # any other header line are ignored
            i += 1
            continue
        i += 1
    if not sections:
        raise ParseError(1)
    return sections


def _resolve_paths(s):
    old = s["old_pair"] if s["old_pair"] is not _UNSET else (
        s["old_rename"] if s["old_rename"] is not None else s["old_diff"])
    new = s["new_pair"] if s["new_pair"] is not _UNSET else (
        s["new_rename"] if s["new_rename"] is not None else s["new_diff"])
    return old, new


def _classify_unified(s, old, new):
    if s["new_file"] or old is None:
        return "create"
    if s["del_file"] or new is None:
        return "delete"
    if old != new:
        return "move"
    return "change"


def apply_hunks(lines, br, ends, hunks, strict):
    """Apply hunks in order to (lines, ends). Returns (new_lines, new_ends).
    Raises EditFail('no-match', ...) with path filled in by the caller."""
    cur_lines = list(lines)
    cur_ends = ends
    d = 0
    for h in hunks:
        old = h["O"]
        new = h["N"]
        a = h["A"]
        if old:
            tier, occ = first_tier(cur_lines, old, strict)
            if tier is None:
                raise EditFail("no-match", "")
            target = a - 1 + d
            pos = min(occ, key=lambda p: (abs(p - target), p))
            mapped = map_new_lines(cur_lines, pos, old, new, tier)
            runs_end = (pos + len(old) == len(cur_lines))
            cur_lines = (cur_lines[:pos] + mapped
                         + cur_lines[pos + len(old):])
            if runs_end:
                cur_ends = not h["no_nl"]
        else:
            ip = a + d
            if ip < 0:
                ip = 0
            if ip > len(cur_lines):
                ip = len(cur_lines)
            at_end = (ip == len(cur_lines))
            mapped = [t for (t, _c, _o) in new]
            cur_lines = cur_lines[:ip] + mapped + cur_lines[ip:]
            if at_end:
                cur_ends = not h["no_nl"]
        d += len(new) - len(old)
    return cur_lines, cur_ends


def apply_unified(tree, sections, strict, moves):
    """Apply unified sections in order. Returns list of (code, path) failures."""
    failures = []
    for s in sections:
        old, new = _resolve_paths(s)
        kind = _classify_unified(s, old, new)
        if kind == "create":
            paths = [new]
        elif kind == "delete":
            paths = [old]
        elif kind == "move":
            paths = [old, new]
        else:
            paths = [old]
        fail = None
        for p in paths:
            if p is None or not is_safe(p):
                fail = ("unsafe", p if p is not None else "")
                break
        if fail is None:
            if kind == "create":
                if new in tree:
                    fail = ("exists", new)
            elif kind == "delete":
                if old not in tree:
                    fail = ("missing", old)
            elif kind == "move":
                if old not in tree:
                    fail = ("missing", old)
                elif new in tree:
                    fail = ("exists", new)
            else:
                if old not in tree:
                    fail = ("missing", old)
        if fail is not None:
            failures.append(fail)
            continue
        if kind == "create":
            plus = []
            plus_no_nl = False
            for h in s["hunks"]:
                for (t, is_ctx, _o) in h["N"]:
                    if not is_ctx:
                        plus.append(t)
                        plus_no_nl = h["plus_no_nl"]
            # plus_no_nl must come from the hunk holding the last + line:
            # recompute over hunks in order, keeping the last hunk that
            # actually contributed a + line.
            plus_no_nl = False
            for h in s["hunks"]:
                if any(not c for (_t, c, _o) in h["N"]):
                    plus_no_nl = h["plus_no_nl"]
            tree[new] = join_file(plus, "\n", bool(plus) and not plus_no_nl) \
                if plus else ""
            continue
        if kind == "delete":
            del tree[old]
            continue
        # move or change: apply hunks to the old file's lines
        lines, br, ends = file_parts(tree[old])
        try:
            new_lines, new_ends = apply_hunks(lines, br, ends, s["hunks"],
                                              strict)
        except EditFail:
            failures.append(("no-match", old))
            continue
        text = join_file(new_lines, br, new_ends)
        if kind == "move":
            tree[new] = text
            del tree[old]
            moves.append((old, new))
        else:
            tree[old] = text
    return failures


# ---------------------------------------------------------------- SEARCH/REPLACE

SEARCH_MARK = "<<<<<<< SEARCH"
SEP_MARK = "======="
REPLACE_MARK = ">>>>>>> REPLACE"


def parse_search_replace(lines):
    blocks = []
    prev_end = 0  # index just after the previous block's REPLACE line
    i = 0
    n = len(lines)
    while i < n:
        if lines[i].rstrip() != SEARCH_MARK:
            i += 1
            continue
        search_lineno = i + 1
        # path: nearest line before SEARCH, after prev_end, that is not
        # blank and does not start (stripped) with three backticks
        path = None
        for j in range(i - 1, prev_end - 1, -1):
            cand = lines[j]
            if cand.strip() == "":
                continue
            if cand.strip().startswith("```"):
                continue
            path = cand.strip()
            break
        if path is None:
            if blocks:
                path = blocks[-1]["path"]
            else:
                raise ParseError(search_lineno)
        # A SEARCH line is a parse error only when no `=======` and then
        # `>>>>>>> REPLACE` follow it (SPEC section 7). Marker-looking
        # lines inside the old/new lines are plain content: a REPLACE
        # before the first =======, or a SEARCH inside the block, does
        # not end or fault the block; the block runs to the first
        # ======= and then the first >>>>>>> REPLACE after it.
        sep = None
        k = i + 1
        while k < n:
            if lines[k].rstrip() == SEP_MARK:
                sep = k
                break
            k += 1
        if sep is None:
            raise ParseError(search_lineno)
        end = None
        k = sep + 1
        while k < n:
            if lines[k].rstrip() == REPLACE_MARK:
                end = k
                break
            k += 1
        if end is None:
            raise ParseError(search_lineno)
        blocks.append({"path": path, "old": lines[i + 1:sep],
                       "new": lines[sep + 1:end]})
        prev_end = end + 1
        i = end + 1
    if not blocks:
        raise ParseError(1)
    return blocks


def apply_search_replace(tree, blocks, strict):
    failures = []
    for b in blocks:
        path = b["path"]
        if not is_safe(path):
            failures.append(("unsafe", path))
            continue
        if not b["old"]:
            if path in tree:
                failures.append(("exists", path))
                continue
            tree[path] = join_file(list(b["new"]), "\n", True) \
                if b["new"] else ""
            continue
        if path not in tree:
            failures.append(("missing", path))
            continue
        lines, br, ends = file_parts(tree[path])
        tier, occ = first_tier(lines, b["old"], strict)
        if tier is None:
            failures.append(("no-match", path))
            continue
        if len(occ) > 1:
            failures.append(("ambiguous", path))
            continue
        pos = occ[0]
        new = [(t, False, None) for t in b["new"]]
        mapped = map_new_lines(lines, pos, b["old"], new, tier)
        tree[path] = join_file(lines[:pos] + mapped
                                + lines[pos + len(b["old"]):], br, ends)
    return failures


# ---------------------------------------------------------------- V4A

ADD_P = "*** Add File: "
DEL_P = "*** Delete File: "
UPD_P = "*** Update File: "
MOVE_P = "*** Move to: "
BEGIN_P = "*** Begin Patch"
END_P = "*** End Patch"


def _is_section_start(line):
    return (line.startswith(ADD_P) or line.startswith(DEL_P)
            or line.startswith(UPD_P))


def _close_chunk(chunks, cur):
    """Build O/N from the chunk's raw body lines. Trailing blank lines
    are NOT dropped here: SPEC section 8 drops blank lines at the end of
    a SECTION, so only the section's last chunk loses them (handled by
    trimming the section's raw lines before chunk parsing)."""
    body = list(cur["body"])
    old = []
    new = []
    for line in body:
        if line.startswith(" "):
            t = line[1:]
            old.append(t)
            new.append((t, True, len(old) - 1))
        elif line.startswith("-"):
            old.append(line[1:])
        elif line.startswith("+"):
            new.append((line[1:], False, None))
        elif line == "":
            old.append("")
            new.append(("", True, len(old) - 1))
    chunks.append({"anchor": cur["anchor"], "eof": cur["eof"],
                   "O": old, "N": new})


def parse_v4a(lines):
    first = None
    for idx, line in enumerate(lines):
        if line.strip() != "":
            first = idx
            break
    if first is None:
        raise ParseError(1)
    if lines[first].strip() != BEGIN_P:
        raise ParseError(first + 1)
    last = None
    for idx in range(len(lines) - 1, -1, -1):
        if lines[idx].strip() != "":
            last = idx
            break
    if lines[last].strip() != END_P:
        raise ParseError(len(lines) + 1)
    sections = []
    i = first + 1
    while i < last:
        line = lines[i]
        if line.strip() == "":
            i += 1
            continue
        if line.startswith(ADD_P):
            path = line[len(ADD_P):].strip()
            j = i + 1
            raw = []
            while j < last and not _is_section_start(lines[j]):
                raw.append(lines[j])
                j += 1
            while raw and raw[-1].strip() == "":
                raw.pop()
            flines = []
            for k, rl in enumerate(raw):
                if rl.startswith("+"):
                    flines.append(rl[1:])
                elif rl == "":
                    flines.append("")
                else:
                    raise ParseError(i + 2 + k)
            # trailing file lines that are blank (empty or only
            # whitespace) are not part of the file
            while flines and flines[-1].strip() == "":
                flines.pop()
            sections.append({"kind": "add", "path": path, "lines": flines})
            i = j
            continue
        if line.startswith(DEL_P):
            path = line[len(DEL_P):].strip()
            j = i + 1
            raw = []
            while j < last and not _is_section_start(lines[j]):
                raw.append(lines[j])
                j += 1
            while raw and raw[-1].strip() == "":
                raw.pop()
            for k, rl in enumerate(raw):
                if rl.strip() != "":
                    raise ParseError(i + 2 + k)
            sections.append({"kind": "delete", "path": path})
            i = j
            continue
        if line.startswith(UPD_P):
            path = line[len(UPD_P):].strip()
            j = i + 1
            move = None
            if j < last and lines[j].startswith(MOVE_P):
                move = lines[j][len(MOVE_P):].strip()
                j += 1
            # the section runs to the next section start or End Patch;
            # blank lines at its end are not part of it (section 8)
            sec_end = j
            while sec_end < last and not _is_section_start(lines[sec_end]):
                sec_end += 1
            end = sec_end
            while end > j and lines[end - 1].strip() == "":
                end -= 1
            chunks = []
            cur = None
            k = j
            while k < end:
                kl = lines[k]
                if kl == "*** End of File":
                    if cur is None:
                        raise ParseError(k + 1)
                    cur["eof"] = True
                    _close_chunk(chunks, cur)
                    cur = None
                    k += 1
                    continue
                if kl.startswith("@@"):
                    if cur is not None:
                        _close_chunk(chunks, cur)
                    anchor = kl[2:].strip()
                    cur = {"anchor": anchor if anchor else None,
                           "eof": False, "body": []}
                    k += 1
                    continue
                if kl.startswith(" ") or kl.startswith("-") \
                        or kl.startswith("+") or kl == "":
                    if cur is None:
                        cur = {"anchor": None, "eof": False, "body": []}
                    cur["body"].append(kl)
                    k += 1
                    continue
                raise ParseError(k + 1)
            if cur is not None:
                _close_chunk(chunks, cur)
                cur = None
            if not chunks and move is None:
                raise ParseError(i + 1)
            sections.append({"kind": "update", "path": path, "move": move,
                             "chunks": chunks})
            i = sec_end
            continue
        raise ParseError(i + 1)
    if not sections:
        raise ParseError(1)
    return sections


def _anchor_search(lines, anchor, strict, cursor):
    """First line at/after cursor equal to anchor at the first tier with
    one (single-line comparison). Returns the index or None."""
    tiers = [0] if strict else [0, 1, 2]
    for t in tiers:
        for idx in range(cursor, len(lines)):
            if line_eq(lines[idx], anchor, t):
                return idx
    return None


def apply_v4a(tree, sections, strict, moves):
    failures = []
    for s in sections:
        kind = s["kind"]
        if kind == "add":
            paths = [s["path"]]
        elif kind == "delete":
            paths = [s["path"]]
        else:
            paths = [s["path"]] + ([s["move"]] if s["move"] else [])
        fail = None
        for p in paths:
            if not is_safe(p):
                fail = ("unsafe", p)
                break
        if fail is None:
            if kind == "add":
                if s["path"] in tree:
                    fail = ("exists", s["path"])
            elif kind == "delete":
                if s["path"] not in tree:
                    fail = ("missing", s["path"])
            else:
                if s["path"] not in tree:
                    fail = ("missing", s["path"])
                elif s["move"] and s["move"] in tree:
                    fail = ("exists", s["move"])
        if fail is not None:
            failures.append(fail)
            continue
        if kind == "add":
            tree[s["path"]] = join_file(list(s["lines"]), "\n", True) \
                if s["lines"] else ""
            continue
        if kind == "delete":
            del tree[s["path"]]
            continue
        # update
        path = s["path"]
        lines, br, ends = file_parts(tree[path])
        cursor = 0
        failed = None
        for ch in s["chunks"]:
            if ch["anchor"] is not None:
                found = _anchor_search(lines, ch["anchor"], strict, cursor)
                if found is None:
                    failed = ("no-match", path)
                    break
                cursor = found + 1
            old = ch["O"]
            new = ch["N"]
            if ch["eof"]:
                if not old:
                    ip = len(lines)
                    mapped = [t for (t, _c, _o) in new]
                    lines = lines[:ip] + mapped + lines[ip:]
                    cursor = ip + len(mapped)
                else:
                    # end-of-file chunk: only occurrences ending at the
                    # file's last line count, so the tier is the first
                    # tier with such an occurrence (not the first tier
                    # with any occurrence)
                    tier = None
                    pos = None
                    for t in ([0] if strict else [0, 1, 2]):
                        occ = occurrences(lines, old, t, start=cursor)
                        cand = [p for p in occ
                                if p + len(old) == len(lines)]
                        if cand:
                            tier, pos = t, cand[0]
                            break
                    if tier is None:
                        failed = ("no-match", path)
                        break
                    mapped = map_new_lines(lines, pos, old, new, tier)
                    lines = lines[:pos] + mapped + lines[pos + len(old):]
                    cursor = pos + len(mapped)
            else:
                if not old:
                    ip = cursor
                    mapped = [t for (t, _c, _o) in new]
                    lines = lines[:ip] + mapped + lines[ip:]
                    cursor = ip + len(mapped)
                else:
                    tier, occ = first_tier(lines, old, strict, start=cursor)
                    if tier is None:
                        failed = ("no-match", path)
                        break
                    pos = occ[0]
                    mapped = map_new_lines(lines, pos, old, new, tier)
                    lines = lines[:pos] + mapped + lines[pos + len(old):]
                    cursor = pos + len(mapped)
        if failed is not None:
            failures.append(failed)
            continue
        text = join_file(lines, br, ends)
        if s["move"]:
            tree[s["move"]] = text
            del tree[path]
            moves.append((path, s["move"]))
        else:
            tree[path] = text
    return failures


# ---------------------------------------------------------------- JSON edits

def _validate_edit_object(obj):
    """Returns a normalised edit dict, or None for a parse fault."""
    if not isinstance(obj, dict):
        return None
    path = obj.get("path")
    cmd = obj.get("command")
    if not isinstance(path, str) or not isinstance(cmd, str):
        return None
    if cmd == "create":
        ft = obj.get("file_text")
        if not isinstance(ft, str):
            return None
        return {"command": "create", "path": path, "file_text": ft}
    if cmd == "str_replace":
        old = obj.get("old_str")
        if not isinstance(old, str) or old == "":
            return None
        new = obj.get("new_str", "")
        if not isinstance(new, str):
            return None
        return {"command": "str_replace", "path": path,
                "old_str": old, "new_str": new}
    if cmd == "insert":
        il = obj.get("insert_line")
        if isinstance(il, bool) or not isinstance(il, int):
            return None
        new = obj.get("new_str")
        if not isinstance(new, str):
            return None
        return {"command": "insert", "path": path,
                "insert_line": il, "new_str": new}
    return None


def parse_json_edits(lines, text):
    first = None
    for idx, line in enumerate(lines):
        if line.strip() != "":
            first = idx
            break
    if first is None:
        raise ParseError(1)
    if lines[first].lstrip().startswith("["):
        # array form: any fault is parse <line where the array starts>
        try:
            data = json.loads(text)
        except Exception:
            raise ParseError(first + 1)
        if not isinstance(data, list):
            raise ParseError(first + 1)
        edits = []
        for el in data:
            e = _validate_edit_object(el)
            if e is None:
                raise ParseError(first + 1)
            edits.append(e)
        if not edits:
            raise ParseError(1)
        return edits
    # JSON Lines form: one edit object a line, blank lines ignored
    edits = []
    for idx, line in enumerate(lines):
        if line.strip() == "":
            continue
        try:
            obj = json.loads(line)
        except Exception:
            raise ParseError(idx + 1)
        e = _validate_edit_object(obj)
        if e is None:
            raise ParseError(idx + 1)
        edits.append(e)
    if not edits:
        raise ParseError(1)
    return edits


def _count_overlapping(text, sub):
    n = 0
    start = 0
    while True:
        i = text.find(sub, start)
        if i < 0:
            return n
        n += 1
        start = i + 1


def _split_new_str(s):
    """SPEC section 9 insert: new_str's lines."""
    if s == "":
        return []
    parts = s.split("\n")
    if s.endswith("\n"):
        parts.pop()
    out = []
    for p in parts:
        if p.endswith("\r"):
            p = p[:-1]
        out.append(p)
    return out


def apply_json(tree, edits):
    failures = []
    for e in edits:
        path = e["path"]
        if not is_safe(path):
            failures.append(("unsafe", path))
            continue
        cmd = e["command"]
        if cmd == "create":
            if path in tree:
                failures.append(("exists", path))
                continue
            tree[path] = e["file_text"]
            continue
        if path not in tree:
            failures.append(("missing", path))
            continue
        if cmd == "str_replace":
            text = tree[path]
            _lines, br, _ends = file_parts(text)
            if br == "\r\n":
                norm_text = text.replace("\r\n", "\n")
                norm_old = e["old_str"].replace("\r\n", "\n")
                norm_new = e["new_str"].replace("\r\n", "\n")
                cnt = _count_overlapping(norm_text, norm_old)
                if cnt == 0:
                    failures.append(("no-match", path))
                    continue
                if cnt > 1:
                    failures.append(("ambiguous", path))
                    continue
                tree[path] = norm_text.replace(norm_old, norm_new, 1) \
                    .replace("\n", "\r\n")
            else:
                cnt = _count_overlapping(text, e["old_str"])
                if cnt == 0:
                    failures.append(("no-match", path))
                    continue
                if cnt > 1:
                    failures.append(("ambiguous", path))
                    continue
                tree[path] = text.replace(e["old_str"], e["new_str"], 1)
            continue
        # insert
        lines, br, ends = file_parts(tree[path])
        il = e["insert_line"]
        if il < 0 or il > len(lines):
            failures.append(("no-match", path))
            continue
        new_lines = _split_new_str(e["new_str"])
        tree[path] = join_file(lines[:il] + new_lines + lines[il:], br, ends)
    return failures


# ---------------------------------------------------------------- tree + main

def load_tree(root):
    tree = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            try:
                with open(full, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            tree[rel] = data.decode("utf-8", errors="surrogateescape")
    return tree


def write_tree(root, orig, final):
    for p in sorted(set(orig) | set(final)):
        full = os.path.join(root, p)
        if p in orig and p not in final:
            try:
                os.remove(full)
            except OSError:
                pass
        elif p not in orig or orig[p] != final[p]:
            d = os.path.dirname(full)
            if d:
                os.makedirs(d, exist_ok=True)
            with open(full, "wb") as f:
                f.write(final[p].encode("utf-8", errors="surrogateescape"))


def _bkey(s):
    return s.encode("utf-8", errors="surrogateescape")


def change_lines(orig, final, moves):
    """SPEC section 2 exit-0 lines, sorted by path bytes (R lines by new)."""
    removed = set()
    added = set()
    modified = set()
    for p in set(orig) | set(final):
        if p in orig and p not in final:
            removed.add(p)
        elif p not in orig and p in final:
            added.add(p)
        elif orig[p] != final[p]:
            modified.add(p)
    entries = []  # (sort_key, line)
    for p in removed:
        entries.append((_bkey(p), "D " + p))
    for p in added:
        entries.append((_bkey(p), "A " + p))
    for p in modified:
        entries.append((_bkey(p), "M " + p))
    for (o, n) in moves:
        if o in orig and o not in final and n not in orig and n in final:
            removed.discard(o)
            added.discard(n)
            entries = [e for e in entries
                       if e[1] not in ("D " + o, "A " + n)]
            entries.append((_bkey(n), "R " + o + " -> " + n))
    entries.sort(key=lambda e: e[0])
    lines = [e[1] for e in entries]
    n = len(lines)
    lines.append("ok: 1 file" if n == 1 else "ok: %d files" % n)
    return lines


def emit(out_lines):
    sys.stdout.buffer.write(
        "".join(l + "\n" for l in out_lines).encode(
            "utf-8", errors="surrogateescape"))
    sys.stdout.buffer.flush()


def main(argv):
    try:
        fmt, check, strict, patch = parse_cli(argv)
    except ParseError:
        emit(["error: usage"])
        return 2
    # read the patch (usage wins over everything)
    if patch is None or patch == "-":
        data = sys.stdin.buffer.read()
    else:
        try:
            with open(patch, "rb") as f:
                data = f.read()
        except OSError:
            emit(["error: no-patch"])
            return 2
    text = data.decode("utf-8", errors="surrogateescape")
    lines = split_patch_lines(text)
    if fmt == "auto":
        fmt = detect_format(lines)
        if fmt is None:
            emit(["error: format"])
            return 2
    try:
        if fmt == "unified":
            edits = parse_unified(lines)
        elif fmt == "search-replace":
            edits = parse_search_replace(lines)
        elif fmt == "v4a":
            edits = parse_v4a(lines)
        else:  # json
            edits = parse_json_edits(lines, text)
    except ParseError as e:
        emit(["error: parse %d" % e.line])
        return 2
    root = os.getcwd()
    orig = load_tree(root)
    tree = dict(orig)
    moves = []
    if fmt == "unified":
        failures = apply_unified(tree, edits, strict, moves)
    elif fmt == "search-replace":
        failures = apply_search_replace(tree, edits, strict)
    elif fmt == "v4a":
        failures = apply_v4a(tree, edits, strict, moves)
    else:
        failures = apply_json(tree, edits)
    if failures:
        out = ["error: %s %s" % (c, p) for (c, p) in failures]
        out.append("failed: %d of %d edits" % (len(failures), len(edits)))
        emit(out)
        return 1
    out = change_lines(orig, tree, moves)
    emit(out)
    if not check:
        write_tree(root, orig, tree)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
