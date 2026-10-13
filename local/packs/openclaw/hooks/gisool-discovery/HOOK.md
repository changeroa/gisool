---
name: gisool-discovery
description: Add gisool skill discovery guidance to OpenClaw's in-memory agent bootstrap.
metadata: { "openclaw": { "events": ["agent:bootstrap"] } }
---

Appends a small discovery instruction to the in-memory AGENTS.md bootstrap entry.
Existing instructions are preserved; no workspace files are written.
