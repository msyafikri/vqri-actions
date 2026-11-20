/*
 * grind.c — BIP39 word-order brute-force search tool (Solana targets).
 *
 * Enumerates permutations of 12 BIP39 word indices (lexicographic order,
 * resumable via factorial unranking), filters by the BIP39 checksum
 * (SHA-256), derives the PBKDF2-HMAC-SHA512 seed for each survivor, then
 * derives Solana addresses via SLIP-0010 (ed25519, all-hardened) for
 * three derivation paths and prints any candidate whose raw 32-byte
 * public key exactly matches one of the target addresses below.
 *
 * Paths checked per candidate (prefix-shared):
 *   A: m/44'/501'/0'/0'      (Phantom-style)
 *   B: m/44'/501'/0'/0'/0'   (Trust-style)
 *   C: m/44'/501'/0'         (Solflare-style)
 *
 * Modes:
 *   ./grind <start> <end> <w1> ... <w12>   search permutation ranks [start, end)
 *   ./grind --phrase <w1> ... <w12>        print the 3 Solana addresses of one phrase
 *   ./grind --check  <w1> ... <w12>        print VALID / INVALID (checksum)
 *   ./grind --targets                      print stored targets (base58 round-trip)
 *
 * Matches go to stdout as:  MATCH <base58 address> <path> <phrase>
 * Progress / stats go to stderr.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include <openssl/sha.h>
#include <openssl/hmac.h>
#include <openssl/evp.h>

#include "words.h"

/* ------------------------------------------------------------------ */
/* Target Solana addresses (full base58). Decoded to raw 32-byte       */
/* public keys at startup; re-encode round-trip is verified.           */
/* ------------------------------------------------------------------ */
static const char *TARGET_STRINGS[] = {
    "Ez2p2HZBmaG2pUn9yNNkiAyTTwsEgcZC4QafwBCWuMxC",
    "AHhReZPyEQw8QZhBc8AiFk9a3NTfNTDsF2MH1dWZAtFF",
    "HcqZnXUqUeBk5PfZdC95Luk7cJgUrS5sZDaBTkX5ArFD",
    "8wNSk5rFugeA1LhWRx5PYgwGFyouTjpZHJpc6wrikzKD",
    "AFKDzsj1sHtngjkVqKFUjmW2NdDxoq8jJnHUQPrde9VP",
    "4h98mdYFyNNvWbsTRHG9taaM3TfCpPkhZyDK8pVBFNDD",
    "3KbrsUFqtu1e2JEhQMfwdSAAwSwizs6hm1pmGcJJD5z9",
};
#define NTARGETS (sizeof(TARGET_STRINGS) / sizeof(TARGET_STRINGS[0]))
static uint8_t g_targets[NTARGETS][32];

/* ------------------------------------------------------------------ */
/* Base58 (Bitcoin alphabet) encode / decode.                          */
/* ------------------------------------------------------------------ */
static const char B58_ALPHABET[] =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

static void base58_encode(const uint8_t *in, size_t len, char *out)
{
    size_t zeros = 0;
    while (zeros < len && in[zeros] == 0)
        zeros++;
    /* base58 digits, little-endian accumulation */
    uint8_t digits[64];
    size_t dlen = 0;
    for (size_t i = zeros; i < len; i++) {
        int carry = in[i];
        for (size_t j = 0; j < dlen; j++) {
            carry += digits[j] << 8;
            digits[j] = (uint8_t)(carry % 58);
            carry /= 58;
        }
        while (carry) {
            digits[dlen++] = (uint8_t)(carry % 58);
            carry /= 58;
        }
    }
    char *p = out;
    for (size_t i = 0; i < zeros; i++)
        *p++ = '1';
    for (size_t i = dlen; i-- > 0;)
        *p++ = B58_ALPHABET[digits[i]];
    *p = '\0';
}

static int b58_value(char ch)
{
    const char *p = strchr(B58_ALPHABET, ch);
    return p ? (int)(p - B58_ALPHABET) : -1;
}

