/**
 * js/curl-geometry.js - Pure stateless finite-sheet page curl geometry.
 * Shared verbatim by production WebGL rendering and Node boundary tests.
 */

const PI = Math.PI

export function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v))
}

function dist2(a, b) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return dx * dx + dy * dy
}

export function smoothstep(a, b, x) {
    if (b === a) return x >= b ? 1 : 0
    const t = clamp((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)
}

/**
 * Compute viewport-proportional curl scale parameters.
 * Ensures consistent curvature radius and depth range from 360px phones to wide tablets.
 */
export function computeCurlMetrics(W, H) {
    const safeW = Math.max(1, Number(W) || 420)
    const safeH = Math.max(1, Number(H) || 940)
    const cornerZone = Math.min(safeW * 0.065, safeH * 0.035)
    const z0 = cornerZone * 0.6
    const z1 = cornerZone * 1.65
    const baseR = clamp(safeW * 0.012, 4, 14)
    const spanR = clamp(safeW * 0.038, 12, 36)
    const minRadius = Math.max(0.025, safeW * 1e-4)
    const zScale = Math.max(200, safeW * 0.95)
    const areaEps = Math.max(1e-9, safeW * safeH * 1e-12)
    return { W: safeW, H: safeH, cornerZone, z0, z1, baseR, spanR, minRadius, zScale, areaEps }
}

/**
 * C1 continuous corner-snap anchor mapping on [0, H] (no step discontinuity across cornerZone).
 */
export function computeSmoothAnchorY(rawY, W, H) {
    const m = computeCurlMetrics(W, H)
    const inputY = clamp(rawY, 0, m.H)
    if (inputY <= m.z0) return 0
    if (inputY < m.z1) return inputY * smoothstep(m.z0, m.z1, inputY)
    if (inputY >= m.H - m.z0) return m.H
    if (inputY > m.H - m.z1) {
        return m.H + (inputY - m.H) * (1 - smoothstep(m.H - m.z1, m.H - m.z0, inputY))
    }
    return inputY
}

/**
 * Spine-safe vertical steering limit. Grows O(inward^2 / edgeDistance) near inward -> 0
 * so small touches near a corner cannot instantaneously flip the opposite corner across H,
 * while giving middle-edge grabs smooth diagonal responsiveness up to inward * (W / edgeDistance).
 */
function computeMaxDY(inward, edgeDistance, W, cY, H) {
    if (edgeDistance <= 1e-8) return Infinity
    if (inward <= 0) return 0
    const spineLimit = inward * (W / edgeDistance)
    const midWeight = Math.sin(PI * clamp(cY / Math.max(1, H), 0, 1))
    const gain = 1 + 3.0 * midWeight * smoothstep(0, W * 0.22, inward)
    const wedgeSafeLimit = (gain * inward * inward) / edgeDistance
    return Math.min(spineLimit, wedgeSafeLimit)
}

/**
 * Continuous convex projection onto the intersection of two spine-centered disks.
 */
export function projectGrab(p, c, W, H) {
    const a = { x: 0, y: 0 }
    const b = { x: 0, y: H }
    const ra = Math.hypot(W, c.y)
    const rb = Math.hypot(W, H - c.y)
    const inDisk = (q, o, r) => dist2(q, o) <= r * r + 1e-7
    if (inDisk(p, a, ra) && inDisk(p, b, rb)) return { x: p.x, y: p.y }

    const candidates = [{ x: c.x, y: c.y }, { x: -W, y: c.y }]
    for (const [o, r, other, otherR] of [[a, ra, b, rb], [b, rb, a, ra]]) {
        const d = Math.hypot(p.x - o.x, p.y - o.y)
        if (d > 0) {
            const q = { x: o.x + (p.x - o.x) * r / d, y: o.y + (p.y - o.y) * r / d }
            if (inDisk(q, other, otherR)) candidates.push(q)
        }
    }
    return candidates.reduce((best, q) => (dist2(q, p) < dist2(best, p) ? q : best), candidates[0])
}

export function grabDistance(s, R) {
    if (R === 0) return 2 * s
    return s >= PI * R ? 2 * s - PI * R : s - R * Math.sin(s / R)
}

export function solveS(D, R) {
    if (R === 0) return D / 2
    if (D >= PI * R) return (D + PI * R) / 2
    let lo = 0
    let hi = PI * R
    for (let i = 0; i < 42; i++) {
        const s = (lo + hi) / 2
        if (grabDistance(s, R) < D) lo = s
        else hi = s
    }
    return (lo + hi) / 2
}

/**
 * Compute finite-sheet curl parameters for a control pose { dir, c, d } in W x H coordinates.
 */
export function geometry(p, W, H) {
    const metrics = computeCurlMetrics(W, H)
    const safeW = metrics.W
    const safeH = metrics.H
    if (!p) {
        return {
            flat: true,
            W: safeW,
            H: safeH,
            zScale: metrics.zScale,
            areaEps: metrics.areaEps,
            R: 0,
            n: { x: 1, y: 0 },
            o: { x: safeW, y: 0 },
            dir: 'next',
            progress: 0,
            crossedOrigin: false,
        }
    }

    const reflected = p.dir === 'prev'
    const toCanonical = (q) => ({ x: reflected ? safeW - q.x : q.x, y: q.y })
    const inputY = clamp(p.c.y, 0, safeH)
    const anchorY = computeSmoothAnchorY(inputY, safeW, safeH)
    const c = { x: safeW, y: anchorY }
    const raw = toCanonical(p.d)
    raw.y += anchorY - inputY

    if (raw.x >= safeW) {
        return {
            flat: true,
            W: safeW,
            H: safeH,
            zScale: metrics.zScale,
            areaEps: metrics.areaEps,
            R: 0,
            n: { x: 1, y: 0 },
            o: { x: safeW, y: 0 },
            dir: p.dir,
            progress: 0,
            crossedOrigin: raw.x > safeW,
            grab: { ...c },
            c,
        }
    }

    const inward = safeW - raw.x
    const rawDY = c.y - raw.y
    const edgeDistance = rawDY >= 0 ? safeH - c.y : c.y
    const maxDY = computeMaxDY(inward, edgeDistance, safeW, c.y, safeH)
    const effectiveDY = maxDY > 0 ? rawDY / Math.hypot(1, rawDY / maxDY) : 0
    const steered = { x: raw.x, y: c.y - effectiveDY }
    const reachable = projectGrab(steered, c, safeW, safeH)
    const dx = c.x - reachable.x
    const dy = c.y - reachable.y
    const requestedDistance = Math.hypot(dx, dy)

    if (requestedDistance < 1e-6) {
        return {
            flat: true,
            W: safeW,
            H: safeH,
            zScale: metrics.zScale,
            areaEps: metrics.areaEps,
            R: 0,
            n: { x: 1, y: 0 },
            o: { x: safeW, y: 0 },
            dir: p.dir,
            progress: 0,
            crossedOrigin: false,
            grab: reachable,
            c,
        }
    }

    const n = { x: dx / requestedDistance, y: dy / requestedDistance }
    const maxS = Math.max(0, Math.min(safeW * n.x + c.y * n.y, safeW * n.x + (c.y - safeH) * n.y))
    const progress = clamp((safeW - reachable.x) / (1.45 * safeW), 0, 1)
    let R = (metrics.baseR + metrics.spanR * Math.sqrt(clamp(requestedDistance / safeW, 0, 1))) *
        (1 - smoothstep(0.87, 1, progress))
    if (R < metrics.minRadius) R = 0

    const D = Math.min(requestedDistance, Math.max(0, grabDistance(maxS, R)))
    const grab = { x: c.x - D * n.x, y: c.y - D * n.y }
    const s = solveS(D, R)
    const o = { x: c.x - s * n.x, y: c.y - s * n.y }

    return {
        flat: false,
        W: safeW,
        H: safeH,
        zScale: metrics.zScale,
        areaEps: metrics.areaEps,
        R,
        n,
        o,
        dir: p.dir,
        progress,
        crossedOrigin: false,
        grab,
        raw,
        c,
        s,
        maxS,
        reachable,
        projected: dist2(reachable, steered) > 0.01,
        constrained: dist2(grab, raw) > 0.01,
    }
}

/**
 * Generalized control-point rebaser for BOTH corner and middle grabs.
 * Removes unreachable pointer overshoot while preserving the exact drawn sheet pose.
 */
export function rebaseControlPoint(p, g) {
    if (!p || !g || g.flat || !g.projected) return null
    const inward = g.W - g.reachable.x
    if (inward <= 1e-8) return null

    const effectiveDY = g.c.y - g.reachable.y
    const edgeDistance = effectiveDY >= 0 ? g.H - g.c.y : g.c.y
    let rawDY = effectiveDY
    if (edgeDistance > 1e-8) {
        const maxDY = computeMaxDY(inward, edgeDistance, g.W, g.c.y, g.H)
        if (!(maxDY > 1e-12)) return null
        const ratio = Math.abs(effectiveDY) / maxDY
        if (!Number.isFinite(ratio) || ratio >= 1 - 1e-10) return null
        rawDY = effectiveDY / Math.sqrt(1 - ratio * ratio)
    }

    const inputY = clamp(p.c.y, 0, g.H)
    return {
        x: p.dir === 'prev' ? g.W - g.reachable.x : g.reachable.x,
        y: inputY - rawDY,
    }
}

// Keep alias so shared test harnesses work with both names cleanly.
export const rebaseCornerControl = rebaseControlPoint

/**
 * Advance a live drag control pose smoothly, supporting mid-drag next <-> prev reversal
 * and middle-edge overshoot rebasing without stale offset deadlock.
 */
export function advanceDragControl(state, dx, dy, { W, H, canTurnNext = true, canTurnPrev = true } = {}) {
    const safeW = Math.max(1, Number(W) || 420)
    const safeH = Math.max(1, Number(H) || 940)
    const startY = clamp(state.startY ?? safeH * 0.5, 0, safeH)
    const scaledDx = dx * 1.25
    let dir = state.dir
    let c = state.c ? { ...state.c } : { x: dir === 'next' ? safeW : 0, y: startY }
    let baseD = state.baseD ? { ...state.baseD } : { x: c.x, y: c.y }
    let d = { x: baseD.x + scaledDx, y: baseD.y + dy }

    // Switch seamlessly across flat edge when user sweeps past start origin.
    if (dir === 'next' && d.x > safeW) {
        const overshoot = d.x - safeW
        if (canTurnPrev && overshoot > 0) {
            dir = 'prev'
            c = { x: 0, y: startY }
            d = { x: overshoot, y: startY + dy }
            baseD = { x: d.x - scaledDx, y: d.y - dy }
        } else {
            d = { x: safeW, y: c.y }
        }
    } else if (dir === 'prev' && d.x < 0) {
        const overshoot = -d.x
        if (canTurnNext && overshoot > 0) {
            dir = 'next'
            c = { x: safeW, y: startY }
            d = { x: safeW - overshoot, y: startY + dy }
            baseD = { x: d.x - scaledDx, y: d.y - dy }
        } else {
            d = { x: 0, y: c.y }
        }
    }

    let pose = { dir, c, d }
    let g = geometry(pose, safeW, safeH)
    const rebased = rebaseControlPoint(pose, g)
    if (rebased) {
        d = rebased
        baseD = { x: rebased.x - scaledDx, y: rebased.y - dy }
        pose = { dir, c, d }
        g = geometry(pose, safeW, safeH)
    }

    return { dir, startY, c, d, baseD, pose, geometry: g }
}

/**
 * Evaluate release commit/snapback and construct a bounded cubic Hermite settle plan.
 */
export function createSettlePlan(pose, velocity, commit, W, H, options = {}) {
    const safeW = Math.max(1, Number(W) || 420)
    const safeH = Math.max(1, Number(H) || 940)
    const dir = pose?.dir === 'prev' ? 'prev' : 'next'
    const c = pose?.c ? { x: pose.c.x, y: clamp(pose.c.y, 0, safeH) } : { x: dir === 'next' ? safeW : 0, y: safeH * 0.5 }
    const from = pose?.d ? { x: pose.d.x, y: pose.d.y } : { ...c }
    const to = commit
        ? { x: dir === 'next' ? -safeW : 2 * safeW, y: c.y }
        : { x: dir === 'next' ? safeW : 0, y: c.y }

    const dist = Math.hypot(from.x - to.x, from.y - to.y)
    const duration = Number.isFinite(options.duration)
        ? Math.max(0, options.duration)
        : Math.min(options.maxDuration ?? 280, clamp((dist / safeW) * 145 + 110, 140, 280))

    const vx = clamp(Number(velocity?.vx ?? velocity?.x ?? 0) || 0, -1.5, 1.5)
    const vy = clamp(Number(velocity?.vy ?? velocity?.y ?? 0) || 0, -1.5, 1.5)

    // PCHIP-style tangent clamp keeps X monotonic inside valid bounds (never pops flat mid-snapback).
    const dx = to.x - from.x
    let mx = vx * duration
    if (Math.abs(dx) < 1e-6) {
        mx = 0
    } else if (mx * dx >= 0) {
        const maxMono = 2.6 * Math.abs(dx)
        mx = clamp(mx, -maxMono, maxMono)
    } else {
        const maxBack = Math.min(0.12 * safeW, 0.25 * Math.abs(dx))
        mx = clamp(mx, -maxBack, maxBack)
    }

    const dy = to.y - from.y
    const maxMy = 1.8 * Math.max(Math.abs(dy), 0.15 * safeH)
    const my = clamp(vy * duration, -maxMy, maxMy)

    return { dir, c, from, to, m: { x: mx, y: my }, commit: Boolean(commit), duration, W: safeW, H: safeH }
}

/**
 * Evaluate bounded Hermite pose at normalized settle progress p in [0, 1].
 */
export function evaluateSettlePose(plan, progress) {
    const p = clamp(progress, 0, 1)
    const p2 = p * p
    const p3 = p2 * p
    const h00 = 2 * p3 - 3 * p2 + 1
    const h10 = p3 - 2 * p2 + p
    const h01 = -2 * p3 + 3 * p2

    const safeW = plan.W
    const safeH = plan.H
    let x = h00 * plan.from.x + h10 * plan.m.x + h01 * plan.to.x
    let y = h00 * plan.from.y + h10 * plan.m.y + h01 * plan.to.y

    if (p >= 1) {
        x = plan.to.x
        y = plan.to.y
    } else if (plan.dir === 'next') {
        const minX = Math.min(plan.from.x, plan.to.x, -safeW)
        const maxX = plan.commit ? safeW : safeW - 1e-3
        x = clamp(x, minX, maxX)
    } else {
        const minX = plan.commit ? 0 : 1e-3
        const maxX = Math.max(plan.from.x, plan.to.x, 2 * safeW)
        x = clamp(x, minX, maxX)
    }
    y = clamp(y, -0.25 * safeH, 1.25 * safeH)

    return { dir: plan.dir, c: { ...plan.c }, d: { x, y } }
}

export function deform(p, g) {
    if (g.flat) return { x: p.x, y: p.y, z: 0, nx: 0, ny: 0, nz: 1 }
    const reflected = g.dir === 'prev'
    const x = reflected ? g.W - p.x : p.x
    const s = (x - g.o.x) * g.n.x + (p.y - g.o.y) * g.n.y
    const q = (x - g.o.x) * -g.n.y + (p.y - g.o.y) * g.n.x

    let h = s
    let z = 0
    let sin = 0
    let cos = 1
    if (s > 0) {
        if (g.R && s < PI * g.R) {
            const t = clamp(s / g.R, 0, PI)
            sin = Math.sin(t)
            cos = Math.cos(t)
            h = g.R * sin
            z = g.R * (1 - cos)
        } else {
            h = -(s - PI * g.R)
            z = 2 * g.R
            cos = -1
        }
    }

    let outX = g.o.x - q * g.n.y + h * g.n.x
    let nx = -sin * g.n.x
    if (reflected) {
        outX = g.W - outX
        nx = -nx
    }
    return { x: outX, y: g.o.y + q * g.n.x + h * g.n.y, z, nx, ny: -sin * g.n.y, nz: cos }
}

export function clip(poly, g, threshold, greater) {
    if (!poly.length) return []
    const value = (pt) => ((g.dir === 'prev' ? g.W - pt.x : pt.x) - g.o.x) * g.n.x + (pt.y - g.o.y) * g.n.y - threshold
    const out = []
    let a = poly[poly.length - 1]
    let av = value(a)
    for (const b of poly) {
        const bv = value(b)
        const ai = greater ? av >= 0 : av <= 0
        const bi = greater ? bv >= 0 : bv <= 0
        if (ai !== bi) {
            const t = av / (av - bv)
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
        }
        if (bi) out.push(b)
        a = b
        av = bv
    }
    return out
}

function appendTriangles(poly, out, g) {
    const eps = g.areaEps || 1e-9
    for (let i = 1; i + 1 < poly.length; i++) {
        const tri = [poly[0], poly[i], poly[i + 1]]
        const area = (tri[1].x - tri[0].x) * (tri[2].y - tri[0].y) - (tri[1].y - tri[0].y) * (tri[2].x - tri[0].x)
        if (Math.abs(area) < eps) continue
        for (const p of tri) {
            const d = deform(p, g)
            out.push(d.x, d.y, d.z, p.x / g.W, p.y / g.H, d.nx, d.ny, d.nz)
        }
    }
}

export function meshes(g) {
    const rect = [{ x: 0, y: 0 }, { x: g.W, y: 0 }, { x: g.W, y: g.H }, { x: 0, y: g.H }]
    const flat = []
    const bend = []
    if (g.flat) {
        appendTriangles(rect, flat, g)
    } else {
        appendTriangles(clip(rect, g, 0, false), flat, g)
        if (g.R) {
            const steps = 48
            for (let i = 0; i < steps; i++) {
                const strip = clip(clip(rect, g, (PI * g.R * i) / steps, true), g, (PI * g.R * (i + 1)) / steps, false)
                appendTriangles(strip, bend, g)
            }
        }
        appendTriangles(clip(rect, g, PI * g.R, true), bend, g)
    }
    return { flat: new Float32Array(flat), bend: new Float32Array(bend) }
}
