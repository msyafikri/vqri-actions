// Fast hash-tail brute forcer in C (Keccak-256, single/multi block absorb).
// usage: ./tail "<prefix ending in :>" <bits> [threads] [start_nonce] [step]
// step (optional): global stride across shards; thread i starts at start+i and strides by step.
// Prints {"nonce","hash","seconds"} JSON on stdout when found.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <time.h>

static const uint64_t RC[24] = {
  0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
  0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
  0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
  0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
  0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
  0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL
};
static const int ROT[25] = {0,1,62,28,27, 36,44,6,55,20, 3,10,43,25,39, 41,45,15,21,8, 18,2,61,56,14};
static const int PI[25] = {0,10,20,5,15, 16,1,11,21,6, 7,17,2,12,22, 23,8,18,3,13, 14,24,9,19,4};

static inline uint64_t rol(uint64_t x, int n){ return n ? (x << n) | (x >> (64 - n)) : x; }

static void keccakf(uint64_t S[25]){
  for(int round=0; round<24; round++){
    uint64_t C[5], D[5], B[25];
    for(int x=0;x<5;x++) C[x]=S[x]^S[x+5]^S[x+10]^S[x+15]^S[x+20];
    for(int x=0;x<5;x++) D[x]=C[(x+4)%5]^rol(C[(x+1)%5],1);
    for(int i=0;i<25;i++) S[i]^=D[i%5];
    for(int i=0;i<25;i++) B[PI[i]]=rol(S[i],ROT[i]);
    for(int y=0;y<5;y++) for(int x=0;x<5;x++){
      int i=x+5*y;
      S[i]=B[i]^((~B[((x+1)%5)+5*y])&B[((x+2)%5)+5*y]);
    }
    S[0]^=RC[round];
  }
}

#define RATE 136
// keccak256 of msg (len bytes) -> out32. Supports multi-block though our inputs are 1 block.
static void keccak256(const uint8_t* msg, size_t len, uint8_t out[32]){
  uint64_t S[25]={0};
  uint8_t block[RATE];
  size_t off=0;
  while(len-off>=RATE){
    for(int i=0;i<RATE/8;i++){ uint64_t w=0; memcpy(&w,msg+off+8*i,8); S[i]^=w; }
    keccakf(S); off+=RATE;
  }
  size_t rem=len-off;
  memset(block,0,RATE); memcpy(block,msg+off,rem); block[rem]=0x01; block[RATE-1]|=0x80;
  for(int i=0;i<RATE/8;i++){ uint64_t w=0; memcpy(&w,block+8*i,8); S[i]^=w; }
  keccakf(S);
  for(int i=0;i<4;i++){ uint64_t w=S[i]; memcpy(out+8*i,&w,8); }
}

static int leading_zeros(const uint8_t d[32]){
  int n=0; for(int i=0;i<32;i++){ if(d[i]){ return n + __builtin_clz(d[i]) - 24; } n+=8; } return n;
}

static const char* g_prefix; static int g_bits; static volatile int g_found=0;
static char g_nonce[32]; static uint8_t g_hash[32];
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static long g_start;

typedef struct { uint64_t start; uint64_t step; } targ;
static void* worker(void* p){
  targ* a=(targ*)p;
  char buf[512]; int plen=strlen(g_prefix);
  memcpy(buf,g_prefix,plen);
  uint8_t d[32];
  for(uint64_t n=a->start; !g_found; n+=a->step){
    int tl=snprintf(buf+plen, sizeof(buf)-plen, "%llu", (unsigned long long)n);
    keccak256((uint8_t*)buf, plen+tl, d);
    if(leading_zeros(d)>=g_bits){
      pthread_mutex_lock(&g_lock);
      if(!g_found){ g_found=1; snprintf(g_nonce,sizeof(g_nonce),"%llu",(unsigned long long)n); memcpy(g_hash,d,32); }
      pthread_mutex_unlock(&g_lock);
      return NULL;
    }
  }
  return NULL;
}

int main(int argc, char** argv){
  if(argc<3){ fprintf(stderr,"usage: tail \"<prefix:>\" <bits> [threads] [start]\n"); return 2; }
  g_prefix=argv[1]; g_bits=atoi(argv[2]);
  int threads = argc>3? atoi(argv[3]) : 2;
  uint64_t start0 = argc>4? strtoull(argv[4],NULL,10) : 0;
  uint64_t gstep = argc>5? strtoull(argv[5],NULL,10) : 0;
  // self-test: keccak256("") must be c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
  uint8_t d[32]; keccak256((uint8_t*)"",0,d);
  static const uint8_t expect[32]={0xc5,0xd2,0x46,0x01,0x86,0xf7,0x23,0x3c,0x92,0x7e,0x7d,0xb2,0xdc,0xc7,0x03,0xc0,0xe5,0x00,0xb6,0x53,0xca,0x82,0x27,0x3b,0x7b,0xfa,0xd8,0x04,0x5d,0x85,0xa4,0x70};
  if(memcmp(d,expect,32)){ fprintf(stderr,"KECCAK SELF-TEST FAILED\n"); return 3; }
  struct timespec t0; clock_gettime(CLOCK_MONOTONIC,&t0); g_start=t0.tv_sec;
  pthread_t th[64]; targ args[64];
  if(threads>64) threads=64;
  for(int i=0;i<threads;i++){ args[i].start=start0+i; args[i].step = gstep? gstep : (uint64_t)threads; pthread_create(&th[i],NULL,worker,&args[i]); }
  for(int i=0;i<threads;i++) pthread_join(th[i],NULL);
  struct timespec t1; clock_gettime(CLOCK_MONOTONIC,&t1);
  double sec=(t1.tv_sec-t0.tv_sec)+(t1.tv_nsec-t0.tv_nsec)/1e9;
  printf("{\"nonce\":\"%s\",\"hash\":\"0x", g_nonce);
  for(int i=0;i<32;i++) printf("%02x", g_hash[i]);
  printf("\",\"seconds\":%.1f}\n", sec);
  return 0;
}
