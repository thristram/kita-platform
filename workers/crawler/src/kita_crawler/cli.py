from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from uuid import UUID

import typer
from rich.console import Console

from .config import load_settings
from .models import FetchMode
from .repository import CrawlerRepository
from .service import CrawlerService
from .storage import create_artifact_store

app = typer.Typer(no_args_is_help=True, help="KitaCon policy-first crawler worker")
console = Console()


async def _chromium_executable() -> str:
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        executable = playwright.chromium.executable_path
    if not Path(executable).exists():
        raise FileNotFoundError(executable)
    return executable


def _service() -> tuple[CrawlerService, CrawlerRepository]:
    settings = load_settings()
    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL_UNPOOLED or DATABASE_URL is required")
    repository = CrawlerRepository(settings.database_url)
    return CrawlerService(settings, repository, create_artifact_store(settings)), repository


@app.command()
def doctor() -> None:
    """Validate package, browser, database, and artifact configuration."""
    settings = load_settings()
    checks = {"scrapling": False, "database": False, "artifact_mode": settings.artifact_mode, "worker_version": settings.worker_version}
    try:
        import scrapling
        checks["scrapling"] = bool(scrapling)
    except ImportError:
        pass
    if settings.database_url:
        checks["database"] = CrawlerRepository(settings.database_url).ping()
    try:
        checks["chromium"] = asyncio.run(_chromium_executable())
    except Exception as error:
        checks["chromium"] = f"missing: {error}"
    console.print_json(json.dumps(checks, default=str))
    if not checks["scrapling"] or not checks["database"] or str(checks.get("chromium", "")).startswith("missing"):
        raise typer.Exit(1)


@app.command("run-source")
def run_source(source_id: UUID, drain: bool = typer.Option(False, help="Process the enqueued job immediately"), idempotency_key: str | None = None) -> None:
    """Enqueue an authorized source crawl."""
    service, repository = _service()
    run_id, job_id = service.enqueue_source(source_id, idempotency_key)
    console.print_json(json.dumps({"run_id": str(run_id), "job_id": str(job_id), "status": "QUEUED"}))
    if drain:
        _drain(service, repository, 1)


def _drain(service: CrawlerService, repository: CrawlerRepository, max_jobs: int) -> int:
    settings = load_settings()
    worker_id = repository.register_worker(settings.worker_name, settings.worker_version)
    processed = 0
    while processed < max_jobs:
        repository.heartbeat(worker_id)
        job = repository.lease_job(settings.worker_name)
        if not job:
            break
        try:
            result = asyncio.run(service.process_job(job))
            console.print_json(json.dumps(result))
        except Exception as error:
            console.print(f"[red]Job {job['id']} failed:[/red] {error}")
        processed += 1
    return processed


@app.command()
def drain(max_jobs: int = typer.Option(25, min=1, max=1000)) -> None:
    """Lease and process a bounded number of jobs."""
    service, repository = _service()
    processed = _drain(service, repository, max_jobs)
    console.print(f"Processed {processed} job(s)")


@app.command()
def worker(poll_seconds: float = typer.Option(2.0, min=0.25, max=30)) -> None:
    """Continuously lease crawler jobs until interrupted."""
    service, repository = _service()
    console.print("Crawler worker started. Press Ctrl+C to stop leasing.")
    try:
        while True:
            processed = _drain(service, repository, 1)
            if not processed:
                time.sleep(poll_seconds)
    except KeyboardInterrupt:
        console.print("Crawler worker stopped")


@app.command()
def replay(raw_document_id: UUID) -> None:
    """Re-extract a stored raw document without fetching the source."""
    service, _ = _service()
    console.print_json(json.dumps(asyncio.run(service.replay(raw_document_id)), default=str))


@app.command()
def inspect(
    url: str,
    no_persist: bool = typer.Option(True, "--no-persist/--persist", help="Diagnostics are non-persistent by default"),
    mode: FetchMode = typer.Option(FetchMode.HTTP),
) -> None:
    """Inspect an allowed URL using the crawler engine."""
    if not no_persist:
        raise typer.BadParameter("Persistent inspection requires a registered source; use run-source")
    settings = load_settings()
    repository = CrawlerRepository(settings.database_url) if settings.database_url else None
    service = CrawlerService(settings, repository, create_artifact_store(settings))  # type: ignore[arg-type]
    console.print_json(json.dumps(asyncio.run(service.inspect(url, mode)), default=str))
