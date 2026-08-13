#!/usr/bin/env python3
"""Generate a BibTeX file for every Zotero item that has a PDF/EPUB on disk.

Reads the Zotero local API (http://127.0.0.1:23119/api) and Better BibTeX
JSON-RPC (item.citationkey) — both of which work without the BBT export
endpoints that are currently broken by the "azp is null" issue — then writes
a .bib whose entries carry citekeys matching BBT plus `file` fields pointing
at the Zotero storage paths, so the Obsidian bib-manager plugin can list the
entries and locate the original PDF for page-level positioning.

Usage:
  python3 scripts/generate-zotero-bib.py [--out /path/zotero.bib]
"""
import argparse
import json
import os
import re
import urllib.request

API = "http://127.0.0.1:23119/api"
RPC = "http://127.0.0.1:23119/better-bibtex/json-rpc"
STORAGE = os.path.join(os.path.expanduser("~"), "Zotero", "storage")
TRANSLATOR_CSL = "36a3b0b5-bad0-4a04-b79b-441c7cef77db"


def api(path: str):
    with urllib.request.urlopen(f"{API}/{path}", timeout=20) as r:
        return json.load(r)


def rpc(method: str, params):
    req = urllib.request.Request(
        RPC,
        data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_all_items(path: str):
    out = []
    start = 0
    while True:
        batch = api(f"{path}&limit=100&start={start}")
        out += batch
        if len(batch) < 100:
            break
        start += 100
    return out


def is_pdf(a):
    return a["data"].get("contentType") == "application/pdf"


def is_epub(a):
    fn = a["data"].get("filename", "").lower()
    return fn.endswith(".epub") or a["data"].get("contentType") in (
        "application/epub+zip",
        "application/x-ebook",
    )


def esc(s: str) -> str:
    """BibTeX-safe single-line string."""
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")
    s = s.replace("$", r"\$").replace("&", r"\&").replace("#", r"\#")
    s = s.replace("%", r"\%").replace("_", r"\_")
    return s


def name_of(c):
    if c.get("name"):
        return c["name"]
    ln = (c.get("lastName") or "").strip()
    fn = (c.get("firstName") or "").strip()
    if ln and fn:
        return f"{ln}, {fn}"
    return ln or fn or ""


def year_of(date: str):
    m = re.match(r"(\d{4})", date or "")
    return m.group(1) if m else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(
        os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/XQLibrary"), "zotero.bib"
    ))
    args = ap.parse_args()

    atts = fetch_all_items("users/0/items?format=json&itemType=attachment")
    wanted = [a for a in atts if a["data"].get("linkMode") in ("imported_file", "imported_url")
              and (is_pdf(a) or is_epub(a))]

    parent_files = {}
    for a in wanted:
        d = a["data"]
        p = os.path.join(STORAGE, a["key"], d.get("filename", ""))
        parent = d.get("parentItem")
        if parent and os.path.exists(p) and os.path.getsize(p) > 0:
            parent_files.setdefault(parent, []).append(p)

    parents = sorted(parent_files)
    print(f"parents with on-disk pdf/epub: {len(parents)}")

    # Fetch parent item metadata via native API. The local API ignores the
    # itemKey filter, so page through every non-attachment item once instead.
    meta = {}
    start = 0
    while True:
        items = api(f"users/0/items?format=json&itemType=-attachment&limit=100&start={start}")
        for it in items:
            meta[it["key"]] = it["data"]
        if len(items) < 100:
            break
        start += 100
    print(f"indexed {len(meta)} non-attachment items")

    # Resolve BBT citation keys.
    ckmap = {}
    for i in range(0, len(parents), 200):
        chunk = parents[i : i + 200]
        try:
            res = rpc("item.citationkey", [chunk])
            ckmap.update(res.get("result", {}))
        except Exception as e:
            print(f"citationkey batch failed at {i}: {e}")

    entries = []
    skipped = 0
    for parent in parents:
        d = meta.get(parent)
        if not d:
            skipped += 1
            continue
        ck = ckmap.get(parent)
        if not ck:
            skipped += 1
            continue
        ck = ck.replace(" ", "").replace(",", "")
        if not ck:
            skipped += 1
            continue

        authors = [name_of(c) for c in d.get("creators", []) if c.get("creatorType") in ("author", "editor")]
        title = d.get("title") or ""
        journal = d.get("publicationTitle") or ""
        date = d.get("date") or ""
        vol = d.get("volume") or ""
        num = d.get("issue") or ""
        pages = d.get("pages") or ""
        doi = d.get("DOI") or ""
        url = d.get("url") or ""
        publisher = d.get("publisher") or ""
        etype = d.get("itemType")

        btype = {
            "book": "book", "bookSection": "incollection", "journalArticle": "article",
            "conferencePaper": "inproceedings", "thesis": "phdthesis", "report": "techreport",
            "preprint": "article",
        }.get(etype, "misc")

        lines = [f"@{btype}{{{ck},"]
        if title:
            lines.append(f"  title = {{{esc(title)}}},")
        if authors:
            lines.append(f"  author = {{{' and '.join(esc(a) for a in authors)}}},")
        if journal:
            lines.append(f"  journal = {{{esc(journal)}}},")
        y = year_of(date)
        if y:
            lines.append(f"  year = {{{y}}},")
        if vol:
            lines.append(f"  volume = {{{vol}}},")
        if num:
            lines.append(f"  number = {{{num}}},")
        if pages:
            lines.append(f"  pages = {{{pages}}},")
        if doi:
            lines.append(f"  doi = {{{esc(doi)}}},")
        if url:
            lines.append(f"  url = {{{esc(url)}}},")
        if publisher:
            lines.append(f"  publisher = {{{esc(publisher)}}},")
        files = parent_files[parent]
        lines.append(f"  file = {{{';'.join(files)}}},")
        lines.append("}")

        entries.append("\n".join(lines))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("%% Auto-generated by scripts/generate-zotero-bib.py\n")
        f.write("%% Source: Zotero local API + Better BibTeX item.citationkey\n\n")
        f.write("\n\n".join(entries) + "\n")

    print(f"written {len(entries)} entries -> {args.out} (skipped {skipped})")


if __name__ == "__main__":
    main()
