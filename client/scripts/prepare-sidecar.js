const fs = require('fs');
const path = require('path');
const os = require('os');

const serverDist = path.resolve(__dirname, '../../server/dist');
const binariesDir = path.resolve(__dirname, '../src-tauri/binaries');

if (!fs.existsSync(binariesDir)) {
  fs.mkdirSync(binariesDir, { recursive: true });
}

let src = '';
let dest = '';

if (os.platform() === 'win32') {
  src = path.join(serverDist, 'loom-backend.exe');
  dest = path.join(binariesDir, 'loom-backend-x86_64-pc-windows-msvc.exe');
} else if (os.platform() === 'linux') {
  src = path.join(serverDist, 'loom-backend');
  dest = path.join(binariesDir, 'loom-backend-x86_64-unknown-linux-gnu');
} else if (os.platform() === 'darwin') {
  src = path.join(serverDist, 'loom-backend');
  dest = path.join(binariesDir, 'loom-backend-x86_64-apple-darwin');
}

console.log(`Copying backend binary from ${src} to ${dest}...`);
try {
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755); // Ensure it's executable
  console.log('Copy complete.');
} catch (e) {
  console.error(`Failed to copy sidecar binary: ${e.message}`);
  process.exit(1);
}
