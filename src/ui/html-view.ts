import { setIcon, TextFileView, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';

export const HTML_VIEW_TYPE = 'litegrid-html-view';
type EditorMode = 'preview' | 'visual' | 'source';

// 预览页的脚本在隔离沙盒里运行：不给同源权限，拿不到 Obsidian；网络请求也不许走 app: / file: 读本机文件
const PREVIEW_CSP = '<meta http-equiv="Content-Security-Policy" content="connect-src http: https: ws: wss: data: blob:">';
// <base> 会让 href="#..." 指向资料库文件夹，这里改回在当前页内滚动
const PREVIEW_ANCHOR_SCRIPT = `<script data-wb-preview>document.addEventListener('click', function (event) {
	if (event.defaultPrevented || !(event.target instanceof Element)) return;
	var link = event.target.closest('a[href^="#"]');
	if (!link) return;
	event.preventDefault();
	var id = link.getAttribute('href').slice(1);
	try { id = decodeURIComponent(id); } catch (error) {}
	var target = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null;
	if (target) target.scrollIntoView();
	else if (!id || id.toLowerCase() === 'top') window.scrollTo(0, 0);
});</script>`;

function isEditorMode(value: unknown): value is EditorMode {
	return value === 'preview' || value === 'visual' || value === 'source';
}

export class LiteGridHtmlView extends TextFileView {
	private source = '';
	private mode: EditorMode = 'preview';
	private renderedMode: EditorMode | null = null;
	private iframe: HTMLIFrameElement | null = null;
	private sourceEditor: HTMLTextAreaElement | null = null;
	private saveTimer: number | null = null;
	private inputTimer: number | null = null;
	private statusEl: HTMLElement | null = null;
	private isFullDocument = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() { return HTML_VIEW_TYPE; }
	getDisplayText() { return this.file?.basename ?? 'HTML 页面'; }
	getIcon() { return 'file-code-2'; }

	getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const mode = (state as { mode?: unknown } | null)?.mode;
		if (isEditorMode(mode)) this.mode = mode;
		await super.setState(state, result);
		if (this.file && this.renderedMode !== this.mode) this.render();
	}

	setViewData(data: string, clear: boolean) {
		if (clear) this.clear();
		this.data = data;
		this.source = data;
		this.isFullDocument = /<!doctype|<html[\s>]/i.test(data);
		this.render();
	}

	getViewData(): string { return this.source; }

	clear() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		if (this.inputTimer !== null) window.clearTimeout(this.inputTimer);
		this.saveTimer = null;
		this.inputTimer = null;
		this.iframe = null;
		this.sourceEditor = null;
		this.renderedMode = null;
		this.contentEl.empty();
	}

	private render() {
		const root = this.contentEl;
		root.empty();
		root.addClass('wb-file-view', 'wb-html-view');
		this.renderedMode = this.mode;
		this.iframe = null;
		this.sourceEditor = null;
		const page = root.createDiv('wb-html-page');
		const header = page.createDiv('wb-html-header');
		header.createEl('h1', { text: this.file?.basename ?? '未命名页面' });
		const toolbar = header.createDiv('wb-toolbar');
		this.addModeButton(toolbar, '预览', 'eye', 'preview');
		this.addModeButton(toolbar, '可视化编辑', 'panel-top-open', 'visual');
		this.addModeButton(toolbar, '源码', 'code-2', 'source');
		if (this.mode === 'visual') {
			toolbar.createDiv('wb-toolbar-divider');
			this.addToolbarButton(toolbar, '加粗', 'bold', () => this.format('bold'));
			this.addToolbarButton(toolbar, '斜体', 'italic', () => this.format('italic'));
			this.addToolbarButton(toolbar, '下划线', 'underline', () => this.format('underline'));
			this.addToolbarButton(toolbar, '项目符号', 'list', () => this.format('insertUnorderedList'));
		}
		this.statusEl = toolbar.createSpan('wb-save-status');
		this.statusEl.setText(this.mode === 'preview' ? '只读预览' : '已保存');

		const stage = page.createDiv('wb-html-stage');
		if (this.mode === 'preview') this.renderPreview(stage);
		else if (this.mode === 'visual') this.renderVisual(stage);
		else this.renderSource(stage);
	}

	private renderPreview(stage: HTMLElement) {
		const iframe = stage.createEl('iframe', {
			cls: 'wb-html-frame',
			attr: {
				sandbox: 'allow-scripts allow-forms',
				referrerpolicy: 'no-referrer',
				title: 'HTML 预览',
			},
		});
		this.iframe = iframe;
		iframe.srcdoc = this.buildPreviewDocument();
	}

	private renderVisual(stage: HTMLElement) {
		const iframe = stage.createEl('iframe', {
			cls: 'wb-html-frame',
			attr: {
				sandbox: 'allow-same-origin',
				referrerpolicy: 'no-referrer',
				title: 'HTML 可视化编辑器',
			},
		});
		this.iframe = iframe;
		iframe.addEventListener('load', () => this.prepareFrame());
		iframe.srcdoc = this.buildEditableDocument();
	}

	private renderSource(stage: HTMLElement) {
		const editor = stage.createEl('textarea', {
			cls: 'wb-html-source',
			attr: { spellcheck: 'false', 'aria-label': 'HTML 源码' },
		});
		editor.value = this.source;
		this.sourceEditor = editor;
		editor.addEventListener('input', () => {
			this.source = editor.value;
			this.isFullDocument = /<!doctype|<html[\s>]/i.test(this.source);
			this.scheduleSave();
		});
	}

	private prepareFrame() {
		const document = this.iframe?.contentDocument;
		if (!document?.body) return;
		document.body.contentEditable = 'true';
		document.body.spellcheck = true;
		document.addEventListener('input', (event) => this.handleFrameInput(event));
		document.addEventListener('keydown', (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
				event.preventDefault();
				this.readFrame();
				this.scheduleSave();
			}
		});
	}

	// 页面自带的输入框、下拉框里打字不算改页面，不触发保存
	private handleFrameInput(event: Event) {
		const tag = (event.target as Element | null)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		this.scheduleFrameRead();
	}

	private buildPreviewDocument(): string {
		const base = `<base data-wb-editor-base href="${this.escapeAttribute(this.getBaseUrl())}">`;
		return this.injectHead(this.source, base + PREVIEW_CSP + PREVIEW_ANCHOR_SCRIPT);
	}

	private buildEditableDocument(): string {
		const base = `<base data-wb-editor-base href="${this.escapeAttribute(this.getBaseUrl())}">`;
		const safeSource = this.source.replace(
			/(<meta\b[^>]*?)http-equiv\s*=\s*(["'])Content-Security-Policy\2/gi,
			'$1data-wb-csp=$2Content-Security-Policy$2',
		);
		return this.injectHead(safeSource, base);
	}

	private injectHead(source: string, head: string): string {
		if (!this.isFullDocument) {
			return `<!DOCTYPE html><html><head>${head}</head><body>${source}</body></html>`;
		}
		if (/<head[\s>]/i.test(source)) {
			return source.replace(/<head([^>]*)>/i, (_match, attrs: string) => `<head${attrs}>${head}`);
		}
		return source.replace(/<html([^>]*)>/i, (_match, attrs: string) => `<html${attrs}><head>${head}</head>`);
	}

	private readFrame() {
		const document = this.iframe?.contentDocument;
		if (!document?.documentElement) return;
		const clone = document.documentElement.cloneNode(true) as HTMLElement;
		clone.querySelector('base[data-wb-editor-base]')?.remove();
		const body = clone.querySelector('body');
		body?.removeAttribute('contenteditable');
		body?.removeAttribute('spellcheck');
		clone.querySelectorAll('meta[data-wb-csp]').forEach((meta) => {
			meta.setAttribute('http-equiv', meta.getAttribute('data-wb-csp') ?? 'Content-Security-Policy');
			meta.removeAttribute('data-wb-csp');
		});
		this.source = this.isFullDocument
			? `<!DOCTYPE html>\n${clone.outerHTML}`
			: body?.innerHTML ?? '';
	}

	private scheduleFrameRead() {
		this.setStatus('未保存');
		if (this.inputTimer !== null) window.clearTimeout(this.inputTimer);
		this.inputTimer = window.setTimeout(() => {
			this.inputTimer = null;
			this.readFrame();
			this.scheduleSave();
		}, 300);
	}

	// 只有还没读回的改动才需要读；没改过就不动源码，免得切换模式时把文件重新排版一遍
	private flushFrame() {
		if (this.inputTimer === null) return;
		window.clearTimeout(this.inputTimer);
		this.inputTimer = null;
		this.readFrame();
		this.scheduleSave();
	}

	private scheduleSave() {
		this.data = this.source;
		this.setStatus('正在保存…');
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save().then(() => this.setStatus('已保存'));
		}, 450);
	}

	private switchMode(mode: EditorMode) {
		if (mode === this.mode) return;
		if (this.mode === 'visual') this.flushFrame();
		this.mode = mode;
		this.render();
		this.app.workspace.requestSaveLayout();
	}

	private format(command: string) {
		const document = this.iframe?.contentDocument;
		if (document) {
			const execute = Reflect.get(document, 'execCommand') as
				((name: string, showUi?: boolean) => boolean) | undefined;
			execute?.call(document, command, false);
		}
		this.scheduleFrameRead();
		this.iframe?.contentWindow?.focus();
	}

	private getBaseUrl(): string {
		if (!this.file) return '';
		try {
			return new URL('.', this.app.vault.getResourcePath(this.file)).toString();
		} catch {
			return this.app.vault.getResourcePath(this.file);
		}
	}

	private escapeAttribute(value: string): string {
		return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
	}

	private setStatus(text: string) { this.statusEl?.setText(text); }

	private addModeButton(container: HTMLElement, label: string, iconName: string, mode: EditorMode) {
		const button = this.addToolbarButton(container, label, iconName, () => this.switchMode(mode));
		button.toggleClass('is-active', this.mode === mode);
		button.setAttribute('aria-pressed', String(this.mode === mode));
	}

	private addToolbarButton(container: HTMLElement, label: string, iconName: string, onClick: () => void) {
		const button = container.createEl('button', { cls: 'wb-toolbar-button' });
		setIcon(button.createSpan(), iconName);
		button.createSpan({ text: label });
		button.addEventListener('click', onClick);
		return button;
	}
}
