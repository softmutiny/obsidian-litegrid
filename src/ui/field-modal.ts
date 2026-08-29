import { App, Modal, setIcon } from 'obsidian';

export interface FieldColumn {
	name: string;
	originalIndex: number | null;
}

export class FieldManagerModal extends Modal {
	private columns: FieldColumn[];

	constructor(
		app: App,
		headers: string[],
		private readonly onApply: (columns: FieldColumn[]) => void,
	) {
		super(app);
		this.columns = headers.map((name, originalIndex) => ({ name, originalIndex }));
	}

	onOpen() {
		this.modalEl.addClass('wb-field-modal');
		this.render();
	}

	private render() {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: '字段管理' });
		this.contentEl.createEl('p', {
			cls: 'wb-modal-hint',
			text: '重命名、增加或删除表格字段。',
		});
		const list = this.contentEl.createDiv('wb-field-list');

		this.columns.forEach((column, index) => {
			const row = list.createDiv('wb-field-row');
			row.createSpan({ cls: 'wb-field-type', text: 'A' });
			const input = row.createEl('input', {
				attr: { type: 'text', 'aria-label': `字段 ${index + 1}` },
				value: column.name,
			});
			input.addEventListener('input', () => {
				column.name = input.value;
			});
			const remove = row.createEl('button', {
				cls: 'wb-icon-button',
				attr: { 'aria-label': '删除字段' },
			});
			setIcon(remove, 'trash-2');
			remove.addEventListener('click', () => {
				if (this.columns.length <= 1) return;
				this.columns.splice(index, 1);
				this.render();
			});
		});

		const add = this.contentEl.createEl('button', {
			cls: 'wb-secondary-button',
			text: '添加字段',
		});
		setIcon(add, 'plus');
		add.addEventListener('click', () => {
			this.columns.push({ name: `字段 ${this.columns.length + 1}`, originalIndex: null });
			this.render();
		});

		const actions = this.contentEl.createDiv('wb-modal-actions');
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.close());
		const apply = actions.createEl('button', { cls: 'mod-cta', text: '应用' });
		apply.addEventListener('click', () => {
			this.onApply(this.columns.map((column, index) => ({
				...column,
				name: column.name.trim() || `字段 ${index + 1}`,
			})));
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
