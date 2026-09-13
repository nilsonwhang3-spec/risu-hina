"""Concrete AI batch settings for one-time user review, before any JOB exists."""
from __future__ import annotations

import copy
import json
from collections import Counter

from . import nai, studio


def prepare(specs: list[dict]) -> tuple[list[tuple[dict, list[dict]]], str, int]:
    prepared, reviews = [], []
    total = 0
    for raw in specs:
        if not ("styles" in raw or raw.get("style")) or "characters" not in raw:
            raise studio.StudioError("AI 생성은 styles와 characters를 명시해야 합니다. 사용자 지정 카드를 확인하세요. 생략해 현재 활성 카드를 대신 사용하지 마세요. 사용하지 않으면 []를 명시하세요.")
        spec = studio.normalize_spec(copy.deepcopy(raw))
        for entry in spec.get("entries") or []:
            if any(k in entry for k in ("styles", "style", "model", "params")):
                raise studio.StudioError("entries 안의 스타일·모델·파라미터 변경은 지원하지 않습니다. 해당 설정을 가진 별도 배치로 나눠 주세요.")
        spec["folder"] = studio.output_folder(spec)
        spec["model"] = str(spec.get("model") or nai.DEFAULT_MODEL)
        spec["params"] = {**nai.DEFAULTS, **(spec.get("params") or {})}
        items = studio.plan(spec)
        if not items:
            raise studio.StudioError("만들 이미지가 없습니다")
        missing = sorted({r for item in items for r in item.get("unresolved", [])})
        if missing:
            raise studio.StudioError("해결되지 않은 조각태그를 먼저 확인하세요: " + ", ".join(missing))
        # Include every effective entry's settings, including overrides, so an
        # array or mixed-character job cannot hide behind its first spec.
        groups = []
        entries = spec.get("entries") or [None]
        for ix, entry in enumerate(entries):
            overrides = entry or {}
            effective = studio.normalize_spec({**spec,
                "characters": overrides.get("characters") if overrides.get("characters") is not None else spec["characters"],
                "scenePreset": overrides.get("scenePreset") or spec.get("scenePreset")})
            subset = [i for i in items if i.get("entryIx", 0) == ix]
            if not subset:
                continue
            characters = effective["characters"]
            references = studio.refs_for_characters([c for c in characters if isinstance(c, str)])
            refs = {"vibes": copy.deepcopy(spec.get("vibes") or references[0]),
                    "charrefs": copy.deepcopy(spec.get("charrefs") or references[1])}
            for item in subset:
                item["referenceSpecs"] = refs
            groups.append({
                "스타일": effective["styles"], "캐릭터": characters,
                "감정/장면 프리셋": effective.get("scenePreset") or ("인라인 장면" if effective.get("scenes") or (entry or {}).get("scene") else "없음"),
                "장면별 생성 수": dict(Counter(str(i.get("scene") or "기본") for i in subset)),
                "시드": list(dict.fromkeys(i.get("seed") for i in subset)),
                "해상도": list(dict.fromkeys(f"{(i.get('size') or {}).get('width', (effective.get('params') or {}).get('width', 832))}×{(i.get('size') or {}).get('height', (effective.get('params') or {}).get('height', 1216))}" for i in subset)),
                "저장 폴더": sorted({i["folder"] for i in subset}),
                "레퍼런스": {kind: [{k: ("첨부 이미지" if k == "image" else v) for k, v in ref.items()} for ref in values] for kind, values in refs.items()},
            })
        estimate_spec = {**spec, **{kind: list({json.dumps(r, sort_keys=True): r
                         for i in items for r in i["referenceSpecs"][kind]}.values())
                         for kind in ("vibes", "charrefs")}}
        reviews.append({"배치": len(reviews) + 1, "총 이미지": len(items), "모델": spec["model"],
                        "설정": groups, "생성 파라미터": spec.get("params") or {},
                        "시드": spec.get("seed", "랜덤"), "예상 비용": studio.estimate(estimate_spec, len(items))["note"]})
        prepared.append((spec, items))
        total += len(items)
    detail = json.dumps(reviews, ensure_ascii=False, indent=2)
    if len(detail) > 60000:
        raise studio.StudioError("확인할 설정이 너무 많습니다. 배치를 나눠 계획해 주세요.")
    return prepared, detail, total
