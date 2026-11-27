import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { mergeMarkdownSidecar, sanitizeSidecarFilename } from '../js/markdown-sidecar.js'
import { parseStarDictFiles, parseMdxBuffer, ripemd128 } from '../js/custom-dict-importer.js'
import { convertChineseScript, applyChineseScriptToDocument } from '../js/chinese-script.js'
import { purifyTxtContent } from '../js/txt-purifier.js'
import { parseKindleClippings, matchClippingsToLibrary } from '../js/clippings-importer.js'
import { computeTextSampleFingerprint, scoreRelinkCandidate } from '../js/document-identity.js'
import { openLocalPdfDirectFirst } from '../js/book-source.js'
import { mergeSyncData } from '../js/sync-model.js'

function adler32Bytes(u8) {
    let a = 1, b = 0
    for (let i = 0; i < u8.length; i++) {
        a = (a + u8[i]) % 65521
        b = (b + a) % 65521
    }
    return ((b << 16) | a) >>> 0
}

function u32beBuf(v) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v >>> 0, 0)
    return b
}

function u32leBuf(v) {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v >>> 0, 0)
    return b
}

function u64beBuf(v) {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(v), 0)
    return b
}

function buildZlibBlock(payloadBuf) {
    const comp = zlib.deflateSync(payloadBuf)
    const adler = adler32Bytes(payloadBuf)
    return Buffer.concat([u32leBuf(2), u32beBuf(adler), comp])
}

function fastDecryptInverse(plainBuf, keyBytes) {
    // Inverse of MDict Encrypted=2 XOR nibble-swap encryption
    const key = ripemd128(keyBytes)
    const out = Buffer.from(plainBuf)
    let prev = 0x36
    for (let i = 0; i < out.length; i++) {
        let p = out[i] ^ (i & 0xff) ^ key[i % key.length]
        p = ((p >> 4) | (p << 4)) & 0xff
        const origPrev = out[i]
        out[i] = p ^ prev
        prev = origPrev
    }
    return out
}

// ============================================================================
// 1. Non-destructive Incremental Markdown Sidecar
// ============================================================================

test('mergeMarkdownSidecar updates owned blocks idempotently without touching user prose or adding deep links', () => {
    const book = { id: 'b1', title: '认知与设计', author: 'Jeff Johnson' }
    const h1 = {
        id: 'hl_1',
        bookId: 'b1',
        chapterTitle: '第1章 视觉感知',
        text: '我们感知的是我们期望看到的。',
        note: '注意对比认知偏见',
        createdAt: 1700000000000,
    }
    const h2 = {
        id: 'hl_2',
        bookId: 'b1',
        chapterTitle: '第2章 色彩',
        text: '不要只靠颜色区分状态。',
        note: '',
        createdAt: 1700001000000,
    }

    const firstPass = mergeMarkdownSidecar('', book, [h1, h2])
    assert.equal(firstPass.added, 2)
    assert.ok(firstPass.content.includes('<!-- linden-leaf:hl:hl_1:start -->'))
    assert.ok(firstPass.content.includes('<!-- linden-leaf:hl:hl_2:start -->'))
    assert.equal(firstPass.content.includes('lindenleaf://'), false, 'must never emit deep links')

    // User adds YAML frontmatter and personal Obsidian reflection outside markers
    const withUserProse = `---\ntags: [ux, design]\n---\n${firstPass.content}\n## 我的读书总结\n这段话是用户手写的，绝不可被覆盖。\n`
    const h1Edited = { ...h1, note: '更新后的个人批注', updatedAt: 1700003000000 }
    const h3 = { id: 'hl_3', bookId: 'b1', chapterTitle: '第3章 记忆', text: '工作记忆容量有限。', createdAt: 1700004000000 }

    const secondPass = mergeMarkdownSidecar(withUserProse, book, [h1Edited, h2, h3])
    assert.equal(secondPass.added, 1)
    assert.equal(secondPass.updated, 1)
    assert.ok(secondPass.content.startsWith('---\ntags: [ux, design]\n---'))
    assert.ok(secondPass.content.includes('更新后的个人批注'))
    assert.ok(secondPass.content.includes('<!-- linden-leaf:hl:hl_3:start -->'))
    assert.ok(secondPass.content.includes('这段话是用户手写的，绝不可被覆盖。'), 'manual user prose outside markers must remain intact')
    assert.equal(secondPass.content.includes('lindenleaf://'), false)
    assert.equal(sanitizeSidecarFilename('a/b:c*d?'), 'a_b_c_d_.md')
})

