# BLUEPRINT — Sokoban Solver make.fun (`sokoban-solver-01-run-20261121`)

**Status: SIAP dipakai builder.** Varian terpilih terbukti optimal di 1.200/1.200
instance sintetis (lokal + GitHub Actions, hasil identik) dan di practice set
5/5 (skor 1.000.000). Sisa risiko hanya ekor distribusi yang belum teramati
dan kecepatan CPU grader — keduanya ditutup margin budget di bawah.

**Untuk builder:** tulis `main.ts` BARU secara bertahap mengikuti rancangan ini.
Jangan menyalin file lab (`solver.mjs`) mentah-mentah — pindahkan rancangan +
parameter + jebakan di bawah ini. Aturan `thinking_reproduces` tetap berlaku.

## 0. Fakta lomba (dari kit, terverifikasi)

- `main.ts` Node 22, 5 instance/set, output `/output/<id>/solution.txt` (LURD).
- Skor/instance: 1.000 poin bila solved tepat P* pushes, else `500*P*/pushes`.
  Satu push lebih saja = <500 poin. Skor set = 1.000 × mean poin, maks 1.000.000.
  **Target = push-optimal di semua room, bukan sekadar selesai.**
- Level: hallway 1 kotak + 1–4 room (slot 6×6, 1 pintu), 3–4 box + goals per
  room, room independen (box keluar pintu tak bisa kembali). P* = jumlah
  optimum per room. Set tumbuh: 1 room 3 box, 1 room 4 box, lalu 2, 3, 4 room
  @4 box. Practice P*: 13, 16, 29, 47, 60.
- Runtime server: 60 detik wall untuk SELURUH set, 1 CPU, 512 MB, tanpa
  network. Dua eksekusi harus byte-identik → budget pakai JUMLAH KERJA
  (states/expansions), BUKAN jam. **Dilarang baca jam dinding, dilarang random.**
- Repo entry maks 1 MiB. Baseline rumah = plain A* atas MOVES (200k
  expansions, tanpa deadlock detection) — harus dikalahkan untuk hadiah
  (top 10 × $10). Baseline itu optimasi moves, bukan pushes, dan buta deadlock.
- Generator hanya menyimpan room yang solver referensi (BFS pushes, cap
  250k states) selesaikan dalam ≥12 pushes (3 box) / ≥14 (4 box). Jadi
  setiap room di set manapun PASTI terselesaikan BFS ≤250k states.
- DeepSeek consult: SUDAH dicoba 2× dan gagal (gateway timeout) — lanjut
  tanpa kritik eksternal.

## 1. Varian terpilih

**Primer: A* atas push-macro dengan heuristik assignment push-distance**
(mode `astar` di lab). Fallback ladder per room: `greedy` (best-first pada
heuristik yang sama), lalu `bfs`. Bila `roomsOf` gagal: solve whole-level
dengan ladder yang sama.

Alasan: `astar` ekspansi paling sedikit (rata-rata 91/room, maks 1.655 dari
2.640 room) sehingga paling jauh dari batas waktu; `astar_manh` dan `bfs`
juga 100% optimal di semua data, tapi ekspansi 3,5× / 36× lebih besar —
mereka adalah cadangan yang sudah teruji, bukan primer.

## 2. Algoritma final (langkah-demi-langkah)

### 2.1 Parsing level (XSB)

- Baris → `w, h`; `#` = wall; `.`/`*`/`+` = goal; `$`/`*` = box;
  `@`/`+` = player. Baris pendek / luar frame = wall.
- Simpan: `wall: Uint8Array`, `goals: number[]` (terurut), `boxes: number[]`
  (terurut), `player: number`. Indeks kotak = `y*w + x`.

### 2.2 Dead squares (live squares)

- Pull-back dari goals: kotak `g` live; dari kotak live `x`, kotak
  `y = x - d` menjadi live bila `y` bukan wall dan `y - d` bukan wall
  (box di `y` bisa di-push arah `d` ke `x`, dengan player berdiri di
  `y - d`). BFS sampai tetap.
- Box di kotak tidak-live = posisi mati: prune (return null untuk room itu).

### 2.3 Dekomposisi room (`roomsOf`)

- Baris player = hallway. Potong semua kotak floor di baris itu yang
  tidak-live (`cut`).
- Komponen terhubung dari floor yang tersisa (4-arah, abaikan `cut`+wall);
  tiap komponen yang berisi box = satu room (squares, boxes, goals).
- Gagal (return null) bila: ada box di `cut`, ada goal di `cut`, atau
  komponen mana pun berisi box ≠ goals. → fallback whole-level (§2.7).

