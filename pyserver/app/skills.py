"""Skills: procedures the agent loads when a job calls for them.

A skill is a folder under `data/skills/<slug>/`:

    SKILL.md          front matter (name, description, always) + the procedure
    references/*.md   material the procedure points at
    scripts/*.py      code the procedure runs through run_python
    …anything else    assets, examples - the folder is the unit

Only the **catalog** - one line per enabled skill, its name and its
description - goes into the system prompt. The description is the trigger: it
says when the skill applies, and the model is told to call `load_skill` before
starting a job that matches. The body reaches the context then, as a tool
result, and only then. This is the shape Claude Code and the Agent Skills
specification use, for the same reason: a procedure that is always in the
prompt is paid for on every turn of every conversation, and ten of them push
the actual work out of the model's attention. A skill that is loaded when its
trigger fires costs nothing until it is needed and is visible in the tool
trace when it is.

`always: true` in the front matter opts a skill back into the prompt - for a
rule that has to hold in every conversation (a house style, a hard limit).
That is the exception, so it is spelled out per skill rather than being the
default.

The same confinement as before (`sandbox.py`): skills are global, workspaces
are per bot, so the runner copies the enabled folders into `<ws>/skills/` on
every run rather than opening a hole to a shared directory. The agent reads
`skills/<slug>/references/x.md` with read_file and runs
`skills/<slug>/scripts/x.py` with run_python, both inside the workspace.
"""
from __future__ import annotations

import io
import re
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Any

from . import config, db, log

SKILL_FILE = "SKILL.md"
MAX_BODY = 40_000          # loaded on demand, so it may be long - but not a book
MAX_DESCRIPTION = 400      # the catalog line; this one is paid for every turn
MAX_FILE = 2_000_000
MAX_SKILLS = 100
CATALOG_LIMIT = 6_000      # the whole catalog block
ALWAYS_LIMIT = 16_000      # bodies of always-on skills, combined
TEXT_EXT = {".md", ".txt", ".py", ".json", ".yaml", ".yml", ".csv", ".html", ".js", ".lua", ".xml"}

# v6 added the NSFW asset-generation pitfalls reference (§1-28); rotating the
# key re-runs seed_once, which dedupes by name, so existing installs gain
# only the new skill.
SEED_KEY = "skills_seeded_v6"
FOLDER_KEY = "skills_folders_v1"
SEED_DIR = Path(__file__).resolve().parent / "seeds"


class SkillError(ValueError):
    pass


def root() -> Path:
    return config.DATA_DIR / "skills"


# --- SKILL.md --------------------------------------------------------------------

_FRONT = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)


def parse(text: str) -> tuple[dict[str, Any], str]:
    """Front matter (a flat `key: value` subset of YAML) and the body.

    Not a YAML parser on purpose: the keys a skill needs are strings and one
    flag, and pulling in a YAML library for that would add a dependency to the
    bundled interpreter for three lines of parsing. Multi-line values use the
    `>` / `|` block forms, which are the ones people actually write.
    """
    meta: dict[str, Any] = {}
    m = _FRONT.match(text or "")
    if not m:
        return meta, (text or "")
    block, body = m.group(1), (text or "")[m.end():]
    lines = block.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line or line[0] in " \t":
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if value in (">", "|", ">-", "|-"):
            # Block scalar: the indented lines that follow.
            chunk: list[str] = []
            while i < len(lines) and (not lines[i].strip() or lines[i][0] in " \t"):
                chunk.append(lines[i].strip())
                i += 1
            value = (" " if value.startswith(">") else "\n").join(c for c in chunk if c).strip()
        elif len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        meta[key] = value
    return meta, body


def _yaml_str(value: str) -> str:
    v = (value or "").replace("\r", " ").replace("\n", " ").strip()
    if not v:
        return '""'
    if any(c in v for c in ":#{}[]&*!|>'\"%@`") or v[0] in " -?":
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return v


def render(meta: dict[str, Any], body: str) -> str:
    """SKILL.md from its parts. Our keys first, anything else kept as it was."""
    lines = ["---"]
    lines.append(f"name: {_yaml_str(str(meta.get('name') or ''))}")
    lines.append(f"description: {_yaml_str(str(meta.get('description') or ''))}")
    if _truthy(meta.get("always")):
        lines.append("always: true")
    for k, v in meta.items():
        if k in ("name", "description", "always"):
            continue
        lines.append(f"{k}: {_yaml_str(str(v))}")
    lines.append("---")
    return "\n".join(lines) + "\n\n" + (body or "").strip() + "\n"


