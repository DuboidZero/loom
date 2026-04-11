# Loom — Architecture Overview

**Loom** is a **Tauri-based desktop application** that acts as an **AI-powered code analysis and visualization tool**.

It maps out the structure of a codebase (both locally and via GitHub URLs) and renders it into a **3D interactive graph**.

It uses a **local AI engine** (**Ollama** with the `gemma4:e2b` model) to inspect and explain selected code segments.

---

# Architecture

## 1. Backend (`server/main.py`)

**Framework:**
Built with **FastAPI**.

### Code Parsing

Maps entire repositories by parsing multiple languages:

* **Python** — via **AST**
* **JavaScript, TypeScript, C++, Java, Go, Rust** — via **regex**

Extracted symbols include:

* Classes
* Functions
* Interfaces
* Modules

---

### Graph Generation

Constructs a **deep call graph** mapping relationships between:

* Files
* Functions
* Classes

Implements detection of:

* **Strongly Connected Components (SCCs)**
  (`detect_sccs`)

This enables correct handling of:

* Recursive calls
* Circular dependencies

---

### Flow Analysis

Exposes endpoints to dynamically visualize execution relationships:

* `/reverse-call-flow`
  → Renders **upstream** call graphs
  → Shows **what calls a function**

* `/forward-call-flow`
  → Renders **downstream** call graphs
  → Shows **what a function calls**

---

### AI Integration

Endpoint:

```
/get-details
```

Queries a locally hosted **Ollama** instance to generate:

* Deep analysis of specific code blocks
* Context-aware explanations using full codebase structure

---

## 2. Frontend (`client/src/App.js`)

**Framework:**

* **React**
* `@tauri-apps/api`

---

### Visualization

Uses:

* `@react-three/fiber`
* `@react-three/drei`

To render:

* **Interactive 3D force-directed layouts**
* Codebase structure as:

  * Nodes → files & symbols
  * Edges → relationships

Displayed visually as **interconnected orbs**.

---

### Interactivity

Users can:

* Switch between views:

  * **Map View** → Full repository
  * **Callers View** → Node-specific hierarchy

Features include:

* Keyboard navigation shortcuts
* Deep inspection controls
* Zooming into graph regions
* Export options:

  * SVG
  * JSON

---

### Source Control Context

Integrates directly with **Git** to:

* Pull working-tree status
* Highlight:

  * Modified files
  * Newly added files

Inside the **3D visualization grid**.

---

## 3. Application Lifecycle Management

(`client/src/OllamaInstaller.js` and `GitInstaller.js`)

Handles dependency verification and installation.

---

### Dependency Detection

Uses **Tauri shell commands** to silently verify:

* **Git**
* **Ollama**
* Required model:

  ```
  gemma4:e2b
  ```

Checks:

* Standard Windows installation paths
* System `PATH` variable

---

### Automated Installation

If dependencies are missing:

* Built-in installers execute automatically
* Uses **PowerShell scripts**
* Fetches and installs:

  * Git
  * Ollama
  * Required model

This process runs **silently at application launch**.

---

## Key Technologies

- Tauri
- FastAPI
- React
- Three.js (@react-three/fiber)
- Ollama (Local LLM inference)
- Python AST
- Regex-based parsing
- Git integration
