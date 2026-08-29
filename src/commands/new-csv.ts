import { normalizePath, Notice, Plugin, TFolder } from 'obsidian';

function findAvailablePath(plugin: Plugin, folder: TFolder): string {
	const prefix = folder.isRoot() ? '' : `${folder.path}/`;
	let counter = 1;
	while (true) {
		const suffix = counter === 1 ? '' : ` ${counter}`;
		const path = normalizePath(`${prefix}未命名表格${suffix}.csv`);
		if (!plugin.app.vault.getAbstractFileByPath(path)) return path;
		counter += 1;
	}
}

export function registerNewCsvMenu(plugin: Plugin) {
	plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file) => {
		const folder = file instanceof TFolder ? file : file.parent;
		if (!folder) return;
		menu.addItem((item) => {
			item.setTitle('新建 CSV 表格')
				.setIcon('sheet')
				.onClick(async () => {
					try {
						const path = findAvailablePath(plugin, folder);
					const created = await plugin.app.vault.create(path, '标题,数字,单选\n');
						await plugin.app.workspace.getLeaf(false).openFile(created);
					} catch (error) {
						console.error('新建 CSV 表格失败。', error);
						new Notice('新建 CSV 表格失败，请检查文件夹权限。');
					}
				});
		});
	}));
}
