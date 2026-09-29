# PermitPilot: watch a building permit through a government portal

Give it a permit number. A Solari Browser searches the city's public permit
portal, opens the record, reads every departmental review and the reviewer's
comment page behind it, lists every attachment with the portal's own labels,
and downloads the applicant's response and the drawing revisions inside the
same session. A Solari Sandbox extracts the PDF text in an isolated VM and is
destroyed before anything reaches a model. The result is a dated snapshot you
can diff against the last one, replay to an earlier checkpoint, and read as a
coordinator's checklist where every claim links to the exact source text.

Two real public cases are wired in:

| Command | Case | What it demonstrates |
| --- | --- | --- |
| `npm run demo:pinecrest` | Permit BL2024-1706, Village of Pinecrest, Florida (eTRAKiT) | Portal navigation, reviewer comments, revision downloads, change detection, historical replay |
| `npm run demo:farmdale` | Farmdale Apartments, Woodburn, Oregon (design review) | Long public documents turned into an evidence-linked timeline, conditions register and decisions |

Open the finished reports without running anything at
[dineshsai05.github.io/solari-cookbook](https://dineshsai05.github.io/solari-cookbook/),
or from the tracked copies in [proof/](proof/README.md), which also explains
what was redacted.

## Why this needs Solari

- **The portal is a real ASP.NET application.** Search is a postback form,
  review detail pages are session-bound, and the attachment handler answers a
  plain HTTP request for the same URL with 403 while serving the PDF to the
  browser session. The adapter drives the page like a person would, with
  recording turned on, so a reviewer can watch the session in the Solari
  console.
- **Attachments are untrusted files.** Everything downloaded goes to a
  throw-away Solari Sandbox with a pinned `pypdfium2` and no credentials. The
  VM is killed before the model request, so the model only ever sees extracted
  text and the sandbox never idles on the bill.
- **A coordinator has many permits in flight.** Each run is one bounded
  browser session and one bounded sandbox. Snapshots are plain JSON, so
  scheduling and fan-out are the caller's problem, not the adapter's.

## What a run produces

`artifacts/<timestamp>-pinecrest-live/`:

- `report.html`: overall status separated from review history, review cycles,
  verbatim reviewer comments with the discipline's outcome chain, the
  comment-to-response checklist, attachments with VOID labels, run evidence.
- `snapshot.json`: permit fields, 17 review rows with notes and hashes, 23
  attachments with labels, keys and download hashes.
- `diff.json` (with `--compare`): permit fields, review rows and attachment
  labels that changed. A repeat run reports `changed: false`.
- `replay.json` (with `--replay YYYY-MM-DD`): the event history filtered to
  that date and labelled as a reconstruction.
- `analysis.json`, `model-response.json`: the checked checklist and the raw
  model reply, with token usage.
- `documents.json`, `attachments/`, three screenshots, `manifest.json`,
  `events.jsonl`.

## How it stays honest

- **The model never writes a quotation.** Extracted text is sliced into
  numbered passages. The model may only cite passage IDs; the host inserts the
  original text and rejects unknown IDs. Every quote is then re-checked against
  its page. This proves traceability, not that the summary is right.
- **Coverage is enforced.** The checklist must contain exactly one item for
  every review that has reviewer notes. An `applicant_asserted` item must cite
  an applicant-response document. Duplicates, omissions and unsupported
  assertions stop the run.
- **Status and history are different things.** The permit's overall status
  is one field. Individual rows keep their historical DENIED or INCOMPLETE
  outcomes and are never presented as current problems. Later APPROVED rows in
  the same discipline are shown as a chain, not as proof that a specific comment
  was satisfied.
- **Replays are labelled.** A reconstructed checkpoint says so on every page
  and can never be replayed again from itself.
- **Nothing is written to the portal.** No login, no applicant record, no
  submission. The only form submitted is the public search box.

Known soft spots in the AI layer are recorded in
[cases/pinecrest-review-notes.md](cases/pinecrest-review-notes.md) and
[cases/farmdale-review-notes.md](cases/farmdale-review-notes.md).

## Install

Requires Node 22.8+, npm, a funded Solari account with browser and sandbox
access, and an AIML API key for a model that supports Chat Completions
JSON-schema structured outputs. Python 3.10+ is only needed for the local deck
mode and the Python tests.

```bash
cd applications/permit-pilot
npm install            # versions are pinned in package.json; the cookbook ignores lockfiles
cp .env.example .env
```

```dotenv
SOLARI_API_KEY=your-key
AIML_API_KEY=your-key
AIML_MODEL=openai/gpt-4.1-mini-2025-04-14
```

`npm start -- --doctor` reports which names are configured without printing
values. There is no automatic model fallback.

## Run the portal demo

```bash
npm run demo:pinecrest
npm run demo:pinecrest -- --compare artifacts/<previous-run> --replay 2025-03-25
npm run demo:pinecrest -- --no-model      # browser and sandbox only
```

The case file `cases/pinecrest.json` pins the portal origin, the permit
number, the expected site address, and the SHA-256 of the three documents the
demo downloads. A changed hash is reported in the snapshot and the report,
not hidden. The permit is finalized, so every run is a historical replay of a
closed case; the code paths for change detection are exercised by comparing
consecutive captures.

Verified September 29, 2026: four consecutive live runs, each about one
minute, the last three reporting no change against the previous snapshot. The
final checklist request used 3,345 input and 1,276 output tokens.

## Run the document-review demo

```bash
npm run demo:farmdale
npm run demo:farmdale -- --resume artifacts/<previous-run>   # reuse extraction, redo the model step
```

Solari Browser captures the official project page; Solari Sandbox downloads
the three text-rich public PDFs, verifies their pinned hashes and extracts 43
pages; one bounded AIML request returns a timeline, recorded tasks, requested
versus decided changes and questions, all cited by passage ID. The 42 drawing
pages are indexed and linked, not analyzed. Verified September 29, 2026 with
24,207 input and 2,100 output tokens. The delivered example was reviewed by
hand; `scripts/review-farmdale.ts` applies those corrections to a run while
keeping the raw model output.

## Earlier demo: Portland deck application

`npm start -- --project fixtures/generated/incomplete/project.json` runs the
first workflow: four official Portland guidance pages are captured live, the
city's application PDF is verified by hash, synthetic plan PDFs are extracted
and classified, a small coded checklist runs, and an unsigned draft of the
official form is produced. `npm run fixtures` generates the synthetic
incomplete, corrected and unreadable sets. `--mode local --python .venv/bin/python`
runs the same PDF tools with reference excerpts and no Solari or AI. Nothing
synthetic is ever entered into a government account.

## Tests

```bash
npm run typecheck
npm test
npm run fixtures && python3 -m venv .venv && .venv/bin/python -m pip install -r python/requirements.txt
.venv/bin/python -m unittest discover -s python -p 'test_*.py' -v
```

22 TypeScript tests cover the portal parser, attachment key hints, snapshot
diffing, replay filtering, checklist coverage and citation rules, HTML
escaping, the Farmdale evidence validator, the deck checklist, and mocked AIML
transport failures. 6 Python tests cover PDF extraction, encrypted inputs,
form round-trips and overflow rejection. No test makes a network call.

## Limits

- Read-only. Submission, payment, account access and edits to the applicant
  record are out of scope by design.
- One portal family (CentralSquare eTRAKiT) and one Oregon document set. The
  selectors in `src/portal-pinecrest.ts` are specific to that portal.
- Text only. Drawings are downloaded and hashed, not interpreted; scanned
  pages need OCR that is not implemented.
- Bounded: 40 attachment pages, 15 MB per file, 160,000 characters of model
  input, one model request with retries disabled.
- A prototype, not a hardened upload service. Do not expose it to the public
  as is.

## Layout

```
cases/            pinned case manifests and review notes
src/portal-*.ts   eTRAKiT adapter, snapshot diff and replay, checklist validation, report
src/case-*.ts     Farmdale document review
src/passages.ts   passage slicing and citation resolution shared by both
src/sandbox-python.ts  sandbox bootstrap with pinned pypdfium2
python/           fixed extraction tools that run inside the sandbox
scripts/          fixtures, proof bundling, Farmdale corrections
proof/            sanitized evidence from live runs
tests/            node:test suites
```

## Sources and provenance

Pinecrest: [public permit record](https://pine-trk.aspgov.com/eTRAKiT/Search/permit.aspx?activityNo=BL2024-1706),
qualified with real Solari sessions on September 29, 2026. Reviewer names and
the site address are public record on that page.

Farmdale: [official project page](https://www.woodburn-or.gov/778/Design-Review-DR-25-02---Marion-County-H)
and five public PDFs pinned by hash in `cases/farmdale.json`.

Portland deck: [drawing requirements](https://www.portland.gov/ppd/residential-permitting/decks/prepare/create-detailed-plans),
[file requirements](https://www.portland.gov/ppd/residential-permitting/decks/prepare/prepare-your-files),
[application instructions](https://www.portland.gov/ppd/residential-permitting/decks/prepare/fill-out-your-forms),
[rule-change context](https://www.portland.gov/permitimprovement/code-alignment-project),
and the [official application PDF](https://www.portland.gov/ppd/documents/building-permit-application-building-site-development-demolition-and-zoning-permits/download),
retained unchanged as a reference fixture with SHA-256
`04671f40f528baaaae5fe42f5f6dcfe0b5aa94ec045f2c10429c417b06f4daf9`.

Model pricing used for the cost note: [AIML GPT-4.1 mini](https://aimlapi.com/models/openai-gpt-4-1-mini-2025-04-14),
$0.52 per million input and $2.08 per million output tokens on September 29, 2026,
so a Pinecrest checklist costs well under a cent and a Farmdale review about two cents,
excluding Solari time.

Built inside the official Solari cookbook, cloned at
`a435d2ac5ae87bdf9ee4f6c91f97da9501359560`.
