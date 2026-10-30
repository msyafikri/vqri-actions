// CastDeep grinder v2: compact optimized Keccak-f1600 + constant-state precompute.
// hash = keccak256(challenge(32) || nonce uint256 BE). Nonce fits uint64 (lane 7).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>

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

// lanes 0..6 from challenge+nonce-high zeros, lane 7 = bswap(nonce), lane 8 = 0x01 (pad), lane 16 = 0x80<<56
static uint64_t BASE[25];
static void setup(const uint8_t ch[32]){
  memset(BASE,0,sizeof BASE);
  // message bytes 0..31 = challenge -> lanes 0..3 (LE loads)
  for(int i=0;i<4;i++){ uint64_t lane=0; for(int j=0;j<8;j++) lane |= (uint64_t)ch[i*8+j]<<(8*j); BASE[i]=lane; }
  // bytes 32..55 are nonce high bytes = 0 -> lanes 4,5,6 = 0
  // byte 64 = 0x01 -> lane 8 low byte = 0x01
  BASE[8]=0x01ULL;
  // byte 135 = 0x80 -> lane 16 top byte
  BASE[16]=0x8000000000000000ULL;
}
static inline void hash_nonce(uint64_t nonce, uint8_t out[32]){
  uint64_t st[25]; memcpy(st, BASE, sizeof st);
  st[7]=__builtin_bswap64(nonce);
  keccakf(st);
  for(int i=0;i<4;i++){ uint64_t lane=st[i]; for(int j=0;j<8;j++) out[i*8+j]=(uint8_t)(lane>>(8*j)); }
}
static int leading_zeros(const uint8_t h[32]){
  int z=0; for(int i=0;i<32;i++){ if(h[i]==0) z+=8; else { z+=__builtin_clz((unsigned)h[i])-24; break; } } return z;
}

static atomic_int best_zeros; static atomic_uint_fast64_t best_nonce; static atomic_int stop_flag;
static int TARGET; static long CAP; static time_t T0;
static uint64_t STARTG, STEPG; static int NTHREADS;
static void* worker(void* arg){
  long tid=(long)arg; uint64_t nonce=STARTG+(uint64_t)tid; uint8_t h[32]; uint64_t it=0;
  while(!atomic_load(&stop_flag)){
    hash_nonce(nonce,h);
    int z=leading_zeros(h);
    if(z>atomic_load(&best_zeros)){
      int cur=atomic_load(&best_zeros);
      while(z>cur && !atomic_compare_exchange_weak(&best_zeros,&cur,z)){}
      if(z>cur){ atomic_store(&best_nonce,nonce); printf("{\"nonce\":%llu,\"zeros\":%d}\n",(unsigned long long)nonce,z); fflush(stdout); }
      if(z>=TARGET) atomic_store(&stop_flag,1);
    }
    nonce+=STEPG; it++;
    if((it&0xFFFFF)==0 && time(NULL)-T0>CAP) atomic_store(&stop_flag,1);
  }
  return NULL;
}
int main(int argc, char** argv){
  uint8_t ch[32]; const char* hex=argv[1];
  for(int i=0;i<32;i++){ unsigned v; sscanf(hex+2*i,"%2x",&v); ch[i]=(uint8_t)v; }
  setup(ch);
  if(argc==3){ uint64_t n=strtoull(argv[2],NULL,10); uint8_t h[32]; hash_nonce(n,h); for(int i=0;i<32;i++) printf("%02x",h[i]); printf("\n"); return 0; }
  TARGET=atoi(argv[2]); NTHREADS=atoi(argv[3]); STARTG=strtoull(argv[4],NULL,10); STEPG=strtoull(argv[5],NULL,10); CAP=atol(argv[6]);
  atomic_store(&best_zeros,0); atomic_store(&best_nonce,0); atomic_store(&stop_flag,0);
  T0=time(NULL);
  pthread_t* th=malloc(sizeof(pthread_t)*NTHREADS);
  for(long i=0;i<NTHREADS;i++) pthread_create(&th[i],NULL,worker,(void*)i);
  for(int i=0;i<NTHREADS;i++) pthread_join(th[i],NULL);
  uint64_t bn=atomic_load(&best_nonce); int bz=atomic_load(&best_zeros); uint8_t h[32]; hash_nonce(bn,h);
  printf("{\"final\":true,\"nonce\":%llu,\"zeros\":%d,\"hash\":\"",(unsigned long long)bn,bz);
  for(int i=0;i<32;i++) printf("%02x",h[i]); printf("\",\"elapsed\":%ld}\n",(long)(time(NULL)-T0));
  return 0;
}
