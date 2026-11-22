# SENJA — Pencuri Pusaka

Prototipe game heist top-down 2D untuk kompetisi make.fun
`best-heist-game-20261122-0559` ($50, deadline Senin 23 Nov 2026 01:00 WIB).

## Cara main

Buka `senja-heist.html` di browser (satu file, tanpa network, tanpa library).

- **WASD / panah** — gerak
- **E (tahan) atau klik panel** — matikan alarm saat berdiri di dekat panel
- **R** — restart / lanjut misi
- Ambil semua pusaka, lalu kabur ke pintu **EKSTRAKSI** emas sebelum timer habis.
- Ketahuan penjaga / CCTV / laser = alarm naik. Alarm 100 = LOCKDOWN = kalah.

## Isi

| Misi | Loot | Penjaga | CCTV | Laser | Timer |
|------|------|---------|------|-------|-------|
| 1 Galeri Senja | 2 | 1 | 1 | — | 120 dtk |
| 2 Ruang Brankas | 3 | 2 | 2 | 1 | 150 dtk |
| 3 Mahkota Senja | 4 | 3 | 3 | 2 silang | 180 dtk |

Tema: galeri museum kota tua saat senja — palet dusk teal-amber,
lantai motif batik halus, loot bernama Indonesia
(Keris Pusaka, Topeng Emas, Kalung Zamrud, Mahkota Senja).

## Uji main (headless Chromium, 22 Nov 2026)

- Autoplay `?autoplay=1` menamatkan 3 misi: 16,7 dtk / 29,6 dtk / 39,1 dtk.
- 0 JS error di console.
- Screenshot staging `?stage=1..4` di `shots/`:
  1. menyusup awal, 2. cone penjaga dekat + loot menyala,
  3. mematikan alarm saat SUSPICIOUS, 4. kabur ke ekstraksi.
- `live1.png`: tangkapan autoplay tengah bermain.

## Mode uji

- `?autoplay=1` — bot penguji (pathfinding + hindari cone, pakai panel, mundur aman).
- `?stage=1..4` — staging beku untuk screenshot juri.

## Blueprint

`BLUEPRINT.md` — spesifikasi prosa lengkap untuk membangun ulang game ini
dari nol (sesi builder hanya boleh membaca blueprint itu).