// ============================================================================
// 2. Custom Local Dictionary Parsers (StarDict & MDX v2 Encrypted Key Block)
// ============================================================================

test('parseStarDictFiles parses .ifo + .idx + gzipped .dict.dz cleanly', () => {
    const def1 = '<div class="def"><b>apple</b><br/>a crisp fruit</div>'
    const def2 = '<b>book</b>\na written work'
    const def1Bytes = Buffer.from(def1, 'utf-8')
    const def2Bytes = Buffer.from(def2, 'utf-8')
    const dictRaw = Buffer.concat([def1Bytes, def2Bytes])
    const dictGz = zlib.gzipSync(dictRaw)

    const idxParts = [
        Buffer.from('apple\0', 'utf-8'),
        u32beBuf(0),
        u32beBuf(def1Bytes.length),
        Buffer.from('book\0', 'utf-8'),
        u32beBuf(def1Bytes.length),
        u32beBuf(def2Bytes.length),
    ]
    const idxBytes = Buffer.concat(idxParts)
    const ifoBytes = Buffer.from("StarDict's dict ifo file\nversion=2.4.2\nbookname=Concise EnDict\n", 'utf-8')

    return parseStarDictFiles({
        ifoBytes,
        idxBytes,
        dictBytes: dictGz,
        isGzipped: true,
        fileName: 'concise.dict.dz',
    }).then(parsed => {
        assert.equal(parsed.title, 'Concise EnDict')
        assert.equal(parsed.format, 'stardict')
        assert.equal(parsed.entries.length, 2)
        assert.equal(parsed.entries[0].word, 'apple')
        assert.ok(parsed.entries[0].definition.includes('a crisp fruit'))
        assert.equal(parsed.entries[1].word, 'book')
    })
})

