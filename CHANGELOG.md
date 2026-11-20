# Changelog

## 0.2.0 (unreleased) — spec 2042 plugin boundary

Requires omadia core `>=1.75.0 <2.0`.

- Kind stays `integration`. The `prompt_partial` persona skill
  (`skills/notion-expert.md`) is gone; its tool knowledge moved into the tool
  descriptions and `playbook.when_to_use`, its role became two inactive
  `agent_templates` (en, de).
- Tools are registered via `ctx.tools.register` + `{ close }`
  (`src/registerTools.ts`); `activate()` no longer returns a `toolkit`. Tool
  names are unchanged.
- Removed the `llm:` preferences. The memory permission stays: it backs the
  technical vector index, not a conversation memory.
- Local `PluginContext` stub gained `tools.register`.
- `reindex_notion` stays `side_effects: write` (writes the plugin's own index);
  the other tools are `read`.
