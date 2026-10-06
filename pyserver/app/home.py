"""The agent's home when no bot is open: 페르소나 편집 and 모듈 편집 without a bot.

Every agent conversation hangs off a chat (sessions, the approval queue, the
scoped DB, the hidden MCP session), and a chat hangs off a character. Personas
and modules need neither - they are edited with no bot selected in RisuAI - so
the agent gets one reserved character + chat of its own to talk from. It holds
no card and no turns; it is never written back to RisuAI and never listed as a
bot. A module opened in the panel is still the turn's target (session.run).
"""
from __future__ import annotations

from . import db

KEY = "hina-home"
# The folder name under projects/ and hina/ (workspace.bot_folder reads it).
NAME = "_공용"


def is_home(key: str) -> bool:
    return key == KEY


def ensure() -> dict:
    """Create the home character and chat once; return the keys."""
    now = db.now()
    db.execute(
        "INSERT OR IGNORE INTO characters(char_key, cha_id, name, char_index, card_json, family_key, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (KEY, "", NAME, None, "{}", "", now, now))
    db.execute(
        "INSERT OR IGNORE INTO chats(chat_key, char_key, chat_id, chat_index, name, meta_json, orig_count, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (KEY, KEY, "", None, NAME, "{}", 0, now, now))
    return {"charKey": KEY, "chatKey": KEY}
