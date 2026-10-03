import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import chromium, { inflate, setupLambdaEnvironment } from '@sparticuz/chromium';

const runtime = path.dirname(fileURLToPath(import.meta.url));
const wordpress = path.resolve(runtime, '../ohnisko-menu-wordpress');
const assets = path.join(wordpress, 'assets');

function fixture(count) {
  const items = Array.from({ length: count }, (_, i) => `<article class="menu-item"><header class="menu-item__header"><h3 class="menu-item__name">Test dish ${i + 1}</h3><span class="menu-item__price">12.00€</span></header><p class="menu-item__meta">/SVK/ 180g (1,3,7)</p><p class="menu-item__description">A long smoke fixture description with enough content to exercise real flow based pagination over multiple A4 pages. Item number ${i + 1} contains seasonal vegetables, smoked herbs and sauce.</p></article>`).join('');
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><link rel="preload" as="image" href="/assets/brand-pattern.png" data-print-critical="1"><link rel="stylesheet" href="/assets/print.css"><script defer src="/assets/print.js"></script><script defer src="/assets/vendor/paged.polyfill.min.js"></script></head><body><main class="menu-document"><header class="menu-intro"><img class="menu-brand" src="/assets/ohnisko-logo-color.png" alt="Ohnisko"><h1>Variable length fixture</h1></header><section class="menu-section"><header class="menu-section__header"><h2>Smoke section</h2></header><div class="menu-items menu-items--columns">${items}</div></section></main></body></html>`;
}

test('Paged.js readiness and variable content produce a variable page count', async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/assets/')) {
      const relative = path.normalize(url.pathname.slice('/assets/'.length));
      if (relative.startsWith('..')) { res.writeHead(403).end(); return; }
      try {
        const file = path.join(assets, relative);
        const body = await fs.readFile(file);
        const ext = path.extname(file);
        const mime = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : ext === '.woff2' ? 'font/woff2' : ext === '.png' ? 'image/png' : 'image/svg+xml';
        res.writeHead(200, { 'content-type': mime });
        res.end(body);
      } catch { res.writeHead(404).end(); }
      return;
    }
    const count = Number(url.searchParams.get('count') || 4);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixture(Math.min(120, Math.max(1, count))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const binDir = path.join(runtime, 'node_modules/@sparticuz/chromium/bin');
    await inflate(path.join(binDir, 'al2023.tar.br'));
    setupLambdaEnvironment('/tmp/al2023/lib');
    chromium.setGraphicsMode = false;
    browser = await puppeteer.launch({ args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }), executablePath: await chromium.executablePath(), headless: 'shell' });
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    const base = `http://127.0.0.1:${server.address().port}`;
    const pageCount = async count => {
      const response = await page.goto(`${base}/?count=${count}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => {
        if (window.__OHNISKO_PRINT_ERROR__) throw new Error(window.__OHNISKO_PRINT_ERROR__);
        return window.__OHNISKO_PRINT_READY__ === true;
      }, { timeout: 60000 });
      return page.$$eval('.pagedjs_page', pages => pages.length);
    };
    const shortPages = await pageCount(4);
    const longPages = await pageCount(80);
    assert.ok(shortPages >= 1);
    assert.ok(longPages > shortPages, `expected long fixture pages (${longPages}) > short fixture (${shortPages})`);
    assert.ok(longPages > 4, `expected variable length fixture to exceed four pages, got ${longPages}`);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    assert.ok(pdf.byteLength > 100);
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString('ascii'), '%PDF-');
    console.log(`Paged.js smoke: ${shortPages} page(s) for short content, ${longPages} for long content; Chromium PDF print succeeded.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
