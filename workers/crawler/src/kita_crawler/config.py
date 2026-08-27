from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel


class Settings(BaseModel):
    database_url: str | None
    artifact_mode: str
    artifact_root: Path
    r2_endpoint_url: str | None
    r2_access_key_id: str | None
    r2_secret_access_key: str | None
    r2_bucket: str
    allow_private_network: bool
    worker_name: str
    worker_version: str
    user_agent: str


def load_settings() -> Settings:
    load_dotenv(".env.local", override=False)
    endpoint = os.getenv("R2_ENDPOINT_URL")
    key = os.getenv("R2_ACCESS_KEY_ID")
    secret = os.getenv("R2_SECRET_ACCESS_KEY")
    mode = os.getenv("CRAWLER_ARTIFACT_MODE") or ("r2" if endpoint and key and secret else "local")
    return Settings(
        database_url=os.getenv("DATABASE_URL_UNPOOLED") or os.getenv("DATABASE_URL"),
        artifact_mode=mode,
        artifact_root=Path(os.getenv("CRAWLER_ARTIFACT_ROOT", "var/crawler/artifacts")),
        r2_endpoint_url=endpoint,
        r2_access_key_id=key,
        r2_secret_access_key=secret,
        r2_bucket=os.getenv("R2_RAW_BUCKET", "kitacon-raw"),
        allow_private_network=os.getenv("CRAWLER_ALLOW_PRIVATE_NETWORK", "false").lower() == "true",
        worker_name=os.getenv("CRAWLER_WORKER_NAME", "kita-local-crawler"),
        worker_version=os.getenv("CRAWLER_WORKER_VERSION", "0.1.0"),
        user_agent=os.getenv("CRAWLER_USER_AGENT", "KitaConCrawler/0.1 (+https://kitacon.app/crawler-policy)"),
    )

