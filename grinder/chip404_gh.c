// CHIP404 grinder: hash = keccak256( saltHash(32) || wallet(20) || nonce uint256 BE )
// saltHash = keccak256("chip404.trial.v1"). Payload 84 bytes, single Keccak block.
// Success: digest (big-endian uint256) has >= TARGET leading zero bits.
// Usage: chipgrind <start_nonce> <target_bits> <outfile> [threads] [max_seconds]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>
#include <unistd.h>

static const uint64_t RNDC[24] = {
  0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
  0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
  0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
  0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
  0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
  0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL};
static const int ROTC[24] = {1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44};
static const int PILN[24] = {10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1};
static inline uint64_t rol(uint64_t x, int n){ return (x<<n)|(x>>(64-n)); }

static void keccakf(uint64_t st[25]){
  uint64_t bc[5], t;
  for(int round=0; round<24; round++){
    for(int i=0;i<5;i++) bc[i]=st[i]^st[i+5]^st[i+10]^st[i+15]^st[i+20];
    for(int i=0;i<5;i++){ t=bc[(i+4)%5]^rol(bc[(i+1)%5],1); for(int j=0;j<25;j+=5) st[j+i]^=t; }
    t=st[1];
    for(int i=0;i<24;i++){ int j=PILN[i]; bc[0]=st[j]; st[j]=rol(t,ROTC[i]); t=bc[0]; }
    for(int j=0;j<25;j+=5){ for(int i=0;i<5;i++) bc[i]=st[j+i]; for(int i=0;i<5;i++) st[j+i]^=(~bc[(i+1)%5])&bc[(i+2)%5]; }
    st[0]^=RNDC[round];
  }
}

static void keccak256(const uint8_t*in, size_t len, uint8_t out[32]){
  uint64_t st[25]; memset(st,0,sizeof st);
  // single block only (len < 136 guaranteed by callers)
  uint8_t block[136]; memset(block,0,sizeof block);
  memcpy(block,in,len); block[len]=0x01; block[135]=0x80;
  for(int i=0;i<17;i++){ uint64_t lane=0; for(int j=0;j<8;j++) lane|=(uint64_t)block[i*8+j]<<(8*j); st[i]=lane; }
  keccakf(st);
  for(int i=0;i<4;i++){ uint64_t lane=st[i]; for(int j=0;j<8;j++) out[i*8+j]=(uint8_t)(lane>>(8*j)); }
}

// Precomputed base state for fixed salt+wallet; only lanes 9,10 vary with nonce.
static uint64_t BASE[25];
static void setup(const uint8_t salt[32], const uint8_t wal[20]){
  uint8_t block[136]; memset(block,0,sizeof block);
  memcpy(block, salt, 32);
  memcpy(block+32, wal, 20);
  // nonce bytes 52..83 left 0 here; padding:
  block[84]=0x01; block[135]=0x80;
  memset(BASE,0,sizeof BASE);
  for(int i=0;i<17;i++){ uint64_t lane=0; for(int j=0;j<8;j++) lane|=(uint64_t)block[i*8+j]<<(8*j); BASE[i]=lane; }
}
static inline int hash_bits(uint64_t nonce, uint8_t out[32]){
  uint64_t st[25]; memcpy(st, BASE, sizeof st);
  // payload bytes 76..79 = BE high 4 bytes of nonce -> lane 9 bytes 4..7 (LE)
  uint32_t hi=(uint32_t)(nonce>>32), lo=(uint32_t)nonce;
  st[9]  |= ((uint64_t)__builtin_bswap32(hi))<<32;
  // payload bytes 80..83 = BE low 4 bytes -> lane 10 bytes 0..3; byte 84 = 0x01 already in BASE lane10
  st[10] |= (uint64_t)__builtin_bswap32(lo);
  keccakf(st);
  for(int i=0;i<4;i++){ uint64_t lane=st[i]; for(int j=0;j<8;j++) out[i*8+j]=(uint8_t)(lane>>(8*j)); }
  int bits=0;
  for(int i=0;i<32;i++){ if(out[i]==0){ bits+=8; } else { bits+=__builtin_clz(out[i])-24; break; } }
  return bits;
}

