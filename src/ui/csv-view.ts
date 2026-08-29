import { Modal, normalizePath, Notice, setIcon, TextFileView, TFile, WorkspaceLeaf } from 'obsidian';
import { normalizeRows, parseCsv, serializeCsv, type CsvDocument } from '../utils/csv';
import {
	FIELD_TYPES, OPTION_COLORS, type ColumnStatistic, type CurrencyCode, type FieldSchema, type FieldType, type FillRule,
	type FilterRule, type RowHeight, type RuleOperator, type TableMeta,
	type TableMetaHost, uid,
} from '../types';

export const CSV_VIEW_TYPE = 'litegrid-csv-view';
type PanelKind = 'fields' | 'filter' | 'group' | 'sort' | 'fill' | null;
type Selection = { startRow: number; endRow: number; startColumn: number; endColumn: number };
type VisibleRow = { row: string[]; index: number };
interface MenuItem { label?: string; icon?: string; action?: () => void; quantityAction?: (count: number) => void; danger?: boolean; divider?: boolean }

const DEFAULT_HEADERS = ['标题', '数字', '单选'];
const TYPE_HINT: Record<FieldType, string> = {
	text: 'A', number: '123', currency: '¥', single: '⌄', multi: '☷', date: '▣',
	person: '◎', checkbox: '☑', link: '↗', email: '@', phone: '☎', image: '▧', attachment: '↗',
};

const CURRENCY_OPTIONS: Array<{ code: CurrencyCode; symbol: string; label: string }> = [
	{ code: 'CNY', symbol: '¥', label: '人民币' },
	{ code: 'USD', symbol: '$', label: '美元' },
	{ code: 'EUR', symbol: '€', label: '欧元' },
	{ code: 'GBP', symbol: '£', label: '英镑' },
	{ code: 'JPY', symbol: '¥', label: '日元' },
];
const OPERATOR_LABEL: Record<RuleOperator, string> = {
	eq: '等于', neq: '不等于', contains: '包含', 'not-contains': '不包含',
	empty: '为空', 'not-empty': '不为空', all: '所有内容',
};

export class LiteGridCsvView extends TextFileView {
	private document: CsvDocument = { rows: [], delimiter: ',', eol: '\n', bom: false };
	private headers = [...DEFAULT_HEADERS];
	private rows: string[][] = [];
	private meta: TableMeta = this.defaultMeta(DEFAULT_HEADERS);
	private saveTimer: number | null = null;
	private metaTimer: number | null = null;
	private statusEl: HTMLElement | null = null;
	private panel: PanelKind = null;
	private selection: Selection | null = null;
	private dragging = false;
	private collapsedGroups = new Set<string>();
	private contextMenu: HTMLElement | null = null;
	private history: string[] = [];
	private historyIndex = -1;
	private undoButton: HTMLButtonElement | null = null;
	private redoButton: HTMLButtonElement | null = null;
	private searchVisible = false;
	private searchTerm = '';
	private replacementTerm = '';
	private searchCaseSensitive = false;

	constructor(leaf: WorkspaceLeaf, private host: TableMetaHost) { super(leaf); }
	getViewType() { return CSV_VIEW_TYPE; }
	getDisplayText() { return this.file?.basename ?? '表格'; }
	getIcon() { return 'sheet'; }
	async onOpen() {
		this.registerDomEvent(this.containerEl.ownerDocument, 'mouseup', () => { this.dragging = false; });
		this.registerDomEvent(this.containerEl.ownerDocument, 'keydown', (event) => {
			if (event.key !== 'Escape') return;
			const fieldEditor = this.contentEl.querySelector<HTMLElement>('.wb-field-editor');
			if (fieldEditor) fieldEditor.remove();
			else if (this.contextMenu) this.closeContextMenu();
			else if (this.panel) { this.panel = null; this.render(); }
			else if (this.searchVisible) { this.searchVisible = false; this.searchTerm = ''; this.replacementTerm = ''; this.render(); }
		});
	}

	setViewData(data: string, clear: boolean) {
		if (clear) this.clear();
		this.data = data;
		this.document = parseCsv(data);
		const [header, ...body] = this.document.rows;
		let restoredDefaultTitle = false;
		if (header?.some((cell) => cell.length > 0)) {
			this.headers = header;
			if (this.headers[0] === '文本' && this.headers[1] === '数字' && this.headers[2] === '单选') { this.headers[0] = '标题'; restoredDefaultTitle = true; }
			this.rows = normalizeRows(body, header.length);
		} else {
			this.headers = [...DEFAULT_HEADERS];
			this.rows = [];
		}
		const stored = this.file ? this.host.getTableMeta(this.file.path) : undefined;
		this.meta = this.reconcileMeta(stored, this.headers);
		const defaultSignature = this.headers[0] === '标题' && this.headers[1] === '数字' && this.headers[2] === '单选';
		const restoredDefaultType = defaultSignature && this.meta.fields[0]?.type === 'text';
		if (restoredDefaultType && this.meta.fields[0]) this.meta.fields[0].type = 'attachment';
		this.render();
		if (restoredDefaultTitle) { this.data = this.getViewData(); window.setTimeout(() => void this.save(), 0); }
		if (restoredDefaultType) this.scheduleMetaSave();
	}

