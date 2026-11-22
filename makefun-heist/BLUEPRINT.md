# BLUEPRINT — SENJA: Pencuri Pusaka

Spesifikasi prosa lengkap untuk membangun ulang game heist ini dari nol.
Sesi builder hanya boleh memakai dokumen ini. Jangan membuka atau menyalin
kode prototipe. Semua angka di sini adalah angka final hasil uji main.

## 1. Ringkasan game

Nama game: SENJA — Pencuri Pusaka. Genre: stealth top-down dua dimensi,
satu pemain menyusup ke galeri dan museum kota tua saat senja, mencuri
pusaka, lalu kabur sebelum timer habis tanpa memicu alarm sampai LOCKDOWN.

Tema visual: senja, bukan tengah malam. Palet dusk teal-amber khas:
arsitektur biru gelap yang desaturasi, ancaman merah, loot dan ekstraksi
emas, pemain dan interaksi sian-hijau. Lantai membawa motif batik halus
sangat samar sebagai aksen. Nama level dan loot berbahasa Indonesia.
Jangan memakai nama klise seperti Midnight Vault atau Gilded Vault.

Satu file HTML mandiri: seluruh gaya dan logika inline di dalam file,
canvas tunggal, tanpa network, tanpa library eksternal, tanpa aset gambar.
Ukuran canvas 1280 kali 800 piksel. Bar atas HUD setinggi 64 piksel.
Area bermain di bawahnya 1280 kali 720 piksel, dibagi grid 32 kolom
kali 18 baris, tiap tile 40 kali 40 piksel. Kolom dihitung 0 sampai 31
dari kiri, baris 0 sampai 17 dari atas area bermain.

## 2. Struktur file

File terdiri dari, berurutan: penanda dokumen dan gaya halaman
(latar gelap, canvas di tengah); satu elemen canvas; satu blok skrip.

Di dalam skrip, susunannya: konstanta ukuran dan palet warna; definisi
tiga level; objek state permainan; fungsi-fungsi utilitas geometri;
fungsi pemuatan level; fungsi deteksi; penangan input keyboard dan mouse;
fungsi update per frame; fungsi-fungsi gambar; fungsi HUD; fungsi overlay
menang dan kalah; mode autoplay untuk pengujian; mode stage untuk
screenshot; lalu loop animasi utama.

## 3. Palet warna

Lantai utama heksadesimal 16232E, varian lantai 182A33. Dinding 26313F
dengan garis tepi atas emas D9A441. Motif batik emas transparan tujuh
persen dan motif batik teal transparan enam persen. Pemain sian 39D5C0
dengan bayangan gelap 0E7A6C. Penjaga merah FF4747 dengan badan 8C1F28
dan kerucut pandang merah transparan. Kamera oranye FF8C42 dengan badan
7A4A12. Laser merah muda FF2E63 dengan node FF7AA2. Emas loot F5B942,
emas gelap C98A1B, emas terang FFE9A8. Panel alarm hijau 2FD6A3 dengan
dasar gelap 0D5C44. Teks utama F2E9D8, teks redup 9FB0BD, bahaya FF4D4D.
Latar HUD 0D141C.

## 4. Mekanik inti

Gerak: tombol WASD atau panah, kecepatan pemain 172 piksel per detik,
radius tabrakan 13 piksel. Gerakan diagonal dinormalisasi supaya tidak
lebih cepat. Tabrakan lingkaran terhadap dinding dan prop, sumbu X dan Y
diuji terpisah supaya pemain bisa meluncur di sepanjang dinding.

Penjaga: berjalan dari titik ke titik sepanjang daftar waypoint, berhenti
sebentar 0,35 detik di tiap titik balik, lalu berbalik. Arah hadap sama
dengan arah gerak. Kerucut pandang: jangkauan 185 piksel, setengah sudut
0,52 radian. Pemain terlihat bila berada di dalam jarak dan sudut itu
dan garis pandang tidak terhalang dinding. Jarak sangat dekat di bawah
42 piksel membuat penjaga melihat pemain dari arah mana pun selama garis
pandang bersih.

Kamera CCTV: terpasang di dinding atas, menyapu kiri-kanan mengikuti
sudut dasar menghadap bawah ditambah simpangan yang berayun. Frustum
lebih lebar dari kerucut penjaga dan berwarna oranye, bukan merah.
Jangkauan 230 sampai 240 piksel menurut level, setengah sudut 0,5 radian,
kecepatan sapuan 0,55 radian per detik.

