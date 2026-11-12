/**
 * capture-pasted-files
 *
 * Перехватывает вставку путей к файлам в редактор Pi и «спасает» файлы,
 * которые macOS вот-вот удалит, а также чинит пути скриншотов с NBSP.
 *
 * 1. Drag-and-drop миниатюры скриншота в терминал вставляет путь вида
 *    /var/folders/.../T/TemporaryItems/NSIRD_screencaptureui_<random>/Снимок экрана — ....png
 *    Этот файл удаляется сразу после завершения перетаскивания.
 *    Хук onTerminalInput срабатывает в момент вставки (до Enter) и синхронно
 *    копирует файл в ~/.pi/agent/captured-files/, подменяя путь во вставке.
 *
 * 2. Имена скриншотов macOS содержат неразрывные пробелы (U+00A0), которые
 *    теряются при копипасте, а read-инструмент Pi их нормализует. Если
 *    вставленный путь не существует, ищем файл в той же папке с нормализацией
 *    пробелов/Unicode, копируем под ASCII-именем и подменяем путь.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAPTURE_DIR = join(homedir(), ".pi", "agent", "captured-files");
const MAX_SIZE = 500 * 1024 * 1024; // не блокируем TUI копированием гигантских файлов
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // чистим копии старше 7 дней

// Токен пути: начинается с "/", допускает backslash-экранирование (drag-and-drop
// из терминала), сырые NBSP и обычные символы. Управляющие символы (включая
// ESC от bracketed paste) исключены, чтобы не прилипнуть к пути.
const PATH_TOKEN_RE = /\/(?:\\.|[^\s\\\x00-\x1f\x7f]|\u00A0)+/g;
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?|mov|mp4|m4v|pdf)$/i;
const WEIRD_SPACE_RE = /[\u00A0\u202F\u2007]/;

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

/** Убирает backslash-экранирование и обрамляющие кавычки. */
export function unescapePath(token: string): string {
	let p = token.replace(/\\(.)/g, "$1");
	if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
		p = p.slice(1, -1);
	}
	return p;
}

const normName = (s: string) => s.normalize("NFC").replace(/[\u00A0\u202F\u2007]/g, " ");

/** Ищет реально существующий файл: точный путь, NFC/NFD, затем скан папки с нормализацией пробелов. */
export function resolveFile(p: string): string | undefined {
	try {
		if (existsSync(p) && statSync(p).isFile()) return p;
		for (const form of ["NFC", "NFD"] as const) {
			const q = p.normalize(form);
			if (existsSync(q) && statSync(q).isFile()) return q;
		}
		const dir = dirname(p);
		const target = normName(basename(p));
		const hit = readdirSync(dir).find((n) => normName(n) === target);
		if (hit) {
			const full = join(dir, hit);
			if (statSync(full).isFile()) return full;
		}
	} catch {
		// папка не существует / нет прав — считаем, что файла нет
	}
	return undefined;
}

/** ASCII-имя для копии: дата-время из имени скриншота, иначе timestamp. */
export function captureName(source: string): string {
	const ext = extname(source).toLowerCase() || ".bin";
	const base = basename(source);
	const m = base.match(/(\d{4})-(\d{2})-(\d{2})\D*(\d{2})\.(\d{2})\.(\d{2})/);
	const stem = m ? `screenshot-${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}` : `capture-${Date.now()}`;
	let name = stem + ext;
	for (let i = 1; existsSync(join(CAPTURE_DIR, name)); i++) name = `${stem}-${i}${ext}`;
	return name;
}

export interface ProcessResult {
	text: string;
	changed: boolean;
}

/**
 * Находит в тексте пути к файлам, при необходимости копирует файлы в CAPTURE_DIR
 * и подменяет пути. Синхронно — чтобы успеть до удаления временного файла.
 */
