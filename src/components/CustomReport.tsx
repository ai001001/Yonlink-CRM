/**
 * 自定义报表的前端部件：字段目录、字段与值的显示、筛选值输入、运行结果（明细表格，或汇总表格与条形图/柱状图）。
 * Custom report widgets: the field catalogue, field and value labels, filter value inputs and run results (a detail
 * table, or a summary table with a bar or column chart).
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, DatePicker, Input, InputNumber, Select, Table, Typography } from 'antd';
import dayjs from 'dayjs';
import { ColumnChart, HBarChart } from '@/components/Charts';
import { RecordSelect } from '@/components/RecordSelect';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useOwners } from '@/lib/hooks';
import { pickOptions } from '@/lib/picklists';

export type Entity = 'LEAD' | 'ACCOUNT' | 'DEAL' | 'ACTIVITY';
export type FieldType = 'text' | 'enum' | 'number' | 'amount' | 'date' | 'owner' | 'boolean' | 'account' | 'territory';
export interface FieldDef {
  type: FieldType;
  label: MessageKey;
  prefix?: string;
  values?: string[];
  extensible?: boolean;
}
export interface Catalog {
  fields: Record<Entity, Record<string, FieldDef>>;
  ops: Record<FieldType, string[]>;
  groupable: FieldType[];
  measurable: FieldType[];
  sortable: FieldType[];
  limits: { summary: number; export: number; reports: number };
}
export interface Filter {
  field: string;
  op: string;
  value?: string | null;
}
export interface Measure {
  fn: 'SUM' | 'AVG' | 'MIN' | 'MAX';
  field: string;
}
export interface Definition {
  entity: Entity;
  columns: string[];
  filters: Filter[];
  groupBy: { field: string; unit?: 'month' | 'quarter' | 'year' | null } | null;
  measures: Measure[];
  chart: 'NONE' | 'BAR' | 'COLUMN';
  sort: { field: string; dir: 'asc' | 'desc' } | null;
}
export type Result =
  | { kind: 'detail'; columns: string[]; rows: { id: string; values: Record<string, unknown> }[]; total: number; page: number; pageSize: number }
  | { kind: 'summary'; groups: { key: string | null; name?: string | null; count: number; measures: (string | number | null)[] }[]; totals: { count: number; measures: (string | number | null)[] }; truncated: boolean; currency: string | null };

/** 不需要值的条件 / operators without a value */
export const NO_VALUE = new Set(['EMPTY', 'NOT_EMPTY', 'THIS_MONTH', 'THIS_YEAR', 'TRUE', 'FALSE']);

/**
 * 读取字段目录（打开页面时读取一次）。
 * Load the field catalogue once per page.
 */
export function useCatalog(): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    api<Catalog>('/api/custom-reports/fields')
      .then(setCatalog)
      .catch(() => setCatalog(null));
  }, []);
  return catalog;
}

/** 指标名称 / measure label */
export const measureLabel = (def: FieldDef | undefined, m: Measure) => `${t(`customReports.fn.${m.fn}` as MessageKey)} · ${def ? t(def.label) : m.field}`;

/** 枚举值的选项（按组织的下拉配置；币种为代码）/ options of an enum (organization pick lists; currencies as codes) */
export const enumOptions = (def: FieldDef) => (def.prefix ? pickOptions(def.prefix, def.values ?? []) : (def.values ?? []).map((v) => ({ value: v, label: v })));

/**
 * 显示一个值（枚举名称、日期、金额、关联记录名称）。
 * Display a value (enum label, date, amount, related record name).
 */
export function showValue(def: FieldDef | undefined, value: unknown, currency?: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') return '—';
  if (!def) return String(value);
  switch (def.type) {
    case 'enum':
      return def.prefix ? tEnum(def.prefix, String(value)) : String(value);
    case 'boolean':
      return value ? t('common.yes') : t('common.no');
    case 'date':
      return String(value).length > 10 && !String(value).endsWith('T00:00:00.000Z') ? fmtDateTime(String(value)) : fmtDate(String(value));
    case 'amount':
      return fmtMoney(String(value), typeof currency === 'string' ? currency : undefined);
    case 'owner':
    case 'territory':
      return (value as { name: string }).name;
    case 'account': {
      const a = value as { id: string; name: string };
      return <Link href={`/accounts?id=${a.id}`}>{a.name}</Link>;
    }
    default:
      return String(value);
  }
}

/**
 * 筛选值输入（按字段类型）。
 * The filter value input for a field type.
 */
