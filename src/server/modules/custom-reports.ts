/**
 * 自定义报表（对标 Zoho CRM 报表构建器）：用户选择对象（线索、客户、商机、跟进）、明细列、筛选条件（全部满足）、
 * 分组（可按月、季度、年）与汇总指标（计数，以及数字、金额字段的合计、平均、最小、最大），可选条形图或柱状图。
 * - 运行时按查看者的可见范围取数（与列表一致：负责人范围，客户与商机含区域只读范围），共享报表也不越权。
 * - 金额指标只在单一币种下计算：须按币种分组，或筛选“币种等于”某一币种。
 * - 汇总最多统计 20000 条记录（超出时标记 truncated）；明细分页（每页最多 100 条）；导出最多 10000 行。
 * - 维护：私有报表所有用户可建；共享给全组织需 view.share；只有创建者能修改；共享报表也可由 view.share 持有者删除；
 *   每人最多 50 个；同一人报表名称唯一；新建、修改、删除与导出写审计。
 * Custom reports (cf. the Zoho CRM report builder): pick an entity (leads, accounts, deals, activities), detail
 * columns, filters (all must hold), a grouping (dates by month, quarter or year) and measures (count, plus sum, average,
 * min and max of number and amount fields), with an optional bar or column chart. Data follows the viewer's visibility
 * (as lists do), shared reports included. Amount measures need a single currency (group by currency, or filter on one).
 * Summaries read at most 20000 records (truncated beyond); details page by up to 100; exports cap at 10000 rows.
 * Private reports for everyone; sharing needs view.share; only creators edit; shared reports may also be deleted by
 * view.share holders; ≤ 50 per user; unique names per user; writes and exports are audited.
 */
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { ReportEntity } from '@/generated/prisma/enums';
import { DEFAULT_LOCALE, LOCALES, tEnumIn, translate, type Locale, type MessageKey } from '@/i18n';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { toCsv } from '../csv';
import { prisma } from '../db';
import { ApiError, notFound } from '../errors';
import { can, requirePermission, visible } from '../permissions';
import { toXlsx, type Cell } from '../xlsx';
import { containsText, optionalText, requiredText } from '../validation';
import { CURRENCIES, INDUSTRIES, LEAD_SOURCES } from './dictionaries';
import { PICKLIST_CODE, withOptionLabels } from './picklists';
import { readableAccounts, readableDeals, territoryReadScope } from './territory-rules';

/** 汇总最多读取的记录数 / max records read by a summary */
export const SUMMARY_MAX = 20_000;
/** 导出最多行数 / max exported rows */
export const REPORT_EXPORT_MAX = 10_000;
/** 每人最多报表数 / max reports per user */
export const MAX_REPORTS = 50;

/** 字段类型 / field type */
export type ReportFieldType = 'text' | 'enum' | 'number' | 'amount' | 'date' | 'owner' | 'boolean' | 'account' | 'territory';
/** 字段定义 / field definition */
export interface ReportField {
  type: ReportFieldType;
  label: MessageKey;
  /** 枚举的 i18n 前缀 / i18n prefix of enum values */
  prefix?: string;
  /** 枚举的内置值（自定义下拉选项另按代码格式接受）/ built-in enum values (custom pick-list codes also accepted) */
  values?: readonly string[];
  /** 可扩展的下拉字段 / extensible pick list */
  extensible?: boolean;
}

