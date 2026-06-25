import React, { useRef, useEffect, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ---------------------------------------------------------------------------
// Paste intelligence helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `text` looks like it was copied from a code editor:
 * - 3+ lines with at least 2 indented lines, OR
 * - matches common language keywords / syntax patterns.
 * Single-line snippets are intentionally excluded so backtick spans feel
 * natural for short things like `myVar`.
 */
function looksLikeCode(text) {
  if (!text || !text.includes('\n')) return false;  // single line → skip
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;

  // Two or more lines that start with whitespace → almost certainly indented code
  const indented = lines.filter(l => /^[ \t]+\S/.test(l));
  if (indented.length >= 2) return true;

  // Language-specific structural patterns (multi-line match)
  const CODE_PATTERNS = [
    /^\s*(def |async def |class |import |from .+ import)/m,  // Python
    /^\s*(function |const |let |var |class |import |export |=>)/m, // JS/TS
    /^\s*(fn |pub fn |use |impl |struct |enum |mod )/m,       // Rust
    /^\s*(func |package |import \()/m,                        // Go
    /^\s*(public|private|protected|static)\s+\w/m,           // Java/C#
    /[{};]$/m,                                                 // C-family braces
    /#include|#define|#pragma/m,                               // C/C++
    /^\s*(sub |my \$|use )/m,                                 // Perl
    /^\s*(def |end$|require )/m,                              // Ruby
  ];
  return CODE_PATTERNS.some(p => p.test(text));
}

/** EXT → Monaco/Markdown language identifier */
const EXT_TO_LANG = {
  py: 'python', js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', rs: 'rust',
  go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp',
  cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash',
  lua: 'lua', r: 'r', kt: 'kotlin', swift: 'swift',
  ex: 'elixir', exs: 'elixir', zig: 'zig',
};

/**
 * Best-effort language detection for a pasted block.
 * Priority:
 *  1. Selected node's file extension (Loom already knows what file we're in)
 *  2. Content pattern matching
 *  3. Empty string (plain code block, renderer will guess)
 */
function detectPastedLanguage(text, selected) {
  // 1. Use the currently focused node's extension
  if (selected) {
    const idPart = selected.id?.split(':')[1] || selected.label || '';
    const ext = idPart.split('.').pop()?.toLowerCase();
    if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  }

  // 2. Content-based heuristics
  if (/^\s*(def |async def |class .+:|from .+ import|import \w)/m.test(text)) return 'python';
  if (/^\s*(fn |pub fn |use |impl |struct |enum )/m.test(text))               return 'rust';
  if (/^\s*(func |package main|import \()/m.test(text))                       return 'go';
  if (/^\s*(function |const |let |var |=>|import .+ from|export )/m.test(text)) return 'javascript';
  if (/^\s*(public|private|void|class .+\{)/m.test(text))                    return 'java';
  if (/#include|#define/m.test(text))                                          return 'cpp';
  if (/^\s*(sub |my \$|use strict)/m.test(text))                              return 'perl';
  if (/^\s*(def .+|end$|require ['"]\w)/m.test(text))                            return 'ruby';

  return '';  // unknown — plain code block
}

// BUG-7: v8-compatible code component — checks node.type instead of the
// deprecated `inline` boolean prop which gets passed to the DOM and causes
// React warnings.
function MarkdownCode({ node, children, className, ...props }) {
  const isBlock = node?.type === 'code' || String(children).includes('\n');
  if (isBlock) {
    return (
      <pre style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-emphasis)',
        padding: '10px 12px',
        borderRadius: 4,
        overflowX: 'auto',
        margin: '8px 0',
        fontSize: '12px',
        lineHeight: 1.5
      }}>
        <code className={className} {...props}>{children}</code>
      </pre>
    );
  }
  return (
    <code style={{
      background: 'var(--bg-secondary)',
      padding: '2px 5px',
      borderRadius: 3,
      fontSize: '0.88em',
      fontFamily: 'var(--font-mono)'
    }} {...props}>
      {children}
    </code>
  );
}

/**
 * Strip LaTeX-style math notation from AI output.
 * The model often wraps variable names and indices in $...$ which renders as
 * raw dollar signs in react-markdown (no math plugin loaded).
 *
 * Rules applied in order:
 *   1. $$...$$  (block math)  → fenced code block
 *   2. $...$    (inline math) → backtick span
 *   3. Lone \$ escape → literal $
 */
function deLatex(text) {
  if (!text || !text.includes('$')) return text;
  // Block math: $$...$$  (possibly multi-line) → ```\n...\n```
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) => '```\n' + inner.trim() + '\n```');
  // Inline math: $...$ — only match when content is non-empty and has no newline
  // Avoids eating lone $ signs (e.g. shell variables, prices)
  text = text.replace(/\$([^$\n]+?)\$/g, '`$1`');
  return text;
}

const MD_COMPONENTS = {
  p: ({ children }) => <p style={{ margin: '0 0 8px 0', lineHeight: 1.6 }}>{children}</p>,
  code: MarkdownCode,
  ul: ({ children }) => <ul style={{ margin: '4px 0 8px 16px', padding: 0 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '4px 0 8px 16px', padding: 0 }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
  h2: ({ children }) => <h2 style={{ fontSize: '13px', fontWeight: 700, margin: '12px 0 4px 0', color: 'var(--accent-primary)' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: '12px', fontWeight: 600, margin: '8px 0 4px 0', color: 'var(--text-primary)' }}>{children}</h3>,
  strong: ({ children }) => <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{children}</strong>,
  // GFM table components
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{
        borderCollapse: 'collapse',
        fontSize: '12px',
        fontFamily: 'var(--font-mono)',
        width: '100%',
        minWidth: 'max-content',
      }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead style={{ background: 'var(--bg-tertiary)' }}>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr style={{ borderBottom: '1px solid var(--border-default)' }}>{children}</tr>,
  th: ({ children }) => (
    <th style={{
      padding: '6px 12px',
      textAlign: 'left',
      color: 'var(--accent-primary)',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      borderBottom: '1px solid var(--border-emphasis)',
    }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{
      padding: '5px 12px',
      color: 'var(--text-secondary)',
      verticalAlign: 'top',
    }}>{children}</td>
  ),
};

export default function BottomDock({
  dockOpen, dockHeight, dockTab, setDockTab,
  setDockOpen,
  openDocument, setOpenDocument,
  chatMessages, setChatMessages,
  chatInput, setChatInput,
  chatLoading, sendChatMessage,
  chatContextNode, setChatContextNode,
  selected,
  startDockResize,
}) {
  const chatEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Grow the textarea to fit content — collapses first so scrollHeight is accurate.
  // Capped at 180px (~9 lines), then it scrolls.
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  useEffect(() => { autoResize(); }, [chatInput, autoResize]);

  /**
   * Smart paste — code-like content is auto-wrapped in a fenced block.
   * Plain text passes through untouched.
   */
  const handlePaste = useCallback((e) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text || !looksLikeCode(text)) return;

    e.preventDefault();
    const lang  = detectPastedLanguage(text, selected);
    const fence = `\`\`\`${lang}\n${text}\n\`\`\``;

    const el    = textareaRef.current;
    const start = el ? el.selectionStart : chatInput.length;
    const end   = el ? el.selectionEnd   : chatInput.length;

    const before = chatInput.slice(0, start);
    const after  = chatInput.slice(end);
    const sep    = before && !before.endsWith('\n') ? '\n\n' : '';
    const sep2   = after  && !after.startsWith('\n') ? '\n\n' : '';
    const next   = before + sep + fence + sep2 + after;

    setChatInput(next);

    requestAnimationFrame(() => {
      if (el) {
        const pos = (before + sep + fence + sep2).length;
        el.setSelectionRange(pos, pos);
        autoResize();
      }
    });
  }, [chatInput, selected, setChatInput, autoResize]);


  // Auto-scroll chat when new messages arrive
  useEffect(() => {
    if (chatEndRef.current && dockTab === 'chat') {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, dockTab]);

  // Context switched = the node we sent last message about differs from currently selected
  const didContextSwitch =
    chatMessages.length > 0 &&
    chatContextNode &&
    selected &&
    chatContextNode.id !== selected.id;

  if (!dockOpen) return null;

  return (
    <div className="bottom-dock" style={{ height: dockHeight }}>
      <div
        className="dock-resize-handle"
        onMouseDown={startDockResize}
        title="Drag to resize"
      />

      <div className="dock-tab-bar">
        <button
          className={`dock-tab-btn ${dockTab === 'source' ? 'active' : ''}`}
          onClick={() => setDockTab('source')}
        >
          ◫ SOURCE
        </button>
        <button
          className={`dock-tab-btn ${dockTab === 'chat' ? 'active' : ''}`}
          onClick={() => setDockTab('chat')}
        >
          ✦ AI ASSISTANT
        </button>
        <button
          className="dock-tab-btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => setDockOpen(false)}
          title="Close dock (Ctrl+J)"
        >
          ✕
        </button>
      </div>

      <div className="dock-content">
        {/* ── SOURCE TAB ─────────────────────────────────────────────── */}
        {dockTab === 'source' ? (
          openDocument ? (
            <Editor
              height="100%"
              language={openDocument.language}
              theme="vs-dark"
              value={openDocument.code}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 13,
                wordWrap: 'on',
                scrollBeyondLastLine: false,
                fontFamily: 'var(--font-mono)',
                padding: { top: 16 },
                automaticLayout: true,
              }}
            />
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 8,
              color: 'var(--text-tertiary)',
              fontSize: 13
            }}>
              <span style={{ fontSize: 24 }}>◫</span>
              <span>No source open</span>
              <span style={{ fontSize: 11 }}>Select a node and press Ctrl+1</span>
            </div>
          )
        ) : (
          /* ── AI CHAT TAB ─────────────────────────────────────────────── */
          <div className="chat-container">
            {/* BUG-8: Context switch banner with action buttons */}
            {didContextSwitch && (
              <div className="chat-banner">
                <span>
                  Context: <strong>{chatContextNode.label}</strong> → <strong>{selected.label}</strong>
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setChatContextNode(selected)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--warning)',
                      color: 'var(--warning)',
                      padding: '2px 10px',
                      borderRadius: 3,
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-mono)'
                    }}
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => {
                      setChatMessages([]);
                      setChatContextNode(selected);
                    }}
                    style={{
                      background: 'var(--warning)',
                      border: 'none',
                      color: 'var(--bg-primary)',
                      padding: '2px 10px',
                      borderRadius: 3,
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600
                    }}
                  >
                    Start Fresh
                  </button>
                </div>
              </div>
            )}

            <div className="chat-messages">
              {chatMessages.length === 0 ? (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  gap: 8,
                  color: 'var(--text-tertiary)',
                  fontSize: 13
                }}>
                  <span style={{ fontSize: 22 }}>✦</span>
                  <span>
                    {selected
                      ? `Ask about ${selected.type} '${selected.label}'`
                      : 'Ask about this repository'}
                  </span>
                  {selected && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 8 }}>
                      {['Explain this', 'What calls this?', 'Any bugs?', 'How does this fit in?'].map(q => (
                        <button
                          key={q}
                          className="chat-suggestion-btn"
                          onClick={() => sendChatMessage(q)}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                chatMessages.map((msg, i) => (
                  <div key={i} className={`chat-message ${msg.role}`}>
                    <div className="chat-bubble">
                      {/* User messages also render through ReactMarkdown — 
                          users are intentionally typing markdown in the textarea. */}
                      {msg.role === 'user' ? (
                        <div style={{ whiteSpace: 'pre-wrap' }}>
                          <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkGfm]}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkGfm]}>
                          {deLatex(msg.content)}
                        </ReactMarkdown>
                      )}
                    </div>
                  </div>
                ))
              )}

              {chatLoading && (
                <div className="chat-message assistant">
                  <div className="chat-bubble" style={{ opacity: 0.6 }}>
                    <span style={{ animation: 'pulse 1.2s ease-in-out infinite' }}>
                      Thinking...
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="chat-input-row">
              <textarea
                ref={textareaRef}
                className="chat-textarea"
                rows={1}
                placeholder={
                  selected
                    ? `Ask about ${selected.label}...`
                    : 'Ask about the repository...'
                }
                value={chatInput}
                onChange={e => {
                  setChatInput(e.target.value);
                  autoResize();
                }}
                onPaste={handlePaste}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!chatLoading && chatInput.trim()) {
                      sendChatMessage(chatInput);
                    }
                  }
                }}
                disabled={chatLoading}
              />
              <button
                className="chat-send-btn"
                style={{
                  background: chatLoading || !chatInput.trim()
                    ? 'var(--bg-tertiary)'
                    : 'var(--accent-primary)',
                  color: chatLoading || !chatInput.trim()
                    ? 'var(--text-tertiary)'
                    : 'var(--bg-primary)',
                  cursor: chatLoading || !chatInput.trim() ? 'default' : 'pointer',
                }}
                onClick={() => sendChatMessage(chatInput)}
                disabled={chatLoading || !chatInput.trim()}
              >
                ↑
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
