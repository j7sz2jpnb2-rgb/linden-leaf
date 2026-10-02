// scripts/fast-download.js
// Multi-connection parallel downloader for Android toolchain archives
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');

async function download(urlStr, destPath, connections = 16) {
  console.log(`Starting multi-connection download:\n  URL:  ${urlStr}\n  DEST: ${destPath}\n  CONCURRENCY: ${connections}`);

  const parsedUrl = new URL(urlStr);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  // 1. Get file size
  const head = await new Promise((resolve, reject) => {
    const req = client.request(urlStr, { method: 'HEAD' }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(res.headers.location, destPath, connections));
      }
      resolve(res.headers);
    });
    req.on('error', reject);
    req.end();
  });

  if (!head || !head['content-length']) {
    throw new Error('Failed to retrieve Content-Length from HEAD request');
  }

  const totalSize = parseInt(head['content-length'], 10);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

  const tempFile = destPath + '.part';
  const fd = fs.openSync(tempFile, 'w');
  // Pre-allocate file size
  fs.ftruncateSync(fd, totalSize);

  const chunkSize = Math.ceil(totalSize / connections);
  let totalDownloaded = 0;
  const startTime = Date.now();

  const progressInterval = setInterval(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const mb = (totalDownloaded / 1024 / 1024).toFixed(2);
    const speed = (totalDownloaded / 1024 / 1024 / elapsedSec).toFixed(2);
    const pct = ((totalDownloaded / totalSize) * 100).toFixed(1);
    process.stdout.write(`\r[${pct}%] ${mb} MB / ${(totalSize / 1024 / 1024).toFixed(2)} MB @ ${speed} MB/s...`);
  }, 1000);

  async function downloadChunk(index, start, end) {
    let retries = 5;
    while (retries > 0) {
      try {
        await new Promise((resolve, reject) => {
          const req = client.get(urlStr, {
            headers: {
              Range: `bytes=${start}-${end}`,
              'User-Agent': 'Mozilla/5.0 LindenLeaf-Downloader'
            }
          }, (res) => {
            if (res.statusCode !== 206 && res.statusCode !== 200) {
              return reject(new Error(`Bad status code ${res.statusCode} for chunk ${index}`));
            }
            let currentOffset = start;
            res.on('data', (buf) => {
              fs.writeSync(fd, buf, 0, buf.length, currentOffset);
              currentOffset += buf.length;
              totalDownloaded += buf.length;
            });
            res.on('end', () => resolve());
            res.on('error', reject);
          });
          req.on('error', reject);
        });
        return; // Success
      } catch (err) {
        retries--;
        console.warn(`\nChunk ${index} failed: ${err.message}. Retrying (${retries} left)...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error(`Chunk ${index} failed after all retries`);
  }

  const tasks = [];
  for (let i = 0; i < connections; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
    if (start <= end) {
      tasks.push(downloadChunk(i, start, end));
    }
  }

  try {
    await Promise.all(tasks);
    clearInterval(progressInterval);
    fs.closeSync(fd);
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
    fs.renameSync(tempFile, destPath);
    const totalSec = (Date.now() - startTime) / 1000;
    console.log(`\nDownload completed successfully in ${totalSec.toFixed(1)}s!`);
  } catch (err) {
    clearInterval(progressInterval);
    try { fs.closeSync(fd); } catch (e) {}
    throw err;
  }
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node fast-download.js <URL> <DestPath> [connections]');
  process.exit(1);
}

download(args[0], args[1], parseInt(args[2] || '16', 10))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Download failed:', err);
    process.exit(1);
  });
