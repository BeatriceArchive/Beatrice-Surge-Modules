import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Run the real validator against a scratch copy of the repository after one mutation.
function validateWith(mutate) {
    const dir = mkdtempSync(path.join(tmpdir(), 'betty-validate-'));
    try {
        for (const entry of ['Modules', 'Scripts', 'docs', 'scripts', 'README.md']) {
            cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
        }
        const edit = (file, from, to) => {
            const target = path.join(dir, file);
            const text = readFileSync(target, 'utf8');
            assert.ok(text.includes(from), `fixture text not found in ${file}: ${from}`);
            writeFileSync(target, text.replace(from, to));
        };
        mutate(edit);
        const result = spawnSync(process.execPath, [path.join(dir, 'scripts/validate-modules.mjs')], { encoding: 'utf8' });
        return { status: result.status, output: result.stdout + result.stderr };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('validator: current repository passes', () => {
    const result = validateWith(() => {});
    assert.equal(result.status, 0, result.output);
});

const failures = [
    ['README table version drifts', edit => edit('README.md', '| 1.6.1 |', '| 1.6.0 |'), /README module table version \(1\.6\.0\)/],
    ['script version constant drifts', edit => edit('Scripts/Betty-Bilibili-Cookie.js', 'const VER="1.6.1"', 'const VER="1.6.10"'), /must declare version 1\.6\.1/],
    ['script version only mentioned in prose', edit => edit('Scripts/Betty-Basic-Panel.js', ' * Version: 1.5.3', ' * Changelog 1.5.3'), /must declare version 1\.5\.3/],
    ['docs version drifts', edit => edit('docs/bilibili-browser-device.md', 'Cookie **1.6.1**', 'Cookie **1.6.0**'), /Betty-Bilibili-Cookie version statement \(1\.6\.0\)/],
    ['audit doc title drifts', edit => edit('docs/bilibili-daily-audit.md', '# Bilibili Daily 1.14.0 ', '# Bilibili Daily 1.13.0 '), /docs\/bilibili-daily-audit\.md: Betty-Bilibili-Daily version statement \(1\.13\.0\)/],
    ['README default argument drifts', edit => edit('Modules/Betty-Basic-Panel.sgmodule', 'argument="YS=1&RISK=1"', 'argument="YS=0&RISK=1"'), /shipped default argument "YS=0&RISK=1"/],
    ['script-path points at a missing file', edit => edit('Modules/Betty-Bilibili-Daily.sgmodule', 'main/Scripts/Betty-Bilibili-Daily.js,wake', 'main/Scripts/Betty-Bilibili-Dialy.js,wake'), /referenced local script does not exist/],
    ['Panel script-name has no Script entry', edit => edit('Modules/Betty-Bilibili-Daily.sgmodule', 'script-name=Betty-Bilibili-Daily-Panel', 'script-name=Betty-Bilibili-Daily-Pane'), /has no matching \[Script\] entry/],
];

for (const [name, mutate, pattern] of failures) {
    test(`validator: rejects ${name}`, () => {
        const result = validateWith(mutate);
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, pattern);
    });
}