/* decode base58 string into exactly 32 bytes; return 0 on success */
static int base58_decode_32(const char *s, uint8_t out[32])
{
    size_t zeros = 0;
    while (s[zeros] == '1')
        zeros++;
    uint8_t bytes[64];
    size_t blen = 0;
    for (size_t i = zeros; s[i] != '\0'; i++) {
        int v = b58_value(s[i]);
        if (v < 0)
            return -1;
        int carry = v;
        for (size_t j = 0; j < blen; j++) {
            carry += bytes[j] * 58;
            bytes[j] = (uint8_t)(carry & 0xff);
            carry >>= 8;
        }
        while (carry) {
            if (blen >= sizeof(bytes))
                return -1;
            bytes[blen++] = (uint8_t)(carry & 0xff);
            carry >>= 8;
        }
    }
    if (zeros + blen != 32)
        return -1;
    memset(out, 0, 32);
    for (size_t i = 0; i < blen; i++)
        out[zeros + i] = bytes[blen - 1 - i];
    return 0;
}

static void targets_init(void)
{
    for (size_t i = 0; i < NTARGETS; i++) {
        if (base58_decode_32(TARGET_STRINGS[i], g_targets[i]) != 0) {
            fprintf(stderr, "FATAL: target %zu does not decode to 32 bytes: %s\n",
                    i, TARGET_STRINGS[i]);
            exit(2);
        }
        char re[64];
        base58_encode(g_targets[i], 32, re);
        if (strcmp(re, TARGET_STRINGS[i]) != 0) {
            fprintf(stderr, "FATAL: target %zu base58 round-trip mismatch: %s != %s\n",
                    i, re, TARGET_STRINGS[i]);
            exit(2);
        }
    }
}

/* ------------------------------------------------------------------ */
/* BIP39 checksum: pack 12 x 11-bit indices -> 16 entropy bytes +      */
/* 4 checksum bits; valid iff SHA256(entropy)[0] >> 4 == checksum.     */
/* ------------------------------------------------------------------ */
static int bip39_checksum_valid(const uint16_t idx[12])
{
    uint8_t ent[16];
    uint32_t acc = 0;
    int nbits = 0, out = 0;
    uint8_t digest[SHA256_DIGEST_LENGTH];

    for (int i = 0; i < 12; i++) {
        acc = (acc << 11) | idx[i];
        nbits += 11;
        while (nbits >= 8) {
            nbits -= 8;
            if (out < 16)
                ent[out++] = (uint8_t)((acc >> nbits) & 0xff);
        }
    }
    /* 132 bits total: 128 emitted, low 4 bits of acc are the checksum */
    uint8_t want = (uint8_t)(acc & 0x0f);
    SHA256(ent, 16, digest);
    return (digest[0] >> 4) == want;
}

/* ------------------------------------------------------------------ */
/* PBKDF2-HMAC-SHA512 seed from mnemonic sentence.                     */
/* ------------------------------------------------------------------ */
static void seed_from_phrase(const char *mnemonic, uint8_t seed[64])
{
    PKCS5_PBKDF2_HMAC(mnemonic, (int)strlen(mnemonic),
                      (const uint8_t *)"mnemonic", 8,
                      2048, EVP_sha512(), 64, seed);
}

/* ------------------------------------------------------------------ */
/* SLIP-0010 ed25519 derivation (all-hardened) via OpenSSL.            */
/* ------------------------------------------------------------------ */
static void hmac512(const uint8_t *key, size_t klen,
                    const uint8_t *data, size_t dlen, uint8_t out[64])
{
    unsigned int ilen = 0;
    HMAC(EVP_sha512(), key, (int)klen, data, dlen, out, &ilen);
}

/* one hardened child step; in-place safe (k/c may alias kout/cout) */
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
    hmac512(c, 32, data, sizeof(data), I);
    memcpy(kout, I, 32);
    memcpy(cout, I + 32, 32);
}

static void ed25519_pubkey(const uint8_t kseed[32], uint8_t out[32])
{
    EVP_PKEY *pkey = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL,
                                                  kseed, 32);
    if (!pkey) {
        fprintf(stderr, "FATAL: EVP_PKEY_new_raw_private_key failed\n");
        exit(2);
    }
    size_t len = 32;
    if (EVP_PKEY_get_raw_public_key(pkey, out, &len) != 1 || len != 32) {
        fprintf(stderr, "FATAL: EVP_PKEY_get_raw_public_key failed\n");
        exit(2);
    }
    EVP_PKEY_free(pkey);
}

