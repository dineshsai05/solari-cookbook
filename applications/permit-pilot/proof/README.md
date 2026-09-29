# Live proof

Sanitized evidence from real Solari runs on September 29, 2026. Open the two
reports in a browser; every quote in them links back to the public source.

| Folder | What it shows |
| --- | --- |
| [pinecrest/](pinecrest/report.html) | Permit BL2024-1706 read from the Village of Pinecrest eTRAKiT portal: search, 17 review rows, 6 reviewer comment pages, 23 attachment labels, 3 in-session downloads, no-change diff against the previous capture, replay as of 2025-03-25, the AI-linked checklist, and the tracker opened in LibreOffice Calc on a Solari Desktop |
| [atherton/](atherton/report.html) | Permit BP26-00421, an open grading permit on the Town of Atherton eTRAKiT portal: 11 review rows with two still pending, no-change diff against the first capture, sandbox and checklist skipped because the town publishes no notes or attachments |
| [farmdale/](farmdale/report.html) | Farmdale Apartments land-use case from Woodburn, Oregon: evidence-linked timeline, recorded tasks and decisions from 43 extracted pages, with the assistant's corrections kept apart from the raw model output |

Each portal folder also has `walkthrough.gif`, assembled from the step
screenshots the adapter took (nothing synthesized), and `tracker.csv`.

Each folder keeps the run manifest, event log, extracted text, raw model
response, and Solari browser screenshots. Browser and sandbox session IDs are
replaced with `[redacted session id]`; local paths are shortened to their base
name. No API key, cookie, or token is included. Downloaded PDFs are not copied:
`pinecrest/snapshot.json` records their public URLs and SHA-256 hashes, which
matched the pinned copies in `cases/pinecrest.json`.

Regenerate a bundle and its GIF from any run with:

```bash
node --import tsx scripts/bundle-proof.ts artifacts/<run> proof/<name>
.venv/bin/python scripts/make-gif.py artifacts/<run> proof/<name>/walkthrough.gif
```

Solari's replay download returned 404 for every session on September 29,
2026, so no rrweb replay is included; the bundler keeps one when it exists.