test('parseMdxBuffer parses synthetic MDX v2.0 with zlib + RIPEMD-128 encrypted key index', async () => {
    const headerXml = '<Dictionary GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" Encrypted="2" Encoding="UTF-8" Format="Html" Title="Synthetic MDX v2"/>'
    const headerBuf = Buffer.from(headerXml, 'utf16le')
    const headerCheck = u32leBuf(adler32Bytes(headerBuf))

    const d1 = Buffer.from('<p>first definition</p>\0', 'utf-8')
    const d2 = Buffer.from('<p>second definition</p>\0', 'utf-8')
    const recordUncomp = Buffer.concat([d1, d2])
    const recordCompBlock = buildZlibBlock(recordUncomp)

    // Key block: two entries in single key block
    const keyPayload = Buffer.concat([
        u64beBuf(0),
        Buffer.from('alpha\0', 'utf-8'),
        u64beBuf(d1.length),
        Buffer.from('beta\0', 'utf-8'),
    ])
    const keyCompBlock = buildZlibBlock(keyPayload)

    // key info (36 bytes in v2): first(8)=alpha\0, last(8)=beta\0 -> wait key_info stores numEntries(8), firstLen(2), first+term, lastLen(2), last+term, compSize(8), decompSize(8)
    const firstTerm = Buffer.from('alpha\0', 'utf-8')
    const lastTerm = Buffer.from('beta\0', 'utf-8')
    const firstLenU16 = Buffer.alloc(2); firstLenU16.writeUInt16BE(5, 0)
    const lastLenU16 = Buffer.alloc(2); lastLenU16.writeUInt16BE(4, 0)
    const keyInfoPlain = Buffer.concat([
        u64beBuf(2),
        firstLenU16, firstTerm,
        lastLenU16, lastTerm,
        u64beBuf(keyCompBlock.length),
        u64beBuf(keyPayload.length),
    ])

    // Encrypt keyInfo with RIPEMD-128 fast decrypt inverse: wait our parser decrypts keyInfo AFTER decompressing if KeyHeader has Encrypted=2!
    // Wait: inspect how parseMdxBuffer expects keyHeader (40 bytes in v2):
    // [numKeyBlocks(8), numEntries(8), keyInfoDecompSize(8), keyInfoCompSize(8), keyBlocksTotalSize(8)] + 4-byte adler32
    const keyInfoComp = zlib.deflateSync(keyInfoPlain)
    const keyInfoCompBlock = Buffer.concat([
        u32leBuf(2),
        u32beBuf(adler32Bytes(keyInfoPlain)),
        keyInfoComp
    ])
    // Encrypt keyInfoCompBlock payload when Encrypted & 2:
    // Notice decryptMdxKeyBlock expects: [compType(4)][adler32(4)][encrypted-compressed] or raw depending on MDX spec.
    // Specifically in custom-dict-importer.js:
    //   keyInfoRaw = bytes.subarray(pos, pos + keyInfoCompSize)
    //   if (encrypted & 2) decrypt keyInfoRaw[8..] with ripemd128(keyInfoRaw[4..8] + \x95\x36\0\0) then zlib decompress!
    const checksumSlice = Buffer.from(keyInfoCompBlock.subarray(4, 8))
    const keySeed = Buffer.concat([checksumSlice, Buffer.from([0x95, 0x36, 0x00, 0x00])])
    const keyBytes = ripemd128(keySeed)
    // Apply exact inverse of fast_decrypt on bytes[pos..] (note decryptMdxKeyBlock uses key[i % 16])
    const encPayload = Buffer.from(keyInfoComp)
    let prevByte = 0x36
    // forward decrypt: b = ((c >> 4) | (c << 4)) & 0xff; plain = b ^ prev ^ (i & 0xff) ^ key[i % len]; prev = c
    // Exact inverse from plain -> cipher c:
    // b = plain ^ prev ^ (i & 0xff) ^ key[i % len]
    // c = ((b >> 4) | (b << 4)) & 0xff; prev = c
    for (let i = 0; i < encPayload.length; i++) {
        const b = encPayload[i] ^ prevByte ^ (i & 0xff) ^ keyBytes[i % keyBytes.length]
        const c = ((b >> 4) | (b << 4)) & 0xff
        encPayload[i] = c
        prevByte = c
    }
    const encryptedKeyInfoBlock = Buffer.concat([
        u32leBuf(2),
        checksumSlice,
        encPayload
    ])

    const keyHeader = Buffer.concat([
        u64beBuf(1), // numKeyBlocks
        u64beBuf(2), // numEntries
        u64beBuf(keyInfoPlain.length),
        u64beBuf(encryptedKeyInfoBlock.length),
        u64beBuf(keyCompBlock.length),
    ])
    const keyHeaderCheck = u32leBuf(adler32Bytes(keyHeader))

    const recordHeader = Buffer.concat([
        u64beBuf(1), // numRecordBlocks
        u64beBuf(2), // numEntries
        u64beBuf(8), // recordInfoSize (numRecordBlocks * 2 * 8? Actually 16 bytes for 1 block!)
        u64beBuf(recordCompBlock.length),
    ])
    // Wait: recordHeader in MDX v2 is 32 bytes (4x8) -> recordInfoSize = 16 bytes
    const recordHeaderFixed = Buffer.concat([
        u64beBuf(1),
        u64beBuf(2),
        u64beBuf(16),
        u64beBuf(recordCompBlock.length),
    ])
    const recordInfo = Buffer.concat([
        u64beBuf(recordCompBlock.length),
        u64beBuf(recordUncomp.length),
    ])

    const fullMdx = Buffer.concat([
        u32beBuf(headerBuf.length),
        headerBuf,
        headerCheck,
        keyHeader,
        keyHeaderCheck,
        encryptedKeyInfoBlock,
        keyCompBlock,
        recordHeaderFixed,
        recordInfo,
        recordCompBlock,
    ])

    const parsed = await parseMdxBuffer(fullMdx.buffer.slice(fullMdx.byteOffset, fullMdx.byteOffset + fullMdx.byteLength), 'Fallback')
    assert.equal(parsed.title, 'Synthetic MDX v2')
    assert.equal(parsed.format, 'mdx')
    assert.equal(parsed.entries.length, 2)
    assert.equal(parsed.entries[0].word, 'alpha')
    assert.ok(parsed.entries[0].definition.includes('first definition'))
    assert.equal(parsed.entries[1].word, 'beta')
    assert.ok(parsed.entries[1].definition.includes('second definition'))
})

// ============================================================================
// 3. Reversible Chinese Simplified <-> Traditional Script Conversion
// ============================================================================