def _truthy(v: Any) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# --- folders ---------------------------------------------------------------------

def slugify(name: str) -> str:
    """A folder name from a skill name. Unicode letters survive - a Korean
    name is a fine folder name on every OS we run on - punctuation does not."""
    s = (name or "").strip().lower()
    s = re.sub(r"[\s/\\]+", "-", s)
    s = "".join(c for c in s if c.isalnum() or c in "-_.")
    s = re.sub(r"-{2,}", "-", s).strip("-._")
    return s[:60] or ("skill-" + uuid.uuid4().hex[:6])


def _dir(slug: str) -> Path:
    if not slug or slug != slugify(slug) or slug in (".", ".."):
        raise SkillError(f"잘못된 스킬 id 입니다: {slug!r}")
    return root() / slug


def _safe_rel(rel: str) -> Path:
    """A path inside a skill folder: at most two levels, no traversal."""
    parts = [p for p in re.split(r"[\\/]+", (rel or "").strip()) if p and p != "."]
    if not parts or any(p == ".." for p in parts) or len(parts) > 2:
        raise SkillError("파일 경로는 `scripts/x.py` 처럼 한 단계 폴더까지만 됩니다")
    clean = []
    for p in parts:
        q = "".join(c for c in p if c.isalnum() or c in "._-")
        if not q or q.startswith("."):
            raise SkillError(f"쓸 수 없는 파일 이름입니다: {p!r}")
        clean.append(q[:80])
    if clean[-1].upper() == SKILL_FILE.upper():
        raise SkillError("SKILL.md 는 스킬 편집에서 고쳐 주세요")
    return Path(*clean)


def _state(slug: str) -> dict:
    r = db.one("SELECT enabled, sort_order, updated_at FROM skill_state WHERE slug = ?", (slug,))
    if r is None:
        return {"enabled": True, "sortOrder": 0, "updatedAt": None}
    return {"enabled": bool(r["enabled"]), "sortOrder": int(r["sort_order"] or 0),
            "updatedAt": r["updated_at"]}


def _set_state(slug: str, *, enabled: bool | None = None, sort_order: int | None = None) -> None:
    cur = _state(slug)
    db.execute(
        "INSERT INTO skill_state(slug, enabled, sort_order, updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(slug) DO UPDATE SET enabled=excluded.enabled, sort_order=excluded.sort_order, "
        "updated_at=excluded.updated_at",
        (slug, int(cur["enabled"] if enabled is None else bool(enabled)),
         int(cur["sortOrder"] if sort_order is None else sort_order), db.now()),
    )


def _files(d: Path) -> list[dict]:
    out = []
    for f in sorted(d.rglob("*")):
        if not f.is_file() or f.name == SKILL_FILE:
            continue
        rel = f.relative_to(d).as_posix()
        if rel.startswith("."):
            continue
        out.append({"path": rel, "size": f.stat().st_size,
                    "textual": f.suffix.lower() in TEXT_EXT})
    return out


def _read(slug: str, d: Path) -> dict | None:
    md = d / SKILL_FILE
    if not md.is_file():
        return None
    try:
        text = md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    meta, body = parse(text)
    st = _state(slug)
    return {
        "id": slug,
        "slug": slug,
        "name": str(meta.get("name") or slug).strip(),
        "description": str(meta.get("description") or "").strip(),
        "always": _truthy(meta.get("always")),
        "enabled": st["enabled"],
        "sortOrder": st["sortOrder"],
        "body": body.strip(),
        "bodyChars": len(body.strip()),
        "files": _files(d),
        "updatedAt": md.stat().st_mtime,
        "meta": {k: v for k, v in meta.items() if k not in ("name", "description", "always")},
    }


