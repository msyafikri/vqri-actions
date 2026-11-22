/*
 * sha512x.h — SHA-512 / HMAC-SHA512 / PBKDF2-HMAC-SHA512 for seed_solver v2.
 *
 * Why this exists (diagnosis of v1's 2,141-2,588 us per survivor):
 *   v1's derive time is ~100% OpenSSL PKCS5_PBKDF2_HMAC (measured 2,159 us
 *   isolated). OpenSSL already reuses HMAC pad states internally (2 block
 *   compressions per iteration); the cost is raw scalar SHA-512 compression
 *   throughput (~500 ns per 128-byte block on the dev VM). A hand-rolled
 *   scalar PBKDF2 with pad reuse therefore lands in the same place. The
 *   only way through is SIMD batching ACROSS candidates: process LANES
 *   independent PBKDF2 streams at once, one SHA-512 state word per lane
 *   element (AVX-512: 8 lanes, AVX2: 4 lanes, scalar fallback: 1 lane).
 *
 * Contents:
 *   - scalar SHA-512 (compress + full hash), reference & SLIP-0010 use
 *   - scalar HMAC-SHA512 with precomputed pad states
 *   - scalar PBKDF2-HMAC-SHA512 (single candidate; --derive, fallback)
 *   - batched PBKDF2-HMAC-SHA512 (LANES candidates, shared salt)
 *
 * All state words are kept as big-endian integer values (uint64_t), never
 * as byte strings, so digests feed straight into the next compression.
 */
#ifndef SHA512X_H
#define SHA512X_H

#include <stdint.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */
static const uint64_t SHA512_K[80] = {
    0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
    0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
    0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
    0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
    0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
    0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
    0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
    0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
    0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
    0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
    0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
    0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
    0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
    0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
    0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
    0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
    0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
    0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
    0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
    0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL
};

static const uint64_t SHA512_H0[8] = {
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
    0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL
};

#define ROTR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