test('convertChineseScript and applyChineseScriptToDocument are reversible and exclude code blocks', () => {
    const s = '阅读器皇后图书馆发财'
    const tText = convertChineseScript(s, 's2t')
    assert.ok(tText.includes('閱讀器') && tText.includes('圖書館'))
    assert.equal(convertChineseScript('閱讀器', 't2s'), '阅读器')

    const makeNode = (val, tag = 'P') => ({ nodeValue: val, parentElement: { tagName: tag, parentElement: null } })
    const n1 = makeNode('简体书籍测试皇后与头发。', 'P')
    const nCode = makeNode('const 书籍 = "阅读";', 'CODE')
    const nPre = makeNode('pre 简体文本', 'PRE')
    const nodes = [n1, nCode, nPre]
    const origN1 = n1.nodeValue
    const mockDoc = {
        body: { textContent: origN1 },
        createTreeWalker() {
            let idx = 0
            return { nextNode: () => (idx < nodes.length ? nodes[idx++] : null) }
        }
    }

    applyChineseScriptToDocument(mockDoc, 's2t')
    assert.notEqual(n1.nodeValue, origN1)
    assert.ok(n1.nodeValue.includes('書籍'))
    assert.equal(nCode.nodeValue, 'const 书籍 = "阅读";')
    assert.equal(nPre.nodeValue, 'pre 简体文本')

    applyChineseScriptToDocument(mockDoc, 'original')
    assert.equal(n1.nodeValue, origN1, 'switching back to original restores exact original text')
})

// ============================================================================
// 4. Offline TXT Ad / Watermark Purification
// ============================================================================

test('purifyTxtContent removes site ads & blank lines while preserving chapter headings and custom rules', () => {
    const input = [
        '第一章 初入江湖',
        '请记住本站网址 https://www.biquge-example.net/ 最新章节！',
        '',
        '',
        '',
        '他推开木门，风雪扑面而来。',
        '（本章未完，请点击下一页继续阅读）',
        '这是自定义词广告测试。',
    ].join('\n')

    const clean = purifyTxtContent(input, {
        enabled: true,
        stripAds: true,
        collapseBlankLines: true,
        customRulesText: '自定义词广告=>\n/([a+]+)+$/=>ignored_redos',
    })

    assert.ok(clean.includes('第一章 初入江湖'))
    assert.ok(clean.includes('他推开木门，风雪扑面而来。'))
    assert.equal(clean.includes('biquge-example'), false)
    assert.equal(clean.includes('本章未完'), false)
    assert.equal(clean.includes('自定义词广告'), false)
    assert.equal(clean.includes('\n\n\n'), false)
})

// ============================================================================
// 5. Free Kindle My Clippings Importer
// ============================================================================

test('parseKindleClippings & matchClippingsToLibrary parse EN/ZH clippings, deduplicate, and match shelf', () => {
    const raw = `
认知心理学 (Robert Solso)
- 您在位置 #100-104 的标注 | 添加于 2024年1月1日
关注注意力选择机制
==========
认知心理学 (Robert Solso)
- 您在位置 #100-106 的标注 | 添加于 2024年1月1日
关注注意力选择机制，过滤无关刺激。
==========
认知心理学 (Robert Solso)
- 您在位置 #104-104 的笔记 | 添加于 2024年1月1日
重点复习这里
==========
Deep Work (Cal Newport)
- Your Highlight on page 42 | Location 500-510 | Added on Sunday
Deep work is the ability to focus without distraction.
==========
`
    const parsed = parseKindleClippings(raw)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0].title, '认知心理学')
    assert.equal(parsed[0].highlights.length, 1, 'overlapping progressive highlight deduplicated')
    assert.equal(parsed[0].highlights[0].text, '关注注意力选择机制，过滤无关刺激。')
    assert.equal(parsed[0].highlights[0].note, '重点复习这里')

    const matched = matchClippingsToLibrary(parsed, [
        { id: 'book_cog', title: '认知心理学', author: 'Robert Solso' },
        { id: 'book_other', title: '无关书籍', author: 'Other' },
    ])
    assert.equal(matched[0].matchedBookId, 'book_cog')
    assert.equal(matched[1].matchedBookId, null)
})

// ============================================================================
// 6. Text Fingerprint Relinking & Direct-First PDF Open & Sync Divergences
// ============================================================================

