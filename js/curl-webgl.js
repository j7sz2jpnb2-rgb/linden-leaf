/**
 * js/curl-webgl.js - Theme-aware WebGL page curl renderer with strict 2-texture budget.
 * Uses curl-geometry.js for finite-sheet deformation and half-res non-occluding soft shadows.
 */

import * as G from './curl-geometry.js'

const VERTEX_SHADER_SRC = `
attribute vec3 aPosition;
attribute vec2 aUV;
attribute vec3 aNormal;
uniform vec2 uSize;
uniform float uPass;
uniform float uZScale;
uniform vec2 uShadowOffset;
varying vec2 vUV;
varying vec3 vNormal;
void main() {
    vec3 p = aPosition;
    if (uPass > 1.5 && uPass < 2.5) {
        p.xy += p.z * uShadowOffset;
    }
    gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, -p.z / uZScale, 1.0);
    vUV = aUV;
    vNormal = aNormal;
}
`

const PAPER_FRAGMENT_SRC = `
precision highp float;
uniform sampler2D uTex;
uniform float uPass;
uniform vec3 uPaperBackColor;
uniform float uBleedAlpha;
uniform float uAmbientBase;
uniform float uDiffuseGain;
uniform float uSpecularStrength;
varying vec2 vUV;
varying vec3 vNormal;
void main() {
    if (uPass > 1.5) {
        gl_FragColor = vec4(1.0);
        return;
    }
    vec3 tex = texture2D(uTex, vUV).rgb;
    if (uPass < 0.5) {
        gl_FragColor = vec4(tex, 1.0);
        return;
    }
    vec3 n = normalize(vNormal);
    bool back = !gl_FrontFacing;
    if (back) n = -n;
    vec3 L = normalize(vec3(-0.43, -0.17, 1.0));
    // Normalize flat face brightness (n = (0,0,1) => 1.0) so s=0 matches flat sheet seamlessly.
    float diff = clamp(max(dot(n, L), 0.0) / max(L.z, 0.001), 0.0, 1.25);
    float shade = uAmbientBase + uDiffuseGain * diff;
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float curveWeight = clamp(1.0 - abs(n.z), 0.0, 1.0);
    float spec = curveWeight * pow(max(dot(n, H), 0.0), 10.0) * uSpecularStrength;
    vec3 paper = back ? mix(uPaperBackColor, tex, uBleedAlpha) : tex;
    // Matte paper keeps its albedo at the lit crest; additive white light made
    // the short front-facing top edge look like a separate bright tab.
    vec3 lit = paper * clamp(shade + spec, 0.0, 1.0);
    gl_FragColor = vec4(lit, 1.0);
}
`

const QUAD_VERTEX_SRC = `
attribute vec2 aQuad;
varying vec2 vUV;
void main() {
    gl_Position = vec4(aQuad, 0.0, 1.0);
    vUV = aQuad * 0.5 + 0.5;
}
`

const BLUR_FRAGMENT_SRC = `
precision mediump float;
uniform sampler2D uMask;
uniform vec2 uStep;
uniform float uOpacity;
uniform vec3 uShadowColor;
varying vec2 vUV;
void main() {
    float a = texture2D(uMask, vUV).a * 0.227027;
    a += (texture2D(uMask, vUV + uStep * 1.384615).a + texture2D(uMask, vUV - uStep * 1.384615).a) * 0.316216;
    a += (texture2D(uMask, vUV + uStep * 3.230769).a + texture2D(uMask, vUV - uStep * 3.230769).a) * 0.070270;
    gl_FragColor = uOpacity < 0.0 ? vec4(1.0, 1.0, 1.0, a) : vec4(uShadowColor, a * uOpacity);
}
`

/**
 * Parse a CSS hex/rgb/rgba color into normalized RGB [0..1].
 */
export function parseCssColorRgb(color, fallback = [0.98, 0.976, 0.96]) {
    if (!color || typeof color !== 'string') return fallback
    const str = color.trim().toLowerCase()
    if (str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return fallback
    if (str === 'black') return [0, 0, 0]
    if (str === 'white') return [1, 1, 1]
    if (str.startsWith('#')) {
        const hex = str.slice(1)
        if (hex.length === 3 || hex.length === 4) {
            return [
                parseInt(hex[0] + hex[0], 16) / 255,
                parseInt(hex[1] + hex[1], 16) / 255,
                parseInt(hex[2] + hex[2], 16) / 255,
            ]
        }
        if (hex.length >= 6) {
            return [
                parseInt(hex.slice(0, 2), 16) / 255,
                parseInt(hex.slice(2, 4), 16) / 255,
                parseInt(hex.slice(4, 6), 16) / 255,
            ]
        }
    }
    const m = str.match(/rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)/)
    if (m) {
        return [
            G.clamp(Number(m[1]) / 255, 0, 1),
            G.clamp(Number(m[2]) / 255, 0, 1),
            G.clamp(Number(m[3]) / 255, 0, 1),
        ]
    }
    return fallback
}

