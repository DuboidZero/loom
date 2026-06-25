/**
 * OllamaInstaller Component
 *
 * Handles first-launch Ollama detection and installation.
 *
 * Windows: Uses PowerShell for detection, downloads OllamaSetup.exe silently,
 *          pulls the required model.
 * Linux:   Uses /bin/sh to check for the ollama binary. Auto-install is NOT
 *          supported on Linux — the user is prompted with manual instructions.
 *          If Ollama is already installed, the model pull is done via CLI.
 * macOS:   Same as Linux path (sh-based detection, no auto-install).
 *
 * Features:
 * - Consent modal before installation
 * - Progress UI with live status updates
 * - 10-minute timeout watchdog (Windows)
 * - localStorage persistence for installation state
 * - Error handling with retry capability
 * - Model verification
 */
import React, { useState, useEffect, useRef } from 'react';
import { Command } from '@tauri-apps/plugin-shell';

// ---------------------------------------------------------------------------
// OS Detection
// ---------------------------------------------------------------------------
const IS_WINDOWS = navigator.userAgent.toLowerCase().includes('windows') ||
  (typeof window !== 'undefined' && window.navigator.platform.toLowerCase().startsWith('win'));

// Installation states
const STATES = {
  CHECKING: 'checking',
  CONSENT: 'consent',               // Need full install (Ollama + model)
  CONSENT_MODEL: 'consent_model',   // Ollama installed, just need model
  INSTALLING: 'installing',
  MANUAL_REQUIRED: 'manual',        // Linux/macOS: show install instructions
  READY: 'ready',
  ERROR: 'error'
};

const PROGRESS_STAGES = {
  DOWNLOADING: { percent: 25, text: 'Downloading Ollama...' },
  INSTALLING:  { percent: 50, text: 'Installing Ollama...' },
  SERVING:     { percent: 70, text: 'Starting Ollama...' },
  PULLING_MODEL: { percent: 85, text: 'Downloading AI model (~3GB)...' },
  MODEL_READY: { percent: 100, text: 'AI Engine Ready!' }
};

const MODEL_ONLY_STAGES = {
  SERVING:     { percent: 30, text: 'Starting Ollama...' },
  PULLING_MODEL: { percent: 60, text: 'Downloading AI model (~3GB)...' },
  MODEL_READY: { percent: 100, text: 'AI Engine Ready!' }
};

const STORAGE_KEY = 'loom_ollama_installed';
const MODEL_NAME = 'gemma4:e2b';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------
async function checkOllamaInstalledUnix() {
  try {
    const cmd = Command.create('sh', ['-c', 'which ollama || command -v ollama']);
    const output = await cmd.execute();
    console.log('Ollama (unix) check:', output.stdout.trim(), 'code:', output.code);
    return output.code === 0 && output.stdout.trim().length > 0;
  } catch (e) {
    console.error('Ollama unix check failed:', e);
    return false;
  }
}

async function checkOllamaInstalledWindows() {
  try {
    const checkScript = `
      $ollamaPath = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe'
      if (Test-Path $ollamaPath) { Write-Output 'FOUND'; exit 0 }
      if (Get-Command ollama -ErrorAction SilentlyContinue) { Write-Output 'FOUND'; exit 0 }
      Write-Output 'NOT_FOUND'; exit 1
    `;
    const cmd = Command.create('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', checkScript
    ]);
    const output = await cmd.execute();
    return output.code === 0 || output.stdout.trim() === 'FOUND';
  } catch (e) {
    return false;
  }
}

async function checkOllamaInstalled() {
  return IS_WINDOWS ? checkOllamaInstalledWindows() : checkOllamaInstalledUnix();
}

async function checkModelInstalledUnix() {
  try {
    // Check via ollama list — works even if serve isn't running
    const cmd = Command.create('sh', ['-c', `ollama list 2>/dev/null | grep -q '${MODEL_NAME.split(':')[0]}' && echo FOUND || echo NOT_FOUND`]);
    const output = await cmd.execute();
    if (output.stdout.trim() === 'FOUND') return true;

    // Fallback: check manifest on disk (~/.ollama/models/...)
    const [family, tag = 'latest'] = MODEL_NAME.split(':');
    const manifestCmd = Command.create('sh', [
      '-c',
      `test -f "$HOME/.ollama/models/manifests/registry.ollama.ai/library/${family}/${tag}" && echo FOUND || echo NOT_FOUND`
    ]);
    const manifestOutput = await manifestCmd.execute();
    return manifestOutput.stdout.trim() === 'FOUND';
  } catch (e) {
    return false;
  }
}

