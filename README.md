# Belge Tarayıcı

Kamerayla belge tarar: sayfanın kenarlarını kendisi bulur, sabit tutunca otomatik çeker, eğikliği ve en-boy oranını düzeltir, gölgeyi temizler, PDF yapar. Her şey tarayıcıda; fotoğraflar hiçbir yere yüklenmez.

Adres: https://dogukaska.github.io/belge/

Sayfa köşeleri: [scanic](https://github.com/marquaye/scanic) yapay zeka köşe bulucusu (DocCornerNet, MIT) + OpenCV ile kenar çizgisi ince ayarı.

Sayfa düzleştirme (kıvrık/eğik sayfa, vFlat benzeri): [UVDoc](https://github.com/tanguymagne/UVDoc) modeli (MIT), ONNX Runtime Web ile tarayıcıda; ızgara tam çözünürlüğe uygulanır (`lib/flatten.js`, `lib/uv-worker.js`). Belge modunda A4e yakın sayfalar tam A4 oranına getirilir. Sayfa kenarına değen parmaklar kâğıt rengiyle kapatılır.

Kütüphaneler: [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), [OpenCV.js](https://opencv.org) (Apache-2.0), [scanic / scanic-ml](https://github.com/marquaye/scanic) (MIT), [JSZip](https://github.com/Stuk/jszip) (MIT). PDF yazıcı kendi kodumuz (`lib/pdf.js`).

Belge Tarayıcı’nın kamera, sayfa düzenleme ve renkli kapak aktarımı akışları OpenAI Codex desteğiyle geliştirildi ve test edildi.