/**
 * Derive theme-matched paper back tint, crease shading, and shadow uniforms.
 */
export function computeCurlThemeParams(bgColor, forceDark = null) {
    const rgb = parseCssColorRgb(bgColor)
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    const isDark = typeof forceDark === 'boolean' ? forceDark : lum < 0.45

    if (isDark) {
        const backBase = lum < 0.45 ? rgb : [0.06, 0.06, 0.07]
        return {
            isDark: true,
            clearColor: rgb,
            // Elevated charcoal/slate tint keeps dark mode paper backs matte instead of bright cream.
            paperBackColor: [
                Math.min(1, backBase[0] * 0.85 + 0.12),
                Math.min(1, backBase[1] * 0.85 + 0.12),
                Math.min(1, backBase[2] * 0.85 + 0.135),
            ],
            bleedAlpha: 0.13,
            shadowColor: [0.0, 0.0, 0.0],
            shadowMaxOpacity: 0.62,
            ambientBase: 0.74,
            diffuseGain: 0.26,
            specularStrength: 0.09,
        }
    }

    return {
        isDark: false,
        clearColor: rgb,
        // Both sides belong to the same sheet. Curvature and ink bleed provide
        // contrast without an artificial yellow back / white front boundary.
        paperBackColor: [...rgb],
        bleedAlpha: 0.16,
        shadowColor: [0.05, 0.055, 0.065],
        shadowMaxOpacity: 0.24,
        ambientBase: 0.78,
        diffuseGain: 0.22,
        specularStrength: 0.06,
    }
}

let _cachedWebGLSupport = null

export class CurlRenderer {
    static isSupported() {
        if (_cachedWebGLSupport !== null) return _cachedWebGLSupport
        if (typeof document === 'undefined') {
            _cachedWebGLSupport = false
            return false
        }
        let probe = null
        try {
            probe = document.createElement('canvas')
            probe.width = 2
            probe.height = 2
            const gl = probe.getContext('webgl', { alpha: false, depth: true, preserveDrawingBuffer: false })
            _cachedWebGLSupport = Boolean(gl && !gl.isContextLost())
            if (gl) {
                try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch {}
            }
        } catch {
            _cachedWebGLSupport = false
        } finally {
            if (probe) {
                try { probe.width = 0; probe.height = 0 } catch {}
            }
        }
        return _cachedWebGLSupport
    }

    constructor({ container, onContextLost = null, onContextRestored = null, maxDpr = 2 } = {}) {
        this.container = container || null
        this._onContextLost = onContextLost
        this._onContextRestored = onContextRestored
        this._maxDpr = maxDpr
        this._disposed = false
        this._contextLost = false
        this._cssW = 0
        this._cssH = 0
        this._pxW = 0
        this._pxH = 0
        this._maskW = 0
        this._maskH = 0
        this._slots = { current: null, target: null } // strict <= 2 GL page textures

        this.canvas = document.createElement('canvas')
        this.canvas.className = 'page-turn-curl-canvas'
        this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;'
        if (this.container) {
            this.container.appendChild(this.canvas)
        }

        this._handleContextLost = (e) => {
            e.preventDefault?.()
            this._contextLost = true
            this._slots = { current: null, target: null }
            this._mask = null
            this._softMask = null
            this._maskW = 0
            this._maskH = 0
            this._pxW = 0
            this._pxH = 0
            this._onContextLost?.()
        }
        this._handleContextRestored = () => {
            if (this._disposed || !this.gl) return
            try {
                this._initGL()
                this._contextLost = false
                this._pxW = 0
                this._pxH = 0
                this._maskW = 0
                this._maskH = 0
                this._onContextRestored?.()
            } catch {
                this._contextLost = true
            }
        }
        this.canvas.addEventListener('webglcontextlost', this._handleContextLost, false)
        this.canvas.addEventListener('webglcontextrestored', this._handleContextRestored, false)

        const gl = this.canvas.getContext('webgl', {
            alpha: true,
            antialias: false,
            depth: true,
            stencil: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
        })
        if (!gl) {
            this.dispose()
            throw new Error('WebGL unavailable for CurlRenderer')
        }
        this.gl = gl
        this._initGL()
    }

