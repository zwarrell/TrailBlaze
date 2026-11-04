// ---------- spatial.js ----------
// Distance math, spatial grids for fast nearest-neighbour lookups, pixel↔meter
// conversion, snapping, and ghost-point preview markers used by the map tools.

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function totalDistance(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) {
        d += haversineMeters(points[i-1].lat, points[i-1].lon, points[i].lat, points[i].lon);
    }
    return d;
}

// ---------- Spatial grid ----------
function buildGrid(points, cellDeg) {
    const grid = new Map();
    for (const p of points) {
        const i = Math.floor(p.lat / cellDeg);
        const j = Math.floor(p.lon / cellDeg);
        const k = i + ',' + j;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(p);
    }
    return {grid, cellDeg};
}

function minDistanceToGrid(lat, lon, gridObj) {
    const {grid, cellDeg} = gridObj;
    const ci = Math.floor(lat / cellDeg);
    const cj = Math.floor(lon / cellDeg);
    let min = Infinity;
    for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
            const cell = grid.get((ci + di) + ',' + (cj + dj));
            if (!cell) continue;
            for (const p of cell) {
                const d = haversineMeters(lat, lon, p.lat, p.lon);
                if (d < min) min = d;
            }
        }
    }
    return min;
}

// Fast "is any base point within `threshold` of this location?" — early-exits
// on the first hit, so it's much faster than minDistanceToGrid when we only
// need a yes/no answer (classification, relevance).
function anyPointWithin(lat, lon, gridObj, threshold) {
    const {grid, cellDeg} = gridObj;
    const cellSpanM = cellDeg * 111000;
    const span = Math.max(1, Math.ceil(threshold / cellSpanM));
    const ci = Math.floor(lat / cellDeg);
    const cj = Math.floor(lon / cellDeg);
    const t2 = threshold; // convenience
    for (let di = -span; di <= span; di++) {
        for (let dj = -span; dj <= span; dj++) {
            const cell = grid.get((ci + di) + ',' + (cj + dj));
            if (!cell) continue;
            for (const p of cell) {
                if (haversineMeters(lat, lon, p.lat, p.lon) < t2) return true;
            }
        }
    }
    return false;
}

// Ghost marker shown in split mode over a hovered track to show where the
// split will land. Placed at the nearest vertex to the cursor.
function showGhostPoint(latlng) {
    if (!state.ghostPoint) {
        state.ghostPoint = L.circleMarker(latlng, {
            radius: 7,
            color: '#e63946',
            fillColor: '#ffdd00',
            fillOpacity: 0.85,
            weight: 2,
            interactive: false,
        }).addTo(map);
    } else {
        state.ghostPoint.setLatLng(latlng);
    }
}
function hideGhostPoint() {
    if (state.ghostPoint) {
        map.removeLayer(state.ghostPoint);
        state.ghostPoint = null;
    }
}
function nearestLatLngOn(line, latlng) {
    const latlngs = line.getLatLngs();
    let best = latlngs[0], bestDist = Infinity;
    for (const ll of latlngs) {
        const d = latlng.distanceTo(ll);
        if (d < bestDist) { bestDist = d; best = ll; }
    }
    return best;
}

// Convert screen pixels to meters at the current map center/zoom.
function pixelsToMeters(px) {
    const c = map.getCenter();
    const p1 = map.latLngToContainerPoint(c);
    const p2 = L.point(p1.x + px, p1.y);
    return c.distanceTo(map.containerPointToLatLng(p2));
}

// Find the closest track vertex (base or novel-ride) to latlng, within
// pxThreshold screen pixels. Returns {latlng, line, kind: 'base'|'ride'}
// or null.
function findSplitCandidate(latlng, pxThreshold = 40) {
    const thresholdM = pixelsToMeters(pxThreshold);
    let best = null;
    const check = (line, kind) => {
        if (!line || typeof line.getLatLngs !== 'function') return;
        for (const ll of line.getLatLngs()) {
            const d = latlng.distanceTo(ll);
            if (!best || d < best.dist) best = {latlng: ll, line, kind, dist: d};
        }
    };
    if (state.baseLayer) state.baseLayer.eachLayer(l => check(l, 'base'));
    for (const seg of state.segments) {
        if (seg.novel) check(seg.layer, 'ride');
    }
    if (best && best.dist <= thresholdM) return best;
    return null;
}

