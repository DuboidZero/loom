/**
 * GitInstaller Component
 *
 * Handles first-launch Git detection and silent installation.
 *
 * Windows: Checks via PowerShell, silently downloads & installs Git for Windows.
 * Linux:   Checks via /bin/sh. Git is expected to be installed by the user;
 *          this component just verifies it's present and proceeds.
 * macOS:   Checks via /bin/sh. Falls through to onReady() if git is found.
 *
 * Features:
 * - Silent install with no user prompts (Windows only; Git is required)
 * - Progress UI with live status updates
 * - 5-minute timeout watchdog (Windows install)
 * - PATH refresh after install (Windows edge case prevention)
 * - Error handling with retry capability
 */
import React, { useState, useEffect, useRef } from 'react';
import { Command } from '@tauri-apps/plugin-shell';

// ---------------------------------------------------------------------------
// OS Detection — true for any non-Windows platform
// ---------------------------------------------------------------------------
const IS_WINDOWS = navigator.userAgent.toLowerCase().includes('windows') ||
  (typeof window !== 'undefined' && window.navigator.platform.toLowerCase().startsWith('win'));

// Installation states
const STATES = {
  CHECKING: 'checking',
  INSTALLING: 'installing',
  READY: 'ready',
  ERROR: 'error'
};

// Progress stages (Windows install path only)
const PROGRESS_STAGES = {
  DOWNLOADING: { percent: 30, text: 'Downloading Git...' },
  INSTALLING: { percent: 70, text: 'Installing Git (this may take a minute)...' },
  VERIFYING: { percent: 90, text: 'Verifying installation...' },
  GIT_READY: { percent: 100, text: 'Git Ready!' }
};

