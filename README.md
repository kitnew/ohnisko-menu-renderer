# Ohnisko Menu PDF renderer

Node and Chromium runtime for generating a PDF from the WordPress print HTML.

## Job flow

The WordPress admin creates a `pending` JSON job under `jobs/`. The scheduled
worker claims the oldest pending job, opens the token-protected print endpoint,
waits for Paged.js to finish pagination, prints A4 PDF, and records the result
as `ready` or `failed` in the same job file.

The runtime is deployed separately at `~/ohnisko-pdf-runtime`.

# Elementor layout PDF test

After deploying the WordPress plugin and this renderer to the existing private runtime, run from the renderer runtime directory:

```sh
./bin/node generate-elementor-test.mjs 624
```

The command uses `site_url` and `print_token` from the existing private `config.json`. It prints the path to a PDF in the private `elementor-tests/` directory. This PDF does not enter the production job queue or publication history. The WordPress page may be Private; the HTML endpoint accepts the shared print token and the numeric page ID. Keep the token and PDF private.

Each `.ohnisko-a4` container must occupy one A4 sheet in the saved Elementor page. The renderer uses a 1920 px desktop viewport, screen media for Elementor styles, and zero print margins. It stops with a sheet number and element selector if an element exceeds the sheet, starts off the expected page boundary, or an image, font, or stylesheet fails to load.

Run `node --test elementor-test.test.mjs` for a local two-sheet PDF and overflow fixture. The test uses `pdfinfo`, `pdffonts`, and `pdftoppm` to check page count, page size, embedded font, SVG, and background color.
