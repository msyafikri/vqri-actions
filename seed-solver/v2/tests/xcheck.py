#!/usr/bin/env python3
"""Independent oracle for seed_solver tests.

Pure-Python BIP39 + SLIP-0010 ed25519 + RFC 8032 implementation, written
independently of the C solver. Before any test trusts it, self_test()
checks it against the *published* SLIP-0010 test vector 1 values and the
published BIP39 vector (entropy 0x00*16, passphrase "TREZOR").
"""
import hashlib
import hmac as hmac_mod
import re
import sys
from pathlib import Path

WORDS_H = Path(__file__).resolve().parent.parent / "src" / "words.h"
WORDLIST = re.findall(r'"([a-z]+)"', WORDS_H.read_text())
assert len(WORDLIST) == 2048, len(WORDLIST)
WIDX = {w: i for i, w in enumerate(WORDLIST)}

# ---------------- BIP39 ----------------

def mnemonic_from_entropy(ent: bytes) -> str:
    cs = len(ent) * 8 // 32
    h = hashlib.sha256(ent).digest()
    bits = int.from_bytes(ent, "big") << cs | (h[0] >> (8 - cs))
    n = (len(ent) * 8 + cs) // 11
    words = []
    for i in range(n):
        words.append(WORDLIST[(bits >> (11 * (n - 1 - i))) & 0x7FF])
    return " ".join(words)

def mnemonic_valid(mn: str) -> bool:
    ws = mn.split()
    if len(ws) not in (12, 15, 18, 21, 24):
        return False
    try:
        idx = [WIDX[w] for w in ws]
    except KeyError:
        return False
    total = 11 * len(ws)
    cs = total // 33
    ent_bits = total - cs
    v = 0
    for i in idx:
        v = (v << 11) | i
    ent = (v >> cs).to_bytes(ent_bits // 8, "big")
    want = v & ((1 << cs) - 1)
    got = hashlib.sha256(ent).digest()[0] >> (8 - cs)
    return want == got

def seed_from_mnemonic(mn: str, passphrase: str = "") -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha512", mn.encode(), ("mnemonic" + passphrase).encode(), 2048, 64)

# ---------------- ed25519 (RFC 8032, affine, slow but exact) ----------------
_q = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493

def _inv(x):
    return pow(x, _q - 2, _q)

_d = (-121665 * _inv(121666)) % _q
_I = pow(2, (_q - 1) // 4, _q)

def _xrecover(y):
    xx = (y * y - 1) * _inv(_d * y * y + 1) % _q
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = (x * _I) % _q
    if x % 2 != 0:
        x = _q - x
    return x

_By = 4 * _inv(5) % _q
_B = (_xrecover(_By), _By)

def _padd(P, Q):
    x1, y1 = P
    x2, y2 = Q
    t = _d * x1 * x2 * y1 * y2 % _q
    return ((x1 * y2 + x2 * y1) * _inv(1 + t) % _q,
            (y1 * y2 + x1 * x2) * _inv(1 - t) % _q)

def _pmul(P, e):
    R = (0, 1)
    while e:
        if e & 1:
            R = _padd(R, P)
        P = _padd(P, P)
        e >>= 1
    return R

def rfc8032_pubkey(seed32: bytes) -> bytes:
    h = bytearray(hashlib.sha512(seed32).digest()[:32])
    h[0] &= 248
    h[31] &= 63
    h[31] |= 64
    x, y = _pmul(_B, int.from_bytes(h, "little"))
    b = bytearray(y.to_bytes(32, "little"))
    b[31] |= (x & 1) << 7
    return bytes(b)

# ---------------- SLIP-0010 ----------------

def slip10_master(seed: bytes):
    I = hmac_mod.new(b"ed25519 seed", seed, hashlib.sha512).digest()
    return I[:32], I[32:]

def slip10_child(k: bytes, c: bytes, index: int):
    data = b"\x00" + k + (index + 0x80000000).to_bytes(4, "big")
    I = hmac_mod.new(c, data, hashlib.sha512).digest()
    return I[:32], I[32:]

def slip10_derive(seed: bytes, path):
    k, c = slip10_master(seed)
    for i in path:
        k, c = slip10_child(k, c, i)
    return k, c

# ---------------- base58 ----------------
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def base58_encode(b: bytes) -> str:
    zeros = len(b) - len(b.lstrip(b"\x00"))
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    return "1" * zeros + s

def solana_address(mn: str, path=(44, 501, 0, 0), passphrase: str = "") -> str:
    seed = seed_from_mnemonic(mn, passphrase)
    k, _ = slip10_derive(seed, list(path))
    return base58_encode(rfc8032_pubkey(k))

# ---------------- self-test against published vectors ----------------

def self_test():
    # SLIP-0010 test vector 1 (seed 000102...0f), from the SLIP-0010 spec
    seed = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
    k, c = slip10_master(seed)
    assert k.hex() == "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7", k.hex()
    assert c.hex() == "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb", c.hex()
    assert rfc8032_pubkey(k).hex() == "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed"
    k2, c2 = slip10_child(k, c, 0)
    assert k2.hex() == "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3", k2.hex()
    assert c2.hex() == "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69", c2.hex()
    assert rfc8032_pubkey(k2).hex() == "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c"
    # RFC 8032 test vector 1
    assert rfc8032_pubkey(bytes.fromhex(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    ).hex() == "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    # BIP39 published vector: entropy 0x00*16, passphrase "TREZOR"
    mn = mnemonic_from_entropy(bytes(16))
    assert mn == " ".join(["abandon"] * 11 + ["about"]), mn
    sd = seed_from_mnemonic(mn, "TREZOR")
    assert sd.hex() == ("c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553"
                        "1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"), sd.hex()
    print("xcheck self-test: PASS (oracle matches published SLIP-0010 + BIP39 + RFC8032 vectors)")

if __name__ == "__main__":
    self_test()
