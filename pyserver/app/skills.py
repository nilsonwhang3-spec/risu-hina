"""Editable procedures appended to the agent's instructions.

A skill is a short written procedure - "how to move early turns into the
lorebook", "how to run a voice-consistency pass" - that the agent reads before
it starts. They live here rather than hard-coded in `agent.INSTRUCTIONS`
because they are the part that changes with the user's own working habits, and
because a procedure the user can correct is worth more than one they have to
re-explain in every conversation.

Two guards matter:

**Enabled, not merely present.** Every enabled skill goes into every request's
system prompt, so a skill left on is a permanent cost. Disabling keeps the text
without paying for it.

**A hard ceiling on the total.** Instructions that grow without limit push the
real work out of the model's attention, and here they would also be re-sent on
every turn of the tool loop. `TOTAL_LIMIT` is the point at which we truncate
loudly rather than silently sending a system prompt bigger than the work.

## Three kinds

| kind | body | prompt | file |
|---|---|---|---|
| `md` | 지침 산문 | 통째로 실린다 | — |
| `script` | 파이썬 | 한 줄 참조만 | `<ws>/skills/<name>.py` |
| `reference` | 마크다운 자료 | 한 줄 참조만 | `<ws>/skills/<name>.md` |

`reference` exists because the useful reference material is far bigger than any
sane prompt budget - the RisuAI CBS syntax tables alone are 9,000 characters,
and they are a lookup, not an instruction. Trimming them to fit would be worse
than leaving them out: the agent would confidently use the half that survived.
So the whole document goes to disk and the prompt gets a line saying it is there
and when to open it.

That split is what keeps both kinds compatible with the confinement in
`sandbox.py`. Skills are global, workspaces are per bot; rather than opening a
hole so the sandbox can reach a shared directory, the runner copies the enabled
files in. Nothing has to reach out.
"""
from __future__ import annotations

import uuid

from . import db, log

MAX_BODY = 8000
# Scripts and reference documents are never sent to the model in full, so they
# are allowed to be much longer than a prompt-loaded skill.
MAX_SCRIPT = 200_000
TOTAL_LIMIT = 24000
MAX_SKILLS = 60

KINDS = ("md", "script", "reference")
# Kinds that live as a file in the workspace rather than in the prompt.
FILE_KINDS = ("script", "reference")
EXT = {"script": ".py", "reference": ".md"}

SEED_KEY = "skills_seeded_v2"

# Reference material and helper scripts, kept in the repo rather than as a
# runtime dependency on the project they came from.
SEED_DIR = __import__("pathlib").Path(__file__).resolve().parent / "seeds"

# Shipped as a starting point, not as furniture: they are ordinary rows the
# user can edit or delete, and the seed runs once so a deleted one stays
# deleted.
SEEDS: list[tuple[str, str]] = [
    (
        "요약 이사 (초반 턴을 로어북으로)",
        """긴 챗의 앞부분을 로어북으로 옮기고 본문에서 덜어내는 작업이다.

1. list_turns 로 전체 길이와 흐름을 먼저 파악한다. 사용자가 범위를 주지 않았으면 어디까지 옮길지 먼저 묻는다.
2. 옮길 범위를 read_turns 로 실제로 읽는다. 기억으로 요약하지 않는다.
3. 사건·설정·관계를 항목별로 정리한다. 한 항목에 하나의 사실만 담는다.
4. 요약본을 out/ 에 md 로 먼저 저장하고 사용자에게 보여 준다. 이 단계에서 승인을 받는다.
5. 승인 후에야 stage_delete 로 원본 턴 삭제를 제안한다. 요약과 삭제를 한 번에 제안하지 않는다.
6. 삭제 범위에 하이파 요약이 참조하는 턴이 있으면 반드시 먼저 알린다.""",
    ),
    (
        "말투 통일",
        """한 인물의 말투를 챗 전체에서 고르게 맞추는 작업이다.

1. search_turns 로 해당 인물의 대사가 있는 턴을 모은다.
2. 실제 사례를 10개쯤 read_turns 로 읽고, 어떤 편차가 있는지 먼저 사용자에게 정리해 보고한다.
3. 규칙이 정해지면 run_python 으로 후보를 뽑아 개수를 확인한다. 눈대중으로 세지 않는다.
4. 기계적으로 치환 가능한 것은 stage_bulk, 문맥을 봐야 하는 것은 stage_edit 으로 나눠 제안한다.
5. 원문의 오탈자나 의도된 말버릇까지 고치지 않는다. 애매하면 남기고 물어본다.""",
    ),
]


class SkillError(ValueError):
    pass