// Find the closest base-track point to latlng, within a pixel-derived
// threshold. Returns a LatLng if snapping should apply, else null.
function findSnap(latlng) {
    if (!state.baseGrid || !state.basePoints.length) return null;
    const thresholdM = pixelsToMeters(15);
    const {grid, cellDeg} = state.baseGrid;
    const cellSpanM = cellDeg * 111000;
    const span = Math.max(1, Math.ceil(thresholdM / cellSpanM));
    const ci = Math.floor(latlng.lat / cellDeg);
    const cj = Math.floor(latlng.lng / cellDeg);
    let best = null, bestDist = Infinity;
    for (let di = -span; di <= span; di++) {
        for (let dj = -span; dj <= span; dj++) {
            const cell = grid.get((ci + di) + ',' + (cj + dj));
            if (!cell) continue;
            for (const p of cell) {
                const d = haversineMeters(latlng.lat, latlng.lng, p.lat, p.lon);
                if (d < bestDist) { bestDist = d; best = p; }
            }
        }
    }
    if (best && bestDist <= thresholdM) return L.latLng(best.lat, best.lon);
    return null;
}

function ptLatLng(trkpt) {
    return {
        lat: parseFloat(trkpt.getAttribute('lat')),
        lon: parseFloat(trkpt.getAttribute('lon')),
    };
}

// ---------- Track graph ----------
// Build an undirected graph from every trkseg / rte in the active base doc.
// Three widening steps handle real-world GPX where tracks that visually meet
// often don't share a vertex:
//   TRACK_GRAPH_SNAP_M — coincident-vertex dedup (shared start/end points).
//   JUNCTION_PROJECT_M — T-intersection: a vertex sits on another's edge.
//   BRIDGE_DEAD_END_M  — dangling endpoint sits near any other node.
// DRAW_ROUTE_SIMPLIFY_M thins the routed path at click-time so a drawn
// track is less dense than the source track it followed.
const TRACK_GRAPH_SNAP_M = 3;
const JUNCTION_PROJECT_M = 12;
const BRIDGE_DEAD_END_M = 30;
const DRAW_ROUTE_SIMPLIFY_M = 3;
function buildTrackGraph(docs) {
    if (!Array.isArray(docs)) docs = [docs];
    const nodes = [];       // [{lat, lon}]
    const adj = [];         // [[{to, dist}, ...]]
    const keyIndex = new Map();
    // cellDeg must be ≥ snap radius so adjacent grid cells still catch snaps
    // close to a cell boundary. 3m ≈ 2.7e-5 deg at the equator; use 1e-4 deg
    // (~11m) so one cell lookup is always enough.
    const cellDeg = 1e-4;
    const gridKey = (lat, lon) => Math.floor(lat / cellDeg) + ',' + Math.floor(lon / cellDeg);
    const grid = new Map();

    const findOrInsertNode = (lat, lon) => {
        const ci = Math.floor(lat / cellDeg);
        const cj = Math.floor(lon / cellDeg);
        for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
                const cell = grid.get((ci + di) + ',' + (cj + dj));
                if (!cell) continue;
                for (const idx of cell) {
                    const n = nodes[idx];
                    if (haversineMeters(lat, lon, n.lat, n.lon) < TRACK_GRAPH_SNAP_M) return idx;
                }
            }
        }
        const idx = nodes.length;
        nodes.push({lat, lon});
        adj.push([]);
        const k = ci + ',' + cj;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(idx);
        return idx;
    };

    const addEdge = (a, b, dist) => {
        if (a === b) return;
        // Dedup — keep the shortest if a parallel edge already exists.
        for (const e of adj[a]) if (e.to === b) { if (dist < e.dist) e.dist = dist; return; }
        adj[a].push({to: b, dist});
        adj[b].push({to: a, dist});
    };

    const addPolyline = (points) => {
        let prevIdx = -1, prev = null;
        for (const p of points) {
            if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) { prevIdx = -1; prev = null; continue; }
            const idx = findOrInsertNode(p.lat, p.lon);
            if (prevIdx !== -1 && idx !== prevIdx) {
                addEdge(prevIdx, idx, haversineMeters(prev.lat, prev.lon, p.lat, p.lon));
            }
            prevIdx = idx;
            prev = p;
        }
    };

    for (const doc of docs) {
        if (!doc) continue;
        for (const trkseg of doc.getElementsByTagName('trkseg')) {
            const pts = [];
            for (const pt of trkseg.getElementsByTagName('trkpt')) {
                pts.push({lat: parseFloat(pt.getAttribute('lat')), lon: parseFloat(pt.getAttribute('lon'))});
            }
            addPolyline(pts);
        }
        for (const rte of doc.getElementsByTagName('rte')) {
            const pts = [];
            for (const pt of rte.getElementsByTagName('rtept')) {
                pts.push({lat: parseFloat(pt.getAttribute('lat')), lon: parseFloat(pt.getAttribute('lon'))});
            }
            addPolyline(pts);
        }
    }

    const graph = {nodes, adj, grid, cellDeg};
    connectJunctions(graph, JUNCTION_PROJECT_M);
    bridgeDeadEnds(graph, BRIDGE_DEAD_END_M);
    return graph;
}

