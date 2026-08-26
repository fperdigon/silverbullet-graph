"""sb-graph: an Obsidian-style link graph for a SilverBullet space.

Reads the space over SilverBullet's own /.fs/ HTTP API (never off disk), keeps an
in-memory link graph, and updates it incrementally:

  * POST /api/notify {"page": "..."}  refetches exactly that one page
  * a periodic reconcile lists /.fs/ once and refetches ONLY files whose
    lastModified/size changed

A full rebuild happens only on first boot with a cold cache, or on explicit
POST /api/rebuild.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

from parser import extract_links, folder_of, title_of

LOG = logging.getLogger("sb-graph")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
# One line per page fetch is unusable at 300+ pages.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

SB_URL = os.environ.get("SILVERBULLET_URL", "").rstrip("/")
SB_TOKEN = os.environ.get("SILVERBULLET_TOKEN", "")
CACHE_PATH = Path(os.environ.get("CACHE_PATH", "/data/cache.json"))
RECONCILE_INTERVAL = int(os.environ.get("RECONCILE_INTERVAL", "300"))
SB_PUBLIC_URL = os.environ.get("SILVERBULLET_PUBLIC_URL", SB_URL).rstrip("/")
CONCURRENCY = int(os.environ.get("FETCH_CONCURRENCY", "8"))
# Folders to keep out of the graph entirely. Library/ holds SilverBullet's own
# std library, which `sb ls` also hides by default: it is machinery, not content.
EXCLUDE_PREFIXES = tuple(
    p.strip() for p in os.environ.get("EXCLUDE_PREFIXES", "Library/").split(",") if p.strip()
)
STATIC_DIR = Path(__file__).parent / "static"

HEADERS = {"Authorization": f"Bearer {SB_TOKEN}", "X-Sync-Mode": "true"}


def asset_version() -> str:
    """Content hash of the front-end, used to bust browser caches.

    Without this the browser happily serves a months-old graph.js from disk
    cache: StaticFiles sets only ETag/Last-Modified, and browsers are free to
    reuse those heuristically without revalidating.
    """
    h = hashlib.md5()
    for name in ("graph.js", "app.css"):
        f = STATIC_DIR / name
        if f.exists():
            h.update(f.read_bytes())
    return h.hexdigest()[:10]


ASSET_V = asset_version()


def page(name: str) -> HTMLResponse:
    html = (STATIC_DIR / name).read_text(encoding="utf-8").replace("{{V}}", ASSET_V)
    # The shell must always be revalidated, or it keeps pointing at old assets.
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, must-revalidate"})


class Graph:
    """Link graph state. `pages` maps page name -> {mtime, size, links}."""

    def __init__(self) -> None:
        self.pages: dict[str, dict] = {}
        self.lock = asyncio.Lock()
        self.version = 0
        self.last_reconcile: float = 0.0
        self.last_change: float = 0.0
        self._subscribers: set[asyncio.Queue] = set()

    # -- persistence -------------------------------------------------
    def load(self) -> None:
        if not CACHE_PATH.exists():
            return
        try:
            data = json.loads(CACHE_PATH.read_text())
            self.pages = data.get("pages", {})
            self.version = data.get("version", 0)
            LOG.info("loaded cache: %d pages", len(self.pages))
        except Exception as exc:  # corrupt cache must never be fatal
            LOG.warning("cache unreadable, starting cold: %s", exc)
            self.pages = {}

    def save(self) -> None:
        try:
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = CACHE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps({"pages": self.pages, "version": self.version}))
            tmp.replace(CACHE_PATH)
        except Exception as exc:
            LOG.warning("could not persist cache: %s", exc)

    # -- change notification ----------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def bump(self) -> None:
        self.version += 1
        self.last_change = time.time()
        for q in list(self._subscribers):
            try:
                q.put_nowait(self.version)
            except asyncio.QueueFull:
                pass

    # -- graph projection -------------------------------------------
    def render(self) -> dict:
        existing = set(self.pages)
        degree: dict[str, int] = {}
        links: list[dict] = []
        seen: set[tuple[str, str]] = set()

        for src, meta in self.pages.items():
            for dst in meta.get("links", []):
                if dst == src or (src, dst) in seen:
                    continue
                seen.add((src, dst))
                links.append({"source": src, "target": dst,
                              "unresolved": dst not in existing})
                degree[src] = degree.get(src, 0) + 1
                degree[dst] = degree.get(dst, 0) + 1

        nodes = [
            {
                "id": p,
                "title": title_of(p),
                "folder": folder_of(p),
                "degree": degree.get(p, 0),
                "exists": True,
            }
            for p in sorted(self.pages)
        ]
        ghosts = {d for _, d in seen} - existing
        nodes += [
            {
                "id": g,
                "title": title_of(g),
                "folder": folder_of(g),
                "degree": degree.get(g, 0),
                "exists": False,
            }
            for g in sorted(ghosts)
        ]
        return {
            "nodes": nodes,
            "links": links,
            "version": self.version,
            "sbUrl": SB_PUBLIC_URL,
            "stats": {
                "pages": len(self.pages),
                "unresolved": len(ghosts),
                "edges": len(links),
                "lastReconcile": self.last_reconcile,
                "lastChange": self.last_change,
            },
        }


GRAPH = Graph()


# -- SilverBullet API --------------------------------------------------
def excluded(page: str) -> bool:
    return any(page.startswith(p) for p in EXCLUDE_PREFIXES)


async def sb_list(client: httpx.AsyncClient) -> tuple[dict[str, dict], set[str]]:
    """One request: every file in the space, split into pages and attachments."""
    r = await client.get(f"{SB_URL}/.fs/", headers=HEADERS, timeout=30)
    r.raise_for_status()
    pages: dict[str, dict] = {}
    attachments: set[str] = set()
    for f in r.json():
        name = f.get("name", "")
        if not name:
            continue
        if name.endswith(".md"):
            page = name[:-3]
            if excluded(page):
                continue
            pages[page] = {
                "mtime": f.get("lastModified", 0),
                "size": f.get("size", 0),
            }
        else:
            # Exact attachment set beats guessing by file extension.
            attachments.add(name)
    return pages, attachments


async def sb_read(client: httpx.AsyncClient, page: str) -> str | None:
    path = "/".join(quote(seg) for seg in f"{page}.md".split("/"))
    r = await client.get(f"{SB_URL}/.fs/{path}", headers=HEADERS, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.text


async def refresh_pages(
    pages: list[str], meta: dict[str, dict], attachments: set[str] | None = None
) -> int:
    """Fetch and reparse exactly the named pages. Returns how many changed."""
    if not pages:
        return 0
    sem = asyncio.Semaphore(CONCURRENCY)
    att = attachments or set()
    changed = 0

    async with httpx.AsyncClient(follow_redirects=True) as client:
        async def one(page: str) -> None:
            nonlocal changed
            async with sem:
                try:
                    text = await sb_read(client, page)
                except Exception as exc:
                    LOG.warning("fetch failed for %s: %s", page, exc)
                    return
            if text is None:
                if GRAPH.pages.pop(page, None) is not None:
                    changed += 1
                return
            info = meta.get(page, {})
            targets = {
                t for t in extract_links(text)
                if not excluded(t) and t not in att
            }
            GRAPH.pages[page] = {
                "mtime": info.get("mtime", 0),
                "size": info.get("size", len(text)),
                "links": sorted(targets),
            }
            changed += 1

        await asyncio.gather(*(one(p) for p in pages))
    return changed


async def export_zip() -> bytes:
    """Zip up the current page set as plain .md files, folder structure intact.

    Re-fetches every page's raw text rather than reading GRAPH.pages, which
    only ever holds parsed links, never the body.
    """
    pages = sorted(GRAPH.pages)
    sem = asyncio.Semaphore(CONCURRENCY)
    bodies: dict[str, str] = {}

    async with httpx.AsyncClient(follow_redirects=True) as client:
        async def one(p: str) -> None:
            async with sem:
                try:
                    text = await sb_read(client, p)
                except Exception as exc:
                    LOG.warning("export fetch failed for %s: %s", p, exc)
                    return
            if text is not None:
                bodies[p] = text

        await asyncio.gather(*(one(p) for p in pages))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(bodies):
            zf.writestr(f"{p}.md", bodies[p])
    return buf.getvalue()


async def reconcile(force: bool = False) -> dict:
    """List the space once; refetch only files whose mtime/size moved."""
    async with GRAPH.lock:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            remote, attachments = await sb_list(client)

        if force:
            stale = list(remote)
        else:
            stale = [
                p for p, m in remote.items()
                if p not in GRAPH.pages
                or GRAPH.pages[p].get("mtime") != m["mtime"]
                or GRAPH.pages[p].get("size") != m["size"]
            ]
        removed = [p for p in GRAPH.pages if p not in remote]
        for p in removed:
            GRAPH.pages.pop(p, None)

        n = await refresh_pages(stale, remote, attachments)
        GRAPH.last_reconcile = time.time()
        if n or removed:
            GRAPH.bump()
            GRAPH.save()
        LOG.info("reconcile: %d refetched, %d removed, %d total",
                 n, len(removed), len(GRAPH.pages))
        return {"refetched": n, "removed": len(removed), "total": len(GRAPH.pages)}


async def reconcile_loop() -> None:
    while True:
        await asyncio.sleep(RECONCILE_INTERVAL)
        try:
            await reconcile()
        except Exception as exc:
            LOG.warning("reconcile failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not SB_URL or not SB_TOKEN:
        LOG.error("SILVERBULLET_URL and SILVERBULLET_TOKEN must be set")
    GRAPH.load()
    try:
        await reconcile(force=not GRAPH.pages)
    except Exception as exc:
        LOG.warning("initial reconcile failed: %s", exc)
    task = asyncio.create_task(reconcile_loop())
    yield
    task.cancel()


app = FastAPI(title="sb-graph", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/healthz", response_class=PlainTextResponse)
async def healthz() -> str:
    return f"ok pages={len(GRAPH.pages)} version={GRAPH.version} assets={ASSET_V}"


@app.get("/api/graph")
async def api_graph() -> JSONResponse:
    return JSONResponse(GRAPH.render())


@app.post("/api/notify")
async def api_notify(request: Request) -> dict:
    """Fast path: SilverBullet tells us one page changed. Refetch only it."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "expected a JSON body")

    pages = body.get("pages") or ([body["page"]] if body.get("page") else [])
    pages = [p[:-3] if p.endswith(".md") else p for p in pages if p]
    if not pages:
        raise HTTPException(400, "no page given")

    async with GRAPH.lock:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            remote, attachments = await sb_list(client)
        n = await refresh_pages(
            [p for p in pages if p in remote], remote, attachments
        )
        for p in pages:
            if p not in remote and GRAPH.pages.pop(p, None) is not None:
                n += 1
        if n:
            GRAPH.bump()
            GRAPH.save()
    LOG.info("notify %s -> %d updated", pages, n)
    return {"updated": n, "version": GRAPH.version}


@app.post("/api/rebuild")
async def api_rebuild() -> dict:
    return await reconcile(force=True)


@app.get("/api/export")
async def api_export() -> Response:
    data = await export_zip()
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="silverbullet-export.zip"'},
    )


@app.get("/api/events")
async def api_events() -> StreamingResponse:
    async def stream():
        q = GRAPH.subscribe()
        try:
            yield f"data: {GRAPH.version}\n\n"
            while True:
                try:
                    v = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"data: {v}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            GRAPH.unsubscribe(q)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/")
async def root() -> HTMLResponse:
    return page("index.html")


@app.get("/embed")
async def embed() -> HTMLResponse:
    return page("embed.html")
