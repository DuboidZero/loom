import React, { useState, useEffect } from "react";

const API = "http://127.0.0.1:8000";

export default function Settings({ isOpen, onClose }) {
    const [gitPath, setGitPath] = useState("");
    const [ollamaHost, setOllamaHost] = useState("http://localhost:11434");
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState("");
    const [clearingCache, setClearingCache] = useState(false);

    // Load settings from backend on mount
    useEffect(() => {
        if (isOpen) {
            loadSettings();
        }
    }, [isOpen]);

    const loadSettings = async () => {
        try {
            const res = await fetch(`${API}/settings`);
            if (res.ok) {
                const data = await res.json();
                setGitPath(data.git_path || "");
                setOllamaHost(data.ollama_host || "http://localhost:11434");
            }
        } catch (e) {
            console.error("Failed to load settings:", e);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setMessage("");
        try {
            const res = await fetch(`${API}/settings`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    git_path: gitPath,
                    ollama_host: ollamaHost
                })
            });
            if (res.ok) {
                setMessage("Settings saved successfully!");
                setTimeout(() => setMessage(""), 3000);
            } else {
                const data = await res.json();
                setMessage("Error: " + (data.error || "Failed to save"));
            }
        } catch (e) {
            setMessage("Error: " + e.message);
        }
        setSaving(false);
    };

    const handleClearCache = async () => {
        setClearingCache(true);
        setMessage("");
        try {
            const res = await fetch(`${API}/clear-cache`, { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
                setMessage(`Cache cleared — ${data.deleted} file(s) removed.`);
            } else {
                setMessage("Error: " + (data.message || "Failed to clear cache"));
            }
        } catch (e) {
            setMessage("Error: " + e.message);
        }
        setClearingCache(false);
        setTimeout(() => setMessage(""), 4000);
    };

    if (!isOpen) return null;

    return (
        <div style={overlayStyle} onClick={onClose}>
            <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
                <div style={headerStyle}>
                    <span style={titleStyle}>SETTINGS</span>
                    <button onClick={onClose} style={closeIconStyle}>✕</button>
                </div>

                <div style={contentStyle}>
                    {/* Git Path Setting */}
                    <div style={settingGroupStyle}>
                        <label style={labelStyle}>GIT_PATH</label>
                        <p style={descriptionStyle}>
                            Path to the Git executable on your system (e.g., C:\Program Files\Git\bin\git.exe or /usr/bin/git)
                        </p>
                        <input
                            type="text"
                            value={gitPath}
                            onChange={(e) => setGitPath(e.target.value)}
                            placeholder="Enter Git executable path..."
                            style={inputStyle}
                        />
                    </div>

                    {/* Ollama Host Setting */}
                    <div style={settingGroupStyle}>
                        <label style={labelStyle}>OLLAMA_HOST</label>
                        <p style={descriptionStyle}>
                            URL of the Ollama server for AI-powered code analysis (default: http://localhost:11434)
                        </p>
                        <input
                            type="text"
                            value={ollamaHost}
                            onChange={(e) => setOllamaHost(e.target.value)}
                            placeholder="http://localhost:11434"
                            style={inputStyle}
                        />
                    </div>

                    {/* Clear Cache */}
                    <div style={settingGroupStyle}>
                        <label style={labelStyle}>GRAPH_CACHE</label>
                        <p style={descriptionStyle}>
                            Clears all cached repository graphs from disk (~/.loom/graph_cache). Next scan will re-analyse from scratch.
                        </p>
                        <button
                            onClick={handleClearCache}
                            disabled={clearingCache}
                            style={{ ...saveBtnStyle, background: "#ff5555", marginBottom: 0 }}
                            id="btn-clear-cache"
                        >
                            {clearingCache ? "CLEARING..." : "CLEAR_GRAPH_CACHE"}
                        </button>
                    </div>

                    {/* Message Display */}
                    {message && (
                        <div style={{
                            ...messageStyle,
                            color: message.startsWith("Error") ? "#ff5555" : "#00ff88"
                        }}>
                            {message}
                        </div>
                    )}

                    {/* Save Button */}
                    <button onClick={handleSave} disabled={saving} style={saveBtnStyle}>
                        {saving ? "SAVING..." : "SAVE_SETTINGS"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Styles
const overlayStyle = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0, 0, 0, 0.8)",
    backdropFilter: "blur(5px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2000
};

const modalStyle = {
    width: "500px",
    maxWidth: "90vw",
    maxHeight: "80vh",
    background: "rgba(15, 15, 15, 0.98)",
    border: "1px solid #333",
    borderRadius: "6px",
    boxShadow: "0 30px 80px rgba(0, 0, 0, 0.9)",
    overflow: "hidden"
};

const headerStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 25px",
    borderBottom: "1px solid #222",
    background: "rgba(0, 0, 0, 0.5)"
};

const titleStyle = {
    color: "#00ff88",
    fontSize: "12px",
    fontWeight: "bold",
    letterSpacing: "3px"
};

const closeIconStyle = {
    background: "none",
    border: "none",
    color: "#666",
    fontSize: "18px",
    cursor: "pointer",
    padding: "5px",
    lineHeight: 1
};

const contentStyle = {
    padding: "30px 25px",
    overflowY: "auto"
};

const settingGroupStyle = {
    marginBottom: "30px"
};

const labelStyle = {
    display: "block",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "bold",
    letterSpacing: "2px",
    marginBottom: "8px"
};

const descriptionStyle = {
    color: "#666",
    fontSize: "12px",
    lineHeight: "1.5",
    margin: "0 0 12px 0"
};

const inputStyle = {
    width: "100%",
    padding: "14px 16px",
    background: "#0a0a0a",
    border: "1px solid #333",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
    fontFamily: "'Courier New', monospace",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.2s"
};

const messageStyle = {
    fontSize: "12px",
    letterSpacing: "1px",
    marginBottom: "20px",
    padding: "10px",
    background: "rgba(0, 255, 136, 0.1)",
    borderRadius: "4px"
};

const saveBtnStyle = {
    width: "100%",
    padding: "16px",
    background: "#00ff88",
    border: "none",
    borderRadius: "4px",
    color: "#000",
    fontSize: "12px",
    fontWeight: "bold",
    letterSpacing: "2px",
    cursor: "pointer",
    fontFamily: "'Courier New', monospace"
};
