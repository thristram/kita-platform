from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from uuid import UUID

from PIL import Image


@dataclass(frozen=True)
class MediaInspection:
    width: int | None
    height: int | None
    sha256: str
    perceptual_hash: str | None


@dataclass(frozen=True)
class CoverCandidate:
    asset_id: UUID
    category: str
    score: float
    pinned: bool = False


def resolve_internal_cover(candidates: list[CoverCandidate], current_asset_id: UUID | None = None) -> UUID | None:
    pinned = next((item for item in candidates if item.pinned), None)
    if pinned:
        return pinned.asset_id
    if current_asset_id and any(item.asset_id == current_asset_id and item.pinned for item in candidates):
        return current_asset_id
    order = {"EVENT_HERO": 1, "EVENT_POSTER": 2, "EVENT_LOGO": 3, "FANDOM_POSTER": 6, "MAP": 9, "OTHER": 10}
    eligible = sorted(candidates, key=lambda item: (order.get(item.category, 8), -item.score, str(item.asset_id)))
    return eligible[0].asset_id if eligible else current_asset_id


def inspect_media(body: bytes, content_type: str) -> MediaInspection:
    sha256 = hashlib.sha256(body).hexdigest()
    if not content_type.lower().startswith("image/"):
        return MediaInspection(None, None, sha256, None)
    try:
        with Image.open(io.BytesIO(body)) as image:
            grayscale = image.convert("L").resize((8, 8))
            pixels = list(grayscale.get_flattened_data())
            average = sum(pixels) / len(pixels)
            bits = "".join("1" if pixel >= average else "0" for pixel in pixels)
            return MediaInspection(image.width, image.height, sha256, f"{int(bits, 2):016x}")
    except Exception:
        return MediaInspection(None, None, sha256, None)


def media_category(*, url: str, alt: str = "", context: str = "", width: int | None = None, height: int | None = None) -> tuple[str, float]:
    signal = f"{url} {alt} {context}".lower()
    if "logo" in signal or "brand" in signal:
        return "EVENT_LOGO", 0.88
    if "map" in signal or "floor" in signal:
        return "MAP", 0.86
    if "poster" in signal or (width and height and height > width * 1.18):
        return "EVENT_POSTER", 0.72
    if "hero" in signal or "banner" in signal or (width and height and width > height * 1.45):
        return "EVENT_HERO", 0.74
    return "OTHER", 0.35


def is_meaningful_media(*, url: str, width: int | None, height: int | None, category: str) -> bool:
    lower = url.lower()
    if any(token in lower for token in ("pixel", "tracking", "spacer", "analytics")):
        return False
    if width and height and width <= 2 and height <= 2:
        return False
    if category.endswith("LOGO"):
        return True
    return not (width and height and max(width, height) < 48)
