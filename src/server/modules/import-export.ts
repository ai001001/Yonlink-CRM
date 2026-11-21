/**
 * 数据导入导出（CSV，参考 Zoho Import / Export）。
 * - 导出：与列表共用查询条件（可见范围 + 筛选 + 搜索），需 data.export 权限，写审计。
 * - 导入：线索、客户；逐行复用新建校验规则，先预检后写入；有效行在一个事务内写入并逐条审计。
 *   线索可选“按分配规则”分配负责人（需 owner.assign）：未指定负责人的行按规则轮流分配，没有规则命中时归导入人。
 * Data import / export (CSV, cf. Zoho Import / Export).
 * - Export shares the list's query conditions, requires data.export and is audited.
 * - Import (leads, accounts) validates each row with the create rules, supports a dry run, and writes
 *   valid rows in one transaction with per-record audit entries. Lead imports may assign owners by the assignment
 *   rules (needs owner.assign): rows without an owner are assigned round-robin; with no matching rule the importer owns them.
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { CustomEntity } from '@/generated/prisma/enums';
import { allTranslations, DEFAULT_LOCALE, enumCodes, isLocale, LOCALES, tEnumIn, translate, type Locale, type MessageKey } from '@/i18n';
import { audit, by, snapshot } from '../audit';
import type { AuthContext } from '../auth';
import { parseCsv, toCsv, uncsvCell } from '../csv';
import { prisma } from '../db';
import { ApiError } from '../errors';
import { can, requirePermission } from '../permissions';
import { toXlsx, type Cell, type NumberFormat } from '../xlsx';
import { accountCreateSchema, accountListSchema, accountWhere, contactCreateSchema, contactListSchema, contactWhere } from './accounts';
import { activityListSchema, activityWhere } from './activities';
import { fieldsOf, normalize } from './custom-fields';
import { assignByRules } from './assignment-rules';
import { dealListSchema, dealWhere } from './deals';
import { territoryIdsFor, territoryMatcher } from './territory-rules';
import { leadCreateSchema, leadListSchema, leadWhere } from './leads';
import { gradeRange } from './scoring-grades';
import { OPEN_STATUSES, ticketListSchema, ticketWhere } from './tickets';

/** 单次导出上限 / Export row cap */
export const EXPORT_MAX = 10_000;
/** 单次导入行数上限 / Import row cap */
export const IMPORT_MAX_ROWS = 2_000;
/** 导入文本长度上限（与 HTTPS 入口 1MB 请求体上限一致）/ Import text cap (matches the 1 MB request limit) */
export const IMPORT_MAX_CHARS = 1_000_000;

/** 北京时间 YYYY-MM-DD HH:mm / Beijing time YYYY-MM-DD HH:mm */
const timeFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtTime = (d: Date | null) => (d ? timeFmt.format(d) : '');
const fmtDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
/**
 * 解析导出/模板的语言参数（缺省为默认语言，非法值 400）。
 * Parse the locale parameter of exports and templates (default when absent; invalid → 400).
 */
