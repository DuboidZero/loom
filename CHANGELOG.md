# Changelog

All notable changes to Loom are documented here.
This file is automatically updated by [Release Please](https://github.com/googleapis/release-please) using [Conventional Commits](https://www.conventionalcommits.org/).

---

<!-- RELEASE-PLEASE-START -->
<!-- New versions will be prepended above this line by Release Please -->
<!-- RELEASE-PLEASE-END -->

---

## Historical Changelog (pre-automation)

The following entries were written manually before automated changelogs were introduced.

## [5.1.0](https://github.com/DuboidZero/loom/compare/loom-v5.0.0...loom-v5.1.0) (2026-10-08)


### ### Features

* add AI chat, source viewer, Linux support, and repository-aware context ([ed4ecba](https://github.com/DuboidZero/loom/commit/ed4ecba40a4667ac15e3c0248c4a50b95ec02cf8))
* lord save my github actions [#3](https://github.com/DuboidZero/loom/issues/3) ([ed8b9d2](https://github.com/DuboidZero/loom/commit/ed8b9d29359e45de85406d4e184258368717e7b9))

### v0.4.0 and prior

#### 🚀 Added

##### AI Chat

* Added an integrated AI chat assistant for repository-aware code analysis.
* Supports conversational questions about functions, architecture, bugs, implementation details, and design decisions.
* Added automatic conversation routing between technical analysis and casual conversation.

##### Source Viewer

* Added an integrated source code viewer.
* View the complete implementation of any selected node directly inside Loom.
* Syntax highlighting based on file language.

##### Repository-Aware AI Context

The AI now receives significantly richer repository context when answering questions.

Added support for:

* Selected node source code.
* Up to **3 caller function bodies**.
* Direct callee function body.
* Call graph relationships.
* File metadata.
* Git status context.
* Current conversation history.

This allows the assistant to reason about **how code is actually used**, rather than analyzing functions in isolation.

---

#### ✨ Improved

##### AI Analysis Quality

* Introduced evidence-based reasoning principles.
* Improved architectural explanations.
* Improved implementation walkthroughs.
* Improved execution tracing.
* Improved variable state tracking during simulations.
* Improved bug analysis with stronger evidence requirements.
* Improved confidence reporting.
* Reduced unsupported assumptions.

##### Conversation Experience

* AI now distinguishes between code analysis, bug investigation, architecture discussion, and casual conversation.
* Natural conversations no longer force analysis formatting.

##### Context Management

* Added automatic chat history trimming.
* Reduced prompt size for long conversations.
* Improved response speed for local models.

##### Internal Prompting

* Refactored system prompt generation.
* Simplified prompt assembly.
* Improved maintainability of prompt logic.
* Reduced prompt duplication across analysis modes.

---

#### 🐧 Platform Support

##### Linux

* Added Linux support. Currently tested on Arch Linux.

---

#### 🛠 Internal

* Refactored AI context construction.
* Improved repository context injection.
* Added caller/callee prioritization.
* Simplified chat backend architecture.
* General cleanup and internal improvements.
