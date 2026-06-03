# Antigravity Auth - Specifications & Test Requirements

## Goal
Seamless integration of free Antigravity AI models across both platforms.

## Requirements
- [ ] **Cross-Platform**: Allows use of Antigravity AI models for free in both OpenCode and Claude Code.
- [ ] **Resilience**: Must handle all edge cases gracefully, especially robust operation within OpenCode subagents.
- [ ] **Claude Hub Integration**: Must integrate with Claude Hub to list itself in the 'cc auth login' menu.
- [ ] **OpenCode Integration**: Must integrate with OpenCode to list itself in the 'oc auth login' menu under the Google provider.

## Architectural Notes
- **Legacy Structure**: The current opencode/plugin.ts is massive (~150KB). To achieve the "same UI design and structure" goal shared with claude-code-auth, this monolith must be refactored into smaller, modular components mirroring claude-code-auth's src/ directory.
