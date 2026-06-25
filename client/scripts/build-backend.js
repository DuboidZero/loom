const { execSync } = require('child_process');
const path = require('path');

const candidates = [
    "../loom-venv/bin/python",
    "../.venv/bin/python",
    "../venv/bin/python",
    "python",
    "python3"
];

let selectedPython = null;

for (const candidate of candidates) {
    console.log(`Trying ${candidate}...`);
    try {
        execSync(`${candidate} -m PyInstaller --version`, { stdio: 'ignore' });
        console.log(`Success! Using interpreter: ${candidate}`);
        selectedPython = candidate;
        break;
    } catch (error) {
        // Continue to the next candidate
    }
}

if (!selectedPython) {
    console.error("Failed to find a suitable Python interpreter with PyInstaller.");
    process.exit(1);
}

const serverPath = path.resolve(__dirname, '../../server');
const command = `${selectedPython} -m PyInstaller loom.spec --distpath ./dist --workpath ./build --noconfirm`;

console.log(`Running in ${serverPath}: ${command}`);

try {
    execSync(command, { cwd: serverPath, stdio: 'inherit' });
} catch (error) {
    console.error("Build failed.");
    process.exit(1);
}
