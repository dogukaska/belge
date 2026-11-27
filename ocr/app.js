import { bitmapOf } from "../lib/photo.js?v=1";

const $ = id => document.getElementById(id);
let running = false;
function update() {
  $("run").disabled=running||!$("file").files.length;
  $("file").disabled=running;
  $("copy").disabled=$("download").disabled=running||!$("result").value.trim();
}
$("file").addEventListener("change",()=>{$("status").textContent="";$("result").value="";update();});
$("result").addEventListener("input",update);
$("run").addEventListener("click",async ()=>{
  const file=$("file").files[0];
  if(running||!file) return;
  running=true;update();$("result").value="";
  $("status").textContent="Türkçe okuma motoru hazırlanıyor…";
  let worker,bitmap,canvas;
  try {
    if(!file.size||file.size>30*1024*1024) throw Error("30 MB’tan küçük bir görsel seç.");
    bitmap=await bitmapOf(file);
    const ratio=Math.min(1,2600/Math.max(bitmap.width,bitmap.height));
    canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    const ctx=canvas.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    worker=await window.Tesseract.createWorker("tur",1,{
      workerPath:"/pdf-epub/vendor/tesseract/worker.min.js",corePath:"/pdf-epub/vendor/tesseract/core/",
      langPath:"/pdf-epub/lang",logger:event=>{
        if(event.status==="recognizing text") $("status").textContent="Metin okunuyor… %"+Math.round(event.progress*100);
      },
    });
    const {data}=await worker.recognize(canvas);
    $("result").value=data.text.trim();
    $("status").textContent=$("result").value?"Metin hazır. Düzeltip kopyalayabilirsin.":"Okunabilir metin bulunamadı.";
  } catch(e) {$("status").textContent=typeof e==="string"?e:e.message||"Metin okunamadı.";}
  finally {
    bitmap?.close?.();if(canvas) canvas.width=canvas.height=0;
    await worker?.terminate().catch(()=>{});
    running=false;update();
  }
});
$("copy").addEventListener("click",async ()=>{
  try {await navigator.clipboard.writeText($("result").value);$("status").textContent="Kopyalandı.";}
  catch {$("result").select();$("status").textContent="Metin seçildi. Kopyalama komutunu kullan.";}
});
$("download").addEventListener("click",()=>{
  const url=URL.createObjectURL(new Blob([$("result").value],{type:"text/plain;charset=utf-8"}));
  const link=document.createElement("a");link.href=url;link.download="belge-metni.txt";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
});
