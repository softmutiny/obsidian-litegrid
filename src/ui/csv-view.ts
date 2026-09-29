import { Modal, normalizePath, Notice, Platform, setIcon, TextFileView, TFile, WorkspaceLeaf } from 'obsidian';
import { normalizeRows, parseCsv, serializeCsv, type CsvDocument } from '../utils/csv';
import {
	FIELD_TYPES, OPTION_COLORS, type ColumnStatistic, type CurrencyCode, type DateFormat, type FieldSchema, type FieldType, type FillRule,
	type FilterRule, type NumberFormat, type RowHeight, type RuleOperator, type TableMeta,
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
const NUMBER_FORMAT_OPTIONS: Array<{ value: NumberFormat; label: string }> = [
	{ value: 'integer', label: '整数' },
	{ value: 'd1', label: '1 位（1.0）' },
	{ value: 'd2', label: '2 位（1.00）' },
	{ value: 'd3', label: '3 位（1.000）' },
	{ value: 'd4', label: '4 位（1.0000）' },
	{ value: 'percent', label: '百分比（100%）' },
	{ value: 'percent2', label: '百分比 2 位（100.00%）' },
	{ value: 'raw', label: '显示原值' },
];
const DATE_FORMAT_OPTIONS: Array<{ value: DateFormat; label: string }> = [
	{ value: 'cn', label: '2018年4月20日' },
	{ value: 'iso', label: '2018-04-20' },
	{ value: 'slash', label: '2018/4/20' },
	{ value: 'md-cn', label: '4月20日' },
	{ value: 'cn-week', label: '2018年4月20日 星期五' },
	{ value: 'cn-time', label: '2018年4月20日 14:00' },
	{ value: 'iso-time', label: '2018-04-20 14:00' },
	{ value: 'us', label: '4/20/2018' },
	{ value: 'eu', label: '20/4/2018' },
];
const OPERATOR_LABEL: Record<RuleOperator, string> = {
	eq: '等于', neq: '不等于', contains: '包含', 'not-contains': '不包含',
	empty: '为空', 'not-empty': '不为空', all: '所有内容',
};

export class LiteGridCsvView extends TextFileView {
	private document: CsvDocument = { rows: [], delimiter: ',', eol: '\n', bom: false, trailingEol: false };
	private headers = [...DEFAULT_HEADERS];
	private rows: string[][] = [];
	private meta: TableMeta = this.defaultMeta(DEFAULT_HEADERS);
	private saveTimer: number | null = null;
	private metaTimer: number | null = null;
	private statusEl: HTMLElement | null = null;
	private panel: PanelKind = null;
	private selection: Selection | null = null;
	private dragging = false;
	private dragRowIndex: number | null = null;
	private dragGhost: HTMLElement | null = null;
	private dragBlank: HTMLElement | null = null;
	private dragFollow: ((event: DragEvent) => void) | null = null;
	private collapsedGroups = new Set<string>();
	private contextMenu: HTMLElement | null = null;
	private history: string[] = [];
	private displayedRows: number[] | null = null;
	private selectedRowCache: { order: number[]; start: number; end: number; rows: number[]; members: Set<number> } | null = null;
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
			if (event.key !== 'Escape' || !this.ownsKeyEvent(event)) return;
			const fieldEditor = this.contentEl.querySelector<HTMLElement>('.wb-field-editor');
			if (fieldEditor) fieldEditor.remove();
			else if (this.contextMenu) this.closeContextMenu();
			else if (this.panel) { this.panel = null; this.render(); }
			else if (this.searchVisible) { this.searchVisible = false; this.searchTerm = ''; this.replacementTerm = ''; this.render(); }
		});
		if (Platform.isIosApp) this.bindLongPressContextMenu();
	}
	// iOS 长按不会触发 contextmenu，这里把长按转成右键菜单；安卓原生就会触发，不需要
	private bindLongPressContextMenu() {
		let timer: number | null = null; let startX = 0; let startY = 0; let swallowClickUntil = 0;
		const cancel = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };
		this.registerDomEvent(this.contentEl, 'touchstart', (event: TouchEvent) => {
			cancel(); if (event.touches.length !== 1) return;
			const touch = event.touches[0]; const target = event.target as HTMLElement | null;
			if (!touch || !target?.closest('.wb-grid')) return;
			startX = touch.clientX; startY = touch.clientY;
			timer = window.setTimeout(() => {
				timer = null; swallowClickUntil = Date.now() + 700;
				target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: startX, clientY: startY }));
			}, 500);
		}, { passive: true });
		this.registerDomEvent(this.contentEl, 'touchmove', (event: TouchEvent) => {
			const touch = event.touches[0]; if (!touch) return;
			if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) cancel();
		}, { passive: true });
		this.registerDomEvent(this.contentEl, 'touchend', cancel);
		this.registerDomEvent(this.contentEl, 'touchcancel', cancel);
		this.registerDomEvent(this.contentEl, 'click', (event) => { if (Date.now() < swallowClickUntil) { event.preventDefault(); event.stopPropagation(); swallowClickUntil = 0; } }, { capture: true });
	}
	// 只处理落在本表格里的按键；焦点在页面空白处时，看本表格是不是当前激活的标签页
	private ownsKeyEvent(event: KeyboardEvent): boolean {
		const target = event.target as Node | null;
		if (target && this.containerEl.contains(target)) return true;
		return (!target || target === this.containerEl.ownerDocument.body) && this.app.workspace.getActiveViewOfType(LiteGridCsvView) === this;
	}

	setViewData(data: string, clear: boolean) {
		if (clear) this.clear();
		this.data = data;
		this.document = parseCsv(data);
		const [header, ...body] = this.document.rows;
		const hasHeaderText = header?.some((cell) => cell.length > 0) ?? false;
		if (hasHeaderText) {
			this.headers = [...header!];
			const width = body.reduce((max, row) => Math.max(max, row.length), this.headers.length);
			this.headers = normalizeRows([this.headers], width)[0] ?? this.headers;
			this.rows = normalizeRows(body, width);
		} else if (this.document.rows.length > 0) {
			// 首行全空但下面有数据：合成占位表头并保留全部行，避免整份数据被丢弃
			const width = this.document.rows.reduce((max, row) => Math.max(max, row.length), DEFAULT_HEADERS.length);
			this.headers = Array.from({ length: width }, (_, i) => DEFAULT_HEADERS[i] ?? `字段 ${i + 1}`);
			this.rows = normalizeRows(this.document.rows, width);
		} else {
			this.headers = [...DEFAULT_HEADERS];
			this.rows = [];
		}
		const stored = this.file ? this.host.getTableMeta(this.file.path) : undefined;
		this.meta = this.reconcileMeta(stored, this.headers);
		this.render();
	}

	getViewData(): string { return serializeCsv({ ...this.document, rows: [this.headers, ...this.rows] }); }
	clear() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		if (this.metaTimer !== null) window.clearTimeout(this.metaTimer);
		this.saveTimer = null; this.metaTimer = null; this.closeContextMenu(); this.contentEl.empty(); this.rows = [];
		this.history = []; this.historyIndex = -1; this.selection = null; this.collapsedGroups.clear();
	}

	private defaultMeta(headers: string[]): TableMeta {
		return { fields: headers.map((name, index) => this.newField(name, index)), rowHeight: 'default', statistics: {}, filters: [], sorts: [], groups: [], fills: [] };
	}
	private newField(name: string, index: number): FieldSchema {
		const lowered = name.toLocaleLowerCase();
		let type: FieldType = /数字|金额|数量|价格|number/.test(lowered) ? 'number' : 'text';
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
			groups: (stored.groups ?? []).filter((rule) => rule.column < fields.length).slice(0, 1),
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
		this.undoButton.disabled = this.history.length === 0 || (this.historyIndex <= 0 && this.history[this.historyIndex] === this.captureSnapshot());
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
		return value.replace(new RegExp(escaped, `${all ? 'g' : ''}${this.searchCaseSensitive ? '' : 'i'}`), () => this.replacementTerm);
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

	private captureSnapshot(): string {
		return JSON.stringify({ csv: this.getViewData(), meta: this.meta });
	}

	private pushHistory() {
		const snapshot = this.captureSnapshot();
		if (this.history[this.historyIndex] === snapshot) return;
		this.history = this.history.slice(0, this.historyIndex + 1);
		this.history.push(snapshot);
		if (this.history.length > 100) this.history.shift();
		this.historyIndex = this.history.length - 1;
	}

	private applySnapshot(snapshot: string) {
		const restored = JSON.parse(snapshot) as { csv: string; meta: TableMeta };
		this.data = restored.csv;
		this.document = parseCsv(restored.csv);
		const [header, ...body] = this.document.rows;
		if (header?.some((cell) => cell.length > 0)) {
			const width = body.reduce((max, row) => Math.max(max, row.length), header.length);
			this.headers = normalizeRows([header], width)[0] ?? header;
			this.rows = normalizeRows(body, width);
		}
		else { this.headers = [...DEFAULT_HEADERS]; this.rows = []; }
		this.meta = restored.meta;
		this.displayedRows = null;
		this.scheduleMetaSave();
		this.render();
	}

	private undo() { this.pushHistory(); if (this.historyIndex > 0) { this.historyIndex -= 1; this.applySnapshot(this.history[this.historyIndex]!); this.selection = null; void this.save(); } }
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

	private createStyledSelect(container: HTMLElement, options: Array<{ value: string; label: string }>, current: string, onChange: (value: string) => void) {
		const wrap = container.createDiv('wb-mini-select');
		const button = wrap.createEl('button', { cls: 'wb-mini-select-button', attr: { type: 'button', 'aria-haspopup': 'listbox' } });
		const label = button.createSpan({ cls: 'wb-mini-select-label', text: options.find((option) => option.value === current)?.label ?? current });
		setIcon(button.createSpan('wb-mini-select-chevron'), 'chevron-down');
		const menu = wrap.createDiv('wb-mini-select-menu'); menu.hidden = true;
		let selected = current;
		const build = () => {
			menu.empty();
			options.forEach((option) => {
				const item = menu.createEl('button', { cls: `wb-mini-select-option${option.value === selected ? ' is-selected' : ''}`, attr: { type: 'button' } });
				item.createSpan({ cls: 'wb-mini-select-option-label', text: option.label });
				const check = item.createSpan('wb-mini-select-check'); if (option.value === selected) setIcon(check, 'check');
				item.onclick = (event) => { event.stopPropagation(); selected = option.value; label.setText(option.label); menu.hidden = true; build(); onChange(option.value); };
			});
		};
		build();
		const dismiss = (event: MouseEvent) => { if (!wrap.contains(event.target as Node)) { menu.hidden = true; this.containerEl.ownerDocument.removeEventListener('mousedown', dismiss); } };
		button.onclick = (event) => {
			event.stopPropagation();
			const opening = menu.hidden; menu.hidden = !opening;
			if (opening) window.setTimeout(() => this.containerEl.ownerDocument.addEventListener('mousedown', dismiss), 0);
			else this.containerEl.ownerDocument.removeEventListener('mousedown', dismiss);
		};
		return wrap;
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
				this.createStyledSelect(symbolRow, CURRENCY_OPTIONS.map((currency) => ({ value: currency.code, label: `${currency.symbol} ${currency.code} ${currency.label}` })), draft.currencyCode, (value) => { draft.currencyCode = value as CurrencyCode; });
				const decimalRow = settings.createDiv('wb-currency-setting-row'); decimalRow.createSpan({ text: '小数位数' });
				this.createStyledSelect(decimalRow, [0, 1, 2, 3, 4].map((places) => ({ value: String(places), label: `${places} 位（${places === 0 ? '1' : `1.${'0'.repeat(places)}`}）` })), String(draft.currencyDecimals ?? 2), (value) => { draft.currencyDecimals = Number(value); });
				const thousandRow = settings.createDiv('wb-currency-setting-row'); thousandRow.createSpan({ text: '使用千位符' });
				const thousand = thousandRow.createEl('button', { cls: `wb-switch${draft.currencyUseThousands ? ' is-on' : ''}`, attr: { type: 'button', 'aria-pressed': String(draft.currencyUseThousands) } });
				thousand.onclick = () => { draft.currencyUseThousands = !draft.currencyUseThousands; thousand.toggleClass('is-on', draft.currencyUseThousands); thousand.setAttribute('aria-pressed', String(draft.currencyUseThousands)); };
			}
			if (draft.type === 'number') {
				draft.numberFormat ??= 'raw'; draft.numberUseThousands ??= false;
				optionArea.createEl('label', { text: '格式设置' });
				const settings = optionArea.createDiv('wb-currency-settings');
				const formatRow = settings.createDiv('wb-currency-setting-row'); formatRow.createSpan({ text: '数字格式' });
				this.createStyledSelect(formatRow, NUMBER_FORMAT_OPTIONS, draft.numberFormat, (value) => { draft.numberFormat = value as NumberFormat; });
				const thousandRow = settings.createDiv('wb-currency-setting-row'); thousandRow.createSpan({ text: '使用千位符' });
				const thousand = thousandRow.createEl('button', { cls: `wb-switch${draft.numberUseThousands ? ' is-on' : ''}`, attr: { type: 'button', 'aria-pressed': String(draft.numberUseThousands) } });
				thousand.onclick = () => { draft.numberUseThousands = !draft.numberUseThousands; thousand.toggleClass('is-on', draft.numberUseThousands ?? false); thousand.setAttribute('aria-pressed', String(draft.numberUseThousands)); };
			}
			if (draft.type === 'date') {
				draft.dateFormat ??= 'iso';
				optionArea.createEl('label', { text: '格式设置' });
				const settings = optionArea.createDiv('wb-currency-settings');
				const formatRow = settings.createDiv('wb-currency-setting-row'); formatRow.createSpan({ text: '日期格式' });
				this.createStyledSelect(formatRow, DATE_FORMAT_OPTIONS, draft.dateFormat, (value) => { draft.dateFormat = value as DateFormat; });
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
		if (this.meta.groups.length) return; // 目前只支持一级分组
		const add = panel.createEl('button', { cls: 'wb-panel-add' }); setIcon(add.createSpan(), 'circle-plus'); add.createSpan({ text: '添加分组条件' }); add.onclick = () => { this.meta.groups.push({ id: uid('group'), column: 0 }); this.scheduleMetaSave(); this.render(); };
	}
	private renderSortPanel(panel: HTMLElement) {
		if (!this.meta.sorts.length) panel.createDiv({ cls: 'wb-panel-empty', text: '暂无排序条件' }); const list = panel.createDiv('wb-rule-list');
		this.meta.sorts.forEach((rule, index) => { const row = list.createDiv('wb-rule-row'); row.createSpan({ cls: 'wb-drag-handle', text: '⠿' }); const field = row.createEl('select'); this.meta.fields.forEach((item, column) => field.createEl('option', { value: String(column), text: `${TYPE_HINT[item.type]}  ${item.name}` })); field.value = String(rule.column); field.onchange = () => { rule.column = Number(field.value); this.scheduleMetaSave(); this.render(); }; const direction = row.createEl('select'); direction.createEl('option', { value: 'asc', text: '升序 A → Z' }); direction.createEl('option', { value: 'desc', text: '降序 Z → A' }); direction.value = rule.direction; direction.onchange = () => { rule.direction = direction.value as 'asc' | 'desc'; this.scheduleMetaSave(); this.render(); }; const remove = row.createEl('button', { cls: 'wb-rule-remove' }); setIcon(remove, 'circle-minus'); remove.onclick = () => { this.meta.sorts.splice(index, 1); this.scheduleMetaSave(); this.render(); }; });
		const add = panel.createEl('button', { cls: 'wb-panel-add' }); setIcon(add.createSpan(), 'circle-plus'); add.createSpan({ text: '添加排序条件' }); add.onclick = () => { this.meta.sorts.push({ id: uid('sort'), column: 0, direction: 'asc' }); this.scheduleMetaSave(); this.render(); };
	}

	private renderGrid(page: HTMLElement) {
		this.displayedRows = null;
		const shell = page.createDiv('wb-grid-shell'); const table = shell.createEl('table', { cls: 'wb-grid' }); this.renderColgroup(table); this.renderHeader(table); const body = table.createEl('tbody'); const visible = this.getVisibleRows();
		if (this.meta.groups.length) this.renderGroupedRows(body, visible); else this.renderPlainRows(body, visible);
		this.renderAddRow(body);
	}
	private renderColgroup(table: HTMLTableElement) {
		const colgroup = table.createEl('colgroup');
		colgroup.createEl('col', { cls: 'wb-col-rownumber' });
		this.meta.fields.forEach((field, columnIndex) => { if (!field.visible) return; const col = colgroup.createEl('col'); col.dataset.column = String(columnIndex); col.style.width = `${field.width}px`; });
		colgroup.createEl('col', { cls: 'wb-col-addfield' });
	}
	private renderGridOnly() { const page = this.contentEl.querySelector<HTMLElement>('.wb-page'); if (!page) return; page.querySelector('.wb-grid-shell')?.remove(); this.renderGrid(page); }

	private renderHeader(table: HTMLTableElement) {
		const head = table.createEl('thead').createEl('tr'); const corner = head.createEl('th', { cls: 'wb-row-number wb-corner-cell' }); const selectAll = corner.createEl('button', { cls: 'wb-select-all', attr: { 'aria-label': '全选' } });
		const allSelected = this.isAllSelected(); selectAll.toggleClass('is-checked', allSelected); selectAll.setAttribute('aria-pressed', String(allSelected)); if (allSelected) setIcon(selectAll, 'check');
		selectAll.onclick = () => { this.selection = allSelected ? null : { startRow: this.getDisplayedRows()[0] ?? 0, endRow: this.getDisplayedRows()[this.getDisplayedRows().length - 1] ?? 0, startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) }; this.renderGridOnly(); };
		let frozenLeft = 40;
		this.meta.fields.forEach((field, columnIndex) => {
			if (!field.visible) return; const th = head.createEl('th'); th.dataset.column = String(columnIndex);
			if (field.frozen) { th.addClass('is-frozen-column'); th.style.left = `${frozenLeft}px`; frozenLeft += field.width; }
			const button = th.createEl('button', { cls: 'wb-column-header' }); button.dataset.column = String(columnIndex); this.renderFieldTypeIcon(button, field.type); button.createSpan({ cls: 'wb-column-title', text: field.name }); const chevron = button.createSpan('wb-column-chevron'); setIcon(chevron, 'chevron-down');
			button.onclick = (event) => { if ((event.target as HTMLElement).closest('.wb-column-chevron')) this.openHeaderContextMenu(button, columnIndex); else this.openFieldEditor(button, columnIndex); };
			button.oncontextmenu = (event) => { event.preventDefault(); this.selection = { startRow: this.getDisplayedRows()[0] ?? 0, endRow: this.getDisplayedRows()[this.getDisplayedRows().length - 1] ?? 0, startColumn: columnIndex, endColumn: columnIndex }; this.openContextMenu(event.clientX, event.clientY, this.headerMenuItems(columnIndex)); };
			const resizer = th.createDiv('wb-column-resizer'); resizer.onmousedown = (event) => this.startResize(event, columnIndex);
		});
		const addField = head.createEl('th', { cls: 'wb-add-field-head' }); const addButton = addField.createEl('button'); setIcon(addButton.createSpan(), 'plus'); addButton.createSpan({ text: '字段' }); addButton.onclick = () => this.insertColumn(this.headers.length);
	}
	private renderPlainRows(body: HTMLTableSectionElement, visible: VisibleRow[]) { const displayCount = Math.max(visible.length, 7); for (let index = 0; index < displayCount; index += 1) this.renderRow(body, visible[index] ?? { row: this.createEmptyRow(), index: this.rows.length + (index - visible.length) }); }
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
		this.meta.fields.forEach((field) => { if (field.visible) row.createEl('td'); });
		row.createEl('td', { cls: 'wb-add-field-spacer' });
	}

	private renderRow(body: HTMLTableSectionElement, item: VisibleRow) {
		const tr = body.createEl('tr'); tr.dataset.row = String(item.index); if (this.selection?.startRow === item.index) tr.addClass('is-active-row'); const rowHead = tr.createEl('th', { cls: 'wb-row-number', text: String(item.index + 1) }); rowHead.dataset.row = String(item.index); this.applyRowHeadSelectionClasses(rowHead, item.index);
		rowHead.onclick = () => { this.selection = { startRow: item.index, endRow: item.index, startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) }; this.renderGridOnly(); };
		rowHead.oncontextmenu = (event) => { event.preventDefault(); this.selection = { startRow: item.index, endRow: item.index, startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) }; this.openContextMenu(event.clientX, event.clientY, this.rowMenuItems(item.index)); };
		if (item.index < this.rows.length && !Platform.isMobile) {
			rowHead.draggable = true; rowHead.setAttribute('title', '拖拽调整行顺序');
			rowHead.ondragstart = (event) => {
				this.dragRowIndex = item.index; tr.addClass('is-dragging-row');
				const doc = this.containerEl.ownerDocument;
				const ghost = doc.body.createDiv('wb-row-drag-ghost');
				ghost.createDiv({ cls: 'wb-row-drag-ghost-num', text: String(item.index + 1) });
				this.meta.fields.forEach((cellField, cellIndex) => {
					if (!cellField.visible) return;
					const segment = ghost.createDiv('wb-row-drag-ghost-cell'); segment.style.width = `${cellField.width}px`;
					segment.setText(this.cellDisplayText(cellField, this.rows[item.index]?.[cellIndex] ?? ''));
				});
				ghost.createSpan({ cls: 'wb-row-drag-ghost-badge', text: `共 ${this.visibleColumnCount()} 列` });
				const grabRect = tr.getBoundingClientRect();
				const offsetX = event.clientX - grabRect.left; const offsetY = event.clientY - grabRect.top;
				const place = (x: number, y: number) => { ghost.style.left = `${x - offsetX}px`; ghost.style.top = `${y - offsetY}px`; };
				place(event.clientX, event.clientY);
				this.dragGhost = ghost;
				const follow = (moveEvent: DragEvent) => { if (moveEvent.clientX === 0 && moveEvent.clientY === 0) return; place(moveEvent.clientX, moveEvent.clientY); };
				this.dragFollow = follow; doc.addEventListener('dragover', follow);
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(item.index));
					const blank = doc.body.createDiv('wb-drag-blank'); this.dragBlank = blank; event.dataTransfer.setDragImage(blank, 0, 0);
				}
			};
			rowHead.ondragend = () => {
				this.dragRowIndex = null;
				this.dragGhost?.remove(); this.dragGhost = null;
				this.dragBlank?.remove(); this.dragBlank = null;
				if (this.dragFollow) { this.containerEl.ownerDocument.removeEventListener('dragover', this.dragFollow); this.dragFollow = null; }
				this.contentEl.querySelectorAll('.is-dragging-row, .wb-row-drop-before').forEach((el) => el.removeClasses(['is-dragging-row', 'wb-row-drop-before']));
			};
		}
		tr.ondragover = (event) => { if (this.dragRowIndex === null || this.dragRowIndex === item.index) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; this.contentEl.querySelectorAll('.wb-row-drop-before').forEach((el) => el.removeClass('wb-row-drop-before')); tr.addClass('wb-row-drop-before'); };
		tr.ondrop = (event) => { if (this.dragRowIndex === null) return; event.preventDefault(); tr.removeClass('wb-row-drop-before'); const from = this.dragRowIndex; this.dragRowIndex = null; this.moveRow(from, item.index); };
		let frozenLeft = 40;
		this.meta.fields.forEach((field, columnIndex) => {
			if (!field.visible) return; const td = tr.createEl('td'); td.dataset.row = String(item.index); td.dataset.column = String(columnIndex); this.applySelectionClassesToCell(td, item.index, columnIndex);
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
		if (field.type === 'date') return this.createDateCell(td, item, field, column);

		const input = td.createEl('input', { cls: `wb-cell-input wb-cell-${field.type}`, value: field.type === 'currency' ? this.formatCurrency(value, field) : field.type === 'number' ? this.formatNumber(value, field) : value });
		input.spellcheck = false; input.dataset.row = String(item.index); input.dataset.column = String(column);
		switch (field.type) {
			case 'number': input.type = 'text'; input.inputMode = 'decimal'; break;
			case 'currency': input.type = 'text'; input.inputMode = 'decimal'; break;
			case 'person': input.type = 'text'; break;
			case 'email': input.type = 'email'; input.inputMode = 'email'; break;
			case 'phone': input.type = 'tel'; input.inputMode = 'tel'; break;
			default: input.type = 'text';
		}
		input.oninput = () => { this.setCell(item.index, column, input.type === 'checkbox' ? (input.checked ? 'true' : '') : input.value); this.scheduleSave(); };
		input.onkeydown = (event) => this.handleCellKey(event, item.index, column); input.onpaste = (event) => this.handlePaste(event, item.index, column);
		input.onfocus = () => { this.pushHistory(); if (field.type === 'currency' || field.type === 'number') input.value = item.row[column] ?? ''; };
		input.onblur = () => { if (field.type === 'currency') input.value = this.formatCurrency(item.row[column] ?? '', field); else if (field.type === 'number') input.value = this.formatNumber(item.row[column] ?? '', field); this.pushHistory(); };
		return input;
	}

	private createDateCell(td: HTMLElement, item: VisibleRow, field: FieldSchema, column: number): HTMLElement {
		const value = item.row[column] ?? '';
		const dateFormat = field.dateFormat ?? 'iso';
		const trigger = td.createEl('button', { cls: `wb-cell-date${value.trim() ? '' : ' is-empty'}`, attr: { type: 'button' } });
		trigger.dataset.row = String(item.index); trigger.dataset.column = String(column);
		if (value.trim()) trigger.createSpan({ cls: 'wb-cell-date-text', text: this.formatDate(value, dateFormat) });
		trigger.onclick = (event) => { event.stopPropagation(); this.openDatePicker(trigger, item.index, column, field); };
		trigger.onkeydown = (event) => this.handleCellKey(event, item.index, column);
		return trigger;
	}

	private openDatePicker(anchor: HTMLElement, row: number, column: number, field: FieldSchema) {
		this.closeContextMenu();
		const dateFormat = field.dateFormat ?? 'iso';
		const hasTime = dateFormat === 'cn-time' || dateFormat === 'iso-time';
		const stored = this.rows[row]?.[column] ?? '';
		const parsed = this.parseDate(stored);
		let selected: Date | null = parsed ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) : null;
		let hh = parsed ? parsed.getHours() : 0; let mm = parsed ? parsed.getMinutes() : 0;
		const view = { year: (parsed ?? new Date()).getFullYear(), month: (parsed ?? new Date()).getMonth() };
		const rootRect = this.contentEl.getBoundingClientRect(); const rect = anchor.getBoundingClientRect();
		const pop = this.contentEl.createDiv('wb-date-popover'); this.contextMenu = pop;
		pop.style.left = `${Math.max(8, Math.min(rect.left - rootRect.left, rootRect.width - 296))}px`;
		pop.style.top = `${Math.max(8, rect.bottom - rootRect.top + 4)}px`;
		const pad = (n: number) => String(n).padStart(2, '0');
		const commit = (date: Date | null) => {
			this.pushHistory();
			if (!date) this.setCell(row, column, '');
			else { const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; this.setCell(row, column, hasTime ? `${base}T${pad(hh)}:${pad(mm)}` : base); }
			this.scheduleSave(); this.closeContextMenu(); this.renderGridOnly();
		};
		const sameDay = (a: Date | null, y: number, m: number, d: number) => !!a && a.getFullYear() === y && a.getMonth() === m && a.getDate() === d;
		const build = () => {
			pop.empty();
			const header = pop.createDiv('wb-date-header');
			const prev = header.createEl('button', { cls: 'wb-date-nav', attr: { type: 'button', 'aria-label': '上个月' } }); setIcon(prev, 'chevron-left');
			header.createSpan({ cls: 'wb-date-title', text: `${view.year}年${view.month + 1}月` });
			const next = header.createEl('button', { cls: 'wb-date-nav', attr: { type: 'button', 'aria-label': '下个月' } }); setIcon(next, 'chevron-right');
			prev.onclick = (event) => { event.stopPropagation(); view.month -= 1; if (view.month < 0) { view.month = 11; view.year -= 1; } build(); };
			next.onclick = (event) => { event.stopPropagation(); view.month += 1; if (view.month > 11) { view.month = 0; view.year += 1; } build(); };
			const week = pop.createDiv('wb-date-week'); ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].forEach((label) => week.createSpan({ text: label }));
			const grid = pop.createDiv('wb-date-grid');
			const firstDay = new Date(view.year, view.month, 1).getDay();
			const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
			const daysPrev = new Date(view.year, view.month, 0).getDate();
			const today = new Date();
			for (let i = 0; i < 42; i += 1) {
				let y = view.year, m = view.month, d: number;
				if (i < firstDay) { d = daysPrev - firstDay + 1 + i; m = view.month - 1; if (m < 0) { m = 11; y -= 1; } }
				else if (i < firstDay + daysInMonth) { d = i - firstDay + 1; }
				else { d = i - firstDay - daysInMonth + 1; m = view.month + 1; if (m > 11) { m = 0; y += 1; } }
				const day = grid.createEl('button', { cls: 'wb-date-day', attr: { type: 'button' }, text: String(d) });
				if (m !== view.month) day.addClass('is-outside');
				if (sameDay(today, y, m, d)) day.addClass('is-today');
				if (sameDay(selected, y, m, d)) day.addClass('is-selected');
				const cy = y, cm = m, cd = d;
				day.onclick = (event) => { event.stopPropagation(); selected = new Date(cy, cm, cd); if (hasTime) build(); else commit(selected); };
			}
			if (hasTime) {
				const timeRow = pop.createDiv('wb-date-time'); timeRow.createSpan({ text: '时间' });
				const hourInput = timeRow.createEl('input', { cls: 'wb-date-time-input', attr: { type: 'number', min: '0', max: '23', 'aria-label': '小时' } }); hourInput.value = pad(hh);
				timeRow.createSpan({ cls: 'wb-date-time-colon', text: ':' });
				const minuteInput = timeRow.createEl('input', { cls: 'wb-date-time-input', attr: { type: 'number', min: '0', max: '59', 'aria-label': '分钟' } }); minuteInput.value = pad(mm);
				hourInput.oninput = () => { hh = Math.max(0, Math.min(23, Number(hourInput.value) || 0)); };
				minuteInput.oninput = () => { mm = Math.max(0, Math.min(59, Number(minuteInput.value) || 0)); };
			}
			const footer = pop.createDiv('wb-date-footer');
			const todayBtn = footer.createEl('button', { cls: 'wb-date-today', attr: { type: 'button' }, text: '今天' });
			todayBtn.onclick = (event) => { event.stopPropagation(); const now = new Date(); selected = new Date(now.getFullYear(), now.getMonth(), now.getDate()); if (hasTime) { hh = now.getHours(); mm = now.getMinutes(); build(); } else commit(selected); };
			const clearBtn = footer.createEl('button', { cls: 'wb-date-clear', attr: { type: 'button' }, text: '清除' }); clearBtn.onclick = (event) => { event.stopPropagation(); commit(null); };
			if (hasTime) { const confirmBtn = footer.createEl('button', { cls: 'wb-date-confirm mod-cta', attr: { type: 'button' }, text: '确定' }); confirmBtn.onclick = (event) => { event.stopPropagation(); commit(selected ?? new Date()); }; }
		};
		build();
		this.registerChoiceMenuDismiss(pop, anchor);
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

	private formatNumber(value: string, field: FieldSchema): string {
		const format = field.numberFormat ?? 'raw';
		if (format === 'raw') return value;
		if (!value.trim()) return '';
		const numeric = Number(value.replace(/[,，\s]/g, ''));
		if (!Number.isFinite(numeric)) return value;
		const percent = format === 'percent' || format === 'percent2';
		const decimals = format === 'integer' || format === 'percent' ? 0 : format === 'percent2' ? 2 : Number(format.slice(1));
		const scaled = percent ? numeric * 100 : numeric;
		const formatted = scaled.toLocaleString('zh-CN', {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
			useGrouping: field.numberUseThousands ?? false,
		});
		return percent ? `${formatted}%` : formatted;
	}

	private parseDate(raw: string): Date | null {
		const trimmed = raw.trim(); if (!trimmed) return null;
		const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2}))?/.exec(trimmed);
		if (match) { const [, y, mo, d, hh, mm] = match; return new Date(Number(y), Number(mo) - 1, Number(d), Number(hh ?? '0'), Number(mm ?? '0')); }
		const fallback = new Date(trimmed); return Number.isNaN(fallback.getTime()) ? null : fallback;
	}

	private formatDate(raw: string, format: DateFormat): string {
		const date = this.parseDate(raw); if (!date) return '';
		const pad = (value: number) => String(value).padStart(2, '0');
		const y = date.getFullYear(), mo = date.getMonth() + 1, d = date.getDate();
		const hh = pad(date.getHours()), mm = pad(date.getMinutes());
		const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
		switch (format) {
			case 'cn': return `${y}年${mo}月${d}日`;
			case 'slash': return `${y}/${mo}/${d}`;
			case 'md-cn': return `${mo}月${d}日`;
			case 'cn-week': return `${y}年${mo}月${d}日 ${weekday}`;
			case 'cn-time': return `${y}年${mo}月${d}日 ${hh}:${mm}`;
			case 'iso-time': return `${y}-${pad(mo)}-${pad(d)} ${hh}:${mm}`;
			case 'us': return `${mo}/${d}/${y}`;
			case 'eu': return `${d}/${mo}/${y}`;
			default: return `${y}-${pad(mo)}-${pad(d)}`;
		}
	}

	private toDateInputValue(stored: string, hasTime: boolean): string {
		const parsed = this.parseDate(stored); if (!parsed) return '';
		const pad = (value: number) => String(value).padStart(2, '0');
		const base = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
		return hasTime ? `${base}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : base;
	}

	private cellDisplayText(field: FieldSchema, raw: string): string {
		const value = raw ?? '';
		switch (field.type) {
			case 'date': return this.formatDate(value, field.dateFormat ?? 'iso');
			case 'currency': return this.formatCurrency(value, field);
			case 'number': return this.formatNumber(value, field);
			case 'checkbox': return ['true', '1', '是', '✓'].includes(value.toLocaleLowerCase()) ? '✓' : '';
			case 'attachment': return value.trim() ? this.indexDisplayName(value) : '';
			case 'link': { const link = this.parseExternalLink(value); return link.text || link.url; }
			default: return value;
		}
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
			const statCell = add.createEl('td', { cls: 'wb-stat-cell' });
			if (field.frozen) { statCell.addClass('is-frozen-column'); statCell.style.left = `${frozenLeft}px`; frozenLeft += field.width; }
			const mode = this.meta.statistics[field.id] ?? 'none'; const stat = statCell.createEl('button', { cls: `wb-column-stat${mode === 'none' ? '' : ' has-stat'}`, attr: { 'aria-label': `${field.name}统计` } });
			stat.createSpan({ text: mode === 'none' ? '统计' : `${this.statisticLabel(mode)} ${this.statisticValue(column, mode)}` });
			stat.onclick = (event) => { event.stopPropagation(); this.openStatisticMenu(stat, column); };
		});
		add.createEl('td', { cls: 'wb-add-field-spacer' });
	}

	private getVisibleRows(): VisibleRow[] {
		const result = this.rows.map((row, index) => ({ row, index })).filter(({ row }) => this.meta.filters.every((rule) => this.matches(row[rule.column] ?? '', rule)));
		if (this.meta.sorts.length) result.sort((left, right) => {
			for (const rule of this.meta.sorts) {
				const comparison = this.compareValues(left.row[rule.column] ?? '', right.row[rule.column] ?? '', this.meta.fields[rule.column]);
				if (comparison) return comparison * (rule.direction === 'asc' ? 1 : -1);
			}
			return left.index - right.index;
		});
		return result;
	}
	private compareValues(left: string, right: string, field?: FieldSchema): number {
		if (field?.type === 'number' || field?.type === 'currency' || field?.type === 'date') {
			const numeric = (value: string): number => !value.trim() ? NaN : field.type === 'date'
				? this.parseDate(value)?.getTime() ?? NaN : Number(value.replace(/[,，\s¥$€£]/g, ''));
			const a = numeric(left), b = numeric(right);
			if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
			if (Number.isFinite(a)) return -1;
			if (Number.isFinite(b)) return 1;
		}
		return left.localeCompare(right, 'zh-CN', { numeric: true });
	}
	private getDisplayedRows(): number[] {
		if (this.displayedRows) return this.displayedRows;
		const visible = this.getVisibleRows();
		const blanks = Array.from({ length: Math.max(0, 7 - visible.length) }, (_, offset) => this.rows.length + offset);
		if (!this.meta.groups.length) return this.displayedRows = [...visible.map(item => item.index), ...blanks];
		const column = this.meta.groups[0]!.column;
		const groups = new Map<string, number[]>();
		visible.forEach(item => { const key = item.row[column]?.trim() || '(空)'; const bucket = groups.get(key) ?? []; bucket.push(item.index); groups.set(key, bucket); });
		if (blanks.length) groups.set('(空)', [...(groups.get('(空)') ?? []), ...blanks]);
		return this.displayedRows = [...groups].flatMap(([key, rows]) => this.collapsedGroups.has(key) ? [] : rows);
	}
	private selectedRows(): number[] {
		if (!this.selection) return [];
		const visible = this.getDisplayedRows();
		const { startRow: start, endRow: end } = this.selection;
		if (this.selectedRowCache?.order === visible && this.selectedRowCache.start === start && this.selectedRowCache.end === end) return this.selectedRowCache.rows;
		const a = visible.indexOf(start), b = visible.indexOf(end);
		const rows = a < 0 || b < 0 ? [] : visible.slice(Math.min(a, b), Math.max(a, b) + 1);
		this.selectedRowCache = { order: visible, start, end, rows, members: new Set(rows) };
		return rows;
	}
	private selectedColumns(): number[] {
		if (!this.selection) return [];
		const { startColumn, endColumn } = this.selection;
		return this.meta.fields.flatMap((field, index) => field.visible && index >= Math.min(startColumn, endColumn) && index <= Math.max(startColumn, endColumn) ? [index] : []);
	}
	private matches(value: string, rule: FilterRule | FillRule): boolean { const source = value.toLocaleLowerCase(); const target = rule.value.toLocaleLowerCase(); switch (rule.operator) { case 'all': return true; case 'eq': return source === target; case 'neq': return source !== target; case 'contains': return source.includes(target); case 'not-contains': return !source.includes(target); case 'empty': return value.trim() === ''; case 'not-empty': return value.trim() !== ''; } }
	private getFill(row: string[], column: number): FillRule | undefined { return this.meta.fills.find((rule) => rule.column === column && this.matches(row[column] ?? '', rule)); }

	private handleCellKey(event: KeyboardEvent, row: number, column: number) {
		if (event.isComposing) return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') { event.preventDefault(); void navigator.clipboard.writeText(this.selectionText()); return; }
		if (!['Enter', 'Tab', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
		event.preventDefault();
		const rows = this.getDisplayedRows(), columns = this.meta.fields.flatMap((field, index) => field.visible ? [index] : []);
		let r = rows.indexOf(row), c = columns.indexOf(column);
		if (r < 0 || c < 0) return;
		if (event.key === 'Enter' || event.key === 'ArrowDown') r += 1;
		if (event.key === 'ArrowUp') r -= 1;
		if (event.key === 'Tab') c += event.shiftKey ? -1 : 1;
		if (c >= columns.length) { c = 0; r += 1; }
		if (c < 0) { c = columns.length - 1; r -= 1; }
		// Navigation alone never changes file contents, including blank placeholder rows.
		this.focusCell(rows[Math.max(0, Math.min(rows.length - 1, r))]!, columns[c]!);
	}
	private handlePaste(event: ClipboardEvent, startRow: number, startColumn: number) {
		const text = event.clipboardData?.getData('text/plain');
		if (!text || (!text.includes('\t') && !/[\r\n]/.test(text))) return;
		event.preventDefault();
		const targets = this.getDisplayedRows().slice();
		const first = targets.indexOf(startRow);
		if (first < 0) return;
		const columns = this.meta.fields.flatMap((field, index) => field.visible && index >= startColumn ? [index] : []);
		this.pushHistory();
		parseCsv(text, '\t').rows.forEach((cells, offset) => {
			const row = targets[first + offset] ?? this.rows.length;
			cells.forEach((value, index) => { const column = columns[index]; if (column !== undefined) this.setCell(row, column, value); });
		});
		this.scheduleSave(); this.render();
	}

	private addRow() { this.pushHistory(); this.rows.push(this.createEmptyRow()); this.scheduleSave(); this.render(); this.focusCell(this.rows.length - 1, 0); }
	private createEmptyRow() { return Array.from({ length: this.headers.length }, () => ''); }
	private setCell(row: number, column: number, value: string) { while (this.rows.length <= row) this.rows.push(this.createEmptyRow()); if (this.rows[row]) this.rows[row][column] = value; this.setStatus('未保存'); }
	private focusCell(row: number, column: number) { window.setTimeout(() => { const container = this.contentEl.querySelector<HTMLElement>(`td[data-row="${row}"][data-column="${column}"]`); const target = container?.matches('input, button') ? container : container?.querySelector<HTMLElement>('input, button'); target?.focus(); if (target instanceof HTMLInputElement) target.select(); }, 0); }
	private visibleColumnCount() { return this.meta.fields.filter((field) => field.visible).length; }
	private isSelected(row: number, column: number) { this.selectedRows(); return !!this.selection && !!this.selectedRowCache?.members.has(row) && this.selectedColumns().includes(column); }
	private isAllSelected() {
		return this.selectedRows().length > 0 && this.selectedRows().length === this.getDisplayedRows().length && this.selectedColumns().length === this.visibleColumnCount();
	}
	private selectionBounds() {
		const rows = this.selectedRows(), columns = this.selectedColumns();
		if (!rows.length || !columns.length) return null;
		return { minRow: rows[0]!, maxRow: rows[rows.length - 1]!, minColumn: columns[0]!, maxColumn: columns[columns.length - 1]!, leftColumn: columns[0]!, rightColumn: columns[columns.length - 1]!, isRange: rows.length > 1 || columns.length > 1 };
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
		const fullRow = !!bounds && this.selectedRowCache?.members.has(row) && bounds.minColumn <= (visible[0] ?? 0) && bounds.maxColumn >= (visible[visible.length - 1] ?? 0);
		['is-selected', 'is-selection-top', 'is-selection-bottom', 'is-selection-left', 'is-selection-range'].forEach((name) => cell.removeClass(name));
		if (!fullRow || !bounds) return;
		cell.addClass('is-selected', 'is-selection-left'); cell.toggleClass('is-selection-top', row === bounds.minRow); cell.toggleClass('is-selection-bottom', row === bounds.maxRow); cell.toggleClass('is-selection-range', bounds.isRange);
	}
	private selectedCoordinates() {
		return this.selectedRows().filter(row => row < this.rows.length).flatMap(row => this.selectedColumns().map(column => ({ row, column })));
	}
	private selectionText() {
		const rows = this.selectedRows().filter(row => row < this.rows.length);
		return serializeCsv({ rows: rows.map(row => this.selectedColumns().map(column => this.rows[row]?.[column] ?? '')), delimiter: '\t', eol: '\n', bom: false, trailingEol: false });
	}
	private applySelectionClasses() {
		this.contentEl.querySelectorAll<HTMLElement>('td[data-row][data-column]').forEach((cell) => this.applySelectionClassesToCell(cell, Number(cell.dataset.row), Number(cell.dataset.column)));
		this.contentEl.querySelectorAll<HTMLElement>('th.wb-row-number[data-row]').forEach((cell) => this.applyRowHeadSelectionClasses(cell, Number(cell.dataset.row)));
		this.contentEl.querySelectorAll<HTMLElement>('tr[data-row]').forEach((row) => row.toggleClass('is-active-row', Number(row.dataset.row) === this.selection?.startRow));
	}

	private startResize(event: MouseEvent, column: number) {
		event.preventDefault(); event.stopPropagation();
		const field = this.meta.fields[column]; if (!field) return;
		const startX = event.clientX; const startWidth = field.width;
		const doc = this.containerEl.ownerDocument;
		const col = this.contentEl.querySelector<HTMLElement>(`col[data-column="${column}"]`);
		const tip = this.contentEl.createDiv('wb-resize-tip');
		const moveTip = (width: number, clientX: number, clientY: number) => { const rootRect = this.contentEl.getBoundingClientRect(); tip.setText(`列宽 ${width} 像素`); tip.style.left = `${Math.min(clientX - rootRect.left + 12, rootRect.width - tip.offsetWidth - 8)}px`; tip.style.top = `${clientY - rootRect.top - 34}px`; };
		doc.body.addClass('wb-resizing');
		moveTip(startWidth, startX, event.clientY);
		const move = (moveEvent: MouseEvent) => {
			const width = Math.max(48, Math.min(720, startWidth + moveEvent.clientX - startX)); field.width = width;
			if (col) col.style.width = `${width}px`;
			moveTip(width, moveEvent.clientX, moveEvent.clientY);
		};
		const up = () => { doc.removeEventListener('mousemove', move); doc.removeEventListener('mouseup', up); doc.body.removeClass('wb-resizing'); tip.remove(); this.scheduleMetaSave(); this.renderGridOnly(); };
		doc.addEventListener('mousemove', move); doc.addEventListener('mouseup', up);
	}

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
		{ label: '分组', icon: 'rows-3', action: () => { this.meta.groups = [{ id: uid('group'), column }]; this.panel = 'group'; this.scheduleMetaSave(); this.render(); } },
		{ label: '排序', icon: 'arrow-up-down', action: () => { this.meta.sorts.push({ id: uid('sort'), column, direction: 'asc' }); this.panel = 'sort'; this.scheduleMetaSave(); this.render(); } },
		{ label: '填色', icon: 'paint-bucket', action: () => { this.meta.fills.push({ id: uid('fill'), column, operator: 'all', value: '', color: OPTION_COLORS[0]!, wholeRow: false }); this.panel = 'fill'; this.scheduleMetaSave(); this.render(); } }, { divider: true },
		{ label: '调整至合适列宽', icon: 'move-horizontal', action: () => this.fitColumn(column) }, { label: '冻结到此列', icon: 'snowflake', action: () => { this.meta.fields.forEach((field, index) => { field.frozen = index <= column; }); this.scheduleMetaSave(); this.render(); } }, { label: '隐藏字段', icon: 'eye-off', action: () => { const field = this.meta.fields[column]; if (field) field.visible = false; this.scheduleMetaSave(); this.render(); } }, { divider: true },
		{ label: '删除字段', icon: 'trash-2', danger: true, action: () => this.deleteColumn(column) },
	]; }
	private rowMenuItems(row: number): MenuItem[] { return [ { label: '创建副本', icon: 'files', action: () => this.duplicateRow(row) }, { label: '在上方插入', icon: 'arrow-up', quantityAction: (count) => this.insertRows(row, count) }, { label: '在下方插入', icon: 'arrow-down', quantityAction: (count) => this.insertRows(row + 1, count) }, ...(Platform.isMobile && row < this.rows.length ? [{ label: '上移一行', icon: 'chevron-up', action: () => this.moveRow(row, row - 1) }, { label: '下移一行', icon: 'chevron-down', action: () => this.moveRow(row, row + 1) }] : []), { label: '删除', icon: 'trash-2', danger: true, action: () => this.deleteRows() } ]; }
	private cellMenuItems(row: number, column: number): MenuItem[] { return [ { label: '只看已填写', icon: 'filter', action: () => { this.meta.filters.push({ id: uid('filter'), column, operator: 'not-empty', value: '' }); this.scheduleMetaSave(); this.render(); } }, { label: '只看未填写', icon: 'filter', action: () => { this.meta.filters.push({ id: uid('filter'), column, operator: 'empty', value: '' }); this.scheduleMetaSave(); this.render(); } }, { divider: true }, ...this.rowMenuItems(row) ]; }

	private moveRow(from: number, to: number) {
		if (this.meta.sorts.length) { new Notice('清除排序后才能手动拖拽调整行顺序'); return; }
		const maxIndex = this.rows.length - 1; if (maxIndex < 0) return;
		const source = Math.max(0, Math.min(maxIndex, from)); const target = Math.max(0, Math.min(maxIndex, to));
		if (source === target) return;
		this.pushHistory(); const [moved] = this.rows.splice(source, 1); if (moved) this.rows.splice(target, 0, moved);
		this.selection = { startRow: target, endRow: target, startColumn: 0, endColumn: Math.max(0, this.headers.length - 1) }; this.scheduleSave(); this.render();
	}
	private insertRows(index: number, count: number) { this.pushHistory(); this.rows.splice(index, 0, ...Array.from({ length: count }, () => this.createEmptyRow())); this.scheduleSave(); this.render(); }
	private duplicateRow(index: number) { this.pushHistory(); this.rows.splice(index + 1, 0, [...(this.rows[index] ?? this.createEmptyRow())]); this.scheduleSave(); this.render(); }
	private deleteRows() { this.pushHistory(); const rows = [...new Set(this.selectedCoordinates().map((item) => item.row))].sort((a, b) => b - a); rows.forEach((row) => this.rows.splice(row, 1)); this.selection = null; this.scheduleSave(); this.render(); }
	private insertColumn(index: number) { this.pushHistory(); const field = this.newField(`字段 ${index + 1}`, index); this.headers.splice(index, 0, field.name); this.meta.fields.splice(index, 0, field); this.rows.forEach((row) => row.splice(index, 0, '')); this.shiftRuleColumns(index, 1); this.scheduleSave(); this.scheduleMetaSave(); this.render(); }
	private duplicateColumn(index: number) { this.pushHistory(); const source = this.meta.fields[index]; if (!source) return; const copy = { ...source, id: uid('field'), name: `${source.name} 副本`, options: source.options.map((option) => ({ ...option, id: uid('option') })) }; this.headers.splice(index + 1, 0, copy.name); this.meta.fields.splice(index + 1, 0, copy); this.rows.forEach((row) => row.splice(index + 1, 0, row[index] ?? '')); this.shiftRuleColumns(index + 1, 1); this.scheduleSave(); this.scheduleMetaSave(); this.render(); }
	private deleteColumn(index: number) { if (this.headers.length <= 1) { new Notice('至少保留一个字段'); return; } this.pushHistory(); const removed = this.meta.fields[index]; this.headers.splice(index, 1); this.meta.fields.splice(index, 1); this.rows.forEach((row) => row.splice(index, 1)); if (removed) delete this.meta.statistics[removed.id]; this.meta.filters = this.adjustRulesAfterDelete(this.meta.filters, index); this.meta.sorts = this.adjustRulesAfterDelete(this.meta.sorts, index); this.meta.groups = this.adjustRulesAfterDelete(this.meta.groups, index); this.meta.fills = this.adjustRulesAfterDelete(this.meta.fills, index); this.scheduleSave(); this.scheduleMetaSave(); this.render(); }
	private shiftRuleColumns(index: number, delta: number) { [...this.meta.filters, ...this.meta.sorts, ...this.meta.groups, ...this.meta.fills].forEach((rule) => { if (rule.column >= index) rule.column += delta; }); }
	private adjustRulesAfterDelete<T extends { column: number }>(rules: T[], index: number): T[] { return rules.filter((rule) => rule.column !== index).map((rule) => ({ ...rule, column: rule.column > index ? rule.column - 1 : rule.column })); }
	private displayWidth(text: string): number { let width = 0; for (const char of text) { const code = char.codePointAt(0) ?? 0; width += code >= 0x1100 && !(code >= 0xff61 && code <= 0xff9f) ? 2 : 1; } return width; }
	private fitColumn(index: number) { const field = this.meta.fields[index]; if (!field) return; const max = Math.max(this.displayWidth(field.name), ...this.rows.map((row) => this.displayWidth(row[index] ?? ''))); field.width = Math.max(100, Math.min(420, 56 + max * 9)); this.scheduleMetaSave(); this.render(); }
}
