#!/usr/bin/env python3
"""Vector tests for seed_solver:
- SLIP-0010 published test vectors 1 & 2 (full chains) via --derive-seed
- BIP39 published vectors: checksum, seed (incl. "TREZOR" passphrase vector),
  and Solana addresses cross-checked C vs independent Python oracle.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xcheck

BIN = Path(__file__).resolve().parent.parent / "seed_solver"

def run(*args, expect=0):
    r = subprocess.run([str(BIN), *args], capture_output=True, text=True)
    assert r.returncode == expect, f"{args}: rc={r.returncode}\n{r.stdout}\n{r.stderr}"
    return r.stdout

def derive_seed(seedhex, path):
    out = run("--derive-seed", seedhex, "--path", path)
    d = {}
    for line in out.strip().splitlines():
        k, v = line.split()
        d[k] = v
    return d

def main():
    xcheck.self_test()

    # ---- SLIP-0010 vector 1 (ed25519) ----
    s1 = "000102030405060708090a0b0c0d0e0f"
    v1 = [
        ("", "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
         "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
         "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed"),
        ("0'", "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
         "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69",
         "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c"),
        ("0'/1'", "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
         "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14",
         "1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187"),
        ("0'/1'/2'", "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
         "2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c",
         "ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1"),
        ("0'/1'/2'/2'", "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662",
         "8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc",
         "8abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c"),
        ("0'/1'/2'/2'/1000000000'", "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
         "68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230",
         "3c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a"),
    ]
    for path, priv, chain, pub in v1:
        d = derive_seed(s1, path)
        assert d == {"priv": priv, "chain": chain, "pub": pub}, (path, d)
    print("SLIP-0010 vector 1 (6 chains): PASS")

    # ---- SLIP-0010 vector 2 (ed25519) ----
    s2 = ("fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a"
          "29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542")
    v2 = [
        ("", "171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012",
         "ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b",
         "8fe9693f8fa62a4305a140b9764c5ee01e455963744fe18204b4fb948249308a"),
        ("0'", "1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635",
         "0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d",
         "86fab68dcb57aa196c77c5f264f215a112c22a912c10d123b0d03c3c28ef1037"),
        ("0'/2147483647'", "ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4",
         "138f0b2551bcafeca6ff2aa88ba8ed0ed8de070841f0c4ef0165df8181eaad7f",
         "5ba3b9ac6e90e83effcd25ac4e58a1365a9e35a3d3ae5eb07b9e4d90bcf7506d"),
        ("0'/2147483647'/1'", "3757c7577170179c7868353ada796c839135b3d30554bbb74a4b1e4a5a58505c",
         "73bd9fff1cfbde33a1b846c27085f711c0fe2d66fd32e139d3ebc28e5a4a6b90",
         "2e66aa57069c86cc18249aecf5cb5a9cebbfd6fadeab056254763874a9352b45"),
        ("0'/2147483647'/1'/2147483646'", "5837736c89570de861ebc173b1086da4f505d4adb387c6a1b1342d5e4ac9ec72",
         "0902fe8a29f9140480a00ef244bd183e8a13288e4412d8389d140aac1794825a",
         "e33c0f7d81d843c572275f287498e8d408654fdf0d1e065b84e2e6f157aab09b"),
        ("0'/2147483647'/1'/2147483646'/2'", "551d333177df541ad876a60ea71f00447931c0a9da16f227c11ea080d7391b8d",
         "5d70af781f3a37b829f0d060924d5e960bdc02e85423494afc0b1a41bbe196d4",
         "47150c75db263559a70d5778bf36abbab30fb061ad69f69ece61a72b0cfa4fc0"),
    ]
    for path, priv, chain, pub in v2:
        d = derive_seed(s2, path)
        assert d == {"priv": priv, "chain": chain, "pub": pub}, (path, d)
    print("SLIP-0010 vector 2 (6 chains): PASS")

    # both pubkey backends must agree
    d = derive_seed(s1, "0'/1'")
    out = run("--derive-seed", s1, "--path", "0'/1'", "--pubimpl", "evp")
    d2 = dict(line.split() for line in out.strip().splitlines())
    assert d == d2, (d, d2)
    print("pubkey backends (sodium vs OpenSSL EVP) agree: PASS")

    # ---- BIP39 vectors: checksum + seed + addresses, C vs oracle ----
    cases = [
        (bytes(16), " ".join(["abandon"] * 11 + ["about"])),
        (bytes([0x7F] * 16), "legal winner thank year wave sausage worth useful legal winner thank yellow"),
        (bytes([0x80] * 16), "letter advice cage absurd amount doctor acoustic avoid letter advice cage above"),
        (bytes([0xFF] * 16), " ".join(["zoo"] * 11 + ["wrong"])),
        (bytes(32), None),            # 24 words, cross-impl only
        (bytes([0xFF] * 32), None),   # 24 words, cross-impl only
        (bytes([0x9F] * 16), None),
    ]
    paths_spec = "44'/501'/0'/0';44'/501'/0';44'/501'/0'/0'/0'"
    path_tuples = [(44, 501, 0, 0), (44, 501, 0), (44, 501, 0, 0, 0)]
    for ent, expect_mn in cases:
        mn = xcheck.mnemonic_from_entropy(ent)
        if expect_mn is not None:
            assert mn == expect_mn, (ent.hex(), mn)
        assert xcheck.mnemonic_valid(mn)
        out = run("--check", "--words", mn)
        assert out.strip() == "VALID", (mn, out)
        out = run("--derive", "--words", mn, "--print-seed", "--paths", paths_spec)
        lines = out.strip().splitlines()
        seed_line = [l for l in lines if l.startswith("seed ")][0]
        assert seed_line.split()[1] == xcheck.seed_from_mnemonic(mn).hex(), mn
        addr_lines = [l for l in lines if not l.startswith("seed ")]
        assert len(addr_lines) == 3
        for line, pt in zip(addr_lines, path_tuples):
            label, addr = line.rsplit(" ", 1)
            assert addr == xcheck.solana_address(mn, pt), (mn, pt, addr)
    print("BIP39 vectors (7 entropies, checksum+seed+3 paths, C vs oracle): PASS")

    # published seed for the TREZOR-passphrase vector, through the C binary
    mn0 = " ".join(["abandon"] * 11 + ["about"])
    out = run("--derive", "--words", mn0, "--print-seed", "--passphrase", "TREZOR")
    seed_line = [l for l in out.strip().splitlines() if l.startswith("seed ")][0]
    assert seed_line.split()[1] == ("c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553"
                                    "1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04")
    # published no-passphrase seed for the same mnemonic
    out = run("--derive", "--words", mn0, "--print-seed")
    seed_line = [l for l in out.strip().splitlines() if l.startswith("seed ")][0]
    assert seed_line.split()[1] == ("5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1"
                                    "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4")
    print("BIP39 published seeds (TREZOR + empty passphrase): PASS")

    # corrupted ordering must be INVALID
    bad = "zoo " + " ".join(["abandon"] * 11)
    r = subprocess.run([str(BIN), "--check", "--words", bad],
                       capture_output=True, text=True)
    assert r.returncode == 1 and r.stdout.strip() == "INVALID", r.stdout
    print("checksum rejection of invalid ordering: PASS")

    print("ALL VECTOR TESTS PASS")

if __name__ == "__main__":
    main()
