/**
 * OllamaInstaller Component
 * 
 * Handles first-launch Ollama detection and installation.
 * Features:
 * - Consent modal before installation
 * - Progress UI with live status updates
 * - 10-minute timeout watchdog
 * - localStorage persistence for installation state
 * - Error handling with retry capability
 * - Model verification (checks for gemma4:4b)
 */
import React, { useState, useEffect, useRef } from 'react';
import { Command } from '@tauri-apps/plugin-shell';

// Installation states
const STATES = {
    CHECKING: 'checking',
    CONSENT: 'consent',           // Need full install (Ollama + model)
    CONSENT_MODEL: 'consent_model', // Ollama installed, just need model
    INSTALLING: 'installing',
    READY: 'ready',
    ERROR: 'error'
};

// Progress stages with percentages and display text
const PROGRESS_STAGES = {
    DOWNLOADING: { percent: 25, text: 'Downloading Ollama...' },
    INSTALLING: { percent: 50, text: 'Installing Ollama...' },
    SERVING: { percent: 70, text: 'Starting Ollama...' },
    PULLING_MODEL: { percent: 85, text: 'Downloading AI model (~3GB)...' },
    MODEL_READY: { percent: 100, text: 'AI Engine Ready!' }
};

// Progress stages for model-only install
const MODEL_ONLY_STAGES = {
    SERVING: { percent: 30, text: 'Starting Ollama...' },
    PULLING_MODEL: { percent: 60, text: 'Downloading AI model (~3GB)...' },
    MODEL_READY: { percent: 100, text: 'AI Engine Ready!' }
};

const STORAGE_KEY = 'loom_ollama_installed';
const MODEL_NAME = 'gemma4:e2b';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Check if Ollama is already installed and accessible.
 * Uses multiple detection methods:
 * 1. Check standard Windows installation path
 * 2. Check if 'ollama' is available in PATH via Get-Command
 */
async function checkOllamaInstalled() {
    try {
        // PowerShell script that checks:
        // 1. The standard Ollama install location on Windows
        // 2. Whether 'ollama' command is available in PATH
        const checkScript = `
            $ollamaPath = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe'
            if (Test-Path $ollamaPath) {
                Write-Output 'FOUND'
                exit 0
            }
            if (Get-Command ollama -ErrorAction SilentlyContinue) {
                Write-Output 'FOUND'
                exit 0
            }
            Write-Output 'NOT_FOUND'
            exit 1
        `;
        const cmd = Command.create('powershell', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            checkScript
        ]);
        const output = await cmd.execute();
        console.log('Ollama check output:', output.stdout, 'code:', output.code);
        return output.code === 0 || output.stdout.trim() === 'FOUND';
    } catch (e) {
        console.error('Ollama check failed:', e);
        return false;
    }
}

/**
 * Check if the required model is installed by inspecting Ollama's manifest
 * directory on disk. This does NOT require the Ollama service to be running,
 * avoiding hangs on first launch before the service has been started.
 *
 * Manifest path: %USERPROFILE%\.ollama\models\manifests\registry.ollama.ai\library\<family>\<tag>
 * For qwen2.5:3b → family = qwen2.5, tag = 3b
 */
async function checkModelInstalled() {
    try {
        // Parse "family:tag" from MODEL_NAME (e.g. "qwen2.5:3b" → family="qwen2.5", tag="3b")
        const [family, tag = 'latest'] = MODEL_NAME.split(':');
        const checkScript = `
            $manifestPath = Join-Path $env:USERPROFILE '.ollama\\models\\manifests\\registry.ollama.ai\\library\\${family}\\${tag}'
            if (Test-Path $manifestPath) {
                Write-Output 'FOUND'
                exit 0
            }
            Write-Output 'NOT_FOUND'
            exit 1
        `;
        const cmd = Command.create('powershell', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            checkScript
        ]);
        const output = await cmd.execute();
        console.log('Model manifest check:', output.stdout.trim(), 'code:', output.code);
        return output.code === 0 || output.stdout.trim() === 'FOUND';
    } catch (e) {
        console.error('Model check failed:', e);
        return false;
    }
}

