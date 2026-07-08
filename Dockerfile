FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHON_BIN=/opt/venv/bin/python \
    ARXIV_PDF_DIR=/data/arxiv_pdfs \
    ARXIV_TEXT_DIR=/data/arxiv_text

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY package*.json ./
RUN npm ci --omit=dev \
    && node --input-type=module -e "import 'pg'" \
    && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node server ./server
COPY --chown=node:node worker ./worker
COPY --from=frontend-build --chown=node:node /app/dist ./dist

RUN mkdir -p /data /app/data \
    && chown -R node:node /data /app

USER node

EXPOSE 3000
VOLUME ["/data"]

CMD ["sh", "-c", "python -m worker.cli init-db && exec node server.js"]
