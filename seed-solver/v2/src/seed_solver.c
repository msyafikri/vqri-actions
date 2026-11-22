/*
 * seed_solver.c — BIP39 word-order puzzle solver (Solana / SLIP-0010 ed25519).
 *
 * Given the shuffled words of a BIP39 mnemonic (12/15/18/21/24 words) and one
 * or more target Solana addresses, find the word ordering whose derived
 * address matches a target.
 *
 * Pipeline (the ordering is the whole point):
 *   1. Enumerate distinct permutations of the word multiset in lexicographic
 *      order (factorial-rank sharding: every shard is a contiguous rank
 *      range, so shards are disjoint and their union is the full space).
 *   2. CHEAP FILTER FIRST: rebuild the entropy from the word indices and
 *      verify the BIP39 checksum (SHA-256, 4 bits @12 words, 8 @24).
 *      Only ~1/2^cs of candidates survive.
 *   3. Survivors only: PBKDF2-HMAC-SHA512 (2048 iters) -> SLIP-0010 ed25519
 *      derivation along configurable all-hardened paths (default Phantom
 *      44'/501'/0'/0') -> RFC 8032 public key -> compare raw 32 bytes
 *      against the target set.
 *
 * Modes:
 *   solve (default)   search a rank range / shard for a target match
 *   --derive          print seed + address(es) for one exact word ordering
 *   --check           print VALID / INVALID for one exact word ordering
 *   --derive-seed     SLIP-0010 derive from a raw hex seed (test vectors)
 *   --rank            print the lexicographic rank of an exact ordering
 *   --dump            print every permutation in range (coverage tests)
 *   --bench-checksum S / --bench-full S   stage benchmarks (seconds)
 *
 * On match (solve): prints "MATCH <base58> <path> <words...>" to stdout and
 * exits 0 immediately (unless --continue). Exit 1 = range exhausted, no
 * match. Exit 2 = usage / input error. Progress goes to stderr every ~10 s.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include <openssl/sha.h>
#include <openssl/evp.h>

#include "words.h"
#include "sha512x.h"

#ifdef HAVE_SODIUM
/* libsodium: deterministic Ed25519 keypair from a 32-byte seed (RFC 8032). */
extern int crypto_sign_seed_keypair(unsigned char *pk, unsigned char *sk,
                                    const unsigned char *seed);
#endif

typedef unsigned __int128 u128;

#define MAXN 24          /* max words */
#define MAXPATHS 16
#define MAXPATHLEN 8
#define MAXTARGETS 64

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */
static double now_sec(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void u128_to_str(u128 v, char *out)
{
    char tmp[48];
    int n = 0;
    if (v == 0) { strcpy(out, "0"); return; }
    while (v > 0) { tmp[n++] = (char)('0' + (int)(v % 10)); v /= 10; }
    int i = 0;
    while (n > 0) out[i++] = tmp[--n];
    out[i] = '\0';
}

static int str_to_u128(const char *s, u128 *out)
{
    u128 v = 0;
    if (!*s) return -1;
    for (const char *p = s; *p; p++) {
        if (*p < '0' || *p > '9') return -1;
        v = v * 10 + (u128)(*p - '0');
    }
    *out = v;
    return 0;
}

static void hex_encode(const uint8_t *in, size_t len, char *out)
{
    static const char H[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2*i] = H[in[i] >> 4];
        out[2*i+1] = H[in[i] & 15];
    }
    out[2*len] = '\0';
}

