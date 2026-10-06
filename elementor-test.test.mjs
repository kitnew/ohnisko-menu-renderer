import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
const font = await fs.readFile(path.join(source, '../ohnisko-menu-wordpress/assets/fonts/montserrat-latin-400-normal.woff2'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="#deB76c"/></svg>';

async function fixture(overflow) {
  const html = `<!doctype html><html><head><style>
    @font-face{font-family:MenuTest;src:url('/font.woff2') format('woff2')}
    .ohnisko-a4{background:#396360 url('/bg.svg') no-repeat right bottom;color:white;font-family:MenuTest}
    .spill{position:absolute;top:${overflow ? '310' : '10'}mm}
    </style></head><body>
    <div class="ohnisko-a4"><p>First A4 page</p><img src="/icon.svg" width="50" height="50"><div class="spill">${overflow ? 'Overflow marker' : ''}</div></div>
    <div class="ohnisko-a4"><p>Second A4 page</p></div>
    </body></html>`;
  const server = createServer((req, res) => {
    if (req.url === '/font.woff2') { res.setHeader('Content-Type', 'font/woff2'); res.end(font); }
    else if (req.url === '/bg.svg' || req.url === '/icon.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end(svg); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ohnisko-elementor-'));
  await fs.copyFile(path.join(source, 'generate-elementor-test.mjs'), path.join(temp, 'generate-elementor-test.mjs'));
  await fs.symlink(path.join(source, 'node_modules'), path.join(temp, 'node_modules'));
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify({ site_url: `http://127.0.0.1:${server.address().port}`, print_token: 'x'.repeat(64) }));
  return { temp, server };
}

test('two A4 sheets preserve font, SVG, and background', async () => {
  const { temp, server } = await fixture(false);
  try {
    const { stdout } = await exec(process.execPath, [path.join(temp, 'generate-elementor-test.mjs'), '123'], { timeout: 120000 });
    const pdf = stdout.trim().split(': ').at(-1);
    const { stdout: info } = await exec('pdfinfo', [pdf]);
    assert.match(info, /^Pages:\s+2$/m);
    const dimensions = info.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
    assert.ok(dimensions);
    assert.ok(Math.abs(Number(dimensions[1]) - 210 * 72 / 25.4) < 0.4);
    assert.ok(Math.abs(Number(dimensions[2]) - 297 * 72 / 25.4) < 0.4);
    const { stdout: fonts } = await exec('pdffonts', [pdf]);
    assert.match(fonts, /Montserrat/);
    const raster = path.join(temp, 'page');
    await exec('pdftoppm', ['-f', '1', '-l', '1', '-scale-to-x', '794', '-scale-to-y', '1123', '-singlefile', pdf, raster]);
    const pixels = await fs.readFile(raster + '.ppm');
    const header = pixels.toString('ascii', 0, 80).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
    assert.ok(header);
    const start = header[0].length;
    const colorAt = (x, y) => [...pixels.subarray(start + (y * Number(header[1]) + x) * 3, start + (y * Number(header[1]) + x) * 3 + 3)];
    assert.deepEqual(colorAt(400, 400), [57, 99, 96]); // green sheet background
    assert.deepEqual(colorAt(2, 2), [57, 99, 96]); // no top/left print margin
    assert.deepEqual(colorAt(2, 1120), [57, 99, 96]); // no bottom print margin
    assert.deepEqual(colorAt(770, 1100), [222, 183, 108]); // SVG background
    assert.deepEqual(colorAt(25, 75), [222, 183, 108]); // inline image SVG
    const data = await fs.readFile(pdf);
    assert.ok(data.length > 1000);
  } finally {
    server.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('overflow fails and leaves no PDF', async () => {
  const { temp, server } = await fixture(true);
  try {
    await assert.rejects(exec(process.execPath, [path.join(temp, 'generate-elementor-test.mjs'), '123'], { timeout: 120000 }), /sheet 1: .* exceeds A4/);
    assert.deepEqual(await fs.readdir(path.join(temp, 'elementor-tests')), []);
  } finally {
    server.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
