import fs from 'node:fs';

const imgPath = "C:/Users/YONGHU/.gemini/antigravity/brain/6b833ecb-e66c-4651-a9f4-72379ea4b411/.user_uploaded/media_1792938328374_19087733.jpg";
const buf = fs.readFileSync(imgPath);
console.log("File size:", buf.length);

let offset = 2;
while (offset < buf.length) {
  if (buf[offset] === 0xFF && (buf[offset+1] >= 0xC0 && buf[offset+1] <= 0xC3)) {
    const height = buf.readUInt16BE(offset + 5);
    const width = buf.readUInt16BE(offset + 7);
    console.log(`JPEG dimensions: width=${width}, height=${height}`);
    break;
  }
  const len = buf.readUInt16BE(offset + 2);
  offset += 2 + len;
}
