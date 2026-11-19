import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = path.join(ROOT, 'Modules');
const SCRIPTS_DIR = path.join(ROOT, 'Scripts');
const LOCAL_RAW_PREFIX = 'https://raw.githubusercontent.com/BeatriceArchive/Beatrice-Surge-Modules/main/';
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
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
const moduleVersions = new Map();

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionDeclaration(version) {
    return new RegExp(`(?:Version:[ \\t]*|\\b(?:V|VER)[ \\t]*=[ \\t]*["'])${escapeRegExp(version)}(?![0-9.])`);
}

function readmeSection(file) {
    const start = README.indexOf(`### ${file}`);
    if (start < 0) return '';
    const next = README.indexOf('\n### ', start + 4);
    const nextH2 = README.indexOf('\n## ', start + 4);
    const ends = [next, nextH2].filter(index => index >= 0);
    return README.slice(start, ends.length ? Math.min(...ends) : undefined);
}

// Version statements in prose docs that must follow the module header.
const DOC_VERSION_RULES = [
    ['README.md', /^([0-9]+\.[0-9]+\.[0-9]+) 问题清单/m, 'Betty-Bilibili-Daily'],
    ['docs/basic-panel.md', /`Betty-Basic-Panel` \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*/, 'Betty-Basic-Panel'],
    ['docs/bilibili-browser-device.md', /适用版本：Daily \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*/, 'Betty-Bilibili-Daily'],
    ['docs/bilibili-browser-device.md', /、Cookie \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*/, 'Betty-Bilibili-Cookie'],
    ['docs/bilibili-browser-device.md', /Daily 面板显示 `v([0-9]+\.[0-9]+\.[0-9]+)`/, 'Betty-Bilibili-Daily'],
    ['docs/bilibili-daily-audit.md', /^# Bilibili Daily ([0-9]+\.[0-9]+\.[0-9]+) /m, 'Betty-Bilibili-Daily'],
];
let localScriptReferenceCount = 0;

for (const file of moduleFiles) {
    const relative = `Modules/${file}`;
    const moduleId = file.replace(/\.sgmodule$/, '');
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

    check(
        README.includes(`### ${file}`),
        `${relative}: README must contain an exact "### ${file}" identity heading`
    );

    const projectMatch = text.match(/^# Project:\s*(\S+)\s*$/m);
    if (projectMatch) {
        check(
            projectMatch[1] === moduleId,
            `${relative}: Project metadata must match module filename (${moduleId})`
        );
    }

    const explicitVersion = text.match(/^# Version:\s*([0-9]+(?:\.[0-9]+){2})\s*$/m)?.[1];
    const descriptionVersion = text.match(/^#!desc=([0-9]+(?:\.[0-9]+){2})(?:：|\s|$)/m)?.[1];
    const moduleVersion = explicitVersion || descriptionVersion || null;

    const scriptNames = new Set();
    const panelScriptNames = new Set();
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

    for (const match of text.matchAll(/script-name=([^,\s"]+)/g)) {
        panelScriptNames.add(match[1]);
    }
    for (const panelScriptName of panelScriptNames) {
        check(
            scriptNames.has(panelScriptName),
            `${relative}: Panel script-name "${panelScriptName}" has no matching [Script] entry`
        );
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
        const scriptId = path.basename(referencedPath, '.js');
        check(
            scriptId === moduleId,
            `${relative}: local script filename must match module identity (${moduleId}.js): ${referencedPath}`
        );
        if (moduleVersion && existsSync(path.join(ROOT, referencedPath))) {
            const scriptText = readFileSync(path.join(ROOT, referencedPath), 'utf8');
            // Require an explicit declaration (header "Version: x" or a V / VER constant),
            // so 1.6.1 cannot be satisfied by an unrelated 1.6.10 or a changelog mention.
            check(
                versionDeclaration(moduleVersion).test(scriptText),
                `${relative}: ${referencedPath} must declare version ${moduleVersion} ("Version: ${moduleVersion}" or V/VER = "${moduleVersion}")`
            );
        }
    }

    // The overview table row and install link must name this exact module.
    const tableRow = README.split(/\r?\n/).find(line => line.startsWith(`| \`${file}\` |`));
    check(Boolean(tableRow), `${relative}: README module table must contain a row for \`${file}\``);
    check(
        README.includes(`(${LOCAL_RAW_PREFIX}Modules/${file})`),
        `${relative}: README must contain the official install link for ${file}`
    );

    // A default argument shown in the README must be the one the module actually ships.
    const moduleArgument = text.match(/argument="([^"]*)"/)?.[1];
    if (moduleArgument !== undefined) {
        const section = readmeSection(file);
        check(
            section.includes('```text\n' + moduleArgument + '\n```'),
            `${relative}: README section must show the shipped default argument "${moduleArgument}"`
        );
    }

    if (moduleVersion) {
        moduleVersions.set(moduleId, moduleVersion);
        const tableVersion = tableRow?.split('|').map(cell => cell.trim()).filter(Boolean).pop();
        check(
            tableVersion === moduleVersion,
            `${relative}: README module table version (${tableVersion ?? 'missing'}) must equal ${moduleVersion}`
        );
    }
}

for (const [docPath, pattern, moduleId] of DOC_VERSION_RULES) {
    const expected = moduleVersions.get(moduleId);
    const absolute = path.join(ROOT, docPath);
    check(Boolean(expected), `${docPath}: no module version found for ${moduleId}`);
    check(existsSync(absolute), `${docPath}: file is missing`);
    if (!expected || !existsSync(absolute)) continue;
    const found = readFileSync(absolute, 'utf8').match(pattern)?.[1];
    check(
        found === expected,
        `${docPath}: ${moduleId} version statement (${found ?? 'missing'}) must equal module version ${expected}`
    );
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