/* ------------------------------------------------------------------ */
/* scalar SHA-512                                                      */
/* ------------------------------------------------------------------ */
/* one compression: h = chaining state (in/out), w = 16 big-endian words */
static void sha512_compress(uint64_t h[8], const uint64_t w[16])
{
    uint64_t W[80];
    memcpy(W, w, 16 * sizeof(uint64_t));
    for (int t = 16; t < 80; t++) {
        uint64_t s0 = ROTR64(W[t-15], 1) ^ ROTR64(W[t-15], 8) ^ (W[t-15] >> 7);
        uint64_t s1 = ROTR64(W[t-2], 19) ^ ROTR64(W[t-2], 61) ^ (W[t-2] >> 6);
        W[t] = W[t-16] + s0 + W[t-7] + s1;
    }
    uint64_t a=h[0], b=h[1], c=h[2], d=h[3], e=h[4], f=h[5], g=h[6], hh=h[7];
    for (int t = 0; t < 80; t++) {
        uint64_t S1 = ROTR64(e, 14) ^ ROTR64(e, 18) ^ ROTR64(e, 41);
        uint64_t ch = (e & f) ^ (~e & g);
        uint64_t t1 = hh + S1 + ch + SHA512_K[t] + W[t];
        uint64_t S0 = ROTR64(a, 28) ^ ROTR64(a, 34) ^ ROTR64(a, 39);
        uint64_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint64_t t2 = S0 + maj;
        hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
}

static uint64_t load_be64(const uint8_t *p)
{
    return ((uint64_t)p[0] << 56) | ((uint64_t)p[1] << 48) |
           ((uint64_t)p[2] << 40) | ((uint64_t)p[3] << 32) |
           ((uint64_t)p[4] << 24) | ((uint64_t)p[5] << 16) |
           ((uint64_t)p[6] << 8)  |  (uint64_t)p[7];
}

static void store_be64(uint8_t *p, uint64_t v)
{
    p[0] = (uint8_t)(v >> 56); p[1] = (uint8_t)(v >> 48);
    p[2] = (uint8_t)(v >> 40); p[3] = (uint8_t)(v >> 32);
    p[4] = (uint8_t)(v >> 24); p[5] = (uint8_t)(v >> 16);
    p[6] = (uint8_t)(v >> 8);  p[7] = (uint8_t)v;
}

/* build the final padded block(s) tail: writes 1 or 2 blocks worth of
 * words for the message remainder rem[0..remlen) with total length total. */
static void sha512_finish_block(uint64_t h[8], const uint8_t *rem,
                                size_t remlen, uint64_t total_len)
{
    uint8_t buf[256];
    memset(buf, 0, sizeof(buf));
    memcpy(buf, rem, remlen);
    buf[remlen] = 0x80;
    size_t blocks = (remlen + 1 + 16 <= 128) ? 1 : 2;
    store_be64(buf + blocks * 128 - 8, total_len * 8);
    /* 128-bit length: high half zero for our sizes */
    uint64_t w[16];
    for (size_t b = 0; b < blocks; b++) {
        for (int i = 0; i < 16; i++) w[i] = load_be64(buf + b * 128 + 8 * i);
        sha512_compress(h, w);
    }
}

static void sha512(const uint8_t *data, size_t len, uint8_t out[64])
{
    uint64_t h[8];
    memcpy(h, SHA512_H0, sizeof(h));
    size_t off = 0;
    while (len - off >= 128) {
        uint64_t w[16];
        for (int i = 0; i < 16; i++) w[i] = load_be64(data + off + 8 * i);
        sha512_compress(h, w);
        off += 128;
    }
    sha512_finish_block(h, data + off, len - off, (uint64_t)len);
    for (int i = 0; i < 8; i++) store_be64(out + 8 * i, h[i]);
}

/* ------------------------------------------------------------------ */
/* scalar HMAC-SHA512 with precomputed pad states                      */
/* ------------------------------------------------------------------ */
typedef struct {
    uint64_t istate[8];
    uint64_t ostate[8];
} hmac512_ctx;

static void hmac512_init(hmac512_ctx *ctx, const uint8_t *key, size_t klen)
{
    uint8_t kb[128];
    memset(kb, 0, sizeof(kb));
    if (klen > 128) {
        uint8_t kh[64];
        sha512(key, klen, kh);
        memcpy(kb, kh, 64);
    } else {
        memcpy(kb, key, klen);
    }
    uint64_t w[16];
    memcpy(ctx->istate, SHA512_H0, sizeof(ctx->istate));
    for (int i = 0; i < 16; i++) w[i] = load_be64(kb + 8 * i) ^ 0x3636363636363636ULL;
    sha512_compress(ctx->istate, w);
    memcpy(ctx->ostate, SHA512_H0, sizeof(ctx->ostate));
    for (int i = 0; i < 16; i++) w[i] = load_be64(kb + 8 * i) ^ 0x5c5c5c5c5c5c5c5cULL;
    sha512_compress(ctx->ostate, w);
}

/* HMAC over data; the inner hash input is the 128-byte pad block + data,
 * so the finish length is 128 + dlen. */
static void hmac512(const hmac512_ctx *ctx, const uint8_t *data, size_t dlen,
                    uint8_t out[64])
{
    uint64_t h[8];
    memcpy(h, ctx->istate, sizeof(h));
    size_t off = 0;
    while (dlen - off >= 128) {
        uint64_t w[16];
        for (int i = 0; i < 16; i++) w[i] = load_be64(data + off + 8 * i);
        sha512_compress(h, w);
        off += 128;
    }
    sha512_finish_block(h, data + off, dlen - off, 128 + (uint64_t)dlen);
    uint8_t inner[64];
    for (int i = 0; i < 8; i++) store_be64(inner + 8 * i, h[i]);
    memcpy(h, ctx->ostate, sizeof(h));
    sha512_finish_block(h, inner, 64, 128 + 64);
    for (int i = 0; i < 8; i++) store_be64(out + 8 * i, h[i]);
}

/* convenience: one-shot HMAC with a raw key */
static void hmac512_key(const uint8_t *key, size_t klen,
                        const uint8_t *data, size_t dlen, uint8_t out[64])
{
    hmac512_ctx ctx;
    hmac512_init(&ctx, key, klen);
    hmac512(&ctx, data, dlen, out);
}

/* ------------------------------------------------------------------ */
/* scalar PBKDF2-HMAC-SHA512 (dkLen = 64, single block index)          */
/* ------------------------------------------------------------------ */
static void pbkdf2_sha512(const uint8_t *pw, size_t pwlen,
                          const uint8_t *salt, size_t saltlen,
                          int iters, uint8_t out[64])
{
    hmac512_ctx ctx;
    hmac512_init(&ctx, pw, pwlen);
    uint8_t msg[256];
    memcpy(msg, salt, saltlen);
    msg[saltlen] = 0; msg[saltlen+1] = 0; msg[saltlen+2] = 0; msg[saltlen+3] = 1;
    uint8_t U[64], T[64];
    hmac512(&ctx, msg, saltlen + 4, U);
    memcpy(T, U, 64);
    for (int i = 1; i < iters; i++) {
        hmac512(&ctx, U, 64, U);
        for (int j = 0; j < 64; j++) T[j] ^= U[j];
    }
    memcpy(out, T, 64);
}

/* ------------------------------------------------------------------ */
/* vectorised batch SHA-512                                            */
/* ------------------------------------------------------------------ */
#if defined(__AVX512F__)
#  include <immintrin.h>
   typedef __m512i v64;
#  define PBKDF2_LANES 8
#  define VADD(a,b)   _mm512_add_epi64((a),(b))
#  define VXOR(a,b)   _mm512_xor_si512((a),(b))
#  define VAND(a,b)   _mm512_and_si512((a),(b))
#  define VOR(a,b)    _mm512_or_si512((a),(b))
#  define VNOT(a)     _mm512_xor_si512((a), _mm512_set1_epi64(-1))
#  define VROTR(a,n)  _mm512_ror_epi64((a),(n))
#  define VSHR(a,n)   _mm512_srli_epi64((a),(n))
#  define VSET1(x)    _mm512_set1_epi64((long long)(x))
#  define VLOAD(p)    _mm512_loadu_si512((const void *)(p))
#  define VSTORE(p,v) _mm512_storeu_si512((void *)(p), (v))
#elif defined(__AVX2__)
#  include <immintrin.h>
   typedef __m256i v64;
#  define PBKDF2_LANES 4
#  define VADD(a,b)   _mm256_add_epi64((a),(b))
#  define VXOR(a,b)   _mm256_xor_si256((a),(b))
#  define VAND(a,b)   _mm256_and_si256((a),(b))
#  define VOR(a,b)    _mm256_or_si256((a),(b))
#  define VNOT(a)     _mm256_xor_si256((a), _mm256_set1_epi64x(-1))
#  define VROTR(a,n)  _mm256_or_si256(_mm256_srli_epi64((a),(n)), _mm256_slli_epi64((a),64-(n)))
#  define VSHR(a,n)   _mm256_srli_epi64((a),(n))
#  define VSET1(x)    _mm256_set1_epi64x((long long)(x))
#  define VLOAD(p)    _mm256_loadu_si256((const __m256i *)(p))
#  define VSTORE(p,v) _mm256_storeu_si256((__m256i *)(p), (v))
#else
   typedef uint64_t v64;
#  define PBKDF2_LANES 1
#  define VADD(a,b)   ((a)+(b))
#  define VXOR(a,b)   ((a)^(b))
#  define VAND(a,b)   ((a)&(b))
#  define VOR(a,b)    ((a)|(b))
#  define VNOT(a)     (~(a))
#  define VROTR(a,n)  ROTR64((a),(n))
#  define VSHR(a,n)   ((a)>>(n))
#  define VSET1(x)    (x)
#  define VLOAD(p)    (*(const uint64_t *)(p))
#  define VSTORE(p,v) (*(uint64_t *)(p) = (v))
#endif

#define LANES PBKDF2_LANES

/* Batched compression. st[w][lane] = chaining word w of lane's state;
 * blk[w][lane] = message word w of lane's block. Both in transposed
 * (word-major) layout so each row loads into one vector register. */
static void sha512x_compress(uint64_t st[8][LANES], const uint64_t blk[16][LANES])
{
    v64 W[80];
    for (int t = 0; t < 16; t++) W[t] = VLOAD(blk[t]);
    for (int t = 16; t < 80; t++) {
        v64 x = W[t-15], y = W[t-2];
        v64 s0 = VXOR(VXOR(VROTR(x, 1), VROTR(x, 8)), VSHR(x, 7));
        v64 s1 = VXOR(VXOR(VROTR(y, 19), VROTR(y, 61)), VSHR(y, 6));
        W[t] = VADD(VADD(W[t-16], s0), VADD(W[t-7], s1));
    }
    v64 a=VLOAD(st[0]), b=VLOAD(st[1]), c=VLOAD(st[2]), d=VLOAD(st[3]);
    v64 e=VLOAD(st[4]), f=VLOAD(st[5]), g=VLOAD(st[6]), h=VLOAD(st[7]);
    for (int t = 0; t < 80; t++) {
        v64 S1 = VXOR(VXOR(VROTR(e, 14), VROTR(e, 18)), VROTR(e, 41));
        v64 ch = VXOR(VAND(e, f), VAND(VNOT(e), g));
        v64 t1 = VADD(VADD(VADD(h, S1), VADD(ch, VSET1(SHA512_K[t]))), W[t]);
        v64 S0 = VXOR(VXOR(VROTR(a, 28), VROTR(a, 34)), VROTR(a, 39));
        v64 maj = VXOR(VXOR(VAND(a, b), VAND(a, c)), VAND(b, c));
        v64 t2 = VADD(S0, maj);
        h = g; g = f; f = e; e = VADD(d, t1);
        d = c; c = b; b = a; a = VADD(t1, t2);
    }
    VSTORE(st[0], VADD(VLOAD(st[0]), a));
    VSTORE(st[1], VADD(VLOAD(st[1]), b));
    VSTORE(st[2], VADD(VLOAD(st[2]), c));
    VSTORE(st[3], VADD(VLOAD(st[3]), d));
    VSTORE(st[4], VADD(VLOAD(st[4]), e));
    VSTORE(st[5], VADD(VLOAD(st[5]), f));
    VSTORE(st[6], VADD(VLOAD(st[6]), g));
    VSTORE(st[7], VADD(VLOAD(st[7]), h));
}

/* Batched PBKDF2-HMAC-SHA512, dkLen = 64.
 * pw[i]/pwlen[i]: password of lane i (may exceed 128 bytes -> pre-hashed).
 * Shared salt; requires saltlen + 4 <= 119 (single inner block for U_1,
 * always true for BIP39's "mnemonic"+passphrase in practice).
 * Lanes beyond the caller's real candidates are padded by the caller
 * (duplicate lane 0); all LANES outputs are written. */
static void pbkdf2_batch(const uint8_t *const pw[LANES],
                         const size_t pwlen[LANES],
                         const uint8_t *salt, size_t saltlen,
                         int iters, uint8_t out[LANES][64])
{
    /* per-lane key material (<=128 bytes, zero padded) */
    uint8_t kb[LANES][128];
    for (int i = 0; i < LANES; i++) {
        memset(kb[i], 0, 128);
        if (pwlen[i] > 128) sha512(pw[i], pwlen[i], kb[i]);
        else memcpy(kb[i], pw[i], pwlen[i]);
    }
    /* pad states, transposed */
    uint64_t istate[8][LANES], ostate[8][LANES], blk[16][LANES];
    for (int rep = 0; rep < 2; rep++) {
        uint64_t pad = rep == 0 ? 0x3636363636363636ULL : 0x5c5c5c5c5c5c5c5cULL;
        for (int w = 0; w < 16; w++)
            for (int i = 0; i < LANES; i++)
                blk[w][i] = load_be64(kb[i] + 8 * w) ^ pad;
        uint64_t st[8][LANES];
        for (int w = 0; w < 8; w++)
            for (int i = 0; i < LANES; i++)
                st[w][i] = SHA512_H0[w];
        sha512x_compress(st, (const uint64_t (*)[LANES])blk);
        memcpy(rep == 0 ? istate : ostate, st, sizeof(st));
    }
    /* U_1: inner block = salt || BE32(1), identical for all lanes */
    uint8_t msg[128];
    memset(msg, 0, sizeof(msg));
    memcpy(msg, salt, saltlen);
    msg[saltlen + 3] = 1;
    msg[saltlen + 4] = 0x80;
    store_be64(msg + 120, (128 + (uint64_t)saltlen + 4) * 8);
    for (int w = 0; w < 16; w++) {
        uint64_t word = load_be64(msg + 8 * w);
        for (int i = 0; i < LANES; i++) blk[w][i] = word;
    }
    uint64_t st[8][LANES];
    memcpy(st, istate, sizeof(st));
    sha512x_compress(st, (const uint64_t (*)[LANES])blk);
    /* outer block from inner digest */
    for (int w = 0; w < 16; w++)
        for (int i = 0; i < LANES; i++)
            blk[w][i] = w < 8 ? st[w][i] : w == 8 ? 0x8000000000000000ULL
                        : w == 15 ? 1536ULL : 0ULL;
    memcpy(st, ostate, sizeof(st));
    sha512x_compress(st, (const uint64_t (*)[LANES])blk);
    uint64_t T[8][LANES];
    memcpy(T, st, sizeof(T));
    /* iterations 2..iters */
    for (int it = 1; it < iters; it++) {
        for (int w = 0; w < 16; w++)
            for (int i = 0; i < LANES; i++)
                blk[w][i] = w < 8 ? st[w][i] : w == 8 ? 0x8000000000000000ULL
                            : w == 15 ? 1536ULL : 0ULL;
        memcpy(st, istate, sizeof(st));
        sha512x_compress(st, (const uint64_t (*)[LANES])blk);
        for (int w = 0; w < 16; w++)
            for (int i = 0; i < LANES; i++)
                blk[w][i] = w < 8 ? st[w][i] : w == 8 ? 0x8000000000000000ULL
                            : w == 15 ? 1536ULL : 0ULL;
        memcpy(st, ostate, sizeof(st));
        sha512x_compress(st, (const uint64_t (*)[LANES])blk);
        for (int w = 0; w < 8; w++)
            for (int i = 0; i < LANES; i++)
                T[w][i] ^= st[w][i];
    }
    for (int i = 0; i < LANES; i++)
        for (int w = 0; w < 8; w++)
            store_be64(out[i] + 8 * w, T[w][i]);
}

#endif /* SHA512X_H */
