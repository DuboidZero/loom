/**
 * WelcomeScreen Component
 *
 * Displayed when no workspace is loaded. Mimics the VSCode welcome page with:
 * - "Open Folder" button  (delegates dialog to App.js via onOpenFolder())
 * - "GitHub URL" input section
 * - Recent workspaces list (from localStorage)
 */
import React, { useState } from 'react';
import logo from './logo.png';

const RECENT_KEY = 'loom_recent_workspaces';
const MAX_RECENT = 8;

/**
 * Reads recent workspaces from localStorage.
 */
function getRecentWorkspaces() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

export default function WelcomeScreen({ onOpenFolder, onOpenGithub }) {
  const [githubUrl, setGithubUrl] = useState('');
  const [githubError, setGithubError] = useState('');
  const [recents, setRecents] = useState(getRecentWorkspaces);

  // Just delegate to App.js — it handles the native Tauri dialog
  const handleOpenFolder = () => {
    onOpenFolder();
  };

  const handleClearRecents = () => {
    localStorage.removeItem(RECENT_KEY);
    setRecents([]);
  };

  const handleGithubSubmit = () => {
    const trimmed = githubUrl.trim();
    if (!trimmed) {
      setGithubError('Please enter a GitHub URL.');
      return;
    }
    if (!trimmed.includes('github.com') && !trimmed.startsWith('http')) {
      setGithubError('Enter a valid GitHub repository URL.');
      return;
    }
    setGithubError('');
    onOpenGithub(trimmed);
  };

  return (
    <div className="welcome-screen">
      {/* Background grid decoration */}
      <div className="welcome-bg-grid" />

      <div className="welcome-content">
        {/* Branding */}
        <div className="welcome-brand">
          <img src={logo} alt="Loom" className="welcome-logo" />
          <div>
            <h1 className="welcome-title">LOOM</h1>
            <p className="welcome-subtitle">Code visualization &amp; analysis</p>
          </div>
        </div>

        <div className="welcome-panels">
          {/* Start Panel */}
          <div className="welcome-panel">
            <h2 className="welcome-panel-header">Start</h2>
            <div className="welcome-actions">
              <button className="welcome-action-btn" onClick={handleOpenFolder} id="btn-open-folder">
                <span className="welcome-action-icon">
                  <FolderIcon />
                </span>
                <span className="welcome-action-label">Open Folder...</span>
              </button>

              {/* GitHub section */}
              <div className="welcome-github-section">
                <div className="welcome-action-label-row">
                  <span className="welcome-action-icon"><GithubIcon /></span>
                  <span style={{ fontSize: 13, color: '#4fc1ff' }}>Clone GitHub Repository...</span>
                </div>
                <div className="welcome-github-input-row">
                  <input
                    className="welcome-github-input"
                    placeholder="https://github.com/user/repo"
                    value={githubUrl}
                    onChange={e => { setGithubUrl(e.target.value); setGithubError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleGithubSubmit()}
                    id="input-github-url"
                    autoComplete="off"
                  />
                  <button className="welcome-github-btn" onClick={handleGithubSubmit} id="btn-clone-github">
                    Analyze
                  </button>
                </div>
                {githubError && <p className="welcome-github-error">{githubError}</p>}
              </div>
            </div>
          </div>

          {/* Recent Panel */}
          {recents.length > 0 && (
            <div className="welcome-panel">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 0 }}>
                <h2 className="welcome-panel-header" style={{ marginBottom: 0 }}>Recent</h2>
                <button
                  onClick={handleClearRecents}
                  title="Clear recent workspaces"
                  style={{
                    background: 'none', border: 'none', color: '#555', cursor: 'pointer',
                    fontSize: 12, padding: '2px 6px', lineHeight: 1, borderRadius: 3,
                    transition: 'color 0.15s'
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = '#ff5555'}
                  onMouseLeave={e => e.currentTarget.style.color = '#555'}
                  id="btn-clear-recents"
                >✕ clear</button>
              </div>
              <div className="welcome-recent-list">
                {recents.map((item, idx) => (
                  <button
                    key={idx}
                    className="welcome-recent-item"
                    onClick={() => onOpenGithub ? onOpenFolder(item.path) : onOpenFolder(item.path)}
                    title={item.path}
                  >
                    <span className="welcome-recent-name">{item.name}</span>
                    <span className="welcome-recent-path">{item.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Saves a newly opened path to the recent workspaces list in localStorage.
 */
export function saveRecentWorkspace(path) {
  const name = path.replace(/\\/g, '/').split('/').pop() || path;
  let recent = getRecentWorkspaces();
  recent = recent.filter(r => r.path !== path);
  recent.unshift({ name, path });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

// --- Inline SVG Icons ---
function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6L7.5 4H13.5A1 1 0 0 1 14.5 5V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5V3.5Z" fill="#d4b44a" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#4fc1ff' }}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
    </svg>
  );
}
