FROM python:3.11-slim-bookworm

ARG TARGETARCH
WORKDIR /app/pyserver

# Compiled wheel hashes are specific to the target CPU architecture.
COPY pyserver/locks/linux-*-cp311.txt /tmp/locks/
RUN case "$TARGETARCH" in \
        amd64) lockfile=linux-x86_64-cp311.txt ;; \
        arm64) lockfile=linux-aarch64-cp311.txt ;; \
        *) echo "Unsupported architecture: $TARGETARCH (expected amd64 or arm64)." >&2; exit 1 ;; \
    esac \
    && python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r "/tmp/locks/$lockfile"

RUN groupadd --gid 10001 risuhina \
    && useradd --uid 10001 --gid risuhina --home-dir /data --create-home --no-log-init risuhina

COPY pyserver/app ./app
COPY pyserver/run.py ./run.py
COPY plugin/Risu.Hina.Plugin.js /app/plugin/Risu.Hina.Plugin.js

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/data \
    XDG_CACHE_HOME=/data/.cache \
    RISUHINA_DATA_DIR=/data \
    RISUHINA_HOST=0.0.0.0 \
    RISUHINA_PORT=6020 \
    RISUHINA_DISABLE_SELF_UPDATE=1

USER 10001:10001
VOLUME ["/data"]
EXPOSE 6020
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import json, os, urllib.request; data = json.load(urllib.request.urlopen('http://127.0.0.1:' + os.environ['RISUHINA_PORT'] + '/health', timeout=3)); assert data.get('service') == 'risu-hina' and data.get('ok') is True"
CMD ["python", "run.py"]