test('computeTextSampleFingerprint and scoreRelinkCandidate rank matching books highest', () => {
    const sample = '深度学习神经网络的反向传播算法通过链式法则计算梯度并优化损失函数。'.repeat(12)
    const fp1 = computeTextSampleFingerprint(sample)
    const fp2 = computeTextSampleFingerprint(`${sample}补充附录几行文字。`)
    const fpOther = computeTextSampleFingerprint('完全不同的古代历史文献纪传体通史资料。'.repeat(12))

    const target = { id: 'new_book', title: 'Deep Learning Notes', author: 'A', format: 'pdf', textFingerprint: fp1 }
    const candMatch = { id: 'old_book', title: 'Deep Learning Notes (v1)', author: 'A', format: 'pdf', textFingerprint: fp2 }
    const candMiss = { id: 'unrelated', title: '史记选读', author: 'B', format: 'epub', textFingerprint: fpOther }

    const sMatch = scoreRelinkCandidate(target, candMatch, { highlights: 5, bookmarks: 1, pdfDrawings: 0 })
    const sMiss = scoreRelinkCandidate(target, candMiss, { highlights: 1, bookmarks: 0, pdfDrawings: 0 })
    assert.ok(sMatch.score > sMiss.score + 30)
    assert.ok(sMatch.reasons.includes('text_fingerprint'))
})

test('openLocalPdfDirectFirst opens read-only without synchronous stagePdfSource and honors ephemeral mode', async () => {
    let stageCalls = 0
    let saveCalls = 0
    const mockDb = {
        getAllBooks: async () => [],
        saveBook: async (b) => { saveCalls++; return b },
    }
    const mockBridge = {
        authorizeDirectPdfPath: async () => true,
        getNativeFileIdentity: async () => ({ fileId: 'vol:123', size: 50000000 }),
        stagePdfSource: async () => { stageCalls++; return { path: 'staged.pdf' } },
    }

    const ephem = await openLocalPdfDirectFirst({ filePath: 'D:/Books/huge.pdf', filename: 'huge.pdf', size: 50000000 }, {
        db: mockDb, bridge: mockBridge, mode: 'ephemeral'
    })
    assert.equal(ephem.ephemeral, true)
    assert.equal(ephem.descriptor.directReadOnly, true)
    assert.equal(stageCalls, 0)
    assert.equal(saveCalls, 0)

    const direct = await openLocalPdfDirectFirst({ filePath: 'D:/Books/huge.pdf', filename: 'huge.pdf', size: 50000000 }, {
        db: mockDb, bridge: mockBridge, mode: 'direct'
    })
    assert.equal(direct.ephemeral, false)
    assert.equal(direct.needsBackgroundReconcile, true)
    assert.equal(direct.descriptor.directReadOnly, true)
    assert.equal(stageCalls, 0)
    assert.equal(saveCalls, 1)
})

test('mergeSyncData emits deterministic progressDivergences for large cross-device offsets', () => {
    const localPayload = {
        clientId: 'client_desktop',
        booksMeta: [
            { id: 'b2', title: 'Book Two', format: 'epub', updatedAt: 2000, progress: { fraction: 0.72, page: 140, updatedAt: 2000 } },
            { id: 'b1', title: 'Book One', format: 'pdf', updatedAt: 1000, progress: { fraction: 0.15, page: 15, updatedAt: 1000 } },
        ]
    }
    const remotePayload = {
        clientId: 'client_android',
        deviceName: 'Android Tablet',
        booksMeta: [
            { id: 'b2', title: 'Book Two', format: 'epub', updatedAt: 2500, progress: { fraction: 0.40, page: 80, updatedAt: 2500 } },
            { id: 'b1', title: 'Book One', format: 'pdf', updatedAt: 3000, progress: { fraction: 0.55, page: 55, updatedAt: 3000 } },
        ]
    }

    const res = mergeSyncData(localPayload, remotePayload, { nowMs: 4000, localClientId: 'client_desktop' })
    assert.equal(res.progressDivergences.length, 2)
    assert.equal(res.progressDivergences[0].bookId, 'b1')
    assert.equal(res.progressDivergences[1].bookId, 'b2')
    assert.ok(Math.abs(res.progressDivergences[0].alternateFraction - 0.15) < 1e-6)
    assert.ok(Math.abs(res.progressDivergences[1].winnerFraction - 0.40) < 1e-6)
})
