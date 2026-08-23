"""chatfmt round-trip tests. Stdlib only - runs under the bundled interpreter.

    python tests/test_roundtrip.py

The fixture is shaped from the real 394-turn chat Phase 0 read, including the
fields that are not in RisuAI's `Chat` interface. Those are the ones a
whitelist-based implementation would silently drop.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pyserver"))

from app import chatfmt  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def real_shaped_chat() -> dict:
    """Mirrors the key set Phase 0 observed on a live chat (docs/01 section 3)."""
    return {
        "type": "risuChat",
        "ver": 2,
        "folders": [],
        "data": {
            "name": "Parma Knights",
            "note": "",
            "localLore": [{"key": ["knight"], "content": "lore body"}],
            "fmIndex": 0,
            "id": "9736456b-11ec-4bb5-9339-2407e5150042",
            # --- not in the documented Chat interface ---
            "useModelPreset": True,
            "modelBinding": {"provider": "x", "model": "y"},
            "bindedBotPreset": "preset-1",
            "bindedPersona": "persona-1",
            "savedToggleValues": {"toggle-a": "1"},
            "activeStreamingDisplayOptimizationMode": "auto",
            "arKey": "ar-9f2c",          # another plugin's identity stamp
            "supaMemory": "",
            "scriptstate": {"var": 3},
            "modules": ["mod-1"],
            "isStreaming": False,
            "hypaV3Data": {"summaries": [{"text": "s1", "chatMemos": ["m-1"]}]},
            "message": [
                {"role": "user", "data": "안녕", "time": 1778892822492, "chatId": "m-0"},
                {
                    "role": "char",
                    "data": "여러 줄\n\n본문이다.",
                    "time": 1778892823000,
                    "chatId": "m-1",
                    "generationInfo": {"model": "gpt", "inputTokens": 120, "outputTokens": 30},
                    "promptInfo": {"promptName": "p"},
                },
                {
                    "role": "user",
                    "data": "",                      # empty body is legal
                    "time": 1778892824000,
                    "chatId": "m-2",
                    "disabled": True,
                },
                {
                    "role": "char",
                    "data": "말풍선",
                    "time": 1778892825000,
                    "chatId": "m-3",
                    "saying": "char-uuid",
                    "isComment": False,
                    "name": "Aldo",
                },
            ],
        },
    }


def test_lossless_roundtrip() -> None:
    print("test_lossless_roundtrip")
    src = real_shaped_chat()
    doc = chatfmt.decode(src)
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    diffs = chatfmt.roundtrip_diff(src, back)
    check("zero field-level diffs", not diffs, "; ".join(diffs[:6]))


def test_unknown_chat_fields_survive() -> None:
    print("test_unknown_chat_fields_survive")
    src = real_shaped_chat()
    src["data"]["someFutureFieldNobodyKnows"] = {"deep": [1, 2, {"x": None}]}
    doc = chatfmt.decode(src)
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    check("unknown chat field preserved",
          back["data"].get("someFutureFieldNobodyKnows") == {"deep": [1, 2, {"x": None}]})
    check("another plugin's arKey preserved", back["data"].get("arKey") == "ar-9f2c")
    check("folders preserved", back.get("folders") == [])


def test_per_message_extras_survive() -> None:
    print("test_per_message_extras_survive")
    src = real_shaped_chat()
    doc = chatfmt.decode(src)
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    msgs = back["data"]["message"]
    check("generationInfo preserved", msgs[1].get("generationInfo", {}).get("inputTokens") == 120)
    check("promptInfo preserved", msgs[1].get("promptInfo", {}).get("promptName") == "p")
    check("disabled preserved", msgs[2].get("disabled") is True)
    check("saying preserved", msgs[3].get("saying") == "char-uuid")
    check("isComment preserved", msgs[3].get("isComment") is False)
    check("name preserved when present", msgs[3].get("name") == "Aldo")
    check("name absent when originally absent", "name" not in msgs[0])


def test_chatid_is_the_join_key() -> None:
    print("test_chatid_is_the_join_key")
    src = real_shaped_chat()
    doc = chatfmt.decode(src)
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    ids = [m["chatId"] for m in back["data"]["message"]]
    check("chatIds intact and ordered", ids == ["m-0", "m-1", "m-2", "m-3"], str(ids))
    memo = src["data"]["hypaV3Data"]["summaries"][0]["chatMemos"][0]
    check("hypa chatMemo still resolves", memo in ids)


def test_edit_touches_only_that_message() -> None:
    print("test_edit_touches_only_that_message")
    src = real_shaped_chat()
    doc = chatfmt.decode(src)
    edited = doc["markdown"].replace("여러 줄\n\n본문이다.", "고쳐 쓴 본문")
    check("edit anchor was found", edited != doc["markdown"])
    back = chatfmt.encode(edited, doc["meta"])
    diffs = chatfmt.roundtrip_diff(src, back)
    check("exactly one field differs", diffs == ["message[1].data: changed"], "; ".join(diffs))
    check("edited body is exact", back["data"]["message"][1]["data"] == "고쳐 쓴 본문")
    check("its metadata survived the edit",
          back["data"]["message"][1].get("generationInfo", {}).get("model") == "gpt")


def test_hostile_bodies() -> None:
    """A message that talks about the delimiter format must not break parsing.

    The agent will be reading and writing this file, so a body quoting the
    markers is not hypothetical.
    """
    print("test_hostile_bodies")
    src = real_shaped_chat()
    src["data"]["message"][0]["data"] = (
        "구분자를 본문에서 언급한다: <!--[MSG:99|role:user|time:1|chatId:x|name:]-->\n"
        "그리고 닫는 것도: <!--[/MSG:99]-->\n"
        "파이프 | 와 백슬래시 \\ 도 섞는다."
    )
    original_body = src["data"]["message"][0]["data"]
    doc = chatfmt.decode(src)
    check("delimiter text is escaped in the document",
          "<!--\\[MSG:99" in doc["markdown"])
    check("no phantom message appears", chatfmt.message_count(doc["markdown"]) == 4,
          f"count={chatfmt.message_count(doc['markdown'])}")
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    msgs = back["data"]["message"]
    check("message count unchanged", len(msgs) == 4, f"count={len(msgs)}")
    check("hostile body round-trips byte-exact", msgs[0]["data"] == original_body,
          repr(msgs[0]["data"][:60]))
    check("no warnings for a well-formed document", chatfmt.verify(doc["markdown"], doc["meta"]) == [])


def test_escape_is_reversible_for_preexisting_backslashes() -> None:
    """A body that already contains the escaped form must not drift."""
    print("test_escape_is_reversible_for_preexisting_backslashes")
    for body in (
        "<!--[MSG:1|a]-->",
        "<!--\\[MSG:1|a]-->",
        "<!--\\\\[MSG:1|a]-->",
        "plain <!--[ bracket comment",
        "no delimiters at all",
    ):
        src = real_shaped_chat()
        src["data"]["message"][0]["data"] = body
        doc = chatfmt.decode(src)
        back = chatfmt.encode(doc["markdown"], doc["meta"])
        got = back["data"]["message"][0]["data"]
        check(f"round-trips {body[:24]!r}", got == body, repr(got))


def test_verify_flags_real_damage() -> None:
    print("test_verify_flags_real_damage")
    src = real_shaped_chat()
    doc = chatfmt.decode(src)

    halved = doc["markdown"].split("<!--[MSG:2|")[0]
    w = chatfmt.verify(halved, doc["meta"])
    check("count change is reported", any("메시지 수" in x for x in w), str(w))

    duped = doc["markdown"].replace("chatId:m-1|", "chatId:m-0|")
    w = chatfmt.verify(duped, doc["meta"])
    check("duplicate chatId is reported", any("중복" in x for x in w), str(w))

    blanked = doc["markdown"].replace("chatId:m-1|", "chatId:|")
    w = chatfmt.verify(blanked, doc["meta"])
    check("blank chatId is reported", any("빈 메시지" in x for x in w), str(w))


def test_delimiter_hostile_ids() -> None:
    print("test_delimiter_hostile_ids")
    src = real_shaped_chat()
    src["data"]["message"][0]["chatId"] = "weird|id]with\\stuff"
    src["data"]["message"][0]["name"] = "a|b]c"
    doc = chatfmt.decode(src)
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    m0 = back["data"]["message"][0]
    check("pipe/bracket/backslash in chatId survives", m0["chatId"] == "weird|id]with\\stuff", m0["chatId"])
    check("pipe/bracket in name survives", m0.get("name") == "a|b]c", str(m0.get("name")))


def web_risu_shaped_chat() -> dict:
    """A chat as stock web RisuAI writes it - only the documented Chat fields.

    `useModelPreset`, `modelBinding`, `bindedBotPreset`, `savedToggleValues` and
    `activeStreamingDisplayOptimizationMode` are PocketRisu additions and are
    absent here on purpose.
    """
    return {
        "type": "risuChat",
        "ver": 2,
        "data": {
            "name": "web chat",
            "note": "",
            "localLore": [],
            "fmIndex": -1,
            "id": "web-chat-uuid",
            "message": [
                {"role": "user", "data": "hi", "time": 1778892822492, "chatId": "w-0"},
                {"role": "char", "data": "hello", "time": 1778892823000, "chatId": "w-1"},
            ],
        },
    }


def test_never_invents_fields() -> None:
    """The preservation contract runs both ways.

    Preserving unknown fields is only half of it. Round-tripping a web-RisuAI
    chat must not *add* PocketRisu-only fields either - a chat that gained
    `modelBinding` or `useModelPreset` on its way through Risu Elf would
    silently change behaviour the next time it is opened in PocketRisu.
    """
    print("test_never_invents_fields")
    src = web_risu_shaped_chat()
    doc = chatfmt.decode(src)
    back = chatfmt.encode(doc["markdown"], doc["meta"])

    check("no field-level diffs", not chatfmt.roundtrip_diff(src, back))
    check("chat key set is identical",
          set(back["data"]) == set(src["data"]),
          f"added={sorted(set(back['data']) - set(src['data']))} "
          f"lost={sorted(set(src['data']) - set(back['data']))}")

    pocketrisu_only = {
        "useModelPreset", "modelBinding", "bindedBotPreset",
        "savedToggleValues", "activeStreamingDisplayOptimizationMode", "arKey",
    }
    leaked = pocketrisu_only & set(back["data"])
    check("no PocketRisu-only field invented", not leaked, str(sorted(leaked)))

    for i, m in enumerate(back["data"]["message"]):
        check(f"message[{i}] key set is identical",
              set(m) == set(src["data"]["message"][i]),
              f"got={sorted(m)}")

    check("envelope gained nothing", set(back) == set(src),
          f"added={sorted(set(back) - set(src))}")


def test_accepts_bare_chat_object() -> None:
    print("test_accepts_bare_chat_object")
    bare = real_shaped_chat()["data"]
    doc = chatfmt.decode(bare)
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    check("envelope synthesized", back["type"] == "risuChat" and back["ver"] == 2)
    check("message count kept", len(back["data"]["message"]) == 4)


def test_output_is_importable_shape() -> None:
    print("test_output_is_importable_shape")
    src = real_shaped_chat()
    doc = chatfmt.decode(src)
    back = chatfmt.encode(doc["markdown"], doc["meta"])
    raw = chatfmt.dumps(back)
    parsed = json.loads(raw)
    # RisuAI's importer branches on exactly these (characters.ts:435).
    check("type/ver match the stock importer",
          parsed.get("type") == "risuChat" and parsed.get("ver") == 2)
    check("data is an object with message[]",
          isinstance(parsed.get("data"), dict) and isinstance(parsed["data"].get("message"), list))
    check("korean is not escaped", "안녕" in raw)


def test_message_count_helper() -> None:
    print("test_message_count_helper")
    doc = chatfmt.decode(real_shaped_chat())
    check("counts delimiters", chatfmt.message_count(doc["markdown"]) == 4)


def main() -> int:
    for fn in (
        test_lossless_roundtrip,
        test_unknown_chat_fields_survive,
        test_per_message_extras_survive,
        test_chatid_is_the_join_key,
        test_edit_touches_only_that_message,
        test_hostile_bodies,
        test_escape_is_reversible_for_preexisting_backslashes,
        test_verify_flags_real_damage,
        test_delimiter_hostile_ids,
        test_never_invents_fields,
        test_accepts_bare_chat_object,
        test_output_is_importable_shape,
        test_message_count_helper,
    ):
        fn()
    print()
    if FAILURES:
        print(f"FAIL - {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASS - all checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
