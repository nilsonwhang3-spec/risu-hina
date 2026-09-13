"""Prepare and atomically approve name-only card edits, without uploading images."""
import re
import hashlib
from collections import defaultdict
from . import card, db


def plan(ck: str, find: str, replace: str, *, regex: bool = False,
         name_filter: str = '', field: str = 'additional', allow_merge: bool = False) -> dict:
    if not find:
        raise ValueError('find가 비어 있습니다. 바꿀 문자열 또는 정규식을 지정하세요.')
    if field not in ('additional', 'emotion', 'cc', 'all'):
        raise ValueError('field: additional, emotion, cc, all')
    try:
        pattern = re.compile(find) if regex else None
        selector = re.compile(name_filter) if name_filter else None
    except re.error as e:
        raise ValueError(f'정규식 오류: {e}') from e
    rows = card.scripts(ck, 'assetref')
    items, groups = [], defaultdict(set)
    for row in rows:
        entry = row['entry']
        before = str(entry.get('name') or '')
        after = before
        if (field == 'all' or entry.get('field') == field) and (selector is None or selector.search(before)):
            try:
                after = pattern.sub(replace, before) if pattern else before.replace(find, replace)
            except re.error as e:
                raise ValueError(f'치환식 오류: {e}') from e
        if after != before:
            if row.get('conflict'):
                raise ValueError('충돌 중인 에셋이 있습니다. 충돌을 먼저 정리하세요.')
            if not after.strip() or any(ord(c) < 32 for c in after):
                raise ValueError('이름이 비거나 제어 문자를 포함하게 됩니다.')
            items.append({'id': row['id'], 'before': entry, 'after': after})
        groups[(entry.get('field'), after)].add(before)
    collisions = [{'field': f, 'name': n, 'sources': sorted(s)} for (f, n), s in groups.items() if len(s) > 1]
    if len(items) > 5000:
        raise ValueError('한 제안은 5000개까지 가능합니다. name_filter로 나누세요.')
    revision = hashlib.sha256(db.js([(r['id'], r['entry']) for r in rows]).encode()).hexdigest()
    return {'items': items, 'revision': revision, 'changed': len(items), 'collisions': collisions[:20], 'collisionCount': len(collisions),
            'blocked': bool(collisions and not allow_merge), 'allowMerge': allow_merge,
            'preview': [{'before': i['before']['name'], 'after': i['after']} for i in items[:20]]}


def apply(ck: str, items: list[dict], revision: str = '') -> int:
    if not items or len(items) > 5000 or len({i['id'] for i in items}) != len(items):
        raise ValueError('잘못된 이름 변경 계획입니다.')
    with db.transaction():
        # Validate every frozen entry before editing anything. Never replay a rule on changed rows.
        current = {r['id']: r for r in card.scripts(ck, 'assetref')}
        if revision and hashlib.sha256(db.js([(r['id'], r['entry']) for r in current.values()]).encode()).hexdigest() != revision:
            raise ValueError('미리보기 이후 에셋 목록이 바뀌었습니다. 이름 변경을 다시 미리보기 하세요.')
        for item in items:
            row = current.get(item['id'])
            if row is None or row['entry'] != item['before'] or row.get('conflict'):
                raise ValueError('미리보기 이후 에셋이 바뀌었습니다. 이름 변경을 다시 미리보기 하세요.')
        for item in items:
            card.update_script(item['id'], {**item['before'], 'name': item['after']})
    return len(items)