Laser tripwire: garis lurus antara dua emitter di kedua ujung, menyala
dan mati bersiklus. Saat menyala, pemain yang menyentuh garis dalam
jarak 15 piksel menerima 25 poin alarm sekaligus, kilat merah singkat
di layar, dan laser itu kebal selama satu detik supaya tidak memicu
berulang. Emitter digambar sebagai node terang di kedua ujung.

Alarm: skala 0 sampai 100. Di bawah 40 berlabel CLEAR, 40 sampai 79
SUSPICIOUS, 80 sampai 99 LOCKDOWN, 100 berarti tertangkap dan kalah.
Saat terlihat, alarm naik sesuai laju deteksi level; saat tidak terlihat,
alarm turun 20 poin per detik. Saat LOCKDOWN, kecepatan penjaga dikali
1,45 dan vignette merah berdenyut muncul di tepi layar.

Panel alarm: satu konsol per level. Berdiri dalam radius 62 piksel lalu
tahan tombol E atau tahan klik mouse di atas panel selama 1,2 detik
untuk mematikan alarm menjadi nol. Ada cincin progres di sekeliling
panel dan teks persen saat proses berjalan. Panel hanya bisa dipakai
sekali per level. Bila pemain menjauh, progres menyusut.

Loot: tiap loot berupa belah ketupat emas berdenyut dengan lingkaran
cahaya dan label nama di atasnya. Tersentuh dalam radius 28 piksel
maka terkumpul, pesan singkat muncul, dan ada bunyi bip pendek.
Pintu ekstraksi terkunci selama loot belum lengkap, ditandai ikon
gembok dan warna abu-abu. Setelah semua loot terkumpul, pintu berubah
emas menyala dengan label KELUAR. Menyentuh pintu dalam radius 34
piksel saat loot lengkap berarti misi selesai.

Timer: hitung mundur per level. Nol berarti kalah dengan alasan waktu
habis. Timer di bawah 30 detik berkedip merah.

Menang dan kalah: setelah misi terakhir selesai, tampil layar HEIST
BERHASIL dengan total waktu dan jumlah pusaka. Kalah tampil layar GAGAL
dengan alasan (tertangkap atau waktu habis). Kedua layar punya tombol
besar emas; klik tombol atau tekan R untuk main lagi atau lanjut misi.
Antar misi ada layar MISI SELESAI dengan tombol LANJUT.

## 5. Angka keseimbangan final

Kecepatan pemain 172 piksel per detik. Kecepatan penjaga: misi satu 56,
misi dua 66, misi tiga 78. Laju deteksi penjaga per detik: 40, 46, 52.
Laju deteksi kamera 32 per detik. Deteksi jarak dekat 72 per detik.
Peluruhan alarm 20 per detik. Laser plus 25 alarm. Timer: misi satu
120 detik, misi dua 150 detik, misi tiga 180 detik. Jumlah loot: 2, 3, 4.

## 6. HUD

Satu bar atas tipis setinggi 64 piksel, latar gelap, garis emas di
bawahnya. Tiga zona. Kiri: ikon belah ketupat emas dan teks LOOT
diikuti jumlah terkumpul dan total, huruf monospace tebal 20 piksel.
Tengah: timer paling besar, monospace tebal 34 piksel, format menit
dua digit titik dua detik dua digit, dengan label kecil TIMER di
bawahnya. Kanan: label ALARM diikuti status CLEAR, SUSPICIOUS, atau
LOCKDOWN, berwarna hijau, kuning, atau merah; di bawah label ada bar
tersegmentasi enam blok, terisi dari kiri, warna blok naik dari kuning
ke oranye ke merah. Status LOCKDOWN membuat label berdenyut.

Bawah kiri layar: nama misi dan objektif berjalan, misalnya ambil dua
pusaka lalu kabur, atau kabur ke pintu ekstraksi bila loot sudah
lengkap. Bawah kanan: petunjuk kontrol singkat. Pesan kejadian
(misalnya loot didapat atau laser kena) muncul sebagai papan kecil
di tengah atas area bermain selama 2,2 detik.

## 7. Denah level

Semua level memakai border dinding penuh di sekeliling. Titik awal
pemain selalu baris 1 kolom 1, sudut kiri atas. Pintu ekstraksi selalu
di baris 17, dinding bawah, sebagai satu tile lantai emas di tengah
dinding. Koordinat di bawah memakai kolom 0 sampai 31 dan baris 0
sampai 17.

### Misi satu — Galeri Senja

Timer 120 detik, satu penjaga, satu kamera, tanpa laser, dua loot.