### 2.4 Sub-level per room (solve room-by-room, urutan scan)

- Untuk room R: `wall' = wall` + semua box room lain dijadikan wall
  (room yang sudah selesai: goals-nya sebagai wall; belum: box-nya).
- Sub-level: `{w, h, wall', goals: R.goals, boxes: R.boxes, player}` dengan
  `player` = posisi player saat ini (awal = posisi di level; lalu ujung
  gerakan room sebelumnya).
- Selesaikan sub-level dengan pencarian §2.5/§2.6. Gabungkan `moves`.
  Player akhir = posisi setelah `moves` room itu.

### 2.5 Tabel push-distance (sekali per room, sebelum A*)

- Untuk SETIAP kotak live `s` dan SETIAP goal `g`: `dist[s][g]` = push
  minimum untuk mengantar SATU box dari `s` ke `g` dengan box lain
  diabaikan.
- Dihitung BFS atas state `(posisi box, low region player)` dengan box
  tunggal sebagai satu-satunya obstacle. Transisi push arah `d` dari box
  di `b` ke `t = b + d` sah bila: `t` floor, kotak belakang `b - d` floor,
  dan `b - d` berada di region player saat itu.
- **Krusial — seed dari SEMUA region:** untuk tiap `s`, hitung semua
  region floor-minus-box-`s` (flood dari tiap kotak floor yang belum
  dikunjungi), seed BFS dari `(s, low)` tiap region pada jarak 0, ambil
  jarak minimum. (Lihat jebakan §5: seed satu region saja = overestimate.)
- `dist = Infinity` bila tak tercapai. Kompleksitas: kotak live ≤ ~36,
  state BFS ≤ ~100 per start — murah.

### 2.6 A* per room (push-macro)

- State: `(boxes terurut, low region player)` — region = flood-fill dari
  posisi player dengan semua box sebagai dinding; `low` = kotak terendah
  region itu. Key state: angka basis-`size` (`low` lalu tiap box).
- `g` = pushes sejauh ini. `h` = min-cost assignment (semua permutasi,
  n ≤ 4 → ≤24) atas `dist[box_i][goal_j]`. Bila assignment Infinity →
  state mati (prune).
- `h` ini admissible + konsisten (tiap push menggerakkan tepat satu box
  sejauh 1; `dist` adalah lower bound per box; lihat §5 untuk syaratnya).
  A* dengan `h` konsisten + closed-set = optimal.
- Suksesor: untuk tiap box `b` dan arah `d`: push ke `t` sah bila player
  bisa berdiri di `b - d` (kotak itu di region saat ini), `t` floor,
  `t` bukan box lain, `t` live, dan tidak membentuk frozen 2×2
  (blok 2×2 wall/box dengan satu box di luar goal).
- Heap biner dengan tie-break deterministik: `(f, h, g desc, indeks)`,
  `f = g + h`. Tanpa jam, tanpa random.
- Budget: maks **100.000 expansions** per room (§3). Bila heap habis
  tanpa solusi → room gagal → fallback (§2.7).
- Rekonstruksi `moves`: dari state solusi, telusur parent; tiap push =
  `walkTo` (BFS jalan terpendek, huruf kecil, urutan arah u,d,l,r) dari
  posisi player ke kotak belakang box + huruf push (U/D/L/R).

### 2.7 Tangga fallback (per room, budget TERPISAH per rung)

1. `astar`, budget 100.000 expansions/room.
2. Bila habis → `greedy` (best-first, `f = h`, heuristik sama), budget
   100.000 expansions/room. Greedy selalu solved di lab (600/600) tapi
   hanya ~40% optimal — dipakai demi poin parsial (`500*P*/pushes`),
   bukan 0.
3. Bila habis → `bfs` (tanpa heuristik), budget 200.000 expansions/room.
   BFS dijamin generator ≤250k untuk tiap room; 200k sudah mencakup
   maks teramati 17.466 dengan margin 11×.
4. Bila `roomsOf` null → terapkan ladder yang sama pada whole-level
   (belum pernah terjadi di data generator; pengaman saja).
5. **Cap global:** hitung kumulatif expansions seluruh set; bila melewati
   **600.000**, room-room sisa langsung `greedy`-only. Ini menjaga total
   kerja di bawah batas wall apa pun yang terjadi di ekor distribusi.

### 2.8 Driver set (main.ts)

- Baca `/input/<id>/level.txt` untuk tiap id (urut abjad), selesaikan,
  tulis `/output/<id>/solution.txt` (buat dir bila perlu).