/**
 * Main installer component
 */
export default function OllamaInstaller({ onReady }) {
    const [state, setState] = useState(STATES.CHECKING);
    const [progress, setProgress] = useState(0);
    const [statusText, setStatusText] = useState('Checking system...');
    const [errorMessage, setErrorMessage] = useState('');
    const [modelOnly, setModelOnly] = useState(false); // Track if we're doing model-only install

    const childProcessRef = useRef(null);
    const timeoutRef = useRef(null);

    // Check installation status on mount
    useEffect(() => {
        const checkStatus = async () => {
            // Quick check: localStorage flag
            if (localStorage.getItem(STORAGE_KEY) === 'true') {
                // Verify both Ollama and model are still installed
                const isOllamaInstalled = await checkOllamaInstalled();
                if (isOllamaInstalled) {
                    const isModelInstalled = await checkModelInstalled();
                    if (isModelInstalled) {
                        setState(STATES.READY);
                        setTimeout(() => onReady(), 500);
                        return;
                    }
                    // Ollama installed but model missing - prompt for model only
                    setModelOnly(true);
                    setState(STATES.CONSENT_MODEL);
                    return;
                }
                // Flag was set but Ollama not found - clear and re-prompt
                localStorage.removeItem(STORAGE_KEY);
            }

            // Full check
            const isOllamaInstalled = await checkOllamaInstalled();
            if (isOllamaInstalled) {
                // Check if model is also installed
                const isModelInstalled = await checkModelInstalled();
                if (isModelInstalled) {
                    localStorage.setItem(STORAGE_KEY, 'true');
                    setState(STATES.READY);
                    setTimeout(() => onReady(), 500);
                } else {
                    // Ollama installed but model missing
                    setModelOnly(true);
                    setState(STATES.CONSENT_MODEL);
                }
            } else {
                setState(STATES.CONSENT);
            }
        };

        checkStatus();
    }, [onReady]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            if (childProcessRef.current) {
                try {
                    childProcessRef.current.kill();
                } catch (e) {
                    console.error('Failed to kill child process:', e);
                }
            }
        };
    }, []);

    const handleInstall = async () => {
        setState(STATES.INSTALLING);
        setProgress(5);
        setStatusText('Preparing installation...');

        // Choose script based on whether we need full install or model-only
        const fullInstallScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  # Resolve ollama path
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
  # Resolve ollama path
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
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command', script
            ]);

            // Set up timeout watchdog
            timeoutRef.current = setTimeout(() => {
                if (childProcessRef.current) {
                    try {
                        childProcessRef.current.kill();
                    } catch (e) {
                        console.error('Failed to kill timed-out process:', e);
                    }
                }
                setErrorMessage('Installation timed out. Please check your internet connection and try again.');
                setState(STATES.ERROR);
            }, INSTALL_TIMEOUT_MS);

            // Handle stdout for progress updates
            cmd.stdout.on('data', (line) => {
                const trimmed = line.trim();
                console.log('Installer output:', trimmed);

                if (stages[trimmed]) {
                    setProgress(stages[trimmed].percent);
                    setStatusText(stages[trimmed].text);
                } else if (trimmed.startsWith('ERROR:')) {
                    setErrorMessage(trimmed.replace('ERROR:', '').trim());
                    setState(STATES.ERROR);
                }
            });

            // Handle close event for completion
            cmd.on('close', (data) => {
                console.log('Install process completed with code:', data.code);

                // Clear timeout
                if (timeoutRef.current) {
                    clearTimeout(timeoutRef.current);
                    timeoutRef.current = null;
                }

                if (data.code === 0) {
                    localStorage.setItem(STORAGE_KEY, 'true');
                    setState(STATES.READY);
                    // 500ms delay for smoother UX
                    setTimeout(() => onReady(), 500);
                } else if (state !== STATES.ERROR) {
                    setErrorMessage(`Installation failed with code ${data.code}. Please try again.`);
                    setState(STATES.ERROR);
                }
            });

            cmd.on('error', (error) => {
                console.error('Command error:', error);
                if (timeoutRef.current) {
                    clearTimeout(timeoutRef.current);
                }
                setErrorMessage(`Installation error: ${error}`);
                setState(STATES.ERROR);
            });

            // Spawn the process (non-blocking)
            const child = await cmd.spawn();
            childProcessRef.current = child;

        } catch (e) {
            console.error('Installation error:', e);
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
            setErrorMessage(`Installation failed: ${e.message || e}`);
            setState(STATES.ERROR);
        }
    };

    const handleRetry = () => {
        setErrorMessage('');
        setProgress(0);
        handleInstall();
    };

    const handleCancel = async () => {
        // Close the app using Tauri's exit API
        try {
            const { exit } = await import('@tauri-apps/plugin-process');
            await exit(0);
        } catch (e) {
            // Fallback: close window
            window.close();
        }
    };

    // Render based on state
    return (
        <div className="installer-overlay">
            <div className="installer-container">
                {/* Logo */}
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

                {/* Checking State */}
                {state === STATES.CHECKING && (
                    <div className="installer-content">
                        <div className="installer-spinner" />
                        <p className="installer-status">Checking system...</p>
                    </div>
                )}

                {/* Consent Modal - Full Install */}
                {state === STATES.CONSENT && (
                    <div className="installer-content">
                        <h1 className="installer-title">Local AI Required</h1>
                        <p className="installer-description">
                            Loom uses a local AI engine (Ollama) for code analysis.
                            <br /><br />
                            This will download ~500MB and run fully offline after setup.
                        </p>
                        <div className="installer-buttons">
                            <button className="installer-btn-primary" onClick={handleInstall}>
                                Install AI Engine
                            </button>
                            <button className="installer-btn-secondary" onClick={handleCancel}>
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Consent Modal - Model Only */}
                {state === STATES.CONSENT_MODEL && (
                    <div className="installer-content">
                        <h1 className="installer-title">AI Model Required</h1>
                        <p className="installer-description">
                            Ollama is installed, but the AI model is missing.
                            <br /><br />
                            This will download ~3GB for the language model.
                        </p>
                        <div className="installer-buttons">
                            <button className="installer-btn-primary" onClick={handleInstall}>
                                Download AI Model
                            </button>
                            <button className="installer-btn-secondary" onClick={handleCancel}>
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Installing State */}
                {state === STATES.INSTALLING && (
                    <div className="installer-content">
                        <h1 className="installer-title">{modelOnly ? 'Downloading AI Model' : 'Preparing Local AI'}</h1>
                        <p className="installer-description">
                            {modelOnly ? 'Downloading the language model...' : 'Downloading and installing Ollama...'}
                        </p>
                        <div className="installer-progress-container">
                            <div className="installer-progress-bar">
                                <div
                                    className="installer-progress-fill"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <p className="installer-status">{statusText}</p>
                        </div>
                        <div className="installer-spinner" />
                    </div>
                )}

                {/* Ready State */}
                {state === STATES.READY && (
                    <div className="installer-content">
                        <div className="installer-success-icon">✓</div>
                        <h1 className="installer-title">Local AI Ready</h1>
                        <p className="installer-status">Launching Loom...</p>
                    </div>
                )}

                {/* Error State */}
                {state === STATES.ERROR && (
                    <div className="installer-content">
                        <div className="installer-error-icon">✕</div>
                        <h1 className="installer-title">Installation Failed</h1>
                        <p className="installer-description installer-error-text">
                            {errorMessage || 'Please check your internet connection and retry.'}
                        </p>
                        <div className="installer-buttons">
                            <button className="installer-btn-primary" onClick={handleRetry}>
                                Retry
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
