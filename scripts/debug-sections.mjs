import fs from 'node:fs';

const opf = fs.readFileSync('D:/LindenLeaf-Data/test-env/epub-inspect/don-quixote/content.opf', 'utf8');
const manifestMatches = [...opf.matchAll(/id="([^"]+)"\s+href="([^"]+)"/g)];
const map = Object.fromEntries(manifestMatches.map(m => [m[1], m[2]]));

const spineMatches = [...opf.matchAll(/idref="([^"]+)"/g)];
spineMatches.forEach((m, idx) => {
    console.log(`Index ${idx}: idref=${m[1]} -> ${map[m[1]]}`);
});
