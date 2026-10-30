// Cast Deep PoW grinder (Keccak-256, challenge || nonce uint256 BE).
// usage: ./castdeep <challenge_hex64> <target_bits> <threads> <start> <step> <seconds_cap>
// Prints a JSON line to stdout every time the global best improves, and a final line at exit.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>

static const uint64_t RC[24] = {
  0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
  0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
  0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
  0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
  0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
  0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL};
static const int R[25] = {0,1,62,28,27, 36,44,6,55,20, 3,10,43,25,39, 41,45,15,21,8, 18,2,61,56,14};
static const int P[25] = {0,10,20,5,15, 16,1,11,21,6, 7,17,2,12,22, 23,8,18,3,13, 14,24,9,19,4};

static inline uint64_t rol(uint64_t x, int n){ return n ? ((x<<n)|(x>>(64-n))) : x; }
static void keccakf(uint64_t a[25]){
  for(int round=0; round<24; round++){
    uint64_t c[5], d[5], b[25];
    for(int x=0;x<5;x++) c[x]=a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20];
    for(int x=0;x<5;x++) d[x]=c[(x+4)%5]^rol(c[(x+1)%5],1);
    for(int i=0;i<25;i++) a[i]^=d[i%5];
    for(int i=0;i<25;i++) b[P[i]]=rol(a[i], R[i]);
    for(int y=0;y<5;y++) for(int x=0;x<5;x++)
      a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);
    a[0]^=RC[round];
  }
}
static void hash_nonce(const uint8_t ch[32], uint64_t nonce, uint8_t out[32]){
  uint8_t block[136]; memset(block,0,sizeof block);
  memcpy(block, ch, 32);
  for(int i=0;i<8;i++) block[56+i] = (uint8_t)(nonce >> (56-8*i));
  block[64]=0x01; block[135]|=0x80;
  uint64_t a[25]; memset(a,0,sizeof a);
  for(int i=0;i<17;i++){ uint64_t lane=0; for(int j=0;j<8;j++) lane |= (uint64_t)block[i*8+j] << (8*j); a[i]=lane; }
  keccakf(a);
  for(int i=0;i<4;i++){ uint64_t lane=a[i]; for(int j=0;j<8;j++) out[i*8+j]=(uint8_t)(lane>>(8*j)); }
}
static int leading_zeros(const uint8_t h[32]){
  int z=0;
  for(int i=0;i<32;i++){ if(h[i]==0){ z+=8; } else { z += __builtin_clz((unsigned)h[i]) - 24; break; } }
  return z;
}

static uint8_t CH[32];
static atomic_int best_zeros;
static atomic_uint_fast64_t best_nonce;
static atomic_int stop_flag;
static int TARGET, THREADS;
static uint64_t START, STEP;
static long CAP;
static time_t T0;
static pthread_mutex_t print_mu = PTHREAD_MUTEX_INITIALIZER;

static void report(uint64_t nonce, int z, const uint8_t h[32]){
  pthread_mutex_lock(&print_mu);
  printf("{\"nonce\":%llu,\"zeros\":%d,\"hash\":\"", (unsigned long long)nonce, z);
  for(int i=0;i<32;i++) printf("%02x", h[i]);
  printf("\",\"elapsed\":%ld}\n", (long)(time(NULL)-T0));
  fflush(stdout);
  pthread_mutex_unlock(&print_mu);
}

static void* worker(void* arg){
  long tid = (long)arg;
  uint64_t nonce = START + (uint64_t)tid;
  uint8_t h[32];
  uint64_t iters = 0;
  while(!atomic_load(&stop_flag)){
    hash_nonce(CH, nonce, h);
    int z = leading_zeros(h);
    if(z > atomic_load(&best_zeros)){
      int cur = atomic_load(&best_zeros);
      while(z > cur && !atomic_compare_exchange_weak(&best_zeros, &cur, z)){}
      if(z > cur){ atomic_store(&best_nonce, nonce); report(nonce, z, h); }
      if(z >= TARGET) atomic_store(&stop_flag, 1);
    }
    nonce += STEP; iters++;
    if((iters & 0xFFFFF) == 0 && time(NULL) - T0 > CAP) atomic_store(&stop_flag, 1);
  }
  return NULL;
}

int main(int argc, char** argv){
  const char* hex = argv[1];
  for(int i=0;i<32;i++){ unsigned v; sscanf(hex+2*i, "%2x", &v); CH[i]=(uint8_t)v; }
  TARGET = atoi(argv[2]); THREADS = atoi(argv[3]);
  START = strtoull(argv[4], NULL, 10); STEP = strtoull(argv[5], NULL, 10);
  CAP = atol(argv[6]);
  atomic_store(&best_zeros, 0); atomic_store(&best_nonce, 0); atomic_store(&stop_flag, 0);
  T0 = time(NULL);
  pthread_t* th = malloc(sizeof(pthread_t)*THREADS);
  for(long i=0;i<THREADS;i++) pthread_create(&th[i], NULL, worker, (void*)i);
  for(int i=0;i<THREADS;i++) pthread_join(th[i], NULL);
  uint64_t bn = atomic_load(&best_nonce); int bz = atomic_load(&best_zeros);
  uint8_t h[32]; hash_nonce(CH, bn, h);
  printf("{\"final\":true,\"nonce\":%llu,\"zeros\":%d,\"hash\":\"", (unsigned long long)bn, bz);
  for(int i=0;i<32;i++) printf("%02x", h[i]);
  printf("\",\"elapsed\":%ld}\n", (long)(time(NULL)-T0));
  return 0;
}
