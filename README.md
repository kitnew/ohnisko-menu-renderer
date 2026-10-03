# Ohnisko Menu PDF renderer

Node and Chromium runtime for generating a PDF from the WordPress print HTML.

## Job flow

The WordPress admin creates a `pending` JSON job under `jobs/`. The scheduled
worker claims the oldest pending job, opens the token-protected print endpoint,
waits for Paged.js to finish pagination, prints A4 PDF, and records the result
as `ready` or `failed` in the same job file.

The runtime is deployed separately at `~/ohnisko-pdf-runtime`.
