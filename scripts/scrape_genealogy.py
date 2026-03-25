#!/usr/bin/env python3
"""
Scrape mathgenealogy.org and produce data/genealogy.json.

Usage:
    cd scripts
    pip install -r requirements.txt
    python scrape_genealogy.py

Outputs: ../data/genealogy.json
"""

import json
import time
import re
import sys
from pathlib import Path
from collections import deque
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

# ── Configuration ────────────────────────────────────────────────────────────

BASE_URL = "https://www.mathgenealogy.org/id.php?id={}"
SLEEP_BETWEEN_REQUESTS = 1.5   # seconds (polite crawl)
ANCESTOR_DEPTH = None          # None = full depth (all ancestors)
DESCENDANT_DEPTH = 0           # ancestors only; no student crawling

DATA_DIR = Path(__file__).parent.parent / "data"
MEMBERS_FILE = DATA_DIR / "members.json"
OUTPUT_FILE = DATA_DIR / "genealogy.json"

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (compatible; AcademicFamilyTreeBot/1.0; "
        "research project scraping mathgenealogy.org)"
    )
})

# ── Helpers ──────────────────────────────────────────────────────────────────

def fetch_page(mgp_id: int) -> BeautifulSoup | None:
    url = BASE_URL.format(mgp_id)
    try:
        r = SESSION.get(url, timeout=20)
        r.raise_for_status()
        return BeautifulSoup(r.text, "lxml")
    except Exception as e:
        print(f"  [WARN] fetch {mgp_id}: {e}", file=sys.stderr)
        return None


def extract_ids_from_links(tags) -> list[int]:
    ids = []
    for tag in tags:
        href = tag.get("href", "")
        m = re.search(r"id=(\d+)", href)
        if m:
            ids.append(int(m.group(1)))
    return ids


def parse_person(mgp_id: int, soup: BeautifulSoup) -> dict:
    """Parse a single MGP person page into a node dict."""
    node = {
        "id": mgp_id,
        "name": "",
        "year": None,
        "institution": None,
        "dissertation": None,
        "advisors": [],
        "students": [],
        "dimag_status": None,
    }

    # Name — typically in <h2> or the page title
    h2 = soup.find("h2")
    if h2:
        node["name"] = h2.get_text(strip=True)

    # Institution — in <span style="color: #006633"> (may be multiple for multi-degree people)
    inst_spans = soup.find_all("span", style=re.compile(r"#006633"))
    for inst_span in inst_spans:
        text = inst_span.get_text(strip=True)
        if text and not node["institution"]:
            node["institution"] = text
        # Year is a sibling text node in the parent <span>
        parent = inst_span.parent
        if parent:
            year_m = re.search(r'\b(1\d{3}|20[0-2]\d)\b', parent.get_text())
            if year_m:
                node["year"] = int(year_m.group(1))
                break

    # Fallback: for scholars with no institution span, the year appears as a
    # bare text node between <h2> and <p>Dissertation</p> (e.g. ancient scholars).
    if node["year"] is None:
        h2 = soup.find("h2")
        diss_tag = soup.find(string=re.compile(r"Dissertation", re.I))
        if h2 and diss_tag:
            between = []
            for el in h2.next_elements:
                if el is diss_tag:
                    break
                if isinstance(el, str):
                    between.append(el.strip())
            year_m = re.search(r'\b(1\d{3}|20[0-2]\d)\b', ' '.join(between))
            if year_m:
                node["year"] = int(year_m.group(1))

    # Dissertation — always in <span id="thesisTitle">
    thesis_span = soup.find("span", id="thesisTitle")
    if thesis_span:
        node["dissertation"] = thesis_span.get_text(strip=True)[:300]

    # Advisors — links appearing in "Advisor" section
    advisor_section = soup.find(string=re.compile(r"Advisor", re.I))
    if advisor_section:
        parent = advisor_section.find_parent()
        if parent:
            node["advisors"] = extract_ids_from_links(parent.find_all("a", href=re.compile(r"id\.php")))

    # Students — links in the student table (usually a <table> at bottom)
    tables = soup.find_all("table")
    student_ids = []
    for table in tables:
        links = table.find_all("a", href=re.compile(r"id\.php"))
        student_ids.extend(extract_ids_from_links(links))
    # De-dup and remove self-references
    node["students"] = list(set(student_ids) - {mgp_id})

    return node


# ── Main BFS ────────────────────────────────────────────────────────────────

