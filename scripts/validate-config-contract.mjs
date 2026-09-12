import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const configPath = process.argv[2] || 'Beatrice-Surge-Config/Beatrice-Surge.conf';
const systemPath = process.argv[3] || 'Modules/Beatrice-Surge-System.sgmodule';

function section(text, name) {
  return text.match(new RegExp('^\\[' + name + '\\]\\r?\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))', 'm'))?.[1] || '';
}

function settings(text) {
  const result = new Map();

  for (const rawLine of section(text, 'General').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;

    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    assert.ok(key, 'Encountered an empty General key');
    assert.ok(!result.has(key), `Duplicate General key: ${key}`);
    result.set(key, value);
  }

  return result;
}

const configGeneral = settings(readFileSync(configPath, 'utf8'));
const systemGeneral = settings(readFileSync(systemPath, 'utf8'));

assert.ok(configGeneral.size > 0, 'Config [General] is missing or empty');
assert.ok(systemGeneral.size > 0, 'System module [General] is missing or empty');

for (const [key, value] of systemGeneral) {
  assert.ok(configGeneral.has(key), `Config is missing System General key: ${key}`);
  assert.equal(configGeneral.get(key), value, `System/Config General mismatch: ${key}`);
}

console.log(`Config contract PASS: ${systemGeneral.size} System General keys match the pinned public Config`);
