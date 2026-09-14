# Large Lua and script text editing

The staging conversation `92c0d3191a5146488d3f348fecb1a075`, turn 585, reported
that a 140,000-character trigger could not safely be reconstructed from escaped
4,000-character JSON pages. It offered manual copy/paste from a generated Lua file.
`read_script` also still silently sliced its result at 30,000 characters.

The full JSON reader now keeps its complete result for tool-result recovery.
For source editing, prefer these tools instead:

1. `read_script_text(script_id)` discovers string fields as JSON Pointers and a revision.
2. Pass `field`, `query` or character `offset`/`limit` to read decoded source, including the tail.
3. `propose_script_text_replace` performs a literal replacement with an exact occurrence count.
4. For substantial edits, `export_script_text` writes a full `.lua`/`.txt` workspace file.
   Edit it using the file workflow, then `propose_script_text_from_file` imports that field.

The backend constructs the entry and preserves unrelated fields. Import proposals snapshot
the file at proposal time. Approval checks the original entry revision inside a DB transaction;
stale edits are rejected. Approval changes the working copy; saving to RisuAI remains separate.
No model needs to rewrite the entire JSON or manually double-escape code.

Lua files participate in text listing/search/preview. `.lua` and `.txt` previews have a text
editor that loads the full UTF-8 source (up to 4 MB), rather than saving a truncated preview.
Saving requires the file revision and uses atomic replacement. Text uploads preserve newline
bytes on Windows. This does not add Lua execution or claim Lua syntax/runtime validation.

OAuth paste input accepts a full callback URL, schemeless `localhost:...` URL, query string,
or an exact code. URL query values decode once; bare codes stay unchanged. Conflicting states,
duplicate code/state parameters, missing codes and OAuth error callbacks are rejected.
Authentication secrets are not included in test fixtures or logs.
