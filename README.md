Loom is a Tauri-based desktop application that acts as an AI-powered code analysis and visualization tool. It maps out the structure of a codebase (both locally and via GitHub URLs) and renders it into a 3D interactive graph. It uses a local AI engine (Ollama with the gemma4:e2b model) to inspect and explain selected code segments.

Architecture
1. Backend (server/main.py):

Framework: Built with FastAPI.
Code Parsing: It maps entire repositories by parsing various languages (Python via AST, and others like JS, TS, C++, Java, Go, Rust via regex). It extracts symbols like classes, functions, and interfaces.
Graph Generation: Constructs a deep call graph mapping the relationships between files, functions, and classes. It intelligently detects Strongly Connected Components (SCCs) to handle recursive calls or circular dependencies (detect_sccs).
Flow Analysis: Exposes endpoints for rendering upstream (/reverse-call-flow) and downstream (/forward-call-flow) call graphs to dynamically show how specific functions are executed or what they execute.
AI Integration: Endpoint (/get-details) queries a locally hosted Ollama instance to generate deep analysis for a specific block of code based on the generated codebase context.
2. Frontend (client/src/App.js):

Framework: Built with React and @tauri-apps/api.
Visualization: Leverages @react-three/fiber and @react-three/drei to render an interactive, 3-dimensional force-directed layout of the codebase where files and symbols are represented as interconnected orbs.
Interactivity: Users can switch between the "map" (full repo) and "callers" (specific node hierarchy) views. Features include keyboard shortcuts for navigation, deep inspection controls, zooming into portions of the system, and exporting the state as an SVG or JSON.
Source Control Context: Integrates directly with Git to pull the working-tree status, highlighting modified and added files inside the 3D grid.
3. Application Lifecycle Management (client/src/OllamaInstaller.js and GitInstaller.js):

Uses Tauri shell commands to silently verify if Git and Ollama (including the specific gemma4:e2b model) are present on the user's system by checking standard Windows installation paths or the PATH variable.
Features built-in installers that will fetch and install these dependencies using an automated PowerShell script if they are missing at launch.