def _row(r) -> dict:
    d = db.row_to_dict(r) or {}
    return {
        "id": d.get("id"),
        "name": d.get("name") or "",
        "body": d.get("body") or "",
        "enabled": bool(d.get("enabled")),
        "sortOrder": int(d.get("sort_order") or 0),
        "kind": d.get("kind") or "md",
        "filename": d.get("filename") or "",
        "updatedAt": d.get("updated_at"),
    }


def _safe_filename(name: str, fallback: str, ext: str = ".py") -> str:
    """A basename with nothing that could steer where the file lands."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    # str.isalnum is Unicode-aware, so Korean names survive; the explicit set is
    # only the punctuation a filename may keep.
    base = "".join(c for c in base if c.isalnum() or c in "._-") or fallback
    if not base.lower().endswith(ext):
        base += ext
    return base[:80]


def list_all() -> list[dict]:
    rows = db.query("SELECT * FROM skills ORDER BY sort_order, name COLLATE NOCASE")
    return [_row(r) for r in rows]


def listing() -> dict:
    items = list_all()
    return {
        "skills": items,
        # Only md skills are sent, so only they spend the budget.
        "usedChars": sum(len(i["body"]) for i in items
                         if i["enabled"] and i["kind"] == "md"),
        "kinds": list(KINDS),
        "limitChars": TOTAL_LIMIT,
        "maxBodyChars": MAX_BODY,
    }


def get(skill_id: str) -> dict | None:
    r = db.one("SELECT * FROM skills WHERE id = ?", (skill_id,))
    return _row(r) if r is not None else None


def save(name: str, body: str, *, skill_id: str | None = None,
         enabled: bool = True, sort_order: int | None = None,
         kind: str = "md", filename: str = "") -> dict:
    label = str(name or "").strip()
    if not label:
        raise SkillError("스킬 이름을 입력해 주세요")
    if len(label) > 80:
        raise SkillError("스킬 이름이 너무 깁니다 (80자까지)")
    if kind not in KINDS:
        raise SkillError("스킬 종류는 md · script · reference 중 하나여야 합니다")
    # A script keeps its leading whitespace: stripping it would change the
    # meaning of the first line of a Python file.
    text = str(body or "") if kind == "script" else str(body or "").strip()
    if not text.strip():
        raise SkillError("스킬 내용을 입력해 주세요")
    cap = MAX_SCRIPT if kind in FILE_KINDS else MAX_BODY
    if len(text) > cap:
        raise SkillError(f"스킬 하나는 {cap}자까지입니다 (지금 {len(text)}자)")

    previous = get(skill_id) if skill_id else None
    if skill_id and previous is None:
        raise SkillError("없는 스킬입니다")
    if not skill_id and len(db.query("SELECT id FROM skills")) >= MAX_SKILLS:
        raise SkillError(f"스킬은 {MAX_SKILLS}개까지만 저장할 수 있습니다")

    fname = ""
    if kind in FILE_KINDS:
        fname = _safe_filename(
            filename or (previous or {}).get("filename") or label,
            "skill" + EXT[kind], EXT[kind])

    sid = skill_id or uuid.uuid4().hex
    order = sort_order if sort_order is not None else (
        previous["sortOrder"] if previous else _next_order())
    now = db.now()
    db.execute(
        "INSERT INTO skills(id, name, body, enabled, sort_order, kind, filename, "
        "created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, body=excluded.body, "
        "enabled=excluded.enabled, sort_order=excluded.sort_order, kind=excluded.kind, "
        "filename=excluded.filename, updated_at=excluded.updated_at",
        (sid, label, text, int(bool(enabled)), int(order), kind, fname, now, now),
    )
    log.info("skill saved id=%s name=%s kind=%s enabled=%s chars=%s",
             sid, label, kind, bool(enabled), len(text))
    return get(sid) or {}


def _next_order() -> int:
    r = db.one("SELECT COALESCE(MAX(sort_order), -1) AS m FROM skills")
    return int((r["m"] if r else -1) or -1) + 1


def set_enabled(skill_id: str, enabled: bool) -> dict:
    if get(skill_id) is None:
        raise SkillError("없는 스킬입니다")
    db.execute("UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?",
               (int(bool(enabled)), db.now(), skill_id))
    return get(skill_id) or {}


def delete(skill_id: str) -> dict:
    if get(skill_id) is None:
        raise SkillError("없는 스킬입니다")
    db.execute("DELETE FROM skills WHERE id = ?", (skill_id,))
    return {"deleted": skill_id}


def enabled_files() -> list[dict]:
    """Skills the runner should write into the workspace as files."""
    rows = db.query(
        "SELECT * FROM skills WHERE enabled = 1 AND kind IN ('script', 'reference') "
        "ORDER BY sort_order, name COLLATE NOCASE")
    return [_row(r) for r in rows]


# Kept as the older name; pyexec imported it before reference skills existed.
enabled_scripts = enabled_files


def prompt() -> str:
    """The enabled skills, as the block appended to the agent instructions."""
    rows = db.query(
        "SELECT name, body, kind, filename FROM skills WHERE enabled = 1 "
        "ORDER BY sort_order, name COLLATE NOCASE")
    if not rows:
        return ""
    parts: list[str] = []
    used = 0
    dropped = 0
    for r in rows:
        if r["kind"] in FILE_KINDS:
            # The body stays out of the prompt. What the model needs is that the
            # file exists, where, and roughly when to open it.
            script = r["kind"] == "script"
            head = _docline(r["body"]) if script else _leadin(r["body"])
            block = (f"### {r['name']} ({'스크립트' if script else '자료'})" + chr(10)
                     + f"`skills/{r['filename']}` 에 있다. "
                     + ("run_python 에서 실행하거나 읽어라."
                        if script else "필요할 때 read_file 로 읽어라.")
                     + (chr(10) + head if head else ""))
        else:
            block = f"### {r['name']}" + chr(10) + r["body"].strip()
        if used + len(block) > TOTAL_LIMIT:
            dropped += 1
            continue
        parts.append(block)
        used += len(block)
    if dropped:
        # Loud, because a silently dropped skill looks exactly like an agent
        # that ignored its instructions.
        log.warn("skills over the %s char budget: %s skipped", TOTAL_LIMIT, dropped)
        parts.append(f"(스킬 {dropped}개가 길이 제한으로 빠졌습니다. 설정에서 정리해 주세요.)")
    return "\n\n## 사용자 스킬\n아래는 사용자가 직접 작성한 작업 절차다. 해당하는 작업을 할 때 그대로 따른다.\n\n" \
        + "\n\n".join(parts)


def _leadin(text: str) -> str:
    """A reference document's opening lines, as its "when to open this"."""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            if out:
                break
            continue
        if line.startswith(("#", "-", "|", "---")):
            break
        out.append(line)
        if len(" ".join(out)) > 200:
            break
    return " ".join(out)[:220]


