# ---- front-end build: bundle, hash and precompress the web app
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /src
RUN npm install --no-save --no-audit --no-fund esbuild@0.28.2
COPY tools/build_frontend.mjs tools/
COPY mammatus/static mammatus/static
ARG MAMMATUS_BUILD=docker
RUN cd tools && ln -s ../node_modules node_modules && MAMMATUS_BUILD=$MAMMATUS_BUILD node build_frontend.mjs

# ---- runtime
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MAMMATUS_DATA_DIR=/data MAMMATUS_PORT=8080 PUID=99 PGID=100 TZ=America/New_York
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt && python -c "import eccodes; print('ecCodes', eccodes.codes_get_api_version())"
COPY mammatus mammatus
RUN rm -rf mammatus/static-dist
COPY --from=web /src/mammatus/static-dist mammatus/static-dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN python -m compileall -q mammatus
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"MAMMATUS_PORT\",\"8080\")}/healthz',timeout=4)" || exit 1
LABEL org.opencontainers.image.title="Mammatus" \
      org.opencontainers.image.description="Self-hosted weather model viewer: HRRR, RRFS, GFS, ECMWF and AIFS on a living globe, with radar, satellite, meteograms, soundings and push alerts." \
      org.opencontainers.image.source="https://github.com/au12/Mammatus" \
      org.opencontainers.image.licenses="MIT"
ENTRYPOINT ["/entrypoint.sh"]
