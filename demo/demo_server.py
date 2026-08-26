#!/usr/bin/env python3
"""Serve the graph UI against a synthetic space, with no SilverBullet at all.

Useful for two things:

  * working on the front-end without standing up SilverBullet
  * producing screenshots, without publishing anyone's real page titles

Every page name below is invented. Run it and open http://localhost:8899/

    python3 demo/demo_server.py [port]
"""
from __future__ import annotations

import io
import json
import random
import sys
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "static"
SEED = 20260826  # fixed, so the demo graph is identical run to run

SPACE: dict[str, list[str]] = {}


def build_space() -> None:
    """A believable-looking personal knowledge base, entirely made up."""
    rnd = random.Random(SEED)

    projects = [
        "Greenhouse Controller", "Bike Workshop Rebuild", "Weather Station",
        "Home Server Migration", "Darkroom Timer", "Bookshelf Redesign",
        "Kayak Trailer", "Solar Shed", "Coffee Roaster", "Aquarium Automation",
        "Router Table", "Wind Chime Tuning",
    ]
    notes = [
        "Soldering Temperatures", "Wood Finishes Compared", "Battery Chemistries",
        "Knot Reference", "Sourdough Hydration", "Camera Film Stocks",
        "Espresso Grind Sizes", "Paint Coverage Rates", "Fastener Sizes",
        "Cable Gauges", "Soil pH Notes", "Compost Ratios", "Bearing Types",
        "Thread Pitches", "Glue Drying Times", "Sharpening Angles",
    ]
    recipes = [
        "Overnight Oats", "Tomato Confit", "Miso Butter Greens", "Flatbread",
        "Lemon Pasta", "Chickpea Stew", "Pickled Onions", "Apple Galette",
        "Roast Chicken", "Congee", "Ramen Broth", "Focaccia",
    ]
    travel = [
        "Lisbon Notes", "Dolomites Huts", "Kyoto Walks", "Iceland Ring Road",
        "Faroe Islands", "Slovenia Lakes", "Corsica Ferries", "Azores Hikes",
    ]
    reading = [
        "The Design of Everyday Things", "Seeing Like a State", "Thinking in Systems",
        "The Timeless Way of Building", "Where Wizards Stay Up Late",
        "The Soul of a New Machine", "Godel Escher Bach", "A Pattern Language",
    ]
    journal = ["Journal/%d Week %02d" % (2026, w) for w in range(1, 19)]

    def add(name: str, links: list[str] | None = None) -> None:
        SPACE[name] = links or []

    # Hubs
    add("index", ["Projects/Index", "Notes/Map of Content", "Recipes/Index",
                  "Travel/Index", "Reading/Index"])
    add("Projects/Index", ["Projects/" + p for p in projects])
    add("Notes/Map of Content", ["Notes/" + n for n in notes])
    add("Recipes/Index", ["Recipes/" + r for r in recipes])
    add("Travel/Index", ["Travel/" + t for t in travel])
    add("Reading/Index", ["Reading/" + b for b in reading])

    for p in projects:
        # Each project cites a couple of technique notes, and sometimes a sibling.
        links = ["Notes/" + n for n in rnd.sample(notes, rnd.randint(1, 3))]
        if rnd.random() < 0.45:
            links.append("Projects/" + rnd.choice([x for x in projects if x != p]))
        links.append("Projects/Index")
        add("Projects/" + p, links)

    for n in notes:
        links = ["Notes/Map of Content"]
        if rnd.random() < 0.4:
            links.append("Notes/" + rnd.choice([x for x in notes if x != n]))
        add("Notes/" + n, links)

    for r in recipes:
        links = ["Recipes/Index"]
        if rnd.random() < 0.35:
            links.append("Recipes/" + rnd.choice([x for x in recipes if x != r]))
        add("Recipes/" + r, links)

    for t in travel:
        links = ["Travel/Index"]
        if rnd.random() < 0.5:
            links.append("Travel/" + rnd.choice([x for x in travel if x != t]))
        add("Travel/" + t, links)

    for b in reading:
        links = ["Reading/Index"]
        if rnd.random() < 0.3:
            links.append("Reading/" + rnd.choice([x for x in reading if x != b]))
        add("Reading/" + b, links)

    # A journal that threads through everything, which is what makes a real
    # graph look like a graph rather than five separate stars.
    for i, j in enumerate(journal):
        links = []
        if i:
            links.append(journal[i - 1])
        pool = (["Projects/" + x for x in projects] + ["Recipes/" + x for x in recipes]
                + ["Travel/" + x for x in travel] + ["Reading/" + x for x in reading])
        links += rnd.sample(pool, rnd.randint(1, 3))
        add(j, links)

    # Three deliberately dangling links, to show the hollow "unresolved" style.
    SPACE["Projects/Greenhouse Controller"].append("Notes/Soil Moisture Sensors")
    SPACE["Travel/Lisbon Notes"].append("Travel/Porto Notes")
    SPACE["index"].append("Inbox")


def graph_payload() -> dict:
    existing = set(SPACE)
    degree: dict[str, int] = {}
    links, seen = [], set()
    for src, targets in SPACE.items():
        for dst in targets:
            if dst == src or (src, dst) in seen:
                continue
            seen.add((src, dst))
            links.append({"source": src, "target": dst,
                          "unresolved": dst not in existing})
            degree[src] = degree.get(src, 0) + 1
            degree[dst] = degree.get(dst, 0) + 1

    def node(name: str, exists: bool) -> dict:
        return {
            "id": name,
            "title": name.rsplit("/", 1)[-1],
            "folder": name.split("/", 1)[0] if "/" in name else "(root)",
            "degree": degree.get(name, 0),
            "exists": exists,
        }

    ghosts = {d for _, d in seen} - existing
    nodes = [node(n, True) for n in sorted(SPACE)] + \
            [node(g, False) for g in sorted(ghosts)]
    return {
        "nodes": nodes,
        "links": links,
        "version": 1,
        "sbUrl": "https://silverbullet.example.com",
        "stats": {"pages": len(SPACE), "unresolved": len(ghosts),
                  "edges": len(links), "lastReconcile": 0, "lastChange": 0},
    }


def export_zip() -> bytes:
    """Stand-in for app.py's export_zip: no real page bodies exist in the demo
    space (only names + links), so fabricate a minimal body for each."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, links in SPACE.items():
            body = "# %s\n\n" % name.rsplit("/", 1)[-1]
            for target in links:
                body += "- [[%s]]\n" % target
            zf.writestr(name + ".md", body)
    return buf.getvalue()


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/graph":
            return self._json(graph_payload())
        if path == "/api/export":
            return self._zip(export_zip())
        if path == "/healthz":
            return self._text("ok demo pages=%d" % len(SPACE))
        if path == "/api/events":
            # The UI opens an EventSource; hold it open and never push.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                self.wfile.write(b": demo\n\n")
                self.wfile.flush()
            except Exception:
                pass
            return
        if path in ("/", "/index.html"):
            return self._file("index.html")
        if path == "/embed":
            return self._file("embed.html")
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        return self._json({"ok": True, "demo": True})

    # -- helpers --
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _zip(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", 'attachment; filename="silverbullet-export.zip"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _text(self, s):
        body = s.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, name):
        body = (STATIC / name).read_text(encoding="utf-8").replace("{{V}}", "demo")
        body = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    build_space()
    print("demo space: %d pages, serving on http://localhost:%d/" % (len(SPACE), port))
    handler = partial(Handler, directory=str(STATIC.parent))
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    main()
