export async function openPhoto(blob) {
  let url;
  try {
    if (!blob?.size) throw new Error();
    const local = new Blob([await blob.arrayBuffer()], { type: blob.type || "image/jpeg" });
    url = URL.createObjectURL(local);
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    return { blob: local, image, url };
  } catch {
    if (url) URL.revokeObjectURL(url);
    throw new Error("Fotoğraf açılamadı.");
  }
}

export async function bitmapOf(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    const { image, url } = await openPhoto(blob);
    URL.revokeObjectURL(url);
    return image;
  }
}
