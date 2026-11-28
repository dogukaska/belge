# Belge Tarayıcı

Kamerayla belge tarar: sayfanın kenarlarını kendisi bulur, sabit tutunca otomatik çeker, eğikliği ve en-boy oranını düzeltir, gölgeyi temizler, PDF yapar. Her şey tarayıcıda; fotoğraflar hiçbir yere yüklenmez.

Adres: https://dogukaska.github.io/belge/

Sayfa köşeleri: [scanic](https://github.com/marquaye/scanic) yapay zeka köşe bulucusu (DocCornerNet, MIT) + OpenCV ile kenar çizgisi ince ayarı.

Sayfa düzleştirme (kıvrık/eğik sayfa, vFlat benzeri): [UVDoc](https://github.com/tanguymagne/UVDoc) modeli (MIT), ONNX Runtime Web ile tarayıcıda; ızgara tam çözünürlüğe uygulanır (`lib/flatten.js`, `lib/uv-worker.js`). Belge modunda A4e yakın sayfalar tam A4 oranına getirilir. Sayfa kenarına değen parmaklar kâğıt rengiyle kapatılır.

Kütüphaneler: [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), [OpenCV.js](https://opencv.org) (Apache-2.0), [scanic / scanic-ml](https://github.com/marquaye/scanic) (MIT), [JSZip](https://github.com/Stuk/jszip) (MIT). PDF yazıcı kendi kodumuz (`lib/pdf.js`).

Belge Tarayıcı’nın otomatik sayfa algılama ve düzleştirme özelliklerine Claude, kamera, sayfa düzenleme ve renkli kapak aktarımının geliştirme ve test çalışmalarına OpenAI Codex katkıda bulundu.

Ek PDF araçları [PDF-Lib](https://github.com/Hopding/pdf-lib), [Fontkit](https://github.com/Hopding/fontkit), [PDF.js](https://github.com/mozilla/pdf.js), [Tesseract.js](https://github.com/naptha/tesseract.js) ve Türkçe karakterleri içeren [DejaVu](https://dejavu-fonts.github.io/) altkümeleri kullanır.

PDF araçlarının geliştirilmesi, tarama akışının incelenmesi ve dosya testleri OpenAI Codex desteğiyle yapıldı.

Tarama modelinin yüklenme zamanı ve fotoğraftan Türkçe OCR’ın tarayıcı uyumluluğu OpenAI Codex desteğiyle geliştirildi.

[PDF’yi Görsele Çevir](https://dogukaska.github.io/belge/gorsele-cevir/), seçili sayfaları tarayıcıda PNG veya JPG olarak ayrı ayrı hazırlar. Birden fazla görsel JSZip ile tek ZIP dosyasına konur. Araç ve kontroller OpenAI Codex desteğiyle geliştirildi.