Dinding dalam: dinding vertikal kolom 8 baris 1 sampai 5, dan kolom 17
baris 1 sampai 5; baris 5 kolom 8 sampai 11 dan kolom 14 sampai 17;
baris 7 kolom 3 sampai 5, kolom 12 sampai 14, dan kolom 22 sampai 24;
baris 11 sama seperti baris 7; baris 13 kolom 8 sampai 11 dan kolom 14
sampai 17; dinding vertikal kolom 8 baris 13 sampai 16, dan kolom 17
baris 13 sampai 16.

Loot Keris Pusaka di baris 2 kolom 23, di ruangan kanan atas. Loot
Topeng Emas di baris 9 kolom 9, di aula tengah kiri. Panel alarm di
baris 15 kolom 23, ruangan kanan bawah. Pintu ekstraksi di baris 17
kolom 13.

Penjaga berpatroli horizontal di baris 8, bolak-balik kolom 4 sampai
kolom 27. Kamera di kolom 16 baris 0, menghadap ke bawah, sapuan
plus minus 0,9 radian, jangkauan 230.

Prop: Etalase kolom 14 sampai 16 baris 9; Meja kolom 20 sampai 22
baris 13; Bangku kolom 5 sampai 6 baris 6; Pot kolom 25 sampai 26
baris 10. Prop adalah penghalang berbentuk persegi panjang dengan
label huruf kecil di tengahnya.

### Misi dua — Ruang Brankas

Timer 150 detik, dua penjaga, dua kamera, satu laser, tiga loot.

Dinding dalam: dinding vertikal kolom 7, kolom 14, dan kolom 23,
masing-masing baris 1 sampai 4 dan baris 14 sampai 16; baris 5 kolom
7 sampai 10, kolom 13 sampai 15, dan kolom 18 sampai 21; baris 7
kolom 5 sampai 7, kolom 12 sampai 14, kolom 19 sampai 21, dan kolom
26; baris 9 kolom 14 sampai 17; baris 11 sama seperti baris 7; baris
13 sama seperti baris 5.

Loot Kalung Zamrud di baris 2 kolom 18; Cincin Pusaka di baris 9
kolom 3; Patung Perunggu di baris 9 kolom 27. Panel alarm di baris
15 kolom 18. Pintu ekstraksi di baris 17 kolom 12.

Penjaga pertama patroli horizontal baris 8 kolom 4 sampai 27.
Penjaga kedua patroli horizontal baris 12 kolom 5 sampai 26. Kamera
pertama kolom 8 baris 0, kamera kedua kolom 24 baris 0, keduanya
menghadap bawah, sapuan plus minus 0,8 radian, jangkauan 235.

Laser horizontal di baris 6, dari kolom 10 sampai kolom 22, menyala
3 detik lalu mati 2 detik, berulang. Prop: Brankas kolom 14 sampai 17
baris 10; Etalase kolom 5 sampai 6 baris 6; Meja kolom 24 sampai 25
baris 10; Pot kolom 13 sampai 14 baris 2.

### Misi tiga — Mahkota Senja

Timer 180 detik, tiga penjaga, tiga kamera, dua laser silang, empat loot.

Dinding dalam: dinding vertikal kolom 6, kolom 12, kolom 19, dan
kolom 25, masing-masing baris 1 sampai 4 dan baris 14 sampai 16;
baris 5 kolom 6 sampai 8, kolom 10 sampai 14, kolom 16 sampai 20,
dan kolom 22 sampai 24; baris 7 kolom 3 sampai 5, kolom 10 sampai
13, kolom 18 sampai 21, dan kolom 26 sampai 28; baris 9 kolom 19
sampai 22; baris 11 sama seperti baris 7; baris 13 sama seperti
baris 5.

Loot Mahkota Senja di baris 2 kolom 9; Keris Pusaka di baris 2
kolom 15; Kalung Zamrud di baris 2 kolom 22; Topeng Emas di baris 9
kolom 8. Panel alarm di baris 15 kolom 9. Pintu ekstraksi di baris
17 kolom 10.

Penjaga pertama patroli horizontal baris 8 kolom 3 sampai 28.
Penjaga kedua patroli horizontal baris 12 kolom 28 sampai 3, arah
berlawanan. Penjaga ketiga patroli vertikal kolom 16 baris 6 sampai
12. Kamera di kolom 6, 16, dan 26, semuanya baris 0 menghadap bawah,
sapuan plus minus 0,9 radian, jangkauan 240.

