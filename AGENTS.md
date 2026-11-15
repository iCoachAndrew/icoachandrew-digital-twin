# Antigravity Rules: Codebase Memory & Token Conservation

These rules govern how the agent interacts with the codebase to maximize context efficiency and reduce token consumption using `codebase-memory-mcp` (v0.12.1).

## Indexed Projects Reference
- **`Github-Digital-Twin`**: Main Git repository (`c:\Users\Ariel Abraham\My Drive (noreply.kopinergi@gmail.com)\Github Digital Twin`)
- **`iCoachAndrew-Digital-Twin`**: Active workspace (`c:\Users\Ariel Abraham\My Drive (noreply.kopinergi@gmail.com)\iCoachAndrew Digital Twin`)

---

## 1. Graph-First Exploration Protocol
Whenever tasked with understanding repository structure, locating functions or classes, or tracking architectural dependencies:
- **ALWAYS query `codebase-memory` MCP tools first (`call_mcp_tool` with `ServerName: "codebase-memory"`):**
  - `manage_adr` (`mode: "get"`): Read persisted Architecture Decision Records first before running broad architectural queries.
  - `get_architecture`: Call this (`aspects: ["overview", "entry_points", "routes"]`) to get high-level module structure and HTTP routes without reading files.
  - `search_graph`: Find specific symbols (functions, variables, modules, routes) and their exact file/line locations in sub-milliseconds:
    - Use `query: "..."` for BM25 keyword search or `name_pattern` / `file_pattern` for regex filtering.
    - Use `semantic_query: ["..."]` (mutually exclusive with `query`) when searching by natural language concepts or features.
  - `get_file_outline`: Inspect all symbol declarations and line ranges in a single file before reading source code.
  - `trace_path`: Inspect call hierarchies, callers, and callees across layers instead of opening intermediate files (`direction: "inbound" | "outbound" | "both"`, `mode: "calls" | "data_flow"`).
- **NEVER perform broad directory tree dumps or recursive grep searches** when the knowledge graph can answer the query. Use `search_code` only for string literals or files flagged in `parse_partial`.

---

## 2. Minimalist File Reading (`get_code_snippet` & `read_file` Guardrails)
- **Do NOT read entire source files** during exploration or search.
- When code inspection or modification is required:
  1. Prefer `get_code_snippet` (`qualified_name`, `source_mode: "auto"`, `max_output_tokens: 2500`) to read a target function or symbol directly from the graph.
  2. When using `read_file` for editing, retrieve the exact `lines` range from `search_graph`, `get_file_outline`, or `trace_path` first.
  3. Invoke `read_file` strictly specifying `StartLine` and `EndLine` for the target block (± 20–30 lines of context).

---

## 3. Change & Impact Verification
- Before refactoring or modifying a function:
  - Run `trace_path` (`function_name`, `direction: "both"` or `"inbound"`, `include_tests: true`) to check which other modules, routes, and tests rely on the symbol.
  - After modifying files, refresh the graph index with `index_repository` (`persistence: true`) so the knowledge graph stays in sync.
- Record significant architectural decisions using `manage_adr` (`mode: "update"` or `"set_sections"`) so future sessions retain project context without re-analyzing past discussions.