static int hex_decode(const char *s, uint8_t *out, size_t maxlen, size_t *outlen)
{
    size_t n = strlen(s);
    if (n % 2 || n / 2 > maxlen) return -1;
    for (size_t i = 0; i < n / 2; i++) {
        int hi, lo;
        char a = s[2*i], b = s[2*i+1];
        hi = (a >= '0' && a <= '9') ? a - '0' : (a >= 'a' && a <= 'f') ? a - 'a' + 10 : (a >= 'A' && a <= 'F') ? a - 'A' + 10 : -1;
        lo = (b >= '0' && b <= '9') ? b - '0' : (b >= 'a' && b <= 'f') ? b - 'a' + 10 : (b >= 'A' && b <= 'F') ? b - 'A' + 10 : -1;
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    *outlen = n / 2;
    return 0;
}

/* ------------------------------------------------------------------ */
/* base58 (Bitcoin alphabet)                                           */
/* ------------------------------------------------------------------ */
static const char B58_ALPHABET[] =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

static void base58_encode(const uint8_t *in, size_t len, char *out)
{
    size_t zeros = 0;
    while (zeros < len && in[zeros] == 0) zeros++;
    uint8_t digits[64];
    size_t dlen = 0;
    for (size_t i = zeros; i < len; i++) {
        int carry = in[i];
        for (size_t j = 0; j < dlen; j++) {
            carry += digits[j] << 8;
            digits[j] = (uint8_t)(carry % 58);
            carry /= 58;
        }
        while (carry) { digits[dlen++] = (uint8_t)(carry % 58); carry /= 58; }
    }
    char *p = out;
    for (size_t i = 0; i < zeros; i++) *p++ = '1';
    for (size_t i = dlen; i-- > 0;) *p++ = B58_ALPHABET[digits[i]];
    *p = '\0';
}

static int b58_value(char ch)
{
    const char *p = strchr(B58_ALPHABET, ch);
    return p ? (int)(p - B58_ALPHABET) : -1;
}

static int base58_decode_32(const char *s, uint8_t out[32])
{
    size_t zeros = 0;
    while (s[zeros] == '1') zeros++;
    uint8_t bytes[64];
    size_t blen = 0;
    for (size_t i = zeros; s[i] != '\0'; i++) {
        int v = b58_value(s[i]);
        if (v < 0) return -1;
        int carry = v;
        for (size_t j = 0; j < blen; j++) {
            carry += bytes[j] * 58;
            bytes[j] = (uint8_t)(carry & 0xff);
            carry >>= 8;
        }
        while (carry) {
            if (blen >= sizeof(bytes)) return -1;
            bytes[blen++] = (uint8_t)(carry & 0xff);
            carry >>= 8;
        }
    }
    if (zeros + blen != 32) return -1;
    memset(out, 0, 32);
    for (size_t i = 0; i < blen; i++) out[zeros + i] = bytes[blen - 1 - i];
    return 0;
}

/* ------------------------------------------------------------------ */
/* BIP39 word helpers                                                  */
/* ------------------------------------------------------------------ */
static uint8_t g_wlen[2048];

static int word_index(const char *w)
{
    for (int i = 0; i < 2048; i++)
        if (strcmp(w, BIP39_WORDS[i]) == 0) return i;
    return -1;
}

/* checksum parameters for n words: total bits 11n, cs = 11n/33 */
static int bip39_checksum_valid_n(const uint16_t *idx, int n)
{
    int total_bits = 11 * n;
    int cs = total_bits / 33;
    int ent_bytes = (total_bits - cs) / 8;
    uint8_t ent[32];
    uint32_t acc = 0;
    int nbits = 0, out = 0;
    for (int i = 0; i < n; i++) {
        acc = (acc << 11) | idx[i];
        nbits += 11;
        while (nbits >= 8 && out < ent_bytes) {
            nbits -= 8;
            ent[out++] = (uint8_t)((acc >> nbits) & 0xff);
        }
    }
    /* the low cs bits of acc are the claimed checksum */
    uint8_t want = (uint8_t)(acc & ((1u << cs) - 1u));
    uint8_t digest[SHA256_DIGEST_LENGTH];
    SHA256(ent, (size_t)ent_bytes, digest);
    return (digest[0] >> (8 - cs)) == want;
}

static void phrase_from_indices(const uint16_t *idx, int n, char *out)
{
    size_t pos = 0;
    for (int i = 0; i < n; i++) {
        const char *w = BIP39_WORDS[idx[i]];
        size_t wl = g_wlen[idx[i]];
        memcpy(out + pos, w, wl);
        pos += wl;
        if (i + 1 < n) out[pos++] = ' ';
    }
    out[pos] = '\0';
}

/* ------------------------------------------------------------------ */
/* factorial / multiset permutation machinery (ranks are u128)         */
/* ------------------------------------------------------------------ */
static u128 FACT[MAXN + 1];

static void fact_init(void)
{
    FACT[0] = 1;
    for (int i = 1; i <= MAXN; i++) FACT[i] = FACT[i - 1] * (u128)i;
}

/* distinct values (ascending) + counts, from a sorted array */
static int distinct_counts(const uint16_t *sorted, int n,
                           uint16_t *vals, int *counts)
{
    int d = 0;
    for (int i = 0; i < n; i++) {
        if (i == 0 || sorted[i] != sorted[i - 1]) {
            vals[d] = sorted[i];
            counts[d] = 1;
            d++;
        } else counts[d - 1]++;
    }
    return d;
}

/* multinomial: rem! / prod(counts!) — sequential division is exact */
static u128 multinomial(int rem, const int *counts, int d)
{
    u128 r = FACT[rem];
    for (int i = 0; i < d; i++) r /= FACT[counts[i]];
    return r;
}

static u128 total_perms(const uint16_t *sorted, int n)
{
    uint16_t vals[MAXN];
    int counts[MAXN];
    int d = distinct_counts(sorted, n, vals, counts);
    return multinomial(n, counts, d);
}

/* write the permutation of the multiset with the given lexicographic rank */
static void unrank(u128 rank, const uint16_t *sorted, int n, uint16_t *out)
{
    uint16_t vals[MAXN];
    int counts[MAXN];
    int d = distinct_counts(sorted, n, vals, counts);
    int rem = n;
    for (int pos = 0; pos < n; pos++) {
        for (int j = 0; j < d; j++) {
            if (counts[j] == 0) continue;
            counts[j]--;
            u128 block = multinomial(rem - 1, counts, d);
            if (rank < block) {
                out[pos] = vals[j];
                rem--;
                break;
            }
            rank -= block;
            counts[j]++;
        }
    }
}

/* lexicographic rank of an exact ordering within its own multiset */
static u128 rank_of(const uint16_t *perm, int n)
{
    uint16_t sorted[MAXN];
    memcpy(sorted, perm, (size_t)n * sizeof(uint16_t));
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            if (sorted[j] < sorted[i]) {
                uint16_t t = sorted[i]; sorted[i] = sorted[j]; sorted[j] = t;
            }
    uint16_t vals[MAXN];
    int counts[MAXN];
    int d = distinct_counts(sorted, n, vals, counts);
    u128 rank = 0;
    int rem = n;
    for (int pos = 0; pos < n; pos++) {
        for (int j = 0; j < d; j++) {
            if (vals[j] >= perm[pos]) break;
            if (counts[j] == 0) continue;
            counts[j]--;
            rank += multinomial(rem - 1, counts, d);
            counts[j]++;
        }
        for (int j = 0; j < d; j++)
            if (vals[j] == perm[pos]) { counts[j]--; break; }
        rem--;
    }
    return rank;
}

static int next_perm(uint16_t *a, int n)
{
    int i = n - 2;
    while (i >= 0 && a[i] >= a[i + 1]) i--;
    if (i < 0) return 0;
    int j = n - 1;
    while (a[j] <= a[i]) j--;
    uint16_t t = a[i]; a[i] = a[j]; a[j] = t;
    for (int l = i + 1, r = n - 1; l < r; l++, r--) {
        t = a[l]; a[l] = a[r]; a[r] = t;
    }
    return 1;
}

/* ------------------------------------------------------------------ */
/* crypto: PBKDF2 seed, SLIP-0010 ed25519, RFC 8032 pubkey             */
/* ------------------------------------------------------------------ */
static void seed_from_phrase(const char *mnemonic, const char *salt,
                             int saltlen, uint8_t seed[64])
{
    /* v2: hand-rolled PBKDF2-HMAC-SHA512 (pad-state reuse), no OpenSSL */
    pbkdf2_sha512((const uint8_t *)mnemonic, strlen(mnemonic),
                  (const uint8_t *)salt, (size_t)saltlen, 2048, seed);
}

static void hmac512_oneshot(const uint8_t *key, size_t klen,
                            const uint8_t *data, size_t dlen, uint8_t out[64])
{
    hmac512_key(key, klen, data, dlen, out);
}

static void slip10_master(const uint8_t *seed, size_t seedlen,
                          uint8_t k[32], uint8_t c[32])
{
    uint8_t I[64];
    hmac512_oneshot((const uint8_t *)"ed25519 seed", 12, seed, seedlen, I);
    memcpy(k, I, 32);
    memcpy(c, I + 32, 32);
}

/* one hardened child step; in-place safe */
static void slip10_child(const uint8_t k[32], const uint8_t c[32],
                         uint32_t index, uint8_t kout[32], uint8_t cout[32])
{
    uint8_t data[37];
    data[0] = 0x00;
    memcpy(data + 1, k, 32);
    uint32_t v = index + 0x80000000u;
    data[33] = (uint8_t)(v >> 24);
    data[34] = (uint8_t)(v >> 16);
    data[35] = (uint8_t)(v >> 8);
    data[36] = (uint8_t)(v);
    uint8_t I[64];
    hmac512_oneshot(c, 32, data, sizeof(data), I);
    memcpy(kout, I, 32);
    memcpy(cout, I + 32, 32);
}

static int g_pubimpl = 0; /* 0 = OpenSSL EVP, 1 = libsodium */

static void ed25519_pubkey(const uint8_t kseed[32], uint8_t out[32])
{
#ifdef HAVE_SODIUM
    if (g_pubimpl == 1) {
        uint8_t sk[64];
        crypto_sign_seed_keypair(out, sk, kseed);
        return;
    }
#endif
    EVP_PKEY *pkey = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL,
                                                  kseed, 32);
    if (!pkey) { fprintf(stderr, "FATAL: EVP_PKEY_new_raw_private_key\n"); exit(2); }
    size_t len = 32;
    if (EVP_PKEY_get_raw_public_key(pkey, out, &len) != 1 || len != 32) {
        fprintf(stderr, "FATAL: EVP_PKEY_get_raw_public_key\n"); exit(2);
    }
    EVP_PKEY_free(pkey);
}

