"""charx 파일을 읽기 좋은 폴더로 푼다. 사용자가 올린 카드를 조사할 때 쓴다.

run_python 안에서 이렇게 부른다 (별도 프로세스를 띄울 수 없으므로 exec 한다):

    import risuelf, os
    ns = {}
    exec(open("skills/charx_unpack.py", encoding="utf-8").read(), ns)
    out = risuelf.scratch("card")
    ns["decode"](os.path.join(risuelf.UPLOADS, "카드.charx"), out)
    print(open(os.path.join(out, "card.md"), encoding="utf-8").read()[:2000])

푼 결과는 scratch/ 에 두고 필요한 부분만 읽어라. 카드 하나가 수십 MB일 수 있다.

원본: vepo-bot charx 스킬. decode 전용으로 줄이고 rpack 맵을 내장했다.

출력 구조:
    출력폴더/
        card.md             # 텍스트 필드 (description, first_mes 등)
        card_meta.json      # 구조적 메타데이터 (extensions, book settings 등)
        backgroundHTML.md   # CSS/HTML (risuai.backgroundHTML → 평문)
        lorebook/           # 로어북 항목 (.md, frontmatter + content)
        triggers.lua        # Lua 코드
        regex.md            # Regex 스크립트
        module.md           # 모듈 메타데이터
        assets/             # 이미지 등 에셋 원본
        x_meta/             # 에셋 메타데이터
"""

import base64
import zipfile
import json
import struct
import sys
import os
import re
import copy
import shutil
from pathlib import Path

try:
    SCRIPT_DIR = Path(__file__).parent
except NameError:
    # exec'd from a string by the runner, which is the normal path here.
    SCRIPT_DIR = Path.cwd()

DEFAULTS = {
    'constant': False, 'selective': False, 'case_sensitive': False,
    'use_regex': False, 'mode': 'normal', 'enabled': True,
    'insertion_order': 100,
}

CARD_TEXT_FIELDS = [
    'description', 'first_mes', 'personality', 'scenario',
    'system_prompt', 'post_history_instructions', 'mes_example', 'creator_notes',
]
CARD_FM_FIELDS = ['name', 'creator', 'character_version']


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name)
    name = name.strip('. ')
    return name or '_'


# The permutation table is inlined rather than shipped as a sidecar file: a
# skill script is copied into the workspace on its own, and a missing companion
# file would fail at the moment it is finally needed.
_RPACK_B64 = "xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0BaXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy807FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA="


def load_rpack_map():
    return base64.b64decode(_RPACK_B64)[256:512]


def rpack_decode(data: bytes, decode_map: bytes) -> bytes:
    return bytes([decode_map[b] for b in data])


def decode_risum(risum_bytes: bytes) -> dict | None:
    if len(risum_bytes) < 6:
        return None
    decode_map = load_rpack_map()
    pos = 0
    if risum_bytes[pos] != 111 or risum_bytes[pos + 1] != 0:
        return None
    pos = 2
    main_len = struct.unpack_from('<I', risum_bytes, pos)[0]; pos += 4
    main_data = rpack_decode(risum_bytes[pos:pos + main_len], decode_map)
    main_json = json.loads(main_data.decode('utf-8'))
    if main_json.get('type') != 'risuModule':
        return None
    return main_json.get('module', {})


def internal_entry_to_v3(entry: dict) -> dict:
    key_str = entry.get('key', '')
    secondkey_str = entry.get('secondkey', '')
    ext = dict(entry.get('extentions', {}))
    case_sensitive = ext.pop('risu_case_sensitive', False) if isinstance(ext, dict) else False
    return {
        'keys': [k.strip() for k in key_str.split(',') if k.strip()] or [''],
        'secondary_keys': [k.strip() for k in secondkey_str.split(',') if k.strip()] if secondkey_str else [],
        'content': entry.get('content', ''),
        'extensions': ext,
        'enabled': True,
        'insertion_order': entry.get('insertorder', 100),
        'constant': entry.get('alwaysActive', False),
        'selective': entry.get('selective', False),
        'name': entry.get('comment', ''),
        'comment': entry.get('comment', ''),
        'case_sensitive': case_sensitive,
        'use_regex': entry.get('useRegex', False),
        'mode': entry.get('mode', 'normal'),
        'folder': entry.get('folder'),
    }


