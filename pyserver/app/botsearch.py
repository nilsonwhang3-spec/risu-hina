"""Search the current working bot by content, retaining domain IDs and state."""
import json
import re

from . import card, store


def search(char_key: str, chat_key: str, query: str, offset: int = 0, limit: int = 30) -> dict:
    rows = []
    for item in card.listing(char_key)["fields"]:
        rows.append(("field", "read_card_field", item, item["body"] or ""))
    for kind in card.SCRIPT_KINDS:
        for item in card.scripts(char_key, kind):
            rows.append((kind, "read_script", item, json.dumps(item["entry"], ensure_ascii=False)))
    for item in store.lore(char_key):
        if item.get("scope") == "global" or item.get("chatKey") == chat_key:
            rows.append(("lore", "read_lore_entry", item, json.dumps(item["entry"], ensure_ascii=False)))
    hits = []
    for kind, reader, item, body in rows:
        # casefold changes string length (e.g. ß); locate with original offsets.
        match = re.search(re.escape(query), body, re.IGNORECASE)
        if match is None:
            continue
        at = match.start()
        hits.append({"kind": kind, "id": item["id"], "readTool": reader,
                     "origin": item.get("origin"), "deleted": item.get("deleted", item.get("origin") == "deleted"),
                     "changed": item.get("changed", item.get("origin") not in (None, "original")),
                     "snippet": body[max(0, at - 100):at + 300], "chars": len(body)})
    offset, limit = max(0, offset), max(1, min(100, limit))
    page = hits[offset:offset + limit]
    return {"source": "Hina working copy", "total": len(hits), "items": page,
            "nextOffset": offset + len(page) if offset + len(page) < len(hits) else None}