/* ------------------------------------------------------------------ */
/* derivation paths                                                    */
/* ------------------------------------------------------------------ */
typedef struct {
    uint32_t comp[MAXPATHLEN];
    int len;
    int raw; /* 1 = no derivation: ed25519 keypair from seed[0..32) directly
              * (solders / web3.js Keypair.fromSeed(seed[:32])) */
    char label[64];
} Path;

static Path g_paths[MAXPATHS];
static int g_npaths = 0;

static int parse_one_path(const char *s, Path *p)
{
    /* special token: "raw" = no derivation path at all */
    if (strcmp(s, "raw") == 0) {
        p->len = 0;
        p->raw = 1;
        snprintf(p->label, sizeof(p->label), "%s", s);
        return 0;
    }
    p->raw = 0;
    /* s like 44'/501'/0'/0' — every component must be hardened (') */
    char buf[64];
    size_t sl = strlen(s);
    if (sl == 0 || sl >= sizeof(buf)) return -1;
    memcpy(buf, s, sl + 1);
    p->len = 0;
    char *save = NULL;
    for (char *tok = strtok_r(buf, "/", &save); tok;
         tok = strtok_r(NULL, "/", &save)) {
        size_t tl = strlen(tok);
        if (tl < 2 || tok[tl - 1] != '\'') return -1; /* hardened only */
        tok[tl - 1] = '\0';
        char *end = NULL;
        long v = strtol(tok, &end, 10);
        if (!end || *end != '\0' || v < 0 || v >= 0x80000000L) return -1;
        if (p->len >= MAXPATHLEN) return -1;
        p->comp[p->len++] = (uint32_t)v;
    }
    if (p->len == 0) return -1;
    snprintf(p->label, sizeof(p->label), "%s", s);
    return 0;
}

