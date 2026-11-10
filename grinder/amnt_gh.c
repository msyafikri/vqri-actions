// amnt_gh.c — grinder AMNT (Agent Mining, BSC 0x2d07B9CcDF5FCdbE26167358B94eeb4c9E995e4E).
// proof = keccak256(abi.encode(seed(32) || wallet(32) || agentId(32) || lane(32) || day(32) || nonce(32)))
//         preimage 192 byte (2 blok absorb rate-136); lolos bila uint256(digest) <= target.
// Diadaptasi dari pearl_gh.c (inti Keccak-f1600 sama; layout preimage + pembanding 256-bit beda).
// Wallet & agentId default = wallet/Agent ID vqri (terverifikasi on-chain), bisa dioverride via env
//   AMNT_WALLET=<40 hex> dan AMNT_AGENTID=<desimal>.
// Mode:
//   amnt_gh <seed_hex64> verify <nonce>   -> cetak digest nonce tsb (verifikasi vs proofDigest/grind.py)
//   amnt_gh <seed_hex64> grind <day> <lane> <target_desimal> <threads> <start> <step> <cap_detik>
//        -> streaming: tiap nonce lolos dicetak satu baris JSON {"nonce":N,"digest":"hex"};
//           di akhir satu baris JSON {"hashes":H,"elapsed":S}
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

// parse bilangan desimal besar (<= 2^256) -> 4 limb big-endian (limb[0] paling signifikan)
static int parse_u256_dec(const char* s, uint64_t limb_be[4]){
  uint64_t u[4]={0,0,0,0}; // little-endian sementara
  for(const char* p=s; *p; p++){
    if(*p<'0'||*p>'9') return -1;
    uint64_t carry=(uint64_t)(*p-'0');
    for(int i=0;i<4;i++){ __uint128_t v=(__uint128_t)u[i]*10+carry; u[i]=(uint64_t)v; carry=(uint64_t)(v>>64); }
    if(carry) return -1;
  }
  for(int i=0;i<4;i++) limb_be[i]=u[3-i];
  return 0;
}
static void u256_to_bytes_be(const uint64_t limb_be[4], uint8_t out[32]){
  for(int i=0;i<4;i++) for(int j=0;j<8;j++) out[i*8+j]=(uint8_t)(limb_be[i]>>(56-8*j));
}

static uint8_t PRE[192];       // preimage statis (nonce word di byte 160..191 diisi per-hash via lane)
static uint64_t TEMPLATE[25];  // state sesudah absorb blok1 + blok2 statis + padding; lane 6 blok2 = nonce
static uint64_t TARGET_LIMB[4];

static void setup(const uint8_t seed[32], const uint8_t wallet[20], const uint64_t agentid_be[4], uint64_t day, uint64_t lane){
  memset(PRE,0,sizeof PRE);
  memcpy(PRE+0, seed, 32);                       // seed
  memcpy(PRE+44, wallet, 20);                    // address: 12 byte nol + 20 byte alamat (offset 32..63)
  u256_to_bytes_be(agentid_be, PRE+64);          // agentId
  for(int j=0;j<8;j++){ PRE[96+24+j]=(uint8_t)(lane>>(56-8*j)); PRE[128+24+j]=(uint8_t)(day>>(56-8*j)); }
  // absorb blok 1 (byte 0..135)
  uint64_t st[25]; memset(st,0,sizeof st);
  for(int i=0;i<17;i++){ uint64_t l=0; for(int j=0;j<8;j++) l|=(uint64_t)PRE[i*8+j]<<(8*j); st[i]^=l; }
  keccakf(st);
  // blok 2 statis (byte 136..191) kecuali lane 6 (byte 184..191 = 8 byte terakhir nonce word)
  for(int i=0;i<7;i++){
    if(i==6) continue;
    uint64_t l=0; for(int j=0;j<8;j++) l|=(uint64_t)PRE[136+i*8+j]<<(8*j); st[i]^=l;
  }
  st[7]^=0x01ULL;                                // padding 0x01 di byte 192 (offset 56 blok 2)
  st[16]^=0x8000000000000000ULL;                 // bit akhir rate di byte 135 blok 2
  memcpy(TEMPLATE, st, sizeof st);
}
static inline void hash_nonce(uint64_t nonce, uint8_t out[32]){
  uint64_t st[25]; memcpy(st, TEMPLATE, sizeof st);
  st[6]^=__builtin_bswap64(nonce);               // nonce word byte 24..31 (lane 6 blok 2) — XOR, bukan assign: TEMPLATE sudah berisi state hasil permutasi blok 1
  keccakf(st);
  for(int i=0;i<4;i++){ uint64_t lane=st[i]; for(int j=0;j<8;j++) out[i*8+j]=(uint8_t)(lane>>(8*j)); }
}
static inline int digest_leq_target(const uint64_t st_lanes_not_used, const uint8_t h[32]){
  (void)st_lanes_not_used;
  for(int i=0;i<4;i++){
    uint64_t limb=0; for(int j=0;j<8;j++) limb=(limb<<8)|(uint64_t)h[i*8+j];
    if(limb<TARGET_LIMB[i]) return 1;
    if(limb>TARGET_LIMB[i]) return 0;
  }
  return 1;
}

