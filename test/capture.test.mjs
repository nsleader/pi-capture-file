import { processText } from '../capture-pasted-files.ts';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = '/tmp/pi-cap-test';
const captureDir = join(homedir(), '.pi', 'agent', 'captured-files');
const cleanup = () => {
	rmSync(root, { recursive: true, force: true });
	try {
		for (const n of readdirSync(captureDir)) {
			if (n.startsWith('screenshot-20261112-120205')) unlinkSync(join(captureDir, n));
		}
	} catch { /* ignore */ }
};
cleanup();

const desk = join(root, 'Desktop');
const temp = join(root, 'var/folders/g0/T/TemporaryItems/NSIRD_screencaptureui_abc123');
mkdirSync(desk, { recursive: true });
mkdirSync(temp, { recursive: true });

const nbspName = 'Снимок экрана\u00A0— 2026-11-12 в\u00A012.02.05.png';
writeFileSync(join(desk, nbspName), 'SCREENSHOT-BYTES');
writeFileSync(join(temp, nbspName), 'TEMP-DRAG-BYTES');
writeFileSync(join(desk, 'plain.png'), 'PLAIN');

const notifications = [];
const notify = (m, t) => notifications.push([t, m]);
const cache = new Map();
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); };

// 1. NBSP path pasted with regular spaces + backslash escapes
const pasted1 = join(desk, 'Снимок экрана — 2026-11-12 в 12.02.05.png').replace(/ /g, '\\ ');
const r1 = processText(pasted1, notify, cache);
check('NBSP path rewritten', r1.changed && !r1.text.includes('Снимок'));
check('NBSP copy exists & correct', r1.changed && existsSync(r1.text) && readFileSync(r1.text, 'utf8') === 'SCREENSHOT-BYTES');
check('ASCII capture name', /screenshot-20261112-120205\.png$/.test(r1.text));

// 2. Temp drag file (escaped path)
const pasted2 = join(temp, 'Снимок экрана — 2026-11-12 в 12.02.05.png').replace(/ /g, '\\ ');
const r2 = processText(pasted2, notify, cache);
check('temp file captured', r2.changed && existsSync(r2.text) && readFileSync(r2.text, 'utf8') === 'TEMP-DRAG-BYTES');

// 3. Temp file already deleted
const gone = join(temp, 'Снимок экрана — 2026-11-12 в 99.99.99.png').replace(/ /g, '\\ ');
const r3 = processText(gone, notify, cache);
check('gone temp file: unchanged + warning', !r3.changed && notifications.some(([t]) => t === 'warning'));

// 4. Plain ASCII existing path — untouched
const r4 = processText(join(desk, 'plain.png'), notify, cache);
check('plain path untouched', !r4.changed && r4.text === join(desk, 'plain.png'));

// 5. Bracketed paste markers must not stick to path
const r5 = processText('\x1b[200~' + pasted1 + '\x1b[201~', notify, cache);
check('bracketed paste handled', r5.changed && r5.text.startsWith('\x1b[200~') && r5.text.endsWith('\x1b[201~') && existsSync(r5.text.slice(6, -6)));

// 6. Cache reuse: same source -> same copy
const r6 = processText(pasted1, notify, cache);
check('cache reuse', r6.changed && r6.text === r1.text);

// 7. Raw NBSP in pasted path (no escapes)
const r7 = processText(join(desk, nbspName), notify, cache);
check('raw NBSP path resolved', r7.changed && existsSync(r7.text));

// 8. Path inside a sentence
const r8 = processText('посмотри ' + pasted1 + ' пожалуйста', notify, cache);
check('path in sentence', r8.changed && r8.text.startsWith('посмотри ') && r8.text.endsWith(' пожалуйста'));

cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);