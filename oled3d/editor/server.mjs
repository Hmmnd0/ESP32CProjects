// OLED3D editor server: static files + scene storage + export + flashing.
// Listens on localhost only. Web Serial needs a secure page, and localhost counts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const scenesDir = path.join(root, 'scenes');
const firmwareDir = path.join(root, 'firmware');
const port = Number(process.env.PORT) || 8090;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const validName = (n) => typeof n === 'string' && /^[\w\- ]{1,60}$/.test(n);
const readBody = (req) => new Promise((res, rej) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 20e6) req.destroy(); }); req.on('end', () => res(b)); req.on('error', rej); });
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

let flashing = false;

// On Windows, tools like pio and ffmpeg are .exe/.cmd shims that need a shell to be found
const WIN = process.platform === 'win32';

// Find the ESP32-C3 on any OS: ask PlatformIO for the serial ports and pick the one with
// Espressif's USB vendor ID (303A). macOS: /dev/cu.usbmodem…, Linux: /dev/ttyACM…, Windows: COM…
function findBoard() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('pio', ['device', 'list', '--json-output'], { shell: WIN });
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      try {
        const ports = JSON.parse(out);
        const esp = ports.find((d) => /VID:PID=303A/i.test(d.hwid || ''));
        const usb = ports.find((d) => /usbmodem|usbserial|ttyACM|ttyUSB/i.test(d.port || ''));
        resolve((esp || usb)?.port || null);
      } catch { resolve(null); }
    });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/scenes' && req.method === 'GET') {
      const names = fs.readdirSync(scenesDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
      return send(res, 200, names);
    }
    if (url.pathname === '/api/scene') {
      const name = url.searchParams.get('name');
      if (!validName(name)) return send(res, 400, { error: 'bad name' });
      const file = path.join(scenesDir, name + '.json');
      if (req.method === 'GET') return fs.existsSync(file) ? send(res, 200, fs.readFileSync(file, 'utf8')) : send(res, 404, { error: 'not found' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body);   // refuse anything that isn't JSON
        fs.writeFileSync(file, body);
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/api/export' && req.method === 'PUT') {
      const body = await readBody(req);
      fs.writeFileSync(path.join(firmwareDir, 'include', 'scene.h'), body);
      return send(res, 200, { ok: true, bytes: body.length });
    }
    if (url.pathname === '/api/flash' && req.method === 'POST') {
      if (flashing) return send(res, 409, { error: 'already flashing' });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      // Find the board ourselves: left to itself, PlatformIO may pick e.g. the Mac's Bluetooth port
      const board = await findBoard();
      if (!board) return res.end('The board was not found on USB. Plug it in with a data USB cable (and close anything else using it), then try again.\n[exit 1]\n');
      flashing = true;
      res.write(`Board found on ${board}\n`);
      const p = spawn('pio', ['run', '-t', 'upload', '--upload-port', board], { cwd: firmwareDir, shell: WIN, env: { ...process.env, PLATFORMIO_DISABLE_PROGRESSBAR: 'true' } });
      p.stdout.on('data', (d) => res.write(d));
      p.stderr.on('data', (d) => res.write(d));
      p.on('error', (e) => { res.write(`\n[could not run pio: ${e.message}]\n`); });
      p.on('close', (code) => { flashing = false; res.end(`\n[exit ${code}]\n`); });
      return;
    }
    // Static files
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(here, rel);
    if (!file.startsWith(here)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(port, '127.0.0.1', () => console.log(`OLED3D editor: http://localhost:${port}  (open in Chrome or Edge)`));