/** 各对象可用的字段（键为数据库模型字段）/ fields per entity (keys are model fields) */
export const REPORT_FIELDS: Record<ReportEntity, Record<string, ReportField>> = {
  LEAD: {
    name: { type: 'text', label: 'leads.name' },
    company: { type: 'text', label: 'leads.company' },
    title: { type: 'text', label: 'leads.jobTitle' },
    email: { type: 'text', label: 'leads.email' },
    phone: { type: 'text', label: 'leads.phone' },
    source: { type: 'enum', label: 'leads.source', prefix: 'leadSource', values: LEAD_SOURCES, extensible: true },
    status: { type: 'enum', label: 'leads.status', prefix: 'leadStatus', values: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'] },
    score: { type: 'number', label: 'scoring.score' },
    ownerId: { type: 'owner', label: 'common.owner' },
    createdAt: { type: 'date', label: 'common.createdAt' },
  },
  ACCOUNT: {
    name: { type: 'text', label: 'accounts.name' },
    industry: { type: 'enum', label: 'accounts.industry', prefix: 'industry', values: INDUSTRIES, extensible: true },
    phone: { type: 'text', label: 'accounts.phone' },
    website: { type: 'text', label: 'accounts.website' },
    score: { type: 'number', label: 'scoring.score' },
    territoryId: { type: 'territory', label: 'territories.territory' },
    ownerId: { type: 'owner', label: 'common.owner' },
    createdAt: { type: 'date', label: 'common.createdAt' },
  },
  DEAL: {
    name: { type: 'text', label: 'deals.name' },
    accountId: { type: 'account', label: 'deals.account' },
    amount: { type: 'amount', label: 'deals.amount' },
    currency: { type: 'enum', label: 'deals.currency', values: CURRENCIES },
    stage: { type: 'enum', label: 'deals.stage', prefix: 'dealStage', values: ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'] },
    expectedCloseDate: { type: 'date', label: 'deals.expectedCloseDate' },
    score: { type: 'number', label: 'scoring.score' },
    ownerId: { type: 'owner', label: 'common.owner' },
    createdAt: { type: 'date', label: 'common.createdAt' },
  },
  ACTIVITY: {
    subject: { type: 'text', label: 'activities.subject' },
    type: { type: 'enum', label: 'activities.type', prefix: 'activityType', values: ['CALL', 'MEETING', 'VISIT', 'TASK'] },
    completed: { type: 'boolean', label: 'activities.completed' },
    dueAt: { type: 'date', label: 'activities.dueAt' },
    accountId: { type: 'account', label: 'activities.account' },
    ownerId: { type: 'owner', label: 'common.owner' },
    createdAt: { type: 'date', label: 'common.createdAt' },
  },
};

/** 各类型可用的筛选运算 / filter operators per type */
export const REPORT_OPS: Record<ReportFieldType, readonly string[]> = {
  text: ['CONTAINS', 'EQUALS', 'EMPTY', 'NOT_EMPTY'],
  enum: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
  number: ['EQUALS', 'GTE', 'LTE'],
  amount: ['EQUALS', 'GTE', 'LTE'],
  date: ['GTE', 'LTE', 'LAST_DAYS', 'THIS_MONTH', 'THIS_YEAR', 'EMPTY', 'NOT_EMPTY'],
  owner: ['EQUALS', 'EMPTY'],
  boolean: ['TRUE', 'FALSE'],
  account: ['EQUALS', 'EMPTY'],
  territory: ['EQUALS', 'EMPTY'],
};
/** 不需要值的运算 / operators without a value */
const NO_VALUE = new Set(['EMPTY', 'NOT_EMPTY', 'THIS_MONTH', 'THIS_YEAR', 'TRUE', 'FALSE']);
/** 可分组的类型 / groupable types */
const GROUPABLE = new Set<ReportFieldType>(['enum', 'owner', 'boolean', 'account', 'territory', 'date']);
/** 可汇总的类型 / measurable types */
const MEASURABLE = new Set<ReportFieldType>(['number', 'amount']);
/** 可排序的类型（明细）/ sortable types (details) */
const SORTABLE = new Set<ReportFieldType>(['text', 'enum', 'number', 'amount', 'date', 'boolean']);

const filterSchema = z.strictObject({ field: z.string().max(30), op: z.string().max(20), value: z.string().trim().max(200).nullish() });
const definitionFields = {
  entity: z.enum(ReportEntity),
  columns: z.array(z.string().max(30)).max(15).default([]),
  filters: z.array(filterSchema).max(10).default([]),
  groupBy: z.strictObject({ field: z.string().max(30), unit: z.enum(['month', 'quarter', 'year']).nullish() }).nullish(),
  measures: z.array(z.strictObject({ fn: z.enum(['SUM', 'AVG', 'MIN', 'MAX']), field: z.string().max(30) })).max(3).default([]),
  chart: z.enum(['NONE', 'BAR', 'COLUMN']).default('NONE'),
  sort: z.strictObject({ field: z.string().max(30), dir: z.enum(['asc', 'desc']) }).nullish(),
};
/** 报表定义（用于预览与保存）/ a report definition (preview and save) */
export const definitionSchema = z.strictObject(definitionFields).superRefine(checkDefinition);
export type ReportDefinition = z.infer<typeof definitionSchema>;
/** 新建 / create */
export const reportCreateSchema = z.strictObject({ ...definitionFields, name: requiredText(100), description: optionalText(500), shared: z.boolean().default(false) }).superRefine(checkDefinition);
/** 修改（整体替换定义；对象不可改）/ update (replaces the definition; the entity is fixed) */
export const reportUpdateSchema = z.strictObject({ ...definitionFields, name: requiredText(100), description: optionalText(500), shared: z.boolean() }).superRefine(checkDefinition);
/** 运行参数 / run parameters */
export const runQuerySchema = z.strictObject({ page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) });

/**
 * 定义的组合校验：字段属于对象、运算与值合法、分组与指标字段类型、图表需要分组、金额需要单一币种。
 * Cross checks: fields belong to the entity, operators and values are valid, group and measure types, charts need a
 * grouping, amounts need a single currency.
 */
function checkDefinition(v: z.infer<z.ZodObject<typeof definitionFields>>, ctx: z.RefinementCtx): void {
  const fields = REPORT_FIELDS[v.entity];
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  v.columns.forEach((c, i) => fields[c] || issue(['columns', i], 'invalid_field'));
  if (new Set(v.columns).size !== v.columns.length) issue(['columns'], 'duplicate');
  if (!v.groupBy && !v.columns.length) issue(['columns'], 'required');
  v.filters.forEach((f, i) => {
    const def = fields[f.field];
    if (!def) return issue(['filters', i, 'field'], 'invalid_field');
    if (!REPORT_OPS[def.type].includes(f.op)) return issue(['filters', i, 'op'], 'invalid_op');
    const value = f.value ?? '';
    if (NO_VALUE.has(f.op)) return value ? issue(['filters', i, 'value'], 'not_allowed') : undefined;
    if (!value) return issue(['filters', i, 'value'], 'required');
    const bad = () => issue(['filters', i, 'value'], 'invalid_value');
    if (def.type === 'enum' && !def.values!.includes(value) && !(def.extensible && PICKLIST_CODE.test(value))) bad();
    if (def.type === 'number' && !/^-?\d{1,9}$/.test(value)) bad();
    if (def.type === 'amount' && !/^-?\d{1,16}(\.\d{1,2})?$/.test(value)) bad();
    if (def.type === 'date' && f.op === 'LAST_DAYS' && !(/^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 3650)) bad();
    if (def.type === 'date' && f.op !== 'LAST_DAYS' && !isDate(value)) bad();
    if (def.type === 'owner' && value !== 'ME' && !z.uuid().safeParse(value).success) bad();
    if ((def.type === 'account' || def.type === 'territory') && !z.uuid().safeParse(value).success) bad();
  });
  if (v.groupBy) {
    const def = fields[v.groupBy.field];
    if (!def || !GROUPABLE.has(def.type)) issue(['groupBy', 'field'], 'invalid_field');
    else if (def.type === 'date' && !v.groupBy.unit) issue(['groupBy', 'unit'], 'required');
    else if (def.type !== 'date' && v.groupBy.unit) issue(['groupBy', 'unit'], 'not_allowed');
  }
  v.measures.forEach((m, i) => {
    const def = fields[m.field];
    if (!def || !MEASURABLE.has(def.type)) issue(['measures', i, 'field'], 'invalid_field');
  });
  if (v.measures.length && !v.groupBy) issue(['measures'], 'group_required');
  if (v.chart !== 'NONE' && !v.groupBy) issue(['chart'], 'group_required');
  // 金额只在单一币种下汇总 / amounts are only aggregated within one currency
  const amounts = v.measures.some((m) => fields[m.field]?.type === 'amount');
  const oneCurrency = v.groupBy?.field === 'currency' || v.filters.some((f) => f.field === 'currency' && f.op === 'EQUALS');
  if (amounts && !oneCurrency) issue(['measures'], 'single_currency');
  if (v.sort) {
    const def = fields[v.sort.field];
    if (!def || !SORTABLE.has(def.type)) issue(['sort', 'field'], 'invalid_field');
  }
}

/** 合法的 YYYY-MM-DD / a valid YYYY-MM-DD */
function isDate(v: string): boolean {
  const d = new Date(`${v}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 一天的毫秒数 / one day in ms */
const DAY = 86_400_000;

/**
 * 单个筛选条件的 Prisma 条件（日期按 UTC）。
 * The Prisma condition of one filter (dates in UTC).
 */
function filterWhere(ctx: AuthContext, def: ReportField, field: string, op: string, value: string, now: Date): Record<string, unknown> {
  const empty = def.type === 'text' ? { OR: [{ [field]: null }, { [field]: '' }] } : { [field]: null };
  switch (op) {
    case 'EMPTY':
      return empty;
    case 'NOT_EMPTY':
      return def.type === 'text' ? { AND: [{ [field]: { not: null } }, { [field]: { not: '' } }] } : { [field]: { not: null } };
    case 'CONTAINS':
      return { [field]: containsText(value) };
    case 'TRUE':
      return { [field]: true };
    case 'FALSE':
      return { [field]: false };
    case 'NOT_EQUALS':
      // “不等于”包含空值 / "not equal" includes empty values
      return { OR: [{ [field]: { not: value } }, { [field]: null }] };
    case 'EQUALS':
      if (def.type === 'text') return { [field]: { equals: value, mode: 'insensitive' } };
      if (def.type === 'number') return { [field]: Number(value) };
      if (def.type === 'amount') return { [field]: new Prisma.Decimal(value) };
      if (def.type === 'owner') return { [field]: value === 'ME' ? ctx.userId : value };
      return { [field]: value };
    case 'GTE':
      if (def.type === 'date') return { [field]: { gte: new Date(`${value}T00:00:00Z`) } };
      return { [field]: { gte: def.type === 'amount' ? new Prisma.Decimal(value) : Number(value) } };
    case 'LTE':
      if (def.type === 'date') return { [field]: { lt: new Date(new Date(`${value}T00:00:00Z`).getTime() + DAY) } };
      return { [field]: { lte: def.type === 'amount' ? new Prisma.Decimal(value) : Number(value) } };
    case 'LAST_DAYS':
      return { [field]: { gte: new Date(now.getTime() - Number(value) * DAY), lte: now } };
    case 'THIS_MONTH': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { [field]: { gte: start, lt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) } };
    }
    case 'THIS_YEAR':
      return { [field]: { gte: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), lt: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) } };
    default:
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid operator', { filters: ['invalid_op'] });
  }
}

/**
 * 查询条件：查看者的可见范围 + 全部筛选。
 * The query condition: the viewer's visibility plus every filter.
 */
async function reportWhere(ctx: AuthContext, d: ReportDefinition, now: Date): Promise<Record<string, unknown>> {
  const fields = REPORT_FIELDS[d.entity];
  const scope =
    d.entity === ReportEntity.ACCOUNT
      ? readableAccounts(ctx, await territoryReadScope(ctx))
      : d.entity === ReportEntity.DEAL
        ? readableDeals(ctx, await territoryReadScope(ctx))
        : visible(ctx);
  return { AND: [scope, ...d.filters.map((f) => filterWhere(ctx, fields[f.field]!, f.field, f.op, f.value ?? '', now))] };
}

/** 对象的 Prisma 委托（字段与条件已按白名单校验）/ the Prisma delegate of an entity (fields and conditions are whitelisted) */
function delegate(entity: ReportEntity) {
  const map = { LEAD: prisma.lead, ACCOUNT: prisma.account, DEAL: prisma.deal, ACTIVITY: prisma.activity } as const;
  return map[entity] as unknown as {
    findMany(args: object): Promise<Record<string, unknown>[]>;
    count(args: object): Promise<number>;
  };
}

/** 日期分组的键 / the bucket of a date grouping */
function bucket(d: Date, unit: 'month' | 'quarter' | 'year'): string {
  const y = d.getUTCFullYear();
  if (unit === 'year') return String(y);
  if (unit === 'quarter') return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 汇总结果的一组 / one summary group */
export interface SummaryGroup {
  key: string | null;
  /** 关联对象的名称（负责人、客户、区域）/ name of a related record (owner, account, territory) */
  name?: string | null;
  count: number;
  /** 各指标的值（金额为两位小数字符串）/ measure values (amounts as 2-decimal strings) */
  measures: (string | number | null)[];
}

/** 运行结果 / run result */
export type ReportResult =
  | { kind: 'detail'; columns: string[]; rows: { id: string; values: Record<string, unknown> }[]; total: number; page: number; pageSize: number }
  | { kind: 'summary'; groups: SummaryGroup[]; totals: { count: number; measures: (string | number | null)[] }; truncated: boolean; currency: string | null };

/**
 * 汇总：读取分组字段与指标字段，在内存中按组统计（最多 SUMMARY_MAX 条）。
 * Summary: read the group and measure fields and aggregate in memory (at most SUMMARY_MAX records).
 */
async function runSummary(ctx: AuthContext, d: ReportDefinition, where: object): Promise<ReportResult> {
  const fields = REPORT_FIELDS[d.entity];
  const g = d.groupBy!;
  const gdef = fields[g.field]!;
  const select: Record<string, boolean> = { [g.field]: true };
  for (const m of d.measures) select[m.field] = true;
  if (d.entity === ReportEntity.DEAL) select.currency = true;
  const rows = await delegate(d.entity).findMany({ where, select, take: SUMMARY_MAX + 1 });
  const truncated = rows.length > SUMMARY_MAX;
  const used = rows.slice(0, SUMMARY_MAX);
  const keyOf = (r: Record<string, unknown>): string | null => {
    const v = r[g.field];
    if (v === null || v === undefined) return null;
    if (gdef.type === 'date') return bucket(v as Date, g.unit!);
    return String(v);
  };
  const groups = new Map<string | null, Record<string, unknown>[]>();
  for (const r of used) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const measure = (list: Record<string, unknown>[], m: { fn: string; field: string }): string | number | null => {
    const amount = fields[m.field]!.type === 'amount';
    const values = list.map((r) => r[m.field]).filter((v) => v !== null && v !== undefined);
    if (!values.length) return null;
    if (amount) {
      const nums = values.map((v) => new Prisma.Decimal(v as Prisma.Decimal));
      const sum = nums.reduce((a, b) => a.plus(b), new Prisma.Decimal(0));
      const out = m.fn === 'SUM' ? sum : m.fn === 'AVG' ? sum.div(nums.length) : m.fn === 'MIN' ? Prisma.Decimal.min(...nums) : Prisma.Decimal.max(...nums);
      return out.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
    }
    const nums = values.map(Number);
    const sum = nums.reduce((a, b) => a + b, 0);
    const out = m.fn === 'SUM' ? sum : m.fn === 'AVG' ? sum / nums.length : m.fn === 'MIN' ? Math.min(...nums) : Math.max(...nums);
    return Math.round(out * 100) / 100;
  };
  let list: SummaryGroup[] = [...groups.entries()].map(([key, rs]) => ({ key, count: rs.length, measures: d.measures.map((m) => measure(rs, m)) }));
  // 日期按时间先后，其他按数量从多到少；空值最后 / dates chronologically, others by count; empty last
  list.sort((a, b) => (a.key === null ? 1 : b.key === null ? -1 : gdef.type === 'date' ? a.key.localeCompare(b.key) : b.count - a.count || a.key.localeCompare(b.key)));
  // 关联对象的名称 / names of related records
  const ids = list.map((x) => x.key).filter((k): k is string => !!k);
  if (gdef.type === 'owner' || gdef.type === 'account' || gdef.type === 'territory') {
    const where = { organizationId: ctx.organizationId, id: { in: ids } };
    const named =
      gdef.type === 'owner'
        ? await prisma.user.findMany({ where, select: { id: true, name: true } })
        : gdef.type === 'account'
          ? await prisma.account.findMany({ where, select: { id: true, name: true } })
          : await prisma.territory.findMany({ where, select: { id: true, name: true } });
    const names = new Map(named.map((n) => [n.id, n.name]));
    list = list.map((x) => ({ ...x, name: x.key ? (names.get(x.key) ?? null) : null }));
  }
  const currencies = new Set(used.map((r) => r.currency).filter(Boolean));
  return {
    kind: 'summary',
    groups: list,
    totals: { count: used.length, measures: d.measures.map((m) => measure(used, m)) },
    truncated,
    currency: currencies.size === 1 ? String([...currencies][0]) : null,
  };
}

/** 明细中关联字段的读取方式 / how related fields are read in details */
const RELATION: Partial<Record<ReportFieldType, (field: string) => Record<string, unknown>>> = {
  owner: () => ({ owner: { select: { id: true, name: true } } }),
  account: () => ({ account: { select: { id: true, name: true } } }),
  territory: () => ({ territory: { select: { id: true, name: true } } }),
};

/**
 * 明细：选定列、排序与分页。
 * Details: the chosen columns, sort and paging.
 */
async function runDetail(d: ReportDefinition, where: object, page: number, pageSize: number): Promise<ReportResult> {
  const fields = REPORT_FIELDS[d.entity];
  const select: Record<string, unknown> = { id: true };
  for (const c of d.columns) {
    const rel = RELATION[fields[c]!.type];
    Object.assign(select, rel ? rel(c) : { [c]: true });
    if (fields[c]!.type === 'amount') select.currency = true;
  }
  const orderBy = [d.sort ? { [d.sort.field]: d.sort.dir } : { createdAt: 'desc' }, { id: 'asc' }];
  const del = delegate(d.entity);
  const [rows, total] = await Promise.all([del.findMany({ where, select, orderBy, skip: (page - 1) * pageSize, take: pageSize }), del.count({ where })]);
  return {
    kind: 'detail',
    columns: d.columns,
    rows: rows.map((r) => {
      const values: Record<string, unknown> = {};
      for (const c of d.columns) {
        const type = fields[c]!.type;
        values[c] = type === 'owner' ? r.owner : type === 'account' ? r.account : type === 'territory' ? r.territory : r[c] instanceof Prisma.Decimal ? (r[c] as Prisma.Decimal).toFixed(2) : r[c];
        if (type === 'amount') values.currency = r.currency;
      }
      return { id: String(r.id), values };
    }),
    total,
    page,
    pageSize,
  };
}

/**
 * 运行报表定义（预览或已保存的报表）。
 * Run a report definition (a preview or a saved report).
 */
export async function runDefinition(ctx: AuthContext, d: ReportDefinition, query: z.infer<typeof runQuerySchema>, now = new Date()): Promise<ReportResult> {
  const where = await reportWhere(ctx, d, now);
  return d.groupBy ? runSummary(ctx, d, where) : runDetail(d, where, query.page, query.pageSize);
}

const select = {
  id: true,
  name: true,
  description: true,
  entity: true,
  columns: true,
  filters: true,
  groupBy: true,
  measures: true,
  chart: true,
  sort: true,
  shared: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true } },
} satisfies Prisma.CustomReportSelect;
type Saved = Prisma.CustomReportGetPayload<{ select: typeof select }>;

/** 已保存的定义 / the stored definition */
const definitionOf = (r: Saved): ReportDefinition => definitionSchema.parse({ entity: r.entity, columns: r.columns, filters: r.filters, groupBy: r.groupBy, measures: r.measures, chart: r.chart, sort: r.sort });

/** 名称重复 / duplicate name */
function nameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError(409, 'CONFLICT', 'Report name already exists', { name: ['taken'] });
  throw err;
}

/** 审计快照 / audit snapshot */
const snap = (r: { name: string; entity: string; shared: boolean; columns: unknown; filters: unknown; groupBy: unknown; measures: unknown; chart: string }) => ({
  name: r.name,
  entity: r.entity,
  shared: r.shared,
  columns: r.columns,
  filters: r.filters,
  groupBy: r.groupBy,
  measures: r.measures,
  chart: r.chart,
});

/**
 * 可见的报表（自己的与共享的），最新修改在前。
 * Reports visible to the user (own and shared), most recently changed first.
 */
export async function listReports(ctx: AuthContext) {
  return {
    items: await prisma.customReport.findMany({
      where: { organizationId: ctx.organizationId, OR: [{ ownerId: ctx.userId }, { shared: true }] },
      select,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    }),
  };
}

/**
 * 读取可见的报表，不可见或不存在时 404。
 * Load a visible report or throw 404.
 */
export async function getReport(ctx: AuthContext, id: string): Promise<Saved> {
  const r = await prisma.customReport.findFirst({ where: { id, organizationId: ctx.organizationId, OR: [{ ownerId: ctx.userId }, { shared: true }] }, select });
  if (!r) throw notFound();
  return r;
}

/**
 * 新建报表（共享需 view.share；每人上限在锁内判断）。
 * Create a report (sharing needs view.share; the per-user cap is checked under a lock).
 */
export async function createReport(ctx: AuthContext, input: z.infer<typeof reportCreateSchema>) {
  if (input.shared) requirePermission(ctx, 'view.share');
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`report:${ctx.organizationId}:${ctx.userId}`}, 0))`;
      if ((await tx.customReport.count({ where: { organizationId: ctx.organizationId, ownerId: ctx.userId } })) >= MAX_REPORTS) {
        throw new ApiError(409, 'CONFLICT', 'Too many reports', { name: ['limit_reached'] });
      }
      const r = await tx.customReport.create({
        data: {
          ...input,
          groupBy: (input.groupBy ?? Prisma.DbNull) as Prisma.InputJsonValue,
          sort: (input.sort ?? Prisma.DbNull) as Prisma.InputJsonValue,
          organizationId: ctx.organizationId,
          ownerId: ctx.userId,
        },
        select,
      });
      await audit(tx, { ...by(ctx), action: 'customreport.create', entityType: 'report', entityId: r.id, changes: { after: snap(r) } });
      return r;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 修改报表（只有创建者；对象不可改；改为共享需 view.share）。
 * Update a report (creator only; fixed entity; sharing needs view.share).
 */
export async function updateReport(ctx: AuthContext, id: string, input: z.infer<typeof reportUpdateSchema>) {
  const current = await getReport(ctx, id);
  if (current.ownerId !== ctx.userId) throw new ApiError(403, 'FORBIDDEN', 'Only the creator can edit this report', { report: ['creator_only'] });
  if (input.entity !== current.entity) throw new ApiError(400, 'VALIDATION_ERROR', 'Entity cannot change', { entity: ['immutable'] });
  if (input.shared && !current.shared) requirePermission(ctx, 'view.share');
  try {
    return await prisma.$transaction(async (tx) => {
      const r = await tx.customReport.update({
        where: { id },
        data: { ...input, groupBy: (input.groupBy ?? Prisma.DbNull) as Prisma.InputJsonValue, sort: (input.sort ?? Prisma.DbNull) as Prisma.InputJsonValue },
        select,
      });
      const before = snap(current);
      const after = snap(r);
      const fields = Object.fromEntries((Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, [before[k], after[k]]]));
      if (Object.keys(fields).length) await audit(tx, { ...by(ctx), action: 'customreport.update', entityType: 'report', entityId: id, changes: { name: r.name, fields } });
      return r;
    });
  } catch (err) {
    nameTaken(err);
  }
}

/**
 * 删除报表（创建者；共享报表也可由 view.share 持有者删除）。
 * Delete a report (the creator; shared reports also by view.share holders).
 */
export async function deleteReport(ctx: AuthContext, id: string): Promise<void> {
  const current = await getReport(ctx, id);
  if (current.ownerId !== ctx.userId && !(current.shared && can(ctx, 'view.share'))) throw new ApiError(403, 'FORBIDDEN', 'Permission denied', { report: ['creator_only'] });
  await prisma.$transaction(async (tx) => {
    await tx.customReport.delete({ where: { id } });
    await audit(tx, { ...by(ctx), action: 'customreport.delete', entityType: 'report', entityId: id, changes: { before: snap(current) } });
  });
}

/**
 * 运行已保存的报表。
 * Run a saved report.
 */
export async function runReport(ctx: AuthContext, id: string, query: z.infer<typeof runQuerySchema>) {
  const r = await getReport(ctx, id);
  return runDefinition(ctx, definitionOf(r), query);
}

/** 导出参数 / export parameters */
export const reportExportSchema = z.strictObject({ format: z.enum(['csv', 'xlsx']).default('csv'), lang: z.enum(LOCALES).optional() });

/**
 * 导出报表（需导出权限，写审计）：明细导出全部行（最多 REPORT_EXPORT_MAX），汇总导出各组与合计。
 * Export a report (export permission, audited): details export every row (up to REPORT_EXPORT_MAX), summaries export
 * the groups and the total.
 */
export async function exportReport(ctx: AuthContext, id: string, query: z.infer<typeof reportExportSchema>) {
  requirePermission(ctx, 'data.export');
  const r = await getReport(ctx, id);
  const d = definitionOf(r);
  const locale: Locale = query.lang ?? DEFAULT_LOCALE;
  const t = (key: MessageKey) => translate(locale, key);
  const tEnum = await withOptionLabels(ctx.organizationId, (prefix, value) => tEnumIn(locale, prefix, value));
  const fields = REPORT_FIELDS[d.entity];
  const empty = translate(locale, 'customReports.empty');
  const fmt = (field: string, v: unknown): Cell => {
    const def = fields[field]!;
    if (v === null || v === undefined || v === '') return '';
    if (def.type === 'enum') return def.prefix ? tEnum(def.prefix, String(v)) : String(v);
    if (def.type === 'boolean') return translate(locale, v ? 'common.yes' : 'common.no');
    if (def.type === 'date') return (v as Date).toISOString().slice(0, field === 'dueAt' || field === 'createdAt' ? 16 : 10).replace('T', ' ');
    if (def.type === 'owner' || def.type === 'account' || def.type === 'territory') return (v as { name: string }).name;
    if (def.type === 'amount') return { value: Number(v), format: 'money' };
    if (def.type === 'number') return { value: Number(v), format: 'int' };
    return String(v);
  };
  let header: string[];
  let rows: Cell[][];
  let count: number;
  let truncated: boolean;
  if (d.groupBy) {
    const s = (await runDefinition(ctx, d, { page: 1, pageSize: 1 })) as Extract<ReportResult, { kind: 'summary' }>;
    const g = fields[d.groupBy.field]!;
    const label = (x: SummaryGroup) => (x.key === null ? empty : g.type === 'enum' && g.prefix ? tEnum(g.prefix, x.key) : (x.name ?? x.key));
    const mLabel = (m: { fn: string; field: string }) => `${translate(locale, `customReports.fn.${m.fn}` as MessageKey)} · ${t(fields[m.field]!.label)}`;
    header = [t(g.label), t('customReports.count'), ...d.measures.map(mLabel)];
    rows = [...s.groups.map((x) => [label(x), x.count, ...x.measures.map((v) => (v === null ? '' : Number(v)))]), [t('customReports.total'), s.totals.count, ...s.totals.measures.map((v) => (v === null ? '' : Number(v)))]];
    count = s.groups.length;
    truncated = s.truncated;
  } else {
    const where = await reportWhere(ctx, d, new Date());
    const detail = (await runDetail(d, where, 1, REPORT_EXPORT_MAX + 1)) as Extract<ReportResult, { kind: 'detail' }>;
    truncated = detail.rows.length > REPORT_EXPORT_MAX;
    const data = detail.rows.slice(0, REPORT_EXPORT_MAX);
    header = d.columns.map((c) => t(fields[c]!.label));
    if (d.columns.some((c) => fields[c]!.type === 'amount')) header.push(t('deals.currency'));
    rows = data.map((x) => {
      const cells = d.columns.map((c) => fmt(c, x.values[c]));
      if (d.columns.some((c) => fields[c]!.type === 'amount')) cells.push(String(x.values.currency ?? ''));
      return cells;
    });
    count = data.length;
  }
  await prisma.$transaction((tx) => audit(tx, { ...by(ctx), action: 'customreport.export', entityType: 'report', entityId: id, changes: { name: r.name, format: query.format, rows: count, truncated } }));
  const base = `report-${new Date().toISOString().slice(0, 10)}`;
  if (query.format === 'xlsx') return { kind: 'xlsx' as const, filename: `${base}.xlsx`, data: toXlsx([{ name: r.name.slice(0, 31), rows: [header, ...rows], boldRows: [0], freezeRows: 1 }]), count, truncated };
  const plain = rows.map((row) => row.map((c) => (c !== null && typeof c === 'object' ? c.value : c)));
  return { kind: 'csv' as const, filename: `${base}.csv`, csv: toCsv(header, plain), count, truncated };
}

/**
 * 字段目录（前端构建器使用）。
 * The field catalogue used by the builder.
 */
export function reportCatalog() {
  return { fields: REPORT_FIELDS, ops: REPORT_OPS, groupable: [...GROUPABLE], measurable: [...MEASURABLE], sortable: [...SORTABLE], limits: { summary: SUMMARY_MAX, export: REPORT_EXPORT_MAX, reports: MAX_REPORTS } };
}
