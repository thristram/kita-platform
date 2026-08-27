FROM python:3.13.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

WORKDIR /app
COPY workers/crawler/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --requirement /app/requirements.lock \
    && python -m playwright install --with-deps chromium

COPY workers/crawler /app/workers/crawler
RUN pip install --no-deps /app/workers/crawler \
    && useradd --create-home --uid 10001 crawler \
    && mkdir -p /var/lib/kitacon-crawler \
    && chown -R crawler:crawler /var/lib/kitacon-crawler

USER 10001
ENV CRAWLER_ARTIFACT_ROOT=/var/lib/kitacon-crawler
ENTRYPOINT ["crawler"]
CMD ["worker"]