static atomic_ullong g_next;      // next chunk id
static atomic_ullong g_tried;
static atomic_int g_stop;
static int TARGET;
static FILE* g_out; static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static uint64_t CHUNK = 1<<20;

static void* worker(void* arg){
  (void)arg;
  uint8_t out[32];
  while(!atomic_load(&g_stop)){
    uint64_t chunk = atomic_fetch_add(&g_next, 1);
    uint64_t base = chunk * CHUNK;
    for(uint64_t i=0;i<CHUNK;i++){
      uint64_t n = base + i;
      int b = hash_bits(n, out);
      if(b >= TARGET){
        pthread_mutex_lock(&g_mu);
        fprintf(g_out, "%llu %d\n", (unsigned long long)n, b); fflush(g_out);
        printf("HIT nonce=%llu bits=%d\n", (unsigned long long)n, b); fflush(stdout);
        pthread_mutex_unlock(&g_mu);
      }
    }
    atomic_fetch_add(&g_tried, CHUNK);
  }
  return NULL;
}

int main(int argc, char** argv){
  if(argc >= 2 && strcmp(argv[1], "kat") == 0){
    uint8_t o[32];
    keccak256((const uint8_t*)"", 0, o);
    printf("empty="); for(int i=0;i<32;i++) printf("%02x", o[i]); printf("\n");
    keccak256((const uint8_t*)"abc", 3, o);
    printf("abc="); for(int i=0;i<32;i++) printf("%02x", o[i]); printf("\n");
    keccak256((const uint8_t*)"chip404.trial.v1", 16, o);
    printf("salt="); for(int i=0;i<32;i++) printf("%02x", o[i]); printf("\n");
    return 0;
  }
  if(argc < 4){ fprintf(stderr, "usage: chipgrind <start> <bits> <outfile> [threads] [max_seconds] [dump_nonce]\n"); return 1; }
  // salt hash from the fixed string, verified externally against python keccak
  uint8_t salt[32];
  keccak256((const uint8_t*)"chip404.trial.v1", 16, salt);
  printf("salt=");
  for(int i=0;i<32;i++) printf("%02x", salt[i]);
  printf("\n");
  // wallet 0xfa0C48F3a5B10aBE43aF895d241E092888Bce31f
  uint8_t wal[20] = {0xfa,0x0C,0x48,0xF3,0xa5,0xB1,0x0a,0xBE,0x43,0xaF,0x89,0x5d,0x24,0x1E,0x09,0x28,0x88,0xBc,0xe3,0x1f};
  setup(salt, wal);
  if(argc >= 7){ // dump mode: print digest for one nonce (verification)
    uint8_t out[32]; uint64_t n = strtoull(argv[6], NULL, 10);
    int b = hash_bits(n, out);
    printf("nonce=%llu digest=", (unsigned long long)n);
    for(int i=0;i<32;i++) printf("%02x", out[i]);
    printf(" bits=%d\n", b);
    return 0;
  }
  uint64_t start = strtoull(argv[1], NULL, 10);
  TARGET = atoi(argv[2]);
  int threads = argc >= 5 ? atoi(argv[4]) : 4;
  int maxsec = argc >= 6 ? atoi(argv[5]) : 0;
  g_out = fopen(argv[3], "a");
  if(!g_out){ perror("outfile"); return 1; }
  atomic_store(&g_next, start / CHUNK);
  atomic_store(&g_tried, 0); atomic_store(&g_stop, 0);
  pthread_t th[64];
  for(int i=0;i<threads;i++) pthread_create(&th[i], NULL, worker, NULL);
  time_t t0 = time(NULL);
  while(!atomic_load(&g_stop)){
    sleep(10);
    unsigned long long tr = atomic_load(&g_tried);
    double el = difftime(time(NULL), t0);
    printf("[%.0fs] tried=%llu rate=%.2f MH/s\n", el, tr, el>0 ? tr/el/1e6 : 0); fflush(stdout);
    if(maxsec && el >= maxsec) atomic_store(&g_stop, 1);
  }
  for(int i=0;i<threads;i++) pthread_join(th[i], NULL);
  return 0;
}