export function FilterValue({ def, op, value, onChange, label }: { def: FieldDef; op: string; value: string | null | undefined; onChange: (v: string | null) => void; label: string }) {
  const owners = useOwners();
  const [territories, setTerritories] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (def.type !== 'territory') return;
    api<{ items: { id: string; name: string }[] }>('/api/territories?view=options')
      .then((r) => setTerritories(r.items))
      .catch(() => setTerritories([]));
  }, [def.type]);
  if (NO_VALUE.has(op)) return null;
  const common = { 'aria-label': label, style: { width: 220 } };
  if (def.type === 'date' && op === 'LAST_DAYS') return <InputNumber {...common} min={1} max={3650} precision={0} value={value ? Number(value) : null} onChange={(v) => onChange(v === null ? null : String(v))} />;
  if (def.type === 'date') return <DatePicker {...common} value={value ? dayjs(value) : null} onChange={(d) => onChange(d ? d.format('YYYY-MM-DD') : null)} />;
  if (def.type === 'enum') return <Select {...common} options={enumOptions(def)} value={value ?? undefined} onChange={onChange} />;
  if (def.type === 'owner') return <Select {...common} options={[{ value: 'ME', label: t('customReports.me') }, ...owners.map((u) => ({ value: u.id, label: u.name }))]} value={value ?? undefined} onChange={onChange} />;
  if (def.type === 'territory') return <Select {...common} options={territories.map((x) => ({ value: x.id, label: x.name }))} value={value ?? undefined} onChange={onChange} />;
  if (def.type === 'account')
    return (
      <div style={{ width: 220 }}>
        <RecordSelect resource="/api/accounts" value={value ?? null} onChange={onChange} placeholder={label} />
      </div>
    );
  return <Input {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * 运行结果：明细表格（分页），或汇总（图表 + 分组表格 + 合计）。
 * Run results: a paged detail table, or a summary (chart, group table and total).
 */
export function ReportResultView({ catalog, definition, result, onPage }: { catalog: Catalog; definition: Definition; result: Result; onPage?: (page: number, pageSize: number) => void }) {
  const fields = catalog.fields[definition.entity];
  if (result.kind === 'detail') {
    return (
      <Table
        rowKey="id"
        data-testid="report-result"
        dataSource={result.rows}
        scroll={{ x: 'max-content' }}
        pagination={{ current: result.page, pageSize: result.pageSize, total: result.total, showTotal: (total) => t('common.total', { total }), onChange: onPage }}
        columns={result.columns.map((c) => ({ key: c, title: fields[c] ? t(fields[c]!.label) : c, render: (_: unknown, r: { values: Record<string, unknown> }) => showValue(fields[c], r.values[c], r.values.currency) }))}
      />
    );
  }
  const gdef = definition.groupBy ? fields[definition.groupBy.field] : undefined;
  const groupLabel = (g: { key: string | null; name?: string | null }) => (g.key === null ? t('customReports.empty') : gdef?.type === 'enum' ? showValue(gdef, g.key) : gdef?.type === 'boolean' ? showValue(gdef, g.key === 'true') : (g.name ?? g.key));
  const money = (v: string | number | null, m: Measure) => (v === null ? '—' : fields[m.field]?.type === 'amount' ? fmtMoney(String(v), result.currency ?? undefined) : String(v));
  const chartData = result.groups.map((g) => ({ key: String(g.key), label: String(groupLabel(g)), value: g.count }));
  const rows = [...result.groups.map((g) => ({ ...g, rowKey: String(g.key), label: groupLabel(g) })), { rowKey: '__total', key: '__total', count: result.totals.count, measures: result.totals.measures, label: <Typography.Text strong>{t('customReports.total')}</Typography.Text> }];
  return (
    <div data-testid="report-result">
      {result.truncated && <Alert type="warning" showIcon title={t('customReports.truncated', { limit: catalog.limits.summary })} style={{ marginBottom: 12 }} />}
      {definition.chart === 'BAR' && <HBarChart data={chartData.map((d) => ({ ...d, display: String(d.value) }))} label={t('customReports.chart.BAR')} testId="report-chart" />}
      {definition.chart === 'COLUMN' && <ColumnChart data={chartData.map((d) => ({ ...d, title: `${d.label}: ${d.value}` }))} label={t('customReports.chart.COLUMN')} testId="report-chart" />}
      <Table
        rowKey="rowKey"
        size="small"
        style={{ marginTop: definition.chart === 'NONE' ? 0 : 16 }}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { key: 'group', title: gdef ? t(gdef.label) : '', render: (_: unknown, r: (typeof rows)[number]) => r.label },
          { key: 'count', title: t('customReports.count'), align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => r.count },
          ...definition.measures.map((m, i) => ({ key: `m${i}`, title: measureLabel(fields[m.field], m), align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => money(r.measures[i] ?? null, m) })),
        ]}
      />
    </div>
  );
}