- Input/output dir dari env `MAKEFUN_INPUT_DIR`/`MAKEFUN_OUTPUT_DIR`
  (default `/input`, `/output`) seperti starter kit.
- Bila satu room/instance gagal total (semua rung habis): tulis
  solution kosong (`""`) untuk instance itu — jangan crash, jangan
  biarkan instance lain tanpa file. (Tak pernah terjadi di 1.200 instance
  uji; pengaman saja.)
- Satu-satunya sumber variasi yang diizinkan: isi `/input`. Tidak ada
  `Date`, `Math.random`, atau baca env selain dir input/output.

## 3. Parameter final

| Parameter | Nilai | Alasan |
|---|---|---|
| Pencarian primer | A* push-distance | ekspansi terkecil, 100% optimal |
| Budget A*/room | 100.000 expansions | 60× maks teramati (1.655); ~4× batas tersirat cap generator (BFS ≤250k → A* ≲25k) |
| Fallback rung 2 | greedy, 100.000/room | selalu solved di lab |
| Fallback rung 3 | BFS, 200.000/room | mencakup maks teramati 17.466 (11×) |
| Cap global set | 600.000 expansions kumulatif → sisa room greedy-only | kerja total terikat; ~20–40 dtk worst-case di CPU grader (estimasi §4) |
| Heuristik | assignment push-distance (§2.5) | admissible + konsisten bila dihitung min-atas-semua-region |
| Pruning | dead-square + frozen 2×2 | keduanya aman (tak pernah memangkas solusi) |
| Tie-break heap | (f, h, g desc, indeks) | deterministik penuh |
| Jam / random | TIDAK ADA | determinisme byte-identik |

## 4. Data uji

### 4.1 Practice set (kit, P* dari manifest)

| Varian | Optimal | Skor |
|---|---|---|
| astar | 5/5 (13,16,29,47,60) | 1.000.000 |
| astar_manh | 5/5 | 1.000.000 |
| bfs | 5/5 | 1.000.000 |

### 4.2 Lokal — 240 set sintetis, 1.200 instance, budget 300k/room, tanpa fallback

Set digambar lokal dengan generator kit dari seed
`sha256("sokoban-lab-set-<n>")`, n = 0..239; P* = ground truth generator.
Level + keys tersimpan di `sets.tar.gz`.

| Varian | Solved | Optimal | Mean poin | Rasio pushes/P* terburuk | Ekspansi/room maks | Waktu/set p50 / p95 / maks |
|---|---|---|---|---|---|---|
| **astar** | 1200/1200 | **1200/1200 (100%)** | 1000 | 1,00 | **1.655** | 32 / 65 / **139 ms** |
| astar_manh | 1200/1200 | 1200/1200 (100%) | 1000 | 1,00 | 7.996 | 56 / 107 / 258 ms |
| bfs | 1200/1200 | 1200/1200 (100%) | 1000 | 1,00 | 17.466 | 317 / 496 / 625 ms |
| greedy (mandiri) | 1200/1200 | 480/1200 (40%) | 659,5 | 2,00 | 4.478 | 82 ms mean |

Ekspansi/room astar (2.640 room): p50 = 27, p95 = 391, p99 = 759,
maks 1.655; hanya 10 room >1.000 ekspansi. Laju di box lab (1,5 CPU
berbagi, terbebani): astar ~28k eksp/dtk, BFS ~108k eksp/dtk.
Seluruh set terberat 139 ms di sini → di CPU grader (1 CPU, ~2–3× lebih
lambat) ≈ <0,5 dtk. Margin terhadap batas 60 dtk: >100× pada rezim
teramati. Cap global 600k ekspansi ≈ 20–40 dtk worst-case di grader.

### 4.3 GitHub Actions — 240 set yang sama, 8 shard paralel

Workflow `.github/workflows/sokoban-sweep.yml`
(`workflow_dispatch`, `setup-node@v4` Node 22, artifact per shard).

| Run | Varian | Hasil | Set maks |
|---|---|---|---|
| 44950278614 | astar | 240 set, 1200/1200 optimal, ekspansi maks 1.655 (identik dengan lokal) | 102 ms |
| 44950289536 | bfs | 240 set, 1200/1200 optimal, ekspansi maks 17.466 (identik dengan lokal) | 478 ms |

State count identik lintas mesin = pencarian deterministik penuh
(verifikasi independen atas klaim byte-identik).

### 4.4 Tangga fallback — 120 set (600 instance), sengaja dicekik

