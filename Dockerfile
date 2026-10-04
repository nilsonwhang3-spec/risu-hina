FROM python:3.11-slim-bookworm

ARG TARGETARCH
WORKDIR /app/pyserver

# This lock contains the project's hashed CPython 3.11 Linux x86_64 wheels.
COPY pyserver/locks/linux-x86_64-cp311.txt /tmp/requirements.lock
RUN test "$TARGETARCH" = "amd64" || (echo "This image currently supports linux/amd64 only." >&2; exit 1)
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/requirements.lock

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
