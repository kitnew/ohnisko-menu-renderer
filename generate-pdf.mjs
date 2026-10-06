import fs from "node:fs/promises";
import path from "node:path";

import puppeteer from "puppeteer-core";
import chromium, {
  inflate,
  setupLambdaEnvironment,
} from "@sparticuz/chromium";

const [, , inputUrl, outputFile] = process.argv;

if (!inputUrl || !outputFile) {
  console.error(
    "Usage: node generate-pdf.mjs <input-url> <output-file>"
  );
  process.exit(1);
}

const binDir = path.join(
  process.cwd(),
  "node_modules",
  "@sparticuz",
  "chromium",
  "bin"
);

// Websupport is Ubuntu, so force extraction of the
// libraries bundled for the portable Chromium runtime.
await inflate(path.join(binDir, "al2023.tar.br"));
setupLambdaEnvironment("/tmp/al2023/lib");

chromium.setGraphicsMode = false;

await fs.mkdir(path.dirname(outputFile), {
  recursive: true,
});

const executablePath = await chromium.executablePath();

console.log(`Opening print endpoint: ${new URL(inputUrl).origin}${new URL(inputUrl).pathname}`);
console.log(`Chromium: ${executablePath}`);
console.log(`Output: ${outputFile}`);

const browser = await puppeteer.launch({
  args: await puppeteer.defaultArgs({
    args: chromium.args,
    headless: "shell",
  }),
  executablePath,
  headless: "shell",
});

try {
  const page = await browser.newPage();
  await page.emulateMediaType("print");

  const response = await page.goto(inputUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  if (!response?.ok()) {
    throw new Error(`Print page returned HTTP ${response?.status() ?? "no response"}`);
  }

  await page.waitForFunction(
    () =>
    window.__OHNISKO_PRINT_READY__ === true ||
    Boolean(window.__OHNISKO_PRINT_ERROR__),
                             { timeout: 60000 }
  );

  const printState = await page.evaluate(() => ({
    ready: window.__OHNISKO_PRINT_READY__ === true,
    error: window.__OHNISKO_PRINT_ERROR__ || null,
    pages: document.querySelectorAll('.pagedjs_page').length,
  }));

  if (printState.error) {
    throw new Error(`Print page failed: ${printState.error}`);
  }

  if (!printState.ready) {
    throw new Error(
      `Print page did not become ready; paged pages: ${printState.pages}`
    );
  }

  await page.pdf({
    path: outputFile,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
  });

  console.log("PDF generated successfully");
} finally {
  await browser.close();
}