	getViewData(): string { return serializeCsv({ ...this.document, rows: [this.headers, ...this.rows] }); }
	clear() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		if (this.metaTimer !== null) window.clearTimeout(this.metaTimer);
		this.saveTimer = null; this.metaTimer = null; this.closeContextMenu(); this.contentEl.empty(); this.rows = [];
	}

	private defaultMeta(headers: string[]): TableMeta {
		return { fields: headers.map((name, index) => this.newField(name, index)), rowHeight: 'default', statistics: {}, filters: [], sorts: [], groups: [], fills: [] };
	}
	private newField(name: string, index: number): FieldSchema {
		const lowered = name.toLocaleLowerCase();
		let type: FieldType = index === 1 || /数字|金额|数量|价格|number/.test(lowered) ? 'number' : 'text';
		if (index === 0 && name === '标题') type = 'attachment';
		if (/单选|状态|类型/.test(lowered)) type = 'single';
		if (/日期|时间|date/.test(lowered)) type = 'date';
		return {
			id: uid('field'), name: name || `字段 ${index + 1}`, type, visible: true, width: 200, options: [],
			currencyCode: 'CNY', currencyDecimals: 2, currencyUseThousands: true,
		};
	}
	private reconcileMeta(stored: TableMeta | undefined, headers: string[]): TableMeta {
		if (!stored) return this.defaultMeta(headers);
		const fields = headers.map((name, index) => {
			const prior = stored.fields[index];
			return prior ? { ...prior, name, type: prior.type === 'person' ? 'text' : prior.type, options: prior.options ?? [], width: prior.width || 200 } : this.newField(name, index);
		});
		return {
			fields, rowHeight: stored.rowHeight ?? 'default', statistics: stored.statistics ?? {},
			filters: (stored.filters ?? []).filter((rule) => rule.column < fields.length),
			sorts: (stored.sorts ?? []).filter((rule) => rule.column < fields.length),
			groups: (stored.groups ?? []).filter((rule) => rule.column < fields.length),
			fills: (stored.fills ?? []).filter((rule) => rule.column < fields.length),
		};
	}

	private scheduleSave() {
		this.data = this.getViewData(); this.setStatus('正在保存…');
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.save().then(() => this.setStatus('已保存')); }, 320);
	}
	private scheduleMetaSave() {
		if (!this.file) return;
		if (this.metaTimer !== null) window.clearTimeout(this.metaTimer);
		this.metaTimer = window.setTimeout(() => { this.metaTimer = null; if (this.file) void this.host.saveTableMeta(this.file.path, this.meta); }, 220);
	}
	private setStatus(text: string) { this.statusEl?.setText(text); }

	private render() {
		const root = this.contentEl; root.empty(); root.addClass('wb-file-view', 'wb-csv-view'); root.dataset.rowHeight = this.meta.rowHeight;
		const page = root.createDiv('wb-page');
		page.onmousedown = (event) => {
			const target = event.target as HTMLElement;
			if (target.closest('.wb-grid-shell, .wb-toolbar, .wb-editable-title, .wb-floating-panel, .wb-context-menu, .wb-option-picker-menu, .wb-file-popover, .wb-index-popover, .wb-link-popover, .wb-field-editor')) return;
			if (this.selection) { this.selection = null; this.renderGridOnly(); }
		};
		this.renderEditableTitle(page);
		const toolbar = page.createDiv('wb-toolbar');
		this.addToolbarButton(toolbar, '添加一行', 'circle-plus', () => this.addRow(), false);
		toolbar.createSpan('wb-toolbar-divider');
		this.addToolbarButton(toolbar, '字段管理', 'panels-top-left', () => this.togglePanel('fields'), this.panel === 'fields');
		this.addToolbarButton(toolbar, '筛选', 'list-filter', () => this.togglePanel('filter'), this.panel === 'filter', this.meta.filters.length);
		this.addToolbarButton(toolbar, '分组', 'rows-3', () => this.togglePanel('group'), this.panel === 'group', this.meta.groups.length);
		this.addToolbarButton(toolbar, '排序', 'arrow-up-down', () => this.togglePanel('sort'), this.panel === 'sort', this.meta.sorts.length);
		this.addToolbarButton(toolbar, '行高', 'list-collapse', () => this.openRowHeightMenu(toolbar), false);
		this.addToolbarButton(toolbar, '填色', 'paint-bucket', () => this.togglePanel('fill'), this.panel === 'fill', this.meta.fills.length);
		this.statusEl = toolbar.createSpan('wb-save-status'); this.statusEl.setText('已保存');
		this.renderToolbarTail(toolbar);
		if (this.panel) this.renderPanel(toolbar, this.panel);
		this.renderGrid(page);
	}

	private renderEditableTitle(page: HTMLElement) {
		const currentName = this.file?.basename ?? '未命名表格'; const title = page.createEl('h1', { cls: 'wb-editable-title', text: currentName });
		title.contentEditable = 'true'; title.spellcheck = false; title.setAttribute('role', 'textbox'); title.setAttribute('aria-label', '表格标题');
		const restore = () => title.setText(this.file?.basename ?? currentName);
		const commit = async () => {
			const file = this.file; if (!file) return;
			const entered = (title.textContent ?? '').trim().replace(/\.csv$/i, '');
			if (!entered) { restore(); return; }
			if (/[\\/:*?"<>|]/.test(entered)) { new Notice('标题不能包含 \\ / : * ? " < > |'); restore(); return; }
			if (entered === file.basename) { title.setText(entered); return; }
			const oldPath = file.path; const folder = file.parent?.path ?? ''; const newPath = normalizePath(folder ? `${folder}/${entered}.csv` : `${entered}.csv`);
			try {
				if (this.metaTimer !== null) { window.clearTimeout(this.metaTimer); this.metaTimer = null; }
				await this.app.fileManager.renameFile(file, newPath); await this.host.renameTableMeta(oldPath, newPath, this.meta); title.setText(entered);
			} catch (error) {
				console.error('[LiteGrid] 重命名表格失败', error); new Notice('重命名失败，可能存在同名表格'); restore();
			}
		};
		title.onkeydown = (event) => {
			if (event.key === 'Enter') { event.preventDefault(); title.blur(); }
			if (event.key === 'Escape') { event.preventDefault(); restore(); title.blur(); }
		};
		title.onpaste = (event) => {
			event.preventDefault(); const text = event.clipboardData?.getData('text/plain').replace(/[\r\n]+/g, ' ') ?? '';
			const selection = this.containerEl.ownerDocument.getSelection();
			if (!selection?.rangeCount) { title.appendText(text); return; }
			const range = selection.getRangeAt(0); if (!title.contains(range.commonAncestorContainer)) { title.appendText(text); return; }
			range.deleteContents(); const node = this.containerEl.ownerDocument.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
		};
		title.onblur = () => { void commit(); };
	}

	private renderToolbarTail(toolbar: HTMLElement) {
		const right = toolbar.createDiv('wb-toolbar-right');
		this.undoButton = this.addIconButton(right, 'undo-2', '撤销', () => this.undo());
		this.redoButton = this.addIconButton(right, 'redo-2', '重做', () => this.redo());
		this.undoButton.disabled = this.historyIndex <= 0;
		this.redoButton.disabled = this.historyIndex >= this.history.length - 1;
		const searchToggle = this.addIconButton(right, 'search', '搜索', () => {
			this.searchVisible = !this.searchVisible;
			this.panel = null;
			if (!this.searchVisible) { this.searchTerm = ''; this.replacementTerm = ''; }
			this.render();
		});
		searchToggle.addClass('wb-toolbar-search');
		if (this.searchVisible) searchToggle.addClass('is-active');
		if (this.searchVisible) this.renderSearchPanel(toolbar, searchToggle);
	}

	private addIconButton(container: HTMLElement, iconName: string, label: string, onClick: () => void) {
		const button = container.createEl('button', { cls: 'wb-toolbar-icon', attr: { 'aria-label': label } });
		setIcon(button, iconName);
		button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
		return button;
	}

	private renderSearchPanel(toolbar: HTMLElement, anchor: HTMLElement) {
		const panel = toolbar.createDiv('wb-search-popover');
		const header = panel.createDiv('wb-panel-header'); header.createEl('strong', { text: '查找替换' });
		const close = header.createEl('button', { cls: 'wb-panel-close', attr: { 'aria-label': '关闭' } }); setIcon(close, 'x');
		close.onclick = () => { this.searchVisible = false; this.searchTerm = ''; this.replacementTerm = ''; this.render(); };
		const search = panel.createEl('input', { cls: 'wb-search-input', attr: { placeholder: '内容', value: this.searchTerm, spellcheck: 'false' } });
		panel.createEl('label', { cls: 'wb-replace-label', text: '替换为' });
		const replacement = panel.createEl('input', { cls: 'wb-search-input', attr: { placeholder: '输入替换内容', value: this.replacementTerm, spellcheck: 'false' } });
		const footer = panel.createDiv('wb-search-footer');
		const caseLabel = footer.createEl('label', { cls: 'wb-check-row' }); const caseInput = caseLabel.createEl('input', { attr: { type: 'checkbox' } }); caseInput.checked = this.searchCaseSensitive; caseLabel.createSpan({ text: '区分大小写' });
		const actions = footer.createDiv('wb-search-actions'); const replace = actions.createEl('button', { text: '替换' }); const replaceAll = actions.createEl('button', { text: '全部替换' });
		const sync = () => { replace.disabled = !this.searchTerm; replaceAll.disabled = !this.searchTerm; };
		search.oninput = () => { this.searchTerm = search.value; sync(); this.renderGridOnly(); };
		replacement.oninput = () => { this.replacementTerm = replacement.value; };
		caseInput.onchange = () => { this.searchCaseSensitive = caseInput.checked; this.renderGridOnly(); };
		search.onkeydown = (event) => { if (event.key === 'Enter') this.jumpToSearchMatch(event.shiftKey ? -1 : 1); };
		replace.onclick = () => this.replaceNext(); replaceAll.onclick = () => this.replaceAll(); sync();
		this.positionPopover(toolbar, anchor, panel, 'right');
		window.setTimeout(() => search.focus(), 0);
	}

	private countSearchMatches(): number {
		if (!this.searchTerm) return 0;
		return this.rows.reduce((total, row) => row.reduce((sum, cell) => sum + (this.cellMatchesSearch(cell ?? '') ? 1 : 0), total), 0);
	}

	private jumpToSearchMatch(direction: 1 | -1) {
		if (!this.searchTerm) return;
		const hits = this.getVisibleRows().filter(({ row }) => row.some((cell) => this.cellMatchesSearch(cell ?? '')));
		if (!hits.length) return;
		const current = this.selection ? hits.findIndex(({ index }) => index === this.selection!.startRow) : -1;
		const next = hits[(current + direction + hits.length) % hits.length]!;
		this.selection = { startRow: next.index, endRow: next.index, startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) };
		this.renderGridOnly();
		this.contentEl.querySelector<HTMLElement>(`tr[data-row="${next.index}"]`)?.scrollIntoView({ block: 'center' });
	}

	private cellMatchesSearch(value: string): boolean {
		if (!this.searchTerm) return false;
		return this.searchCaseSensitive ? value.includes(this.searchTerm) : value.toLocaleLowerCase().includes(this.searchTerm.toLocaleLowerCase());
	}

	private replaceInValue(value: string, all: boolean): string {
		if (!this.searchTerm) return value;
		const escaped = this.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return value.replace(new RegExp(escaped, `${all ? 'g' : ''}${this.searchCaseSensitive ? '' : 'i'}`), this.replacementTerm);
	}

	private replaceNext() {
		if (!this.searchTerm) return;
		const coordinates = this.getVisibleRows().flatMap(({ row, index }) => row.map((value, column) => ({ row: index, column, value }))).filter((item) => this.cellMatchesSearch(item.value ?? ''));
		if (!coordinates.length) return;
		const current = this.selection ? coordinates.findIndex((item) => item.row === this.selection!.startRow && item.column === this.selection!.startColumn) : -1;
		const target = coordinates[(current + 1) % coordinates.length]!; this.pushHistory(); this.setCell(target.row, target.column, this.replaceInValue(target.value, false));
		this.selection = { startRow: target.row, endRow: target.row, startColumn: target.column, endColumn: target.column }; this.scheduleSave(); this.render();
	}

	private replaceAll() {
		if (!this.searchTerm) return; this.pushHistory(); let changed = false;
		this.rows.forEach((row) => row.forEach((value, column) => { if (!this.cellMatchesSearch(value ?? '')) return; row[column] = this.replaceInValue(value ?? '', true); changed = true; }));
		if (changed) { this.scheduleSave(); this.render(); }
	}

	private pushHistory() {
		const snapshot = this.getViewData();
		if (this.history[this.historyIndex] === snapshot) return;
		this.history = this.history.slice(0, this.historyIndex + 1);
		this.history.push(snapshot);
		if (this.history.length > 100) this.history.shift();
		this.historyIndex = this.history.length - 1;
	}

	private applySnapshot(snapshot: string) {
		this.data = snapshot;
		this.document = parseCsv(snapshot);
		const [header, ...body] = this.document.rows;
		if (header?.some((cell) => cell.length > 0)) { this.headers = header; this.rows = normalizeRows(body, header.length); }
		else { this.headers = [...DEFAULT_HEADERS]; this.rows = []; }
		this.meta = this.reconcileMeta(this.meta, this.headers);
		this.render();
	}

	private undo() { if (this.historyIndex > 0) { this.historyIndex -= 1; this.applySnapshot(this.history[this.historyIndex]!); this.selection = null; void this.save(); } }
	private redo() { if (this.historyIndex < this.history.length - 1) { this.historyIndex += 1; this.applySnapshot(this.history[this.historyIndex]!); this.selection = null; void this.save(); } }
	private addToolbarButton(container: HTMLElement, label: string, iconName: string, onClick: () => void, active: boolean, count = 0) {
		const button = container.createEl('button', { cls: `wb-toolbar-button${active || count ? ' is-active' : ''}` }); button.dataset.action = label;
		setIcon(button.createSpan(), iconName); button.createSpan({ text: label }); if (count) button.createSpan({ cls: 'wb-tool-count', text: String(count) });
		button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
	}
	private togglePanel(panel: Exclude<PanelKind, null>) { this.panel = this.panel === panel ? null : panel; this.searchVisible = false; this.closeContextMenu(); this.render(); }

	private renderPanel(toolbar: HTMLElement, panel: Exclude<PanelKind, null>) {
		const popover = toolbar.createDiv(`wb-floating-panel wb-panel-${panel}`);
		const titleMap = { fields: '字段管理', filter: '筛选', group: '分组', sort: '排序', fill: '填色' };
		const header = popover.createDiv('wb-panel-header'); header.createEl('strong', { text: titleMap[panel] });
		const close = header.createEl('button', { cls: 'wb-panel-close', attr: { 'aria-label': '关闭' } }); setIcon(close, 'x'); close.onclick = () => { this.panel = null; this.render(); };
		if (panel === 'fields') this.renderFieldPanel(popover);
		if (panel === 'filter') this.renderRulePanel(popover, 'filter');
		if (panel === 'group') this.renderGroupPanel(popover);
		if (panel === 'sort') this.renderSortPanel(popover);
		if (panel === 'fill') this.renderRulePanel(popover, 'fill');
		const action = { fields: '字段管理', filter: '筛选', group: '分组', sort: '排序', fill: '填色' }[panel];
		const anchor = toolbar.querySelector<HTMLElement>(`[data-action="${action}"]`); if (anchor) this.positionPopover(toolbar, anchor, popover);
	}

	private positionPopover(toolbar: HTMLElement, anchor: HTMLElement, popover: HTMLElement, align: 'left' | 'right' = 'left') {
		window.requestAnimationFrame(() => {
			const toolbarRect = toolbar.getBoundingClientRect(); const anchorRect = anchor.getBoundingClientRect(); const width = popover.offsetWidth;
			const preferred = align === 'right' ? anchorRect.right - toolbarRect.left - width : anchorRect.left - toolbarRect.left;
			popover.setCssProps({ left: `${Math.max(0, Math.min(preferred, toolbar.clientWidth - width))}px`, right: 'auto' });
		});
	}

	private renderFieldTypeIcon(container: HTMLElement, type: FieldType, className = 'wb-field-type-box') {
		const icon = container.createSpan({ cls: `${className} wb-field-type-${type}` });
		const definition = FIELD_TYPES.find((item) => item.value === type);
		if (type === 'text') icon.setText('A');
		else if (definition?.icon === '123') icon.setText('123');
		else setIcon(icon, definition?.icon ?? 'square-a');
		return icon;
	}

	private renderFieldPanel(panel: HTMLElement) {
		const list = panel.createDiv('wb-field-panel-list');
		this.meta.fields.forEach((field, index) => {
			const row = list.createDiv('wb-field-panel-row'); row.createSpan({ cls: 'wb-drag-handle', text: '⠿' }); this.renderFieldTypeIcon(row, field.type); row.createSpan({ cls: 'wb-field-name', text: field.name });
			const actions = row.createDiv('wb-field-actions');
			const edit = actions.createEl('button', { attr: { 'aria-label': '修改字段' } }); setIcon(edit, 'pencil'); edit.onclick = () => this.openFieldEditor(edit, index);
			const remove = actions.createEl('button', { attr: { 'aria-label': '删除字段' } }); setIcon(remove, 'trash-2'); remove.onclick = () => this.deleteColumn(index);
			const toggle = row.createEl('button', { cls: `wb-switch${field.visible ? ' is-on' : ''}`, attr: { 'aria-label': field.visible ? '隐藏字段' : '显示字段' } });
			toggle.onclick = () => { field.visible = !field.visible; this.scheduleMetaSave(); this.render(); };
		});
		const add = panel.createEl('button', { cls: 'wb-panel-add' }); setIcon(add.createSpan(), 'circle-plus'); add.createSpan({ text: '新增字段' }); add.onclick = () => this.insertColumn(this.headers.length);
	}

	private openFieldEditor(anchor: HTMLElement, index: number) {
		this.contentEl.querySelector('.wb-field-editor')?.remove(); const field = this.meta.fields[index]; if (!field) return;
		const draft: FieldSchema = { ...field, options: field.options.map((option) => ({ ...option })) };
		const editor = this.contentEl.createDiv('wb-field-editor');
		const title = editor.createDiv('wb-form-group'); title.createEl('label', { text: '列标题' }); const input = title.createEl('input', { value: draft.name }); input.oninput = () => { draft.name = input.value; };
		const typeGroup = editor.createDiv('wb-form-group wb-type-group'); typeGroup.createEl('label', { text: '类型' });
		const typeSelect = typeGroup.createEl('button', { cls: 'wb-type-select-button', attr: { type: 'button', 'aria-expanded': 'false' } });
		const typeMenu = typeGroup.createDiv('wb-field-type-menu'); typeMenu.hidden = true;
		const optionArea = editor.createDiv('wb-option-area');
		const renderOptions = () => {
			optionArea.empty();
			if (draft.type === 'currency') {
				draft.currencyCode ??= 'CNY'; draft.currencyDecimals ??= 2; draft.currencyUseThousands ??= true;
				optionArea.createEl('label', { text: '格式设置' });
				const settings = optionArea.createDiv('wb-currency-settings');
				const symbolRow = settings.createDiv('wb-currency-setting-row'); symbolRow.createSpan({ text: '货币符号' });
				const symbol = symbolRow.createEl('select');
				CURRENCY_OPTIONS.forEach((currency) => symbol.createEl('option', { value: currency.code, text: `${currency.symbol} ${currency.code} ${currency.label}` }));
				symbol.value = draft.currencyCode; symbol.onchange = () => { draft.currencyCode = symbol.value as CurrencyCode; };
				const decimalRow = settings.createDiv('wb-currency-setting-row'); decimalRow.createSpan({ text: '小数位数' });
				const decimals = decimalRow.createEl('select');
				[0, 1, 2, 3, 4].forEach((places) => {
					const example = places === 0 ? '1' : `1.${'0'.repeat(places)}`;
					decimals.createEl('option', { value: String(places), text: `${places} 位（${example}）` });
				});
				decimals.value = String(draft.currencyDecimals); decimals.onchange = () => { draft.currencyDecimals = Number(decimals.value); };
				const thousandRow = settings.createDiv('wb-currency-setting-row'); thousandRow.createSpan({ text: '使用千位符' });
				const thousand = thousandRow.createEl('button', { cls: `wb-switch${draft.currencyUseThousands ? ' is-on' : ''}`, attr: { type: 'button', 'aria-pressed': String(draft.currencyUseThousands) } });
				thousand.onclick = () => { draft.currencyUseThousands = !draft.currencyUseThousands; thousand.toggleClass('is-on', draft.currencyUseThousands); thousand.setAttribute('aria-pressed', String(draft.currencyUseThousands)); };
			}
			if (draft.type === 'number') {
				optionArea.createEl('label', { text: '格式设置' }); const format = optionArea.createEl('select'); format.createEl('option', { text: '整数' });
				const thousand = optionArea.createEl('label', { cls: 'wb-check-row' }); thousand.createEl('input', { attr: { type: 'checkbox' } }); thousand.createSpan({ text: '使用千位符' });
			}
			if (draft.type === 'single' || draft.type === 'multi') {
				optionArea.createEl('label', { text: '选项管理' });
				draft.options.forEach((option, optionIndex) => {
					const row = optionArea.createDiv('wb-option-row'); row.createSpan({ cls: 'wb-drag-handle', text: '⠿' }); const color = row.createEl('button', { cls: 'wb-option-color' }); color.style.background = option.color;
					color.onclick = () => { option.color = OPTION_COLORS[(OPTION_COLORS.indexOf(option.color) + 1) % OPTION_COLORS.length] ?? OPTION_COLORS[0]!; renderOptions(); };
					const name = row.createEl('input', { value: option.name, attr: { placeholder: '输入选项名称' } }); name.oninput = () => { option.name = name.value; };
					const del = row.createEl('button'); setIcon(del, 'x'); del.onclick = () => { draft.options.splice(optionIndex, 1); renderOptions(); };
				});
				const add = optionArea.createEl('button', { cls: 'wb-inline-add', text: '+ 添加选项' }); add.onclick = () => { draft.options.push({ id: uid('option'), name: '', color: OPTION_COLORS[draft.options.length % OPTION_COLORS.length]! }); renderOptions(); };
			}
		};
		const renderTypeButton = () => {
			typeSelect.empty(); this.renderFieldTypeIcon(typeSelect, draft.type, 'wb-type-select-icon');
			typeSelect.createSpan({ cls: 'wb-type-select-label', text: FIELD_TYPES.find((item) => item.value === draft.type)?.label ?? '文本' });
			setIcon(typeSelect.createSpan('wb-type-select-chevron'), 'chevron-down');
		};
		const renderTypeMenu = () => {
			typeMenu.empty();
			FIELD_TYPES.forEach((item) => {
				const option = typeMenu.createEl('button', { cls: `wb-field-type-option${draft.type === item.value ? ' is-selected' : ''}`, attr: { type: 'button' } });
				this.renderFieldTypeIcon(option, item.value, 'wb-field-type-option-icon'); option.createSpan({ text: item.label });
				const check = option.createSpan('wb-field-type-option-check'); if (draft.type === item.value) setIcon(check, 'check');
				option.onclick = (event) => { event.stopPropagation(); draft.type = item.value; typeMenu.hidden = true; typeSelect.setAttribute('aria-expanded', 'false'); renderTypeButton(); renderTypeMenu(); renderOptions(); };
			});
		};
		typeSelect.onclick = (event) => { event.stopPropagation(); typeMenu.hidden = !typeMenu.hidden; typeSelect.setAttribute('aria-expanded', String(!typeMenu.hidden)); };
		renderTypeButton(); renderTypeMenu(); renderOptions();
		const buttons = editor.createDiv('wb-editor-actions'); const cancel = buttons.createEl('button', { text: '取消' }); cancel.onclick = () => editor.remove();
		const confirm = buttons.createEl('button', { cls: 'mod-cta', text: '确认' }); confirm.onclick = () => { this.headers[index] = draft.name || `字段 ${index + 1}`; this.meta.fields[index] = { ...draft, name: this.headers[index] }; this.scheduleSave(); this.scheduleMetaSave(); this.render(); };
		const rootRect = this.contentEl.getBoundingClientRect(); const anchorRect = anchor.getBoundingClientRect();
		window.requestAnimationFrame(() => { editor.style.left = `${Math.max(8, Math.min(anchorRect.left - rootRect.left, rootRect.width - editor.offsetWidth - 8))}px`; editor.style.top = `${Math.max(8, anchorRect.bottom - rootRect.top + 4)}px`; });
		window.setTimeout(() => { input.focus(); input.select(); const doc = this.containerEl.ownerDocument; const outside = (event: MouseEvent) => { if (editor.contains(event.target as Node) || anchor.contains(event.target as Node)) return; editor.remove(); doc.removeEventListener('mousedown', outside); }; doc.addEventListener('mousedown', outside); }, 0);
	}

	private renderRulePanel(panel: HTMLElement, kind: 'filter' | 'fill') {
		const rules = kind === 'filter' ? this.meta.filters : this.meta.fills; const emptyText = kind === 'filter' ? '暂无筛选条件' : '暂无填色规则';
		if (!rules.length) panel.createDiv({ cls: 'wb-panel-empty', text: emptyText });
		const list = panel.createDiv('wb-rule-list'); rules.forEach((rule, index) => this.renderFilterRule(list, rule, index, kind));
		const add = panel.createEl('button', { cls: 'wb-panel-add' }); setIcon(add.createSpan(), 'circle-plus'); add.createSpan({ text: kind === 'filter' ? '添加筛选条件' : '添加条件' });
		add.onclick = () => {
			const base = { id: uid(kind), column: 0, operator: kind === 'fill' ? 'all' as RuleOperator : 'not-empty' as RuleOperator, value: '' };
			if (kind === 'filter') this.meta.filters.push(base); else this.meta.fills.push({ ...base, color: OPTION_COLORS[0]!, wholeRow: false });
			this.scheduleMetaSave(); this.render();
		};
	}

	private renderFilterRule(list: HTMLElement, rule: FilterRule | FillRule, index: number, kind: 'filter' | 'fill') {
		const row = list.createDiv('wb-rule-row'); row.createSpan({ cls: 'wb-drag-handle', text: '⠿' });
		const field = row.createEl('select', { cls: 'wb-rule-field' }); this.meta.fields.forEach((item, column) => field.createEl('option', { value: String(column), text: `${TYPE_HINT[item.type]}  ${item.name}` }));
		field.value = String(rule.column); field.onchange = () => { rule.column = Number(field.value); this.scheduleMetaSave(); this.renderGridOnly(); };
		const operator = row.createEl('select', { cls: 'wb-rule-operator' }); const operators: RuleOperator[] = kind === 'fill' ? ['all', 'eq', 'neq', 'contains', 'not-contains', 'empty', 'not-empty'] : ['eq', 'neq', 'contains', 'not-contains', 'empty', 'not-empty'];
		operators.forEach((value) => operator.createEl('option', { value, text: OPERATOR_LABEL[value] })); operator.value = rule.operator; operator.onchange = () => { rule.operator = operator.value as RuleOperator; this.scheduleMetaSave(); this.render(); };
		if (!['empty', 'not-empty', 'all'].includes(rule.operator)) { const value = row.createEl('input', { cls: 'wb-rule-value', value: rule.value, attr: { placeholder: '输入值' } }); value.oninput = () => { rule.value = value.value; this.scheduleMetaSave(); this.renderGridOnly(); }; }
		if (kind === 'fill') { const fill = rule as FillRule; const color = row.createEl('button', { cls: 'wb-fill-swatch' }); color.style.background = fill.color; color.onclick = () => this.openColorMenu(color, fill); }
		const remove = row.createEl('button', { cls: 'wb-rule-remove' }); setIcon(remove, 'circle-minus'); remove.onclick = () => { (kind === 'filter' ? this.meta.filters : this.meta.fills).splice(index, 1); this.scheduleMetaSave(); this.render(); };
	}

	private openColorMenu(anchor: HTMLElement, rule: FillRule) {
		this.closeContextMenu(); const menu = this.contentEl.createDiv('wb-color-menu'); this.contextMenu = menu;
		const rect = anchor.getBoundingClientRect(); const rootRect = this.contentEl.getBoundingClientRect(); menu.style.top = `${rect.bottom - rootRect.top + 4}px`;
		window.requestAnimationFrame(() => { menu.style.left = `${Math.max(8, Math.min(rect.left - rootRect.left - 20, rootRect.width - menu.offsetWidth - 8))}px`; });
		const none = menu.createEl('button', { cls: 'wb-color-none' }); setIcon(none.createSpan(), 'ban'); none.createSpan({ text: '无色' }); none.onclick = () => { rule.color = 'transparent'; this.scheduleMetaSave(); this.render(); };
		const grid = menu.createDiv('wb-color-grid'); OPTION_COLORS.forEach((color) => { const swatch = grid.createEl('button', { attr: { 'aria-label': color } }); swatch.style.background = color; if (rule.color === color) swatch.addClass('is-active'); swatch.onclick = () => { rule.color = color; this.scheduleMetaSave(); this.render(); }; });
		const whole = menu.createEl('label', { cls: 'wb-check-row' }); const check = whole.createEl('input', { attr: { type: 'checkbox' } }); check.checked = rule.wholeRow; check.onchange = () => { rule.wholeRow = check.checked; this.scheduleMetaSave(); this.render(); }; whole.createSpan({ text: '整行填色' });
	}

	private renderGroupPanel(panel: HTMLElement) {
		if (!this.meta.groups.length) panel.createDiv({ cls: 'wb-panel-empty', text: '暂无分组条件' }); const list = panel.createDiv('wb-rule-list');
		this.meta.groups.forEach((rule, index) => { const row = list.createDiv('wb-rule-row'); row.createSpan({ cls: 'wb-drag-handle', text: '⠿' }); const field = row.createEl('select'); this.meta.fields.forEach((item, column) => field.createEl('option', { value: String(column), text: `${TYPE_HINT[item.type]}  ${item.name}` })); field.value = String(rule.column); field.onchange = () => { rule.column = Number(field.value); this.scheduleMetaSave(); this.render(); }; const remove = row.createEl('button', { cls: 'wb-rule-remove' }); setIcon(remove, 'circle-minus'); remove.onclick = () => { this.meta.groups.splice(index, 1); this.scheduleMetaSave(); this.render(); }; });
		const add = panel.createEl('button', { cls: 'wb-panel-add' }); setIcon(add.createSpan(), 'circle-plus'); add.createSpan({ text: '添加分组条件' }); add.onclick = () => { this.meta.groups.push({ id: uid('group'), column: 0 }); this.scheduleMetaSave(); this.render(); };
	}
	private renderSortPanel(panel: HTMLElement) {
		if (!this.meta.sorts.length) panel.createDiv({ cls: 'wb-panel-empty', text: '暂无排序条件' }); const list = panel.createDiv('wb-rule-list');
		this.meta.sorts.forEach((rule, index) => { const row = list.createDiv('wb-rule-row'); row.createSpan({ cls: 'wb-drag-handle', text: '⠿' }); const field = row.createEl('select'); this.meta.fields.forEach((item, column) => field.createEl('option', { value: String(column), text: `${TYPE_HINT[item.type]}  ${item.name}` })); field.value = String(rule.column); field.onchange = () => { rule.column = Number(field.value); this.scheduleMetaSave(); this.render(); }; const direction = row.createEl('select'); direction.createEl('option', { value: 'asc', text: '升序 A → Z' }); direction.createEl('option', { value: 'desc', text: '降序 Z → A' }); direction.value = rule.direction; direction.onchange = () => { rule.direction = direction.value as 'asc' | 'desc'; this.scheduleMetaSave(); this.render(); }; const remove = row.createEl('button', { cls: 'wb-rule-remove' }); setIcon(remove, 'circle-minus'); remove.onclick = () => { this.meta.sorts.splice(index, 1); this.scheduleMetaSave(); this.render(); }; });
		const add = panel.createEl('button', { cls: 'wb-panel-add' }); setIcon(add.createSpan(), 'circle-plus'); add.createSpan({ text: '添加排序条件' }); add.onclick = () => { this.meta.sorts.push({ id: uid('sort'), column: 0, direction: 'asc' }); this.scheduleMetaSave(); this.render(); };
	}

	private renderGrid(page: HTMLElement) {
		const shell = page.createDiv('wb-grid-shell'); const table = shell.createEl('table', { cls: 'wb-grid' }); this.renderHeader(table); const body = table.createEl('tbody'); const visible = this.getVisibleRows();
		if (this.meta.groups.length) this.renderGroupedRows(body, visible); else this.renderPlainRows(body, visible);
		this.renderAddRow(body);
	}
	private renderGridOnly() { const page = this.contentEl.querySelector<HTMLElement>('.wb-page'); if (!page) return; page.querySelector('.wb-grid-shell')?.remove(); this.renderGrid(page); }

	private renderHeader(table: HTMLTableElement) {
		const head = table.createEl('thead').createEl('tr'); const corner = head.createEl('th', { cls: 'wb-row-number wb-corner-cell' }); const selectAll = corner.createEl('button', { cls: 'wb-select-all', attr: { 'aria-label': '全选' } });
		const allSelected = this.isAllSelected(); selectAll.toggleClass('is-checked', allSelected); selectAll.setAttribute('aria-pressed', String(allSelected)); if (allSelected) setIcon(selectAll, 'check');
		selectAll.onclick = () => { this.selection = allSelected ? null : { startRow: 0, endRow: this.displayedRowEnd(), startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) }; this.renderGridOnly(); };
		let frozenLeft = 40;
		this.meta.fields.forEach((field, columnIndex) => {
			if (!field.visible) return; const th = head.createEl('th'); th.style.width = `${field.width}px`; th.dataset.column = String(columnIndex);
			if (field.frozen) { th.addClass('is-frozen-column'); th.style.left = `${frozenLeft}px`; frozenLeft += field.width; }
			const button = th.createEl('button', { cls: 'wb-column-header' }); button.dataset.column = String(columnIndex); this.renderFieldTypeIcon(button, field.type); button.createSpan({ cls: 'wb-column-title', text: field.name }); const chevron = button.createSpan('wb-column-chevron'); setIcon(chevron, 'chevron-down');
			button.onclick = (event) => { if ((event.target as HTMLElement).closest('.wb-column-chevron')) this.openHeaderContextMenu(button, columnIndex); else this.openFieldEditor(button, columnIndex); };
			button.oncontextmenu = (event) => { event.preventDefault(); this.selection = { startRow: 0, endRow: Math.max(0, this.rows.length - 1), startColumn: columnIndex, endColumn: columnIndex }; this.openContextMenu(event.clientX, event.clientY, this.headerMenuItems(columnIndex)); };
			const resizer = th.createDiv('wb-column-resizer'); resizer.onmousedown = (event) => this.startResize(event, columnIndex);
		});
		const addField = head.createEl('th', { cls: 'wb-add-field-head' }); const addButton = addField.createEl('button'); setIcon(addButton.createSpan(), 'plus'); addButton.createSpan({ text: '字段' }); addButton.onclick = () => this.insertColumn(this.headers.length);
	}
	private renderPlainRows(body: HTMLTableSectionElement, visible: VisibleRow[]) { const displayCount = Math.max(visible.length, 7); for (let index = 0; index < displayCount; index += 1) this.renderRow(body, visible[index] ?? { row: this.createEmptyRow(), index }); }
	private renderGroupedRows(body: HTMLTableSectionElement, visible: VisibleRow[]) {
		const column = this.meta.groups[0]?.column ?? 0; const groups = new Map<string, VisibleRow[]>();
		visible.forEach((item) => { const key = item.row[column]?.trim() || '(空)'; const bucket = groups.get(key) ?? []; bucket.push(item); groups.set(key, bucket); });
		if (!groups.size) groups.set('(空)', []);

		// Keep the grid visually full after grouping. Put the same virtual
		// blank rows used by the plain view into the empty-value group.
		const missingRows = Math.max(0, 7 - visible.length);
		if (missingRows) {
			const emptyItems = groups.get('(空)') ?? [];
			for (let offset = 0; offset < missingRows; offset += 1) emptyItems.push({ row: this.createEmptyRow(), index: this.rows.length + offset });
			groups.set('(空)', emptyItems);
		}

		groups.forEach((items, key) => {
			const groupRow = body.createEl('tr', { cls: 'wb-group-row' });
			const cell = groupRow.createEl('td', { attr: { colspan: String(this.visibleColumnCount() + 2) } });
			const toggle = cell.createEl('button', { attr: { type: 'button', 'aria-expanded': String(!this.collapsedGroups.has(key)) } });
			setIcon(toggle.createSpan('wb-group-chevron'), this.collapsedGroups.has(key) ? 'chevron-right' : 'chevron-down');
			toggle.createSpan({ cls: 'wb-group-label', text: `${this.headers[column]}: ${key}` });
			toggle.onclick = () => { this.collapsedGroups.has(key) ? this.collapsedGroups.delete(key) : this.collapsedGroups.add(key); this.renderGridOnly(); };
			if (!this.collapsedGroups.has(key)) {
				items.forEach((item) => this.renderRow(body, item));
				this.renderGroupAddRow(body, column, key);
			}
		});
	}

	private renderGroupAddRow(body: HTMLTableSectionElement, groupColumn: number, groupKey: string) {
		const row = body.createEl('tr', { cls: 'wb-group-add-row' });
		const numberCell = row.createEl('td', { cls: 'wb-row-number' });
		const add = numberCell.createEl('button', { attr: { type: 'button', 'aria-label': '在此分组添加一行' } }); setIcon(add, 'circle-plus');
		add.onclick = () => {
			this.pushHistory(); const next = this.createEmptyRow(); if (groupKey !== '(空)') next[groupColumn] = groupKey;
			this.rows.push(next); this.scheduleSave(); this.render(); this.focusCell(this.rows.length - 1, 0);
		};
		this.meta.fields.forEach((field) => { if (field.visible) { const cell = row.createEl('td'); cell.style.width = `${field.width}px`; } });
		row.createEl('td', { cls: 'wb-add-field-spacer' });
	}

	private renderRow(body: HTMLTableSectionElement, item: VisibleRow) {
		const tr = body.createEl('tr'); tr.dataset.row = String(item.index); if (this.selection?.startRow === item.index) tr.addClass('is-active-row'); const rowHead = tr.createEl('th', { cls: 'wb-row-number', text: String(item.index + 1) }); rowHead.dataset.row = String(item.index); this.applyRowHeadSelectionClasses(rowHead, item.index);
		rowHead.onclick = () => { this.selection = { startRow: item.index, endRow: item.index, startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) }; this.renderGridOnly(); };
		rowHead.oncontextmenu = (event) => { event.preventDefault(); this.selection = { startRow: item.index, endRow: item.index, startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) }; this.openContextMenu(event.clientX, event.clientY, this.rowMenuItems(item.index)); };
		let frozenLeft = 40;
		this.meta.fields.forEach((field, columnIndex) => {
			if (!field.visible) return; const td = tr.createEl('td'); td.style.width = `${field.width}px`; td.dataset.row = String(item.index); td.dataset.column = String(columnIndex); this.applySelectionClassesToCell(td, item.index, columnIndex);
			if (field.frozen) { td.addClass('is-frozen-column'); td.style.left = `${frozenLeft}px`; frozenLeft += field.width; }
			const fill = this.getFill(item.row, columnIndex); if (fill) (fill.wholeRow ? tr : td).style.background = fill.color;
			const editor = this.createCellEditor(td, item, field, columnIndex);
			if (this.cellMatchesSearch(item.row[columnIndex] ?? '')) td.addClass('is-search-hit');
			td.onmousedown = (event) => { if (event.button !== 0) return; this.dragging = true; const anchor = event.shiftKey && this.selection ? { row: this.selection.startRow, column: this.selection.startColumn } : { row: item.index, column: columnIndex }; this.selection = { startRow: anchor.row, endRow: item.index, startColumn: anchor.column, endColumn: columnIndex }; this.applySelectionClasses(); };
			td.onmouseenter = () => { if (!this.dragging || !this.selection) return; this.selection.endRow = item.index; this.selection.endColumn = columnIndex; this.applySelectionClasses(); };
			td.oncontextmenu = (event) => { event.preventDefault(); if (!this.isSelected(item.index, columnIndex)) this.selection = { startRow: item.index, endRow: item.index, startColumn: columnIndex, endColumn: columnIndex }; this.openContextMenu(event.clientX, event.clientY, this.cellMenuItems(item.index, columnIndex)); };
			editor.addEventListener('focus', () => { this.selection = { startRow: item.index, endRow: item.index, startColumn: columnIndex, endColumn: columnIndex }; this.applySelectionClasses(); }, true);
		});
		tr.createEl('td', { cls: 'wb-add-field-spacer' });
	}

	private createCellEditor(td: HTMLElement, item: VisibleRow, field: FieldSchema, column: number): HTMLElement {
		const value = item.row[column] ?? '';
		if (field.type === 'single' || field.type === 'multi') {
			const button = td.createEl('button', { cls: `wb-cell-choice wb-cell-${field.type}`, attr: { type: 'button' } });
			button.dataset.row = String(item.index); button.dataset.column = String(column);
			this.renderChoiceCell(button, value, field, field.type === 'multi');
			button.onclick = () => this.openChoiceMenu(button, item.index, column, field, field.type === 'multi');
			button.onkeydown = (event) => this.handleCellKey(event, item.index, column);
			return button;
		}
		if (field.type === 'image') return this.createImageCell(td, item, field, column);
		if (field.type === 'attachment') return this.createIndexCell(td, item, column);
		if (field.type === 'checkbox') return this.createCheckboxCell(td, item, column);
		if (field.type === 'link') return this.createExternalLinkCell(td, item, column);

		const input = td.createEl('input', { cls: `wb-cell-input wb-cell-${field.type}`, value: field.type === 'currency' ? this.formatCurrency(value, field) : value });
		input.spellcheck = false; input.dataset.row = String(item.index); input.dataset.column = String(column);
		switch (field.type) {
			case 'number': input.type = 'number'; input.step = 'any'; input.inputMode = 'decimal'; break;
			case 'currency': input.type = 'text'; input.inputMode = 'decimal'; break;
			case 'date': input.type = 'date'; break;
			case 'person': input.type = 'text'; break;
			case 'email': input.type = 'email'; input.inputMode = 'email'; break;
			case 'phone': input.type = 'tel'; input.inputMode = 'tel'; break;
			default: input.type = 'text';
		}
		input.oninput = () => { this.setCell(item.index, column, input.type === 'checkbox' ? (input.checked ? 'true' : '') : input.value); this.scheduleSave(); };
		input.onkeydown = (event) => this.handleCellKey(event, item.index, column); input.onpaste = (event) => this.handlePaste(event, item.index, column);
		input.onfocus = () => { this.pushHistory(); if (field.type === 'currency') input.value = item.row[column] ?? ''; };
		input.onblur = () => { if (field.type === 'currency') input.value = this.formatCurrency(item.row[column] ?? '', field); this.pushHistory(); };
		return input;
	}

	private createCheckboxCell(td: HTMLElement, item: VisibleRow, column: number): HTMLElement {
		const checked = ['true', '1', '是', '✓'].includes((item.row[column] ?? '').toLocaleLowerCase());
		const button = td.createEl('button', {
			cls: `wb-cell-checkbox${checked ? ' is-checked' : ''}`,
			attr: { type: 'button', role: 'checkbox', 'aria-checked': String(checked), 'aria-label': checked ? '取消勾选' : '勾选' },
		});
		const box = button.createSpan('wb-cell-checkbox-box'); if (checked) setIcon(box, 'check');
		button.dataset.row = String(item.index); button.dataset.column = String(column);
		button.onclick = (event) => {
			event.stopPropagation(); this.pushHistory(); this.setCell(item.index, column, checked ? '' : 'true'); this.scheduleSave(); this.renderGridOnly();
		};
		button.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		return button;
	}

	private createExternalLinkCell(td: HTMLElement, item: VisibleRow, column: number): HTMLElement {
		const value = item.row[column] ?? ''; const link = this.parseExternalLink(value);
		const cell = td.createDiv('wb-cell-link'); cell.dataset.row = String(item.index); cell.dataset.column = String(column);
		const open = cell.createEl('button', { cls: `wb-cell-link-open${link.url ? '' : ' is-empty'}`, attr: { type: 'button', title: link.url ? '打开外部链接' : '添加链接' } });
		open.createSpan({ cls: 'wb-cell-link-label', text: link.url ? (link.text || link.url) : '输入链接' });
		open.onclick = (event) => { event.stopPropagation(); if (link.url) this.openExternalLink(link.url); else this.openLinkPopover(cell, item.index, column); };
		open.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		const picker = cell.createEl('button', { cls: 'wb-cell-link-picker', attr: { type: 'button', 'aria-label': link.url ? '编辑链接' : '添加链接' } }); setIcon(picker, 'chevron-down');
		picker.onclick = (event) => { event.stopPropagation(); this.openLinkPopover(cell, item.index, column); };
		picker.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		return cell;
	}

	private parseExternalLink(value: string): { text: string; url: string } {
		const trimmed = value.trim(); const match = /^\[([^\]]*)\]\(([\s\S]*)\)$/.exec(trimmed);
		return match ? { text: match[1]?.trim() ?? '', url: match[2]?.trim() ?? '' } : { text: trimmed, url: trimmed };
	}

	private externalLinkValue(text: string, url: string): string {
		const cleanUrl = url.trim(); if (!cleanUrl) return '';
		return `[${text.trim() || cleanUrl}](${cleanUrl})`;
	}

	private openExternalLink(value: string) {
		const raw = value.trim(); const normalized = /^(https?:|mailto:|tel:)/i.test(raw) ? raw : `https://${raw}`;
		try {
			const parsed = new URL(normalized); if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
			window.open(parsed.href, '_blank', 'noopener,noreferrer');
		} catch { new Notice('链接地址无效'); }
	}

	private openLinkPopover(anchor: HTMLElement, row: number, column: number) {
		this.closeContextMenu(); const current = this.parseExternalLink(this.rows[row]?.[column] ?? '');
		const rootRect = this.contentEl.getBoundingClientRect(); const rect = anchor.getBoundingClientRect();
		const popover = this.contentEl.createDiv('wb-link-popover'); this.contextMenu = popover;
		popover.style.left = `${Math.max(8, Math.min(rect.left - rootRect.left, rootRect.width - 430))}px`;
		popover.style.top = `${Math.max(8, rect.bottom - rootRect.top + 4)}px`;
		const textRow = popover.createDiv('wb-link-form-row'); textRow.createEl('label', { text: '显示文本' });
		const textInput = textRow.createEl('input', { value: current.text, attr: { type: 'text', placeholder: '请输入显示文本' } });
		const urlRow = popover.createDiv('wb-link-form-row'); urlRow.createEl('label', { text: '链接' });
		const urlInput = urlRow.createEl('input', { value: current.url, attr: { type: 'url', placeholder: '请输入链接地址' } });
		const actions = popover.createDiv('wb-link-actions');
		const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } }); cancel.onclick = () => this.closeContextMenu();
		const confirm = actions.createEl('button', { cls: 'mod-cta', text: '确认', attr: { type: 'button' } });
		const save = () => { this.pushHistory(); this.setCell(row, column, this.externalLinkValue(textInput.value, urlInput.value)); this.scheduleSave(); this.closeContextMenu(); this.renderGridOnly(); };
		confirm.onclick = save; [textInput, urlInput].forEach((input) => { input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } }; });
		this.registerChoiceMenuDismiss(popover, anchor); window.setTimeout(() => textInput.focus(), 0);
	}

	private formatCurrency(value: string, field: FieldSchema): string {
		if (!value.trim()) return '';
		const numeric = Number(value.replace(/[,，\s¥$€£]/g, ''));
		if (!Number.isFinite(numeric)) return value;
		const currency = CURRENCY_OPTIONS.find((item) => item.code === (field.currencyCode ?? 'CNY')) ?? CURRENCY_OPTIONS[0]!;
		const decimals = Math.max(0, Math.min(4, field.currencyDecimals ?? 2));
		const formatted = numeric.toLocaleString('zh-CN', {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
			useGrouping: field.currencyUseThousands ?? true,
		});
		return `${currency.symbol}${formatted}`;
	}

	private parseMultiValue(value: string): string[] {
		return value.split(/\s*[;；]\s*/).map((part) => part.trim()).filter(Boolean);
	}

	private renderChoiceCell(button: HTMLElement, value: string, field: FieldSchema, multiple: boolean) {
		button.empty();
		const names = multiple ? this.parseMultiValue(value) : (value.trim() ? [value.trim()] : []);
		const tags = button.createSpan('wb-cell-tags');
		names.forEach((name) => {
			const option = field.options.find((candidate) => candidate.name === name);
			const tag = tags.createSpan({ cls: 'wb-cell-tag', text: name });
			tag.style.backgroundColor = option?.color ?? 'var(--background-modifier-hover)';
		});
		const chevron = button.createSpan('wb-cell-choice-chevron'); setIcon(chevron, 'chevron-down');
	}

	private openChoiceMenu(anchor: HTMLElement, row: number, column: number, field: FieldSchema, multiple: boolean) {
		this.closeContextMenu();
		const rootRect = this.contentEl.getBoundingClientRect(); const rect = anchor.getBoundingClientRect();
		const menu = this.contentEl.createDiv('wb-option-picker-menu'); this.contextMenu = menu;
		menu.style.left = `${Math.max(8, Math.min(rect.left - rootRect.left, rootRect.width - 250))}px`;
		menu.style.top = `${Math.max(8, rect.bottom - rootRect.top + 4)}px`;
		if (!field.options.length) menu.createDiv({ cls: 'wb-option-picker-empty', text: '暂无选项，请先在字段设置中添加' });
		const selected = new Set(multiple ? this.parseMultiValue(this.rows[row]?.[column] ?? '') : [this.rows[row]?.[column] ?? '']);
		field.options.forEach((option) => {
			const item = menu.createEl('button', { cls: 'wb-option-picker-item', attr: { type: 'button' } });
			item.createSpan({ cls: 'wb-option-dot' }).style.backgroundColor = option.color;
			item.createSpan({ text: option.name || '未命名选项' });
			const check = item.createSpan('wb-option-picker-check'); if (selected.has(option.name)) setIcon(check, 'check');
			item.onclick = (event) => {
				event.stopPropagation(); this.pushHistory();
				if (multiple) {
					selected.has(option.name) ? selected.delete(option.name) : selected.add(option.name);
					this.setCell(row, column, [...selected].filter(Boolean).join('; '));
					check.empty(); if (selected.has(option.name)) setIcon(check, 'check');
					this.renderChoiceCell(anchor, this.rows[row]?.[column] ?? '', field, true);
				} else {
					this.setCell(row, column, option.name); this.renderChoiceCell(anchor, option.name, field, false); this.closeContextMenu();
				}
				this.scheduleSave();
			};
		});
		const clear = menu.createEl('button', { cls: 'wb-option-picker-clear', attr: { type: 'button' } }); setIcon(clear.createSpan(), 'x'); clear.createSpan({ text: '清空' });
		clear.onclick = () => { this.pushHistory(); this.setCell(row, column, ''); this.scheduleSave(); this.renderChoiceCell(anchor, '', field, multiple); this.closeContextMenu(); };
		this.registerChoiceMenuDismiss(menu, anchor);
	}

	private registerChoiceMenuDismiss(menu: HTMLElement, anchor: HTMLElement) {
		window.setTimeout(() => this.registerDomEvent(this.containerEl.ownerDocument, 'mousedown', (event) => {
			if (this.contextMenu !== menu) return;
			if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) this.closeContextMenu();
			else this.registerChoiceMenuDismiss(menu, anchor);
		}, { once: true }), 0);
	}

	private createIndexCell(td: HTMLElement, item: VisibleRow, column: number): HTMLElement {
		const value = item.row[column] ?? '';
		const cell = td.createDiv('wb-cell-index'); cell.dataset.row = String(item.index); cell.dataset.column = String(column);
		if (value.trim()) {
			const open = cell.createEl('button', { cls: 'wb-cell-index-open', attr: { type: 'button', title: '打开索引' } });
			open.createSpan({ cls: 'wb-cell-index-name', text: this.indexDisplayName(value) });
			open.onclick = (event) => { event.stopPropagation(); void this.openIndexLink(value); };
			open.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		}
		const picker = cell.createEl('button', { cls: `wb-cell-index-picker${value.trim() ? '' : ' is-empty'}`, attr: { type: 'button', 'aria-label': value.trim() ? '更换索引' : '添加索引' } });
		if (value.trim()) setIcon(picker, 'chevron-down');
		else picker.createSpan({ text: '添加索引' });
		picker.onclick = (event) => { event.stopPropagation(); this.openIndexPopover(picker, item.index, column); };
		picker.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		return cell;
	}

	private indexLinkText(value: string): string {
		const trimmed = value.trim();
		const match = /^\[\[([\s\S]*?)\]\]$/.exec(trimmed);
		return (match?.[1] ?? trimmed).split('|')[0]?.trim() ?? '';
	}

	private indexFilePath(value: string): string {
		return this.indexLinkText(value).split(/[#^]/)[0]?.trim() ?? '';
	}

	private indexDisplayName(value: string): string {
		const trimmed = value.trim(); const match = /^\[\[([\s\S]*?)\]\]$/.exec(trimmed);
		const alias = match?.[1]?.split('|').slice(1).join('|').trim(); if (alias) return alias;
		const target = this.indexFilePath(value); const file = this.resolveIndexFile(target);
		return file?.basename ?? target.split('/').pop()?.replace(/\.md$/i, '') ?? target;
	}

	private resolveIndexFile(target: string): TFile | null {
		if (!target) return null;
		const sourcePath = this.file?.path ?? '';
		const resolved = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
		if (resolved) return resolved;
		const direct = this.app.vault.getAbstractFileByPath(normalizePath(target));
		if (direct instanceof TFile) return direct;
		const markdown = this.app.vault.getAbstractFileByPath(normalizePath(`${target}.md`));
		return markdown instanceof TFile ? markdown : null;
	}

	private async openIndexLink(value: string) {
		const linkText = this.indexLinkText(value); const target = this.resolveIndexFile(this.indexFilePath(value));
		if (!target) { new Notice('索引目标不存在'); return; }
		await this.app.workspace.openLinkText(linkText, this.file?.path ?? '', false);
	}

	private indexValueForFile(file: TFile): string {
		const target = file.extension === 'md' ? file.path.slice(0, -3) : file.path;
		return `[[${target}]]`;
	}

	private openIndexPopover(anchor: HTMLElement, row: number, column: number) {
		this.closeContextMenu();
		const rootRect = this.contentEl.getBoundingClientRect(); const rect = anchor.getBoundingClientRect();
		const popover = this.contentEl.createDiv('wb-index-popover'); this.contextMenu = popover;
		popover.style.left = `${Math.max(8, Math.min(rect.left - rootRect.left, rootRect.width - 330))}px`;
		popover.style.top = `${Math.max(8, rect.bottom - rootRect.top + 4)}px`;
		const search = popover.createDiv('wb-index-search'); setIcon(search.createSpan(), 'search');
		const input = search.createEl('input', { attr: { type: 'search', placeholder: '搜索仓库文件' } });
		const results = popover.createDiv('wb-index-results');
		const configPrefix = `${this.app.vault.configDir}/`;
		const files = this.app.vault.getFiles()
			.filter((file) => file.path !== this.file?.path && !file.path.startsWith(configPrefix))
			.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN', { numeric: true }));
		const renderResults = () => {
			results.empty(); const query = input.value.trim().toLocaleLowerCase();
			const matched = files.filter((file) => !query || file.path.toLocaleLowerCase().includes(query)).slice(0, 60);
			if (!matched.length) results.createDiv({ cls: 'wb-index-empty', text: '没有找到匹配文件' });
			matched.forEach((file) => {
				const option = results.createEl('button', { cls: 'wb-index-option', attr: { type: 'button' } });
				setIcon(option.createSpan('wb-index-option-icon'), file.extension === 'md' ? 'file-text' : 'file');
				const copy = option.createSpan('wb-index-option-copy'); copy.createSpan({ cls: 'wb-index-option-name', text: file.basename });
				copy.createSpan({ cls: 'wb-index-option-path', text: file.parent?.path && file.parent.path !== '/' ? file.parent.path : '仓库根目录' });
				option.onclick = () => { this.pushHistory(); this.setCell(row, column, this.indexValueForFile(file)); this.scheduleSave(); this.closeContextMenu(); this.renderGridOnly(); };
			});
		};
		input.oninput = renderResults; renderResults();
		const clear = popover.createEl('button', { cls: 'wb-index-clear', attr: { type: 'button' } }); setIcon(clear.createSpan(), 'x'); clear.createSpan({ text: '清空索引' });
		clear.onclick = () => { this.pushHistory(); this.setCell(row, column, ''); this.scheduleSave(); this.closeContextMenu(); this.renderGridOnly(); };
		this.registerChoiceMenuDismiss(popover, anchor); window.setTimeout(() => input.focus(), 0);
	}

	private createImageCell(td: HTMLElement, item: VisibleRow, field: FieldSchema, column: number): HTMLElement {
		const value = item.row[column] ?? '';
		const cell = td.createDiv('wb-cell-image'); cell.dataset.row = String(item.index); cell.dataset.column = String(column);
		if (value) {
			const stored = this.app.vault.getAbstractFileByPath(value);
			const preview = cell.createEl('button', { cls: 'wb-cell-image-open', attr: { type: 'button', 'aria-label': '预览图片' } });
			if (stored instanceof TFile) {
				const thumb = preview.createSpan('wb-cell-image-preview'); thumb.style.backgroundImage = `url("${this.app.vault.getResourcePath(stored)}")`;
				preview.onclick = (event) => { event.stopPropagation(); this.openImagePreview(stored); };
			} else {
				setIcon(preview.createSpan('wb-cell-image-missing'), 'image-off');
				preview.onclick = (event) => { event.stopPropagation(); new Notice('图片文件不存在'); };
			}
			preview.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		}
		const picker = cell.createEl('button', { cls: 'wb-cell-image-picker', attr: { type: 'button', 'aria-label': value ? '更换图片' : '添加图片' } });
		setIcon(picker, 'chevron-down');
		picker.onclick = (event) => { event.stopPropagation(); this.openFilePopover(cell, item.index, column, field); };
		picker.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		return cell;
	}

	private openImagePreview(file: TFile) {
		const modal = new Modal(this.app); modal.modalEl.addClass('wb-image-preview-modal');
		modal.contentEl.createEl('img', { cls: 'wb-image-preview-full', attr: { src: this.app.vault.getResourcePath(file), alt: file.basename } });
		modal.open();
	}

	private openFilePopover(anchor: HTMLElement, row: number, column: number, field: FieldSchema) {
		this.closeContextMenu(); const isImage = field.type === 'image';
		const rootRect = this.contentEl.getBoundingClientRect(); const rect = anchor.getBoundingClientRect();
		const popover = this.contentEl.createDiv('wb-file-popover'); this.contextMenu = popover;
		popover.style.left = `${Math.max(8, Math.min(rect.left - rootRect.left, rootRect.width - 378))}px`;
		popover.style.top = `${Math.max(8, rect.bottom - rootRect.top + 4)}px`;
		const dropZone = popover.createDiv('wb-file-drop-zone');
		const currentPath = this.rows[row]?.[column] ?? '';
		const currentFile = currentPath ? this.app.vault.getAbstractFileByPath(currentPath) : null;
		if (isImage && currentFile instanceof TFile) {
			const card = dropZone.createDiv('wb-file-current-image');
			const image = card.createEl('img', { attr: { src: this.app.vault.getResourcePath(currentFile), alt: currentFile.basename } });
			image.onclick = (event) => { event.stopPropagation(); this.openImagePreview(currentFile); };
			const actions = card.createDiv('wb-file-current-actions');
			const download = actions.createEl('button', { attr: { type: 'button', 'aria-label': '下载图片' } }); setIcon(download, 'download');
			download.onclick = (event) => { event.stopPropagation(); void this.downloadVaultFile(currentFile); };
			const remove = actions.createEl('button', { attr: { type: 'button', 'aria-label': '移除图片' } }); setIcon(remove, 'trash-2');
			remove.onclick = (event) => { event.stopPropagation(); this.pushHistory(); this.setCell(row, column, ''); this.scheduleSave(); this.closeContextMenu(); this.renderGridOnly(); };
		} else dropZone.createSpan({ text: isImage ? '将图片拖拽至此即可添加' : '将文件拖拽至此即可添加' });
		const add = popover.createEl('button', { cls: 'wb-file-local-button', attr: { type: 'button' } });
		setIcon(add.createSpan(), 'plus'); add.createSpan({ text: isImage ? '添加本地图片' : '添加本地文件' });
		const picker = popover.createEl('input', { cls: 'wb-cell-file-picker', attr: { type: 'file' } }); if (isImage) picker.accept = 'image/*';
		const accept = (file: File) => { if (isImage && !file.type.startsWith('image/')) { new Notice('请选择图片文件'); return; } void this.importCellFile(file, row, column).then(() => this.closeContextMenu()); };
		add.onclick = () => picker.click(); picker.onchange = () => { const file = picker.files?.[0]; if (file) accept(file); };
		dropZone.ondragover = (event) => { event.preventDefault(); dropZone.addClass('is-dragging'); };
		dropZone.ondragleave = () => dropZone.removeClass('is-dragging');
		dropZone.ondrop = (event) => { event.preventDefault(); dropZone.removeClass('is-dragging'); const file = event.dataTransfer?.files[0]; if (file) accept(file); };
		this.registerChoiceMenuDismiss(popover, anchor);
	}

	private async downloadVaultFile(file: TFile) {
		try {
			const data = await this.app.vault.readBinary(file); const url = URL.createObjectURL(new Blob([data]));
			const link = this.containerEl.ownerDocument.createElement('a'); link.href = url; link.download = file.name;
			this.containerEl.ownerDocument.body.appendChild(link); link.click(); link.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (error) { console.error('[LiteGrid] 下载图片失败', error); new Notice('下载图片失败'); }
	}

	private async importCellFile(file: File, row: number, column: number) {
		try {
			this.pushHistory();
			const path = this.availableCellFilePath(file.name);
			await this.app.vault.createBinary(path, await file.arrayBuffer());
			this.setCell(row, column, path); this.scheduleSave(); this.renderGridOnly();
		} catch (error) {
			console.error('[LiteGrid] 导入附件失败', error); new Notice('导入附件失败');
		}
	}

	private availableCellFilePath(fileName: string): string {
		const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_') || '附件';
		const dot = safeName.lastIndexOf('.'); const stem = dot > 0 ? safeName.slice(0, dot) : safeName; const extension = dot > 0 ? safeName.slice(dot) : '';
		const folder = this.file?.parent?.path ?? ''; let counter = 1;
		let path = normalizePath(folder ? `${folder}/${safeName}` : safeName);
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(folder ? `${folder}/${stem} ${counter}${extension}` : `${stem} ${counter}${extension}`); counter += 1;
		}
		return path;
	}
	private renderAddRow(body: HTMLTableSectionElement) {
		const add = body.createEl('tr', { cls: 'wb-add-row-line' }); const cell = add.createEl('td', { cls: 'wb-row-number' }); const button = cell.createEl('button', { attr: { 'aria-label': '添加一行' } }); setIcon(button, 'circle-plus'); button.onclick = () => this.addRow();
		let frozenLeft = 40;
		this.meta.fields.forEach((field, column) => {
			if (!field.visible) return;
			const statCell = add.createEl('td', { cls: 'wb-stat-cell' }); statCell.style.width = `${field.width}px`;
			if (field.frozen) { statCell.addClass('is-frozen-column'); statCell.style.left = `${frozenLeft}px`; frozenLeft += field.width; }
			const mode = this.meta.statistics[field.id] ?? 'none'; const stat = statCell.createEl('button', { cls: `wb-column-stat${mode === 'none' ? '' : ' has-stat'}`, attr: { 'aria-label': `${field.name}统计` } });
			stat.createSpan({ text: mode === 'none' ? '统计' : `${this.statisticLabel(mode)} ${this.statisticValue(column, mode)}` });
			stat.onclick = (event) => { event.stopPropagation(); this.openStatisticMenu(stat, column); };
		});
		add.createEl('td', { cls: 'wb-add-field-spacer' });
	}

	private getVisibleRows(): VisibleRow[] {
		const result = this.rows.map((row, index) => ({ row, index })).filter(({ row }) => this.meta.filters.every((rule) => this.matches(row[rule.column] ?? '', rule)));
		if (this.meta.sorts.length) result.sort((left, right) => { for (const rule of this.meta.sorts) { const comparison = (left.row[rule.column] ?? '').localeCompare(right.row[rule.column] ?? '', 'zh-CN', { numeric: true }); if (comparison) return comparison * (rule.direction === 'asc' ? 1 : -1); } return left.index - right.index; }); return result;
	}
	private matches(value: string, rule: FilterRule | FillRule): boolean { const source = value.toLocaleLowerCase(); const target = rule.value.toLocaleLowerCase(); switch (rule.operator) { case 'all': return true; case 'eq': return source === target; case 'neq': return source !== target; case 'contains': return source.includes(target); case 'not-contains': return !source.includes(target); case 'empty': return value.trim() === ''; case 'not-empty': return value.trim() !== ''; } }
	private getFill(row: string[], column: number): FillRule | undefined { return this.meta.fills.find((rule) => rule.column === column && this.matches(row[column] ?? '', rule)); }

	private handleCellKey(event: KeyboardEvent, row: number, column: number) {
		if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') { event.preventDefault(); void navigator.clipboard.writeText(this.selectionText()); return; }
		if (!['Enter', 'Tab', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); let nextRow = row; let nextColumn = column;
		if (event.key === 'Enter' || event.key === 'ArrowDown') nextRow += 1; if (event.key === 'ArrowUp') nextRow -= 1; if (event.key === 'Tab') nextColumn += event.shiftKey ? -1 : 1;
		if (nextColumn >= this.headers.length) { nextColumn = 0; nextRow += 1; } if (nextColumn < 0) { nextColumn = this.headers.length - 1; nextRow -= 1; } if (nextRow >= this.rows.length) this.rows.push(this.createEmptyRow());
		this.scheduleSave(); this.render(); this.focusCell(Math.max(0, nextRow), Math.max(0, nextColumn));
	}
	private handlePaste(event: ClipboardEvent, startRow: number, startColumn: number) { const text = event.clipboardData?.getData('text/plain'); if (!text || (!text.includes('\t') && !text.includes('\n'))) return; event.preventDefault(); this.pushHistory(); text.replace(/\r\n/g, '\n').split('\n').filter((line, index, all) => line.length > 0 || index < all.length - 1).forEach((line, rowOffset) => { line.split('\t').forEach((value, columnOffset) => { if (startColumn + columnOffset < this.headers.length) this.setCell(startRow + rowOffset, startColumn + columnOffset, value); }); }); this.scheduleSave(); this.render(); }

	private addRow() { this.pushHistory(); this.rows.push(this.createEmptyRow()); this.scheduleSave(); this.render(); this.focusCell(this.rows.length - 1, 0); }
	private createEmptyRow() { return Array.from({ length: this.headers.length }, () => ''); }
	private setCell(row: number, column: number, value: string) { while (this.rows.length <= row) this.rows.push(this.createEmptyRow()); if (this.rows[row]) this.rows[row][column] = value; this.setStatus('未保存'); }
	private focusCell(row: number, column: number) { window.setTimeout(() => this.contentEl.querySelector<HTMLInputElement>(`.wb-cell-input[data-row="${row}"][data-column="${column}"]`)?.focus(), 0); }
	private visibleColumnCount() { return this.meta.fields.filter((field) => field.visible).length; }
	private isSelected(row: number, column: number) { if (!this.selection) return false; const minRow = Math.min(this.selection.startRow, this.selection.endRow); const maxRow = Math.max(this.selection.startRow, this.selection.endRow); const minColumn = Math.min(this.selection.startColumn, this.selection.endColumn); const maxColumn = Math.max(this.selection.startColumn, this.selection.endColumn); return row >= minRow && row <= maxRow && column >= minColumn && column <= maxColumn; }
	private displayedRowEnd() { return Math.max(6, this.rows.length - 1); }
	private isAllSelected() {
		if (!this.selection) return false;
		const minRow = Math.min(this.selection.startRow, this.selection.endRow); const maxRow = Math.max(this.selection.startRow, this.selection.endRow);
		const minColumn = Math.min(this.selection.startColumn, this.selection.endColumn); const maxColumn = Math.max(this.selection.startColumn, this.selection.endColumn);
		return minRow === 0 && maxRow >= this.displayedRowEnd() && minColumn === 0 && maxColumn >= this.headers.length - 1;
	}
	private selectionBounds() {
		if (!this.selection) return null;
		const minRow = Math.min(this.selection.startRow, this.selection.endRow); const maxRow = Math.max(this.selection.startRow, this.selection.endRow);
		const minColumn = Math.min(this.selection.startColumn, this.selection.endColumn); const maxColumn = Math.max(this.selection.startColumn, this.selection.endColumn);
		const visibleColumns = this.meta.fields.map((field, index) => field.visible && index >= minColumn && index <= maxColumn ? index : -1).filter((index) => index >= 0);
		if (!visibleColumns.length) return null;
		return { minRow, maxRow, minColumn, maxColumn, leftColumn: visibleColumns[0]!, rightColumn: visibleColumns[visibleColumns.length - 1]!, isRange: minRow !== maxRow || visibleColumns.length > 1 };
	}
	private applySelectionClassesToCell(cell: HTMLElement, row: number, column: number) {
		const bounds = this.selectionBounds(); const selected = this.isSelected(row, column); cell.toggleClass('is-selected', selected);
		['is-selection-top', 'is-selection-right', 'is-selection-bottom', 'is-selection-left', 'is-selection-range'].forEach((name) => cell.removeClass(name));
		if (!selected || !bounds) return;
		cell.toggleClass('is-selection-top', row === bounds.minRow); cell.toggleClass('is-selection-bottom', row === bounds.maxRow);
		cell.toggleClass('is-selection-left', column === bounds.leftColumn); cell.toggleClass('is-selection-right', column === bounds.rightColumn);
		cell.toggleClass('is-selection-range', bounds.isRange);
	}
	private applyRowHeadSelectionClasses(cell: HTMLElement, row: number) {
		const bounds = this.selectionBounds();
		const visible = this.meta.fields.map((field, index) => field.visible ? index : -1).filter((index) => index >= 0);
		const fullRow = !!bounds && row >= bounds.minRow && row <= bounds.maxRow && bounds.minColumn <= (visible[0] ?? 0) && bounds.maxColumn >= (visible[visible.length - 1] ?? 0);
		['is-selected', 'is-selection-top', 'is-selection-bottom', 'is-selection-left', 'is-selection-range'].forEach((name) => cell.removeClass(name));
		if (!fullRow || !bounds) return;
		cell.addClass('is-selected', 'is-selection-left'); cell.toggleClass('is-selection-top', row === bounds.minRow); cell.toggleClass('is-selection-bottom', row === bounds.maxRow); cell.toggleClass('is-selection-range', bounds.isRange);
	}
	private selectedCoordinates() { const result: Array<{ row: number; column: number }> = []; if (!this.selection) return result; const minRow = Math.max(0, Math.min(this.selection.startRow, this.selection.endRow)); const maxRow = Math.min(Math.max(0, this.rows.length - 1), Math.max(this.selection.startRow, this.selection.endRow)); const minColumn = Math.max(0, Math.min(this.selection.startColumn, this.selection.endColumn)); const maxColumn = Math.min(this.headers.length - 1, Math.max(this.selection.startColumn, this.selection.endColumn)); for (let row = minRow; row <= maxRow; row += 1) for (let column = minColumn; column <= maxColumn; column += 1) result.push({ row, column }); return result; }
	private selectionText() { if (!this.selection) return ''; const minRow = Math.min(this.selection.startRow, this.selection.endRow); const maxRow = Math.max(this.selection.startRow, this.selection.endRow); const minColumn = Math.min(this.selection.startColumn, this.selection.endColumn); const maxColumn = Math.max(this.selection.startColumn, this.selection.endColumn); return Array.from({ length: maxRow - minRow + 1 }, (_, offset) => this.rows[minRow + offset]?.slice(minColumn, maxColumn + 1).join('\t') ?? '').join('\n'); }
	private applySelectionClasses() {
		this.contentEl.querySelectorAll<HTMLElement>('td[data-row][data-column]').forEach((cell) => this.applySelectionClassesToCell(cell, Number(cell.dataset.row), Number(cell.dataset.column)));
		this.contentEl.querySelectorAll<HTMLElement>('th.wb-row-number[data-row]').forEach((cell) => this.applyRowHeadSelectionClasses(cell, Number(cell.dataset.row)));
		this.contentEl.querySelectorAll<HTMLElement>('tr[data-row]').forEach((row) => row.toggleClass('is-active-row', Number(row.dataset.row) === this.selection?.startRow));
	}

	private startResize(event: MouseEvent, column: number) { event.preventDefault(); event.stopPropagation(); const field = this.meta.fields[column]; if (!field) return; const startX = event.clientX; const startWidth = field.width; const move = (moveEvent: MouseEvent) => { field.width = Math.max(100, Math.min(600, startWidth + moveEvent.clientX - startX)); this.contentEl.querySelectorAll<HTMLElement>(`[data-column="${column}"]`).forEach((cell) => { cell.style.width = `${field.width}px`; }); }; const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); this.scheduleMetaSave(); }; document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); }

	private openRowHeightMenu(toolbar: HTMLElement) { this.closeContextMenu(); const button = toolbar.querySelector<HTMLElement>('[data-action="行高"]'); if (!button) return; const rect = button.getBoundingClientRect(); const rootRect = this.contentEl.getBoundingClientRect(); const menu = this.contentEl.createDiv('wb-context-menu wb-row-height-menu'); this.contextMenu = menu; menu.style.left = `${rect.left - rootRect.left}px`; menu.style.top = `${rect.bottom - rootRect.top + 4}px`; ([['default', '默认'], ['medium', '中等'], ['spacious', '宽松'], ['extra', '超宽']] as Array<[RowHeight, string]>).forEach(([value, label]) => this.addMenuItem(menu, label, value === this.meta.rowHeight ? 'check' : '', () => { this.meta.rowHeight = value; this.scheduleMetaSave(); this.closeContextMenu(); this.render(); })); }
	private openHeaderContextMenu(anchor: HTMLElement, column: number) { const rect = anchor.getBoundingClientRect(); this.openContextMenu(rect.right - 180, rect.bottom, this.headerMenuItems(column)); }
	private openContextMenu(clientX: number, clientY: number, items: MenuItem[]) { this.closeContextMenu(); const rootRect = this.contentEl.getBoundingClientRect(); const menu = this.contentEl.createDiv('wb-context-menu'); this.contextMenu = menu; menu.style.left = `${Math.max(8, Math.min(clientX - rootRect.left, rootRect.width - 210))}px`; menu.style.top = `${Math.max(8, clientY - rootRect.top)}px`; items.forEach((item) => { if (item.divider) menu.createDiv('wb-menu-divider'); else if (item.quantityAction) this.addQuantityMenuItem(menu, item.label ?? '', item.icon ?? '', (count) => { item.quantityAction?.(count); this.closeContextMenu(); }); else this.addMenuItem(menu, item.label ?? '', item.icon ?? '', () => { item.action?.(); this.closeContextMenu(); }, item.danger); }); window.setTimeout(() => this.registerDomEvent(this.containerEl.ownerDocument, 'mousedown', (event) => { if (!menu.contains(event.target as Node)) this.closeContextMenu(); }, { once: true }), 0); }
	private addMenuItem(menu: HTMLElement, label: string, icon: string, action: () => void, danger = false) { const button = menu.createEl('button', { cls: danger ? 'is-danger' : '' }); if (icon) setIcon(button.createSpan(), icon); else button.createSpan(); button.createSpan({ text: label }); button.onclick = action; }
	private addQuantityMenuItem(menu: HTMLElement, label: string, icon: string, action: (count: number) => void) {
		const row = menu.createDiv('wb-menu-quantity-row'); const iconSlot = row.createSpan('wb-menu-item-icon'); setIcon(iconSlot, icon); row.createSpan({ cls: 'wb-menu-quantity-label', text: label });
		const quantity = row.createEl('input', { cls: 'wb-menu-quantity-input', attr: { type: 'number', min: '1', max: '999', value: '1', 'aria-label': '插入行数' } }); row.createSpan({ cls: 'wb-menu-quantity-unit', text: '行' });
		const run = () => action(Math.max(1, Math.min(999, Number(quantity.value) || 1))); row.onclick = (event) => { if (event.target === quantity) return; run(); }; quantity.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); run(); } };
	}
	private closeContextMenu() { this.contextMenu?.remove(); this.contextMenu = null; }

	private statisticLabel(mode: ColumnStatistic) { return ({ count: '计数', empty: '未填写', filled: '已填写', unique: '去重计数', 'empty-rate': '未填写占比', 'filled-rate': '已填写占比', 'unique-rate': '去重占比', none: '不显示' } as Record<ColumnStatistic, string>)[mode]; }
	private statisticValue(column: number, mode: ColumnStatistic) {
		const values = this.rows.map((row) => row[column] ?? ''); const total = values.length; const filled = values.filter((value) => value.trim().length > 0); const unique = new Set(filled).size;
		const percent = (value: number) => `${total ? Math.round((value / total) * 100) : 0}%`;
		if (mode === 'count') return String(total); if (mode === 'empty') return String(total - filled.length); if (mode === 'filled') return String(filled.length); if (mode === 'unique') return String(unique);
		if (mode === 'empty-rate') return percent(total - filled.length); if (mode === 'filled-rate') return percent(filled.length); if (mode === 'unique-rate') return percent(unique); return '';
	}
	private openStatisticMenu(anchor: HTMLElement, column: number) {
		this.closeContextMenu(); const field = this.meta.fields[column]; if (!field) return; const menu = this.contentEl.createDiv('wb-context-menu wb-stat-menu'); this.contextMenu = menu;
		const current = this.meta.statistics[field.id] ?? 'none'; const options: ColumnStatistic[] = ['count', 'empty', 'filled', 'unique', 'empty-rate', 'filled-rate', 'unique-rate'];
		options.forEach((mode) => { const item = menu.createEl('button', { cls: 'wb-stat-menu-item' }); const check = item.createSpan('wb-stat-check'); if (current === mode) setIcon(check, 'check'); item.createSpan({ text: this.statisticLabel(mode) }); item.createSpan({ cls: 'wb-stat-value', text: this.statisticValue(column, mode) }); item.onclick = () => { this.meta.statistics[field.id] = mode; this.scheduleMetaSave(); this.closeContextMenu(); this.render(); }; });
		menu.createDiv('wb-menu-divider'); const hide = menu.createEl('button', { cls: 'wb-stat-menu-item' }); const check = hide.createSpan('wb-stat-check'); if (current === 'none') setIcon(check, 'check'); hide.createSpan({ text: '不显示' }); hide.createSpan(); hide.onclick = () => { this.meta.statistics[field.id] = 'none'; this.scheduleMetaSave(); this.closeContextMenu(); this.render(); };
		const rect = anchor.getBoundingClientRect(); const rootRect = this.contentEl.getBoundingClientRect(); window.requestAnimationFrame(() => { menu.style.left = `${Math.max(8, Math.min(rect.left - rootRect.left - 12, rootRect.width - menu.offsetWidth - 8))}px`; menu.style.top = `${Math.max(8, rect.top - rootRect.top - menu.offsetHeight - 5)}px`; });
		window.setTimeout(() => this.registerDomEvent(this.containerEl.ownerDocument, 'mousedown', (event) => { if (!menu.contains(event.target as Node)) this.closeContextMenu(); }, { once: true }), 0);
	}

	private headerMenuItems(column: number): MenuItem[] { return [
		{ label: '修改字段', icon: 'pencil', action: () => { this.render(); window.setTimeout(() => { const header = this.contentEl.querySelector<HTMLElement>(`.wb-column-header[data-column="${column}"]`) ?? this.contentEl.querySelectorAll<HTMLElement>('.wb-column-header')[column]; if (header) this.openFieldEditor(header, column); }, 0); } },
		{ label: '插入字段', icon: 'between-vertical-start', action: () => this.insertColumn(column + 1) }, { label: '创建副本', icon: 'copy', action: () => this.duplicateColumn(column) }, { divider: true },
		{ label: '筛选', icon: 'list-filter', action: () => { this.meta.filters.push({ id: uid('filter'), column, operator: 'not-empty', value: '' }); this.panel = 'filter'; this.scheduleMetaSave(); this.render(); } },
		{ label: '分组', icon: 'rows-3', action: () => { this.meta.groups.push({ id: uid('group'), column }); this.panel = 'group'; this.scheduleMetaSave(); this.render(); } },
		{ label: '排序', icon: 'arrow-up-down', action: () => { this.meta.sorts.push({ id: uid('sort'), column, direction: 'asc' }); this.panel = 'sort'; this.scheduleMetaSave(); this.render(); } },
		{ label: '填色', icon: 'paint-bucket', action: () => { this.meta.fills.push({ id: uid('fill'), column, operator: 'all', value: '', color: OPTION_COLORS[0]!, wholeRow: false }); this.panel = 'fill'; this.scheduleMetaSave(); this.render(); } }, { divider: true },
		{ label: '调整至合适列宽', icon: 'move-horizontal', action: () => this.fitColumn(column) }, { label: '冻结到此列', icon: 'snowflake', action: () => { this.meta.fields.forEach((field, index) => { field.frozen = index <= column; }); this.scheduleMetaSave(); this.render(); } }, { label: '隐藏字段', icon: 'eye-off', action: () => { const field = this.meta.fields[column]; if (field) field.visible = false; this.scheduleMetaSave(); this.render(); } }, { divider: true },
		{ label: '删除字段', icon: 'trash-2', danger: true, action: () => this.deleteColumn(column) },
	]; }
	private rowMenuItems(row: number): MenuItem[] { return [ { label: '创建副本', icon: 'files', action: () => this.duplicateRow(row) }, { label: '在上方插入', icon: 'arrow-up', quantityAction: (count) => this.insertRows(row, count) }, { label: '在下方插入', icon: 'arrow-down', quantityAction: (count) => this.insertRows(row + 1, count) }, { label: '删除', icon: 'trash-2', danger: true, action: () => this.deleteRows() } ]; }
	private cellMenuItems(row: number, column: number): MenuItem[] { return [ { label: '不看已填写', icon: 'filter', action: () => { this.meta.filters.push({ id: uid('filter'), column, operator: 'empty', value: '' }); this.scheduleMetaSave(); this.render(); } }, { label: '只看未填写', icon: 'filter', action: () => { this.meta.filters.push({ id: uid('filter'), column, operator: 'empty', value: '' }); this.scheduleMetaSave(); this.render(); } }, { divider: true }, ...this.rowMenuItems(row) ]; }

	private insertRows(index: number, count: number) { this.pushHistory(); this.rows.splice(index, 0, ...Array.from({ length: count }, () => this.createEmptyRow())); this.scheduleSave(); this.render(); }
	private duplicateRow(index: number) { this.pushHistory(); this.rows.splice(index + 1, 0, [...(this.rows[index] ?? this.createEmptyRow())]); this.scheduleSave(); this.render(); }
	private deleteRows() { this.pushHistory(); const rows = [...new Set(this.selectedCoordinates().map((item) => item.row))].sort((a, b) => b - a); rows.forEach((row) => this.rows.splice(row, 1)); this.selection = null; this.scheduleSave(); this.render(); }
	private insertColumn(index: number) { this.pushHistory(); const field = this.newField(`字段 ${index + 1}`, index); this.headers.splice(index, 0, field.name); this.meta.fields.splice(index, 0, field); this.rows.forEach((row) => row.splice(index, 0, '')); this.shiftRuleColumns(index, 1); this.scheduleSave(); this.scheduleMetaSave(); this.render(); }
	private duplicateColumn(index: number) { this.pushHistory(); const source = this.meta.fields[index]; if (!source) return; const copy = { ...source, id: uid('field'), name: `${source.name} 副本`, options: source.options.map((option) => ({ ...option, id: uid('option') })) }; this.headers.splice(index + 1, 0, copy.name); this.meta.fields.splice(index + 1, 0, copy); this.rows.forEach((row) => row.splice(index + 1, 0, row[index] ?? '')); this.shiftRuleColumns(index + 1, 1); this.scheduleSave(); this.scheduleMetaSave(); this.render(); }
	private deleteColumn(index: number) { if (this.headers.length <= 1) { new Notice('至少保留一个字段'); return; } this.pushHistory(); this.headers.splice(index, 1); this.meta.fields.splice(index, 1); this.rows.forEach((row) => row.splice(index, 1)); this.meta.filters = this.adjustRulesAfterDelete(this.meta.filters, index); this.meta.sorts = this.adjustRulesAfterDelete(this.meta.sorts, index); this.meta.groups = this.adjustRulesAfterDelete(this.meta.groups, index); this.meta.fills = this.adjustRulesAfterDelete(this.meta.fills, index); this.scheduleSave(); this.scheduleMetaSave(); this.render(); }
	private shiftRuleColumns(index: number, delta: number) { [...this.meta.filters, ...this.meta.sorts, ...this.meta.groups, ...this.meta.fills].forEach((rule) => { if (rule.column >= index) rule.column += delta; }); }
	private adjustRulesAfterDelete<T extends { column: number }>(rules: T[], index: number): T[] { return rules.filter((rule) => rule.column !== index).map((rule) => ({ ...rule, column: rule.column > index ? rule.column - 1 : rule.column })); }
	private fitColumn(index: number) { const field = this.meta.fields[index]; if (!field) return; const max = Math.max(field.name.length, ...this.rows.map((row) => (row[index] ?? '').length)); field.width = Math.max(100, Math.min(420, 64 + max * 14)); this.scheduleMetaSave(); this.render(); }
}
