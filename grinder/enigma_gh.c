// EnigmaAgent grinder (fleet): keccak256(wallet(20) || nonce uint256 BE), wallet fixed.
// Message block (136B): wallet at 0..19, nonce low-64 BE at 44..51, pad 0x01 at 52, 0x80 at 135.
// Self-check vector: hash(nonce=0) = 1de4d642f94192d63a6f4aabc18e5d9cdf5d22b8006ea57b5c2999d0a2c8f94f
// CLI: ./enigma <nonce>                      -> print hash of nonce (argc==2)
//      ./enigma <bits> <threads> <start> <step> <seconds>  -> grind shard
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

// wallet 0xfa0C48F3a5B10aBE43aF895d241E092888Bce31f
static const uint8_t WALLET[20]={0xfa,0x0C,0x48,0xF3,0xa5,0xB1,0x0a,0xBE,0x43,0xaF,0x89,0x5d,0x24,0x1E,0x09,0x28,0x88,0xBc,0xe3,0x1f};
static uint64_t BASE[25];
static void setup(void){
  uint8_t blk[136]={0};
  memcpy(blk,WALLET,20);
  blk[52]=0x01; blk[135]=0x80;
  memset(BASE,0,sizeof BASE);
  for(int i=0;i<17;i++){ uint64_t lane=0; for(int j=0;j<8;j++) lane |= (uint64_t)blk[i*8+j]<<(8*j); BASE[i]=lane; }
}
static inline void hash_nonce(uint64_t nonce, uint8_t out[32]){
  uint64_t st[25]; memcpy(st, BASE, sizeof st);
  st[5]=((uint64_t)__builtin_bswap32((uint32_t)(nonce>>32)))<<32;
  st[6]=BASE[6] | (uint64_t)__builtin_bswap32((uint32_t)nonce);
  keccakf(st);
  for(int i=0;i<4;i++){ uint64_t lane=st[i]; for(int j=0;j<8;j++) out[i*8+j]=(uint8_t)(lane>>(8*j)); }
}
static int leading_zeros(const uint8_t h[32]){
  int z=0; for(int i=0;i<32;i++){ if(h[i]==0) z+=8; else { z+=__builtin_clz((unsigned)h[i])-24; break; } } return z;
}
static void hexhash(const uint8_t h[32], char* buf){ for(int i=0;i<32;i++) sprintf(buf+2*i,"%02x",h[i]); buf[64]=0; }

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
      if(z>cur){
        atomic_store(&best_nonce,nonce);
        char fh[65]; hexhash(h,fh);
        printf("{\"nonce\":%llu,\"zeros\":%d,\"hash\":\"%s\"}\n",(unsigned long long)nonce,z,fh); fflush(stdout);
        if(z>=TARGET){ printf("FOUND nonce=%llu lz=%d hash=%s\n",(unsigned long long)nonce,z,fh); fflush(stdout); }
      }
      if(z>=TARGET) atomic_store(&stop_flag,1);
    }
    nonce+=STEPG; it++;
    if((it&0xFFFFF)==0 && time(NULL)-T0>CAP) atomic_store(&stop_flag,1);
  }
  return NULL;
}
int main(int argc, char** argv){
  setup();
  if(argc==2){ uint64_t n=strtoull(argv[1],NULL,10); uint8_t h[32]; hash_nonce(n,h); char fh[65]; hexhash(h,fh); printf("%s\n",fh); return 0; }
  TARGET=atoi(argv[1]); NTHREADS=atoi(argv[2]); STARTG=strtoull(argv[3],NULL,10); STEPG=strtoull(argv[4],NULL,10); CAP=atol(argv[5]);
  atomic_store(&best_zeros,0); atomic_store(&best_nonce,0); atomic_store(&stop_flag,0);
  T0=time(NULL);
  pthread_t* th=malloc(sizeof(pthread_t)*NTHREADS);
  for(long i=0;i<NTHREADS;i++) pthread_create(&th[i],NULL,worker,(void*)i);
  for(int i=0;i<NTHREADS;i++) pthread_join(th[i],NULL);
  uint64_t bn=atomic_load(&best_nonce); int bz=atomic_load(&best_zeros); uint8_t h[32]; hash_nonce(bn,h);
  char fh[65]; hexhash(h,fh);
  printf("{\"final\":true,\"nonce\":%llu,\"zeros\":%d,\"hash\":\"%s\",\"elapsed\":%ld}\n",(unsigned long long)bn,bz,fh,(long)(time(NULL)-T0));
  return 0;
}
