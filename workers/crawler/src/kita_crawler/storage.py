from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

import boto3

from .config import Settings


@dataclass(frozen=True)
class StoredObject:
    bucket: str
    key: str
    byte_size: int
    content_type: str
    etag: str | None = None
    last_modified: datetime | None = None


class ObjectStore(Protocol):
    bucket: str

    async def put_bytes(self, *, key: str, body: bytes, content_type: str, metadata: dict[str, str] | None = None) -> StoredObject: ...
    async def head(self, key: str) -> StoredObject | None: ...
    async def get_bytes(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...
    async def create_signed_get_url(self, key: str, ttl_seconds: int = 900) -> str: ...

    async def put(self, key: str, body: bytes, content_type: str) -> str: ...
    async def get(self, key: str) -> bytes: ...


class LocalObjectStore:
    def __init__(self, root: Path, bucket: str = "kita-raw"):
        self.root = root
        self.bucket = bucket

    def _path(self, key: str) -> Path:
        target = (self.root / key).resolve()
        if not target.is_relative_to(self.root.resolve()):
            raise ValueError("Artifact key escapes the configured root")
        return target

    async def put_bytes(self, *, key: str, body: bytes, content_type: str, metadata: dict[str, str] | None = None) -> StoredObject:
        target = self._path(key)
        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(target.write_bytes, body)
        return StoredObject(bucket=self.bucket, key=key, byte_size=len(body), content_type=content_type, last_modified=datetime.now(timezone.utc))

    async def head(self, key: str) -> StoredObject | None:
        target = self._path(key)
        if not await asyncio.to_thread(target.exists):
            return None
        stat = await asyncio.to_thread(target.stat)
        return StoredObject(bucket=self.bucket, key=key, byte_size=stat.st_size, content_type="application/octet-stream", last_modified=datetime.fromtimestamp(stat.st_mtime, timezone.utc))

    async def get_bytes(self, key: str) -> bytes:
        return await asyncio.to_thread(self._path(key).read_bytes)

    async def delete(self, key: str) -> None:
        target = self._path(key)
        if await asyncio.to_thread(target.exists):
            await asyncio.to_thread(target.unlink)

    async def create_signed_get_url(self, key: str, ttl_seconds: int = 900) -> str:
        del ttl_seconds
        return self._path(key).as_uri()

    async def put(self, key: str, body: bytes, content_type: str) -> str:
        return (await self.put_bytes(key=key, body=body, content_type=content_type)).key

    async def get(self, key: str) -> bytes:
        return await self.get_bytes(key)


class R2ObjectStore:
    def __init__(self, settings: Settings, *, bucket: str | None = None):
        self.bucket = bucket or settings.r2_raw_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint_url,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name="auto",
        )

    async def put_bytes(self, *, key: str, body: bytes, content_type: str, metadata: dict[str, str] | None = None) -> StoredObject:
        response = await asyncio.to_thread(self.client.put_object, Bucket=self.bucket, Key=key, Body=body, ContentType=content_type, Metadata=metadata or {})
        return StoredObject(bucket=self.bucket, key=key, byte_size=len(body), content_type=content_type, etag=str(response.get("ETag", "")).strip('"') or None)

    async def head(self, key: str) -> StoredObject | None:
        try:
            response = await asyncio.to_thread(self.client.head_object, Bucket=self.bucket, Key=key)
        except self.client.exceptions.ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return None
            raise
        return StoredObject(bucket=self.bucket, key=key, byte_size=int(response.get("ContentLength", 0)), content_type=response.get("ContentType", "application/octet-stream"), etag=str(response.get("ETag", "")).strip('"') or None, last_modified=response.get("LastModified"))

    async def get_bytes(self, key: str) -> bytes:
        response = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=key)
        return await asyncio.to_thread(response["Body"].read)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=key)

    async def create_signed_get_url(self, key: str, ttl_seconds: int = 900) -> str:
        return await asyncio.to_thread(self.client.generate_presigned_url, "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=ttl_seconds)

    async def put(self, key: str, body: bytes, content_type: str) -> str:
        return (await self.put_bytes(key=key, body=body, content_type=content_type)).key

    async def get(self, key: str) -> bytes:
        return await self.get_bytes(key)


ArtifactStore = ObjectStore
LocalArtifactStore = LocalObjectStore
R2ArtifactStore = R2ObjectStore


def create_artifact_store(settings: Settings, *, media: bool = False) -> ObjectStore:
    bucket = settings.r2_media_bucket if media else settings.r2_raw_bucket
    if settings.artifact_mode == "r2":
        if not all((settings.r2_endpoint_url, settings.r2_access_key_id, settings.r2_secret_access_key)):
            raise RuntimeError("R2 mode requires R2_ENDPOINT (or R2_ENDPOINT_URL), R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY")
        return R2ObjectStore(settings, bucket=bucket)
    root = settings.artifact_root / ("media" if media else "raw")
    return LocalObjectStore(root, bucket=bucket)
