import fs from 'fs';
const buf = fs.readFileSync('C:/Users/YONGHU/Desktop/最新反馈/微信图片_20261022125151_160_122.jpg');
for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0xFF && [0xC0, 0xC1, 0xC2, 0xC3].includes(buf[i+1])) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        console.log(`Found SOF at ${i}: Image Size: ${w} x ${h}`);
        break;
    }
}
