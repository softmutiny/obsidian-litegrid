// Exercise real TypeScript methods; replace only Obsidian/DOM and disk writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const cache = new Map();
function load(file) {
	file = path.resolve(file);
	if (cache.has(file)) return cache.get(file).exports;
	const module = { exports: {} }; cache.set(file, module);
	const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
	}).outputText;
	const requireStub = name => name === 'obsidian'
		? { TextFileView: class {}, Modal: class {}, Notice: class {}, TFile: class {}, normalizePath: value => value, setIcon() {} }
		: load(path.resolve(path.dirname(file), `${name}.ts`));
	vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(requireStub, module, module.exports);
	return module.exports;
}
const { LiteGridCsvView } = load(root + '/src/ui/csv-view.ts');
const { parseCsv, serializeCsv } = load(root + '/src/utils/csv.ts');
function view(rows, headers = ['姓名', '金额']) {
	const v = Object.create(LiteGridCsvView.prototype);
	v.rows = structuredClone(rows); v.headers = headers;
	v.meta = v.defaultMeta(headers); v.selection = null; v.displayedRows = null;
	v.collapsedGroups = new Set(); v.history = []; v.historyIndex = -1;
	v.document = { rows: [], delimiter: ',', eol: '\n', bom: false, trailingEol: false };
	v.render = () => { v.displayedRows = null; };
	v.saved = 0; v.metaSaves = 0;
	v.scheduleSave = () => { v.saved++; };
	v.scheduleMetaSave = () => { v.metaSaves++; };
	v.setStatus = () => {};
	v.save = async () => { v.saved++; };
	return v;
}
function select(v, startRow, endRow, startColumn = 0, endColumn = v.headers.length - 1) {
	v.selection = { startRow, endRow, startColumn, endColumn };
}
function paste(v, text, row = 0, column = 0) {
	v.handlePaste({ clipboardData: { getData: () => text }, preventDefault() {} }, row, column);
}
function key(v, key, row, column = 0, extra = {}) {
	v.focusCell = (r, c) => { v.focus = [r, c]; };
	v.handleCellKey({ key, preventDefault() {}, ...extra }, row, column);
}
test('filtered range copies and deletes only visible rows', () => {
	const v = view([['A','1'],['B','0'],['C','1']]);
	v.meta.filters = [{ column: 1, operator: 'eq', value: '1' }];
	select(v, 0, 2);
	assert.equal(v.selectionText(), 'A\t1\nC\t1');
	v.deleteRows(); assert.deepEqual(v.rows, [['B','0']]);
});
test('descending-index selection follows display order in either drag direction', () => {
	const v = view([['A','3'],['B','2'],['C','1']]); v.meta.sorts = [{ column: 1, direction: 'asc' }];
	select(v, 2, 0); assert.equal(v.selectionText(), 'C\t1\nB\t2\nA\t3');
	select(v, 0, 2); assert.equal(v.selectionText(), 'C\t1\nB\t2\nA\t3');
});
test('group order and collapsed groups are respected', () => {
	const v = view([['A','x'],['B','y'],['C','x'],['D','z']]);
	v.meta.groups = [{ column: 1 }]; v.collapsedGroups.add('y');
	select(v, 0, 3); assert.equal(v.selectionText(), 'A\tx\nC\tx\nD\tz');
	v.deleteRows(); assert.deepEqual(v.rows, [['B','y']]);
});
test('hidden columns are excluded from copy and paste targets', () => {
	const v = view([['A','secret','B']], ['a','hidden','b']); v.meta.fields[1].visible = false;
	select(v, 0, 0); assert.equal(v.selectionText(), 'A\tB');
	paste(v, 'X\tY'); assert.deepEqual(v.rows, [['X','secret','Y']]);
});
test('sorted paste snapshots row targets before changing sort values', () => {
	const v = view([['A','3'],['B','2'],['C','1']]); v.meta.sorts = [{ column: 1, direction: 'asc' }];
	paste(v, 'X\t10\nY\t20', 2); assert.deepEqual(v.rows, [['A','3'],['Y','20'],['X','10']]);
});
test('filtered paste leaves hidden rows intact', () => {
	const v = view([['A','1'],['B','0'],['C','1']]); v.meta.filters = [{ column: 1, operator: 'eq', value: '1' }];
	paste(v, 'X\t2\nY\t3'); assert.deepEqual(v.rows, [['X','2'],['B','0'],['Y','3']]);
});
test('paste grows beyond placeholder rows without dropping entries', () => {
	const v = view([]); paste(v, Array.from({length: 12}, (_, i) => `${i}\t${i}`).join('\n'));
	assert.equal(v.rows.length, 12); assert.deepEqual(v.rows[11], ['11','11']);
});
test('quoted multiline TSV keeps one source cell in one target cell', () => {
	const v = view([['A','0'],['B','0']]); paste(v, '"第一行\n第二行"\t100');
	assert.deepEqual(v.rows, [['第一行\n第二行','100'],['B','0']]);
});
test('copy and paste preserve quotes, tabs, CRLF and trailing empty cells', () => {
	const rows = [['a"b', 'one\r\ntwo', 'x\ty', '']];
	const v = view(rows, ['a','b','c','d']); select(v,0,0);
	const target = view([], ['a','b','c','d']); paste(target, v.selectionText()); assert.deepEqual(target.rows, rows);
});
test('numeric ascending/descending sorting supports negatives and decimals', () => {
	const v = view([['A','-2'],['B','-10'],['C','1.2'],['D','1.11']]);
	v.meta.sorts = [{ column: 1, direction: 'asc' }];
	assert.deepEqual(v.getVisibleRows().map(x => x.row[1]), ['-10','-2','1.11','1.2']);
	v.meta.sorts[0].direction = 'desc'; assert.deepEqual(v.getVisibleRows().map(x => x.row[1]), ['1.2','1.11','-2','-10']);
});
test('currency, empty values and stable numeric ties', () => {
	const v = view([['A','¥1,000'],['B','2'],['C','2.0'],['D','']]); v.meta.fields[1].type='currency';
	v.meta.sorts=[{column:1,direction:'asc'}]; assert.deepEqual(v.getVisibleRows().map(x=>x.row[0]),['B','C','A','D']);
});
test('date fields compare timestamps', () => {
	const v=view([['A','2026-10-01'],['B','2026-2-01']]); v.meta.fields[1].type='date'; v.meta.sorts=[{column:1,direction:'asc'}];
	assert.deepEqual(v.getVisibleRows().map(x=>x.row[0]),['B','A']);
});
test('navigation follows sorted rows without writing or adding rows', () => {
	const v=view([['A','3'],['B','1'],['C','2']]); v.meta.sorts=[{column:1,direction:'asc'}];
	key(v,'ArrowDown',2); assert.deepEqual(v.focus,[0,0]); assert.equal(v.rows.length,3); assert.equal(v.saved,0);
	key(v,'ArrowUp',0); assert.deepEqual(v.focus,[2,0]);
});
test('Tab skips hidden columns and Shift+Tab wraps in visual order', () => {
	const v=view([['A','hidden','1'],['B','hidden','2']],['a','hidden','c']); v.meta.fields[1].visible=false;
	key(v,'Tab',0); assert.deepEqual(v.focus,[0,2]);
	key(v,'Tab',1,0,{shiftKey:true}); assert.deepEqual(v.focus,[0,2]);
});
test('IME Enter does not navigate', () => {
	const v=view([['A','1']]); key(v,'Enter',0,0,{isComposing:true}); assert.equal(v.focus,undefined);
});
test('deleting a column, undo and redo restore complete metadata', () => {
	const v=view([['A','42','2026-09-05']],['姓名','金额','日期']);
	v.meta.fields[1].width=333; v.meta.filters=[{id:'f',column:2,operator:'not-empty',value:''}];
	const before=structuredClone(v.meta); v.deleteColumn(1); const after=structuredClone(v.meta);
	v.undo(); assert.deepEqual(v.meta,before); assert.equal(v.metaSaves,2); assert.equal(v.rows[0][1],'42');
	v.redo(); assert.deepEqual(v.meta,after); assert.deepEqual(v.headers,['姓名','日期']);
});
test('CSV semicolon quoted header survives save and reopen', () => {
	const source='"a""b";c\n1;2\n'; const doc=parseCsv(source);
	assert.deepEqual(parseCsv(serializeCsv(doc)).rows, doc.rows);
});
test('CSV delimiter detection respects multiline and mid-field quotes', () => {
	assert.deepEqual(parseCsv('"a\nb";c\n1;2').rows,[['a\nb','c'],['1','2']]);
	assert.deepEqual(parseCsv('a"b;c\n1;2').rows,[['a"b','c'],['1','2']]);
});
test('CSV retains BOM, CRLF, wide rows and trailing newline', () => {
	const source='\uFEFFa,b\r\n1,2,3\r\n'; assert.equal(serializeCsv(parseCsv(source)),source);
});
