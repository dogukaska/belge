import * as pdfjs from "/pdf-epub/vendor/pdfjs/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf-epub/vendor/pdfjs/pdf.worker.min.mjs";
const $ = id => document.getElementById(id);
const pages = [];
let busy = false, serial = 0;
const mergeMode = new URLSearchParams(location.search).get("arac") === "birlestir";
if (mergeMode) { document.title = "PDF Birleştir · Dijital Çakı"; document.querySelector("h1").textContent = "PDF Birleştir"; }
const status = text => { $("status").textContent = text; };
function update() {
  $("download").disabled = busy || !pages.some(p => p.selected);
  $("all").disabled = $("none").disabled = busy || !pages.length;
  $("file").disabled = busy;
  for (const el of $("pages").querySelectorAll("button,input")) el.disabled = busy || el.dataset.edge === "true";
}
function button(label, action, edge=false) {
  const el = document.createElement("button");
  el.type="button"; el.textContent=label; el.dataset.edge=String(edge); el.addEventListener("click",action);
  return el;
}
function draw() {
  $("pages").replaceChildren();
  pages.forEach((page,i) => {
    const row=document.createElement("li"), thumb=document.createElement("div"), details=document.createElement("div");
    row.className="sheet"; row.id="row-"+page.id; thumb.className="pdf-thumb";
    if (page.canvas) thumb.append(page.canvas);
    const title=document.createElement("p"), label=document.createElement("label"), selected=document.createElement("input");
    title.textContent=(i+1)+". "+page.name+" · Sayfa "+(page.index+1);
    selected.type="checkbox"; selected.checked=page.selected;
    selected.setAttribute("aria-label",page.name+" sayfa "+(page.index+1)+" seç");
    selected.addEventListener("change",() => { page.selected=selected.checked; update(); });
    label.append(selected," İndirmeye ekle");
    const grip=document.createElement("span");
    grip.className="page-grip"; grip.textContent="⠿"; grip.title="Sürükleyerek sırala"; grip.setAttribute("aria-hidden","true");
    grip.addEventListener("pointerdown", startDrag);
    const actions=document.createElement("div");
    actions.className="row";
    const move=to => {
      [pages[to],pages[i]]=[pages[i],pages[to]];
      draw();
      $("row-"+page.id).querySelector("input").focus();
    };
    const rotate=() => {
      page.rotation=(page.rotation+90)%360;
      if(page.canvas) page.canvas.style.transform="rotate("+page.rotation+"deg)";
      status("Sayfa "+page.rotation+"° döndürüldü.");
    };
    actions.append(button("Yukarı",()=>move(i-1),i===0),
      button("Aşağı",()=>move(i+1),i===pages.length-1), button("Döndür",rotate),
      button("Çıkar",()=>{pages.splice(i,1);draw();$("pages").querySelector("input")?.focus();status("Sayfa listeden çıkarıldı.");}));
    details.append(title,label,actions); row.append(grip,thumb,details); $("pages").append(row);
  });
  update();
}
let dragging;
function targetRow(event) {
  return document.elementFromPoint(event.clientX, event.clientY)?.closest("#pages .sheet");
}
function startDrag(event) {
  if (busy || dragging || event.button !== 0) return;
  const grip = event.currentTarget;
  dragging = { row: grip.closest(".sheet"), pointer: event.pointerId };
  grip.setPointerCapture(event.pointerId);
  grip.addEventListener("pointermove", trackDrag);
  grip.addEventListener("pointerup", finishDrag);
  grip.addEventListener("lostpointercapture", cancelDrag);
  dragging.row.classList.add("dragging");
}
function trackDrag(event) {
  if (dragging?.pointer !== event.pointerId) return;
  const target = targetRow(event);
  if (dragging.target === target) return;
  dragging.target?.classList.remove("drop-page");
  dragging.target = target;
  if (target !== dragging.row) target?.classList.add("drop-page");
}
function cancelDrag(event) {
  const grip = event.currentTarget;
  grip.removeEventListener("pointermove", trackDrag);
  grip.removeEventListener("pointerup", finishDrag);
  grip.removeEventListener("lostpointercapture", cancelDrag);
  dragging?.row.classList.remove("dragging");
  dragging?.target?.classList.remove("drop-page");
  dragging = undefined;
}
function finishDrag(event) {
  const from = pages.findIndex(page => "row-" + page.id === dragging.row.id);
  const to = pages.findIndex(page => "row-" + page.id === targetRow(event)?.id);
  cancelDrag(event);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = pages.splice(from, 1);
  pages.splice(to, 0, moved);
  draw();
  status("Sayfa " + (to + 1) + ". sıraya taşındı.");
}