def list_all(*, with_body: bool = False) -> list[dict]:
    r = root()
    if not r.is_dir():
        return []
    out = []
    for d in sorted(r.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        sk = _read(d.name, d)
        if sk is None:
            continue
        if not with_body:
            sk = {**sk, "body": ""}
        out.append(sk)
    out.sort(key=lambda s: (s["sortOrder"], s["name"].lower()))
    return out


def get(slug: str) -> dict | None:
    try:
        d = _dir(slug)
    except SkillError:
        return None
    return _read(slug, d) if d.is_dir() else None


def find(name_or_slug: str) -> dict | None:
    """By slug first, then by name, case-insensitively - the model says names."""
    want = (name_or_slug or "").strip()
    hit = get(slugify(want)) if want else None
    if hit is not None:
        return hit
    low = want.lower()
    for sk in list_all(with_body=True):
        if sk["name"].lower() == low or sk["slug"] == low:
            return sk
    return None


def listing() -> dict:
    items = list_all()
    block = prompt()
    return {
        "skills": items,
        "catalogChars": len(block),
        "catalogLimit": CATALOG_LIMIT + ALWAYS_LIMIT,
        "maxBodyChars": MAX_BODY,
        "maxDescriptionChars": MAX_DESCRIPTION,
        "dir": str(root()),
    }


# --- editing -----------------------------------------------------------------------

def save(name: str, description: str, body: str, *, slug: str | None = None,
         always: bool = False, enabled: bool | None = None,
         sort_order: int | None = None, extra_meta: dict | None = None) -> dict:
    label = str(name or "").strip()
    if not label:
        raise SkillError("스킬 이름을 입력해 주세요")
    if len(label) > 80:
        raise SkillError("스킬 이름이 너무 깁니다 (80자까지)")
    desc = " ".join(str(description or "").split())
    if not desc:
        raise SkillError("설명(언제 쓰는 스킬인지)을 입력해 주세요 — 이 한 줄이 에이전트가 스킬을 고르는 근거입니다")
    if len(desc) > MAX_DESCRIPTION:
        raise SkillError(f"설명은 {MAX_DESCRIPTION}자까지입니다 (지금 {len(desc)}자)")
    text = str(body or "").strip()
    if not text:
        raise SkillError("스킬 본문을 입력해 주세요")
    if len(text) > MAX_BODY:
        raise SkillError(f"스킬 본문은 {MAX_BODY}자까지입니다 (지금 {len(text)}자)")

    if slug:
        d = _dir(slug)
        if not d.is_dir():
            raise SkillError("없는 스킬입니다")
        previous = _read(slug, d) or {}
    else:
        if len(list_all()) >= MAX_SKILLS:
            raise SkillError(f"스킬은 {MAX_SKILLS}개까지입니다")
        slug = _unique_slug(label)
        d = _dir(slug)
        previous = {}
        d.mkdir(parents=True, exist_ok=True)

    meta = dict(extra_meta if extra_meta is not None else previous.get("meta") or {})
    meta.update({"name": label, "description": desc, "always": bool(always)})
    (d / SKILL_FILE).write_text(render(meta, text), encoding="utf-8")
    _set_state(slug, enabled=enabled if enabled is not None else previous.get("enabled", True),
               sort_order=sort_order)
    log.info("skill saved slug=%s name=%s always=%s chars=%s", slug, label, bool(always), len(text))
    return get(slug) or {}


def _unique_slug(label: str) -> str:
    base = slugify(label)
    slug = base
    n = 2
    while (root() / slug).exists():
        slug = f"{base}-{n}"
        n += 1
    return slug


def set_enabled(slug: str, enabled: bool) -> dict:
    if get(slug) is None:
        raise SkillError("없는 스킬입니다")
    _set_state(slug, enabled=enabled)
    return get(slug) or {}


def delete(slug: str) -> dict:
    d = _dir(slug)
    if get(slug) is None:
        raise SkillError("없는 스킬입니다")
    shutil.rmtree(d, ignore_errors=True)
    db.execute("DELETE FROM skill_state WHERE slug = ?", (slug,))
    log.info("skill deleted slug=%s", slug)
    return {"deleted": slug}


def put_file(slug: str, rel: str, data: bytes) -> dict:
    """Write one file into a skill folder (a script, a reference, an asset)."""
    d = _dir(slug)
    if get(slug) is None:
        raise SkillError("없는 스킬입니다")
    if len(data) > MAX_FILE:
        raise SkillError(f"파일 하나는 {MAX_FILE // 1_000_000}MB 까지입니다")
    target = d / _safe_rel(rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    _set_state(slug)  # bumps updated_at so the agent rebuilds
    return {"slug": slug, "path": target.relative_to(d).as_posix(), "size": len(data)}


def read_file(slug: str, rel: str, limit: int = 60_000) -> dict:
    d = _dir(slug)
    target = d / _safe_rel(rel)
    if not target.is_file():
        raise SkillError(f"파일이 없습니다: {rel}")
    if target.suffix.lower() not in TEXT_EXT:
        return {"path": rel, "textual": False, "content": "", "size": target.stat().st_size}
    text = target.read_text(encoding="utf-8", errors="replace")
    return {"path": rel, "textual": True, "content": text[:limit],
            "truncated": len(text) > limit, "size": target.stat().st_size}


def delete_file(slug: str, rel: str) -> dict:
    d = _dir(slug)
    target = d / _safe_rel(rel)
    if not target.is_file():
        raise SkillError(f"파일이 없습니다: {rel}")
    target.unlink()
    # An emptied subfolder is noise in the listing.
    try:
        if target.parent != d and not any(target.parent.iterdir()):
            target.parent.rmdir()
    except OSError:
        pass
    _set_state(slug)
    return {"slug": slug, "deleted": rel}


# --- importing -------------------------------------------------------------------------

def import_file(filename: str, text: str) -> dict:
    """A single file becomes a skill of its own.

    The old shape - upload one .md or one .py and get a skill - still works,
    because that is how most skills start. A .py becomes `scripts/<name>` with
    a SKILL.md that says to run it; a long .md becomes `references/<name>`
    with a SKILL.md that says to read it; a short .md *is* the SKILL.md body.
    """
    base = Path((filename or "").replace("\\", "/")).name.strip() or "skill.md"
    stem = Path(base).stem or "skill"
    ext = Path(base).suffix.lower()
    if ext == ".zip":
        raise SkillError("zip 은 import_zip 으로")
    label = stem.replace("_", " ").replace("-", " ").strip()[:80] or "스킬"
    if ext == ".py":
        desc = _docline(text) or f"{base} 스크립트를 실행해야 할 때"
        body = (f"이 스킬의 스크립트는 `scripts/{base}` 에 있다.\n"
                f"run_python 에서 `exec(open('skills/{{slug}}/scripts/{base}', encoding='utf-8').read())` "
                f"로 실행하거나, 먼저 read_file 로 읽어 무엇을 하는지 확인해라.")
        sk = save(label, desc, body)
        put_file(sk["slug"], f"scripts/{base}", text.encode("utf-8"))
        return _fix_slug_placeholder(sk["slug"])
    meta, md_body = parse(text)
    if meta.get("name") and meta.get("description"):
        # Already a SKILL.md - take it as written.
        return save(str(meta["name"]), str(meta["description"]), md_body,
                    always=_truthy(meta.get("always")),
                    extra_meta={k: v for k, v in meta.items() if k not in ("name", "description", "always")})
    if len(text) > 3000:
        desc = _leadin(text) or f"{base} 자료가 필요할 때"
        fname = base if ext == ".md" else stem + ".md"
        body = (f"이 스킬의 자료는 `references/{fname}` 에 있다. "
                f"필요한 부분을 read_file 로 읽어라. 통째로 외우려 하지 마라.")
        sk = save(label, desc, body)
        put_file(sk["slug"], f"references/{fname}", text.encode("utf-8"))
        return _fix_slug_placeholder(sk["slug"])
    desc = _leadin(text) or f"{label} 작업을 할 때"
    return save(label, desc, text)


def _fix_slug_placeholder(slug: str) -> dict:
    sk = get(slug) or {}
    if "{slug}" in sk.get("body", ""):
        save(sk["name"], sk["description"], sk["body"].replace("{slug}", slug),
             slug=slug, always=sk["always"], extra_meta=sk.get("meta"))
    return get(slug) or {}


def import_zip(filename: str, data: bytes) -> dict:
    """A zipped skill folder: SKILL.md at the root, or inside one top folder."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise SkillError("zip 파일이 아닙니다")
    names = [n for n in zf.namelist() if not n.endswith("/")]
    md = [n for n in names if Path(n).name.upper() == SKILL_FILE.upper()]
    if not md:
        raise SkillError("zip 안에 SKILL.md 가 없습니다")
    md.sort(key=lambda n: n.count("/"))
    top = md[0][: -len(Path(md[0]).name)]
    if top.count("/") > 1:
        raise SkillError("SKILL.md 는 zip 의 최상위나 한 단계 폴더 안에 있어야 합니다")
    text = zf.read(md[0]).decode("utf-8", errors="replace")
    meta, body = parse(text)
    label = str(meta.get("name") or Path(filename).stem or "스킬")
    desc = str(meta.get("description") or "") or _leadin(body) or f"{label} 작업을 할 때"
    sk = save(label, desc, body or "(본문 없음)", always=_truthy(meta.get("always")),
              extra_meta={k: v for k, v in meta.items() if k not in ("name", "description", "always")})
    total = 0
    for n in names:
        if n == md[0] or not n.startswith(top):
            continue
        rel = n[len(top):]
        try:
            payload = zf.read(n)
            total += len(payload)
            if total > MAX_FILE * 5:
                raise SkillError("zip 내용이 너무 큽니다")
            put_file(sk["slug"], rel, payload)
        except SkillError as e:
            log.warn("skill zip: skipped %s (%s)", n, e)
    return get(sk["slug"]) or {}


# --- what the agent sees ---------------------------------------------------------------

def enabled_skills() -> list[dict]:
    return [s for s in list_all(with_body=True) if s["enabled"]]


def enabled_dirs() -> list[tuple[str, Path]]:
    """(slug, folder) for the runner to copy into the workspace."""
    return [(s["slug"], root() / s["slug"]) for s in enabled_skills()]


def catalog_lines(items: list[dict] | None = None) -> list[str]:
    items = enabled_skills() if items is None else items
    out = []
    for s in items:
        tag = " (항상 적용됨)" if s["always"] else ""
        out.append(f"- **{s['name']}**{tag} — {s['description'] or '(설명 없음)'}")
    return out


def prompt() -> str:
    """The block appended to the instructions: the catalog, then always-on bodies."""
    items = enabled_skills()
    if not items:
        return ""
    head = (
        "\n\n## 스킬\n"
        "아래는 사용자가 등록한 작업 절차다. **해당하는 작업이면 시작하기 전에 `load_skill(이름)` 으로 "
        "본문을 불러 그대로 따른다.** 본문을 읽기 전에 절차를 지어내지 마라. 설명이 맞지 않는 작업에는 "
        "부르지 마라. 스킬 폴더의 파일은 워크스페이스의 `skills/<id>/…` 에 있다 — 자료는 read_file, "
        "스크립트는 run_python 으로 쓴다.\n\n"
    )
    lines = catalog_lines(items)
    block = head + "\n".join(lines)
    if len(block) > CATALOG_LIMIT:
        # Keep whole lines; say what was cut. A silently missing skill looks
        # exactly like an agent that ignored it.
        kept: list[str] = []
        used = len(head)
        for ln in lines:
            if used + len(ln) + 1 > CATALOG_LIMIT:
                break
            kept.append(ln)
            used += len(ln) + 1
        dropped = len(lines) - len(kept)
        log.warn("skill catalog over %s chars: %s skipped", CATALOG_LIMIT, dropped)
        block = head + "\n".join(kept) + f"\n(스킬 {dropped}개가 길이 제한으로 목록에서 빠졌습니다. 설정에서 설명을 줄여 주세요.)"

    always = [s for s in items if s["always"] and s["body"]]
    if always:
        used = 0
        parts = []
        for s in always:
            piece = f"\n\n### 항상 적용: {s['name']}\n{s['body']}"
            if used + len(piece) > ALWAYS_LIMIT:
                log.warn("always-on skills over %s chars: %s skipped", ALWAYS_LIMIT, s["name"])
                parts.append(f"\n\n(스킬 “{s['name']}” 의 본문이 길이 제한으로 빠졌습니다 — load_skill 로 불러라.)")
                continue
            parts.append(piece)
            used += len(piece)
        block += "".join(parts)
    return block


def load(name_or_slug: str) -> str:
    """What `load_skill` returns: the body, and the files it can reach."""
    sk = find(name_or_slug)
    if sk is None:
        names = ", ".join(s["name"] for s in enabled_skills()) or "(없음)"
        return f"그런 스킬이 없습니다: {name_or_slug!r}. 있는 스킬: {names}"
    if not sk["enabled"]:
        return (f"스킬 “{sk['name']}” 은 사용자가 꺼 두었습니다 — 부르지 말고, 그 스킬 없이 진행하세요. "
                "(꺼진 스킬은 카탈로그에도 없습니다; 다시 시도하지 마세요.)")
    lines = [f"# 스킬: {sk['name']}", f"_{sk['description']}_", "", sk["body"] or "(본문 없음)"]
    if sk["files"]:
        lines.append("")
        lines.append(f"## 이 스킬의 파일 (워크스페이스 `skills/{sk['slug']}/` 아래)")
        for f in sk["files"]:
            lines.append(f"- `skills/{sk['slug']}/{f['path']}` ({f['size']}B)"
                         + ("" if f["textual"] else " · 텍스트 아님"))
        lines.append("자료는 read_file 로 읽고, 스크립트는 run_python 안에서 "
                     f"`exec(open('skills/{sk['slug']}/scripts/<이름>.py', encoding='utf-8').read())` 로 실행한다.")
    return "\n".join(lines)[:MAX_BODY + 4000]


def fingerprint() -> str:
    """Changes whenever the prompt block or an enabled folder changed, so the
    agent is rebuilt and the workspace copy refreshed."""
    r = root()
    stamp: list[str] = []
    if r.is_dir():
        for d in sorted(r.iterdir()):
            md = d / SKILL_FILE
            if md.is_file():
                st = _state(d.name)
                stamp.append(f"{d.name}:{int(st['enabled'])}:{md.stat().st_mtime_ns}:{st['updatedAt'] or 0}")
    return "|".join(stamp) or "none"


# --- descriptions from files (for single-file imports) -------------------------------------

def _leadin(text: str) -> str:
    """A document's opening lines, as its "when to open this"."""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            if out:
                break
            continue
        if line.startswith(("#", "-", "|", "---", "```")):
            if out:
                break
            continue
        out.append(line)
        if len(" ".join(out)) > 200:
            break
    return " ".join(out)[:MAX_DESCRIPTION]


def _docline(source: str) -> str:
    """A script's first docstring or comment line, as its description."""
    for raw in (source or "").splitlines()[:12]:
        line = raw.strip()
        if not line or line.startswith(("import ", "from ", "#!")):
            continue
        for delim in ('"""', "'''"):
            if line.startswith(delim):
                rest = line[len(delim):]
                end = rest.find(delim)
                return (rest if end < 0 else rest[:end]).strip()[:200]
        if line.startswith("#"):
            return line.lstrip("#").strip()[:200]
        return ""
    return ""


# --- seeds and migration ---------------------------------------------------------------

SEEDS: list[tuple[str, str, str]] = [
    (
        "요약 이사 (초반 턴을 로어북으로)",
        "긴 챗의 앞부분을 요약해 로어북으로 옮기고 그 턴들을 본문에서 덜어낼 때. \"챗 이사\", \"요약해서 로어북에\", \"앞부분 정리\" 같은 요청.",
        """긴 챗의 앞부분을 로어북으로 옮기고 본문에서 덜어내는 작업이다.

1. list_turns 로 전체 길이와 흐름을 먼저 파악한다. 사용자가 범위를 주지 않았으면 어디까지 옮길지 먼저 묻는다.
2. 옮길 범위를 read_turns 로 실제로 읽는다. 기억으로 요약하지 않는다.
3. 사건·설정·관계를 항목별로 정리한다. 한 항목에 하나의 사실만 담는다.
4. 요약본을 out/ 에 md 로 먼저 저장하고 사용자에게 보여 준다. 이 단계에서 "이대로 진행할까요?"라고 묻는다.
5. 동의를 받으면 로어북 추가(propose_lore_add)와 원본 턴 삭제(stage_delete)를 **한 턴에** 제안한다.
6. 삭제 범위에 하이파 요약이 참조하는 턴이 있으면 반드시 먼저 알린다.""",
    ),
]

# Seeds that were shipped once and are retired: removed from installs that
# still carry them untouched (the user asked; the agent does the job as well
# without a procedure card).
RETIRED_SEEDS = ("말투 통일", "NSFW 에셋 생성 함정")
# Bumped when RETIRED_SEEDS grows, so an existing install sweeps the new
# entry once (defaults_once ran on 0.7.2 installs and never again).
RETIRE_KEY = "skills_retire_v2"


def retire_once() -> None:
    """Remove retired seeds an existing install still carries (§1-39: the
    NSFW pitfalls card confused more than it helped, and studio_generate no
    longer asks for it - a disabled skill the prompt still named was a
    load_skill failure every time)."""
    if db.has_migration(RETIRE_KEY):
        return
    gone = 0
    for s in list_all():
        if s["name"].strip() in RETIRED_SEEDS:
            try:
                delete(s["slug"])
                gone += 1
            except Exception as e:  # noqa: BLE001
                log.warn("retire %s: %s", s["slug"], e)
    db.mark_migration(RETIRE_KEY)
    if gone:
        log.info("skills: retired %s seed(s)", gone)

# filename -> (display name, description, starts enabled). All on by default
# since 0.7.2: a reference the agent may need is worth its catalog line, and
# a disabled reference is one the user has to know exists to switch on.
SEED_FILES: dict[str, tuple[str, str, bool]] = {
    "risuai-cbs.md": ("RisuAI CBS 문법",
                      "봇 카드·로어북·정규식·프롬프트의 `{{tag}}` (CBS) 문법을 읽거나 써야 할 때. {{getvar}}·{{random}} 같은 태그의 뜻이 필요할 때.", True),
    "risuai-lorebook-style.md": ("RisuAI 로어북 작성 규칙",
                                 "로어북 항목을 새로 쓰거나 고칠 때 반드시. ### 제목·#### 소제목·불릿 형식, 우선순위 숫자 표(300~2000), 영/한/일 키워드, 폴더, 상시 항목 규칙. 실리태번식 @@ 헤더 금지.", True),
    "risuai-lorebook.md": ("RisuAI 로어북 구조",
                           "챗 로어북 항목을 만들거나 고칠 때, 특히 발동 조건(key·데코레이터·삽입 위치)을 정할 때.", True),
    "risuai-hooks.md": ("RisuAI 처리 순서 (정규식·Lua 훅)",
                        "Regex(editinput/editoutput/editprocess/editdisplay)·Lua listenEdit(editRequest 등)·트리거가 한 턴에서 언제 어떤 순서로 돌고 무엇이 저장되는지. 정규식·트리거·배경 HTML 을 만들거나 고칠 때, 태그가 요청/화면/저장본 어디에 남는지 설명할 때.", True),
    "risuai-lua.md": ("RisuAI Lua 트리거",
                      "봇 카드의 Lua 트리거 스크립트를 읽거나 이해해야 할 때.", True),
    "charx-cards.md": ("charx 카드 구조",
                       "사용자가 .charx 카드 파일을 올렸고 그 내부 구조(설정·에셋·로어북)를 알아야 할 때.", True),
    "charx_unpack.py": ("charx 풀기",
                        "사용자가 올린 .charx 카드를 읽기 좋은 폴더로 풀어 조사해야 할 때.", True),
    "studio-image-ops.md": ("에셋 스튜디오 이미지 가공",
                            "에셋 스튜디오의 이미지를 크기 조절·자르기·포맷 변환·메타데이터 제거해야 할 때. Pillow 는 배포 번들에 없어 run_python 에서 설치해 쓴다.", True),
    "arca-html.md": ("아카라이브 HTML 작성",
                     "아카라이브(arca.live)에 붙여넣을 HTML(챗로그·소개글·요약)을 만들 때의 제약.", True),
}


def seed_once() -> None:
    """Install the starter skills once, as folders. Idempotent by name too."""
    if db.has_migration(SEED_KEY):
        return
    have = {s["name"].strip().lower() for s in list_all()}
    made = 0
    for name, desc, body in SEEDS:
        if name.strip().lower() in have:
            continue
        try:
            save(name, desc, body, sort_order=made)
            made += 1
        except SkillError as e:  # noqa: PERF203
            log.warn("could not seed skill %s: %s", name, e)
    for filename, (label, desc, enabled) in SEED_FILES.items():
        if label.strip().lower() in have:
            continue
        path = SEED_DIR / filename
        try:
            data = path.read_bytes()
        except OSError as e:
            log.warn("seed file missing: %s (%s)", filename, e)
            continue
        try:
            _seed_file_skill(label, desc, filename, data, enabled, made)
            made += 1
        except SkillError as e:  # noqa: PERF203
            log.warn("could not seed %s: %s", filename, e)
    db.mark_migration(SEED_KEY)
    log.info("seeded %s starter skills", made)


DEFAULTS_KEY = "skills_defaults_v1"


def defaults_once() -> None:
    """One-time alignment of an existing install with the 0.7.2 defaults:
    every skill switched on, and retired seeds removed. Runs after seeding
    so a fresh install gets the same end state by construction."""
    if db.has_migration(DEFAULTS_KEY):
        return
    on = 0
    gone = 0
    for s in list_all():
        if s["name"].strip() in RETIRED_SEEDS:
            try:
                delete(s["slug"])
                gone += 1
            except SkillError:
                pass
            continue
        if not s["enabled"]:
            _set_state(s["slug"], enabled=True)
            on += 1
    db.mark_migration(DEFAULTS_KEY)
    log.info("skill defaults: enabled %s, retired %s", on, gone)


# Rotating the key re-copies the seed into existing installs on next boot -
# _v2 added the batch-spec section (inline scenes, name addressing, adhoc dir).
STUDIO_OPS_KEY = "skills_studio_ops_space_v2"


def refresh_studio_ops_once() -> None:
    """The seeded studio skill's reference drifts as the studio grows (the
    space move in 0.11.0, then the batch-spec rules). Replace that one
    reference file with the current seed, once per key rotation."""
    if db.has_migration(STUDIO_OPS_KEY):
        return
    db.mark_migration(STUDIO_OPS_KEY)
    target = next((s for s in list_all()
                   if s["name"].strip() == "에셋 스튜디오 이미지 가공"), None)
    if not target:
        return
    try:
        data = (SEED_DIR / "studio-image-ops.md").read_bytes()
        put_file(target["slug"], "references/studio-image-ops.md", data)
        log.info("studio image-ops reference refreshed for the space")
    except (OSError, SkillError) as e:
        log.warn("could not refresh the studio image-ops reference: %s", e)


def _seed_file_skill(label: str, desc: str, filename: str, data: bytes, enabled: bool, order: int) -> dict:
    script = filename.endswith(".py")
    sub = "scripts" if script else "references"
    slug = _unique_slug(label)
    body = (f"이 스킬의 {'스크립트' if script else '자료'}는 `{sub}/{filename}` 에 있다. "
            + (f"run_python 안에서 `exec(open('skills/{slug}/scripts/{filename}', encoding='utf-8').read())` 로 실행한다. "
               "먼저 read_file 로 읽어 인자와 동작을 확인해라."
               if script else
               f"필요한 절을 read_file 로 `skills/{slug}/{sub}/{filename}` 에서 읽어라. 통째로 외우려 하지 마라."))
    sk = save(label, desc, body, enabled=enabled, sort_order=order)
    put_file(sk["slug"], f"{sub}/{filename}", data)
    return get(sk["slug"]) or {}


def migrate_rows_once() -> None:
    """Old installs kept skills as database rows; turn each into a folder.

    Runs once. Rows are left in place (harmless, and a rollback path) and the
    enabled flag is carried over, because a skill the user turned off must
    not come back on by being moved.
    """
    if db.has_migration(FOLDER_KEY):
        return
    try:
        rows = db.query("SELECT * FROM skills ORDER BY sort_order, name COLLATE NOCASE")
    except Exception:  # noqa: BLE001 - the table may not exist on a fresh install
        rows = []
    have = {s["name"].strip().lower() for s in list_all()}
    moved = 0
    for i, r in enumerate(rows):
        d = db.row_to_dict(r) or {}
        name = str(d.get("name") or "").strip()
        if not name or name.lower() in have:
            continue
        kind = d.get("kind") or "md"
        body = str(d.get("body") or "")
        enabled = bool(d.get("enabled"))
        try:
            if kind in ("script", "reference"):
                fname = d.get("filename") or (name + (".py" if kind == "script" else ".md"))
                desc = (_docline(body) if kind == "script" else _leadin(body)) or f"{name} 이 필요할 때"
                _seed_file_skill(name, desc, fname, body.encode("utf-8"), enabled, i)
            else:
                desc = _leadin(body) or f"{name} 작업을 할 때"
                save(name, desc, body, enabled=enabled, sort_order=i)
            have.add(name.lower())
            moved += 1
        except SkillError as e:  # noqa: PERF203
            log.warn("could not migrate skill %s: %s", name, e)
    db.mark_migration(FOLDER_KEY)
    if moved:
        log.info("migrated %s skill rows into folders under %s", moved, root())