static int parse_paths(const char *spec)
{
    /* paths separated by ';' */
    char buf[1024];
    size_t sl = strlen(spec);
    if (sl >= sizeof(buf)) return -1;
    memcpy(buf, spec, sl + 1);
    g_npaths = 0;
    char *save = NULL;
    for (char *tok = strtok_r(buf, ";", &save); tok;
         tok = strtok_r(NULL, ";", &save)) {
        if (g_npaths >= MAXPATHS) return -1;
        if (parse_one_path(tok, &g_paths[g_npaths]) != 0) return -1;
        g_npaths++;
    }
    return g_npaths > 0 ? 0 : -1;
}

/* derive the pubkey for one path from a 64-byte BIP39 seed */
static void derive_path_pubkey(const uint8_t seed[64], const Path *p,
                               uint8_t pub[32], uint8_t *kout, uint8_t *cout)
{
    uint8_t k[32], c[32];
    if (p->raw) {
        /* no SLIP-0010 at all: private key = first 32 bytes of the seed */
        memcpy(k, seed, 32);
        memset(c, 0, 32);
        ed25519_pubkey(k, pub);
        if (kout) memcpy(kout, k, 32);
        if (cout) memcpy(cout, c, 32);
        return;
    }
    slip10_master(seed, 64, k, c);
    for (int i = 0; i < p->len; i++)
        slip10_child(k, c, p->comp[i], k, c);
    ed25519_pubkey(k, pub);
    if (kout) memcpy(kout, k, 32);
    if (cout) memcpy(cout, c, 32);
}

/* ------------------------------------------------------------------ */
/* argument handling                                                   */
/* ------------------------------------------------------------------ */
static void usage(const char *prog)
{
    fprintf(stderr,
        "usage:\n"
        "  %s --words \"w1 ... wN\" --targets addr[,addr...] [options]\n"
        "  %s --derive --words \"w1 ... wN\" [--paths \"44'/501'/0'/0'\"] [--passphrase X] [--print-seed]\n"
        "  %s --check --words \"w1 ... wN\"\n"
        "  %s --derive-seed HEX --path \"0'/1'\"   (empty --path = master)\n"
        "  %s --rank --words \"w1 ... wN\"\n"
        "  %s --dump --words \"w1 ... wN\" [--shard-index i --shard-count n]\n"
        "  %s --bench-checksum SECS --words \"w1 ... wN\"\n"
        "  %s --bench-full SECS --words \"w1 ... wN\" [--paths ...]\n"
        "options: --words-file F --targets-file F --shard-index i --shard-count n\n"
        "         --start R --end R --max-seconds S --continue --pubimpl evp|sodium\n",
        prog, prog, prog, prog, prog, prog, prog, prog);
}

/* split a string of space-separated words into indices; returns count */
static int parse_words_str(const char *s, uint16_t *idx, int maxn)
{
    char buf[4096];
    size_t sl = strlen(s);
    if (sl >= sizeof(buf)) return -1;
    memcpy(buf, s, sl + 1);
    int n = 0;
    char *save = NULL;
    for (char *tok = strtok_r(buf, " \t\r\n", &save); tok;
         tok = strtok_r(NULL, " \t\r\n", &save)) {
        if (n >= maxn) return -1;
        int wi = word_index(tok);
        if (wi < 0) {
            fprintf(stderr, "unknown BIP39 word: %s\n", tok);
            return -1;
        }
        idx[n++] = (uint16_t)wi;
    }
    return n;
}

static char *read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0 || sz > (1 << 24)) { fclose(f); return NULL; }
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t rd = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[rd] = '\0';
    return buf;
}

static int valid_word_count(int n)
{
    return n == 12 || n == 15 || n == 18 || n == 21 || n == 24;
}

static int cmp_u16(const void *a, const void *b)
{
    return (int)*(const uint16_t *)a - (int)*(const uint16_t *)b;
}

/* ------------------------------------------------------------------ */
/* modes                                                               */
/* ------------------------------------------------------------------ */
static int mode_derive_seed(const char *seedhex, const char *pathspec)
{
    uint8_t seed[64];
    size_t seedlen = 0;
    if (hex_decode(seedhex, seed, sizeof(seed), &seedlen) != 0 ||
        seedlen < 16) {
        fprintf(stderr, "bad seed hex\n");
        return 2;
    }
    uint8_t k[32], c[32];
    slip10_master(seed, seedlen, k, c);
    if (pathspec && *pathspec) {
        Path p;
        if (parse_one_path(pathspec, &p) != 0) {
            fprintf(stderr, "bad path (hardened components only)\n");
            return 2;
        }
        for (int i = 0; i < p.len; i++)
            slip10_child(k, c, p.comp[i], k, c);
    }
    uint8_t pub[32];
    ed25519_pubkey(k, pub);
    char hex[129];
    hex_encode(k, 32, hex);   printf("priv %s\n", hex);
    hex_encode(c, 32, hex);   printf("chain %s\n", hex);
    hex_encode(pub, 32, hex); printf("pub %s\n", hex);
    return 0;
}

