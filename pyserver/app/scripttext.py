"""Edit script string fields without round-tripping a large JSON entry through the model."""
import copy
import hashlib
import json

from . import card, db, files


def digest(entry: dict) -> str:
    return hashlib.sha256(json.dumps(entry, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def current(char_key: str, script_id: str) -> dict:
    owner = db.one("SELECT char_key FROM card_scripts WHERE id=? AND origin <> 'deleted'", (script_id,))
    if not owner or owner["char_key"] != char_key:
        raise ValueError("현재 봇의 스크립트가 아닙니다")
    return card.script_entry(script_id)["entry"]


def fields(value, prefix="") -> list[dict]:
    result = []
    if isinstance(value, str):
        return [{"field": prefix, "chars": len(value), "lines": len(value.splitlines())}]
    if isinstance(value, (dict, list)):
        for key, child in (value.items() if isinstance(value, dict) else enumerate(value)):
            result.extend(fields(child, prefix + "/" + str(key).replace("~", "~0").replace("/", "~1")))
    return result


def locate(entry: dict, pointer: str):
    if not pointer.startswith("/"):
        raise ValueError("field에는 조회 결과의 JSON Pointer를 사용하세요 (예: /effect/0/code)")
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer[1:].split("/")]
    parent = entry
    try:
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
        value = parent[key]
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise ValueError("없는 코드 필드입니다") from e
    if not isinstance(value, str):
        raise ValueError("텍스트 필드만 편집할 수 있습니다")
    return parent, key, value


def read(char_key: str, script_id: str, field: str, offset: int, limit: int, query: str) -> str:
    entry = current(char_key, script_id)
    revision = digest(entry)
    if not field:
        return json.dumps({"revision": revision, "fields": fields(entry)}, ensure_ascii=False)
    _, _, text = locate(entry, field)
    start = max(0, offset)
    if query:
        start = text.find(query, start)
        if start < 0:
            return f"revision={revision}\n검색 결과 없음"
    end = min(len(text), start + max(1, min(4000, limit)))
    header = {"field": field, "revision": revision, "offset": start, "totalChars": len(text),
              "nextOffset": end if end < len(text) else None}
    return json.dumps(header, ensure_ascii=False) + "\n--- 원문 (JSON 인코딩 아님) ---\n" + text[start:end]


def replacement(char_key: str, script_id: str, field: str, revision: str,
                *, find: str = "", replace: str = "", source_path: str = "", expected_count: int = 1) -> dict:
    entry = current(char_key, script_id)
    if not revision or digest(entry) != revision:
        raise ValueError("스크립트가 변경됐습니다. 다시 조회한 revision으로 수정하세요")
    updated = copy.deepcopy(entry)
    parent, key, text = locate(updated, field)
    if source_path:
        path = files._resolve(files.SPACE, source_path)
        if path.suffix.lower() not in (".lua", ".txt", ".js", ".html", ".css"):
            raise ValueError("소스는 Lua/TXT/JS/HTML/CSS 텍스트 파일이어야 합니다")
        if path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError("소스 파일은 4MB까지 지원합니다")
        replacement = path.read_bytes().decode("utf-8-sig")
    else:
        if not find or expected_count < 1 or text.count(find) != expected_count:
            raise ValueError("find 일치 횟수가 expected_count와 다릅니다. 충분한 문맥으로 다시 지정하세요")
        replacement = text.replace(find, replace)
    if text == replacement:
        raise ValueError("변경 내용이 없습니다")
    parent[key] = replacement
    return {"id": script_id, "entry": updated, "baseHash": revision}