// Bridge dead-end nodes (degree ≤ 1) to their nearest other graph node
// within toleranceM, provided no direct edge already exists. Fills small
// gaps between tracks that end close to another track without crossing it.
// Only dead-ends get bridges so parallel tracks don't get spuriously
// stitched together at every nearby vertex pair.
function bridgeDeadEnds(graph, toleranceM) {
    const {nodes, adj, grid, cellDeg} = graph;
    const span = Math.max(1, Math.ceil(toleranceM / (cellDeg * 111000)));
    const bridges = [];
    for (let v = 0; v < nodes.length; v++) {
        if (adj[v].length > 1) continue;
        const nV = nodes[v];
        const ci = Math.floor(nV.lat / cellDeg);
        const cj = Math.floor(nV.lon / cellDeg);
        let bestIdx = -1, bestDist = Infinity;
        for (let di = -span; di <= span; di++) {
            for (let dj = -span; dj <= span; dj++) {
                const cell = grid.get((ci + di) + ',' + (cj + dj));
                if (!cell) continue;
                for (const idx of cell) {
                    if (idx === v) continue;
                    if (adj[v].some(e => e.to === idx)) continue;
                    const d = haversineMeters(nV.lat, nV.lon, nodes[idx].lat, nodes[idx].lon);
                    if (d < bestDist) { bestDist = d; bestIdx = idx; }
                }
            }
        }
        if (bestIdx !== -1 && bestDist <= toleranceM) {
            bridges.push({u: v, w: bestIdx, d: bestDist});
        }
    }
    for (const b of bridges) {
        if (adj[b.u].some(e => e.to === b.w)) continue;
        adj[b.u].push({to: b.w, dist: b.d});
        adj[b.w].push({to: b.u, dist: b.d});
    }
}

// Perpendicular projection parameter t and distance for point P onto segment
// AB, in the local equirectangular plane. t ∈ R (not clamped) so callers can
// reject projections outside the segment interior.
function projectOntoSegment(p, a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const lat0 = toRad((a.lat + b.lat) / 2);
    const scale = Math.cos(lat0);
    const bx = (b.lon - a.lon) * scale * R * Math.PI / 180;
    const by = (b.lat - a.lat) * R * Math.PI / 180;
    const px = (p.lon - a.lon) * scale * R * Math.PI / 180;
    const py = (p.lat - a.lat) * R * Math.PI / 180;
    const lenSq = bx * bx + by * by;
    if (lenSq === 0) return {t: 0, dist: Math.hypot(px, py)};
    const t = (px * bx + py * by) / lenSq;
    const tC = Math.max(0, Math.min(1, t));
    const fx = tC * bx, fy = tC * by;
    return {t, dist: Math.hypot(px - fx, py - fy)};
}