async function checkModelInstalledWindows() {
  try {
    const [family, tag = 'latest'] = MODEL_NAME.split(':');
    const checkScript = `
      $manifestPath = Join-Path $env:USERPROFILE '.ollama\\models\\manifests\\registry.ollama.ai\\library\\${family}\\${tag}'
      if (Test-Path $manifestPath) { Write-Output 'FOUND'; exit 0 }
      Write-Output 'NOT_FOUND'; exit 1
    `;
    const cmd = Command.create('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', checkScript
    ]);
    const output = await cmd.execute();
    return output.code === 0 || output.stdout.trim() === 'FOUND';
  } catch (e) {
    return false;
  }
}

async function checkModelInstalled() {
  return IS_WINDOWS ? checkModelInstalledWindows() : checkModelInstalledUnix();
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function OllamaInstaller({ onReady }) {
  const [state, setState] = useState(STATES.CHECKING);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Checking system...');
  const [errorMessage, setErrorMessage] = useState('');
  const [modelOnly, setModelOnly] = useState(false);

  const childProcessRef = useRef(null);
  const timeoutRef = useRef(null);

  useEffect(() => {
    const checkStatus = async () => {
      if (localStorage.getItem(STORAGE_KEY) === 'true') {
        const isOllamaInstalled = await checkOllamaInstalled();
        if (isOllamaInstalled) {
          const isModelInstalled = await checkModelInstalled();
          if (isModelInstalled) {
            setState(STATES.READY);
            setTimeout(() => onReady(), 500);
            return;
          }
          setModelOnly(true);
          setState(IS_WINDOWS ? STATES.CONSENT_MODEL : STATES.MANUAL_REQUIRED);
          return;
        }
        localStorage.removeItem(STORAGE_KEY);
      }

      const isOllamaInstalled = await checkOllamaInstalled();
      if (isOllamaInstalled) {
        const isModelInstalled = await checkModelInstalled();
        if (isModelInstalled) {
          localStorage.setItem(STORAGE_KEY, 'true');
          setState(STATES.READY);
          setTimeout(() => onReady(), 500);
        } else {
          setModelOnly(true);
          setState(IS_WINDOWS ? STATES.CONSENT_MODEL : STATES.MANUAL_REQUIRED);
        }
      } else {
        setState(IS_WINDOWS ? STATES.CONSENT : STATES.MANUAL_REQUIRED);
      }
    };

    checkStatus();
  }, [onReady]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (childProcessRef.current) {
        try { childProcessRef.current.kill(); } catch (e) {}
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Linux/macOS: pull model via CLI if ollama is already installed
  // ---------------------------------------------------------------------------
  const handlePullModelUnix = async () => {
    setState(STATES.INSTALLING);
    setProgress(30);
    setStatusText('Starting Ollama serve...');

    try {
      // Start ollama serve in background (ignore errors if already running)
      const serveCmd = Command.create('sh', ['-c', 'ollama serve &>/dev/null &']);
      await serveCmd.execute().catch(() => {});

      setProgress(50);
      setStatusText(`Pulling model ${MODEL_NAME}... (~3GB, may take several minutes)`);

      const pullCmd = Command.create('sh', ['-c', `ollama pull ${MODEL_NAME}`]);

      timeoutRef.current = setTimeout(() => {
        if (childProcessRef.current) {
          try { childProcessRef.current.kill(); } catch (e) {}
        }
        setErrorMessage('Model pull timed out. Check your internet connection and try again.');
        setState(STATES.ERROR);
      }, INSTALL_TIMEOUT_MS);

      pullCmd.stdout.on('data', (line) => {
        const trimmed = line.trim();
        if (trimmed) setStatusText(trimmed.slice(0, 80));
      });

      pullCmd.on('close', (data) => {
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        if (data.code === 0) {
          localStorage.setItem(STORAGE_KEY, 'true');
          setProgress(100);
          setStatusText('Model ready!');
          setState(STATES.READY);
          setTimeout(() => onReady(), 500);
        } else {
          setErrorMessage(`Model pull failed (exit ${data.code}). Run: ollama pull ${MODEL_NAME}`);
          setState(STATES.ERROR);
        }
      });

      pullCmd.on('error', (err) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setErrorMessage(`Error pulling model: ${err}`);
        setState(STATES.ERROR);
      });

      const child = await pullCmd.spawn();
      childProcessRef.current = child;

    } catch (e) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setErrorMessage(`Failed to pull model: ${e.message || e}`);
      setState(STATES.ERROR);
    }
  };

  // ---------------------------------------------------------------------------
  // Windows: full PowerShell install path (unchanged)
  // ---------------------------------------------------------------------------
  const handleInstallWindows = async () => {
    setState(STATES.INSTALLING);
    setProgress(5);
    setStatusText('Preparing installation...');

    const fullInstallScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $ollamaPath = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe'
  if (-not (Test-Path $ollamaPath)) {
    $found = Get-Command ollama -ErrorAction SilentlyContinue
    if ($found) { $ollamaPath = $found.Source } else { $ollamaPath = $null }
  }
  if (-not $ollamaPath) {
    Write-Output "DOWNLOADING"; [Console]::Out.Flush()
    $p = "$env:TEMP\\OllamaSetup.exe"
    Invoke-WebRequest https://ollama.com/download/OllamaSetup.exe -OutFile $p
    Write-Output "INSTALLING"; [Console]::Out.Flush()
    Start-Process $p -ArgumentList '/S' -Wait
    $ollamaPath = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe'
  }
  Write-Output "SERVING"; [Console]::Out.Flush()
  Start-Process $ollamaPath -ArgumentList 'serve' -WindowStyle Hidden
  Start-Sleep -Seconds 5
  Write-Output "PULLING_MODEL"; [Console]::Out.Flush()
  & $ollamaPath pull ${MODEL_NAME}
  Write-Output "MODEL_READY"; [Console]::Out.Flush()
} catch {
  Write-Output "ERROR: $_"; [Console]::Out.Flush()
  exit 1
}
`;

    const modelOnlyScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $ollamaPath = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe'
  if (-not (Test-Path $ollamaPath)) {
    $found = Get-Command ollama -ErrorAction SilentlyContinue
    if ($found) { $ollamaPath = $found.Source } else { Write-Output 'ERROR: Ollama not found'; exit 1 }
  }
  Write-Output "SERVING"; [Console]::Out.Flush()
  Start-Process $ollamaPath -ArgumentList 'serve' -WindowStyle Hidden
  Start-Sleep -Seconds 5
  Write-Output "PULLING_MODEL"; [Console]::Out.Flush()
  & $ollamaPath pull ${MODEL_NAME}
  Write-Output "MODEL_READY"; [Console]::Out.Flush()
} catch {
  Write-Output "ERROR: $_"; [Console]::Out.Flush()
  exit 1
}
`;

    const script = modelOnly ? modelOnlyScript : fullInstallScript;
    const stages = modelOnly ? MODEL_ONLY_STAGES : PROGRESS_STAGES;

    try {
      const cmd = Command.create('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script
      ]);

      timeoutRef.current = setTimeout(() => {
        if (childProcessRef.current) {
          try { childProcessRef.current.kill(); } catch (e) {}
        }
        setErrorMessage('Installation timed out.');
        setState(STATES.ERROR);
      }, INSTALL_TIMEOUT_MS);

      cmd.stdout.on('data', (line) => {
        const trimmed = line.trim();
        if (stages[trimmed]) {
          setProgress(stages[trimmed].percent);
          setStatusText(stages[trimmed].text);
        } else if (trimmed.startsWith('ERROR:')) {
          setErrorMessage(trimmed.replace('ERROR:', '').trim());
          setState(STATES.ERROR);
        }
      });

      cmd.on('close', (data) => {
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        if (data.code === 0) {
          localStorage.setItem(STORAGE_KEY, 'true');
          setState(STATES.READY);
          setTimeout(() => onReady(), 500);
        } else if (state !== STATES.ERROR) {
          setErrorMessage(`Installation failed (code ${data.code}).`);
          setState(STATES.ERROR);
        }
      });

      cmd.on('error', (error) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setErrorMessage(`Installation error: ${error}`);
        setState(STATES.ERROR);
      });

      const child = await cmd.spawn();
      childProcessRef.current = child;
    } catch (e) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setErrorMessage(`Installation failed: ${e.message || e}`);
      setState(STATES.ERROR);
    }
  };

  const handleInstall = () => {
    if (IS_WINDOWS) {
      handleInstallWindows();
    } else {
      handlePullModelUnix();
    }
  };

  const handleSkip = () => {
    // Allow the user to skip Ollama — graph works fine, only AI analysis is disabled
    localStorage.setItem(STORAGE_KEY, 'true');
    onReady();
  };

  const handleRetry = () => {
    setErrorMessage('');
    setProgress(0);
    handleInstall();
  };

  const handleCancel = async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process');
      await exit(0);
    } catch (e) {
      window.close();
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="installer-overlay">
      <div className="installer-container">
        <div className="installer-logo">
          <svg width="48" height="48" viewBox="0 0 100 100" fill="none">
            <circle cx="50" cy="50" r="45" stroke="var(--accent-primary)" strokeWidth="3" fill="none" />
            <circle cx="50" cy="50" r="8" fill="var(--accent-primary)" />
            <line x1="50" y1="5" x2="50" y2="25" stroke="var(--accent-primary)" strokeWidth="3" />
            <line x1="50" y1="75" x2="50" y2="95" stroke="var(--accent-primary)" strokeWidth="3" />
            <line x1="5" y1="50" x2="25" y2="50" stroke="var(--accent-primary)" strokeWidth="3" />
            <line x1="75" y1="50" x2="95" y2="50" stroke="var(--accent-primary)" strokeWidth="3" />
          </svg>
        </div>

        {state === STATES.CHECKING && (
          <div className="installer-content">
            <div className="installer-spinner" />
            <p className="installer-status">Checking system...</p>
          </div>
        )}

        {/* Windows: full install consent */}
        {state === STATES.CONSENT && IS_WINDOWS && (
          <div className="installer-content">
            <h1 className="installer-title">Local AI Required</h1>
            <p className="installer-description">
              Loom uses a local AI engine (Ollama) for code analysis.<br /><br />
              This will download ~500MB and run fully offline after setup.
            </p>
            <div className="installer-buttons">
              <button className="installer-btn-primary" onClick={handleInstall}>Install AI Engine</button>
              <button className="installer-btn-secondary" onClick={handleCancel}>Cancel</button>
            </div>
          </div>
        )}

        {/* Windows: model-only consent */}
        {state === STATES.CONSENT_MODEL && IS_WINDOWS && (
          <div className="installer-content">
            <h1 className="installer-title">AI Model Required</h1>
            <p className="installer-description">
              Ollama is installed, but the AI model is missing.<br /><br />
              This will download ~3GB for the language model.
            </p>
            <div className="installer-buttons">
              <button className="installer-btn-primary" onClick={handleInstall}>Download AI Model</button>
              <button className="installer-btn-secondary" onClick={handleCancel}>Cancel</button>
            </div>
          </div>
        )}

        {/* Linux/macOS: manual install instructions */}
        {state === STATES.MANUAL_REQUIRED && !IS_WINDOWS && (
          <div className="installer-content">
            <h1 className="installer-title">Ollama Not Found</h1>
            <p className="installer-description" style={{ whiteSpace: 'pre-wrap', textAlign: 'left', fontSize: 12 }}>
              {modelOnly
                ? `Ollama is installed but the model (${MODEL_NAME}) is missing.\n\nTo download the model, run in a terminal:\n\n  ollama pull ${MODEL_NAME}\n\nThen click Retry below.`
                : `Loom uses Ollama for AI-powered code analysis.\n\nInstall Ollama on Linux:\n\n  curl -fsSL https://ollama.com/install.sh | sh\n\nThen pull the model:\n\n  ollama pull ${MODEL_NAME}\n\nOr skip — graph visualization works without AI.`
              }
            </p>
            <div className="installer-buttons">
              {modelOnly && (
                <button className="installer-btn-primary" onClick={handlePullModelUnix}>
                  Pull Model Now
                </button>
              )}
              <button className="installer-btn-primary" onClick={handleRetry}>
                Retry Detection
              </button>
              <button className="installer-btn-secondary" onClick={handleSkip}>
                Skip (no AI)
              </button>
            </div>
          </div>
        )}

        {state === STATES.INSTALLING && (
          <div className="installer-content">
            <h1 className="installer-title">{modelOnly ? 'Downloading AI Model' : 'Preparing Local AI'}</h1>
            <p className="installer-description">
              {modelOnly ? `Pulling ${MODEL_NAME}...` : 'Downloading and installing Ollama...'}
            </p>
            <div className="installer-progress-container">
              <div className="installer-progress-bar">
                <div className="installer-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <p className="installer-status">{statusText}</p>
            </div>
            <div className="installer-spinner" />
          </div>
        )}

        {state === STATES.READY && (
          <div className="installer-content">
            <div className="installer-success-icon">✓</div>
            <h1 className="installer-title">Local AI Ready</h1>
            <p className="installer-status">Launching Loom...</p>
          </div>
        )}

        {state === STATES.ERROR && (
          <div className="installer-content">
            <div className="installer-error-icon">✕</div>
            <h1 className="installer-title">Setup Error</h1>
            <p className="installer-description installer-error-text" style={{ whiteSpace: 'pre-wrap' }}>
              {errorMessage || 'An error occurred. Please try again.'}
            </p>
            <div className="installer-buttons">
              <button className="installer-btn-primary" onClick={handleRetry}>Retry</button>
              <button className="installer-btn-secondary" onClick={handleSkip}>Skip (no AI)</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