export function parseLang(value: string | null | undefined): Locale {
  if (value === undefined || value === null || value === '') return DEFAULT_LOCALE;
  if (!isLocale(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid language', { lang: ['invalid'] });
  return value;
}

export type ExportEntity = 'leads' | 'accounts' | 'contacts' | 'deals' | 'activities' | 'tickets';

/** 导出结果 / Export result */
export interface ExportResult {
  filename: string;
  csv: string;
  count: number;
  truncated: boolean;
}

/**
 * 记录导出审计（只记筛选条件的键值与是否搜索，不记搜索词）。
 * Audit an export (filters and whether a search was used; never the search text).
 */
async function auditExport(ctx: AuthContext, entityType: 'lead' | 'account' | 'contact' | 'deal' | 'activity' | 'ticket', query: Record<string, unknown>, count: number, truncated: boolean) {
  const filters = Object.fromEntries(Object.entries(query).filter(([k, v]) => v !== undefined && !['q', 'page', 'pageSize'].includes(k)));
  await prisma.$transaction((tx) =>
    audit(tx, { ...by(ctx), action: `${entityType}.export`, entityType, changes: { count, truncated, searched: !!query.q, filters } }),
  );
}

/** 列表导出格式 / list export format */
export type ListExportFormat = 'csv' | 'xlsx';

/** Excel 列表导出结果 / Excel list export result */
export interface ListXlsxResult {
  filename: string;
  data: Buffer;
  count: number;
  truncated: boolean;
}

/**
 * 导出 CSV。查询参数与对应列表相同。
 * Export CSV; query parameters are the same as the corresponding list.
 */
export async function exportCsv(ctx: AuthContext, entity: ExportEntity, input: Record<string, string>): Promise<ExportResult> {
  return (await exportList(ctx, entity, input, 'csv')) as ExportResult;
}

/**
 * 导出 Excel（.xlsx）：与 CSV 同样的列与筛选；金额、数量为数字单元格，表头加粗冻结，审计记录格式。
 * Export Excel (.xlsx): the same columns and filters as CSV; amounts and counts are numeric cells, the header is bold and
 * frozen, and the audit records the format.
 */
export async function exportXlsx(ctx: AuthContext, entity: ExportEntity, input: Record<string, string>): Promise<ListXlsxResult> {
  return (await exportList(ctx, entity, input, 'xlsx')) as ListXlsxResult;
}

/**
 * 按格式生成文件并写审计。CSV 内容与原有导出完全一致；Excel 按列格式把金额、数量写为数字。
 * Render the file in the requested format and audit it. CSV output is unchanged; Excel writes amounts and counts as
 * numbers according to the column formats.
 * @param formats 列序号 → 数字格式 / column index → number format
 */
async function finish(
  ctx: AuthContext,
  format: ListExportFormat,
  locale: Locale,
  auditEntity: Parameters<typeof auditExport>[1],
  query: Record<string, unknown>,
  base: string,
  header: string[],
  rows: unknown[][],
  truncated: boolean,
  formats: Record<number, NumberFormat> = {},
  custom?: { entity: CustomEntity; values: Prisma.JsonValue[] },
): Promise<ExportResult | ListXlsxResult> {
  // 自定义字段（启用的）追加在最后几列 / active custom fields are appended as the last columns
  if (custom) {
    const defs = (await fieldsOf(ctx.organizationId, custom.entity)).filter((d) => d.isActive);
    header = [...header, ...defs.map((d) => d.label)];
    rows = rows.map((r, i) => {
      const v = (custom.values[i] ?? {}) as Record<string, unknown>;
      return [...r, ...defs.map((d) => (typeof v[d.key] === 'boolean' ? translate(locale, v[d.key] ? 'common.yes' : 'common.no') : (v[d.key] ?? null)))];
    });
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (format === 'csv') {
    await auditExport(ctx, auditEntity, query, rows.length, truncated);
    return { filename: `${base}-${stamp}.csv`, csv: toCsv(header, rows), count: rows.length, truncated };
  }
  const cells: Cell[][] = rows.map((r) =>
    r.map((v, i) => {
      const f = formats[i];
      if (v === null || v === undefined || v === '') return null;
      if (f) return { value: Number(v), format: f };
      return typeof v === 'number' ? v : String(v);
    }),
  );
  await auditExport(ctx, auditEntity, { ...query, format: 'xlsx' }, rows.length, truncated);
  // 工作表名用列表名称（随语言）/ the sheet is named after the list, in the export language
  const sheet = translate(locale, `nav.${base}` as MessageKey);
  return { filename: `${base}-${stamp}.xlsx`, data: toXlsx([{ name: sheet, rows: [header, ...cells], boldRows: [0], freezeRows: 1 }]), count: rows.length, truncated };
}

/**
 * 列表导出（CSV 或 Excel）。查询参数与对应列表相同。
 * List export (CSV or Excel); query parameters are the same as the corresponding list.
 */
async function exportList(ctx: AuthContext, entity: ExportEntity, input: Record<string, string>, format: ListExportFormat): Promise<ExportResult | ListXlsxResult> {
  requirePermission(ctx, 'data.export');
  // 语言参数只决定表头与枚举文字，不参与筛选 / the locale only affects headers and enum labels, not filtering
  const { lang, ...params } = input;
  const locale = parseLang(lang);
  const t = (key: MessageKey) => translate(locale, key);
  const tEnum = (prefix: string, value: string | null | undefined) => tEnumIn(locale, prefix, value);
  const TIME_HEADER = (label: string) => translate(locale, 'export.timeHeader', { label });
  const take = EXPORT_MAX + 1;
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'asc' as const }];

  if (entity === 'leads') {
    const query = leadListSchema.parse(params);
    const rows = await prisma.lead.findMany({ where: leadWhere(ctx, query, await gradeRange(ctx.organizationId, 'LEAD', query.grade)), include: { owner: { select: { name: true, email: true } } }, orderBy, take });
    const truncated = rows.length > EXPORT_MAX;
    const data = rows.slice(0, EXPORT_MAX);
    return finish(
      ctx,
      format,
      locale,
      'lead',
      query,
      'leads',
      [t('leads.name'), t('leads.company'), t('leads.jobTitle'), t('leads.phone'), t('leads.mobile'), t('leads.email'), t('leads.source'), t('leads.status'), t('common.owner'), t('import.ownerEmail'), TIME_HEADER(t('common.createdAt')), t('common.description')],
      data.map((l) => [l.name, l.company, l.title, l.phone, l.mobile, l.email, tEnum('leadSource', l.source), tEnum('leadStatus', l.status), l.owner?.name, l.owner?.email, fmtTime(l.createdAt), l.description]),
      truncated,
      {},
      { entity: 'LEAD', values: data.map((r) => r.custom) },
    );
  }

  if (entity === 'tickets') {
    const query = ticketListSchema.parse(params);
    const rows = await prisma.ticket.findMany({
      where: ticketWhere(ctx, query),
      include: {
        account: { select: { name: true } },
        contact: { select: { name: true, phone: true, email: true } },
        owner: { select: { name: true } },
        _count: { select: { comments: true } },
      },
      orderBy,
      take,
    });
    const truncated = rows.length > EXPORT_MAX;
    const data = rows.slice(0, EXPORT_MAX);
    const now = new Date();
    return finish(
      ctx,
      format,
      locale,
      'ticket',
      query,
      'tickets',
      [
        t('tickets.number'),
        t('tickets.subject'),
        t('tickets.account'),
        t('tickets.contact'),
        t('contacts.phone'),
        t('contacts.email'),
        t('tickets.type'),
        t('tickets.channel'),
        t('tickets.priority'),
        t('tickets.status'),
        t('tickets.overdue'),
        t('common.owner'),
        TIME_HEADER(t('tickets.dueAt')),
        TIME_HEADER(t('tickets.resolvedAt')),
        TIME_HEADER(t('common.createdAt')),
        t('tickets.commentCount'),
        t('common.description'),
        t('tickets.resolution'),
      ],
      data.map((tk) => [
        tk.ticketNumber,
        tk.subject,
        tk.account.name,
        tk.contact?.name,
        tk.contact?.phone,
        tk.contact?.email,
        tEnum('ticketType', tk.type),
        tEnum('ticketChannel', tk.channel),
        tEnum('ticketPriority', tk.priority),
        tEnum('ticketStatus', tk.status),
        // 逾期按导出时刻计算 / overdue as of the export time
        tk.dueAt && tk.dueAt < now && OPEN_STATUSES.includes(tk.status) ? t('common.yes') : t('common.no'),
        tk.owner?.name,
        fmtTime(tk.dueAt),
        fmtTime(tk.resolvedAt),
        fmtTime(tk.createdAt),
        tk._count.comments,
        tk.description,
        tk.resolution,
      ]),
      truncated,
      { 15: 'int' },
    );
  }

  if (entity === 'contacts') {
    const query = contactListSchema.parse(params);
    const rows = await prisma.contact.findMany({ where: contactWhere(ctx, query, await gradeRange(ctx.organizationId, 'CONTACT', query.grade)), include: { account: { select: { name: true, owner: { select: { name: true } } } } }, orderBy, take });
    const truncated = rows.length > EXPORT_MAX;
    const data = rows.slice(0, EXPORT_MAX);
    return finish(
      ctx,
      format,
      locale,
      'contact',
      query,
      'contacts',
      [t('contacts.name'), t('contacts.title'), t('contacts.phone'), t('contacts.email'), t('contacts.isPrimary'), t('contacts.account'), t('common.owner'), TIME_HEADER(t('common.createdAt'))],
      data.map((c) => [c.name, c.title, c.phone, c.email, c.isPrimary ? t('common.yes') : t('common.no'), c.account.name, c.account.owner?.name, fmtTime(c.createdAt)]),
      truncated,
      {},
      { entity: 'CONTACT', values: data.map((r) => r.custom) },
    );
  }

  if (entity === 'accounts') {
    const query = accountListSchema.parse(params);
    const rows = await prisma.account.findMany({
      where: accountWhere(ctx, query, await gradeRange(ctx.organizationId, 'ACCOUNT', query.grade), await territoryIdsFor(ctx, query.territoryId)),
      include: { owner: { select: { name: true, email: true } }, territory: { select: { name: true } }, contacts: { where: { isPrimary: true }, take: 1 }, _count: { select: { contacts: true } } },
      orderBy,
      take,
    });
    const truncated = rows.length > EXPORT_MAX;
    const data = rows.slice(0, EXPORT_MAX);
    return finish(
      ctx,
      format,
      locale,
      'account',
      query,
      'accounts',
      [t('accounts.name'), t('accounts.industry'), t('accounts.phone'), t('accounts.website'), t('accounts.address'), t('common.owner'), t('import.ownerEmail'), t('contacts.isPrimary'), t('accounts.contactCount'), TIME_HEADER(t('common.createdAt')), t('common.description'), t('territories.territory')],
      data.map((a) => [a.name, tEnum('industry', a.industry), a.phone, a.website, a.address, a.owner?.name, a.owner?.email, a.contacts[0]?.name, a._count.contacts, fmtTime(a.createdAt), a.description, a.territory?.name]),
      truncated,
      { 8: 'int' },
      { entity: 'ACCOUNT', values: data.map((r) => r.custom) },
    );
  }

  if (entity === 'deals') {
    const query = dealListSchema.parse(params);
    const rows = await prisma.deal.findMany({
      where: dealWhere(ctx, query, await gradeRange(ctx.organizationId, 'DEAL', query.grade), await territoryIdsFor(ctx, query.territoryId)),
      include: { owner: { select: { name: true, email: true } }, account: { select: { name: true } } },
      orderBy,
      take,
    });
    const truncated = rows.length > EXPORT_MAX;
    const data = rows.slice(0, EXPORT_MAX);
    return finish(
      ctx,
      format,
      locale,
      'deal',
      query,
      'deals',
      [t('deals.name'), t('deals.account'), t('deals.amount'), t('deals.currency'), t('deals.stage'), t('deals.expectedCloseDate'), t('common.owner'), t('import.ownerEmail'), TIME_HEADER(t('common.createdAt')), t('common.description')],
      data.map((d) => [d.name, d.account.name, d.amount.toFixed(2), d.currency, tEnum('dealStage', d.stage), fmtDate(d.expectedCloseDate), d.owner?.name, d.owner?.email, fmtTime(d.createdAt), d.description]),
      truncated,
      { 2: 'money' },
      { entity: 'DEAL', values: data.map((r) => r.custom) },
    );
  }

  const query = activityListSchema.parse(params);
  const rows = await prisma.activity.findMany({
    where: activityWhere(ctx, query),
    include: { owner: { select: { name: true } }, account: { select: { name: true } }, lead: { select: { name: true } }, deal: { select: { name: true } } },
    orderBy,
    take,
  });
  const truncated = rows.length > EXPORT_MAX;
  const data = rows.slice(0, EXPORT_MAX);
  return finish(
    ctx,
    format,
    locale,
    'activity',
    query,
    'activities',
    [t('activities.type'), t('activities.subject'), t('activities.content'), TIME_HEADER(t('activities.dueAt')), t('activities.status'), t('activities.account'), t('activities.lead'), t('activities.deal'), t('common.owner'), TIME_HEADER(t('common.createdAt'))],
    data.map((a) => [
      tEnum('activityType', a.type),
      a.subject,
      a.content,
      fmtTime(a.dueAt),
      a.completed ? t('activities.completed') : t('activities.pending'),
      a.account?.name,
      a.lead?.name,
      a.deal?.name,
      a.owner?.name,
      fmtTime(a.createdAt),
    ]),
    truncated,
  );
}

// ---------------------------------------------------------------------------
// 导入 / Import
// ---------------------------------------------------------------------------

export type ImportEntity = 'leads' | 'accounts';

/** 行错误原因（前端用 i18n 显示）/ Row error reasons (displayed via i18n) */
export type ImportReason = 'required' | 'too_long' | 'invalid_email' | 'invalid_value' | 'owner_not_found' | 'owner_forbidden' | 'invalid';

/** 导入请求 / Import request */
export const importSchema = z.strictObject({
  csv: z.string().min(1).max(IMPORT_MAX_CHARS),
  dryRun: z.boolean().default(true),
  /** 重复记录：跳过（默认）或照常创建 / duplicates: skip (default) or create anyway */
  duplicates: z.enum(['skip', 'create']).default('skip'),
  /** 提示信息（如缺失的列名）使用的语言 / locale for messages such as missing column names */
  lang: z.enum(LOCALES).optional(),
  /** 未指定负责人的行：归导入人（默认）或按分配规则（仅线索）/ rows without an owner: the importer (default) or the assignment rules (leads only) */
  owner: z.enum(['self', 'rules']).default('self'),
});

/** 导入报告 / Import report */
export interface ImportReport {
  dryRun: boolean;
  total: number;
  valid: number;
  created: number;
  /** 按分配规则分配的行数 / rows assigned by the assignment rules */
  assignedByRule: number;
  duplicates: { row: number; value: string }[];
  errors: { row: number; field: string; reason: ImportReason }[];
  unknownColumns: string[];
}

/** 列定义：表头（任一语言的标签或字段名）→ 字段 / Column definition: header (label in any locale or field name) → field */
interface ColumnDef {
  field: string;
  /** 表头文案 key / header message key */
  label: MessageKey;
  required?: boolean;
  /** 枚举翻译前缀（可填中文标签或代码）/ enum translation prefix (label or code accepted) */
  enumPrefix?: string;
}

const LEAD_COLUMNS: ColumnDef[] = [
  { field: 'name', label: 'leads.name', required: true },
  { field: 'company', label: 'leads.company' },
  { field: 'title', label: 'leads.jobTitle' },
  { field: 'phone', label: 'leads.phone' },
  { field: 'mobile', label: 'leads.mobile' },
  { field: 'email', label: 'leads.email' },
  { field: 'source', label: 'leads.source', enumPrefix: 'leadSource' },
  { field: 'status', label: 'leads.status', enumPrefix: 'leadStatus' },
  { field: 'ownerEmail', label: 'import.ownerEmail' },
  { field: 'description', label: 'common.description' },
];

const ACCOUNT_COLUMNS: ColumnDef[] = [
  { field: 'name', label: 'accounts.name', required: true },
  { field: 'industry', label: 'accounts.industry', enumPrefix: 'industry' },
  { field: 'phone', label: 'accounts.phone' },
  { field: 'website', label: 'accounts.website' },
  { field: 'address', label: 'accounts.address' },
  { field: 'ownerEmail', label: 'import.ownerEmail' },
  { field: 'description', label: 'common.description' },
  { field: 'contactName', label: 'import.contactName' },
  { field: 'contactTitle', label: 'import.contactTitle' },
  { field: 'contactPhone', label: 'import.contactPhone' },
  { field: 'contactEmail', label: 'import.contactEmail' },
];

const COLUMNS: Record<ImportEntity, ColumnDef[]> = { leads: LEAD_COLUMNS, accounts: ACCOUNT_COLUMNS };

/**
 * 示例行（模板，按语言）。
 * Example rows for templates, per locale.
 */
function example(entity: ImportEntity, locale: Locale): string[] {
  const t = (key: MessageKey) => translate(locale, key);
  return entity === 'leads'
    ? [t('import.sample.leadName'), t('import.sample.company'), t('import.sample.jobTitle'), '021-55550000', '13800000000', 'sample@example.com', tEnumIn(locale, 'leadSource', 'EXHIBITION'), tEnumIn(locale, 'leadStatus', 'NEW'), '', t('import.exampleNote')]
    : [t('import.sample.accountName'), tEnumIn(locale, 'industry', 'MANUFACTURING'), '0571-55550000', 'https://www.example.com', t('import.sample.address'), '', t('import.exampleNote'), t('import.sample.contactName'), t('import.sample.contactTitle'), '13700000000', 'contact@example.com'];
}

/**
 * 导入模板（表头 + 一行示例，按语言）。
 * Import template (header plus one example row) in the given locale.
 */
export function importTemplate(entity: ImportEntity, locale: Locale = DEFAULT_LOCALE): { filename: string; csv: string } {
  return { filename: `${entity}-import-template.csv`, csv: toCsv(COLUMNS[entity].map((c) => translate(locale, c.label)), [example(entity, locale)]) };
}

/**
 * 枚举值：接受代码或任一语言的标签，返回代码；空值返回 undefined；无法识别时原样返回（由校验报错）。
 * Enum value: accepts a code or its label in any locale; empty → undefined; unknown values pass through to fail validation.
 */
function enumValue(prefix: string, raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  const code = v.toUpperCase();
  if (allTranslations(`${prefix}.${code}`).length) return code;
  // 任一语言的标签（英文不区分大小写）/ a label in any locale (English is case-insensitive)
  const hit = enumCodes(prefix).find((c) => allTranslations(`${prefix}.${c}`).some((label) => label.toLowerCase() === v.toLowerCase()));
  return hit ?? v;
}

/**
 * Zod 问题 → 行错误原因。
 * Map a Zod issue to a row error reason.
 */
function reasonOf(issue: z.core.$ZodIssue): ImportReason {
  if (issue.code === 'too_small') return 'required';
  if (issue.code === 'too_big') return 'too_long';
  if (issue.code === 'invalid_format' && (issue as { format?: string }).format === 'email') return 'invalid_email';
  if (issue.code === 'invalid_value' || issue.code === 'invalid_union') return 'invalid_value';
  return 'invalid';
}

/**
 * 导入线索或客户。dryRun 时只校验不写入。
 * Import leads or accounts; a dry run validates without writing.
 */
export async function importCsv(ctx: AuthContext, entity: ImportEntity, input: z.infer<typeof importSchema>): Promise<ImportReport> {
  requirePermission(ctx, 'record.create');
  if (input.owner === 'rules') {
    if (entity !== 'leads') throw new ApiError(400, 'VALIDATION_ERROR', 'Assignment rules apply to leads only', { owner: ['leads_only'] });
    requirePermission(ctx, 'owner.assign');
  }
  let table: string[][];
  try {
    table = parseCsv(input.csv);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid CSV', { csv: ['unterminated_quote'] });
  }
  if (table.length < 2) throw new ApiError(400, 'VALIDATION_ERROR', 'No data rows', { csv: ['no_rows'] });
  if (table.length - 1 > IMPORT_MAX_ROWS) throw new ApiError(400, 'VALIDATION_ERROR', 'Too many rows', { csv: ['too_many_rows'] });

  // 表头映射 / header mapping
  const header = table[0]!.map((h) => h.trim());
  const defs = COLUMNS[entity];
  const indexOf: Record<string, number> = {};
  const unknownColumns: string[] = [];
  // 表头与启用的自定义字段名称相同的列作为自定义字段导入 / columns named like active custom fields import into them
  const customDefs = (await fieldsOf(ctx.organizationId, entity === 'leads' ? 'LEAD' : 'ACCOUNT')).filter((d) => d.isActive);
  const customCols: { def: (typeof customDefs)[number]; index: number }[] = [];
  header.forEach((h, i) => {
    const def = defs.find((d) => [...allTranslations(d.label), d.field].some((x) => x.toLowerCase() === h.toLowerCase()));
    if (def) indexOf[def.field] ??= i;
    else {
      const cdef = customDefs.find((d) => d.label.toLowerCase() === h.toLowerCase());
      if (cdef && !customCols.some((c) => c.def.id === cdef.id)) customCols.push({ def: cdef, index: i });
      else if (h) unknownColumns.push(h);
    }
  });
  const missing = defs.filter((d) => d.required && indexOf[d.field] === undefined);
  if (missing.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Missing required column', { csv: missing.map((d) => `missing_column:${translate(input.lang ?? DEFAULT_LOCALE, d.label)}`) });

  // 负责人：本组织启用用户的邮箱 / owners: active users of the organization by email
  const users = await prisma.user.findMany({ where: { organizationId: ctx.organizationId, isActive: true }, select: { id: true, email: true } });
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  // 已有记录用于查重（整个组织范围）/ existing keys for duplicate detection (organization wide)
  const existing = new Set<string>(
    entity === 'leads'
      ? (await prisma.lead.findMany({ where: { organizationId: ctx.organizationId, email: { not: null } }, select: { email: true } })).map((l) => l.email!.toLowerCase())
      : (await prisma.account.findMany({ where: { organizationId: ctx.organizationId }, select: { name: true } })).map((a) => a.name.trim().toLowerCase()),
  );

  const report: ImportReport = { dryRun: input.dryRun, total: table.length - 1, valid: 0, created: 0, assignedByRule: 0, duplicates: [], errors: [], unknownColumns };
  const toCreate: { data: Record<string, unknown>; contact?: Record<string, unknown> }[] = [];

  table.slice(1).forEach((cells, i) => {
    const rowNo = i + 2; // 文件中的行号（含表头）/ line number in the file, header included
    const raw: Record<string, string> = {};
    for (const d of defs) {
      const idx = indexOf[d.field];
      if (idx === undefined) continue;
      // 还原导出时为防公式注入加的单引号，使“导出→导入”数据一致 / undo export escaping so export → import round-trips
      const v = uncsvCell(cells[idx] ?? '');
      raw[d.field] = d.enumPrefix ? (enumValue(d.enumPrefix, v) ?? '') : v;
    }
    const errors: ImportReport['errors'] = [];

    // 负责人 / owner
    let ownerId: string | undefined;
    const ownerEmail = raw.ownerEmail?.trim().toLowerCase();
    if (ownerEmail) {
      ownerId = userByEmail.get(ownerEmail);
      if (!ownerId) errors.push({ row: rowNo, field: 'ownerEmail', reason: 'owner_not_found' });
      else if (ownerId !== ctx.userId && !can(ctx, 'owner.assign')) errors.push({ row: rowNo, field: 'ownerEmail', reason: 'owner_forbidden' });
    }

    const { contactName, contactTitle, contactPhone, contactEmail, ...rest } = raw;
    delete rest.ownerEmail;
    // 可选列空值视为 null；必填列保留空串，使校验报告“必填”而非“格式不正确”
    // empty optional cells become null; required cells stay '' so validation reports "required" rather than "invalid"
    const requiredFields = new Set(defs.filter((d) => d.required).map((d) => d.field));
    const cleaned: Record<string, unknown> = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === '' && !requiredFields.has(k) ? null : v]));
    if (entity === 'leads' && cleaned.status === null) delete cleaned.status;
    const parsed = (entity === 'leads' ? leadCreateSchema : accountCreateSchema).safeParse({ ...cleaned, ownerId: ownerId ?? undefined });
    if (!parsed.success) for (const issue of parsed.error.issues) errors.push({ row: rowNo, field: String(issue.path[0] ?? ''), reason: reasonOf(issue) });

    let contact: Record<string, unknown> | undefined;
    if (entity === 'accounts' && (contactName || contactTitle || contactPhone || contactEmail)) {
      const c = contactCreateSchema.safeParse({ name: contactName ?? '', title: contactTitle || null, phone: contactPhone || null, email: contactEmail || null, isPrimary: true });
      if (c.success) contact = c.data;
      else for (const issue of c.error.issues) errors.push({ row: rowNo, field: `contact.${String(issue.path[0] ?? '')}`, reason: reasonOf(issue) });
    }

    // 自定义字段：按类型校验；勾选接受是/否、yes/no、true/false、1/0；必填字段必须有值
    // custom fields: validated per type; checkboxes accept 是/否, yes/no, true/false, 1/0; required ones must have a value
    const custom: Record<string, unknown> = {};
    for (const { def, index } of customCols) {
      let raw: unknown = uncsvCell(cells[index] ?? '').trim();
      if (def.type === 'CHECKBOX' && raw !== '') {
        const v = String(raw).toLowerCase();
        raw = ['是', 'yes', 'true', '1'].includes(v) ? true : ['否', 'no', 'false', '0'].includes(v) ? false : raw;
      }
      try {
        const v = normalize(def, raw);
        if (v !== undefined) custom[def.key] = v;
      } catch {
        errors.push({ row: rowNo, field: def.label, reason: 'invalid_value' });
      }
    }
    for (const d of customDefs) if (d.required && custom[d.key] === undefined && !errors.some((e) => e.field === d.label)) errors.push({ row: rowNo, field: d.label, reason: 'required' });

    if (errors.length || !parsed.success) {
      report.errors.push(...errors);
      return;
    }
    const data: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>), custom };
    const key = entity === 'leads' ? (data.email as string | null)?.toLowerCase() : String(data.name).trim().toLowerCase();
    if (key && existing.has(key)) {
      report.duplicates.push({ row: rowNo, value: entity === 'leads' ? String(data.email) : String(data.name) });
      if (input.duplicates === 'skip') return;
    }
    if (key) existing.add(key); // 文件内重复也算重复 / duplicates within the file count too
    report.valid += 1;
    toCreate.push({ data, contact });
  });

  if (input.dryRun || toCreate.length === 0) return report;

  await prisma.$transaction(
    async (tx) => {
      const territoryOf = entity === 'accounts' ? await territoryMatcher(ctx.organizationId, tx) : null;
      for (const item of toCreate) {
        const { ownerId, ...data } = item.data as { ownerId?: string | null } & Record<string, unknown>;
        // 文件中指定的负责人优先；否则按规则（选择时）；最后归导入人 / the file's owner first, then the rules (when chosen), then the importer
        const assigned = !ownerId && input.owner === 'rules' ? await assignByRules(tx, ctx.organizationId, data as Record<string, string | null>) : null;
        const owner = ownerId ?? assigned?.ownerId ?? ctx.userId;
        if (entity === 'leads') {
          const lead = await tx.lead.create({ data: { ...(data as Omit<Prisma.LeadUncheckedCreateInput, 'organizationId'>), organizationId: ctx.organizationId, ownerId: owner } });
          await audit(tx, {
            ...by(ctx),
            action: 'lead.create',
            entityType: 'lead',
            entityId: lead.id,
            changes: { after: snapshot('lead', lead), via: 'lead.import', ...(assigned ? { assignmentRule: assigned.ruleName } : {}) },
          });
          if (assigned) report.assignedByRule += 1;
        } else {
          const account = await tx.account.create({
            data: { ...(data as Omit<Prisma.AccountUncheckedCreateInput, 'organizationId'>), ...territoryOf!({ ...data, ownerId: owner }), organizationId: ctx.organizationId, ownerId: owner },
          });
          await audit(tx, { ...by(ctx), action: 'account.create', entityType: 'account', entityId: account.id, changes: { after: snapshot('account', account), via: 'account.import' } });
          if (item.contact) {
            const c = await tx.contact.create({
              data: { ...(item.contact as Omit<Prisma.ContactUncheckedCreateInput, 'organizationId' | 'accountId'>), organizationId: ctx.organizationId, accountId: account.id },
            });
            await audit(tx, { ...by(ctx), action: 'contact.create', entityType: 'contact', entityId: c.id, changes: { after: snapshot('contact', c), via: 'account.import' } });
          }
        }
        report.created += 1;
      }
      const entityType = entity === 'leads' ? 'lead' : 'account';
      await audit(tx, {
        ...by(ctx),
        action: `${entityType}.import`,
        entityType,
        changes: {
          total: report.total,
          created: report.created,
          duplicates: report.duplicates.length,
          errors: report.errors.length,
          duplicatePolicy: input.duplicates,
          ...(input.owner === 'rules' ? { assignedByRule: report.assignedByRule } : {}),
        },
      });
    },
    { timeout: 120_000 },
  );
  return report;
}