export function processText(text: string, notify?: Notify, cache?: Map<string, string>): ProcessResult {
	interface Replacement {
		start: number;
		end: number;
		dest: string;
	}
	const replacements: Replacement[] = [];
	let skipUntil = 0;

	for (const m of text.matchAll(PATH_TOKEN_RE)) {
		const start = m.index;
		if (start < skipUntil) continue;
		const token = m[0];
		const pasted = unescapePath(token);
		if (!pasted.startsWith("/")) continue;

		// Кандидаты: сам токен; если он не резолвится и не экранирован —
		// расширяем до конца строки и постепенно отсекаем хвостовые слова
		// (путь из Finder «Copy as Pathname» содержит неэкранированные пробелы).
		const candidates: string[] = [token];
		if (!token.includes("\\") && !resolveFile(pasted)) {
			let lineEnd = text.length;
			for (let i = start; i < text.length; i++) {
				const c = text.charCodeAt(i);
				if (c === 10 || c === 13 || (c < 32 && c !== 9) || c === 127) {
					lineEnd = i;
					break;
				}
			}
			let cand = text.slice(start, lineEnd).trimEnd();
			for (let i = 0; i < 12 && cand.length > token.length; i++) {
				candidates.push(cand);
				const lastSpace = cand.lastIndexOf(" ");
				if (lastSpace <= 0) break;
				cand = cand.slice(0, lastSpace).trimEnd();
			}
		}

		let warned = false;
		for (const raw of candidates) {
			const p = unescapePath(raw);
			const isTemp = p.includes("/TemporaryItems/");
			const isMedia = MEDIA_EXT_RE.test(p);
			if (!isTemp && !isMedia) continue;

			const resolved = resolveFile(p);
			if (!resolved) {
				if (isTemp && !warned) {
					notify?.(`Временный файл уже удалён системой: ${basename(p)}`, "warning");
					warned = true;
				}
				continue;
			}

			const needsCapture = isTemp || resolved !== p || WEIRD_SPACE_RE.test(basename(resolved));
			if (!needsCapture) continue;

			// уже копировали этот файл ранее — переиспользуем копию
			const cached = cache?.get(resolved);
			if (cached && existsSync(cached)) {
				replacements.push({ start, end: start + raw.length, dest: cached });
				skipUntil = start + raw.length;
				break;
			}

			try {
				const size = statSync(resolved).size;
				if (size > MAX_SIZE) {
					notify?.(`Файл слишком большой для захвата (${Math.round(size / 1024 / 1024)} МБ): ${basename(resolved)}`, "warning");
					continue;
				}
				mkdirSync(CAPTURE_DIR, { recursive: true });
				const dest = join(CAPTURE_DIR, captureName(resolved));
				copyFileSync(resolved, dest);
				cache?.set(resolved, dest);
				replacements.push({ start, end: start + raw.length, dest });
				skipUntil = start + raw.length;
				notify?.(`📎 Файл сохранён: ${dest}`, "info");
				break;
			} catch (e) {
				notify?.(`Не удалось скопировать ${basename(resolved)}: ${(e as Error).message}`, "error");
			}
		}
	}

	if (replacements.length === 0) return { text, changed: false };
	let result = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		result = result.slice(0, r.start) + r.dest + result.slice(r.end);
	}
	return { text: result, changed: true };
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, string>();

	pi.on("session_start", async (_event, ctx) => {
		// чистка старых копий
		try {
			const now = Date.now();
			for (const name of readdirSync(CAPTURE_DIR)) {
				const p = join(CAPTURE_DIR, name);
				try {
					if (now - statSync(p).mtimeMs > PRUNE_AGE_MS) unlinkSync(p);
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* папки ещё нет */
		}

		if (ctx.mode !== "tui") return;

		// Главный хук: сырой ввод терминала, срабатывает в момент вставки/дропа,
		// до попадания текста в редактор. Копируем синхронно и подменяем путь.
		ctx.ui.onTerminalInput((data) => {
			const { text, changed } = processText(data, (m, t) => ctx.ui.notify(m, t), cache);
			return changed ? { data: text } : undefined;
		});
	});

	// Фолбэк: если путь попал в сообщение другим путём (RPC, вставка до загрузки
	// расширения) — пробуем захватить на отправке. Для временных файлов может
	// быть уже поздно, но NBSP-пути чинятся и здесь.
	pi.on("input", async (event) => {
		const { text, changed } = processText(event.text, undefined, cache);
		if (changed) return { action: "transform", text };
		return { action: "continue" };
	});
}