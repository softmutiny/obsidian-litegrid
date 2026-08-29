import { setIcon, TextFileView, WorkspaceLeaf } from 'obsidian';

export const HTML_VIEW_TYPE = 'litegrid-html-view';
type EditorMode = 'visual' | 'source';

export class LiteGridHtmlView extends TextFileView {
	private source = '';
	private mode: EditorMode = 'visual';
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
		this.contentEl.empty();
	}

	private render() {
		const root = this.contentEl;
		root.empty();
		root.addClass('wb-file-view', 'wb-html-view');
		const page = root.createDiv('wb-html-page');
		const header = page.createDiv('wb-html-header');
		header.createEl('h1', { text: this.file?.basename ?? '未命名页面' });
		const toolbar = header.createDiv('wb-toolbar');
		if (this.mode === 'visual') {
			this.addToolbarButton(toolbar, '加粗', 'bold', () => this.format('bold'));
			this.addToolbarButton(toolbar, '斜体', 'italic', () => this.format('italic'));
			this.addToolbarButton(toolbar, '下划线', 'underline', () => this.format('underline'));
			this.addToolbarButton(toolbar, '项目符号', 'list', () => this.format('insertUnorderedList'));
			this.addToolbarButton(toolbar, '源码', 'code-2', () => this.switchMode('source'));
		} else {
			this.addToolbarButton(toolbar, '返回可视化编辑', 'panel-top-open', () => this.switchMode('visual'));
		}
		this.statusEl = toolbar.createSpan('wb-save-status');
		this.statusEl.setText('已保存');

		const stage = page.createDiv('wb-html-stage');
		if (this.mode === 'visual') this.renderVisual(stage);
		else this.renderSource(stage);
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
		document.addEventListener('input', () => this.scheduleFrameRead());
		document.addEventListener('keydown', (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
				event.preventDefault();
				this.readFrame();
				this.scheduleSave();
			}
		});
	}

	private buildEditableDocument(): string {
		const baseUrl = this.getBaseUrl();
		const base = `<base data-wb-editor-base href="${this.escapeAttribute(baseUrl)}">`;
		const safeSource = this.source.replace(
			/(<meta\b[^>]*?)http-equiv\s*=\s*(["'])Content-Security-Policy\2/gi,
			'$1data-wb-csp=$2Content-Security-Policy$2',
		);
		if (!this.isFullDocument) {
			return `<!DOCTYPE html><html><head>${base}</head><body>${safeSource}</body></html>`;
		}
		if (/<head[\s>]/i.test(safeSource)) {
			return safeSource.replace(/<head([^>]*)>/i, `<head$1>${base}`);
		}
		return safeSource.replace(/<html([^>]*)>/i, `<html$1><head>${base}</head>`);
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
		if (this.mode === 'visual') this.readFrame();
		this.mode = mode;
		this.render();
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

	private addToolbarButton(container: HTMLElement, label: string, iconName: string, onClick: () => void) {
		const button = container.createEl('button', { cls: 'wb-toolbar-button' });
		setIcon(button.createSpan(), iconName);
		button.createSpan({ text: label });
		button.addEventListener('click', onClick);
	}
}