// Detect T-junctions — any node V that lies within toleranceM of a non-
// incident edge (A,B) gets injected as a midpoint of that edge, splitting it
// into (A,V) and (V,B). This is what lets a draw-route "jump" between tracks
// whose GPX vertices happen not to coincide at their visual intersection.
function connectJunctions(graph, toleranceM) {
    const {nodes, adj, cellDeg} = graph;
    // 1. Snapshot the current edges (undirected, canonical u < v).
    const edges = [];
    for (let u = 0; u < nodes.length; u++) {
        for (const e of adj[u]) if (u < e.to) edges.push({u, v: e.to});
    }
    if (!edges.length) return;
    // 2. Index edges by every grid cell their bbox overlaps. Cells match the
    //    node grid so span math works for both.
    const edgeCell = new Map();
    const pushCell = (k, ei) => {
        const arr = edgeCell.get(k);
        if (arr) arr.push(ei); else edgeCell.set(k, [ei]);
    };
    edges.forEach((e, ei) => {
        const a = nodes[e.u], b = nodes[e.v];
        const ciMin = Math.floor(Math.min(a.lat, b.lat) / cellDeg);
        const ciMax = Math.floor(Math.max(a.lat, b.lat) / cellDeg);
        const cjMin = Math.floor(Math.min(a.lon, b.lon) / cellDeg);
        const cjMax = Math.floor(Math.max(a.lon, b.lon) / cellDeg);
        for (let ci = ciMin; ci <= ciMax; ci++) {
            for (let cj = cjMin; cj <= cjMax; cj++) pushCell(ci + ',' + cj, ei);
        }
    });
    // 3. For each node, find candidate edges in nearby cells; record splits.
    const splitters = new Map(); // edgeIdx → [{nodeIdx, t, dist}]
    const span = Math.max(1, Math.ceil(toleranceM / (cellDeg * 111000)));
    for (let v = 0; v < nodes.length; v++) {
        const nV = nodes[v];
        const ci = Math.floor(nV.lat / cellDeg);
        const cj = Math.floor(nV.lon / cellDeg);
        const seen = new Set();
        for (let di = -span; di <= span; di++) {
            for (let dj = -span; dj <= span; dj++) {
                const cell = edgeCell.get((ci + di) + ',' + (cj + dj));
                if (!cell) continue;
                for (const ei of cell) {
                    if (seen.has(ei)) continue;
                    seen.add(ei);
                    const e = edges[ei];
                    if (e.u === v || e.v === v) continue;
                    const {t, dist} = projectOntoSegment(nV, nodes[e.u], nodes[e.v]);
                    if (dist > toleranceM) continue;
                    // Interior only — t at ~0 or ~1 means V is already at the
                    // edge's endpoint (would've been deduped in buildTrackGraph).
                    if (t <= 0.02 || t >= 0.98) continue;
                    let arr = splitters.get(ei);
                    if (!arr) { arr = []; splitters.set(ei, arr); }
                    arr.push({nodeIdx: v, t});
                }
            }
        }
    }
    // 4. Apply: for each split edge, remove the original u↔v edge and chain
    //    through the splitting nodes in increasing t order.
    for (const [ei, arr] of splitters) {
        arr.sort((x, y) => x.t - y.t);
        const {u, v} = edges[ei];
        const uIdx = adj[u].findIndex(e => e.to === v);
        if (uIdx !== -1) adj[u].splice(uIdx, 1);
        const vIdx = adj[v].findIndex(e => e.to === u);
        if (vIdx !== -1) adj[v].splice(vIdx, 1);
        const chain = [u, ...arr.map(x => x.nodeIdx), v];
        for (let i = 0; i < chain.length - 1; i++) {
            const a = chain[i], b = chain[i + 1];
            if (a === b) continue;
            const d = haversineMeters(nodes[a].lat, nodes[a].lon, nodes[b].lat, nodes[b].lon);
            // Dedup — the sub-edge may already exist if the chain revisits.
            if (!adj[a].some(e => e.to === b)) {
                adj[a].push({to: b, dist: d});
                adj[b].push({to: a, dist: d});
            }
        }
    }
}

// Collect the docs that should feed the snap graph — the active base plus
// every visible overlay base. Overlays let draw-mode route onto tracks from
// view-only GPX files loaded alongside the one being edited.
function collectSnapDocs() {
    const docs = [];
    if (state.baseXmlDoc) docs.push(state.baseXmlDoc);
    if (state.visibleBaseNames && state.baseCache) {
        for (const name of state.visibleBaseNames) {
            if (name === state.activeBaseName) continue;
            const entry = state.baseCache.get(name);
            if (entry?.xmlDoc) docs.push(entry.xmlDoc);
        }
    }
    return docs;
}

// Ensure state.trackGraph matches the current snap-doc set. Cheap when
// already in sync (shallow reference-array check); rebuilds on any doc swap
// (active edit, overlay toggle, new file load).
function ensureTrackGraph() {
    const docs = collectSnapDocs();
    if (!docs.length) { state.trackGraph = null; return null; }
    const g = state.trackGraph;
    if (g && g._docs && g._docs.length === docs.length && g._docs.every((d, i) => d === docs[i])) {
        return g;
    }
    state.trackGraph = buildTrackGraph(docs);
    state.trackGraph._docs = docs;
    return state.trackGraph;
}