static atomic_int stop_flag;
static atomic_uint_fast64_t total_hashes;
static pthread_mutex_t print_lock = PTHREAD_MUTEX_INITIALIZER;
static long CAP; static time_t T0;
static uint64_t STARTG, STEPG;
static void* worker(void* arg){
  long tid=(long)arg; uint64_t nonce=STARTG+(uint64_t)tid; uint8_t h[32]; uint64_t it=0;
  while(!atomic_load(&stop_flag)){
    hash_nonce(nonce,h);
    if(digest_leq_target(0,h)){
      pthread_mutex_lock(&print_lock);
      printf("{\"nonce\":%llu,\"digest\":\"",(unsigned long long)nonce);
      for(int i=0;i<32;i++) printf("%02x",h[i]);
      printf("\"}\n"); fflush(stdout);
      pthread_mutex_unlock(&print_lock);
    }
    nonce+=STEPG; it++;
    if((it&0xFFFF)==0){
      atomic_fetch_add(&total_hashes,0x10000);
      if(time(NULL)-T0>CAP) atomic_store(&stop_flag,1);
    }
  }
  return NULL;
}

static const char* DEFAULT_WALLET_HEX = "fa0C48F3a5B10aBE43aF895d241E092888Bce31f";
static const char* DEFAULT_AGENTID_DEC = "8570027782354062739075737039481937779970299619441480422511763668300868081993";

int main(int argc, char** argv){
  if(argc<3){ fprintf(stderr,"usage: amnt_gh <seed_hex> verify <nonce> | amnt_gh <seed_hex> grind <day> <lane> <target_dec> <threads> <start> <step> <cap>\n"); return 64; }
  uint8_t seed[32]; const char* hex=argv[1];
  if(strlen(hex)!=64){ fprintf(stderr,"seed harus 64 hex char\n"); return 64; }
  for(int i=0;i<32;i++){ unsigned v; sscanf(hex+2*i,"%2x",&v); seed[i]=(uint8_t)v; }

  const char* whex = getenv("AMNT_WALLET"); if(!whex) whex = DEFAULT_WALLET_HEX;
  if(strlen(whex)>=2 && whex[0]=='0' && (whex[1]=='x'||whex[1]=='X')) whex+=2;
  if(strlen(whex)!=40){ fprintf(stderr,"wallet harus 40 hex char\n"); return 64; }
  uint8_t wallet[20];
  for(int i=0;i<20;i++){ unsigned v; sscanf(whex+2*i,"%2x",&v); wallet[i]=(uint8_t)v; }
  const char* aid = getenv("AMNT_AGENTID"); if(!aid) aid = DEFAULT_AGENTID_DEC;
  uint64_t agentid_be[4];
  if(parse_u256_dec(aid, agentid_be)!=0){ fprintf(stderr,"agentId desimal tidak valid\n"); return 64; }

  int is_grind = strcmp(argv[2],"grind")==0;
  uint64_t day=0, lane=2;
  if(is_grind){
    if(argc<10){ fprintf(stderr,"grind butuh: <day> <lane> <target_dec> <threads> <start> <step> <cap>\n"); return 64; }
    day=strtoull(argv[3],NULL,10); lane=strtoull(argv[4],NULL,10);
    if(parse_u256_dec(argv[5], TARGET_LIMB)!=0){ fprintf(stderr,"target desimal tidak valid\n"); return 64; }
  } else {
    // mode verify memakai parameter test-vector hari berjalan? day/lane bisa dioverride via env
    const char* d=getenv("AMNT_DAY"); if(d) day=strtoull(d,NULL,10);
    const char* l=getenv("AMNT_LANE"); if(l) lane=strtoull(l,NULL,10);
  }
  setup(seed, wallet, agentid_be, day, lane);
  if(!is_grind){
    if(argc<4){ fprintf(stderr,"verify butuh <nonce>\n"); return 64; }
    uint64_t n=strtoull(argv[3],NULL,10); uint8_t h[32]; hash_nonce(n,h);
    for(int i=0;i<32;i++) printf("%02x",h[i]); printf("\n"); return 0;
  }
  int nthreads=atoi(argv[6]); STARTG=strtoull(argv[7],NULL,10); STEPG=strtoull(argv[8],NULL,10); CAP=atol(argv[9]);
  atomic_store(&stop_flag,0); atomic_store(&total_hashes,0);
  T0=time(NULL);
  pthread_t* th=malloc(sizeof(pthread_t)*nthreads);
  for(long i=0;i<nthreads;i++) pthread_create(&th[i],NULL,worker,(void*)i);
  for(int i=0;i<nthreads;i++) pthread_join(th[i],NULL);
  printf("{\"hashes\":%llu,\"elapsed\":%ld}\n",(unsigned long long)atomic_load(&total_hashes),(long)(time(NULL)-T0));
  fflush(stdout);
  return 0;
}
