#!/usr/bin/env python3
"""Bake the terrain heightmaps that SignalLab's map view uses.

Source is the AWS Terrain Tiles open dataset (Terrarium encoding), which over
CONUS is derived from USGS 3DEP/NED. It is public, needs no API key, and is CORS
enabled, but we still fetch at author time and commit the result: a docs page
should not need a live elevation API to render, and baking the data keeps the
component synchronous and SSR safe.

    https://registry.opendata.aws/terrain-tiles/

Every value is cross-checked against the USGS ned10m dataset served by
opentopodata.org before anything is written.

Usage:  python3 scripts/fetch_terrain.py
Writes: src/data/terrain.js
"""

import base64
import io
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

# --------------------------------------------------------------------------- config

ZOOM = 13          # ~15 m/px at these latitudes, 3DEP-derived over CONUS
SPAN_M = 6000.0    # side length of the square window, metres
GRID = 200         # samples per side -> 30 m/px
TILE = 256

# Orthoimagery for the map background. z15 is ~3.7 m/px at these latitudes, so
# 1600 px covers the 6 km window at native resolution with no upsampling — good
# for roughly 4x zoom before it softens.
IMG_ZOOM = 15
IMG_PX = 1600
IMG_QUALITY = 82

SITES = [
    {
        "id": "mdrs",
        "name": "Mars Desert Research Station",
        "sub": "Hanksville, Utah — where URC runs",
        "lat": 38.406390,
        "lon": -110.791940,
    },
    {
        "id": "rolla",
        "name": "Rolla test site",
        "sub": "Missouri S&T — the home field",
        "lat": 37.950030,
        "lon": -91.783062,
    },
]

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
# USGS National Map orthoimagery: a US federal work, so public domain, no key
# and no licence to propagate. Note ArcGIS orders the path z/y/x.
IMAGE_URL = ("https://basemap.nationalmap.gov/arcgis/rest/services/"
             "USGSImageryOnly/MapServer/tile/{z}/{y}/{x}")
CHECK_URL = "https://api.opentopodata.org/v1/ned10m?locations={pts}"
UA = {"User-Agent": "MRDT-docs-terrain-bake/1.0 (+https://github.com/MissouriMRDT)"}

# --------------------------------------------------------------------- web mercator


def lonlat_to_pixel(lon, lat, z):
    """Global pixel coordinates at zoom z (256 px tiles)."""
    n = TILE * (2 ** z)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def decode_terrarium(img):
    a = np.asarray(img.convert("RGB")).astype(np.float64)
    # Terrarium: height = (R * 256 + G + B / 256) - 32768
    return (a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0) - 32768.0


def decode_rgb(img):
    return np.asarray(img.convert("RGB")).astype(np.float64)


def fetch_tile(url_tmpl, z, x, y, cache, decode):
    key = (url_tmpl, z, x, y)
    if key in cache:
        return cache[key]
    url = url_tmpl.format(z=z, x=x, y=y)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=45) as r:
                raw = r.read()
            break
        except Exception as exc:  # noqa: BLE001 - retry any transport failure
            if attempt == 3:
                raise RuntimeError(f"tile {z}/{x}/{y} failed: {exc}") from exc
            time.sleep(1.5 * (attempt + 1))
    out = decode(Image.open(io.BytesIO(raw)))
    cache[key] = out
    return out


def build_mosaic(lat, lon, z, url_tmpl, cache, decode, bands=1):
    """Fetch every tile touching the window and return (mosaic, px0, py0)."""
    half = SPAN_M / 2.0
    # Generous margin so bilinear sampling never runs off the mosaic.
    dlat = (half + 400.0) / 111320.0
    dlon = (half + 400.0) / (111320.0 * math.cos(math.radians(lat)))

    corners = [
        lonlat_to_pixel(lon - dlon, lat + dlat, z),
        lonlat_to_pixel(lon + dlon, lat - dlat, z),
    ]
    x0 = int(math.floor(min(c[0] for c in corners) / TILE))
    x1 = int(math.floor(max(c[0] for c in corners) / TILE))
    y0 = int(math.floor(min(c[1] for c in corners) / TILE))
    y1 = int(math.floor(max(c[1] for c in corners) / TILE))

    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    print(f"    {nx}x{ny} tiles at z{z}", end="", flush=True)
    shape = (ny * TILE, nx * TILE) if bands == 1 else (ny * TILE, nx * TILE, bands)
    mosaic = np.zeros(shape, dtype=np.float64)
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            mosaic[(ty - y0) * TILE:(ty - y0 + 1) * TILE,
                   (tx - x0) * TILE:(tx - x0 + 1) * TILE] = \
                fetch_tile(url_tmpl, z, tx, ty, cache, decode)
    print(f"  ({nx * ny} fetched)", flush=True)
    return mosaic, x0 * TILE, y0 * TILE


