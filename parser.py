"""Link extraction for SilverBullet markdown pages."""
from __future__ import annotations

import posixpath
import re
from urllib.parse import unquote

FENCE_RE = re.compile(r"^```.*?^```", re.S | re.M)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.S)

# [[Target]] / [[Target|Alias]] / [[Target#Section]] / ![[Target]] / [[^Lib/Page]]
WIKILINK_RE = re.compile(r"!?\[\[\s*\^?([^\]\|#\n]+?)\s*(?:#[^\]\|\n]*)?(?:\|[^\]\n]*)?\]\]")

# [text](/Path/To/Page)  -- markdown links
MDLINK_RE = re.compile(r"!?\[[^\]\n]*\]\(\s*<?([^)>\s]+)>?\s*\)")

EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "tel:", "ftp://", "data:", "#")

# Anything with one of these suffixes is an attachment, not a page.
ATTACHMENT_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico",
    ".pdf", ".zip", ".tar", ".gz", ".mp4", ".mp3", ".wav", ".mov",
    ".csv", ".xlsx", ".json", ".yaml", ".yml", ".txt", ".conf",
)


def strip_noise(text: str) -> str:
    """Remove frontmatter and code so links inside them are not counted.

    Frontmatter is dropped here because most of it is metadata, but it can still
    hold real links; `extract_links` scans it separately before calling this.
    """
    text = FRONTMATTER_RE.sub("", text)
    text = FENCE_RE.sub("", text)
    text = INLINE_CODE_RE.sub("", text)
    return text


def normalise(target: str, base: str = "") -> str | None:
    """Turn a raw link target into a page name, or None if it is not a page.

    `base` is the folder of the page the link was found on. Pass it only for
    plain Markdown links: SilverBullet renders those as ordinary HTML, so the
    browser resolves them relative to the current page's folder. `[[wikilinks]]`
    are always space-root-absolute and must pass no base.
    """
    t = target.strip()
    if not t or t.startswith(EXTERNAL_PREFIXES):
        return None
    # Library pages embed Lua templates like [[${name}]]; those are not links.
    if "${" in t or "{{" in t:
        return None
    # Markdown links are often percent-encoded; the space stores plain names.
    if "%" in t:
        t = unquote(t)
    # An escaped pipe inside a wikilink leaves a trailing backslash behind.
    t = t.rstrip("\\").strip()
    t = t.split("#", 1)[0].split("?", 1)[0]
    if t.startswith("/"):
        t = t.lstrip("/")
    elif base:
        t = posixpath.normpath(f"{base}/{t}")
        # normpath can walk above the space root. Clamp instead of emitting a
        # name starting with "../", which matches no page.
        while t.startswith("../"):
            t = t[3:]
        if t in ("..", "."):
            return None
    if t.endswith(".md"):
        t = t[:-3]
    if not t:
        return None
    if t.lower().endswith(ATTACHMENT_SUFFIXES):
        return None
    return t


def extract_links(text: str, page: str | None = None) -> set[str]:
    """All internal page targets referenced by this page.

    `page` is the name of the page the text came from. Without it, relative
    Markdown links cannot be resolved and silently become root-level names.
    """
    fm = FRONTMATTER_RE.search(text)
    body = strip_noise(text)
    base = page.rsplit("/", 1)[0] if page and "/" in page else ""

    out: set[str] = set()

    # Frontmatter carries real links. SilverBullet renders a [[wikilink]] in an
    # attribute as a link, and spaces use attributes such as `parents:` and
    # `siblings:` to express relationships that appear nowhere else on the page;
    # dropping them made whole clusters look far sparser than they are. Only
    # wikilinks are read here: a Markdown link inside a YAML description is
    # prose, not navigation.
    if fm:
        for m in WIKILINK_RE.finditer(fm.group(0)):
            n = normalise(m.group(1))
            if n:
                out.add(n)

    for m in WIKILINK_RE.finditer(body):
        n = normalise(m.group(1))
        if n:
            out.add(n)
    for m in MDLINK_RE.finditer(body):
        n = normalise(m.group(1), base)
        if n:
            out.add(n)
    return out


def title_of(page: str) -> str:
    return page.rsplit("/", 1)[-1]


def folder_of(page: str) -> str:
    return page.split("/", 1)[0] if "/" in page else "(root)"
