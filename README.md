# pdf-knowledge-graph

Two processes. A Python service reads a short PDF, pulls out the entities
and relations, and returns JSON. A React canvas renders the graph and lets
you edit it. The source text panel on the right stays read-only, editing
the graph never touches the underlying document.

There's a Hungarian walkthrough of the whole pipeline at
[`docs/DOKUMENTACIO.md`](docs/DOKUMENTACIO.md).

---

## Setup

### Prerequisites

- **Python 3.10+** (check with `python3 --version`)
- **Node.js 18+** (check with `node --version`)
- **npm** (ships with Node)
- ~150 MB of disk for the spaCy model + node_modules
- A short PDF to test with. Anything 1–10 pages of mostly-text works;
  scanned image PDFs won't (no OCR step).

On Debian/Ubuntu/WSL you may also need `python3-venv`:

```bash
sudo apt install python3-venv
```

### One-time install

Clone, then set the backend up first:

```bash
git clone https://github.com/kevinyecs/pdf-knowledge-graph.git
cd pdf-knowledge-graph

# --- backend ---
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
pip install https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
cd ..

# --- frontend ---
npm install
```

If you can't make a venv (e.g. the Debian-flavoured "externally-managed
environment" error), install with `pip install --user --break-system-packages`
instead. It's not pretty but it works.

### Verify the install

```bash
# backend smoke test, should print a graph summary
python3 -c "import sys; sys.path.insert(0,'backend'); from extractor import extract; from pdf_io import read_pdf; print('backend ok')"

# frontend type check + production build
npm run build
```

---

## Running the app

You'll need two terminals.

**Terminal 1 (backend):**

```bash
cd backend
source .venv/bin/activate                 # if you made a venv
python -m uvicorn app:app --reload --port 8000
```

You should see `Uvicorn running on http://127.0.0.1:8000`.

**Terminal 2 (frontend):**

```bash
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). Vite proxies
`/api/*` to the backend on port 8000, so the browser only ever talks to
one origin.

The sidebar shows a green dot when the backend is reachable, red when it
isn't.

### Production build

```bash
npm run build      # static bundle in dist/
npm run preview    # serve dist/ on a port for a quick smoke test
```

The backend has no separate "build" step, `python -m uvicorn app:app`
runs it. For a non-dev deployment, drop `--reload` and pick a process
manager (systemd, supervisor, whatever).

---

## Using it

Two test PDFs ship with the repo in `samples/`. They cover the two
shapes the extractor handles:

| file | pages | what it is | what to expect |
|---|---|---|---|
| `samples/finance.pdf`   | 3 | sample financial statement (tabular) | `org` / `metric` / `money` / `date` nodes connected by `reports`, `includes`, `value`, `as-of` edges |
| `samples/rohini.pdf`    | 8 | LED-physics study notes (prose)      | `topic` nodes with verb-labelled edges from dependency-parsed SVO triples (`emit`, `recombine`, `cross`, ...) |

Steps:

1. Click **Upload PDF** in the sidebar. Pick one of the samples above,
   or any short PDF of your own.
2. The backend parses it (≈1–3s for a few pages) and returns a graph.
3. Click a node to focus the source text panel on the sentences that
   mention it. Click an edge to focus the single sentence that produced it.
4. Drag from the side handle of one node to another to add an edge.
   Double-click a node or edge to rename it. Select something and hit
   **Delete** to remove it.
5. Type in the search box to filter, the canvas dims non-matches and
   centres on the top hit. Try `revenue` on the finance PDF or
   `electron` on the rohini PDF.

Edits live only in the graph. The text panel never changes.

---

## Troubleshooting

**`ModuleNotFoundError: en_core_web_sm`**: you skipped the spaCy model
install. Run the second `pip install` line again.

**`Backend offline` in the sidebar**: uvicorn isn't running, or it's on
a port other than 8000. The frontend hard-codes `/api` to
`http://127.0.0.1:8000` in `vite.config.ts`. Edit that file if you're
using a different port.

**`fetch /api/extract` returns CORS errors**: Vite proxy isn't picking
the request up. Restart `npm run dev` after editing `vite.config.ts`.

**`pdfplumber.PdfReadError`**: the file is encrypted, corrupted, or not
actually a PDF. The backend returns HTTP 422 in this case; check the
sidebar error banner.

**Empty graph on a PDF that "should" have content**: probably scanned
image-only pages. There's no OCR step. Run
`python3 -c "import pdfplumber; print(pdfplumber.open('your.pdf').pages[0].extract_text())"`
to confirm. If it prints nothing or junk, that's the problem.

---

## What's in the box

```
backend/                    Python: FastAPI + spaCy + pdfplumber
  app.py                    one endpoint: POST /extract
  pdf_io.py                 pdfplumber wrapper, flags tabular pages
  extractor.py              prose pipeline + tabular pipeline
  requirements.txt
src/                        React: Vite + TypeScript + Tailwind
  App.tsx                   wiring, ping the backend, edit state
  components/
    GraphView.tsx           @xyflow/react canvas, dagre layout
    EntityNode.tsx          coloured node by kind
    Sidebar.tsx             upload, search, hits
    TextPanel.tsx           read-only source, focuses on selection
  lib/
    extract.ts              calls POST /api/extract
    layout.ts               dagre layout helper
    search.ts               degree-weighted node search
docs/
  DOKUMENTACIO.md           step-by-step pipeline explanation (Hungarian)
samples/
  finance.pdf               3-page financial statement (tabular content)
  rohini.pdf                8 pages of LED physics notes (prose content)
```

## How the extraction actually works

For the long version, see [`docs/DOKUMENTACIO.md`](docs/DOKUMENTACIO.md). Short
version:

The pipeline branches per page based on a tabular/prose heuristic
(short lines + high digit density → tabular).

**Prose pages.** spaCy NER plus a small dependency-tree walk for SVO
triples. For each verb, take its subject and either a direct object,
a prepositional object, or an `agent` (passive voice). The lemmatised
verb becomes the edge label. Multi-word noun chunks are added as
`topic` nodes after stripping leading determiners so "the LED" and
"LED" merge.

**Tabular pages.** Line-by-line parse: headings become `org`, section
titles ("Income Statement") become `topic`, dates become `date`,
label-amount lines produce a `metric` connected to a `money` node by
a `value` edge and to its enclosing section by `includes`.

**Both then converge:** rapidfuzz collapses near-duplicate node labels,
parallel edges between the same pair are folded with a weight count, and
one-mention isolated nodes get pruned.

## Things I'd add next

- Real coreference (currently "the LED" / "LED" merge but "it" doesn't
  link).
- Optional LLM path for richer relation labels, keeping spaCy as the
  cheap fallback.
- Persist the edited graph (currently in memory only).
- Multi-document mode where the same entity merges across PDFs.
- Export to JSON / GraphML.

## License

MIT.