    _compileShader(type, src) {
        const gl = this.gl
        const s = gl.createShader(type)
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(s)
            gl.deleteShader(s)
            throw new Error(`Curl shader compile failed: ${log}`)
        }
        return s
    }

    _createProgram(vertSrc, fragSrc) {
        const gl = this.gl
        const vs = this._compileShader(gl.VERTEX_SHADER, vertSrc)
        const fs = this._compileShader(gl.FRAGMENT_SHADER, fragSrc)
        const prog = gl.createProgram()
        gl.attachShader(prog, vs)
        gl.attachShader(prog, fs)
        gl.linkProgram(prog)
        gl.deleteShader(vs)
        gl.deleteShader(fs)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(prog)
            gl.deleteProgram(prog)
            throw new Error(`Curl program link failed: ${log}`)
        }
        return prog
    }

    _initGL() {
        const gl = this.gl
        this._paperProg = this._createProgram(VERTEX_SHADER_SRC, PAPER_FRAGMENT_SRC)
        this._blurProg = this._createProgram(QUAD_VERTEX_SRC, BLUR_FRAGMENT_SRC)

        this._pLoc = {}
        for (const k of [
            'uSize', 'uPass', 'uZScale', 'uShadowOffset', 'uTex',
            'uPaperBackColor', 'uBleedAlpha', 'uAmbientBase', 'uDiffuseGain', 'uSpecularStrength',
        ]) {
            this._pLoc[k] = gl.getUniformLocation(this._paperProg, k)
        }
        this._pAttrs = ['aPosition', 'aUV', 'aNormal'].map(k => gl.getAttribLocation(this._paperProg, k))

        this._qLoc = {}
        for (const k of ['uMask', 'uStep', 'uOpacity', 'uShadowColor']) {
            this._qLoc[k] = gl.getUniformLocation(this._blurProg, k)
        }
        this._qAttr = gl.getAttribLocation(this._blurProg, 'aQuad')

        this._vbo = gl.createBuffer()
        this._quadVbo = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVbo)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW)

        this._mask = null
        this._softMask = null
    }

    _createFboTarget(w, h) {
        const gl = this.gl
        const tex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

        const fb = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.deleteFramebuffer(fb)
            gl.deleteTexture(tex)
            throw new Error('Curl shadow FBO incomplete')
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return { texture: tex, fb }
    }

    _deleteFbo(target) {
        if (!target || !this.gl) return
        try { if (target.fb) this.gl.deleteFramebuffer(target.fb) } catch {}
        try { if (target.texture) this.gl.deleteTexture(target.texture) } catch {}
    }

    resize(cssW, cssH, dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1) {
        if (this._disposed || this._contextLost) return false
        const safeW = Math.max(1, Number(cssW) || 1)
        const safeH = Math.max(1, Number(cssH) || 1)
        const clampedDpr = G.clamp(Number(dpr) || 1, 1, this._maxDpr)
        const pxW = Math.max(1, Math.round(safeW * clampedDpr))
        const pxH = Math.max(1, Math.round(safeH * clampedDpr))

        if (pxW === this._pxW && pxH === this._pxH && Math.abs(safeW - this._cssW) < 0.01 && Math.abs(safeH - this._cssH) < 0.01 && this._mask) {
            return true
        }

        this._cssW = safeW
        this._cssH = safeH
        this._pxW = pxW
        this._pxH = pxH
        this.canvas.width = pxW
        this.canvas.height = pxH

        this._fullMesh = G.meshes(G.geometry(null, safeW, safeH)).flat

        const maskW = Math.max(64, Math.round(pxW * 0.5))
        const maskH = Math.max(64, Math.round(pxH * 0.5))
        if (!this._mask || maskW !== this._maskW || maskH !== this._maskH) {
            this._deleteFbo(this._mask)
            this._deleteFbo(this._softMask)
            this._mask = this._createFboTarget(maskW, maskH)
            this._softMask = this._createFboTarget(maskW, maskH)
            this._maskW = maskW
            this._maskH = maskH
        }
        return true
    }

    _uploadSlot(slotName, key, source, closeBitmapAfter = true) {
        if (this._disposed || this._contextLost) return null
        const existing = this._slots[slotName]
        if (existing && existing.key === key && existing.tex) {
            if (source && typeof source.close === 'function' && closeBitmapAfter) {
                try { source.close() } catch {}
            }
            return existing.tex
        }
        const gl = this.gl
        if (existing?.tex) {
            gl.deleteTexture(existing.tex)
            this._slots[slotName] = null
        }

        const tex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
        } catch (error) {
            gl.deleteTexture(tex)
            throw error
        } finally {
            if (source && typeof source.close === 'function' && closeBitmapAfter) {
                try { source.close() } catch {}
            }
        }
        this._slots[slotName] = { key, tex }
        return tex
    }

    syncPageTextures(currentSnap, targetSnap) {
        if (this._disposed || this._contextLost) return false
        const makeKey = (snap) => snap
            ? `${snap.loadGeneration ?? 0}:${snap.pageIndex ?? ''}:${snap.visualVersion ?? 0}:${snap.width ?? 0}x${snap.height ?? 0}`
            : ''

        const curSrc = currentSnap?.bitmap || currentSnap?.canvas
        const tgtSrc = targetSnap?.bitmap || targetSnap?.canvas
        if (!curSrc || (targetSnap && !tgtSrc)) return false

        const currentKey = makeKey(currentSnap)
        const targetKey = makeKey(targetSnap)
        if (this._slots.target?.key === currentKey || (targetSnap && this._slots.current?.key === targetKey)) {
            const previousCurrent = this._slots.current
            this._slots.current = this._slots.target
            this._slots.target = previousCurrent
        }
        try {
            this._uploadSlot('current', currentKey, curSrc, currentSnap?.closeBitmapOnUpload !== false)
            if (tgtSrc) {
                this._uploadSlot('target', targetKey, tgtSrc, targetSnap?.closeBitmapOnUpload !== false)
            } else if (this._slots.target?.tex) {
                try { this.gl.deleteTexture(this._slots.target.tex) } catch {}
                this._slots.target = null
            }
        } catch {
            // WebGL rejects unreadable or cross-origin sources. Fall back
            // to the live reader without forcing a synchronous canvas read.
            this.releasePageTextures()
            return false
        }
        return Boolean(this._slots.current?.tex && (!targetSnap || this._slots.target?.tex))
    }

    releasePageTextures() {
        const gl = this.gl
        for (const name of ['current', 'target']) {
            const slot = this._slots[name]
            if (slot?.tex && gl) {
                try { gl.deleteTexture(slot.tex) } catch {}
            }
            this._slots[name] = null
        }
    }

    _enableAttribs(locs) {
        const gl = this.gl
        for (let i = 0; i < 6; i++) gl.disableVertexAttribArray(i)
        for (const idx of locs) {
            if (idx >= 0) gl.enableVertexAttribArray(idx)
        }
    }

    _setupPaperProgram(g, theme) {
        const gl = this.gl
        gl.useProgram(this._paperProg)
        gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo)
        this._enableAttribs(this._pAttrs)
        if (this._pAttrs[0] >= 0) gl.vertexAttribPointer(this._pAttrs[0], 3, gl.FLOAT, false, 32, 0)
        if (this._pAttrs[1] >= 0) gl.vertexAttribPointer(this._pAttrs[1], 2, gl.FLOAT, false, 32, 12)
        if (this._pAttrs[2] >= 0) gl.vertexAttribPointer(this._pAttrs[2], 3, gl.FLOAT, false, 32, 20)

        gl.uniform2f(this._pLoc.uSize, this._cssW, this._cssH)
        gl.uniform1f(this._pLoc.uZScale, g.zScale || Math.max(200, this._cssW * 0.95))
        gl.uniform2f(this._pLoc.uShadowOffset, 0.35, 0.16)
        gl.uniform1i(this._pLoc.uTex, 0)
        gl.uniform3fv(this._pLoc.uPaperBackColor, theme.paperBackColor)
        gl.uniform1f(this._pLoc.uBleedAlpha, theme.bleedAlpha)
        gl.uniform1f(this._pLoc.uAmbientBase, theme.ambientBase)
        gl.uniform1f(this._pLoc.uDiffuseGain, theme.diffuseGain)
        gl.uniform1f(this._pLoc.uSpecularStrength, theme.specularStrength)
        gl.frontFace(gl.CW)
        gl.disable(gl.CULL_FACE)
    }

    _drawMesh(data, pass, tex) {
        if (!data || !data.length) return
        const gl = this.gl
        gl.uniform1f(this._pLoc.uPass, pass)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
        gl.drawArrays(gl.TRIANGLES, 0, data.length / 8)
    }

    _drawBlurPass(tex, stepX, stepY, opacity, shadowColor) {
        const gl = this.gl
        gl.useProgram(this._blurProg)
        gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVbo)
        this._enableAttribs([this._qAttr])
        if (this._qAttr >= 0) gl.vertexAttribPointer(this._qAttr, 2, gl.FLOAT, false, 0, 0)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform1i(this._qLoc.uMask, 0)
        gl.uniform2f(this._qLoc.uStep, stepX, stepY)
        gl.uniform1f(this._qLoc.uOpacity, opacity)
        gl.uniform3fv(this._qLoc.uShadowColor, shadowColor)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    renderPose(pose, options = {}) {
        if (this._disposed || this._contextLost || !this.gl) return null
        if (this.gl.isContextLost()) {
            this._contextLost = true
            this._slots = { current: null, target: null }
            this._mask = null
            this._softMask = null
            this._maskW = 0
            this._maskH = 0
            this._pxW = 0
            this._pxH = 0
            this._onContextLost?.()
            return null
        }

        const currentTex = this._slots.current?.tex
        const targetTex = this._slots.target?.tex
        const liveTarget = Boolean(options.liveTarget && pose)
        if (!currentTex || (!options.liveTarget && !targetTex)) return null

        const gl = this.gl
        const theme = options.themeParams || computeCurlThemeParams(options.bgColor, options.isDark)
        const g = G.geometry(pose, this._cssW, this._cssH)
        const m = G.meshes(g)
        const baseTex = pose ? targetTex : currentTex
        const metrics = G.computeCurlMetrics(this._cssW, this._cssH)

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, this._pxW, this._pxH)
        gl.depthMask(true)
        if (liveTarget) gl.clearColor(0, 0, 0, 0)
        else gl.clearColor(theme.clearColor[0], theme.clearColor[1], theme.clearColor[2], 1)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.disable(gl.BLEND)
        gl.disable(gl.DEPTH_TEST)

        this._setupPaperProgram(g, theme)
        if (!liveTarget) this._drawMesh(this._fullMesh, 0, baseTex)
        this._drawMesh(m.flat, 0, currentTex)

        if (!g.flat && g.R > metrics.minRadius && m.bend.length && this._mask && this._softMask) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._mask.fb)
            gl.viewport(0, 0, this._maskW, this._maskH)
            gl.clearColor(0, 0, 0, 0)
            gl.clear(gl.COLOR_BUFFER_BIT)
            gl.disable(gl.BLEND)
            this._drawMesh(m.bend, 2, currentTex)

            gl.bindFramebuffer(gl.FRAMEBUFFER, this._softMask.fb)
            gl.clear(gl.COLOR_BUFFER_BIT)
            const spread = 1.1 + g.R * 0.075
            this._drawBlurPass(this._mask.texture, spread / this._maskW, 0, -1, theme.shadowColor)

            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.viewport(0, 0, this._pxW, this._pxH)
            gl.enable(gl.BLEND)
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
            const opacity = theme.shadowMaxOpacity * Math.min(1, g.R / Math.max(1.5, metrics.baseR * 0.45))
            this._drawBlurPass(this._softMask.texture, 0, spread / this._maskH, opacity, theme.shadowColor)
            gl.disable(gl.BLEND)
            this._setupPaperProgram(g, theme)
        }

        gl.depthMask(true)
        gl.clear(gl.DEPTH_BUFFER_BIT)
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        this._drawMesh(m.bend, 1, currentTex)
        gl.disable(gl.DEPTH_TEST)
        return g
    }

    getDebugStats() {
        return {
            disposed: this._disposed,
            contextLost: this._contextLost,
            textureCount: (this._slots.current?.tex ? 1 : 0) + (this._slots.target?.tex ? 1 : 0),
            fboCount: (this._mask ? 1 : 0) + (this._softMask ? 1 : 0),
            cssWidth: this._cssW,
            cssHeight: this._cssH,
            pxWidth: this._pxW,
            pxHeight: this._pxH,
        }
    }

    dispose() {
        if (this._disposed) return
        this._disposed = true
        this.releasePageTextures()
        if (this.canvas) {
            try { this.canvas.removeEventListener('webglcontextlost', this._handleContextLost, false) } catch {}
            try { this.canvas.removeEventListener('webglcontextrestored', this._handleContextRestored, false) } catch {}
        }
        const gl = this.gl
        if (gl) {
            this._deleteFbo(this._mask)
            this._deleteFbo(this._softMask)
            try { if (this._vbo) gl.deleteBuffer(this._vbo) } catch {}
            try { if (this._quadVbo) gl.deleteBuffer(this._quadVbo) } catch {}
            try { if (this._paperProg) gl.deleteProgram(this._paperProg) } catch {}
            try { if (this._blurProg) gl.deleteProgram(this._blurProg) } catch {}
        }
        this._mask = null
        this._softMask = null
        this._vbo = null
        this._quadVbo = null
        this._paperProg = null
        this._blurProg = null
        this.gl = null
        if (this.canvas) {
            try { this.canvas.width = 0; this.canvas.height = 0 } catch {}
            try { this.canvas.remove() } catch {}
        }
    }
}
