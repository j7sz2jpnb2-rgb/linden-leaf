// Development-only AST checks using the Acorn bundled with the project's Node runtime.
// No parser or validation machinery is shipped in the reader.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('internal/deps/acorn/acorn/dist/acorn');
const root = path.resolve(__dirname, '..');
const parse = s => acorn.parse(s, { sourceType: 'module', ecmaVersion: 'latest', locations: true });
function duplicateMembers(ast) {
    const duplicates = [];
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
            const seen = new Set();
            for (const member of node.body.body) {
                if (member.type !== 'MethodDefinition' || member.computed) continue;
                const name = member.key.name || member.key.value;
                const key = [Boolean(member.static), member.kind, name].join(':');
                if (seen.has(key)) duplicates.push({ name, line: member.loc.start.line });
                seen.add(key);
            }
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value?.type) visit(value);
        }
    }
    visit(ast);
    return duplicates;
}
if (process.argv.includes('--check-runner')) {
    const found = duplicateMembers(parse('class Broken { start() {} start() {} }'));
    console.error('Intentional duplicate-member probe:', found);
    process.exit(found.length ? 1 : 0);
}
let failures = 0;
const files = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js'));
for (const file of files) {
    const ast = parse(fs.readFileSync(path.join(root, 'js', file), 'utf8'));
    for (const duplicate of duplicateMembers(ast)) {
        failures++;
        console.error(`[FAIL] ${file}:${duplicate.line} duplicate ${duplicate.name}`);
    }
    if (file.endsWith('-controller.js') || file === 'foliate-section-binder.js') {
        for (const node of ast.body) {
            if (node.type === 'ImportDeclaration' && path.posix.basename(node.source.value) === 'app.js') {
                failures++;
                console.error(`[FAIL] ${file} imports App; use its explicit constructor/session interface.`);
            }
        }
    }
}
const pure = ['sync-model.js', 'book-metadata.js', 'reading-data.js', 'document-identity.js'];
for (const file of pure) {
    const ast = parse(fs.readFileSync(path.join(root, 'js', file), 'utf8'));
    for (const node of ast.body) {
        if (node.type === 'ImportDeclaration' && ['db.js', 'app.js', 'platformBridge.js', 'advanced-settings.js', 'tts-player.js'].includes(path.posix.basename(node.source.value))) {
            failures++;
            console.error(`[FAIL] pure model ${file} depends on ${node.source.value}`);
        }
    }
}
(() => {
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const rootDir = pathMod.resolve(__dirname, '..');

  const checkDupAttrs = (sourceLabel, tagName, attrsStr) => {
    const seen = new Set();
    const attrRe = /(?:^|\s)([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    let m;
    while ((m = attrRe.exec(attrsStr)) !== null) {
      const attrName = m[1].toLowerCase();
      if (seen.has(attrName)) {
        console.error(`[structure] Duplicate attribute "${attrName}" on <${tagName}> in ${sourceLabel}`);
        failures += 1;
      }
      seen.add(attrName);
    }
  };

  // (a) & (c): index.html duplicate IDs and duplicate attributes on the same opening tag
  const indexPath = pathMod.join(rootDir, 'index.html');
  if (fsMod.existsSync(indexPath)) {
    const rawHtml = fsMod.readFileSync(indexPath, 'utf8');
    const markupOnly = rawHtml
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
    const idLocs = new Map();
    const tagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/g;
    let tm;
    while ((tm = tagRe.exec(markupOnly)) !== null) {
      const tagName = tm[1];
      const attrs = tm[2] || '';
      if (!attrs) continue;
      checkDupAttrs('index.html', tagName, attrs);
      const idMatch = /(?:^|\s)id\s*=\s*(["'])([^"']+)\1/i.exec(attrs);
      if (idMatch) {
        const idVal = idMatch[2];
        idLocs.set(idVal, (idLocs.get(idVal) || 0) + 1);
      }
    }
    for (const [idVal, count] of idLocs.entries()) {
      if (count > 1) {
        console.error(`[structure] Duplicate id="${idVal}" (${count} occurrences) in index.html`);
        failures += 1;
      }
    }
  }

  // (c): duplicate HTML attributes in JS HTML template tags
  const jsTagsRe = /<(button|div|span|input|select|textarea|label|a|form|img|option|section|header|footer|ul|li|p|h[1-6]|tr|td|th)\b((?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'=<>`${}]+))?)+)\s*\/?>/g;
  for (const jsRelPath of files) {
    const absJs = pathMod.isAbsolute(jsRelPath) ? jsRelPath : pathMod.join(rootDir, 'js', jsRelPath);
    if (!fsMod.existsSync(absJs)) continue;
    const jsSrc = fsMod.readFileSync(absJs, 'utf8');
    let jm;
    while ((jm = jsTagsRe.exec(jsSrc)) !== null) {
      checkDupAttrs(pathMod.relative(rootDir, absJs), jm[1], jm[2]);
    }
  }

  // (b): duplicate @keyframes names across css/*.css
  const cssDir = pathMod.join(rootDir, 'css');
  if (fsMod.existsSync(cssDir)) {
    const keyframesMap = new Map();
    const cssFiles = fsMod.readdirSync(cssDir).filter((f) => f.endsWith('.css')).sort();
    for (const cssFile of cssFiles) {
      const cssSrc = fsMod.readFileSync(pathMod.join(cssDir, cssFile), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const kfRe = /@keyframes\s+([A-Za-z_][\w-]*)/g;
      let km;
      while ((km = kfRe.exec(cssSrc)) !== null) {
        const name = km[1];
        const list = keyframesMap.get(name) || [];
        list.push(`css/${cssFile}`);
        keyframesMap.set(name, list);
      }
    }
    for (const [kfName, locations] of keyframesMap.entries()) {
      if (locations.length > 1) {
        console.error(`[structure] Duplicate @keyframes "${kfName}" across: ${locations.join(', ')}`);
        failures += 1;
      }
    }

    // (d): CSS !important ratchet ceiling so CSS override technical debt never grows
    const MAX_CSS_IMPORTANT = 1291;
    let importantCount = 0;
    for (const cssFile of cssFiles) {
      const cssSrc = fsMod.readFileSync(pathMod.join(cssDir, cssFile), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const matches = cssSrc.match(/!important\b/g);
      if (matches) importantCount += matches.length;
    }
    if (importantCount > MAX_CSS_IMPORTANT) {
      console.error(`[structure] CSS !important count (${importantCount}) exceeded ratchet ceiling (${MAX_CSS_IMPORTANT}).`);
      failures += 1;
    }
  }
})();
console.log(`Structure checks: ${files.length} JS files, ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
