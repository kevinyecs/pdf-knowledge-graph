"""FastAPI entrypoint. One real endpoint: POST /extract with a PDF file."""

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from extractor import extract
from pdf_io import read_pdf

app = FastAPI(title="pdf-knowledge-graph backend", version="0.2.0")

# Open CORS for local dev. The frontend runs on a different port (Vite at
# 5173) so the browser blocks fetches without this.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/extract")
async def extract_endpoint(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="upload must be a .pdf file")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    try:
        pages = read_pdf(data)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not parse PDF: {exc}")

    if not pages:
        raise HTTPException(status_code=422, detail="PDF contained no text")

    graph = extract(pages)

    return {
        "name": file.filename,
        "page_count": len(pages),
        "tabular_pages": [p.number for p in pages if p.is_tabular],
        **graph.to_dict(),
    }
