// Generate ICO from existing icon.png using Electron's nativeImage
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(pngPath);

  // Create multiple sizes for ICO
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = sizes.map(s => {
    const resized = img.resize({ width: s, height: s });
    return { size: s, data: resized.toPNG() };
  });

  // Build ICO file manually
  // ICO format: header + directory entries + image data
  const numImages = pngs.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * numImages;
  let dataOffset = headerSize + dirSize;

  // Calculate total size
  let totalSize = dataOffset;
  for (const p of pngs) totalSize += p.data.length;

  const buf = Buffer.alloc(totalSize);

  // Header
  buf.writeUInt16LE(0, 0);      // reserved
  buf.writeUInt16LE(1, 2);      // type: icon
  buf.writeUInt16LE(numImages, 4); // count

  // Directory entries
  let offset = dataOffset;
  for (let i = 0; i < pngs.length; i++) {
    const p = pngs[i];
    const pos = headerSize + i * dirEntrySize;
    buf.writeUInt8(p.size >= 256 ? 0 : p.size, pos);     // width
    buf.writeUInt8(p.size >= 256 ? 0 : p.size, pos + 1); // height
    buf.writeUInt8(0, pos + 2);                            // colors
    buf.writeUInt8(0, pos + 3);                            // reserved
    buf.writeUInt16LE(1, pos + 4);                         // planes
    buf.writeUInt16LE(32, pos + 6);                        // bits per pixel
    buf.writeUInt32LE(p.data.length, pos + 8);             // data size
    buf.writeUInt32LE(offset, pos + 12);                   // data offset
    offset += p.data.length;
  }

  // Image data
  offset = dataOffset;
  for (const p of pngs) {
    p.data.copy(buf, offset);
    offset += p.data.length;
  }

  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  fs.writeFileSync(icoPath, buf);
  console.log('ICO created:', totalSize, 'bytes');
  app.quit();
});