static int mode_derive(const uint16_t *idx, int n, const char *passphrase,
                       int print_seed)
{
    if (!bip39_checksum_valid_n(idx, n)) {
        printf("INVALID\n");
        return 1;
    }
    char phrase[1024], salt[1024];
    phrase_from_indices(idx, n, phrase);
    snprintf(salt, sizeof(salt), "mnemonic%s", passphrase);
    uint8_t seed[64];
    seed_from_phrase(phrase, salt, (int)strlen(salt), seed);
    if (print_seed) {
        char hex[129];
        hex_encode(seed, 64, hex);
        printf("seed %s\n", hex);
    }
    for (int i = 0; i < g_npaths; i++) {
        uint8_t pub[32];
        derive_path_pubkey(seed, &g_paths[i], pub, NULL, NULL);
        char addr[64];
        base58_encode(pub, 32, addr);
        printf("%s %s\n", g_paths[i].label, addr);
    }
    return 0;
}

/* shared range resolution: shard args or explicit start/end */
static int resolve_range(const uint16_t *sorted, int n,
                         long shard_index, long shard_count,
                         const char *start_s, const char *end_s,
                         u128 *start, u128 *end)
{
    u128 total = total_perms(sorted, n);
    u128 s = 0, e = total;
    if (start_s && str_to_u128(start_s, &s) != 0) return -1;
    if (end_s && str_to_u128(end_s, &e) != 0) return -1;
    if (shard_count > 1 || shard_index > 0) {
        if (shard_count < 1 || shard_index < 0 || shard_index >= shard_count)
            return -1;
        s = total * (u128)shard_index / (u128)shard_count;
        e = total * (u128)(shard_index + 1) / (u128)shard_count;
    }
    if (e > total) e = total;
    if (s > e) return -1;
    *start = s;
    *end = e;
    return 0;
}

