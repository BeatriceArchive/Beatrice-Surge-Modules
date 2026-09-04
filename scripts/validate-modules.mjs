import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = path.join(ROOT, 'Modules');
const SCRIPTS_DIR = path.join(ROOT, 'Scripts');
const LOCAL_RAW_PREFIX = 'https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/';
const errors = [];

function check(condition, message) {
    if (!condition) errors.push(message);
}

function textFiles(dir, suffix) {
    return readdirSync(dir)
        .filter(name => name.endsWith(suffix))
        .sort((a, b) => a.localeCompare(b, 'en'));
}

const moduleFiles = textFiles(MODULES_DIR, '.sgmodule');
const scriptFiles = textFiles(SCRIPTS_DIR, '.js');

check(moduleFiles.length > 0, 'Modules/ must contain at least one .sgmodule file');
check(scriptFiles.length > 0, 'Scripts/ must contain at least one .js file');

const moduleNames = new Map();
let localScriptReferenceCount = 0;

for (const file of moduleFiles) {
    const relative = `Modules/${file}`;
    const text = readFileSync(path.join(MODULES_DIR, file), 'utf8');

    check(text.length > 0, `${relative}: file must not be empty`);
    check(text.charCodeAt(0) !== 0xFEFF, `${relative}: UTF-8 BOM is not allowed`);
    check(text.endsWith('\n'), `${relative}: file must end with a newline`);

    text.split(/\r?\n/).forEach((line, index) => {
        check(!/[ \t]+$/.test(line), `${relative}:${index + 1}: trailing whitespace`);
    });

    const nameMatch = text.match(/^#!name=(.+)$/m);
    check(Boolean(nameMatch?.[1]?.trim()), `${relative}: missing #!name metadata`);
    if (nameMatch?.[1]?.trim()) {
        const name = nameMatch[1].trim();
        const previous = moduleNames.get(name);
        check(!previous, `${relative}: duplicate #!name "${name}" already used by ${previous}`);
        moduleNames.set(name, relative);
    }

    const scriptNames = new Set();
    let inScriptSection = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (/^\[[^\]]+\]$/.test(line)) {
            inScriptSection = line === '[Script]';
            continue;
        }
        if (!inScriptSection || !line || line.startsWith('#')) continue;
        const equalsIndex = line.indexOf('=');
        check(equalsIndex > 0, `${relative}: malformed [Script] entry: ${line}`);
        if (equalsIndex <= 0) continue;
        const scriptName = line.slice(0, equalsIndex).trim();
        check(!scriptNames.has(scriptName), `${relative}: duplicate [Script] name "${scriptName}"`);
        scriptNames.add(scriptName);
    }

    for (const match of text.matchAll(/script-path=([^,\s"]+)/g)) {
        const scriptUrl = match[1];
        check(!scriptUrl.startsWith('http://'), `${relative}: script-path must use HTTPS: ${scriptUrl}`);
        if (!scriptUrl.startsWith(LOCAL_RAW_PREFIX)) continue;

        const referencedPath = scriptUrl.slice(LOCAL_RAW_PREFIX.length);
        localScriptReferenceCount += 1;
        check(
            /^Scripts\/[^/]+\.js$/.test(referencedPath),
            `${relative}: local script-path must point directly into Scripts/: ${referencedPath}`
        );
        check(
            existsSync(path.join(ROOT, referencedPath)),
            `${relative}: referenced local script does not exist: ${referencedPath}`
        );
    }
}

check(localScriptReferenceCount > 0, 'no local raw.githubusercontent.com script references were found');

if (errors.length > 0) {
    console.error(`Surge module validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
} else {
    console.log(
        `Surge module validation passed: ${moduleFiles.length} modules, ${scriptFiles.length} scripts, ${localScriptReferenceCount} local script references.`
    );
}
