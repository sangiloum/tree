#!/usr/bin/env python3
"""Download member and ancestor photos for the family tree.

Usage:
    cd <project-root>
    python scripts/download_photos.py
"""
import json, os, time
import requests

OUT_DIR = 'data/photos'
os.makedirs(OUT_DIR, exist_ok=True)

def save(mgp_id, url, label=''):
    out = os.path.join(OUT_DIR, f'{mgp_id}.jpg')
    if os.path.exists(out):
        return  # already downloaded
    try:
        r = requests.get(url, timeout=10, headers={'User-Agent': 'FamilyTreeBot/1.0'})
        if r.ok and r.headers.get('content-type', '').startswith('image'):
            with open(out, 'wb') as f:
                f.write(r.content)
            print(f'  OK  {label or mgp_id}')
        else:
            print(f'  SKIP {label or mgp_id} (HTTP {r.status_code})')
    except Exception as e:
        print(f'  ERR  {label or mgp_id}: {e}')

# ── 1. DIMAG members: photos from dimag.ibs.re.kr ──────────────────────────
print('Downloading DIMAG member photos…')
with open('data/members.json') as f:
    members = json.load(f)

for group in ('current', 'former'):
    for m in members.get(group, []):
        mgp_id    = m.get('mgp_id')
        photo_url = m.get('photo_url')
        if mgp_id and photo_url:
            save(mgp_id, photo_url, m.get('name', mgp_id))
            time.sleep(0.3)
        elif not mgp_id and photo_url:
            # Use the same ID convention as the scraper: "no-mgp-{name}"
            synthetic_id = f'no-mgp-{m["name"]}'
            save(synthetic_id, photo_url, m.get('name', synthetic_id))
            time.sleep(0.3)

# ── 2. Genealogy ancestors: photos + Wikipedia URLs ────────────────────────
print('Downloading ancestor photos from Wikipedia…')
with open('data/genealogy.json') as f:
    genealogy = json.load(f)

WIKI_URLS_FILE = 'data/wikipedia_urls.json'
wiki_urls = {}
if os.path.exists(WIKI_URLS_FILE):
    with open(WIKI_URLS_FILE) as f:
        wiki_urls = json.load(f)

for node in genealogy.get('nodes', []):
    mgp_id = node.get('id')
    name   = node.get('name', '').strip()
    if not mgp_id or not name:
        continue
    title = name.replace(' ', '_')
    out   = os.path.join(OUT_DIR, f'{mgp_id}.jpg')
    already_have_photo = os.path.exists(out)
    already_have_url   = str(mgp_id) in wiki_urls
    if already_have_photo and already_have_url:
        continue
    try:
        r = requests.get(
            f'https://en.wikipedia.org/api/rest_v1/page/summary/{title}',
            timeout=8, headers={'User-Agent': 'FamilyTreeBot/1.0'}
        )
        if r.ok:
            data  = r.json()
            page_url = data.get('content_urls', {}).get('desktop', {}).get('page')
            if page_url:
                wiki_urls[str(mgp_id)] = page_url
            thumb = data.get('thumbnail', {}).get('source')
            if thumb and not already_have_photo:
                save(mgp_id, thumb, name)
    except Exception as e:
        print(f'  ERR  {name}: {e}')
    time.sleep(0.4)

with open(WIKI_URLS_FILE, 'w') as f:
    json.dump(wiki_urls, f, indent=2)
print(f'  Saved {len(wiki_urls)} Wikipedia URLs → {WIKI_URLS_FILE}')

print('Done.')
