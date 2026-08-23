"""Entrypoint. `python -m app` and `python run.py` both land here."""
from __future__ import annotations

import sys

import uvicorn

from app import config


def main() -> int:
    config.load()
    token = config.ensure_token()
    print(f"{config.APP_NAME} {config.VERSION}")
    print(f"  listening   http://{config.HOST}:{config.PORT}")
    print(f"  data        {config.DATA_DIR}")
    print(f"  token       {token}")
    if not config.is_loopback(config.HOST) and config.HOST not in ("", "127.0.0.1"):
        # Non-loopback binding hands `run_python` to anyone holding the token,
        # so say so at the moment it happens rather than only in the docs.
        print("  WARNING     비루프백 바인딩 — 토큰이 곧 이 머신의 임의 코드 실행 권한이다.")
        print("              사설망(Tailscale 등) 안으로만 노출할 것.")
    uvicorn.run(
        "app.main:app",
        host=config.HOST,
        port=config.PORT,
        log_level="warning",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