// Nearest graph node to latlng within pxThreshold screen pixels. Returns
// {idx, latlng, dist} or null. Used by the snap-to-tracks draw mode.
function findSnapNode(latlng, pxThreshold = 15) {
    const g = ensureTrackGraph();
    if (!g || !g.nodes.length) return null;
    const thresholdM = pixelsToMeters(pxThreshold);
    const {cellDeg, grid, nodes} = g;
    const cellSpanM = cellDeg * 111000;
    const span = Math.max(1, Math.ceil(thresholdM / cellSpanM));
    const ci = Math.floor(latlng.lat / cellDeg);
    const cj = Math.floor(latlng.lng / cellDeg);
    let bestIdx = -1, bestDist = Infinity;
    for (let di = -span; di <= span; di++) {
        for (let dj = -span; dj <= span; dj++) {
            const cell = grid.get((ci + di) + ',' + (cj + dj));
            if (!cell) continue;
            for (const idx of cell) {
                const n = nodes[idx];
                const d = haversineMeters(latlng.lat, latlng.lng, n.lat, n.lon);
                if (d < bestDist) { bestDist = d; bestIdx = idx; }
            }
        }
    }
    if (bestIdx === -1 || bestDist > thresholdM) return null;
    return {idx: bestIdx, latlng: L.latLng(nodes[bestIdx].lat, nodes[bestIdx].lon), dist: bestDist};
}

// Dijkstra shortest path from node fromIdx to toIdx. Returns an array of node
// indices (inclusive at both ends) or null if disconnected.
function shortestPathOnTracks(fromIdx, toIdx) {
    const g = ensureTrackGraph();
    if (!g || fromIdx === toIdx) return fromIdx === toIdx ? [fromIdx] : null;
    const n = g.nodes.length;
    const dist = new Float64Array(n);
    const prev = new Int32Array(n);
    const visited = new Uint8Array(n);
    for (let i = 0; i < n; i++) { dist[i] = Infinity; prev[i] = -1; }
    dist[fromIdx] = 0;
    // Binary heap keyed on dist. Entries are [dist, nodeIdx]; stale entries
    // are tolerated (we skip when visited).
    const heap = [[0, fromIdx]];
    const heapPush = (v) => {
        heap.push(v);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p][0] <= heap[i][0]) break;
            [heap[p], heap[i]] = [heap[i], heap[p]];
            i = p;
        }
    };
    const heapPop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = 2 * i + 2;
                let m = i;
                if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                if (m === i) break;
                [heap[m], heap[i]] = [heap[i], heap[m]];
                i = m;
            }
        }
        return top;
    };
    while (heap.length) {
        const [d, u] = heapPop();
        if (visited[u]) continue;
        visited[u] = 1;
        if (u === toIdx) break;
        if (d > dist[u]) continue;
        for (const e of g.adj[u]) {
            if (visited[e.to]) continue;
            const nd = d + e.dist;
            if (nd < dist[e.to]) {
                dist[e.to] = nd;
                prev[e.to] = u;
                heapPush([nd, e.to]);
            }
        }
    }
    if (dist[toIdx] === Infinity) return null;
    const path = [];
    for (let u = toIdx; u !== -1; u = prev[u]) path.push(u);
    path.reverse();
    return path;
}

// ---------- Resampling ----------
// Perpendicular distance in meters from point P to the line segment AB,
// using an equirectangular projection centered on the segment midpoint. Good
// to sub-meter accuracy at the scales GPX tracks cover.
function perpDistanceM(p, a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const lat0 = toRad((a.lat + b.lat) / 2);
    const scale = Math.cos(lat0);
    const bx = (b.lon - a.lon) * scale * R * Math.PI / 180;
    const by = (b.lat - a.lat) * R * Math.PI / 180;
    const px = (p.lon - a.lon) * scale * R * Math.PI / 180;
    const py = (p.lat - a.lat) * R * Math.PI / 180;
    const lenSq = bx * bx + by * by;
    if (lenSq === 0) return Math.hypot(px, py);
    let t = (px * bx + py * by) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const dxp = px - t * bx, dyp = py - t * by;
    return Math.hypot(dxp, dyp);
}

// Iterative Douglas-Peucker. Returns a boolean keep[] array parallel to
// points. First and last are always kept so endpoints anchor the track.
function douglasPeuckerKeep(points, toleranceM) {
    const n = points.length;
    const keep = new Array(n).fill(false);
    if (n === 0) return keep;
    keep[0] = true;
    keep[n - 1] = true;
    if (n < 3) return keep;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let maxDist = -1, maxIdx = -1;
        for (let i = a + 1; i < b; i++) {
            const d = perpDistanceM(points[i], points[a], points[b]);
            if (d > maxDist) { maxDist = d; maxIdx = i; }
        }
        if (maxDist > toleranceM && maxIdx !== -1) {
            keep[maxIdx] = true;
            stack.push([a, maxIdx]);
            stack.push([maxIdx, b]);
        }
    }
    return keep;
}
