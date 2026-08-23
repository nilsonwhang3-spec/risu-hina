RisuAI Lua 트리거 레퍼런스. 봇 카드의 트리거 스크립트를 읽거나 이해해야 할 때 읽어라.
Risu Elf는 Lua를 실행하지 않는다 — 무엇을 하는 코드인지 읽기 위한 자료다.

---

# RisuAI Lua Scripting Reference

RisuAI embeds a wasmoon-based Lua VM. Lua code runs via trigger scripts packaged in module.risum.

---

## CRITICAL: Verified Implementation Rules

These rules were verified by testing against the RisuAI source code and a working production bot (Office Counseling v2.0.0).

### Delivery: module.risum is MANDATORY
- Lua triggers and regex scripts MUST be in module.risum, not card.json.
- On charx import, module.risum OVERWRITES card.json's triggerscript/customScripts.
- The charx encode tool builds module.risum automatically from `triggers.lua` and `regex.json`.

### onStart is REQUIRED
- You MUST define `function onStart(triggerId)` in the Lua code.
- The trigger system auto-calls `onStart(triggerId)` every turn at the start of message processing.
- Without `onStart`, the Lua VM loads but variable initialization never happens.

### Parameter Naming: use `triggerId`
- All hook functions and listenEdit callbacks receive `triggerId` as the first parameter.
- This is a UUID access key generated per execution, checked against ScriptingSafeIds.
- Follow the reference bot convention: name it `triggerId`, not `id`.

### listenEdit('editOutput') takes 2 params, not 3
```lua
-- CORRECT (reference bot pattern):
listenEdit('editOutput', function(triggerId, text)
    return text
end)

-- WRONG (causes silent failure):
listenEdit('editOutput', function(triggerId, text, meta)  -- meta is nil
    return text
end)
```
editRequest takes 3 params (`triggerId, messages, meta`). editDisplay takes 2 (`triggerId, text`).

### Error Handling: errors are SILENT
- `runLuaEditTrigger` wraps everything in `try/catch` and returns original content on error.
- Lua runtime errors produce NO console output.
- Use `log(value)` liberally during development. It outputs to browser console.

### Variable Storage
- `setChatVar(triggerId, key, value)` → stored in `chat.scriptstate['$' + key]`
- `getState(triggerId, name)` / `setState(triggerId, name, value)` → stored as `$__name` (JSON-encoded)
- `defaultVariables` in card.json provides fallback values (read when scriptstate has no entry)
- Variables set via setChatVar appear in RisuAI's frontend variable panel.

---

## 1. Trigger Types (triggerMode)

| Type | When | Purpose |
|------|------|---------|
| `start` | Every turn, before processing | Variable init, setup |
| `input` | After user input | Modify user messages |
| `output` | After AI response | Modify character responses |
| `display` | During rendering | Display-only changes (limited API) |
| `request` | Before LLM call | Modify request body |
| `manual` | Explicit call | Button/trigger invocation |

## 2. Message Processing Pipeline

```
1. start trigger         — onStart(triggerId) called
2. editInput             — listenEdit('editInput', ...) 
3. editRequest           — listenEdit('editRequest', ...)
4. ── LLM call ──
5. editOutput            — listenEdit('editOutput', ...)
6. output trigger        — onOutput(triggerId) called
7. editDisplay           — listenEdit('editDisplay', ...)
```

## 3. Hook Functions (auto-called by trigger system)

```lua
function onStart(triggerId)
    -- Called every turn. Initialize variables here.
    -- Use initVar pattern to avoid overwriting existing values.
end

function onOutput(triggerId)
    -- Called after AI generates response.
end

function onInput(triggerId)
    -- Called after user sends message.
end

function onButtonClick(triggerId, data)
    -- Called when a button is clicked.
    -- data: string passed from the button.
end
```

## 4. Event Listeners (listenEdit)

Registered at top level. Persist in the Lua engine for the lifetime of the mode.

```lua
-- editOutput: 2 params (triggerId, text)
listenEdit('editOutput', function(triggerId, text)
    -- Parse tags, update variables
    -- Return modified text (or original)
    return text
end)

-- editRequest: 3 params (triggerId, messages, meta)
listenEdit('editRequest', function(triggerId, messages, meta)
    -- messages: OpenAIChat[] array ({role, content})
    -- Roles: "system", "user", "assistant"
    -- Can add/remove/modify messages, return modified array
    return messages
end)

-- editDisplay: 2 params (triggerId, text)
listenEdit('editDisplay', function(triggerId, text)
    -- Display-only modifications (limited API access)
    return text
end)

-- editInput: 2 params (triggerId, text)  
listenEdit('editInput', function(triggerId, text)
    return text
end)
```

---

## 5. Chat API

```lua
getChat(triggerId, index)           -- {role, data, time}
getChatLength(triggerId)            -- message count
getFullChat(triggerId)              -- full message array

setChat(triggerId, index, value)    -- modify message text
setFullChat(triggerId, value)       -- replace entire array
addChat(triggerId, role, value)     -- append (role: 'user'|'char')
insertChat(triggerId, index, role, value)
setChatRole(triggerId, index, value)

cutChat(triggerId, start, end_)
removeChat(triggerId, index)
```

## 6. Variable API

```lua
-- Chat variables (per-chat, persistent)
getChatVar(triggerId, key)          -- returns string or "null"
setChatVar(triggerId, key, value)   -- writes to scriptstate

-- Global variables (shared across all chats)
getGlobalVar(triggerId, key)

-- State variables (JSON-serialized, "__" prefix auto-added)
getState(triggerId, name)           -- json.decode(getChatVar("__"..name))
setState(triggerId, name, value)    -- setChatVar("__"..name, json.encode(value))
```

