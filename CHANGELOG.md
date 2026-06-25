# Changelog

## 🚀 Added

### AI Chat

* Added an integrated AI chat assistant for repository-aware code analysis.
* Supports conversational questions about functions, architecture, bugs, implementation details, and design decisions.
* Added automatic conversation routing between technical analysis and casual conversation.

### Source Viewer

* Added an integrated source code viewer.
* View the complete implementation of any selected node directly inside Loom.
* Syntax highlighting based on file language.

### Repository-Aware AI Context

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

## ✨ Improved

### AI Analysis Quality

* Introduced evidence-based reasoning principles.
* Improved architectural explanations.
* Improved implementation walkthroughs.
* Improved execution tracing.
* Improved variable state tracking during simulations.
* Improved bug analysis with stronger evidence requirements.
* Improved confidence reporting.
* Reduced unsupported assumptions.

### Conversation Experience

* AI now distinguishes between:

  * Code analysis
  * Bug investigation
  * Architecture discussion
  * Casual conversation
* Natural conversations no longer force analysis formatting.

### Context Management

* Added automatic chat history trimming.
* Reduced prompt size for long conversations.
* Improved response speed for local models.

### Internal Prompting

* Refactored system prompt generation.
* Simplified prompt assembly.
* Improved maintainability of prompt logic.
* Reduced prompt duplication across analysis modes.

---

## 🐧 Platform Support

### Linux

* Added Linux support.
* Currently tested on Arch Linux.

---

## 🛠 Internal

* Refactored AI context construction.
* Improved repository context injection.
* Added caller/callee prioritization.
* Simplified chat backend architecture.
* General cleanup and internal improvements.
