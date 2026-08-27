// docx.js - Word (.docx) document parser and reflowable paginator for foliate-js using Mammoth

const MIME = {
    XHTML: 'application/xhtml+xml',
    SVG: 'image/svg+xml',
}

const escapeHTML = str => {
    if (!str) return ''
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

// Generate an elegant Word/Document style SVG book cover
const generateDocxCoverSVG = (title, author) => {
    const safeTitle = escapeHTML(title.length > 26 ? title.slice(0, 24) + '...' : title)
    const safeAuthor = escapeHTML(author || 'Word 文档')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
  <defs>
    <linearGradient id="docxBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e3a8a"/>
      <stop offset="50%" stop-color="#1e40af"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="badgeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="600" height="900" fill="url(#docxBg)"/>
  
  <!-- Inner Page Frame -->
  <rect x="36" y="36" width="528" height="828" rx="8" fill="none" stroke="#3b82f6" stroke-width="1.5" stroke-opacity="0.4"/>
  <rect x="48" y="48" width="504" height="804" rx="6" fill="none" stroke="#60a5fa" stroke-width="1" stroke-opacity="0.2"/>
  
  <!-- Word DOCX Badge Icon -->
  <g transform="translate(250, 160)" filter="url(#shadow)">
    <rect width="100" height="100" rx="18" fill="url(#badgeGrad)"/>
    <text x="50" y="66" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="38" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="1">W</text>
  </g>

  <!-- Format Tag -->
  <rect x="250" y="275" width="100" height="24" rx="12" fill="rgba(255, 255, 255, 0.15)"/>
  <text x="300" y="291" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" font-weight="700" fill="#93c5fd" text-anchor="middle" letter-spacing="2">DOCX 文档</text>
  
  <!-- Title Line -->
  <line x1="80" y1="340" x2="520" y2="340" stroke="#3b82f6" stroke-width="1" stroke-opacity="0.3"/>
  
  <!-- Main Title -->
  <text x="300" y="440" font-family="'Source Han Serif SC', 'Noto Serif SC', 'Songti SC', serif" font-size="36" font-weight="700" fill="#f8fafc" text-anchor="middle" letter-spacing="1">
    ${safeTitle}
  </text>
  
  <!-- Divider -->
  <line x1="260" y1="500" x2="340" y2="500" stroke="#60a5fa" stroke-width="2" stroke-linecap="round"/>
  
  <!-- Author -->
  <text x="300" y="550" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif" font-size="20" fill="#93c5fd" text-anchor="middle">
    ${safeAuthor}
  </text>
  
  <!-- Bottom Ribbon -->
  <line x1="80" y1="780" x2="520" y2="780" stroke="#3b82f6" stroke-width="1" stroke-opacity="0.3"/>
  <text x="300" y="815" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" fill="#64748b" text-anchor="middle" letter-spacing="2">LINDEN LEAF READER</text>
</svg>`
}

export const isDOCX = (file, loader) => {
    if (!file) return false
    const name = file.name ? file.name.toLowerCase() : ''
    const type = file.type || ''
    if (name.endsWith('.docx')) return true
    if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return true
    if (loader?.entries?.some(e => e.filename === 'word/document.xml')) return true
    return false
}

// Extract Dublin Core metadata from docProps/core.xml
const extractDocxMetadata = async (loader, defaultTitle) => {
    let title = defaultTitle
    let author = '未知作者'
    let description = ''

    if (loader && typeof loader.loadText === 'function') {
        try {
            const coreXml = await loader.loadText('docProps/core.xml')
            if (coreXml) {
                const doc = new DOMParser().parseFromString(coreXml, 'application/xml')
                const dcTitle = doc.querySelector('title, dc\\:title')?.textContent?.trim()
                const dcAuthor = doc.querySelector('creator, dc\\:creator')?.textContent?.trim()
                const dcDesc = doc.querySelector('description, dc\\:description')?.textContent?.trim()

                if (dcTitle) title = dcTitle
                if (dcAuthor) author = dcAuthor
                if (dcDesc) description = dcDesc
            }
        } catch (e) {
            console.warn('[DOCX] Metadata extraction notice:', e.message)
        }
    }

    return { title, author, description }
}

// Ensure Mammoth is loaded
const ensureMammoth = async () => {
    if (typeof window !== 'undefined' && window.mammoth) {
        return window.mammoth
    }
    try {
        // Try importing from vendor
        const mammothModule = await import('../vendor/mammoth/mammoth.browser.min.js')
        if (mammothModule?.default) return mammothModule.default
        if (typeof window !== 'undefined' && window.mammoth) return window.mammoth
    } catch {
        // Dynamic script injection fallback
        if (typeof document !== 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script')
                script.src = './vendor/mammoth/mammoth.browser.min.js'
                script.onload = () => resolve(window.mammoth)
                script.onerror = reject
                document.head.appendChild(script)
            })
            return window.mammoth
        }
    }
    throw new Error('Failed to load Mammoth.js DOCX engine')
}

export const makeDOCX = async (loader, file) => {
    const rawFileName = file.name ? file.name.replace(/\.[^/.]+$/, '').trim() : 'Word 文档'
    const meta = await extractDocxMetadata(loader, rawFileName)
    const title = meta.title || rawFileName
    const author = meta.author || '未知作者'

    const urls = []
    const mammoth = await ensureMammoth()
    const arrayBuffer = await file.arrayBuffer()

    const mammothOptions = {
        styleMap: [
            "p[style-name='Title'] => h1.doc-title:fresh",
            "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Heading 4'] => h4:fresh",
            "p[style-name='Quote'] => blockquote:fresh",
            "p[style-name='Intense Quote'] => blockquote.intense-quote:fresh"
        ],
        convertImage: mammoth.images.imgElement(image => {
            return image.read('arrayBuffer').then(buf => {
                const blob = new Blob([buf], { type: image.contentType || 'image/png' })
                const url = URL.createObjectURL(blob)
                urls.push(url)
                return { src: url }
            }).catch(() => {
                return image.read('base64').then(imageBuffer => ({
                    src: `data:${image.contentType};base64,${imageBuffer}`
                }))
            })
        })
    }

    const { value: rawHtml } = await mammoth.convertToHtml({ arrayBuffer }, mammothOptions)

    // Split HTML into chapters/sections using DOMParser
    const parser = new DOMParser()
    const parsedDoc = parser.parseFromString(`<div id="root">${rawHtml}</div>`, 'text/html')
    const rootDiv = parsedDoc.getElementById('root')
    const children = Array.from(rootDiv.children)

    const chapters = []
    let currentChapter = {
        title: '文档概述',
        headingLevel: 1,
        elementsHtml: [],
        hasExplicitHeading: false
    }

    const isHeading = el => {
        const tag = el.tagName.toLowerCase()
        return tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || el.classList.contains('doc-title')
    }

    let hasAnyHeadings = false

    children.forEach(el => {
        if (isHeading(el)) {
            hasAnyHeadings = true
            if (currentChapter.elementsHtml.length > 0) {
                chapters.push(currentChapter)
            }
            const headingText = el.textContent.trim() || '章节'
            currentChapter = {
                title: headingText,
                headingLevel: parseInt(el.tagName.replace(/\D/g, ''), 10) || 1,
                elementsHtml: [el.outerHTML],
                hasExplicitHeading: true
            }
        } else {
            currentChapter.elementsHtml.push(el.outerHTML)
        }
    })

    if (currentChapter.elementsHtml.length > 0) {
        chapters.push(currentChapter)
    }

    // If no headings found, split by chunks if large, or keep single
    let finalChapters = chapters
    if (!hasAnyHeadings) {
        if (children.length > 30) {
            finalChapters = []
            const chunkSize = 20
            for (let i = 0; i < children.length; i += chunkSize) {
                const chunkElements = children.slice(i, i + chunkSize)
                finalChapters.push({
                    title: `第 ${Math.floor(i / chunkSize) + 1} 部分`,
                    elementsHtml: chunkElements.map(e => e.outerHTML),
                    hasExplicitHeading: false
                })
            }
        } else {
            finalChapters = [{
                title: title,
                elementsHtml: children.map(e => e.outerHTML),
                hasExplicitHeading: false
            }]
        }
    }

    // Comprehensive HTML to strict XHTML entity sanitizer
    const sanitizeHtmlForXhtml = html => {
        if (!html) return ''
        return html
            .replace(/&nbsp;/gi, '&#160;')
            .replace(/&thinsp;/gi, '&#8201;')
            .replace(/&ensp;/gi, '&#8194;')
            .replace(/&emsp;/gi, '&#8195;')
            .replace(/&mdash;/gi, '&#8212;')
            .replace(/&ndash;/gi, '&#8211;')
            .replace(/&ldquo;/gi, '&#8220;')
            .replace(/&rdquo;/gi, '&#8221;')
            .replace(/&lsquo;/gi, '&#8216;')
            .replace(/&rsquo;/gi, '&#8217;')
            .replace(/&hellip;/gi, '&#8230;')
            .replace(/&copy;/gi, '&#169;')
            .replace(/&reg;/gi, '&#174;')
            .replace(/&trade;/gi, '&#8482;')
            .replace(/&bull;/gi, '&#8226;')
            .replace(/&middot;/gi, '&#183;')
            .replace(/&sect;/gi, '&#167;')
            .replace(/&para;/gi, '&#182;')
            .replace(/&times;/gi, '&#215;')
            .replace(/&divide;/gi, '&#247;')
            .replace(/&plusmn;/gi, '&#177;')
            .replace(/&radic;/gi, '&#8730;')
            .replace(/&infin;/gi, '&#8734;')
            .replace(/&ne;/gi, '&#8800;')
            .replace(/&le;/gi, '&#8804;')
            .replace(/&ge;/gi, '&#8805;')
            .replace(/&larr;/gi, '&#8592;')
            .replace(/&uarr;/gi, '&#8593;')
            .replace(/&rarr;/gi, '&#8594;')
            .replace(/&darr;/gi, '&#8595;')
            .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)[a-zA-Z0-9]+;/g, ' ')
    }

    // Template for Foliate Section XHTML
    const sectionTemplate = (chapterTitle, contentHtml, sectionIndex) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html [
  <!ENTITY nbsp "&#160;">
  <!ENTITY copy "&#169;">
  <!ENTITY mdash "&#8212;">
  <!ENTITY ndash "&#8211;">
  <!ENTITY ldquo "&#8220;">
  <!ENTITY rdquo "&#8221;">
  <!ENTITY lsquo "&#8216;">
  <!ENTITY rsquo "&#8217;">
  <!ENTITY hellip "&#8230;">
  <!ENTITY bull "&#8226;">
  <!ENTITY middot "&#183;">
]>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHTML(chapterTitle)}</title>
  <style>
    @namespace "http://www.w3.org/1999/xhtml";
    html, body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif;
      font-size: 1rem;
      line-height: 1.85;
      color: inherit;
    }
    .docx-container {
      max-width: 100%;
      margin: 0 auto;
      padding: 0 1rem;
      word-wrap: break-word;
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: -apple-system, BlinkMacSystemFont, 'Noto Sans SC', 'PingFang SC', sans-serif;
      font-weight: 700;
      line-height: 1.4;
      color: inherit;
    }
    h1 {
      font-size: 1.6em;
      margin: 1.6em 0 1em 0;
      text-align: center;
      letter-spacing: 0.05em;
    }
    h2 {
      font-size: 1.3em;
      margin: 1.4em 0 0.8em 0;
      border-bottom: 1px solid rgba(125, 125, 125, 0.2);
      padding-bottom: 0.3em;
    }
    h3 {
      font-size: 1.1em;
      margin: 1.2em 0 0.6em 0;
    }
    p {
      text-indent: 2em;
      margin: 0.85em 0;
      text-align: justify;
      line-height: inherit;
    }
    blockquote {
      margin: 1.2em 0;
      padding: 0.6em 1.2em;
      border-left: 4px solid #3b82f6;
      background: rgba(59, 130, 246, 0.05);
      border-radius: 0 6px 6px 0;
      font-style: italic;
      text-indent: 0;
    }
    blockquote p {
      text-indent: 0;
      margin: 0.4em 0;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1.5em 0;
      font-size: 0.92em;
    }
    table, th, td {
      border: 1px solid rgba(125, 125, 125, 0.25);
    }
    th, td {
      padding: 0.6em 0.8em;
      text-align: left;
    }
    th {
      background: rgba(125, 125, 125, 0.1);
      font-weight: 600;
    }
    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1.5em auto;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }
    ul, ol {
      margin: 0.8em 0;
      padding-left: 2em;
    }
    li {
      margin: 0.4em 0;
    }
    code, pre {
      font-family: Consolas, Monaco, 'Courier New', monospace;
      font-size: 0.9em;
      background: rgba(125, 125, 125, 0.12);
      border-radius: 3px;
      padding: 0.2em 0.4em;
    }
  </style>
</head>
<body>
  <div class="docx-container" id="section-${sectionIndex}">
    <span id="heading-${sectionIndex}"></span>
    ${contentHtml}
  </div>
</body>
</html>`

    const sectionData = finalChapters.map((chapter, index) => {
        const rawContentHtml = chapter.elementsHtml.join('\n')
        const contentHtml = sanitizeHtmlForXhtml(rawContentHtml)
        const htmlStr = sectionTemplate(chapter.title, contentHtml, index)
        const blob = new Blob([htmlStr], { type: MIME.XHTML })
        const url = URL.createObjectURL(blob)
        urls.push(url)

        return {
            id: index,
            title: chapter.title,
            size: blob.size,
            load: () => url,
            createDocument: () => new DOMParser().parseFromString(htmlStr, MIME.XHTML)
        }
    })

    const coverSvg = generateDocxCoverSVG(title, author)
    const coverBlob = new Blob([coverSvg], { type: MIME.SVG })

    const book = {
        metadata: {
            title,
            author,
            description: meta.description || '',
            language: 'zh-CN',
            identifier: `docx-${Date.now()}`,
            format: 'docx'
        },
        sections: sectionData.map(s => ({
            id: s.id,
            load: s.load,
            createDocument: s.createDocument,
            size: s.size
        })),
        toc: sectionData.map((s, idx) => ({
            label: s.title,
            href: `${idx}#heading-${idx}`
        })),
        resolveHref: href => {
            if (!href) return { index: 0 }
            const [sectionIdx, anchorId] = href.split('#')
            return {
                index: parseInt(sectionIdx, 10) || 0,
                anchor: doc => anchorId ? doc.getElementById(anchorId) : null
            }
        },
        splitTOCHref: href => {
            if (!href) return []
            const parts = href.split('#')
            return [parseInt(parts[0], 10) || 0, parts[1] || '']
        },
        getTOCFragment: (doc, id) => id ? doc.getElementById(id) : null,
        isExternal: uri => /^\w+:/i.test(uri),
        getCover: () => coverBlob,
        destroy: () => {
            for (const u of urls) URL.revokeObjectURL(u)
        }
    }

    return book
}
