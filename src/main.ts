import { Notice, Plugin } from 'obsidian';
import { registerNewCsvMenu } from './commands/new-csv';
import { CSV_VIEW_TYPE, LiteGridCsvView } from './ui/csv-view';
import { HTML_VIEW_TYPE, LiteGridHtmlView } from './ui/html-view';
import type { LiteGridPluginData, TableMeta, TableMetaHost } from './types';

export default class LiteGridPlugin extends Plugin implements TableMetaHost {
	private pluginData: LiteGridPluginData = { tables: {} };

	async onload() {
		this.pluginData = Object.assign({ tables: {} }, await this.loadData() as Partial<LiteGridPluginData>);
		this.pluginData.tables ??= {};
		this.registerView(CSV_VIEW_TYPE, (leaf) => new LiteGridCsvView(leaf, this));
		this.registerView(HTML_VIEW_TYPE, (leaf) => new LiteGridHtmlView(leaf));
		try {
			this.registerExtensions(['csv'], CSV_VIEW_TYPE);
		} catch (error) {
			console.warn('轻格无法接管 CSV；可能已被其他插件占用。', error);
			new Notice('轻格已加载，但 CSV 正被其他插件占用。');
		}
		try {
			this.registerExtensions(['html', 'htm'], HTML_VIEW_TYPE);
		} catch (error) {
			console.warn('轻格无法接管 HTML；可能已被其他插件占用。', error);
			new Notice('轻格已加载，但 HTML 正被其他插件占用。请先关闭旧的 HTML 编辑器。');
		}
		registerNewCsvMenu(this);
		// 表格设置按路径存；在文件列表里改名、移动（包括整个文件夹）时跟着搬过去
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.moveTableMeta(oldPath, file.path); }));
	}

	getTableMeta(path: string): TableMeta | undefined {
		return this.pluginData.tables[path];
	}

	async saveTableMeta(path: string, meta: TableMeta): Promise<void> {
		this.pluginData.tables[path] = meta;
		await this.saveData(this.pluginData);
	}

	async renameTableMeta(oldPath: string, newPath: string, meta: TableMeta): Promise<void> {
		delete this.pluginData.tables[oldPath];
		this.pluginData.tables[newPath] = meta;
		await this.saveData(this.pluginData);
	}

	async moveTableMeta(oldPath: string, newPath: string): Promise<void> {
		const tables = this.pluginData.tables;
		let moved = false;
		for (const path of Object.keys(tables)) {
			const suffix = path === oldPath ? '' : path.startsWith(`${oldPath}/`) ? path.slice(oldPath.length) : null;
			const meta = tables[path];
			if (suffix === null || !meta) continue;
			delete tables[path];
			tables[newPath + suffix] = meta;
			moved = true;
		}
		if (moved) await this.saveData(this.pluginData);
	}

}
