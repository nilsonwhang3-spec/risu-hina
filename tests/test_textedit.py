"""replace_once: the contract behind propose_*_replace.

    python tests/test_textedit.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pyserver"))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp949
except Exception:  # noqa: BLE001
    pass

from app.textedit import ReplaceError, replace_once  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def expect_error(name: str, fn, needle: str) -> None:
    try:
        fn()
    except ReplaceError as e:
        check(name, needle in str(e), str(e))
        return
    check(name, False, "no error raised")


def main() -> int:
    body = "첫 줄입니다.\n성소는 북쪽 숲에 있다.\n의식은 보름달에 열린다.\n마지막 줄."

    out, n = replace_once(body, "북쪽 숲", "남쪽 호수")
    check("one occurrence is replaced in place", out == body.replace("북쪽 숲", "남쪽 호수") and n == 1)
    check("the rest of the body is untouched", out.startswith("첫 줄입니다.\n") and out.endswith("\n마지막 줄."))

    expect_error("an empty find is refused", lambda: replace_once(body, "", "x"), "비어")
    expect_error("a missing snippet is refused with a hint", lambda: replace_once(body, "성소는 북쪽 숲에있다.", "x"), "비슷한 줄")
    expect_error("two occurrences are ambiguous", lambda: replace_once("a b a", "a", "c"), "2곳")

    out, n = replace_once("a b a", "a", "c", replace_all=True)
    check("replace_all takes every occurrence", out == "c b c" and n == 2, out)

    out, n = replace_once(body, "의식은 보름달에 열린다.\n", "")
    check("a line can be deleted by replacing with nothing", "의식" not in out and out.count("\n") == 2)

    if FAILURES:
        print(f"\nFAIL - {len(FAILURES)} check(s)")
        return 1
    print("\nALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
