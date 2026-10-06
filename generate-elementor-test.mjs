import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import chromium, { inflate, setupLambdaEnvironment } from '@sparticuz/chromium';

const runtime = path.dirname(fileURLToPath(import.meta.url));
const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id < 1 || String(id) !== process.argv[2]) {
  throw new Error('Usage: node generate-elementor-test.mjs <WordPress page ID>');
}

const config = JSON.parse(await fs.readFile(path.join(runtime, 'config.json'), 'utf8'));
if (typeof config.print_token !== 'string' || config.print_token.length < 32) {
  throw new Error('Runtime config must contain a print_token of at least 32 characters.');
}
const url = new URL(config.site_url);
url.searchParams.set('ohnisko_elementor_test', '1');
url.searchParams.set('ohnisko_elementor_id', String(id));
url.searchParams.set('token', config.print_token);

const outputDir = path.join(runtime, 'elementor-tests');
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await fs.chmod(outputDir, 0o700);
const output = path.join(outputDir, `page-${id}-${Date.now()}.pdf`);

await inflate(path.join(runtime, 'node_modules', '@sparticuz', 'chromium', 'bin', 'al2023.tar.br'));
setupLambdaEnvironment('/tmp/al2023/lib');
chromium.setGraphicsMode = false;
const browser = await puppeteer.launch({
  args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
  executablePath: await chromium.executablePath(),
  headless: 'shell',
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.emulateMediaType('screen');
  const failedAssets = new Set();
  page.on('requestfailed', request => {
    if (['stylesheet', 'font', 'image'].includes(request.resourceType())) failedAssets.add(request.url());
  });
  page.on('response', response => {
    if (response.status() >= 400 && ['stylesheet', 'font', 'image'].includes(response.request().resourceType())) {
      failedAssets.add(response.url());
    }
  });
  const response = await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 60000 });
  if (!response?.ok()) throw new Error(`Elementor page returned HTTP ${response?.status() ?? 'no response'}`);

  await page.addStyleTag({ content: `
    @page { size: A4; margin: 0; }
    html, body { margin: 0 !important; padding: 0 !important; width: 210mm !important; }
    .ohnisko-a4 { box-sizing: border-box !important; width: 210mm !important; height: 297mm !important;
      min-width: 210mm !important; max-width: 210mm !important; min-height: 297mm !important; max-height: 297mm !important;
      margin: 0 !important; contain: layout !important; break-inside: avoid !important; page-break-inside: avoid !important; }
  ` });

  const pages = await page.$$('.ohnisko-a4');
  if (!pages.length) throw new Error('No .ohnisko-a4 containers found');
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"]').forEach(img => { img.loading = 'eager'; });
  });
  for (const item of pages) {
    await item.evaluate(element => element.scrollIntoView());
    await page.waitForNetworkIdle({ idleTime: 150, timeout: 30000 });
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
  });
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 });
  if (failedAssets.size) throw new Error(`Assets failed to load: ${[...failedAssets].map(value => new URL(value).pathname).join(', ')}`);

  const problems = await page.evaluate(() => {
    const tolerance = 1;
    const issues = [];
    document.querySelectorAll('.ohnisko-a4').forEach((sheet, index) => {
      const edge = sheet.getBoundingClientRect();
      const top = edge.top + window.scrollY;
      const left = edge.left + window.scrollX;
      const expectedTop = index * 297 * 96 / 25.4;
      if (Math.abs(top - expectedTop) > tolerance || Math.abs(left) > tolerance) {
        issues.push(`sheet ${index + 1}: starts at (${left.toFixed(1)}, ${top.toFixed(1)}) px, expected (0, ${expectedTop.toFixed(1)}) px`);
      }
      if (Math.abs(edge.width - 210 * 96 / 25.4) > tolerance || Math.abs(edge.height - 297 * 96 / 25.4) > tolerance) {
        issues.push(`sheet ${index + 1}: size ${edge.width.toFixed(1)} x ${edge.height.toFixed(1)} px`);
      }
      for (const element of sheet.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const box = element.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        if (box.left < edge.left - tolerance || box.top < edge.top - tolerance || box.right > edge.right + tolerance || box.bottom > edge.bottom + tolerance) {
          const selector = element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}${element.classList.length ? '.' + [...element.classList].slice(0, 2).join('.') : ''}`;
          issues.push(`sheet ${index + 1}: ${selector} exceeds A4 by ${Math.ceil(Math.max(edge.left - box.left, edge.top - box.top, box.right - edge.right, box.bottom - edge.bottom))} px`);
          if (issues.length >= 10) break;
        }
      }
      if (sheet.scrollWidth > sheet.clientWidth + tolerance || sheet.scrollHeight > sheet.clientHeight + tolerance) {
        issues.push(`sheet ${index + 1}: scroll size ${sheet.scrollWidth} x ${sheet.scrollHeight} exceeds ${sheet.clientWidth} x ${sheet.clientHeight} px`);
      }
    });
    for (const img of document.images) if (!img.complete || !img.naturalWidth) issues.push(`Image failed: ${new URL(img.currentSrc || img.src, document.baseURI).pathname}`);
    return issues;
  });
  if (problems.length) throw new Error(`A4 overflow or asset error:\n${problems.join('\n')}`);

  await page.pdf({ path: output, format: 'A4', preferCSSPageSize: true, printBackground: true,
    displayHeaderFooter: false, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await fs.chmod(output, 0o600);
  console.log(`Generated ${pages.length} A4 pages: ${output}`);
} catch (error) {
  await fs.rm(output, { force: true });
  throw error;
} finally {
  await browser.close();
}