### Safe init pattern (from reference bot):
```lua
local function initVar(triggerId, key, default)
    local v = getChatVar(triggerId, key)
    if not v or v == "null" or v == "" then
        setChatVar(triggerId, key, default)
    end
end
```

## 7. Character / Persona API

```lua
getName(triggerId)                      -- character name
setName(triggerId, name)
getDescription(triggerId)               -- description field
setDescription(triggerId, desc)
getCharacterFirstMessage(triggerId)
setCharacterFirstMessage(triggerId, data)
getCharacterImage(triggerId)            -- async, returns inlay

getPersonaName(triggerId)               -- user name
getPersonaDescription(triggerId)
getPersonaImage(triggerId)              -- async, returns inlay
```

## 8. Lorebook API

```lua
getLoreBooks(triggerId, search)
loadLoreBooks(triggerId)                -- async

upsertLocalLoreBook(triggerId, name, content, options)
-- options: {alwaysActive, insertOrder, key, secondKey, regex}

-- v2 API
v2GetAllLorebooks(triggerId)
v2GetLorebookByName(triggerId, name)
v2GetLorebookByIndex(triggerId, index)
v2GetLorebookCountNew(triggerId)
v2CreateLorebook(triggerId, name, key, content, insertOrder)
v2ModifyLorebookByIndex(triggerId, index, name, key, content, insertOrder)
v2DeleteLorebookByIndex(triggerId, index)
v2SetLorebookAlwaysActive(triggerId, index, value)
```

## 9. Notes / Prompt API

```lua
getAuthorsNote(triggerId)
setAuthorNote(triggerId, value)
getBackgroundEmbedding(triggerId)
setBackgroundEmbedding(triggerId, data)
getReplaceGlobalNote(triggerId)
setReplaceGlobalNote(triggerId, value)
```

## 10. UI / Alert API

```lua
alertError(triggerId, value)
alertNormal(triggerId, value)
alertInput(triggerId, value)            -- async, returns string
alertSelect(triggerId, value)           -- async, returns string
alertConfirm(triggerId, value)          -- async, returns boolean
reloadDisplay(triggerId)
reloadChat(triggerId, index)
```

## 11. LLM / Image Generation API

> Requires lowLevelAccess

```lua
LLM(triggerId, prompt, useMultimodal)   -- async, returns {success, result}
simpleLLM(triggerId, prompt)            -- async
axLLM(triggerId, prompt, useMultimodal) -- async

generateImage(triggerId, value, negValue)  -- async
```

## 12. Utility API

```lua
getTokens(triggerId, value)             -- async
hash(triggerId, value)                  -- async
sleep(triggerId, time)                  -- async, milliseconds
cbs(value)                              -- run CBS parser
log(value)                              -- console.log (auto JSON-encoded)
similarity(triggerId, source, values)   -- async
request(triggerId, url)                 -- HTTPS GET (5/min, 120 char max)
```

---

## 13. Regex Scripts (customScripts)

Regex scripts are stored alongside Lua triggers in module.risum. They handle display transformations that don't need Lua logic.

```json
{
    "comment": "Hide status tag",
    "in": "<status>[\\s\\S]*?</status>",
    "out": "",
    "type": "editdisplay",
    "flag": "g",
    "ableFlag": true
}
```

| type | Purpose |
|------|---------|
| `editdisplay` | Display-only modification |
| `editprocess` | Remove from LLM request |
| `editinput` | Modify user input |
| `editoutput` | Modify AI output (persists to stored message) |

Prefer `editdisplay` for tag hiding (doesn't modify stored data).
Use `editprocess` to strip display-only tags from the LLM request.

---

## 14. Engine Architecture

- Lua engines are cached per `mode` key in `ScriptingEngines` Map.
- `runLuaEditTrigger` iterates ALL `triggerlua` triggers and calls `runScripted` for each.
- Code is loaded once per mode; subsequent calls reuse the engine.
- `onStart`/`onOutput`/`onInput` are auto-called by the switch-case in `runScripted`.
- `callListenMain` dispatches to registered `listenEdit` callbacks.

---

## 15. Security Tiers

| Tier | Allowed |
|------|---------|
| **ScriptingSafeIds** | All normal APIs — chat, variables, lorebook, alerts |
| **ScriptingEditDisplayIds** | Display mode only — read + limited write |
| **ScriptingLowLevelIds** | LLM, image generation, HTTP requests, similarity |

`lowLevelAccess: true` requires user confirmation on import.

---

## 16. Complete Bot Template

```lua
-- Helper: safe init
local function initVar(triggerId, key, default)
    local v = getChatVar(triggerId, key)
    if not v or v == "null" or v == "" then
        setChatVar(triggerId, key, default)
    end
end

-- onStart: called every turn
function onStart(triggerId)
    initVar(triggerId, "stage", "0")
    initVar(triggerId, "day_count", "1")
    -- Complex structures use getState/setState
    if not getState(triggerId, "history") then
        setState(triggerId, "history", {})
    end
end

-- editOutput: parse AI tags → update variables
listenEdit('editOutput', function(triggerId, text)
    local tag = text:match("<my_tag>(.-)</my_tag>")
    if tag then
        setChatVar(triggerId, "my_var", tag)
    end
    return text
end)

-- editRequest: inject system context
listenEdit('editRequest', function(triggerId, messages, meta)
    local state = getChatVar(triggerId, "stage")
    table.insert(messages, 2, {
        role = "system",
        content = "[Current Stage: " .. state .. "]"
    })
    return messages
end)
```
