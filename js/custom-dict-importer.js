/**
 * custom-dict-importer.js
 * Pure browser / Node client-side parser for StarDict (.ifo/.idx/.dict[.dz]) and
 * MDict (.mdx v1.2 / v2.0) local dictionaries.
 */

function u32be(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function u64be(bytes, offset) {
    const hi = u32be(bytes, offset)
    const lo = u32be(bytes, offset + 4)
    return hi * 4294967296 + lo
}

function adler32(bytes) {
    let a = 1
    let b = 0
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % 65521
        b = (b + a) % 65521
    }
    return ((b << 16) | a) >>> 0
}

async function decompressWithStream(bytes, format) {
    if (typeof DecompressionStream === 'function') {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))
        const ab = await new Response(stream).arrayBuffer()
        return new Uint8Array(ab)
    }
    // Node fallback for offline test environments lacking Web DecompressionStream
    const zlib = await import('node:zlib')
    if (format === 'gzip') return new Uint8Array(zlib.gunzipSync(bytes))
    if (format === 'deflate-raw') return new Uint8Array(zlib.inflateRawSync(bytes))
    return new Uint8Array(zlib.inflateSync(bytes))
}

async function decompressZlibBytes(bytes) {
    try {
        return await decompressWithStream(bytes, 'deflate')
    } catch (_) {
        if (bytes.length > 2 && bytes[0] === 0x78) {
            return decompressWithStream(bytes.subarray(2), 'deflate-raw')
        }
        return decompressWithStream(bytes, 'deflate-raw')
    }
}

export function cleanDictionaryHtml(raw) {
    let s = String(raw || '')
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
    return s.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').trim()
}

/**
 * Pure JS RIPEMD-128 used by encrypted MDict v2.0 key headers.
 */
export function ripemd128(msgBytes) {
    const len = msgBytes.length
    const bitLenLo = (len * 8) >>> 0
    const bitLenHi = Math.floor((len * 8) / 4294967296) >>> 0
    const paddedLen = (((len + 8) >> 6) + 1) << 6
    const padded = new Uint8Array(paddedLen)
    padded.set(msgBytes)
    padded[len] = 0x80
    const dv = new DataView(padded.buffer)
    dv.setUint32(paddedLen - 8, bitLenLo, true)
    dv.setUint32(paddedLen - 4, bitLenHi, true)

    const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0
    const f0 = (x, y, z) => (x ^ y ^ z) >>> 0
    const f1 = (x, y, z) => ((x & y) | (~x & z)) >>> 0
    const f2 = (x, y, z) => ((x | ~y) ^ z) >>> 0
    const f3 = (x, y, z) => ((x & z) | (y & ~z)) >>> 0
    const fns = [f0, f1, f2, f3]
    const pfns = [f3, f2, f1, f0]
    const ks = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc]
    const pks = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000]
    const r = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
        3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
        1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    ]
    const rp = [
        5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
        6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
        15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
        8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    ]
    const s = [
        11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
        7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
        11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
        11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    ]
    const sp = [
        8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
        9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
        9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
        15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    ]

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476
    const x = new Uint32Array(16)
    for (let off = 0; off < paddedLen; off += 64) {
        for (let i = 0; i < 16; i++) x[i] = dv.getUint32(off + i * 4, true)
        let al = h0, bl = h1, cl = h2, dl = h3
        let ar = h0, br = h1, cr = h2, dr = h3
        for (let j = 0; j < 64; j++) {
            const round = j >> 4
            const t1 = (al + fns[round](bl, cl, dl) + x[r[j]] + ks[round]) >>> 0
            al = dl; dl = cl; cl = bl; bl = rol(t1, s[j])
            const t2 = (ar + pfns[round](br, cr, dr) + x[rp[j]] + pks[round]) >>> 0
            ar = dr; dr = cr; cr = br; br = rol(t2, sp[j])
        }
        const t = (h1 + cl + dr) >>> 0
        h1 = (h2 + dl + ar) >>> 0
        h2 = (h3 + al + br) >>> 0
        h3 = (h0 + bl + cr) >>> 0
        h0 = t
    }
    const out = new Uint8Array(16)
    const outDv = new DataView(out.buffer)
    outDv.setUint32(0, h0, true)
    outDv.setUint32(4, h1, true)
    outDv.setUint32(8, h2, true)
    outDv.setUint32(12, h3, true)
    return out
}

