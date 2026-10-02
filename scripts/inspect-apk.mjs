import fs from 'node:fs';

const apkPath = 'src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk';
if (!fs.existsSync(apkPath)) {
    console.log('APK not found at', apkPath);
    process.exit(0);
}
const buf = fs.readFileSync(apkPath);
console.log('APK total size:', buf.length);

let count = 0;
let emptyCount = 0;
let emptyBytes = 0;
let offset = 0;
const firstFewEmpty = [];

while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) === 0x04034b50) {
        count++;
        const fnLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);
        const compSize = buf.readUInt32LE(offset + 18);
        const entryLen = 30 + fnLen + extraLen + compSize;
        if (fnLen === 0) {
            emptyCount++;
            emptyBytes += entryLen;
            if (firstFewEmpty.length < 5) {
                firstFewEmpty.push({ offset, fnLen, extraLen, compSize, entryLen });
            }
        }
        offset += entryLen;
    } else {
        offset++;
    }
}

console.log(`Total local headers: ${count}`);
console.log(`Empty local headers: ${emptyCount}, empty bytes: ${emptyBytes} (~${(emptyBytes / 1024 / 1024).toFixed(2)} MiB)`);
console.log('First few empty headers:', firstFewEmpty);