- `astar` budget 100 + `greedy` budget 300.000 (terpisah): 600/600
  solved, 49,7% optimal, mean 716,7 poin. Mekanisme tangga bekerja.
- Bukti negatif: saat fallback memakai budget YANG SAMA dengan primer
  (100), hasil jatuh ke 282/600 solved, mean 421,5 — **budget rung harus
  terpisah** (§2.7).

## 5. Daftar jebakan (semua ditemukan + diperbaiki di lab)

1. **Tabel push-distance harus min atas SEMUA region player.** Versi awal
   men-seed BFS dari satu region (region kotak player awal di hallway).
   Bila box menutup pintu, region itu terputus dari interior room →
   `dist` overestimate → A* mengembalikan solusi SUBOPTIMAL (21 vs P*
   15) dan memangkas state solvable sebagai mati (22/600 instance gagal).
   Perbaikan: seed dari tiap region (§2.5). Setelah perbaikan: 1200/1200.
2. **Tabel harus mencakup SEMUA kotak live, bukan hanya posisi box awal.**
   Setelah box bergerak, lookup posisi baru mengembalikan `undefined` →
   heuristik Infinity → semua suksesor dibuang (0/5 practice). Perbaikan:
   hitung `dist` untuk tiap kotak live.
3. **Box di pintu memutus region.** Ini akar jebakan 1: region player
   dengan box di pintu ≠ region tanpa box. Semua perhitungan region harus
   selalu dilakukan DENGAN box yang sedang dipindah sebagai obstacle,
   dari kotak player yang sebenarnya.
4. **Manhattan saja tidak cukup kuat tapi aman.** `astar_manh` 100%
   optimal di data, ekspansi ~3,5× astar. Cadangan yang sah bila tabel
   push-distance diragukan — tapi jangan jadikan primer.
5. **Greedy bukan solver utama.** 100% solved tapi 40% optimal, rasio
   terburuk 2,0× P*. Hanya untuk tangga fallback.
6. **Satu push lebih = skor <500.** Optimasi moves (seperti baseline)
   tidak sama dengan optimasi pushes. Jangan pernah menukar 1 push demi
   jalan yang lebih pendek.
7. **Urutan room = urutan scan `roomsOf`.** Player transit antar room
   lewat hallway; box room lain = dinding saat walk. Jangan mengasumsikan
   player kembali ke posisi awal tiap room.
8. **Budget dari jumlah kerja, bukan jam.** Setiap rung + cap global
   dihitung dari expansions. `Date.now`/`performance.now` di entry =
   nondeterministik = tidak berperingkat.
9. **Ukuran repo 1 MiB.** Solver ini ~19 KB sebagai `.mjs`; versi
   `main.ts` akan seukuran itu — jauh di bawah batas. Jangan sertakan
   tabel lookup besar.
10. **Tulis solution kosong, bukan crash,** bila sebuah instance gagal
    total — instance lain tetap terselamatkan.

## 6. Yang BELUM terverifikasi

- **Scored set belum digambar** (drand round 34200012, final phase
  23 Nov 03:10 UTC). Semua angka di atas dari practice + 240 set sintetis
  dari generator yang sama — distribusinya sama, tapi instance pastinya
  belum ada.
- **Kecepatan CPU grader (1 CPU)** hanya diestimasi: faktor 2–3× dari box
  lab/CI. Worst-case absolut (semua room di cap generator) tidak tercapai
  di 2.640 room teramati (maks BFS 17.466 dari cap 250k); cap global
  600k ekspansi adalah pengaman untuk ekor ini.
- **Tidak ada kritik DeepSeek** (gateway timeout 2×). Keputusan desain =
  Muse + data lab saja.
- **Whole-level fallback** (roomsOf null) belum pernah terpicu di data
  generator — logikanya ada sebagai pengaman, belum teruji end-to-end
  pada level nyata.

## 7. File lab (repo fleet `msyafikri/vqri-actions`)

- `makefun-sokoban/solver.mjs` — varian solver (lab, bukan entry).
- `makefun-sokoban/sweep.mjs` — harness + replay verifier mandiri.
- `makefun-sokoban/sets.tar.gz` — 240 set sintetis + `keys.json` (P*).
- `makefun-sokoban/README.md` — ringkasan lab.
- `.github/workflows/sokoban-sweep.yml` — sweep CI (run 44950278614 astar,
  44950289536 bfs).
- Salinan lokal blueprint ini: `~/workspace/makefun/sokoban-lab/BLUEPRINT.md`;
  ringkasan sweep lokal: `sweep240_*.json` di folder lab repo.