static const char *PATH_LABELS[3] = {
    "44'/501'/0'/0'",       /* A */
    "44'/501'/0'/0'/0'",    /* B */
    "44'/501'/0'",          /* C */
};

/* Derive all three Solana pubkeys for a 64-byte seed (shared prefix). */
static void derive_sol_pubkeys(const uint8_t seed[64], uint8_t pubs[3][32])
{
    uint8_t I[64];
    hmac512((const uint8_t *)"ed25519 seed", 12, seed, 64, I);
    uint8_t k[32], c[32];
    memcpy(k, I, 32);
    memcpy(c, I + 32, 32);

    slip10_child(k, c, 44, k, c);
    slip10_child(k, c, 501, k, c);
    slip10_child(k, c, 0, k, c);
    ed25519_pubkey(k, pubs[2]);            /* C: 44'/501'/0' */
    slip10_child(k, c, 0, k, c);
    ed25519_pubkey(k, pubs[0]);            /* A: 44'/501'/0'/0' */
    slip10_child(k, c, 0, k, c);
    ed25519_pubkey(k, pubs[1]);            /* B: 44'/501'/0'/0'/0' */
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
static int word_index(const char *w)
{
    for (int i = 0; i < 2048; i++)
        if (strcmp(w, BIP39_WORDS[i]) == 0)
            return i;
    return -1;
}

static void phrase_from_indices(const uint16_t idx[12], char *out, size_t outsz)
{
    size_t pos = 0;
    for (int i = 0; i < 12; i++) {
        const char *w = BIP39_WORDS[idx[i]];
        size_t wl = strlen(w);
        if (pos + wl + 2 > outsz)
            break;
        memcpy(out + pos, w, wl);
        pos += wl;
        if (i < 11)
            out[pos++] = ' ';
    }
    out[pos] = '\0';
}

static double now_sec(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static uint64_t FACT[13];

/* factorial unranking: permutation of rank `rank` (lexicographic) */
static void unrank(uint64_t rank, const uint16_t sorted[12], uint16_t out[12])
{
    uint16_t avail[12];
    memcpy(avail, sorted, sizeof(avail));
    int n = 12;
    for (int pos = 0; pos < 12; pos++) {
        uint64_t f = FACT[11 - pos];
        int digit = (int)(rank / f);
        rank %= f;
        out[pos] = avail[digit];
        memmove(&avail[digit], &avail[digit + 1],
                (size_t)(n - digit - 1) * sizeof(uint16_t));
        n--;
    }
}

static int next_perm(uint16_t a[12])
{
    int i = 10;
    while (i >= 0 && a[i] >= a[i + 1])
        i--;
    if (i < 0)
        return 0;
    int j = 11;
    while (a[j] <= a[i])
        j--;
    uint16_t t = a[i]; a[i] = a[j]; a[j] = t;
    for (int l = i + 1, r = 11; l < r; l++, r--) {
        t = a[l]; a[l] = a[r]; a[r] = t;
    }
    return 1;
}

static int cmp_u16(const void *a, const void *b)
{
    return (int)*(const uint16_t *)a - (int)*(const uint16_t *)b;
}

/* parse 12 CLI words starting at argv[off]; fill idx; die on unknown word */
static void parse_words(int argc, char **argv, int off, uint16_t idx[12])
{
    if (argc < off + 12) {
        fprintf(stderr, "need 12 words\n");
        exit(2);
    }
    for (int i = 0; i < 12; i++) {
        int wi = word_index(argv[off + i]);
        if (wi < 0) {
            fprintf(stderr, "unknown BIP39 word: %s\n", argv[off + i]);
            exit(2);
        }
        idx[i] = (uint16_t)wi;
    }
}

int main(int argc, char **argv)
{
    FACT[0] = 1;
    for (int i = 1; i <= 12; i++)
        FACT[i] = FACT[i - 1] * (uint64_t)i;

    targets_init();

    if (argc >= 2 && strcmp(argv[1], "--targets") == 0) {
        for (size_t i = 0; i < NTARGETS; i++) {
            char re[64];
            base58_encode(g_targets[i], 32, re);
            printf("%s\n", re);
        }
        return 0;
    }

    if (argc >= 2 && strcmp(argv[1], "--check") == 0) {
        uint16_t idx[12];
        parse_words(argc, argv, 2, idx);
        printf("%s\n", bip39_checksum_valid(idx) ? "VALID" : "INVALID");
        return 0;
    }

    if (argc >= 2 && strcmp(argv[1], "--phrase") == 0) {
        uint16_t idx[12];
        parse_words(argc, argv, 2, idx);
        if (!bip39_checksum_valid(idx)) {
            printf("INVALID\n");
            return 1;
        }
        char phrase[256];
        phrase_from_indices(idx, phrase, sizeof(phrase));
        uint8_t seed[64];
        seed_from_phrase(phrase, seed);
        uint8_t pubs[3][32];
        derive_sol_pubkeys(seed, pubs);
        for (int p = 0; p < 3; p++) {
            char addr[64];
            base58_encode(pubs[p], 32, addr);
            printf("%s %s\n", PATH_LABELS[p], addr);
        }
        return 0;
    }

    /* grind mode: ./grind <start> <end> <w1..w12> */
    if (argc < 15) {
        fprintf(stderr,
            "usage: %s <start> <end> <w1> ... <w12>\n"
            "       %s --phrase <w1> ... <w12>\n"
            "       %s --check <w1> ... <w12>\n"
            "       %s --targets\n",
            argv[0], argv[0], argv[0], argv[0]);
        return 2;
    }
    uint64_t start = strtoull(argv[1], NULL, 10);
    uint64_t end = strtoull(argv[2], NULL, 10);
    if (end > FACT[12])
        end = FACT[12];
    if (start >= end) {
        fprintf(stderr, "empty range\n");
        return 2;
    }

    uint16_t idx[12], sorted[12], perm[12];
    parse_words(argc, argv, 3, idx);
    memcpy(sorted, idx, sizeof(idx));
    qsort(sorted, 12, sizeof(uint16_t), cmp_u16);
    unrank(start, sorted, perm);

    uint64_t done = 0, valid = 0, matches = 0;
    double t_begin = now_sec();
    double t_last = t_begin;
    double acc_check = 0.0, acc_derive = 0.0;

    for (uint64_t rank = start; rank < end; rank++) {
        double t0 = now_sec();
        int ok = bip39_checksum_valid(perm);
        double t1 = now_sec();
        acc_check += t1 - t0;
        if (ok) {
            valid++;
            char phrase[256];
            phrase_from_indices(perm, phrase, sizeof(phrase));
            uint8_t seed[64];
            seed_from_phrase(phrase, seed);
            uint8_t pubs[3][32];
            derive_sol_pubkeys(seed, pubs);
            double t2 = now_sec();
            acc_derive += t2 - t1;
            for (int p = 0; p < 3; p++) {
                for (size_t t = 0; t < NTARGETS; t++) {
                    if (memcmp(pubs[p], g_targets[t], 32) == 0) {
                        char addr[64];
                        base58_encode(pubs[p], 32, addr);
                        printf("MATCH %s %s %s\n", addr, PATH_LABELS[p], phrase);
                        fflush(stdout);
                        matches++;
                    }
                }
            }
        }
        done++;
        if (rank + 1 < end && !next_perm(perm))
            break;
        double tnow = now_sec();
        if (tnow - t_last >= 5.0) {
            double el = tnow - t_begin;
            fprintf(stderr,
                "[grind] rank=%llu done=%llu valid=%llu elapsed=%.1fs rate=%.0f perms/s\n",
                (unsigned long long)(rank + 1),
                (unsigned long long)done,
                (unsigned long long)valid,
                el, done / el);
            t_last = tnow;
        }
    }

    double wall = now_sec() - t_begin;
    fprintf(stderr,
        "[done] perms=%llu valid=%llu matches=%llu wall=%.2fs "
        "checksum_rate=%.0f/s end_to_end_rate=%.0f/s "
        "(checksum_time=%.2fs derive_time=%.2fs)\n",
        (unsigned long long)done,
        (unsigned long long)valid,
        (unsigned long long)matches,
        wall,
        acc_check > 0 ? done / acc_check : 0.0,
        wall > 0 ? done / wall : 0.0,
        acc_check, acc_derive);
    return 0;
}