def v3_entry_to_md(entry: dict, safe_filename: str = '') -> str:
    lines = ['---']
    keys_list = entry.get('keys', [''])
    keys_list = [k.replace('', '') for k in keys_list]
    keys_str = ', '.join(keys_list)
    lines.append(f'keys: {keys_str}')

    comment = entry.get('comment', '')
    if comment and comment != safe_filename:
        lines.append(f'comment: {comment}')

    secondary = entry.get('secondary_keys', [])
    if secondary:
        lines.append(f'secondary_keys: {", ".join(secondary)}')

    order = entry.get('insertion_order', 100)
    if order != DEFAULTS['insertion_order']:
        lines.append(f'insertion_order: {order}')

    for field in ['constant', 'selective', 'case_sensitive', 'use_regex']:
        val = entry.get(field, DEFAULTS[field])
        if val != DEFAULTS[field]:
            lines.append(f'{field}: {str(val).lower()}')

    mode = entry.get('mode', 'normal')
    if mode != 'normal':
        lines.append(f'mode: {mode}')

    enabled = entry.get('enabled', True)
    if not enabled:
        lines.append('enabled: false')

    folder = entry.get('folder')
    if folder:
        folder = folder.replace('', '')
        lines.append(f'folder: {folder}')

    lines.append('---')
    lines.append(entry.get('content', ''))
    return '\n'.join(lines)


def card_to_md_and_meta(card_raw: dict) -> tuple[str, dict]:
    """Split card JSON into card.md (text) + card_meta (structural)."""
    data = card_raw['data']

    # --- Build card.md ---
    fm_lines = ['---']
    for f in CARD_FM_FIELDS:
        fm_lines.append(f'{f}: {data.get(f, "")}')
    fm_lines.append('---')
    header = '\n'.join(fm_lines)

    sections = []
    for f in CARD_TEXT_FIELDS:
        val = data.get(f, '')
        if val:
            sections.append(f'=== {f} ===\n{val}')
        else:
            sections.append(f'=== {f} ===')

    for i, g in enumerate(data.get('alternate_greetings', [])):
        if g:
            sections.append(f'=== alternate_greetings[{i}] ===\n{g}')
        else:
            sections.append(f'=== alternate_greetings[{i}] ===')

    risuai = data.get('extensions', {}).get('risuai', {})
    dv = risuai.get('defaultVariables', '')
    if dv:
        sections.append(f'=== defaultVariables ===\n{dv}')
    else:
        sections.append(f'=== defaultVariables ===')

    md_content = header + '\n\n' + '\n\n'.join(sections) + '\n'

    # --- Build card_meta (structural only) ---
    meta = copy.deepcopy(card_raw)
    md = meta['data']
    for f in CARD_TEXT_FIELDS + CARD_FM_FIELDS + ['alternate_greetings']:
        md.pop(f, None)
    meta_risuai = md.get('extensions', {}).get('risuai', {})
    meta_risuai.pop('defaultVariables', None)

    return md_content, meta


def regex_to_md(regex_list: list) -> str:
    """Convert regex array to .md format with === sections ===."""
    if not regex_list:
        return ''
    sections = []
    for entry in regex_list:
        comment = entry.get('comment', 'Untitled')
        lines = [f'=== {comment} ===']
        lines.append(f'type: {entry.get("type", "")}')
        lines.append(f'in: {entry.get("in", "")}')
        lines.append(f'out: {entry.get("out", "")}')
        if entry.get('flag'):
            lines.append(f'flag: {entry["flag"]}')
        if not entry.get('ableFlag', True):
            lines.append('ableFlag: false')
        sections.append('\n'.join(lines))
    return '\n\n'.join(sections) + '\n'


def module_to_md(module_meta: dict) -> str:
    """Convert module metadata to .md frontmatter."""
    lines = ['---']
    for k in ['name', 'description', 'id']:
        if k in module_meta:
            lines.append(f'{k}: {module_meta[k]}')
    for k, v in module_meta.items():
        if k not in ('name', 'description', 'id'):
            lines.append(f'{k}: {json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v}')
    lines.append('---')
    return '\n'.join(lines) + '\n'


