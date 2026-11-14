// ---------- slope.js ----------
// Client-side slope-angle shading. Pulls terrain tiles for raw elevation,
// decodes each pixel into meters, computes slope with the Horn 3x3 algorithm,
// and paints a CalTopo-style color ramp onto a canvas returned as a Leaflet
// tile. Backed by the AWS Open Data "terrarium" tileset — unlimited, no key,
// global coverage. Nothing of value leaves the browser.

L.GridLayer.SlopeShade = L.GridLayer.extend({
    options: {
        tileSize: 256,
        // Terrarium tiles have no data above z15 — Leaflet upscales instead.
        maxNativeZoom: 15,
        // Classic backcountry-skiing ramp: light yellow starts around 27°,
        // reds at 35°+, purple past 45°. Higher-angle stops win because we
        // evaluate highest-first in _paint.
        colorStops: [
            {deg: 60, rgba: [40,  0, 40,  230]},
            {deg: 55, rgba: [100, 0, 100, 220]},
            {deg: 50, rgba: [160, 0, 160, 210]},
            {deg: 45, rgba: [220, 30, 180, 200]},
            {deg: 40, rgba: [230, 20, 60,  200]},
            {deg: 35, rgba: [255, 60, 40,  190]},
            {deg: 32, rgba: [255, 140, 40, 180]},
            {deg: 30, rgba: [255, 210, 40, 170]},
            {deg: 27, rgba: [240, 245, 100, 150]},
        ],
    },

    createTile(coords, done) {
        const size = this.getTileSize();
        const tile = document.createElement('canvas');
        tile.width = size.x;
        tile.height = size.y;

        // AWS Open Data "terrarium" tileset — SRTM-based global DEM, served
        // keyless from S3 with wide-open CORS. No account, no quota.
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/` +
            `${coords.z}/${coords.x}/${coords.y}.png`;
        this._fetchAndPaint(tile, coords, url, done);
        return tile;
    },

    async _fetchAndPaint(tile, coords, url, done) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) {
                this._warnOnce(`Slope layer: terrain tile HTTP ${resp.status}`);
                console.error('[slope]', resp.status, resp.statusText, 'at', url);
                done(new Error(`HTTP ${resp.status}`), tile);
                return;
            }
            const blob = await resp.blob();
            const bitmap = await createImageBitmap(blob);
            this._paint(tile, bitmap, coords);
            done(null, tile);
        } catch (e) {
            this._warnOnce(`Slope layer: ${e.message}`);
            console.error('[slope]', e);
            done(e, tile);
        }
    },

    // Surface the first failure to the user via toast (if available) and the
    // console. Silent on subsequent tiles — one noisy banner per session is
    // enough.
    _warnOnce(msg) {
        if (this._warned) return;
        this._warned = true;
        console.warn('[slope]', msg);
        if (typeof showToast === 'function') showToast(msg, 'warn', 8000);
    },

    // Reusable scratch canvas for reading the source image's pixel data —
    // creating a new one per tile churns GC and shows up in profiling.
    _getScratch(w, h) {
        if (!L.GridLayer.SlopeShade._scratch) {
            L.GridLayer.SlopeShade._scratch = document.createElement('canvas');
        }
        const c = L.GridLayer.SlopeShade._scratch;
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        return c;
    },

    _paint(tile, img, coords) {
        const W = tile.width, H = tile.height;
        const scratch = this._getScratch(W, H);
        const sctx = scratch.getContext('2d');
        sctx.clearRect(0, 0, W, H);
        sctx.drawImage(img, 0, 0, W, H);
        const src = sctx.getImageData(0, 0, W, H).data;

        // Decode RGB → meters using the Terrarium encoding:
        //   height = (R * 256 + G + B / 256) - 32768
        // Different from Mapbox's terrain-rgb; same per-pixel precision at
        // ~5cm resolution, which is well below SRTM's 30m native cell size.
        const elev = new Float32Array(W * H);
        for (let i = 0, p = 0; i < W * H; i++, p += 4) {
            elev[i] = (src[p] * 256 + src[p + 1] + src[p + 2] / 256) - 32768;
        }

        // Pixel size in meters at this tile's center latitude. Web Mercator
        // scale is 156543.03 * cos(lat) / 2^z meters per pixel for 256-pixel
        // tiles — adjust if tileSize differs.
        const n = Math.pow(2, coords.z);
        const centerY = (coords.y + 0.5) / n;
        const centerLatRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * centerY)));
        const pxM = (156543.03392 * Math.cos(centerLatRad) / n) * (256 / W);

        const stops = this.options.colorStops;
        const outImg = new ImageData(W, H);
        const out = outImg.data;
        const Wm1 = W - 1, Hm1 = H - 1;

        for (let y = 0; y < H; y++) {
            // Clamp row indices so edge pixels repeat themselves — avoids a
            // visible 1-pixel seam at tile boundaries.
            const y0 = y > 0 ? y - 1 : 0;
            const y2 = y < Hm1 ? y + 1 : Hm1;
            const r0 = y0 * W, r1 = y * W, r2 = y2 * W;
            for (let x = 0; x < W; x++) {
                const x0 = x > 0 ? x - 1 : 0;
                const x2 = x < Wm1 ? x + 1 : Wm1;
                // Horn 3x3 kernel — same math as gdaldem slope.
                const a = elev[r0 + x0], b = elev[r0 + x], c = elev[r0 + x2];
                const d = elev[r1 + x0],                   f = elev[r1 + x2];
                const g = elev[r2 + x0], h = elev[r2 + x], i = elev[r2 + x2];
                const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * pxM);
                const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * pxM);
                const deg = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;

                const o = (r1 + x) * 4;
                for (const s of stops) {
                    if (deg >= s.deg) {
                        out[o]     = s.rgba[0];
                        out[o + 1] = s.rgba[1];
                        out[o + 2] = s.rgba[2];
                        out[o + 3] = s.rgba[3];
                        break;
                    }
                }
            }
        }
        tile.getContext('2d').putImageData(outImg, 0, 0);
    },
});

L.gridLayer.slopeShade = (opts) => new L.GridLayer.SlopeShade(opts);

// Legend rendered inside the map, reading its color stops directly from the
// SlopeShade class so there's no second source of truth to drift.
L.Control.SlopeLegend = L.Control.extend({
    options: {position: 'bottomleft'},

    onAdd(map) {
        const div = L.DomUtil.create('div', 'slope-legend');
        const stops = [...L.GridLayer.SlopeShade.prototype.options.colorStops]
            .sort((a, b) => a.deg - b.deg);
        // Each stop names the bottom of a bin whose top is the next stop
        // (or "+" for the highest bin).
        const rowsHtml = stops.map((s, i) => {
            const next = stops[i + 1];
            const label = next ? `${s.deg}–${next.deg - 1}°` : `${s.deg}°+`;
            const [r, g, b, a] = s.rgba;
            const rgba = `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;
            return `<div class="slope-legend-row">` +
                `<span class="slope-legend-swatch" style="background:${rgba}"></span>` +
                `<span class="slope-legend-label">${label}</span>` +
                `</div>`;
        }).join('');
        div.innerHTML = `<div class="slope-legend-title">Slope angle</div>${rowsHtml}`;
        L.DomEvent.disableClickPropagation(div);
        return div;
    },
});

L.control.slopeLegend = (opts) => new L.Control.SlopeLegend(opts);
