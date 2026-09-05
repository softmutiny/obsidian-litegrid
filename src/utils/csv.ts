export interface CsvDocument {
	rows: string[][];
	delimiter: string;
	eol: string;
	bom: boolean;
	trailingEol: boolean;
}

function countDelimiter(source: string, delimiter: string): number {
	let count = 0, quoted = false, fieldStart = true;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === '"') {
			if (quoted && source[index + 1] === '"') index += 1;
			else if (quoted) quoted = false;
			else if (fieldStart) quoted = true;
			fieldStart = false;
		} else if (!quoted && (char === '\n' || char === '\r')) break;
		else if (!quoted && char === delimiter) { count += 1; fieldStart = true; }
		else fieldStart = false;
	}
	return count;
}

function detectDelimiter(source: string): string {
	return [',', '\t', ';'].sort((left, right) => countDelimiter(source, right) - countDelimiter(source, left))[0] ?? ',';
}

export function parseCsv(source: string, explicitDelimiter?: string): CsvDocument {
	const bom = source.startsWith('\uFEFF');
	const text = bom ? source.slice(1) : source;
	const delimiter = explicitDelimiter ?? detectDelimiter(text);
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const trailingEol = /[\r\n]$/.test(text);
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
			} else if (quoted) {
				quoted = false;
			} else if (cell.length === 0) {
				quoted = true;
			} else {
				cell += char;
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

	if (cell.length > 0 || row.length > 0 || (text.length > 0 && !trailingEol)) {
		row.push(cell);
		rows.push(row);
	}
	return { rows, delimiter, eol, bom, trailingEol };
}

function quoteCell(value: string, delimiter: string): string {
	if (!value.includes(delimiter) && !/[\r\n]/.test(value) && !value.includes('"')) return value;
	return `"${value.replaceAll('"', '""')}"`;
}

export function serializeCsv(document: CsvDocument): string {
	const body = document.rows
		.map((row) => row.map((cell) => quoteCell(cell, document.delimiter)).join(document.delimiter))
		.join(document.eol);
	const trailing = document.trailingEol && document.rows.length > 0 ? document.eol : '';
	return `${document.bom ? '\uFEFF' : ''}${body}${trailing}`;
}

export function normalizeRows(rows: string[][], width: number): string[][] {
	return rows.map((row) =>
		Array.from({ length: width }, (_, index) => row[index] ?? ''),
	);
}