function mdxFastDecrypt(dataBytes, adlerSuffixBytes) {
    const keyInput = new Uint8Array(8)
    keyInput.set(adlerSuffixBytes.subarray(0, 4), 0)
    keyInput[4] = 0x95; keyInput[5] = 0x36; keyInput[6] = 0x00; keyInput[7] = 0x00
    const key = ripemd128(keyInput)
    const out = new Uint8Array(dataBytes)
    let prev = 0x36
    for (let i = 0; i < out.length; i++) {
        let b = out[i]
        b = ((b >> 4) | (b << 4)) & 0xFF
        b = b ^ prev ^ (i & 0xFF) ^ key[i % key.length]
        prev = out[i]
        out[i] = b
    }
    return out
}

export async function parseStarDictFiles({ ifoBytes = null, idxBytes, dictBytes, isGzipped = false, fileName = '' } = {}) {
    if (!idxBytes || !dictBytes) {
        throw new Error('StarDict requires both .idx and .dict / .dict.dz files')
    }
    const idxU8 = idxBytes instanceof Uint8Array ? idxBytes : new Uint8Array(idxBytes)
    let dictU8 = dictBytes instanceof Uint8Array ? dictBytes : new Uint8Array(dictBytes)
    const hasGzipMagic = dictU8.length >= 2 && dictU8[0] === 0x1F && dictU8[1] === 0x8B
    if (isGzipped || hasGzipMagic) {
        dictU8 = await decompressWithStream(dictU8, 'gzip')
    }

    let title = fileName ? fileName.replace(/\.(ifo|idx|dict(\.dz)?)$/i, '') : 'StarDict Dictionary'
    let use64BitOffsets = false
    if (ifoBytes) {
        const ifoText = new TextDecoder('utf-8').decode(ifoBytes instanceof Uint8Array ? ifoBytes : new Uint8Array(ifoBytes))
        const bookMatch = /^bookname=(.+)$/im.exec(ifoText)
        if (bookMatch?.[1]) title = bookMatch[1].trim()
        if (/^idxoffsetbits=64\b/im.test(ifoText)) use64BitOffsets = true
    }

    const utf8 = new TextDecoder('utf-8')
    const entries = []
    let pos = 0
    while (pos < idxU8.length) {
        let zero = pos
        while (zero < idxU8.length && idxU8[zero] !== 0) zero++
        if (zero >= idxU8.length) break
        const word = utf8.decode(idxU8.subarray(pos, zero)).trim()
        pos = zero + 1
        const need = use64BitOffsets ? 12 : 8
        if (pos + need > idxU8.length) break
        const offset = use64BitOffsets ? u64be(idxU8, pos) : u32be(idxU8, pos)
        const size = u32be(idxU8, pos + (use64BitOffsets ? 8 : 4))
        pos += need
        if (!word || size === 0 || offset + size > dictU8.length) continue
        const rawDef = utf8.decode(dictU8.subarray(offset, offset + size))
        const cleanDef = cleanDictionaryHtml(rawDef)
        if (cleanDef) {
            entries.push({ word, definition: cleanDef })
        }
    }

    return { title, format: 'stardict', entries }
}

