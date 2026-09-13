"""Build an application-only staging update; no runtime data or interpreter."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
version = json.loads((ROOT / "plugin/package.json").read_text(encoding="utf-8"))["version"]
plugin = ROOT / f"plugin/dist/risu-hina-{version}.js"
files = [(p, p.relative_to(ROOT).as_posix()) for p in sorted((ROOT / "pyserver/app").rglob("*"))
         if p.is_file() and "__pycache__" not in p.parts and p.suffix not in (".pyc", ".log", ".db")]
files.append((plugin, "plugin/" + plugin.name))
output = ROOT / ".cache" / f"staging-{version}.zip"
output.parent.mkdir(exist_ok=True)
manifest = {"version": version, "files": []}
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for source, target in files:
        data = source.read_bytes()
        archive.writestr(target, data)
        manifest["files"].append({"path": target, "sha256": hashlib.sha256(data).hexdigest()})
    archive.writestr("staging-manifest.json", json.dumps(manifest, indent=2))
print(json.dumps({"path": str(output), "files": len(files), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))
