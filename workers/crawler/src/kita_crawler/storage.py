from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Protocol

import boto3

from .config import Settings


class ArtifactStore(Protocol):
    async def put(self, key: str, body: bytes, content_type: str) -> str: ...
    async def get(self, key: str) -> bytes: ...


class LocalArtifactStore:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, key: str) -> Path:
        target = (self.root / key).resolve()
        if not target.is_relative_to(self.root.resolve()):
            raise ValueError("Artifact key escapes the configured root")
        return target

    async def put(self, key: str, body: bytes, content_type: str) -> str:
        target = self._path(key)
        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(target.write_bytes, body)
        return key

    async def get(self, key: str) -> bytes:
        return await asyncio.to_thread(self._path(key).read_bytes)


class R2ArtifactStore:
    def __init__(self, settings: Settings):
        self.bucket = settings.r2_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint_url,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name="auto",
        )

    async def put(self, key: str, body: bytes, content_type: str) -> str:
        await asyncio.to_thread(self.client.put_object, Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)
        return key

    async def get(self, key: str) -> bytes:
        response = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=key)
        return await asyncio.to_thread(response["Body"].read)


def create_artifact_store(settings: Settings) -> ArtifactStore:
    if settings.artifact_mode == "r2":
        if not all((settings.r2_endpoint_url, settings.r2_access_key_id, settings.r2_secret_access_key)):
            raise RuntimeError("R2 mode requires R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY")
        return R2ArtifactStore(settings)
    return LocalArtifactStore(settings.artifact_root)

