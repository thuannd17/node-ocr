# RosterParser web app (Node + the small Python runtime of the learned roster model).
# The PaddleOCR server is a separate image (docker/ocr.Dockerfile): see docker-compose.yml.
#
#   docker build -t roster-ocr-app .
#
# The roster data is not here: it lives in MinIO (MINIO_* settings; src/services/storage/ is the code that reads it);
# the app keeps its mirror of it, of the trained AI models (also in MinIO) and its caches in
# ROSTER_WORK_DIR (/work, a volume shared with the OCR server). See docker-compose.yml.

FROM node:20.18.1-bookworm-slim

# Python 3.11 for src/scripts/pdf_tagger_predict.py (reading) and train_pdf_tagger.py (Train on /models).
# src/services/pdf-ai-extract.js looks for it at .venv/bin/python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY docker/requirements-app.txt docker/requirements-app.txt
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir -r docker/requirements-app.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    OCR_SERVER_URL=http://ocr:8501 \
    ROSTER_WORK_DIR=/work

# The code stays root-owned (read-only for the app); the app writes only to /work.
RUN mkdir -p /work \
 && chown node:node /work
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/openapi.json').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/index.js"]
