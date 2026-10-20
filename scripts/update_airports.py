#!/usr/bin/env python3
"""
Update SkyArt Airport Database
Downloads the latest global airports dataset from OurAirports (Public Domain / CC0)
and produces a compact, fast-loading JSON dataset covering all international
airports, regional hubs, general aviation airfields, and seaplane bases worldwide.
"""

import csv
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUTPUT_FILE = os.path.join(DATA_DIR, "airports_summary.json")
BACKUP_FILE = os.path.join(DATA_DIR, "airports_summary.json.bak")

AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
COUNTRIES_URL = "https://davidmegginson.github.io/ourairports-data/countries.csv"

TMP_AIRPORTS_CSV = "/tmp/airports.csv"
TMP_COUNTRIES_CSV = "/tmp/countries.csv"


def download_file(url, target_path):
    print(f"Downloading {url} -> {target_path}...")
    try:
        subprocess.run(["curl", "-sL", url, "-o", target_path], check=True)
        size_mb = os.path.getsize(target_path) / (1024 * 1024)
        print(f"Downloaded {size_mb:.2f} MB")
    except Exception as e:
        print(f"Error downloading {url}: {e}")
        if not os.path.exists(target_path):
            raise


def build_database():
    os.makedirs(DATA_DIR, exist_ok=True)

    # 1. Ensure latest raw CSVs are available
    if not os.path.exists(TMP_COUNTRIES_CSV) or os.path.getsize(TMP_COUNTRIES_CSV) < 1000:
        download_file(COUNTRIES_URL, TMP_COUNTRIES_CSV)

    if not os.path.exists(TMP_AIRPORTS_CSV) or os.path.getsize(TMP_AIRPORTS_CSV) < 1000000:
        download_file(AIRPORTS_URL, TMP_AIRPORTS_CSV)

    # 2. Parse countries
    print("Loading countries...")
    countries = {}
    with open(TMP_COUNTRIES_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            code = (r.get("code") or "").strip().upper()
            name = (r.get("name") or "").strip()
            if code and name:
                countries[code] = name
    print(f"Loaded {len(countries)} countries.")

    # 3. Parse airports
    print("Parsing airports from OurAirports dataset...")
    airports = []
    skipped_closed = 0
    skipped_heliport_no_code = 0

    with open(TMP_AIRPORTS_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            atype = (r.get("type") or "").strip()
            if atype in ("closed", "balloonport"):
                skipped_closed += 1
                continue

            # Only include heliports if they have an assigned ICAO or IATA code
            if atype == "heliport" and not (r.get("icao_code") or r.get("iata_code")):
                skipped_heliport_no_code += 1
                continue

            ident = (r.get("ident") or "").strip().upper()
            icao = (r.get("icao_code") or "").strip().upper()
            iata = (r.get("iata_code") or "").strip().upper()
            local = (r.get("local_code") or "").strip().upper()
            name = (r.get("name") or "").strip()
            city = (r.get("municipality") or "").strip()
            country_code = (r.get("iso_country") or "").strip().upper()
            country_name = countries.get(country_code, country_code)
            keywords = (r.get("keywords") or "").strip()

            try:
                lat = round(float(r["latitude_deg"]), 4)
                lon = round(float(r["longitude_deg"]), 4)
            except (ValueError, TypeError, KeyError):
                continue

            iso_region = (r.get("iso_region") or "").strip()
            state = iso_region.split("-")[1] if "-" in iso_region else iso_region

            # Primary code: icao_code if available, otherwise ident
            disp_code = icao or ident

            # FAA code for US facilities
            faa_code = local or (ident if len(ident) <= 4 and country_code == "US" else "")

            ap = {
                "icao": disp_code,
                "iata": iata,
                "faa": faa_code,
                "name": name,
                "city": city,
                "state": state,
                "country": country_code,
                "country_name": country_name,
                "type": atype,
                "lat": lat,
                "lon": lon,
            }

            if keywords:
                ap["keywords"] = keywords

            if r.get("elevation_ft"):
                try:
                    ap["elevation_ft"] = int(float(r["elevation_ft"]))
                except (ValueError, TypeError):
                    pass

            airports.append(ap)

    print(f"Parsed {len(airports)} active global airports (skipped {skipped_closed} closed, {skipped_heliport_no_code} unindexed heliports).")

    # 4. Backup existing database if present
    if os.path.exists(OUTPUT_FILE):
        print(f"Backing up existing airport database to {BACKUP_FILE}...")
        shutil.copy2(OUTPUT_FILE, BACKUP_FILE)

    # 5. Build final summary payload
    payload = {
        "version": "3.0.0",
        "last_synced": datetime.now(timezone.utc).isoformat(),
        "total_airports": len(airports),
        "airports": airports,
    }

    print(f"Writing database to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)

    file_size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    print(f"Successfully created {OUTPUT_FILE} ({file_size_mb:.2f} MB, {len(airports)} airports).")


if __name__ == "__main__":
    build_database()