def scrape(seed_ids: list[int], up_only_ids: list[int], dimag_current: set[int], dimag_former: set[int]) -> dict:
    dimag_all = dimag_current | dimag_former

    nodes: dict[int, dict] = {}   # mgp_id → node
    edges: list[dict] = []

    # Queue entries: (mgp_id, direction, depth)
    # direction: "up" (ancestors) | "down" (descendants)
    queue: deque = deque()
    visited: dict[int, tuple] = {}  # mgp_id → (direction, depth) at first visit

    for sid in seed_ids:
        queue.append((sid, "both", 0))
        visited[sid] = ("both", 0)
    for sid in up_only_ids:
        if sid not in visited:
            queue.append((sid, "up", 0))
            visited[sid] = ("up", 0)

    processed = 0
    while queue:
        mgp_id, direction, depth = queue.popleft()

        print(f"[{processed+1}] Fetching {mgp_id} (dir={direction}, depth={depth})")
        soup = fetch_page(mgp_id)
        if soup is None:
            time.sleep(SLEEP_BETWEEN_REQUESTS)
            continue

        node = parse_person(mgp_id, soup)
        # Set DIMAG status
        if mgp_id in dimag_current:
            node["dimag_status"] = "current"
        elif mgp_id in dimag_former:
            node["dimag_status"] = "former"

        nodes[mgp_id] = node
        processed += 1

        # Enqueue ancestors (crawl up)
        if direction in ("both", "up"):
            can_go_up = (ANCESTOR_DEPTH is None) or (depth < ANCESTOR_DEPTH)
            if can_go_up:
                for advisor_id in node["advisors"]:
                    if advisor_id not in visited:
                        visited[advisor_id] = ("up", depth + 1)
                        queue.append((advisor_id, "up", depth + 1))

        # Enqueue descendants (crawl down)
        if direction in ("both", "down"):
            can_go_down = depth < DESCENDANT_DEPTH
            if can_go_down:
                for student_id in node["students"]:
                    if student_id not in visited:
                        visited[student_id] = ("down", depth + 1)
                        queue.append((student_id, "down", depth + 1))

        time.sleep(SLEEP_BETWEEN_REQUESTS)

    # Build edge list from advisor→student pairs within collected nodes
    seen_edges: set[tuple] = set()
    for node in nodes.values():
        for advisor_id in node["advisors"]:
            if advisor_id in nodes:
                key = (advisor_id, node["id"])
                if key not in seen_edges:
                    seen_edges.add(key)
                    edges.append({"source": advisor_id, "target": node["id"]})
        for student_id in node["students"]:
            if student_id in nodes:
                key = (node["id"], student_id)
                if key not in seen_edges:
                    seen_edges.add(key)
                    edges.append({"source": node["id"], "target": student_id})

    return {
        "nodes": list(nodes.values()),
        "edges": edges,
        "meta": {
            "generated": datetime.now(timezone.utc).isoformat(),
            "node_count": len(nodes),
            "edge_count": len(edges),
        },
    }


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    print(f"Loading members from {MEMBERS_FILE}")
    with open(MEMBERS_FILE) as f:
        members = json.load(f)

    current_ids = {m["mgp_id"] for m in members["current"] if m["mgp_id"]}
    former_ids  = {m["mgp_id"] for m in members["former"]  if m["mgp_id"]}

    # Advisors of null-mgp members: crawl up only (not down) to avoid pulling
    # in academic siblings and their students
    advisor_ids: set[int] = set()
    for role in ("current", "former"):
        for m in members[role]:
            if not m.get("mgp_id"):
                advisor_ids.update(m.get("advisor_mgp_ids") or [])

    dimag_seed_ids   = sorted(current_ids | former_ids)
    advisor_seed_ids = sorted(advisor_ids - current_ids - former_ids)

    print(f"DIMAG seeds: {dimag_seed_ids}")
    print(f"Advisor-only seeds (up only): {advisor_seed_ids}")
    print(f"Starting BFS crawl — ancestor_depth={'∞' if ANCESTOR_DEPTH is None else ANCESTOR_DEPTH}, descendant_depth={DESCENDANT_DEPTH}")
    print(f"Sleep between requests: {SLEEP_BETWEEN_REQUESTS}s")
    print()

    graph = scrape(dimag_seed_ids, advisor_seed_ids, current_ids, former_ids)

    # Synthesize nodes for null-mgp members that have advisor_mgp_ids specified
    existing_ids = {n["id"] for n in graph["nodes"]}
    seen_edges   = {(e["source"], e["target"]) for e in graph["edges"]}
    manual_count = 0
    for role in ("current", "former"):
        for m in members[role]:
            if m.get("mgp_id") or not m.get("advisor_mgp_ids"):
                continue
            synthetic_id = f"no-mgp-{m['name']}"
            if synthetic_id not in existing_ids:
                graph["nodes"].append({
                    "id":           synthetic_id,
                    "name":         m["name"],
                    "year":         m.get("year"),
                    "institution":  m.get("institution"),
                    "dissertation": m.get("dissertation"),
                    "advisors":     m["advisor_mgp_ids"],
                    "students":     [],
                    "dimag_status": role,
                    "photo_url":    m.get("photo_url"),
                    "is_manual":    True,
                })
                existing_ids.add(synthetic_id)
                manual_count += 1
            for advisor_id in m["advisor_mgp_ids"]:
                edge_key = (advisor_id, synthetic_id)
                if edge_key not in seen_edges:
                    graph["edges"].append({"source": advisor_id, "target": synthetic_id})
                    seen_edges.add(edge_key)
                # Back-patch advisor's students list
                for n in graph["nodes"]:
                    if n["id"] == advisor_id and synthetic_id not in n.get("students", []):
                        n.setdefault("students", []).append(synthetic_id)

    graph["meta"]["node_count"] = len(graph["nodes"])
    graph["meta"]["edge_count"] = len(graph["edges"])

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False, indent=2)

    print()
    print(f"Done. Wrote {graph['meta']['node_count']} nodes ({manual_count} manual), {graph['meta']['edge_count']} edges → {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