async function renderThumb(reader,page) {
  const pdfPage=await reader.getPage(page.index+1);
  try {
    const original=pdfPage.getViewport({scale:1});
    const viewport=pdfPage.getViewport({scale:Math.min(1,130/Math.max(original.width,original.height))});
    const canvas=document.createElement("canvas");
    canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
    canvas.setAttribute("aria-hidden","true");
    await pdfPage.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
    page.canvas=canvas;
  } finally { pdfPage.cleanup(); }
}
$("file").addEventListener("change",async () => {
  const files=[...$("file").files];
  $("file").value="";
  if (!files.length || busy) return;
  busy=true; update();
  const errors=[];
  try {
    for (const file of files) {
      status(file.name+" açılıyor…");
      let reader;
      try {
        const total=[...new Set(pages.map(p=>p.source))].reduce((sum,src)=>sum+src.size,0);
        if (!file.size || total+file.size>100*1024*1024) throw Error("toplam sınır 100 MiB");
        const bytes=await file.arrayBuffer();
        const source={doc:await window.PDFLib.PDFDocument.load(bytes),size:file.size};
        const count=source.doc.getPageCount();
        if (!count || pages.length+count>250) throw Error("toplam sınır 250 sayfa");
        const items=Array.from({length:count},(_,index)=>({id:++serial,source,index,name:file.name,selected:true,rotation:0}));
        pages.push(...items);
        try {
          reader=await pdfjs.getDocument({data:bytes,isEvalSupported:false,cMapUrl:"/pdf-epub/vendor/pdfjs/cmaps/",cMapPacked:true,
            standardFontDataUrl:"/pdf-epub/vendor/pdfjs/standard_fonts/"}).promise;
          let missing=0;
          for (const page of items) await renderThumb(reader,page).catch(()=>{missing++;});
          if (missing) errors.push(file.name+" için "+missing+" sayfa önizlenemedi.");
        } catch { errors.push(file.name+" önizlenemedi."); }
      } catch(e) { errors.push(file.name+" açılamadı ("+(e.message||"geçersiz dosya")+")."); }
      finally { await reader?.destroy().catch(()=>{}); }
    }
  } finally { busy=false;draw();status(pages.length+" sayfa hazır. "+errors.join(" ")); }
});
for (const [id,value] of [["all",true],["none",false]]) $(id).addEventListener("click",()=>{
  pages.forEach(p=>{p.selected=value;}); draw();
});
$("download").addEventListener("click",async ()=>{
  const selected=pages.filter(p=>p.selected);
  if (!selected.length || busy) return;
  busy=true;update();status("PDF hazırlanıyor…");
  try {
    const result=await window.PDFLib.PDFDocument.create();
    const grouped=new Map(), copies=new Map();
    for(const item of selected) {
      if(!grouped.has(item.source)) grouped.set(item.source,[]);
      grouped.get(item.source).push(item);
    }
    for(const [source,items] of grouped) {
      const batch=await result.copyPages(source.doc,items.map(item=>item.index));
      items.forEach((item,i)=>copies.set(item,batch[i]));
    }
    for(const item of selected) {
      const page=copies.get(item);
      page.setRotation(window.PDFLib.degrees((page.getRotation().angle+item.rotation)%360));
      result.addPage(page);
    }
    const url=URL.createObjectURL(new Blob([await result.save()],{type:"application/pdf"}));
    const link=document.createElement("a");link.href=url;link.download=mergeMode ? "birlestirilmis.pdf" : "duzenlenmis.pdf";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
    status(selected.length+" sayfalık PDF hazır.");
  } catch(e) {status(e.message||"PDF oluşturulamadı.");}
  finally {busy=false;update();}
});