Laser pertama horizontal di baris 6, kolom 8 sampai 24, menyala 3
detik mati 2 detik, fase nol. Laser kedua vertikal di kolom 22,
baris 7 sampai 13, menyala 2,5 detik mati 2,5 detik, fase 1,5 detik,
sehingga kedua laser tidak pernah menyala bersamaan penuh. Prop:
Tahta kolom 14 sampai 17 baris 9; Etalase kolom 5 sampai 6 baris 6;
Meja kolom 25 sampai 26 baris 10; Pot kolom 13 sampai 14 baris 15.

## 8. Gambar dan suasana

Lantai digambar dari pola ubin 80 kali 80 piksel yang diulang: latar
gelap, empat kelopak elips membentuk motif kawung di tiap sudut ubin
dengan garis emas sangat samar, plus titik-titik teal kecil. Di atas
lantai ada cahaya senja: gradasi radial oranye hangat dari sudut kanan
atas dengan opasitas puncak sepuluh persen.

Dinding digambar solid per tile; garis emas setebal tiga piksel hanya
di sisi atas tile dinding yang berbatasan langsung dengan lantai,
bukan di semua sisi, supaya dinding vertikal terlihat padat bukan
bergaris-garis. Sisi bawah dinding yang berbatasan lantai diberi
bayangan gelap empat piksel.

Kerucut penjaga digambar sebagai kipas gradasi radial merah yang
memudar ke ujung, dengan dua garis tepi putus-putus. Frustum kamera
sama tetapi oranye dan sedikit lebih lebar. Pemain digambar sebagai
lingkaran sian dengan garis arah hadap putih dan label KAMU di atasnya,
dikelilingi lingkaran cahaya lembut. Penjaga berupa lingkaran merah
gelap dengan garis arah dan titik putih. Loot berdenyut dengan
sinus waktu. Vignette gelap di sudut layar selalu ada; vignette merah
muncul saat alarm LOCKDOWN. Kilat merah memenuhi layar sesaat saat
laser kena.

Urutan gambar dari bawah ke atas: lantai dan motif, cahaya senja,
kerucut dan frustum, dinding, prop, laser, pintu ekstraksi, panel
alarm, loot, kamera, penjaga, pemain, vignette, kilat laser, lalu HUD,
pesan, dan overlay.

## 9. Mode pengujian dan staging

Mode autoplay diaktifkan lewat parameter alamat bertanda autoplay sama
dengan satu. Bot penguji memakai pencarian jalur berbobot di grid:
tiap tile tetangga diberi biaya satu ditambah biaya bahaya, yaitu
300 untuk tile di dalam kerucut penjaga, 250 untuk tile di dalam
frustum kamera, 200 untuk tile di dekat garis laser yang sedang
menyala, dan 200 untuk tile sangat dekat penjaga. Bot menghitung ulang
jalur tiap 0,6 detik. Prioritas target: bila alarm di atas 35 dan
panel belum dipakai, pergi ke panel; bila tidak, pergi ke loot
terdekat yang belum diambil; bila semua loot sudah diambil, pergi ke
pintu ekstraksi. Bila alarm di atas 70 dan panel sudah dipakai, bot
mundur ke tile aman terdekat dan menunggu sampai alarm turun di bawah
30. Saat misi selesai dalam mode ini, permainan lanjut otomatis ke
misi berikut setelah satu detik.

Mode stage diaktifkan lewat parameter alamat bertanda stage satu
sampai empat, semuanya memakai misi satu dengan keadaan dibekukan
(timer, alarm, dan progres panel tidak berubah selama staging).
Stage satu: pemain di awal penyusupan, baris 6 kolom 2. Stage dua:
pemain di baris 4 kolom 21, dekat loot Keris Pusaka, penjaga dipindah
ke baris 7 kolom 21 menghadap ke atas ke arah pemain. Stage tiga:
alarm 58 alias SUSPICIOUS, pemain di samping panel alarm, progres
mematikan 55 persen. Stage empat: semua loot sudah diambil, pemain
di baris 14 kolom 13, dekat pintu ekstraksi emas yang menyala.

## 10. Perbaikan dari uji main

Sepuluh perbaikan dilakukan berdasarkan tiga kali uji autoplay penuh
dan pemeriksaan visual screenshot.

Pertama, bot penguji pernah macet di layar misi selesai karena tidak
ada yang menekan tombol lanjut; mode autoplay kini lanjut otomatis
setelah satu detik.

