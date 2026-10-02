const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const desktop = path.join(process.env.USERPROFILE, 'Desktop');
const target = 'C:\\Windows\\System32\\wscript.exe';
const args = 'D:\\LindenLeaf-Dev\\astra-mupdf-core\\scripts\\launch-preview.vbs';
const workDir = 'D:\\LindenLeaf-Dev\\astra-mupdf-core';
const icon = 'D:\\LindenLeaf-Dev\\astra-mupdf-core\\build\\icon.ico';

function createShortcut(filename, desc) {
  const shortcutPath = path.join(desktop, filename);
  const vbsContent = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `Set sc = WshShell.CreateShortcut("${shortcutPath.replace(/\\/g, '\\\\')}")`,
    `sc.TargetPath = "${target.replace(/\\/g, '\\\\')}"`,
    `sc.Arguments = """${args.replace(/\\/g, '\\\\')}"""`,
    `sc.WorkingDirectory = "${workDir.replace(/\\/g, '\\\\')}"`,
    `sc.IconLocation = "${icon.replace(/\\/g, '\\\\')},0"`,
    `sc.Description = "${desc}"`,
    'sc.Save'
  ].join('\r\n');

  const tempVbs = path.join(__dirname, 'temp-shortcut.vbs');
  // Write with UTF-16LE (Unicode with BOM) so Windows Script Host handles Chinese correctly
  fs.writeFileSync(tempVbs, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbsContent, 'utf16le')]));

  try {
    execSync(`cscript //nologo "${tempVbs}"`, { stdio: 'inherit' });
    console.log('Shortcut created successfully:', shortcutPath);
  } finally {
    if (fs.existsSync(tempVbs)) fs.unlinkSync(tempVbs);
  }
}

createShortcut('Linden Leaf (Dev Preview).lnk', 'Linden Leaf - Realtime Dev Preview');
createShortcut('Linden Leaf 最新源码预览.lnk', 'Linden Leaf - 现代化全格式电子书阅读器 (最新源码实时预览)');
