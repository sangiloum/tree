#!/usr/bin/env python3
"""
Fetch only nodes that are missing a year in genealogy.json and patch them in place.

Usage:
    cd scripts
    python patch_missing_years.py

Much faster than a full re-scrape when only year data is missing.
"""

import json
import time
import re
import sys
from pathlib import Path
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.mathgenealogy.org/id.php?id={}"
SLEEP_BETWEEN_REQUESTS = 1.5

DATA_DIR = Path(__file__).parent.parent / "data"
OUTPUT_FILE = DATA_DIR / "genealogy.json"

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (compatible; AcademicFamilyTreeBot/1.0; "
        "research project scraping mathgenealogy.org)"
    )
})


def fetch_page(mgp_id: int) -> BeautifulSoup | None:
    url = BASE_URL.format(mgp_id)
    try:
        r = SESSION.get(url, timeout=20)
        r.raise_for_status()
        return BeautifulSoup(r.text, "lxml")
    except Exception as e:
        print(f"  [WARN] fetch {mgp_id}: {e}", file=sys.stderr)
        return None


def extract_year(soup: BeautifulSoup) -> int | None:
    """Extract PhD/degree year using the same logic as the main scraper."""
    # Primary: institution span(s) with year as sibling text
    # Some people have multiple degree entries; check all spans.
    for inst_span in soup.find_all("span", style=re.compile(r"#006633")):
        parent = inst_span.parent
        if parent:
            year_m = re.search(r'\b(1\d{3}|20[0-2]\d)\b', parent.get_text())
            if year_m:
                return int(year_m.group(1))

    # Fallback: bare text between <h2> and Dissertation label (ancient scholars)
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
            return int(year_m.group(1))

    return None


def main():
    print(f"Loading {OUTPUT_FILE}")
    with open(OUTPUT_FILE, encoding="utf-8") as f:
        data = json.load(f)

    null_nodes = [n for n in data["nodes"] if not n.get("year")]
    print(f"Nodes missing year: {len(null_nodes)} / {len(data['nodes'])}")
    print(f"Estimated time: {len(null_nodes) * SLEEP_BETWEEN_REQUESTS / 60:.1f} min\n")

    patched = 0
    still_null = 0

    for i, node in enumerate(null_nodes):
        mgp_id = node["id"]
        print(f"[{i+1}/{len(null_nodes)}] id={mgp_id} {node['name'][:40]}", end=" ... ")
        soup = fetch_page(mgp_id)
        if soup is None:
            print("FETCH FAILED")
            time.sleep(SLEEP_BETWEEN_REQUESTS)
            continue

        year = extract_year(soup)
        if year:
            node["year"] = year
            patched += 1
            print(f"year={year}")
        else:
            still_null += 1
            print("no year found")

        time.sleep(SLEEP_BETWEEN_REQUESTS)

    # Update metadata
    data["meta"]["patched"] = datetime.now(timezone.utc).isoformat()
    data["meta"]["patch_added_years"] = patched

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nDone. Patched {patched} nodes, {still_null} still have no year → {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