Kedua, pintu ekstraksi misi tiga awalnya tertutup dinding di atasnya
sehingga tidak bisa dicapai; pintu dipindah dari kolom 12 ke kolom 10.

Ketiga, ada lubang lantai di dinding bawah misi dua dan tiga akibat
baris peta yang kependekan; baris diperbaiki menjadi 32 karakter.

Keempat, misi tiga terlalu mematikan: laju deteksi penjaga diturunkan
dari 58 ke 52 per detik, peluruhan alarm dinaikkan dari 14 ke 20 per
detik, laju kamera diturunkan dari 38 ke 32, penalti laser diturunkan
dari 30 ke 25, jangkauan kerucut dipendekkan dari 195 ke 185 piksel.

Kelima, dinding vertikal awalnya bergaris-garis seperti tangga karena
garis emas digambar di tiap tile; kini garis emas hanya di sisi atas
yang menghadap lantai.

Keenam, label pintu ekstraksi awalnya terpotong tepi bawah layar;
label dipindah ke atas pintu.

Ketujuh, staging ketiga awalnya kehilangan status SUSPICIOUS sebelum
screenshot diambil karena alarm meluruh; mode stage kini membekukan
timer, alarm, dan progres.

Kedelapan, dua prop awalnya menumpuk dinding; Brankas misi dua
dipindah ke baris 10, Pot misi tiga dipindah ke kolom 13 sampai 14.

Kesembilan, timer misi satu dipangkas dari 150 ke 120 detik supaya
tekanan waktu terasa, setelah bot menamatkannya dalam 17 detik.

Kesepuluh, bot penguji diperkuat: bobot bahaya dinaikkan tajam,
ambang pergi ke panel diturunkan dari 55 ke 35, dan perilaku mundur
ke tempat aman ditambahkan.

## 11. Hasil uji main final

Tiga kali uji autoplay penuh berturut-turut semuanya menang, nol
error JavaScript di console. Waktu tempuh bot per misi pada uji
terakhir: misi satu 16,1 detik, misi dua 28,6 detik, misi tiga 19,6
detik, total 64,3 detik waktu permainan untuk sembilan pusaka.
Waktu antar uji bervariasi karena posisi patroli acak di awal;
kisaran misi tiga 19 sampai 39 detik. Timer manusia jauh lebih
longgar dari waktu bot, tekanannya datang dari alarm, bukan timer.

## 12. Catatan screenshot

Empat frame staging 1280 kali 800, semuanya keadaan bermain nyata.

Frame satu, menyusup awal: pemain di kiri atas dekat pintu masuk,
kerucut penjaga merah membentang ke kanan di tengah, frustum kamera
oranye dari atas, dua loot emas menyala di kanan atas dan tengah,
panel alarm hijau di kanan bawah, pintu ekstraksi terkunci di bawah
tengah, HUD lengkap terbaca.

Frame dua, cone dekat dan loot menyala: pemain di kanan atas tepat
di samping loot Keris Pusaka yang berdenyut, penjaga di bawah pemain
dengan kerucut merah mengarah ke atas ke arah pemain, loot kedua
terlihat di tengah kiri, ketegangan terbaca dalam sekejap.

Frame tiga, mematikan alarm saat SUSPICIOUS: alarm menunjukkan
SUSPICIOUS oranye dengan tiga dari enam segmen terisi, pemain berdiri
di panel hijau kanan bawah dengan cincin progres dan teks mematikan
55 persen, kerucut penjaga dan frustum kamera tetap terlihat di
tengah dan atas.

Frame empat, kabur ke ekstraksi: LOOT dua dari dua, pintu ekstraksi
emas menyala dengan label KELUAR dan label EKSTRAKSI di atasnya,
pemain tepat di atas pintu, objektif bawah kiri berubah menjadi
perintah kabur.

Satu frame tambahan dari autoplay tengah bermain menunjukkan
permainan berjalan hidup di luar staging.

## 13. Yang harus dijaga saat membangun ulang

Satu file, tanpa network, tanpa library. Semua elemen penentu genre
harus terlihat dalam satu frame: kerucut penjaga, frustum kamera,
loot menyala, dan meter alarm. HUD satu bar atas dengan timer di
tengah. Alarm tersegmentasi enam blok dengan label status, bukan bar
kontinu. Palet disiplin satu warna per fungsi. Denah harus punya
hierarki ruang dan prop berlabel, bukan kotak kosong. Game harus bisa
ditamatkan manusia: jaga keseimbangan angka di bagian lima, dan uji
dengan autoplay sampai tiga misi selesai sebelum dianggap matang.
