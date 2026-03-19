// Generate a 256x256 PNG icon - blue "M" with transparent background
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });

  const html = `<!DOCTYPE html>
<html><head><style>
  html, body { margin:0; padding:0; overflow:hidden; background: transparent !important; }
</style></head>
<body>
<canvas id="c" width="256" height="256"></canvas>
<script>
const c = document.getElementById('c');
const ctx = c.getContext('2d');
const size = 256;
const pad = 8;

// Clear with transparency
ctx.clearRect(0, 0, size, size);

// Rounded square
const r = 50;
const x = pad, y = pad, w = size - pad*2, h = size - pad*2;
ctx.fillStyle = '#0078D4';
ctx.beginPath();
ctx.moveTo(x + r, y);
ctx.lineTo(x + w - r, y);
ctx.arcTo(x + w, y, x + w, y + r, r);
ctx.lineTo(x + w, y + h - r);
ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
ctx.lineTo(x + r, y + h);
ctx.arcTo(x, y + h, x, y + h - r, r);
ctx.lineTo(x, y + r);
ctx.arcTo(x, y, x + r, y, r);
ctx.fill();

// Gradient overlay
const grad = ctx.createLinearGradient(0, 0, size, size);
grad.addColorStop(0, 'rgba(0, 149, 246, 0.6)');
grad.addColorStop(1, 'rgba(0, 60, 150, 0.6)');
ctx.fillStyle = grad;
ctx.fill();

// "M" letter
ctx.fillStyle = 'white';
ctx.font = 'bold 160px Arial';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('M', size / 2, size / 2 + 6);

// Export as data URL and put in title for extraction
document.title = c.toDataURL('image/png');
</script>
</body></html>`;

  const fs = require('fs');
  const path = require('path');
  const tmpHtml = path.join(__dirname, 'assets', '_icon.html');
  fs.writeFileSync(tmpHtml, html);

  await win.loadFile(tmpHtml);
  await new Promise(r => setTimeout(r, 500));

  // Get the PNG data URL from canvas directly (avoids white background from capturePage)
  const dataUrl = await win.webContents.executeJavaScript('document.title');
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const png = Buffer.from(base64, 'base64');

  console.log('PNG size:', png.length);
  fs.writeFileSync(path.join(__dirname, 'assets', 'icon.png'), png);
  fs.unlinkSync(tmpHtml);
  console.log('Icon saved to assets/icon.png');
  app.quit();
});
