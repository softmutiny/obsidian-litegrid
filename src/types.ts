export type FieldType =
	| 'text'
	| 'number'
	| 'currency'
	| 'single'
	| 'multi'
	| 'date'
	| 'person'
	| 'checkbox'
	| 'link'
	| 'email'
	| 'phone'
	| 'image'
	| 'attachment';

export type RowHeight = 'default' | 'medium' | 'spacious' | 'extra';
export type ColumnStatistic = 'count' | 'empty' | 'filled' | 'unique' | 'empty-rate' | 'filled-rate' | 'unique-rate' | 'none';

export interface SelectOption {
	id: string;
	name: string;
	color: string;
}

export interface FieldSchema {
	id: string;
	name: string;
	type: FieldType;
	visible: boolean;
	width: number;
	options: SelectOption[];
	frozen?: boolean;
	currencyCode?: CurrencyCode;
	currencyDecimals?: number;
	currencyUseThousands?: boolean;
	numberFormat?: NumberFormat;
	numberUseThousands?: boolean;
	dateFormat?: DateFormat;
}

export type CurrencyCode = 'CNY' | 'USD' | 'EUR' | 'GBP' | 'JPY';
export type NumberFormat = 'raw' | 'integer' | 'd1' | 'd2' | 'd3' | 'd4' | 'percent' | 'percent2';
export type DateFormat = 'iso' | 'cn' | 'slash' | 'md-cn' | 'cn-week' | 'cn-time' | 'iso-time' | 'us' | 'eu';

export type RuleOperator = 'eq' | 'neq' | 'contains' | 'not-contains' | 'empty' | 'not-empty' | 'all';

export interface FilterRule {
	id: string;
	column: number;
	operator: RuleOperator;
	value: string;
}

export interface SortRule {
	id: string;
	column: number;
	direction: 'asc' | 'desc';
}

export interface GroupRule {
	id: string;
	column: number;
}

export interface FillRule extends FilterRule {
	color: string;
	wholeRow: boolean;
}

export interface TableMeta {
	fields: FieldSchema[];
	rowHeight: RowHeight;
	statistics: Record<string, ColumnStatistic>;
	filters: FilterRule[];
	sorts: SortRule[];
	groups: GroupRule[];
	fills: FillRule[];
}

export interface LiteGridPluginData {
	tables: Record<string, TableMeta>;
}

export interface TableMetaHost {
	getTableMeta(path: string): TableMeta | undefined;
	saveTableMeta(path: string, meta: TableMeta): Promise<void>;
	renameTableMeta(oldPath: string, newPath: string, meta: TableMeta): Promise<void>;
}

export const FIELD_TYPES: Array<{ value: FieldType; label: string; icon: string }> = [
	{ value: 'text', label: '文本', icon: 'square-a' },
	{ value: 'number', label: '数字', icon: '123' },
	{ value: 'currency', label: '货币', icon: 'circle-dollar-sign' },
	{ value: 'single', label: '单选', icon: 'circle-chevron-down' },
	{ value: 'multi', label: '多选', icon: 'list-checks' },
	{ value: 'date', label: '日期', icon: 'calendar-days' },
	{ value: 'checkbox', label: '复选框', icon: 'square-check-big' },
	{ value: 'link', label: '链接', icon: 'link-2' },
	{ value: 'email', label: '邮箱', icon: 'mail' },
	{ value: 'phone', label: '电话', icon: 'phone' },
	{ value: 'image', label: '图片', icon: 'image' },
	{ value: 'attachment', label: '索引', icon: 'paperclip' },
];

export const OPTION_COLORS = [
	'#dfe3e8', '#8f959f', '#cfd5da', '#c9d9fb', '#4f82ec', '#d9eefc', '#b7ddf6', '#3f9fe5',
	'#d9f2e2', '#b5e1c4', '#58b87b', '#f8dcdc', '#f2bcb9', '#d54a3c', '#fde7dd', '#f6cfa9', '#f08b18',
	'#fff3c4', '#ffe58f', '#f0c600', '#efd8fa', '#dfb4f1', '#9d3bc2', '#f8d4e6', '#f2bad8', '#cc3886',
];

export function uid(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
