import { useState, useEffect, useRef } from "react";

const API = "http://127.0.0.1:8000";

const SUGGESTIONS = [
  "Summarize this document",
  "What are the key topics covered?",
  "Explain the main idea in simple words",
];

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(""); // "" = all documents
  const [status, setStatus] = useState({ text: "", type: "" });
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);

  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  async function loadDocuments() {
    try {
      const res = await fetch(`${API}/documents`);
      const data = await res.json();
      setDocuments(data.documents);
    } catch {
      setStatus({ text: "Cannot reach the backend. Is uvicorn running?", type: "error" });
    }
  }

  useEffect(() => {
    loadDocuments();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  async function uploadFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setStatus({ text: "Please choose a PDF file.", type: "error" });
      return;
    }

    setUploading(true);
    setStatus({ text: "Uploading and indexing...", type: "" });

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API}/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      setStatus({ text: `Indexed ${data.chunks_stored} chunks from ${data.pages} pages`, type: "ok" });
      setSelectedDoc(data.filename);
      loadDocuments();
    } catch (err) {
      setStatus({ text: err.message, type: "error" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleDelete(e, name) {
    e.stopPropagation();
    await fetch(`${API}/documents/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (selectedDoc === name) setSelectedDoc("");
    loadDocuments();
  }

  async function ask(question) {
    const q = question.trim();
    if (!q || thinking) return;

    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setInput("");
    setThinking(true);

    try {
      const res = await fetch(`${API}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: q, filename: selectedDoc || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error("The server returned an error.");

      const notFound = data.answer.replace(/’/g, "'").toLowerCase().includes("couldn't find");

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.answer.replace(/【/g, "[").replace(/】/g, "]"),
          sources: notFound ? [] : data.sources,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Something went wrong: ${err.message}`, sources: [] },
      ]);
    } finally {
      setThinking(false);
    }
  }

  const noDocs = documents.length === 0;

  return (
    <div className="app">
      {/* ---------- Sidebar ---------- */}
      <aside className="sidebar">
        <div>
          <h1 className="brand">Doc<span>Chat</span></h1>
          <p className="tagline">Ask questions, get cited answers.</p>
        </div>

        <div
          className={`dropzone ${dragOver ? "over" : ""} ${uploading ? "busy" : ""}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            uploadFile(e.dataTransfer.files[0]);
          }}
        >
          <strong>{uploading ? "Indexing..." : "Upload a PDF"}</strong>
          Click or drag a file here
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            hidden
            onChange={(e) => uploadFile(e.target.files[0])}
          />
        </div>

        {status.text && <p className={`status ${status.type}`}>{status.text}</p>}

        <div>
          <h3 className="section-title">Documents</h3>
          {noDocs ? (
            <p className="empty">No documents yet.</p>
          ) : (
            <ul className="doc-list">
              <li
                className={`doc-item ${selectedDoc === "" ? "active" : ""}`}
                onClick={() => setSelectedDoc("")}
              >
                <span className="doc-name">All documents</span>
              </li>
              {documents.map((name) => (
                <li
                  key={name}
                  className={`doc-item ${selectedDoc === name ? "active" : ""}`}
                  onClick={() => setSelectedDoc(name)}
                  title={name}
                >
                  <span className="doc-name">{name}</span>
                  <button className="icon-btn" onClick={(e) => handleDelete(e, name)} title="Delete">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* ---------- Chat ---------- */}
      <main className="main">
        <div className="chat-header">
          Searching in: <strong>{selectedDoc || "all documents"}</strong>
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>{noDocs ? "Upload a PDF to begin" : "Ask your documents anything"}</h2>
              <p>
                {noDocs
                  ? "Your questions are answered using only the content of your files."
                  : "Answers come with the exact pages they were taken from."}
              </p>
              {!noDocs && (
                <div className="chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`row ${m.role === "user" ? "user" : ""}`}>
              <div className={`bubble ${m.role === "user" ? "user" : "bot"}`}>
                {m.text}

                {m.sources && m.sources.length > 0 && (
                  <details className="sources">
                    <summary>Sources ({m.sources.length})</summary>
                    {m.sources.map((src, j) => (
                      <div key={j} className="source">
                        <div className="source-head">
                          <span className="tag">[{j + 1}]</span>
                          <strong>{src.source}</strong>
                          <span className="tag">page {src.page}</span>
                        </div>
                        <p>{src.text.length > 260 ? src.text.slice(0, 260) + "..." : src.text}</p>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            </div>
          ))}

          {thinking && (
            <div className="row">
              <div className="bubble bot">
                <span className="typing"><i /><i /><i /></span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask(input)}
            placeholder={noDocs ? "Upload a PDF first" : "Ask a question..."}
            disabled={noDocs}
          />
          <button onClick={() => ask(input)} disabled={thinking || noDocs || !input.trim()}>
            Ask
          </button>
        </div>
      </main>
    </div>
  );
}