const STORAGE_KEY = 'loom_git_installed';
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Linux / macOS: check git via /bin/sh
// ---------------------------------------------------------------------------
async function checkGitInstalledUnix() {
  try {
    const cmd = Command.create('sh', ['-c', 'which git && git --version']);
    const output = await cmd.execute();
    console.log('Git (unix) check:', output.stdout.trim(), 'code:', output.code);
    return output.code === 0;
  } catch (e) {
    console.error('Git unix check failed:', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Windows: check git via PowerShell
// ---------------------------------------------------------------------------
async function checkGitInstalledWindows() {
  try {
    const checkScript = `
      if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Output 'FOUND'; exit 0
      }
      $gitPaths = @(
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
        'C:\\Program Files (x86)\\Git\\bin\\git.exe'
      )
      foreach ($path in $gitPaths) {
        if (Test-Path $path) { Write-Output 'FOUND'; exit 0 }
      }
      Write-Output 'NOT_FOUND'; exit 1
    `;
    const cmd = Command.create('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', checkScript
    ]);
    const output = await cmd.execute();
    console.log('Git (win) check:', output.stdout, 'code:', output.code);
    return output.code === 0 || output.stdout.trim() === 'FOUND';
  } catch (e) {
    console.error('Git windows check failed:', e);
    return false;
  }
}

async function checkGitInstalled() {
  return IS_WINDOWS ? checkGitInstalledWindows() : checkGitInstalledUnix();
}

async function getGitVersion() {
  try {
    const shellCmd = IS_WINDOWS ? 'powershell' : 'sh';
    const shellArgs = IS_WINDOWS
      ? ['-NoProfile', '-Command', 'git --version']
      : ['-c', 'git --version'];
    const cmd = Command.create(shellCmd, shellArgs);
    const output = await cmd.execute();
    return output.code === 0 ? output.stdout.trim() : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function GitInstaller({ onReady }) {
  const [state, setState] = useState(STATES.CHECKING);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Checking for Git...');
  const [errorMessage, setErrorMessage] = useState('');

  const childProcessRef = useRef(null);
  const timeoutRef = useRef(null);

  useEffect(() => {
    const checkStatus = async () => {
      // Quick localStorage check
      if (localStorage.getItem(STORAGE_KEY) === 'true') {
        const isGitInstalled = await checkGitInstalled();
        if (isGitInstalled) {
          setState(STATES.READY);
          setTimeout(() => onReady(), 300);
          return;
        }
        localStorage.removeItem(STORAGE_KEY);
      }

      const isGitInstalled = await checkGitInstalled();
      if (isGitInstalled) {
        const version = await getGitVersion();
        console.log('Git found:', version);
        localStorage.setItem(STORAGE_KEY, 'true');
        setState(STATES.READY);
        setTimeout(() => onReady(), 300);
      } else if (IS_WINDOWS) {
        // Windows: silently install
        console.log('Git not found (Windows), starting silent installation...');
        handleInstallWindows();
      } else {
        // Linux/macOS: can't auto-install — show error with instructions
        setErrorMessage(
          'Git is not installed on your system. Please install it with:\n\n' +
          '  Arch/Manjaro:  sudo pacman -S git\n' +
          '  Ubuntu/Debian: sudo apt install git\n' +
          '  macOS:         xcode-select --install\n\n' +
          'Then restart Loom.'
        );
        setState(STATES.ERROR);
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

  // Windows-only silent install path
  const handleInstallWindows = async () => {
    setState(STATES.INSTALLING);
    setProgress(5);
    setStatusText('Preparing Git installation...');

    const installScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Write-Output "DOWNLOADING"; [Console]::Out.Flush()
  $installerPath = "$env:TEMP\\Git-Installer.exe"
  $gitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe'
  Invoke-WebRequest -Uri $gitUrl -OutFile $installerPath -UseBasicParsing

  Write-Output "INSTALLING"; [Console]::Out.Flush()
  Start-Process -FilePath $installerPath -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS' -Wait
  Remove-Item $installerPath -Force -ErrorAction SilentlyContinue

  Write-Output "VERIFYING"; [Console]::Out.Flush()
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  $gitCmdPath = 'C:\\Program Files\\Git\\cmd'
  if (-not ($env:Path -like "*$gitCmdPath*")) { $env:Path += ";$gitCmdPath" }

  $gitVersion = git --version 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Output "GIT_READY"; [Console]::Out.Flush()
  } else {
    throw "Git installation verification failed"
  }
} catch {
  Write-Output "ERROR: $_"; [Console]::Out.Flush()
  exit 1
}
`;

    try {
      const cmd = Command.create('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', installScript
      ]);

      timeoutRef.current = setTimeout(() => {
        if (childProcessRef.current) {
          try { childProcessRef.current.kill(); } catch (e) {}
        }
        setErrorMessage('Installation timed out. Please check your internet connection and try again.');
        setState(STATES.ERROR);
      }, INSTALL_TIMEOUT_MS);

      cmd.stdout.on('data', (line) => {
        const trimmed = line.trim();
        if (PROGRESS_STAGES[trimmed]) {
          setProgress(PROGRESS_STAGES[trimmed].percent);
          setStatusText(PROGRESS_STAGES[trimmed].text);
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
          setTimeout(() => onReady(), 300);
        } else if (state !== STATES.ERROR) {
          setErrorMessage(`Installation failed with code ${data.code}. Please try again.`);
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

  const handleRetry = () => {
    localStorage.removeItem(STORAGE_KEY);
    setErrorMessage('');
    setProgress(0);
    setState(STATES.CHECKING);
    // Re-trigger the check
    checkGitInstalled().then(found => {
      if (found) {
        localStorage.setItem(STORAGE_KEY, 'true');
        setState(STATES.READY);
        setTimeout(() => onReady(), 300);
      } else if (IS_WINDOWS) {
        handleInstallWindows();
      } else {
        setErrorMessage(
          'Git is not installed. Please install it and restart Loom.\n\n' +
          '  Arch/Manjaro:  sudo pacman -S git\n' +
          '  Ubuntu/Debian: sudo apt install git'
        );
        setState(STATES.ERROR);
      }
    });
  };

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
            <p className="installer-status">Checking for Git...</p>
          </div>
        )}

        {state === STATES.INSTALLING && (
          <div className="installer-content">
            <h1 className="installer-title">Installing Git</h1>
            <p className="installer-description">
              Git is required for version control features.<br /><br />
              Installing silently in the background...
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
            <h1 className="installer-title">Git Ready</h1>
            <p className="installer-status">Continuing startup...</p>
          </div>
        )}

        {state === STATES.ERROR && (
          <div className="installer-content">
            <div className="installer-error-icon">✕</div>
            <h1 className="installer-title">Git Not Found</h1>
            <p className="installer-description installer-error-text" style={{ whiteSpace: 'pre-wrap' }}>
              {errorMessage || 'Please install Git and restart Loom.'}
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