static int mode_dump(const uint16_t *idx, int n,
                     long shard_index, long shard_count,
                     const char *start_s, const char *end_s)
{
    uint16_t sorted[MAXN];
    memcpy(sorted, idx, (size_t)n * sizeof(uint16_t));
    qsort(sorted, (size_t)n, sizeof(uint16_t), cmp_u16);
    u128 start, end;
    if (resolve_range(sorted, n, shard_index, shard_count,
                      start_s, end_s, &start, &end) != 0) {
        fprintf(stderr, "bad range\n");
        return 2;
    }
    uint16_t perm[MAXN];
    unrank(start, sorted, n, perm);
    char rs[48];
    for (u128 rank = start; rank < end; rank++) {
        u128_to_str(rank, rs);
        printf("PERM %s ", rs);
        for (int i = 0; i < n; i++) printf("%s%u", i ? "," : "", perm[i]);
        printf(" %d\n", bip39_checksum_valid_n(perm, n) ? 1 : 0);
        if (rank + 1 < end && !next_perm(perm, n)) break;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* v2 survivor batching: checksum survivors are collected LANES at a   */
/* time and run through the SIMD-batched PBKDF2 together; the SLIP-    */
/* 0010 + pubkey step stays scalar per candidate (it is ~2% of the     */
/* derive cost). Lanes beyond the real batch size duplicate lane 0.    */
/* ------------------------------------------------------------------ */
#define PHRASE_BUF 1024

typedef struct {
    char phrases[LANES][PHRASE_BUF];
    int count;
    const uint8_t *salt;
    int saltlen;
    int use_batch; /* batch PBKDF2 needs saltlen + 4 <= 111 */
} BatchCtx;

static void batch_init(BatchCtx *b, const char *salt, int saltlen)
{
    b->count = 0;
    b->salt = (const uint8_t *)salt;
    b->saltlen = saltlen;
    b->use_batch = saltlen <= 107;
}

static void batch_seeds(BatchCtx *b, uint8_t seeds[LANES][64])
{
    if (b->use_batch) {
        const uint8_t *pw[LANES];
        size_t pwl[LANES];
        for (int i = 0; i < LANES; i++) {
            int src = i < b->count ? i : 0;
            pw[i] = (const uint8_t *)b->phrases[src];
            pwl[i] = strlen(b->phrases[src]);
        }
        pbkdf2_batch(pw, pwl, b->salt, (size_t)b->saltlen, 2048, seeds);
    } else {
        for (int i = 0; i < LANES; i++) {
            int src = i < b->count ? i : 0;
            seed_from_phrase(b->phrases[src], (const char *)b->salt,
                             b->saltlen, seeds[i]);
        }
    }
    b->count = 0;
}

static int mode_solve(const uint16_t *idx, int n,
                      const uint8_t targets[][32], int ntargets,
                      const char *passphrase,
                      long shard_index, long shard_count,
                      const char *start_s, const char *end_s,
                      double max_seconds, int keep_going)
{
    uint16_t sorted[MAXN];
    memcpy(sorted, idx, (size_t)n * sizeof(uint16_t));
    qsort(sorted, (size_t)n, sizeof(uint16_t), cmp_u16);
    u128 start, end;
    if (resolve_range(sorted, n, shard_index, shard_count,
                      start_s, end_s, &start, &end) != 0) {
        fprintf(stderr, "bad range / shard args\n");
        return 2;
    }
    char sbuf[48], ebuf[48], tbuf[48];
    u128_to_str(start, sbuf);
    u128_to_str(end, ebuf);
    u128_to_str(total_perms(sorted, n), tbuf);
    fprintf(stderr,
            "[solve] v2 (lanes=%d) shard %ld/%ld ranks [%s, %s) of %s total perms, %d target(s), %d path(s)\n",
            LANES, shard_index, shard_count, sbuf, ebuf, tbuf, ntargets, g_npaths);

    char salt[1024];
    snprintf(salt, sizeof(salt), "mnemonic%s", passphrase);
    int saltlen = (int)strlen(salt);

    uint16_t perm[MAXN];
    unrank(start, sorted, n, perm);

    uint64_t done = 0, valid = 0, matches = 0;
    double t_begin = now_sec(), t_last = t_begin;
    double acc_check = 0.0, acc_derive = 0.0;
    u128 span = end - start;
    int stop = 0;

    BatchCtx batch;
    batch_init(&batch, salt, saltlen);
    uint8_t seeds[LANES][64];

    for (u128 rank = start; rank < end && !stop; rank++) {
        double t0 = now_sec();
        int ok = bip39_checksum_valid_n(perm, n);
        double t1 = now_sec();
        acc_check += t1 - t0;
        if (ok) {
            valid++;
            phrase_from_indices(perm, n, batch.phrases[batch.count]);
            batch.count++;
            if (batch.count == LANES) {
                double d0 = now_sec();
                int nb = batch.count;
                batch_seeds(&batch, seeds);
                for (int li = 0; li < nb; li++) {
                    int hit = 0;
                    for (int p = 0; p < g_npaths; p++) {
                        if (hit && !keep_going) break;
                        uint8_t pub[32];
                        derive_path_pubkey(seeds[li], &g_paths[p], pub,
                                           NULL, NULL);
                        for (int t = 0; t < ntargets; t++) {
                            if (memcmp(pub, targets[t], 32) == 0) {
                                char addr[64];
                                base58_encode(pub, 32, addr);
                                printf("MATCH %s %s %s\n", addr,
                                       g_paths[p].label, batch.phrases[li]);
                                fflush(stdout);
                                matches++;
                                hit = 1;
                                break;
                            }
                        }
                    }
                    if (hit && !keep_going) { stop = 1; break; }
                }
                acc_derive += now_sec() - d0;
                if (stop) {
                    fprintf(stderr, "[solve] match found, stopping\n");
                    break;
                }
            }
        }
        done++;
        if (rank + 1 < end && !next_perm(perm, n)) break;
        double tnow = now_sec();
        if (tnow - t_last >= 10.0) {
            double el = tnow - t_begin;
            double pct = span > 0 ? 100.0 * (double)done / (double)span : 100.0;
            double rate = el > 0 ? done / el : 0;
            double eta = rate > 0 ? (double)(span - done) / rate : 0;
            fprintf(stderr,
                    "[solve] %.1f%% done=%llu valid=%llu rate=%.0f/s eta=%.0fs\n",
                    pct, (unsigned long long)done,
                    (unsigned long long)valid, rate, eta);
            t_last = tnow;
        }
        if (max_seconds > 0 && tnow - t_begin >= max_seconds) {
            fprintf(stderr, "[solve] max-seconds reached, stopping\n");
            break;
        }
    }
    /* flush the tail batch (unless we already stopped on a match) */
    if (!stop && batch.count > 0) {
        double d0 = now_sec();
        int nb = batch.count;
        batch_seeds(&batch, seeds);
        for (int li = 0; li < nb; li++) {
            int hit = 0;
            for (int p = 0; p < g_npaths; p++) {
                if (hit && !keep_going) break;
                uint8_t pub[32];
                derive_path_pubkey(seeds[li], &g_paths[p], pub, NULL, NULL);
                for (int t = 0; t < ntargets; t++) {
                    if (memcmp(pub, targets[t], 32) == 0) {
                        char addr[64];
                        base58_encode(pub, 32, addr);
                        printf("MATCH %s %s %s\n", addr,
                               g_paths[p].label, batch.phrases[li]);
                        fflush(stdout);
                        matches++;
                        hit = 1;
                        break;
                    }
                }
            }
            if (hit && !keep_going) break;
        }
        acc_derive += now_sec() - d0;
    }

    double wall = now_sec() - t_begin;
    fprintf(stderr,
            "[done] perms=%llu valid=%llu matches=%llu wall=%.2fs "
            "checksum_rate=%.0f/s end_to_end_rate=%.0f/s "
            "(checksum_time=%.2fs derive_time=%.2fs)\n",
            (unsigned long long)done, (unsigned long long)valid,
            (unsigned long long)matches, wall,
            acc_check > 0 ? done / acc_check : 0.0,
            wall > 0 ? done / wall : 0.0, acc_check, acc_derive);
    return matches > 0 ? 0 : 1;
}

static int mode_bench(const uint16_t *idx, int n, double seconds, int full,
                      const char *passphrase)
{
    uint16_t sorted[MAXN];
    memcpy(sorted, idx, (size_t)n * sizeof(uint16_t));
    qsort(sorted, (size_t)n, sizeof(uint16_t), cmp_u16);
    char salt[1024];
    snprintf(salt, sizeof(salt), "mnemonic%s", passphrase);
    int saltlen = (int)strlen(salt);
    uint8_t dummy[32];
    memset(dummy, 0, sizeof(dummy));

    uint16_t perm[MAXN];
    memcpy(perm, sorted, (size_t)n * sizeof(uint16_t));
    uint64_t done = 0, valid = 0;
    double t_begin = now_sec();
    double acc_check = 0.0, acc_derive = 0.0;
    BatchCtx batch;
    batch_init(&batch, salt, saltlen);
    uint8_t seeds[LANES][64];
    while (now_sec() - t_begin < seconds) {
        double t0 = now_sec();
        int ok = bip39_checksum_valid_n(perm, n);
        double t1 = now_sec();
        acc_check += t1 - t0;
        if (ok && full) {
            valid++;
            phrase_from_indices(perm, n, batch.phrases[batch.count]);
            batch.count++;
            if (batch.count == LANES) {
                double d0 = now_sec();
                int nb = batch.count;
                batch_seeds(&batch, seeds);
                for (int li = 0; li < nb; li++)
                    for (int p = 0; p < g_npaths; p++) {
                        uint8_t pub[32];
                        derive_path_pubkey(seeds[li], &g_paths[p], pub,
                                           NULL, NULL);
                        if (memcmp(pub, dummy, 32) == 0)
                            printf("MATCH(impossible)\n");
                    }
                acc_derive += now_sec() - d0;
            }
        } else if (ok) valid++;
        done++;
        if (!next_perm(perm, n))
            memcpy(perm, sorted, (size_t)n * sizeof(uint16_t)); /* wrap */
    }
    if (full && batch.count > 0) {
        double d0 = now_sec();
        int nb = batch.count;
        batch_seeds(&batch, seeds);
        for (int li = 0; li < nb; li++)
            for (int p = 0; p < g_npaths; p++) {
                uint8_t pub[32];
                derive_path_pubkey(seeds[li], &g_paths[p], pub, NULL, NULL);
                if (memcmp(pub, dummy, 32) == 0) printf("MATCH(impossible)\n");
            }
        acc_derive += now_sec() - d0;
    }
    double wall = now_sec() - t_begin;
    printf("BENCH %s perms=%llu valid=%llu wall=%.2fs cand_per_sec=%.0f "
           "checksum_stage_per_sec=%.0f derive_per_survivor_us=%.1f "
           "pubimpl=%s paths=%d solver=v2 lanes=%d\n",
           full ? "full" : "checksum",
           (unsigned long long)done, (unsigned long long)valid, wall,
           wall > 0 ? done / wall : 0.0,
           acc_check > 0 ? done / acc_check : 0.0,
           valid > 0 ? acc_derive * 1e6 / valid : 0.0,
           g_pubimpl == 1 ? "sodium" : "evp", g_npaths, LANES);
    return 0;
}

/* ------------------------------------------------------------------ */
int main(int argc, char **argv)
{
    fact_init();
    for (int i = 0; i < 2048; i++) g_wlen[i] = (uint8_t)strlen(BIP39_WORDS[i]);
#ifdef HAVE_SODIUM
    g_pubimpl = 1;
#endif

    const char *words_s = NULL, *words_file = NULL;
    const char *targets_s = NULL, *targets_file = NULL;
    const char *paths_s = "44'/501'/0'/0'";
    const char *passphrase = "";
    const char *mode = "solve";
    const char *derive_seed_hex = NULL, *derive_path = "";
    const char *start_s = NULL, *end_s = NULL;
    long shard_index = 0, shard_count = 1;
    double max_seconds = 0, bench_secs = 0;
    int print_seed = 0, keep_going = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--words") == 0 && i + 1 < argc) words_s = argv[++i];
        else if (strcmp(argv[i], "--words-file") == 0 && i + 1 < argc) words_file = argv[++i];
        else if (strcmp(argv[i], "--targets") == 0 && i + 1 < argc) targets_s = argv[++i];
        else if (strcmp(argv[i], "--targets-file") == 0 && i + 1 < argc) targets_file = argv[++i];
        else if (strcmp(argv[i], "--paths") == 0 && i + 1 < argc) paths_s = argv[++i];
        else if (strcmp(argv[i], "--passphrase") == 0 && i + 1 < argc) passphrase = argv[++i];
        else if (strcmp(argv[i], "--shard-index") == 0 && i + 1 < argc) shard_index = strtol(argv[++i], NULL, 10);
        else if (strcmp(argv[i], "--shard-count") == 0 && i + 1 < argc) shard_count = strtol(argv[++i], NULL, 10);
        else if (strcmp(argv[i], "--start") == 0 && i + 1 < argc) start_s = argv[++i];
        else if (strcmp(argv[i], "--end") == 0 && i + 1 < argc) end_s = argv[++i];
        else if (strcmp(argv[i], "--max-seconds") == 0 && i + 1 < argc) max_seconds = strtod(argv[++i], NULL);
        else if (strcmp(argv[i], "--continue") == 0) keep_going = 1;
        else if (strcmp(argv[i], "--print-seed") == 0) print_seed = 1;
        else if (strcmp(argv[i], "--pubimpl") == 0 && i + 1 < argc) {
            const char *v = argv[++i];
            if (strcmp(v, "sodium") == 0) g_pubimpl = 1;
            else if (strcmp(v, "evp") == 0) g_pubimpl = 0;
            else { usage(argv[0]); return 2; }
        }
        else if (strcmp(argv[i], "--derive") == 0) mode = "derive";
        else if (strcmp(argv[i], "--check") == 0) mode = "check";
        else if (strcmp(argv[i], "--rank") == 0) mode = "rank";
        else if (strcmp(argv[i], "--dump") == 0) mode = "dump";
        else if (strcmp(argv[i], "--derive-seed") == 0 && i + 1 < argc) {
            mode = "derive-seed";
            derive_seed_hex = argv[++i];
        }
        else if (strcmp(argv[i], "--path") == 0 && i + 1 < argc) derive_path = argv[++i];
        else if (strcmp(argv[i], "--bench-checksum") == 0 && i + 1 < argc) {
            mode = "bench-checksum";
            bench_secs = strtod(argv[++i], NULL);
        }
        else if (strcmp(argv[i], "--bench-full") == 0 && i + 1 < argc) {
            mode = "bench-full";
            bench_secs = strtod(argv[++i], NULL);
        }
        else { usage(argv[0]); return 2; }
    }

#ifndef HAVE_SODIUM
    if (g_pubimpl == 1) {
        fprintf(stderr, "libsodium not linked; using OpenSSL EVP pubkeys\n");
        g_pubimpl = 0;
    }
#endif

    if (strcmp(mode, "derive-seed") == 0)
        return mode_derive_seed(derive_seed_hex, derive_path);

    if (parse_paths(paths_s) != 0) {
        fprintf(stderr, "bad --paths (hardened components only, ';' separated)\n");
        return 2;
    }

    /* words */
    char *words_buf = NULL;
    if (words_file) {
        words_buf = read_file(words_file);
        if (!words_buf) { fprintf(stderr, "cannot read words file\n"); return 2; }
        words_s = words_buf;
    }
    if (!words_s) { usage(argv[0]); return 2; }
    uint16_t idx[MAXN];
    int n = parse_words_str(words_s, idx, MAXN);
    if (n < 0 || !valid_word_count(n)) {
        fprintf(stderr, "need 12/15/18/21/24 BIP39 words (got %d)\n", n);
        return 2;
    }

    if (strcmp(mode, "check") == 0) {
        int ok = bip39_checksum_valid_n(idx, n);
        printf("%s\n", ok ? "VALID" : "INVALID");
        return ok ? 0 : 1;
    }
    if (strcmp(mode, "derive") == 0)
        return mode_derive(idx, n, passphrase, print_seed);
    if (strcmp(mode, "rank") == 0) {
        uint16_t sorted[MAXN];
        memcpy(sorted, idx, (size_t)n * sizeof(uint16_t));
        qsort(sorted, (size_t)n, sizeof(uint16_t), cmp_u16);
        char rb[48], tb[48];
        u128_to_str(rank_of(idx, n), rb);
        u128_to_str(total_perms(sorted, n), tb);
        printf("rank %s total %s\n", rb, tb);
        return 0;
    }
    if (strcmp(mode, "dump") == 0)
        return mode_dump(idx, n, shard_index, shard_count, start_s, end_s);
    if (strcmp(mode, "bench-checksum") == 0)
        return mode_bench(idx, n, bench_secs, 0, passphrase);
    if (strcmp(mode, "bench-full") == 0)
        return mode_bench(idx, n, bench_secs, 1, passphrase);

    /* solve: need targets */
    static uint8_t targets[MAXTARGETS][32];
    int ntargets = 0;
    char *targets_buf = NULL;
    if (targets_file) {
        targets_buf = read_file(targets_file);
        if (!targets_buf) { fprintf(stderr, "cannot read targets file\n"); return 2; }
        targets_s = targets_buf;
    }
    if (!targets_s) {
        fprintf(stderr, "solve mode needs --targets or --targets-file\n");
        return 2;
    }
    {
        char buf[8192];
        size_t sl = strlen(targets_s);
        if (sl >= sizeof(buf)) { fprintf(stderr, "targets too long\n"); return 2; }
        memcpy(buf, targets_s, sl + 1);
        char *save = NULL;
        for (char *tok = strtok_r(buf, ", \t\r\n", &save); tok;
             tok = strtok_r(NULL, ", \t\r\n", &save)) {
            if (ntargets >= MAXTARGETS) { fprintf(stderr, "too many targets\n"); return 2; }
            if (base58_decode_32(tok, targets[ntargets]) != 0) {
                fprintf(stderr, "bad target address: %s\n", tok);
                return 2;
            }
            /* round-trip sanity */
            char re[64];
            base58_encode(targets[ntargets], 32, re);
            if (strcmp(re, tok) != 0) {
                fprintf(stderr, "target base58 round-trip mismatch: %s\n", tok);
                return 2;
            }
            ntargets++;
        }
    }
    if (ntargets == 0) { fprintf(stderr, "no targets\n"); return 2; }

    return mode_solve(idx, n, targets, ntargets, passphrase,
                      shard_index, shard_count, start_s, end_s,
                      max_seconds, keep_going);
}
