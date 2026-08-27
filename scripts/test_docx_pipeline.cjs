const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const mammoth = require('mammoth')

async function createSampleDocx(outputPath) {
    const zip = new JSZip()

    // [Content_Types].xml
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`)

    // _rels/.rels
    zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`)

    // docProps/core.xml
    zip.folder('docProps').file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>现代化电子书阅读器设计白皮书</dc:title>
  <dc:creator>Linden Leaf 研发团队</dc:creator>
  <dc:description>探讨拟物排版、多格式解析与全时区阅读统计的设计与实现。</dc:description>
  <cp:lastModifiedBy>深度读者</cp:lastModifiedBy>
</cp:coreProperties>`)

    // docProps/app.xml
    zip.folder('docProps').file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Office Word</Application>
  <TotalTime>120</TotalTime>
  <Pages>3</Pages>
  <Words>850</Words>
</Properties>`)

    // word/_rels/document.xml.rels
    zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`)

    // word/styles.xml
    zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="180" w:after="90"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr>
  </w:style>
</w:styles>`)

    // word/document.xml
    zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <!-- Chapter 1 -->
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>第一章：数字时代的拟物阅读美学</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>电子书阅读器不应仅仅是冰冷的代码展示器，而应当传递出纸质书籍的温度与沉淀。木质书架、精致书脊、书页厚度阴影，共同营造出静心阅读的仪式感。</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t>重要观察：</w:t></w:r>
      <w:r><w:t>当读者置身于优雅的环境中时，心流状态的进入速度将显著提升 40% 以上。</w:t></w:r>
    </w:p>
    
    <!-- Chapter 2 -->
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>第二章：全格式兼容架构演进</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>传统的阅读器往往将格式割裂开来。EPUB 走一种引擎，PDF 走另一种引擎，而 Word 文档（.docx）更是常常被排斥在阅读器之外，只能在臃肿的办公套件中打开。</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>通过将 OpenXML 标准语义化转译为标准 DOM，Linden Leaf 赋予了 Word 文档与出版级电子书完全同等的翻页、主题、高亮与划线能力。</w:t></w:r>
    </w:p>

    <!-- Chapter 3 -->
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>第三章：知识资产与思维卡片</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>阅读不仅是输入，更是思考的重构。六色荧光笔、五种笔刷手感，配合一键生成的高清书摘卡片，让阅读灵感随时在社交网络与个人知识库之间流淌。</w:t></w:r>
    </w:p>
    <w:sectPr/>
  </w:body>
</w:document>`)

    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(outputPath, buffer)
    console.log(`Successfully generated sample docx at: ${outputPath} (${buffer.length} bytes)`)
}

async function testPipeline() {
    const docxPath = path.join(__dirname, '../samples/sample_whitepaper.docx')
    await createSampleDocx(docxPath)

    console.log('\n--- Testing Mammoth Conversion ---')
    const result = await mammoth.convertToHtml({ path: docxPath })
    console.log('HTML Output:\n', result.value)
    console.log('Messages / Warnings:', result.messages)

    console.log('\n--- Testing Raw Text Extraction ---')
    const rawResult = await mammoth.extractRawText({ path: docxPath })
    console.log('Raw Text Output:\n', rawResult.value)
}

testPipeline().catch(console.error)