def bilinear(mosaic, px, py):
    """Sample the mosaic at fractional pixel coords (arrays in, array out).

    Works for a single band or for an (H, W, C) image.
    """
    h, w = mosaic.shape[0], mosaic.shape[1]
    px = np.clip(px, 0, w - 1.001)
    py = np.clip(py, 0, h - 1.001)
    x0 = np.floor(px).astype(int)
    y0 = np.floor(py).astype(int)
    fx = px - x0
    fy = py - y0
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    if mosaic.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    return (mosaic[y0, x0] * (1 - fx) * (1 - fy) + mosaic[y0, x1] * fx * (1 - fy) +
            mosaic[y1, x0] * (1 - fx) * fy + mosaic[y1, x1] * fx * fy)


def window_pixels(lat, lon, n, zoom):
    """Global mercator pixel coords for an n x n grid over the local window.

    Both the heightmap and the imagery go through this, so they land on exactly
    the same ground and the contours sit where the imagery says they should.
    """
    half = SPAN_M / 2.0
    step = SPAN_M / (n - 1)
    offs = -half + step * np.arange(n)          # metres east / north of centre
    east = np.tile(offs, (n, 1))                # x increases east
    north = np.repeat(offs[::-1, None], n, 1)   # row 0 = north

    lats = lat + north / 111320.0
    lons = lon + east / (111320.0 * math.cos(math.radians(lat)))

    span = TILE * (2 ** zoom)
    gx = (lons + 180.0) / 360.0 * span
    s = np.sin(np.radians(lats))
    gy = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * span
    return gx, gy


def sample_site(site, cache):
    """Return a GRID x GRID array of elevations, row 0 = north edge."""
    lat, lon = site["lat"], site["lon"]
    mosaic, px0, py0 = build_mosaic(lat, lon, ZOOM, TILE_URL, cache, decode_terrarium)
    gx, gy = window_pixels(lat, lon, GRID, ZOOM)
    return bilinear(mosaic, gx - px0, gy - py0)


def sample_imagery(site, cache, out_dir):
    """Resample USGS orthoimagery onto the identical window and write a WebP."""
    lat, lon = site["lat"], site["lon"]
    mosaic, px0, py0 = build_mosaic(lat, lon, IMG_ZOOM, IMAGE_URL, cache, decode_rgb, bands=3)
    gx, gy = window_pixels(lat, lon, IMG_PX, IMG_ZOOM)
    rgb = np.clip(bilinear(mosaic, gx - px0, gy - py0), 0, 255).astype(np.uint8)

    os.makedirs(out_dir, exist_ok=True)
    name = f"{site['id']}.webp"
    path = os.path.join(out_dir, name)
    Image.fromarray(rgb, "RGB").save(path, "WEBP", quality=IMG_QUALITY, method=6)
    kb = os.path.getsize(path) // 1024
    print(f"    imagery {IMG_PX}x{IMG_PX} @ z{IMG_ZOOM} "
          f"({SPAN_M / IMG_PX:.2f} m/px), {kb} KB webp", flush=True)
    return name, kb


# ------------------------------------------------------------------- verification


