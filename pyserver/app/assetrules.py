"""Project asset contracts: naming, expected slots and durable image identity.

These contracts describe files, never image prompts. Candidate identities are
independent of filenames; exports must round-trip through the selected rule.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import string
import threading
import uuid
from functools import lru_cache
from pathlib import Path

from . import files, nai, workspace

LOCK = threading.RLock()
STATUSES = {"required", "optional", "excluded"}
EXTENSIONS = {"png", "webp", "jpg"}
COPY_SUFFIX = r"(?:\.(?:[2-9]|[1-9][0-9]+))?"


class RuleError(ValueError):
    pass


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _root() -> Path:
    return workspace.space_root() / "studio/config/.studio/asset-rules"


def project_name(project: str) -> str:
    if not isinstance(project, str) or not project.strip() or project != project.strip():
        raise RuleError("프로젝트 폴더명이 필요합니다")
    _filename(project)
    return project


def _filename(name: str) -> str:
    if (not name or len(name) > 220 or name in (".", "..")
            or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith((".", " "))
            or name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL",
                *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}):
        raise RuleError(f"파일명으로 사용할 수 없습니다: {name!r}")
    return name


def _id(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", value):
        raise RuleError("규칙·세트·슬롯 ID는 영문, 숫자, _, - 로 1~60자입니다")
    return value


def rule_fields(rule: dict) -> list[str]:
    try:
        parts = list(string.Formatter().parse(rule["template"]))
    except (ValueError, KeyError, TypeError) as e:
        raise RuleError("파일명 템플릿이 올바르지 않습니다") from e
    fields = []
    for literal, field, fmt, conv in parts:
        if field is not None:
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,39}", field) or fmt or conv or field in fields:
                raise RuleError("템플릿 필드는 중복 없는 {character}, {emotion} 같은 이름이어야 합니다")
            fields.append(field)
    if not fields or "character" not in fields or len(fields) > 12:
        raise RuleError("템플릿에 {character}를 포함하고 필드는 12개 이하로 지정하세요")
    return fields


def pattern(rule: dict) -> str:
    """A portable numbered-capture regex (Python and JavaScript compatible)."""
    rule_fields(rule)
    chunks = []
    for literal, field, _, _ in string.Formatter().parse(rule["template"]):
        chunks.append(_regex_literal(literal))
        if field:
            values = rule.get("allowed", {}).get(field, [])
            chunks.append("(" + ("|".join(_regex_literal(v) for v in sorted(values, key=len, reverse=True))
                                 if values else ".+?") + ")")
    return "^" + "".join(chunks) + COPY_SUFFIX + r"\." + re.escape(rule.get("extension", "webp")) + "$"


def _regex_literal(value: str) -> str:
    # Unlike re.escape, avoid identity escapes such as \- and \space, which
    # JavaScript rejects when the bot compiles the regex with the u flag.
    return "".join("\\" + c if c in r"\.^$|?*+()[]{}" else c for c in value)


def render(rule: dict, fields: dict) -> str:
    names = rule_fields(rule)
    values = {}
    for key in names:
        value = fields.get(key, "")
        if not isinstance(value, str):
            raise RuleError(f"{key}: 문자열 값이 필요합니다")
        if not value:
            value = rule.get("empty", {}).get(key, "")
        if not value:
            raise RuleError(f"{key}: 값 또는 빈 값 대체어가 필요합니다")
        allowed = rule.get("allowed", {}).get(key, [])
        if allowed and value not in allowed:
            raise RuleError(f"{key}: 허용되지 않은 값 {value!r}")
        values[key] = value
    name = _filename(rule["template"].format(**values) + "." + rule.get("extension", "webp"))
    match = re.fullmatch(pattern(rule), name)
    if not match or dict(zip(names, match.groups())) != values:
        raise RuleError(f"파일명을 regex로 되읽으면 필드가 달라집니다: {name}")
    return name


def validate(document: dict) -> dict:
    if not isinstance(document, dict):
        raise RuleError("에셋 규칙 문서는 객체여야 합니다")
    # JSON copy both rejects non-serializable input and isolates the caller.
    doc = json.loads(json.dumps(document, ensure_ascii=False))
    rules, sets = doc.get("rules", []), doc.get("sets", [])
    if not isinstance(rules, list) or not isinstance(sets, list) or len(rules) > 100 or len(sets) > 200:
        raise RuleError("규칙은 100개, 세트는 200개 이하의 목록이어야 합니다")
    by_id = {}
    for rule in rules:
        if not isinstance(rule, dict):
            raise RuleError("규칙은 객체여야 합니다")
        rid = _id(rule.get("id"))
        if rid in by_id:
            raise RuleError(f"중복 규칙 ID: {rid}")
        names = rule_fields(rule)
        if rule.get("extension", "webp") not in EXTENSIONS:
            raise RuleError("확장자는 png, webp, jpg 중 하나입니다")
        for kind in ("allowed", "empty"):
            values = rule.get(kind, {})
            if not isinstance(values, dict) or set(values) - set(names):
                raise RuleError(f"{rid}: {kind}에는 템플릿 필드만 지정하세요")
            for key, value in values.items():
                if kind == "allowed":
                    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
                        raise RuleError(f"{key}: 허용값은 문자열 목록입니다")
                elif not isinstance(value, str):
                    raise RuleError(f"{key}: 빈 값 대체어는 문자열입니다")
        rule["regex"] = pattern(rule)
        rule["version"] = _hash(json.dumps({k: v for k, v in rule.items() if k != "version"}, sort_keys=True))[:16]
        by_id[rid] = rule
    set_ids = set()
    for aset in sets:
        if not isinstance(aset, dict):
            raise RuleError("세트는 객체여야 합니다")
        sid = _id(aset.get("id"))
        if sid in set_ids or aset.get("ruleId") not in by_id:
            raise RuleError(f"세트 ID 중복 또는 없는 규칙: {sid}")
        set_ids.add(sid)
        rule = by_id[aset["ruleId"]]
        chars = aset.get("characters", [])
        if not isinstance(chars, list) or not all(isinstance(c, str) and c for c in chars):
            raise RuleError("적용 캐릭터는 이름 목록입니다 (빈 목록은 전체)")
        slots = aset.get("slots", [])
        if not isinstance(slots, list) or len(slots) > 2000:
            raise RuleError("세트의 슬롯은 2000개 이하의 목록입니다")
        slot_ids = set()
        for slot in slots:
            if not isinstance(slot, dict):
                raise RuleError("슬롯은 객체여야 합니다")
            slot_id = _id(slot.get("id"))
            if slot_id in slot_ids or slot.get("status", "required") not in STATUSES:
                raise RuleError(f"슬롯 ID 중복 또는 잘못된 상태: {slot_id}")
            slot_ids.add(slot_id)
            fields = slot.get("fields", {})
            if not isinstance(fields, dict) or set(fields) - set(rule_fields(rule)) or "character" in fields:
                raise RuleError("슬롯에는 character를 제외한 템플릿 필드를 지정하세요")
            example_char = (chars or rule.get("allowed", {}).get("character") or ["Character"])[0]
            render(rule, {**fields, "character": example_char})
        overrides = aset.get("overrides", {})
        if not isinstance(overrides, dict):
            raise RuleError("캐릭터 예외 설정은 객체입니다")
        for character, statuses in overrides.items():
            if not character or not isinstance(statuses, dict) or set(statuses) - slot_ids or any(v not in STATUSES for v in statuses.values()):
                raise RuleError(f"캐릭터 예외 설정이 올바르지 않습니다: {character}")
    return {"rules": rules, "sets": sets}


def read(project: str) -> dict:
    project_name(project)
    p = _root() / "projects" / (_hash(project) + ".json")
    if not p.exists():
        return {"project": project, "revision": 0, "rules": [], "sets": []}
    return json.loads(p.read_text(encoding="utf-8"))


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def save(project: str, document: dict) -> dict:
    clean = validate(document)
    with LOCK:
        old = read(project)
        if document.get("revision") != old["revision"]:
            raise RuleError("다른 창에서 규칙이 변경됐습니다. 다시 불러온 뒤 저장하세요")
        result = {"project": project, "revision": old["revision"] + 1, **clean}
        _write(_root() / "projects" / (_hash(project) + ".json"), result)
        return result


def status(aset: dict, slot: dict, character: str) -> str:
    if aset.get("characters") and character not in aset["characters"]:
        return "excluded"
    return aset.get("overrides", {}).get(character, {}).get(slot["id"], slot.get("status", "required"))


def resolve(binding: dict, *, character: str = "", scene: str = "") -> dict:
    if not isinstance(binding, dict):
        raise RuleError("asset는 project, setId, slotId, fields를 담는 객체입니다")
    doc = read(str(binding.get("project") or ""))
    aset = next((s for s in doc["sets"] if s["id"] == binding.get("setId")), None)
    if aset is None:
        raise RuleError("적용할 에셋 세트를 선택하세요")
    supplied = binding.get("fields", {})
    if not isinstance(supplied, dict):
        raise RuleError("asset.fields는 객체입니다")
    candidates = [s for s in aset["slots"] if s["id"] == binding.get("slotId")] if binding.get("slotId") else [
        s for s in aset["slots"] if s["fields"].get("emotion") == scene]
    if len(candidates) != 1:
        raise RuleError("슬롯을 하나로 결정할 수 없습니다. asset.slotId를 지정하세요")
    slot = candidates[0]
    if any(k in slot["fields"] and v != slot["fields"][k] for k, v in supplied.items()):
        raise RuleError("슬롯에 정의된 필드를 바꾸려면 별도의 슬롯을 선택하세요")
    fields = {**slot["fields"], **supplied}
    fields.setdefault("character", character)
    if status(aset, slot, fields["character"]) == "excluded":
        raise RuleError(f"이 캐릭터에서 제외된 슬롯입니다: {slot['id']}")
    rule = next(r for r in doc["rules"] if r["id"] == aset["ruleId"])
    if set(fields) - set(rule_fields(rule)):
        raise RuleError("asset.fields에 템플릿에 없는 필드가 있습니다")
    name = render(rule, fields)
    # Persist normalized values so empty substitutions also round-trip.
    fields = dict(zip(rule_fields(rule), re.fullmatch(pattern(rule), name).groups()))
    return {"project": doc["project"], "setId": aset["id"], "slotId": slot["id"],
            "rule": rule, "fields": fields, "exportName": name}


def candidate(asset: dict, parent_id: str = "") -> dict:
    image_id = uuid.uuid4().hex
    return {**asset, "imageId": image_id, "parentId": parent_id}


def group_key(asset: dict) -> str:
    # Keep every semantic field: two variants must never collapse into one slot.
    return json.dumps([asset["project"], asset["setId"], asset["rule"]["id"],
                       asset["fields"]], sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def numbered(name: str, index: int) -> str:
    """Disk-only random candidate suffix; RisuAI receives the unsuffixed name."""
    p = Path(name)
    return name if index == 1 else f"{p.stem}.{index}{p.suffix}"


def bot_name(asset: dict) -> str:
    return Path(render(asset["rule"], asset["fields"])).stem


@lru_cache(maxsize=2048)
def _metadata(path: str, mtime: int, size: int) -> dict | None:
    p = Path(path)
    body = p.read_bytes()
    digest = hashlib.sha256(body).hexdigest()
    assignment = _root() / "assignments" / (_hash(str(p.resolve())) + ".json")
    if assignment.is_file():
        saved = json.loads(assignment.read_text(encoding="utf-8"))
        if saved["digest"] == digest:
            return saved["asset"]
    assigned = _root() / "identities" / (digest + ".json")
    if assigned.is_file():
        saved = json.loads(assigned.read_text(encoding="utf-8"))
        if not saved.get("ambiguous"):
            return saved["asset"]
    return nai.recipe(body).get("hina", {}).get("asset")


def metadata(path: Path) -> dict | None:
    st = path.stat()
    return _metadata(str(path.resolve()), st.st_mtime_ns, st.st_size)


def bind(path: str, binding: dict) -> dict:
    p = files._resolve(files.SPACE, path)
    if p.suffix.lower() not in (".png", ".webp", ".jpg", ".jpeg") or not p.is_file():
        raise RuleError("이미지 파일을 선택하세요")
    asset = candidate(resolve(binding))
    remember(p, asset)
    return asset


def remember(p: Path, asset: dict) -> None:
    digest = hashlib.sha256(p.read_bytes()).hexdigest()
    with LOCK:
        _write(_root() / "assignments" / (_hash(str(p.resolve())) + ".json"), {"digest": digest, "asset": asset})
        identity = _root() / "identities" / (digest + ".json")
        old = json.loads(identity.read_text(encoding="utf-8")) if identity.exists() else None
        # Identical pixels may intentionally serve different slots. Never let
        # a content-based rename fallback silently reassign another file.
        ambiguous = old and (old.get("ambiguous") or group_key(old["asset"]) != group_key(asset))
        _write(identity, {"ambiguous": True} if ambiguous else {"asset": asset})
        _metadata.cache_clear()


def classify(project: str, filename: str) -> list[dict]:
    """Preview import matches; ambiguity is returned, never silently resolved."""
    doc = read(project)
    matches = []
    for rule in doc["rules"]:
        m = re.fullmatch(pattern(rule), filename)
        if not m:
            continue
        fields = dict(zip(rule_fields(rule), m.groups()))
        for aset in doc["sets"]:
            if aset["ruleId"] != rule["id"]:
                continue
            for slot in aset["slots"]:
                try:
                    asset = resolve({"project": project, "setId": aset["id"], "slotId": slot["id"], "fields": fields})
                    matches.append(asset)
                except RuleError:
                    pass
    return matches


def coverage(project: str, character: str, assets: list[dict]) -> dict:
    if not character:
        raise RuleError("집계할 캐릭터 이름이 필요합니다")
    doc = read(project)
    if not doc["sets"]:
        raise RuleError("프로젝트에 에셋 세트가 없습니다. 필요한 슬롯을 먼저 정의하세요")
    present = set()
    for asset in assets:
        if asset.get("project") != project or asset.get("fields", {}).get("character") != character:
            continue
        try:
            current = resolve({"project": project, "setId": asset["setId"], "slotId": asset["slotId"], "fields": asset["fields"]})
            if current["exportName"] == asset["exportName"]:
                present.add((asset["setId"], asset["slotId"]))
        except RuleError:
            pass
    rows = []
    for aset in doc["sets"]:
        for slot in aset["slots"]:
            mode = status(aset, slot, character)
            rows.append({"setId": aset["id"], "slotId": slot["id"], "status": mode,
                         "present": (aset["id"], slot["id"]) in present})
    missing = [r for r in rows if r["status"] == "required" and not r["present"]]
    return {"project": project, "character": character, "slots": rows, "missing": missing,
            "complete": not missing}


def selected_assets(folder: str) -> list[dict]:
    from . import studio
    base = files._resolve(files.SPACE, folder)
    if not base.is_dir():
        raise RuleError("집계할 폴더가 없습니다")
    result = []
    # Selected status, not exported copies or generated candidates, is the truth.
    directories = [base, *(p for p in base.rglob("*") if p.is_dir() and not any(
        part == "selected" or part.startswith(".") for part in p.relative_to(base).parts))]
    for directory in directories:
        selections = studio.read_selection(directory.relative_to(workspace.space_root()).as_posix())
        for name, selection in selections.items():
            p = directory / name
            if p.parent == directory and p.is_file() and selection.get("use"):
                asset = metadata(p)
                if asset:
                    result.append(asset)
    return result


def export_plan(grouped: dict) -> dict:
    entries, problems, taken = [], [], set()
    counts: dict[str, int] = {}
    owners: dict[str, str] = {}
    for group in grouped["groups"]:
        for item in sorted(group["items"], key=lambda i: (not i["selection"].get("rep"), i.get("modified", 0), i["filename"])):
            targets = ([""] if item["selection"].get("use") else []) + (["inpaint/"] if item["selection"].get("inpaint") else [])
            if not targets:
                continue
            asset = item.get("asset")
            if not asset:
                problems.append(f"규칙이 지정되지 않은 채택 파일: {item['filename']}")
                continue
            try:
                name = render(asset["rule"], asset["fields"])
                # A rule snapshot preserves naming; current applicability still
                # wins if a user has since excluded the character or slot.
                resolve({"project": asset["project"], "setId": asset["setId"],
                         "slotId": asset["slotId"], "fields": asset["fields"]})
            except RuleError as e:
                problems.append(f"{item['filename']}: {e}")
                continue
            for prefix in targets:
                logical = (prefix + name).casefold()
                owner = group_key(asset)
                if logical in owners and owners[logical] != owner:
                    problems.append(f"서로 다른 에셋 규칙이 같은 이름을 만듭니다: {prefix + name}")
                owners[logical] = owner
                counts[logical] = counts.get(logical, 0) + 1
                target = prefix + numbered(name, counts[logical])
                if target.casefold() in taken:
                    problems.append(f"후보 번호와 다른 에셋 이름이 충돌합니다: {target}")
                taken.add(target.casefold())
                entries.append({"source": item["path"], "target": target, "assetName": bot_name(asset), "asset": asset})
    for item in grouped["unmatched"]:
        if item["selection"].get("use") or item["selection"].get("inpaint"):
            problems.append(f"이름 규칙을 확인할 수 없는 채택 파일: {item['filename']}")
    return {"mapping": entries, "problems": problems}


def export(grouped: dict, *, preview: bool = False) -> dict:
    plan = export_plan(grouped)
    result = {"folder": grouped["folder"] + "/selected", "managed": True, **plan,
              "used": sum(not x["target"].startswith("inpaint/") for x in plan["mapping"]),
              "inpaint": sum(x["target"].startswith("inpaint/") for x in plan["mapping"]),
              "empty": 0, "groups": len(grouped["groups"]), "unmatched": len(grouped["unmatched"])}
    if preview:
        return result
    if plan["problems"]:
        raise RuleError("\n".join(plan["problems"]))
    if not plan["mapping"]:
        raise RuleError("내보낼 채택 이미지가 없습니다")
    from PIL import Image
    base = files._resolve(files.SPACE, grouped["folder"])
    out = base / "selected"
    temp = base / (".export-" + uuid.uuid4().hex)
    backup = base / (".selected-backup-" + uuid.uuid4().hex)
    temp.mkdir()
    try:
        for item in plan["mapping"]:
            src = files._resolve(files.SPACE, item["source"])
            dest = temp / item["target"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            ext = dest.suffix.lower()
            body = src.read_bytes()
            with Image.open(io.BytesIO(body)) as im:
                if im.format == {".png": "PNG", ".webp": "WEBP", ".jpg": "JPEG"}[ext]:
                    dest.write_bytes(body)
                else:
                    im.convert("RGB" if ext == ".jpg" else "RGBA").save(dest,
                        **({"lossless": True} if ext == ".webp" else {}))
            remember(dest, item["asset"])
        # Build and validate everything before replacing an earlier export.
        with LOCK:
            if out.exists():
                out.rename(backup)
            try:
                temp.rename(out)
            except Exception:
                if backup.exists():
                    backup.rename(out)
                raise
        for item in plan["mapping"]:
            remember(out / item["target"], item["asset"])
        # Retain the previous export for recovery, outside the visible folder.
        if backup.exists():
            result["previousExport"] = backup.relative_to(workspace.space_root()).as_posix()
        _write(_root() / "exports" / (_hash(grouped["folder"]) + ".json"), result)
        return result
    finally:
        if temp.exists():
            shutil.rmtree(temp)


def adoption(path: str) -> dict:
    """Keep one RisuAI name for numbered alternatives; the host needs PNG bytes."""
    from . import assets
    p = files._resolve(files.SPACE, path)
    asset = metadata(p)
    if not asset:
        return assets.stage_file(path)
    resolve({"project": asset["project"], "setId": asset["setId"],
             "slotId": asset["slotId"], "fields": asset["fields"]})
    body = p.read_bytes()
    if not body.startswith(b"\x89PNG\r\n\x1a\n"):
        from PIL import Image
        # Conversion is a prepared local artifact, before the host proposal.
        target = _root() / "adoption" / (_hash(hashlib.sha256(body).hexdigest() + group_key(asset)) + ".png")
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            with Image.open(io.BytesIO(body)) as im:
                im.convert("RGBA").save(target)
        remember(target, asset)
        path = target.relative_to(workspace.space_root()).as_posix()
    return {**assets.stage_file(path), "name": bot_name(asset)}
