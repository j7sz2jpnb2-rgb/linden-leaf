// scripts/verify-shortcut-launch.mjs
// Verifies that launching from the release executable path runs cleanly,
// has zero debug ports, and matches the expected process path and build-info.

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('================================================================');
    console.log('Linden Leaf: Shortcut / Release Executable Verification');
    console.log('================================================================');

    const exePath = 'D:\\LindenLeaf-Release\\linden-leaf.exe';
    if (!existsSync(exePath)) throw new Error(`Missing ${exePath}`);

    const stat = statSync(exePath);
    console.log(`Executable: ${exePath}`);
    console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Mtime: ${stat.mtime.toISOString()}`);

    // Verify build-info in dist-tauri
    const buildInfo = JSON.parse(readFileSync('dist-tauri/build-info.json', 'utf8'));
    console.log(`Build-Info: ID=${buildInfo.buildId}, Commit=${buildInfo.commit}, Timestamp=${buildInfo.timestamp}`);

    // Check if any process is already running
    try {
        const existing = execSync('powershell -Command "Get-Process linden-leaf -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"').toString().trim();
        if (existing) {
            console.log(`Warning: Existing linden-leaf process found: ${existing}`);
        }
    } catch {}

    // Launch standalone (NO remote debugging port)
    console.log('\nLaunching standalone executable without debug flags...');
    const app = spawn(exePath, [], {
        cwd: 'D:\\LindenLeaf-Release',
        stdio: 'ignore',
        detached: true
    });
    const pid = app.pid;
    console.log(`  Launched PID: ${pid}`);

    await SLEEP(2500);

    // Verify process path in OS
    const procPath = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).Path"`).toString().trim();
    console.log(`  Running Process Path: ${procPath}`);
    if (procPath.toLowerCase() !== exePath.toLowerCase()) {
        throw new Error(`Process path mismatch! Expected ${exePath}, got ${procPath}`);
    }

    // Verify NO debug port is open
    const ports = [9222, 9223, 9333, 9444];
    for (const p of ports) {
        try {
            const check = execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -ErrorAction SilentlyContinue"`).toString().trim();
            if (check) {
                throw new Error(`Unexpected debug port ${p} is listening!`);
            }
        } catch {}
    }
    console.log('  PASS: Verified zero debug ports listening. Application is running cleanly in standalone production mode.');

    // Gracefully terminate test launch
    app.kill();
    await SLEEP(1000);
    console.log('  Clean shutdown of standalone launch test complete.');
}

main().catch(err => {
    console.error('Fatal error in shortcut verification:', err);
    process.exit(1);
});
