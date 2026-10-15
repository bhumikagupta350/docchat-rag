import os
import shutil
from dotenv import load_dotenv
import requests
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pypdf import PdfReader
from sentence_transformers import SentenceTransformer
import chromadb

load_dotenv()
api_key = os.getenv("GROQ_API_KEY")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # fine for local development
    allow_methods=["*"],
    allow_headers=["*"],
)

model = SentenceTransformer("all-MiniLM-L6-v2")
client = chromadb.PersistentClient(path="./chroma_db")
collection = client.get_or_create_collection("documents")


def chunk_text(text, chunk_size=200, overlap=40):
    words = text.split()
    chunks = []
    start = 0
    while start < len(words):
        end = start + chunk_size
        chunks.append(" ".join(words[start:end]))
        start = end - overlap
    return chunks


@app.post("/upload")
def upload_pdf(file: UploadFile = File(...)):
    file_path = f"temp_{file.filename}"
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    reader = PdfReader(file_path)

    chunks, metadatas, ids = [], [], []
    for page_num, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        for j, chunk in enumerate(chunk_text(text)):
            if len(chunk.split()) < 15:      # skip title-only / near-empty chunks
                continue
            chunks.append(chunk)
            metadatas.append({"source": file.filename, "page": page_num})
            ids.append(f"{file.filename}-p{page_num}-c{j}")
    os.remove(file_path)

    if not chunks:
        raise HTTPException(status_code=400, detail="No readable text found in this PDF.")

    vectors = model.encode(chunks).tolist()
    collection.upsert(documents=chunks, embeddings=vectors, metadatas=metadatas, ids=ids)

    return {"filename": file.filename, "pages": len(reader.pages), "chunks_stored": len(chunks)}


@app.get("/documents")
def list_documents():
    data = collection.get(include=["metadatas"])
    names = sorted({m["source"] for m in data["metadatas"]})
    return {"documents": names}


@app.delete("/documents/{filename}")
def delete_document(filename: str):
    collection.delete(where={"source": filename})
    return {"deleted": filename}


class Question(BaseModel):
    text: str
    filename: str | None = None   # optional: restrict search to one document


def retrieve_chunks(question, filename=None, n_results=4):
    question_vector = model.encode([question]).tolist()
    where = {"source": filename} if filename else None
    results = collection.query(
        query_embeddings=question_vector,
        n_results=n_results,
        where=where,
    )
    return [
        {"text": doc, "source": meta["source"], "page": meta["page"]}
        for doc, meta in zip(results["documents"][0], results["metadatas"][0])
    ]


def ask_llm(question, chunks):
    context = "\n\n".join(
        f"[{i+1}] (from {c['source']}, page {c['page']}) {c['text']}"
        for i, c in enumerate(chunks)
    )
    prompt = f"""You are a helpful assistant answering questions using only the context below.
If the answer is not in the context, say "I couldn't find that in the document."
Cite the source numbers you used in plain square brackets like [1] or [2]. Do not use any other citation format.


Context:
{context}

Question: {question}

Answer:"""

    response = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": "openai/gpt-oss-20b",
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    data = response.json()
    return data["choices"][0]["message"]["content"]


@app.post("/ask")
def ask_question(question: Question):
    chunks = retrieve_chunks(question.text, question.filename)
    if not chunks:
        return {"question": question.text, "answer": "No documents uploaded yet.", "sources": []}
    answer = ask_llm(question.text, chunks)
    return {"question": question.text, "answer": answer, "sources": chunks}
