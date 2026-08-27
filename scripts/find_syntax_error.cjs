const fs = require('fs');
const path = require('path');
const vm = require('vm');

function getAllJs(dir) {
    let res = [];
    fs.readdirSync(dir).forEach(f => {
        if (f === 'node_modules' || f === 'dist' || f === '.git') return;
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) res = res.concat(getAllJs(p));
        else if (p.endsWith('.js')) res.push(p);
    });
    return res;
}

const files = getAllJs('.');
console.log('Testing ' + files.length + ' JS files...');

for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    // Remove import and export statements to test body syntax
    const cleaned = code
        .replace(/^import\s+.*?['"].*?['"];?/gm, '// import')
        .replace(/^export\s+.*?;?/gm, '// export')
        .replace(/import\(/g, 'void(')
    try {
        new vm.Script(cleaned, { filename: file });
        console.log(file + ': OK');
    } catch (e) {
        console.log('>>> SYNTAX ERROR IN ' + file);
        console.log(e.stack.split('\n').slice(0, 3).join('\n'));
    }
}
