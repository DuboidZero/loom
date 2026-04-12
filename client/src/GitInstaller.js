/**
 * GitInstaller Component
 * 
 * Handles first-launch Git detection and silent installation.
 * Features:
 * - Silent install with no user prompts (Git is required, not optional)
 * - Progress UI with live status updates
 * - 5-minute timeout watchdog
 * - PATH refresh after install (Windows edge case prevention)
 * - Error handling with retry capability
 */
import React, { useState, useEffect, useRef } from 'react';
import { Command } from '@tauri-apps/plugin-shell';

// Installation states
const STATES = {
    CHECKING: 'checking',
    INSTALLING: 'installing',
    READY: 'ready',
    ERROR: 'error'
};

// Progress stages with percentages and display text
const PROGRESS_STAGES = {
    DOWNLOADING: { percent: 30, text: 'Downloading Git...' },
    INSTALLING: { percent: 70, text: 'Installing Git (this may take a minute)...' },
    VERIFYING: { percent: 90, text: 'Verifying installation...' },
    GIT_READY: { percent: 100, text: 'Git Ready!' }
};

const STORAGE_KEY = 'loom_git_installed';
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Standard Git installation paths on Windows
const GIT_PATHS = [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files (x86)\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files (x86)\\Git\\bin'
];

/**
 * Check if Git is already installed and accessible.
 * Uses multiple detection methods:
 * 1. Check if 'git' is available in PATH via Get-Command
 * 2. Check standard Windows installation paths
 */
async function checkGitInstalled() {
    try {
        const checkScript = `
            if (Get-Command git -ErrorAction SilentlyContinue) {
                Write-Output 'FOUND'
                exit 0
            }
            $gitPaths = @(
                'C:\\Program Files\\Git\\cmd\\git.exe',
                'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
                'C:\\Program Files\\Git\\bin\\git.exe',
                'C:\\Program Files (x86)\\Git\\bin\\git.exe'
            )
            foreach ($path in $gitPaths) {
                if (Test-Path $path) {
                    Write-Output 'FOUND'
                    exit 0
                }
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
        console.log('Git check output:', output.stdout, 'code:', output.code);
        return output.code === 0 || output.stdout.trim() === 'FOUND';
    } catch (e) {
        console.error('Git check failed:', e);
        return false;
    }
}

/**
 * Get Git version to verify working installation
 */
async function getGitVersion() {
    try {
        const cmd = Command.create('powershell', [
            '-NoProfile',
            '-Command',
            'git --version'
        ]);
        const output = await cmd.execute();
        return output.code === 0 ? output.stdout.trim() : null;
    } catch (e) {
        console.error('Git version check failed:', e);
        return null;
    }
}

/**
 * Main Git installer component
 */
export default function GitInstaller({ onReady }) {
    const [state, setState] = useState(STATES.CHECKING);
    const [progress, setProgress] = useState(0);
    const [statusText, setStatusText] = useState('Checking for Git...');
    const [errorMessage, setErrorMessage] = useState('');

    const childProcessRef = useRef(null);
    const timeoutRef = useRef(null);

    // Check installation status on mount
    useEffect(() => {
        const checkStatus = async () => {
            // Quick check: localStorage flag
            if (localStorage.getItem(STORAGE_KEY) === 'true') {
                // Verify Git is still installed
                const isGitInstalled = await checkGitInstalled();
                if (isGitInstalled) {
                    setState(STATES.READY);
                    setTimeout(() => onReady(), 300);
                    return;
                }
                // Flag was set but Git not found - clear and re-install
                localStorage.removeItem(STORAGE_KEY);
            }

            // Full check
            const isGitInstalled = await checkGitInstalled();
            if (isGitInstalled) {
                const version = await getGitVersion();
                console.log('Git found:', version);
                localStorage.setItem(STORAGE_KEY, 'true');
                setState(STATES.READY);
                setTimeout(() => onReady(), 300);
            } else {
                // Git not found - start silent installation immediately
                console.log('Git not found, starting silent installation...');
                handleInstall();
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
        setStatusText('Preparing Git installation...');

        // PowerShell script for silent Git installation
        // Uses Git for Windows official installer with silent flags
        const installScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    Write-Output "DOWNLOADING"; [Console]::Out.Flush()
    $installerPath = "$env:TEMP\\Git-Installer.exe"
    
    # Download the latest Git for Windows 64-bit installer
    $gitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe'
    Invoke-WebRequest -Uri $gitUrl -OutFile $installerPath -UseBasicParsing
    
    Write-Output "INSTALLING"; [Console]::Out.Flush()
    
    # Silent install with sensible defaults
    # /VERYSILENT = no UI at all
    # /NORESTART = don't restart Windows
    # /NOCANCEL = user cannot cancel
    # /SP- = skip the "This will install..." page
    # /CLOSEAPPLICATIONS = close applications using files that need updating
    # /RESTARTAPPLICATIONS = restart applications after install
    Start-Process -FilePath $installerPath -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS' -Wait
    
    # Clean up installer
    Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
    
    Write-Output "VERIFYING"; [Console]::Out.Flush()
    
    # Explicitly refresh PATH for this process
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
    # Also add standard Git paths explicitly (Windows sometimes doesn't refresh immediately)
    $gitCmdPath = 'C:\\Program Files\\Git\\cmd'
    if (-not ($env:Path -like "*$gitCmdPath*")) {
        $env:Path += ";$gitCmdPath"
    }
    
    # Verify installation
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
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command', installScript
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
                console.log('Git installer output:', trimmed);

                if (PROGRESS_STAGES[trimmed]) {
                    setProgress(PROGRESS_STAGES[trimmed].percent);
                    setStatusText(PROGRESS_STAGES[trimmed].text);
                } else if (trimmed.startsWith('ERROR:')) {
                    setErrorMessage(trimmed.replace('ERROR:', '').trim());
                    setState(STATES.ERROR);
                }
            });

            // Handle close event for completion
            cmd.on('close', (data) => {
                console.log('Git install process completed with code:', data.code);

                // Clear timeout
                if (timeoutRef.current) {
                    clearTimeout(timeoutRef.current);
                    timeoutRef.current = null;
                }

                if (data.code === 0) {
                    localStorage.setItem(STORAGE_KEY, 'true');
                    setState(STATES.READY);
                    // 300ms delay for smoother UX
                    setTimeout(() => onReady(), 300);
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
                        <p className="installer-status">Checking for Git...</p>
                    </div>
                )}

                {/* Installing State */}
                {state === STATES.INSTALLING && (
                    <div className="installer-content">
                        <h1 className="installer-title">Installing Git</h1>
                        <p className="installer-description">
                            Git is required for version control features.
                            <br /><br />
                            Installing silently in the background...
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
                        <h1 className="installer-title">Git Ready</h1>
                        <p className="installer-status">Continuing startup...</p>
                    </div>
                )}

                {/* Error State */}
                {state === STATES.ERROR && (
                    <div className="installer-content">
                        <div className="installer-error-icon">✕</div>
                        <h1 className="installer-title">Git Installation Failed</h1>
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