def _docline(source: str) -> str:
    """The script's first docstring or comment line, as its description."""
    for raw in source.splitlines()[:12]:
        line = raw.strip()
        if not line or line.startswith(("import ", "from ", "#!")):
            continue
        for delim in ('"""', "'''"):
            if line.startswith(delim):
                # Stop at the closing delimiter. Without this a file whose whole
                # source sits on one line - anything with escaped newlines -
                # would put its entire body in the prompt, which is exactly what
                # a script skill exists to avoid.
                rest = line[len(delim):]
                end = rest.find(delim)
                return (rest if end < 0 else rest[:end]).strip()[:200]
        if line.startswith("#"):
            return line.lstrip("#").strip()[:200]
        return ""
    return ""


def fingerprint() -> str:
    """Changes whenever the prompt block would change, so the agent rebuilds."""
    r = db.one(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS c, "
        "COALESCE(MAX(updated_at), 0) AS t FROM skills WHERE enabled = 1")
    return f"{r['n']}:{r['c']}:{r['t']}" if r else "0:0:0"


# filename -> (display name, whether it starts enabled)
#
# The RisuAI references are on by default because they cost one line each and
# answer questions that come up constantly. charx is off: most chats have no
# card file to unpack, and a line about one is a line about nothing.
SEED_FILES: dict[str, tuple[str, bool]] = {
    "risuai-cbs.md": ("RisuAI CBS 문법", True),
    "risuai-lorebook.md": ("RisuAI 로어북 구조", True),
    "risuai-lua.md": ("RisuAI Lua 트리거", False),
    "charx-cards.md": ("charx 카드 구조", False),
    "charx_unpack.py": ("charx 풀기", False),
    "arca-html.md": ("아카라이브 HTML 작성", False),
}


def seed_once() -> None:
    """Install the starter skills exactly once."""
    if db.has_migration(SEED_KEY):
        return
    order = 0
    for name, body in SEEDS:
        try:
            save(name, body, sort_order=order)
            order += 1
        except SkillError as e:  # noqa: PERF203
            log.warn("could not seed skill %s: %s", name, e)

    for filename, (label, enabled) in SEED_FILES.items():
        path = SEED_DIR / filename
        try:
            body = path.read_text(encoding="utf-8")
        except OSError as e:
            log.warn("seed file missing: %s (%s)", filename, e)
            continue
        kind = "script" if filename.endswith(".py") else "reference"
        try:
            save(label, body, kind=kind, filename=filename,
                 enabled=enabled, sort_order=order)
            order += 1
        except SkillError as e:  # noqa: PERF203
            log.warn("could not seed %s: %s", filename, e)

    db.mark_migration(SEED_KEY)
    log.info("seeded %s starter skills", order)