function parseHeaderAttrs(xml) {
    const attrs = {}
    const attrRe = /([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g
    let m
    while ((m = attrRe.exec(xml)) !== null) {
        attrs[m[1]] = m[2]
    }
    return attrs
}

function decodeMdxString(bytes, encoding) {
    try {
        return new TextDecoder(encoding).decode(bytes)
    } catch (_) {
        return new TextDecoder('utf-8').decode(bytes)
    }
}

async function decodeMdxBlock(rawBlock, decompressedSize) {
    if (rawBlock.length < 8) return rawBlock
    const compType = u32le(rawBlock, 0)
    const payload = rawBlock.subarray(8)
    if (compType === 0) return payload
    if (compType === 2) {
        const dec = await decompressZlibBytes(payload)
        return decompressedSize && dec.length > decompressedSize ? dec.subarray(0, decompressedSize) : dec
    }
    throw new Error(`Unsupported MDX block compression type (${compType})`)
}

export async function parseMdxBuffer(arrayBuffer, fallbackName = 'Custom MDX') {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer)
    if (bytes.length < 16) throw new Error('Invalid MDX file: too short')
    let pos = 0
    const headerByteSize = u32be(bytes, pos)
    pos += 4
    if (pos + headerByteSize + 4 > bytes.length) throw new Error('Invalid MDX header bounds')
    const headerBytes = bytes.subarray(pos, pos + headerByteSize)
    pos += headerByteSize
    const expectedChecksum = u32le(bytes, pos)
    pos += 4
    if (adler32(headerBytes) !== expectedChecksum) {
        throw new Error('Corrupt MDX header checksum')
    }

    const headerXml = new TextDecoder('utf-16le').decode(headerBytes)
    const attrs = parseHeaderAttrs(headerXml)
    const version = parseFloat(attrs.GeneratedByEngineVersion || '1.2') || 1.2
    const numWidth = version >= 2.0 ? 8 : 4
    const readNum = (buf, off) => (numWidth === 8 ? u64be(buf, off) : u32be(buf, off))
    const encRaw = (attrs.Encoding || 'UTF-8').trim().toUpperCase()
    const encoding = encRaw === 'UTF-16' || encRaw === 'UTF-16LE' ? 'utf-16le'
        : (encRaw === 'GBK' || encRaw === 'GB2312' || encRaw === 'GB18030' ? 'gb18030' : 'utf-8')
    const unitBytes = encoding === 'utf-16le' ? 2 : 1
    const encrypt = parseInt(attrs.Encrypted || '0', 10) || 0
    const title = (attrs.Title || fallbackName).replace(/\.mdx$/i, '').trim() || fallbackName

    // 1. Key section header
    const keyHeaderLen = version >= 2.0 ? 5 * 8 : 4 * 4
    if (pos + keyHeaderLen > bytes.length) throw new Error('Truncated MDX key section header')
    let keyHeaderBytes = bytes.subarray(pos, pos + keyHeaderLen)
    pos += keyHeaderLen
    if (version >= 2.0) pos += 4 // header adler32

    if (encrypt & 1) {
        throw new Error('User-key encrypted MDX files requiring registration code are not supported')
    }

    const numKeyBlocks = readNum(keyHeaderBytes, 0)
    const keyBlockInfoSize = readNum(keyHeaderBytes, numWidth * (version >= 2.0 ? 3 : 2))
    const keyBlockDataSize = readNum(keyHeaderBytes, numWidth * (version >= 2.0 ? 4 : 3))

    if (pos + keyBlockInfoSize > bytes.length) throw new Error('Truncated MDX key block info')
    const keyBlockInfoRaw = bytes.subarray(pos, pos + keyBlockInfoSize)
    pos += keyBlockInfoSize

    let keyBlockInfo = keyBlockInfoRaw
    if (version >= 2.0) {
        const compType = u32le(keyBlockInfoRaw, 0)
        let payload = keyBlockInfoRaw.subarray(8)
        if (encrypt & 2) {
            payload = mdxFastDecrypt(payload, keyBlockInfoRaw.subarray(4, 8))
        }
        keyBlockInfo = compType === 2 ? await decompressZlibBytes(payload) : payload
    }

    // Parse key block metadata
    const keyBlocksMeta = []
    let infoOff = 0
    for (let i = 0; i < numKeyBlocks && infoOff + numWidth * 2 <= keyBlockInfo.length; i++) {
        infoOff += numWidth // word count in block
        if (version >= 2.0) {
            const csz = (keyBlockInfo[infoOff] << 8) | keyBlockInfo[infoOff + 1]
            infoOff += 2 + (csz + 1) * unitBytes
            const lsz = (keyBlockInfo[infoOff] << 8) | keyBlockInfo[infoOff + 1]
            infoOff += 2 + (lsz + 1) * unitBytes
        } else {
            const firstTextLen = keyBlockInfo[infoOff]
            infoOff += 1 + firstTextLen * unitBytes
            const lastLen = keyBlockInfo[infoOff]
            infoOff += 1 + lastLen * unitBytes
        }
        const compSize = readNum(keyBlockInfo, infoOff); infoOff += numWidth
        const decompSize = readNum(keyBlockInfo, infoOff); infoOff += numWidth
        keyBlocksMeta.push({ compSize, decompSize })
    }

    if (pos + keyBlockDataSize > bytes.length) throw new Error('Truncated MDX key data')
    let kbOff = pos
    pos += keyBlockDataSize

    const keyEntries = []
    for (const meta of keyBlocksMeta) {
        const slice = bytes.subarray(kbOff, kbOff + meta.compSize)
        kbOff += meta.compSize
        const decoded = await decodeMdxBlock(slice, meta.decompSize)
        let kPos = 0
        while (kPos + numWidth < decoded.length) {
            const recordOffset = readNum(decoded, kPos)
            kPos += numWidth
            let end = kPos
            if (unitBytes === 2) {
                while (end + 1 < decoded.length && !(decoded[end] === 0 && decoded[end + 1] === 0)) end += 2
                const word = decodeMdxString(decoded.subarray(kPos, end), encoding).trim()
                kPos = end + 2
                keyEntries.push({ recordOffset, word })
            } else {
                while (end < decoded.length && decoded[end] !== 0) end++
                const word = decodeMdxString(decoded.subarray(kPos, end), encoding).trim()
                kPos = end + 1
                keyEntries.push({ recordOffset, word })
            }
        }
    }

    // 2. Record section header
    if (pos + numWidth * 4 > bytes.length) throw new Error('Truncated MDX record section header')
    const numRecordBlocks = readNum(bytes, pos); pos += numWidth
    pos += numWidth // numEntries
    const recordBlockInfoSize = readNum(bytes, pos); pos += numWidth
    pos += numWidth // recordBlockDataSize

    const recMeta = []
    let rInfoEnd = pos + recordBlockInfoSize
    while (pos + numWidth * 2 <= rInfoEnd && recMeta.length < numRecordBlocks) {
        const compSize = readNum(bytes, pos); pos += numWidth
        const decompSize = readNum(bytes, pos); pos += numWidth
        recMeta.push({ compSize, decompSize })
    }

    // Concatenate decompressed record blocks progressively while indexing key slices
    const chunks = []
    let totalRecLen = 0
    for (const rm of recMeta) {
        const slice = bytes.subarray(pos, pos + rm.compSize)
        pos += rm.compSize
        const decoded = await decodeMdxBlock(slice, rm.decompSize)
        chunks.push({ start: totalRecLen, buf: decoded })
        totalRecLen += decoded.length
    }

    keyEntries.sort((a, b) => a.recordOffset - b.recordOffset)
    const entries = []
    let chunkCursor = 0
    for (let i = 0; i < keyEntries.length; i++) {
        const { recordOffset, word } = keyEntries[i]
        if (!word) continue
        const nextOffset = i + 1 < keyEntries.length ? keyEntries[i + 1].recordOffset : totalRecLen
        if (nextOffset <= recordOffset || recordOffset >= totalRecLen) continue
        const endOffset = Math.min(totalRecLen, nextOffset)
        while (chunkCursor < chunks.length && recordOffset >= chunks[chunkCursor].start + chunks[chunkCursor].buf.length) {
            chunkCursor++
        }
        if (chunkCursor >= chunks.length) break
        const targetChunk = chunks[chunkCursor]
        let sliceBytes
        if (endOffset <= targetChunk.start + targetChunk.buf.length) {
            sliceBytes = targetChunk.buf.subarray(recordOffset - targetChunk.start, endOffset - targetChunk.start)
        } else {
            sliceBytes = new Uint8Array(endOffset - recordOffset)
            let written = 0
            let cIdx = chunkCursor
            while (cIdx < chunks.length && written < sliceBytes.length) {
                const c = chunks[cIdx++]
                const relS = Math.max(0, recordOffset + written - c.start)
                const relE = Math.min(c.buf.length, relS + (sliceBytes.length - written))
                if (relE > relS) {
                    sliceBytes.set(c.buf.subarray(relS, relE), written)
                    written += relE - relS
                }
            }
        }
        const rawDef = decodeMdxString(sliceBytes, encoding)
        const cleanDef = cleanDictionaryHtml(rawDef)
        if (cleanDef) {
            entries.push({ word, definition: cleanDef })
        }
    }

    return { title, format: 'mdx', entries }
}
