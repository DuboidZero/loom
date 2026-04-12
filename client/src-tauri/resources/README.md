# Loom

Loom is a fully local developer tool that maps codebases into logical graphs, helping you understand architecture, dependencies, and flow at a glance — without sending your code anywhere.

Your code stays on your machine. Always.

---

## Why Loom?

Modern codebases are hard to reason about:

- Files are scattered
- Dependencies are implicit
- Architectural intent gets lost over time

Loom helps by:

- Parsing your codebase locally
- Building a graph of how things connect
- Visualizing structure instead of forcing you to read everything

Think of it as x-ray vision for codebases.

---

## Privacy by Design

Loom is 100% local.

- No servers
- No uploads
- No accounts
- No telemetry by default

Your repositories are never sent, stored, or processed outside your machine.

This makes Loom suitable for:

- Private repositories
- Proprietary code
- Offline environments
- Security-sensitive projects

---

## How It Works (High Level)

- A local backend analyzes your codebase
- Relationships (imports, calls, modules, etc.) are extracted
- A graph model is built
- The frontend renders an interactive visualization
- An AI analysis can be run, (fully locally through an Ollama model) to help understand your code

All computation happens locally.

---

## Platform

Loom is distributed as a desktop application built with:

- A local Python backend
- A React frontend
- Packaged using Tauri

No browser dependency is required.

---

## Installation

Loom is currently distributed as a local installer.

1. Download the installer from the website
2. Run the installer
3. Open Loom
4. Point it at a codebase / local directory

That’s it.

No sign-up. No setup. No cloud.

---

## Disclaimer

Loom is provided "as is", without warranty of any kind.

You are responsible for:

- Reviewing results
- Validating architectural decisions
- Using the tool appropriately

Loom does not modify your codebase.

---

## License

Loom is licensed under the Apache License, Version 2.0.

See the LICENSE file for full terms.

---

## Roadmap (Indicative)

Planned or possible directions include:

- Support for larger and more complex repositories
- Incremental graph updates
- Improved language coverage
- Better graph navigation and filtering
- Optional advanced features for power users

Details may change as Loom evolves.

---

## Contributing

Contribution details will be shared once the project is ready for public collaboration.

---

## Author

Built by an independent developer who got tired of getting lost in large codebases.
- Dhruv Sagar Inamdar
