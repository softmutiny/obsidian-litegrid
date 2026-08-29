export interface CsvDocument {
	rows: string[][];
	delimiter: string;
	eol: string;
	bom: boolean;
}

function countDelimiter(line: string, delimiter: string): number {
	let count = 0;
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === '"') {
			if (quoted && line[index + 1] === '"') index += 1;
			else quoted = !quoted;
		} else if (!quoted && char === delimiter) {
			count += 1;
		}
	}
	return count;
}

function detectDelimiter(source: string): string {
	const line = source.split(/\r?\n/, 1)[0] ?? '';
	const candidates = [',', '\t', ';'];
	return candidates.sort(
		(left, right) => countDelimiter(line, right) - countDelimiter(line, left),
	)[0] ?? ',';
}

export function parseCsv(source: string): CsvDocument {
	const bom = source.startsWith('\uFEFF');
	const text = bom ? source.slice(1) : source;
	const delimiter = detectDelimiter(text);
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === '"') {
			if (quoted && text[index + 1] === '"') {
				cell += '"';
				index += 1;
			} else {
				quoted = !quoted;
			}
		} else if (!quoted && char === delimiter) {
			row.push(cell);
			cell = '';
		} else if (!quoted && (char === '\n' || char === '\r')) {
			if (char === '\r' && text[index + 1] === '\n') index += 1;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else {
			cell += char;
		}
	}

	if (cell.length > 0 || row.length > 0 || (text.length > 0 && !/[\r\n]$/.test(text))) {
		row.push(cell);
		rows.push(row);
	}
	return { rows, delimiter, eol, bom };
}

function quoteCell(value: string, delimiter: string): string {
	if (!value.includes(delimiter) && !/["\r\n]/.test(value)) return value;
	return `"${value.replaceAll('"', '""')}"`;
}

export function serializeCsv(document: CsvDocument): string {
	const body = document.rows
		.map((row) => row.map((cell) => quoteCell(cell, document.delimiter)).join(document.delimiter))
		.join(document.eol);
	return `${document.bom ? '\uFEFF' : ''}${body}`;
}

export function normalizeRows(rows: string[][], width: number): string[][] {
	return rows.map((row) =>
		Array.from({ length: width }, (_, index) => row[index] ?? ''),
	);
}