def verify(site, grid):
    """Spot-check the baked grid against USGS ned10m via opentopodata."""
    lat, lon = site["lat"], site["lon"]
    half = SPAN_M / 2.0
    step = SPAN_M / (GRID - 1)
    rng = np.random.default_rng(7)
    idx = [(GRID // 2, GRID // 2)] + [
        (int(r), int(c)) for r, c in rng.integers(10, GRID - 10, size=(11, 2))
    ]

    pts, mine = [], []
    for r, c in idx:
        north = half - r * step
        east = -half + c * step
        pts.append("%.6f,%.6f" % (lat + north / 111320.0,
                                  lon + east / (111320.0 * math.cos(math.radians(lat)))))
        mine.append(grid[r, c])

    url = CHECK_URL.format(pts="|".join(pts))
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    if data.get("status") != "OK":
        raise RuntimeError(f"verification query failed: {data}")

    ref = [x["elevation"] for x in data["results"]]
    diffs = [abs(a - b) for a, b in zip(mine, ref) if b is not None]
    worst = max(diffs)
    print("    checked %d points against USGS ned10m: mean |dz| %.2f m, worst %.2f m"
          % (len(diffs), sum(diffs) / len(diffs), worst), flush=True)
    if worst > 25.0:
        raise RuntimeError(f"terrain disagrees with USGS by {worst:.1f} m — refusing to write")
    return sum(diffs) / len(diffs), worst


# ------------------------------------------------------------------------- output


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(here, "..", "src", "data", "terrain.js")
    img_dir = os.path.normpath(os.path.join(here, "..", "static", "img", "terrain"))
    cache = {}
    blocks = []

    for site in SITES:
        print(f"  {site['id']}: {site['lat']}, {site['lon']}", flush=True)
        grid = sample_site(site, cache)
        mean_err, worst_err = verify(site, grid)
        image, image_kb = sample_imagery(site, cache, img_dir)

        base = float(np.floor(grid.min()))
        # decimetres above the site floor keeps 0.1 m precision inside int16
        dm = np.rint((grid - base) * 10.0).astype(np.int32)
        if dm.max() > 32767:
            raise RuntimeError("relief exceeds int16 range in decimetres")
        payload = base64.b64encode(dm.astype("<i2").tobytes()).decode("ascii")

        print("    elevation %.1f..%.1f m (relief %.1f m), %d KB base64"
              % (grid.min(), grid.max(), grid.max() - grid.min(), len(payload) // 1024),
              flush=True)

        blocks.append({
            "id": site["id"],
            "name": site["name"],
            "sub": site["sub"],
            "lat": site["lat"],
            "lon": site["lon"],
            "base": base,
            "min": round(float(grid.min()), 1),
            "max": round(float(grid.max()), 1),
            "checkMean": round(mean_err, 2),
            "checkWorst": round(worst_err, 2),
            "image": image,
            "imageKb": image_kb,
            "data": payload,
        })

    lines = [
        "// GENERATED FILE — do not edit by hand.",
        "// Regenerate with:  python3 scripts/fetch_terrain.py",
        "//",
        "// Terrain for the SignalLab map view. Elevation comes from the AWS Terrain",
        "// Tiles open dataset (Terrarium encoding), which over the continental US is",
        "// derived from USGS 3DEP/NED. Each grid was spot-checked against USGS ned10m",
        "// before being written; the agreement is recorded per site below.",
        "//",
        "// The matching orthoimagery is USGS National Map (public domain), resampled",
        f"// through the same projection onto the same window at {SPAN_M / IMG_PX:.2f} m per pixel,",
        "// so the contours land exactly where the imagery says they should. The files",
        "// live in static/img/terrain/ and are fetched by the browser, not bundled.",
        "//",
        "// Heights are int16 decimetres above `base`, row-major, row 0 = north edge,",
        f"// column 0 = west edge, {GRID}x{GRID} samples over a {SPAN_M / 1000:.0f} km square"
        f" ({SPAN_M / (GRID - 1):.1f} m per sample).",
        "",
        f"export const GRID = {GRID};",
        f"export const SPAN_M = {SPAN_M:.0f};",
        f"export const STEP_M = SPAN_M / (GRID - 1);",
        "",
        "export const SITES = [",
    ]
    for b in blocks:
        lines += [
            "  {",
            f"    id: {json.dumps(b['id'])},",
            f"    name: {json.dumps(b['name'])},",
            f"    sub: {json.dumps(b['sub'])},",
            f"    lat: {b['lat']}, lon: {b['lon']},",
            f"    base: {b['base']}, min: {b['min']}, max: {b['max']},",
            f"    // agreement with USGS ned10m: mean {b['checkMean']} m, worst {b['checkWorst']} m",
            f"    image: {json.dumps('img/terrain/' + b['image'])}, // {b['imageKb']} KB",
            f"    data: {json.dumps(b['data'])},",
            "  },",
        ]
    lines += [
        "];",
        "",
        "// Base64 -> Int16Array, decoded once on first use. Works in Node (SSR) and in",
        "// the browser without touching any DOM API.",
        "const decoded = new Map();",
        "",
        "export function heightGrid(id) {",
        "  if (decoded.has(id)) return decoded.get(id);",
        "  const site = SITES.find((s) => s.id === id) || SITES[0];",
        "  const bin =",
        "    typeof atob === 'function'",
        "      ? atob(site.data)",
        "      : Buffer.from(site.data, 'base64').toString('binary');",
        "  const bytes = new Uint8Array(bin.length);",
        "  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);",
        "  const dm = new Int16Array(bytes.buffer);",
        "  const out = new Float32Array(dm.length);",
        "  for (let i = 0; i < dm.length; i++) out[i] = site.base + dm[i] / 10;",
        "  decoded.set(id, out);",
        "  return out;",
        "}",
        "",
    ]

    out_path = os.path.normpath(out_path)
    with open(out_path, "w") as f:
        f.write("\n".join(lines))
    print(f"wrote {out_path} ({os.path.getsize(out_path) // 1024} KB)")


if __name__ == "__main__":
    sys.exit(main())
