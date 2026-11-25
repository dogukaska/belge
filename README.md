# Belge Tarayıcı

Kamerayla belge tarar: sayfanın kenarlarını kendisi bulur, sabit tutunca otomatik çeker, eğikliği ve en-boy oranını düzeltir, gölgeyi temizler, PDF yapar. Her şey tarayıcıda; fotoğraflar hiçbir yere yüklenmez.

Adres: https://dogukaska.github.io/belge/

Sayfa köşeleri: [scanic](https://github.com/marquaye/scanic) yapay zeka köşe bulucusu (DocCornerNet, MIT) + OpenCV ile kenar çizgisi ince ayarı.

Kütüphaneler: [OpenCV.js](https://opencv.org) (Apache-2.0), [scanic / scanic-ml](https://github.com/marquaye/scanic) (MIT), [JSZip](https://github.com/Stuk/jszip) (MIT). PDF yazıcı kendi kodumuz (`lib/pdf.js`).