def decode(charx_path: str, output_dir: str | None = None):
    charx_path = Path(charx_path).resolve()
    if not charx_path.exists():
        print(f"Error: {charx_path} not found"); sys.exit(1)

    if output_dir is None:
        output_dir = charx_path.with_suffix('')
    else:
        output_dir = Path(output_dir).resolve()

    if output_dir.exists():
        # No prompt: the runner has no stdin, so asking would hang rather than
        # ask. The caller chose the destination; overwriting it is what they
        # meant, and everything here lives under scratch/ anyway.
        print(f"replacing {output_dir}")
        shutil.rmtree(output_dir)

    output_dir.mkdir(parents=True)

    with zipfile.ZipFile(charx_path, 'r') as z:
        card_raw = json.loads(z.read('card.json'))
        card_data = card_raw['data']

        # Decode module.risum
        module = None
        if 'module.risum' in z.namelist():
            module = decode_risum(z.read('module.risum'))

        # Determine lorebook source
        character_book = card_data.get('character_book', {})
        card_entries = character_book.get('entries', [])
        if card_entries:
            entries = card_entries
        elif module and module.get('lorebook'):
            entries = [internal_entry_to_v3(e) for e in module['lorebook']]
            print(f"  lorebook: using module source")
        else:
            entries = []

        # Write lorebook as .md files
        lorebook_dir = output_dir / 'lorebook'
        lorebook_dir.mkdir()
        for i, entry in enumerate(entries):
            name = entry.get('comment') or entry.get('name') or f'entry_{i}'
            safe_name = sanitize_filename(name)
            filename = f'{i:02d}_{safe_name}.md'
            md_content = v3_entry_to_md(entry, safe_name)
            (lorebook_dir / filename).write_text(md_content, encoding='utf-8')
        print(f"  lorebook: {len(entries)} entries → .md")

        # Extract module components
        if module:
            for trigger in module.get('trigger', []):
                for effect in trigger.get('effect', []):
                    if effect.get('type') == 'triggerlua' and effect.get('code'):
                        (output_dir / 'triggers.lua').write_text(effect['code'], encoding='utf-8')
                        print(f"  triggers.lua: {len(effect['code']):,} chars")
                        break

            regex_list = module.get('regex', [])
            if regex_list:
                regex_md = regex_to_md(regex_list)
                (output_dir / 'regex.md').write_text(regex_md, encoding='utf-8')
                print(f"  regex.md: {len(regex_list)} scripts")

            meta = {k: v for k, v in module.items()
                    if k not in ('trigger', 'regex', 'lorebook', 'assets')}
            module_md = module_to_md(meta)
            (output_dir / 'module.md').write_text(module_md, encoding='utf-8')
            print(f"  module.md written")

        # Write card.md + card_meta.json
        card_md, card_meta = card_to_md_and_meta(card_raw)

        # Extract backgroundHTML to separate file
        risuai_ext = card_meta.get('data', {}).get('extensions', {}).get('risuai', {})
        bg_html = risuai_ext.get('backgroundHTML', '')
        if bg_html:
            (output_dir / 'backgroundHTML.md').write_text(bg_html, encoding='utf-8')
            risuai_ext['backgroundHTML'] = ''
            print(f"  backgroundHTML.md: {len(bg_html):,} chars")

        (output_dir / 'card.md').write_text(card_md, encoding='utf-8')
        (output_dir / 'card_meta.json').write_text(
            json.dumps(card_meta, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"  card.md + card_meta.json written")

        # Extract assets
        skip_files = {'card.json', 'module.risum'}
        extracted = 0
        for info in z.infolist():
            if info.filename in skip_files:
                continue
            target = output_dir / info.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            if not info.is_dir():
                target.write_bytes(z.read(info.filename))
                extracted += 1
        print(f"  assets/meta: {extracted} files")

    print(f"\nDone → {output_dir}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python charx_decode.py <input.charx> [output_dir]"); sys.exit(1)
    decode(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
