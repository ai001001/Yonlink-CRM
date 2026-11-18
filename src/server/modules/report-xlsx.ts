/**
 * 报表导出 Excel（.xlsx）：销售报表、销售预测、应收账款。与 CSV 导出使用同一报表计算，数字与页面一致；需导出权限，写审计
 * （记录格式为 xlsx）。与 CSV 相比：
 * - 销售报表按板块分为多个工作表（概览、销售漏斗、按月赢单、负责人排行、线索来源、报价单、竞争对手）；
 * - 金额、数量、比率是真正的数字单元格（金额千分位两位小数、比率显示 %），可直接求和、排序、做图表；
 * - 表头加粗并冻结，列宽按内容设置；合计行加粗。
 * 表头与枚举文字随语言参数（lang）。
 * Report exports as Excel (.xlsx): sales report, forecast and receivables, using the same calculations as the CSV exports
 * so figures match the pages; export permission required, audited with format xlsx. Compared with CSV, the sales report
 * is split into one sheet per section; amounts, counts and rates are real numeric cells (money with separators and two
 * decimals, rates shown with %) ready for sums, sorting and charts; headers are bold and frozen, columns sized to content,
 * totals bold. Headers and labels follow the lang parameter.
 */
import { translate, type MessageKey } from '@/i18n';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { prisma } from '../db';
import { requirePermission } from '../permissions';
import { toXlsx, type Cell, type Sheet } from '../xlsx';
import { forecastQuerySchema, getForecast } from './forecasts';
import { EXPORT_MAX, parseLang } from './import-export';
import { receivablesQuerySchema, receivablesReport } from './receivables';
import { auditReport, localeTools } from './report-exports';
import { reportQuerySchema, salesReport } from './reports';

/** Excel 导出结果 / Excel export result */
export interface XlsxExport {
  filename: string;
  data: Buffer;
  count: number;
  truncated: boolean;
}

/** 金额单元格（字符串或数字，空值留空）/ money cell (string or number; empty stays empty) */
const money = (v: string | number | null | undefined): Cell => (v === null || v === undefined || v === '' ? null : { value: Number(v), format: 'money' });
/** 整数单元格 / integer cell */
const int = (v: number | null | undefined): Cell => (v === null || v === undefined ? null : { value: v, format: 'int' });
/** 比率单元格（已是百分数，如 45.5 表示 45.5%）/ rate cell (already a percentage, e.g. 45.5 means 45.5%) */
const rate = (v: number | null | undefined): Cell => (v === null || v === undefined ? null : { value: v, format: 'percent' });

/**
 * 一个“表头 + 数据”的工作表，表头加粗并冻结；可在表头前放几行说明（标题加粗）。
 * A sheet with a bold, frozen header row, optionally preceded by a few description rows (title bold).
 */
function table(name: string, header: string[], rows: Cell[][], intro: Cell[][] = [], boldRows: number[] = []): Sheet {
  const lead = intro.length ? [...intro, []] : [];
  const headerRow = lead.length;
  return {
    name,
    rows: [...lead, header, ...rows],
    boldRows: [...(intro.length ? [0] : []), headerRow, ...boldRows.map((r) => r + headerRow + 1)],
    freezeRows: headerRow + 1,
  };
}

/**
 * 导出销售报表 Excel（每个板块一个工作表）。
 * Export the sales report as Excel (one sheet per section).
 */
export async function exportSalesReportXlsx(ctx: AuthContext, input: Record<string, string>): Promise<XlsxExport> {
  requirePermission(ctx, 'data.export');
  const { lang, ...params } = input;
  const { t, tEnum, percent } = localeTools(lang);
  const query = reportQuerySchema.parse(params);
  const r = await salesReport(ctx, query);
  const owner = query.ownerId ? ((await prisma.user.findFirst({ where: { id: query.ownerId, organizationId: ctx.organizationId }, select: { name: true } }))?.name ?? '') : t('reports.allOwners');
  const s = r.summary;
  const intro: Cell[][] = [[t('reports.title')], [t('reports.currency'), r.currency], [t('reports.period'), `${r.from} ~ ${r.to}`], [t('reports.owner'), owner]];
  const sheets: Sheet[] = [
    table(
      t('reportExport.summary'),
      [t('reportExport.metric'), t('reportExport.value')],
      [
        [t('reports.openAmount'), money(s.openAmount)],
        [t('reports.col.openCount'), int(s.openCount)],
        [t('reports.wonAmount'), money(s.wonAmount)],
        [t('reports.col.wonCount'), int(s.wonCount)],
        [t('reportExport.lostAmount'), money(s.lostAmount)],
        [t('reports.col.lostCount'), int(s.lostCount)],
        [percent('reports.winRate'), rate(s.winRate)],
        [t('reports.col.leads'), int(s.leadTotal)],
        [t('reports.col.converted'), int(s.leadConverted)],
        [percent('reports.leadConversion'), rate(s.leadConversionRate)],
        [percent('reports.quoteAcceptance'), rate(s.quoteAcceptanceRate)],
      ],
      intro,
    ),
    table(t('reports.funnel'), [t('reportExport.stage'), t('reports.col.count'), t('reports.col.amount')], r.funnel.map((f) => [tEnum('dealStage', f.stage), int(f.count), money(f.amount)])),
    table(
      t('reportExport.monthly'),
      [t('reportExport.month'), t('reports.col.wonCount'), t('reports.col.wonAmount'), t('reports.col.lostCount')],
      r.monthly.map((m) => [m.month, int(m.wonCount), money(m.wonAmount), int(m.lostCount)]),
    ),
    table(
      t('reports.owners'),
      [t('reports.owner'), t('reports.col.openCount'), t('reports.col.openAmount'), t('reports.col.wonCount'), t('reports.col.wonAmount'), t('reports.col.lostCount'), percent('reports.col.winRate'), t('reports.col.activities')],
      r.owners.map((o) => [o.name ?? t('reports.unassigned'), int(o.openCount), money(o.openAmount), int(o.wonCount), money(o.wonAmount), int(o.lostCount), rate(o.winRate), int(o.activities)]),
    ),
    table(
      t('reports.leadSources'),
      [t('reports.col.source'), t('reports.col.leads'), t('reports.col.converted'), percent('reports.col.conversionRate')],
      r.leadSources.map((l) => [l.source ? tEnum('leadSource', l.source) : t('reports.noSource'), int(l.total), int(l.converted), rate(l.conversionRate)]),
    ),
    table(t('reports.quotes'), [t('reportExport.status'), t('reports.col.count'), t('reports.col.amount')], r.quotes.map((q) => [tEnum('quoteStatus', q.status), int(q.count), money(q.amount)])),
    table(
      t('reports.competitors'),
      [t('competitors.name'), t('reports.col.openCount'), t('reports.col.wonCount'), t('reports.col.lostCount'), t('reportExport.lostAmount'), percent('reports.col.winRate')],
      r.competitors.map((c) => [c.name, int(c.openCount), int(c.wonCount), int(c.lostCount), money(c.lostAmount), rate(c.winRate)]),
    ),
  ];
  const rows = sheets.reduce((n, sh) => n + sh.rows.length, 0);
  await auditReport(ctx, 'sales', { currency: r.currency, from: r.from, to: r.to, ownerId: query.ownerId, format: 'xlsx' }, rows);
  return { filename: `sales-report-${r.currency}-${r.from.replace(/-/g, '')}-${r.to.replace(/-/g, '')}.xlsx`, data: toXlsx(sheets), count: rows, truncated: false };
}

/**
 * 导出销售预测 Excel（按负责人一行，合计行加粗）。
 * Export the forecast as Excel (one row per owner, bold total row).
 */
export async function exportForecastXlsx(ctx: AuthContext, input: Record<string, string>): Promise<XlsxExport> {
  requirePermission(ctx, 'data.export');
  const { lang, ...params } = input;
  const { t, percent } = localeTools(lang);
  const query = forecastQuerySchema.parse(params);
  const f = await getForecast(ctx, query);
  const line = (name: string, r: (typeof f.rows)[number]): Cell[] => [
    name,
    money(r.target),
    money(r.won),
    int(r.wonCount),
    rate(r.attainment),
    money(r.gap),
    money(r.open),
    int(r.openCount),
    money(r.weighted),
    money(r.forecast),
    rate(r.forecastAttainment),
    money(r.bestCase),
  ];
  const sheet = table(
    t('forecasts.title'),
    [
      t('forecasts.owner'),
      t('forecasts.target'),
      t('forecasts.won'),
      t('reports.col.wonCount'),
      percent('forecasts.attainment'),
      t('forecasts.gap'),
      t('forecasts.open'),
      t('reportExport.openCount'),
      t('forecasts.weighted'),
      t('forecasts.forecast'),
      percent('forecasts.forecastAttainment'),
      t('forecasts.bestCase'),
    ],
    [...f.rows.map((r) => line(r.name ?? t('forecasts.unassigned'), r)), line(t('forecasts.total'), f.totals)],
    [[t('forecasts.title')], [t('forecasts.period'), f.period], [t('reports.currency'), f.currency]],
    [f.rows.length],
  );
  await auditReport(ctx, 'forecast', { period: f.period, currency: f.currency, format: 'xlsx' }, f.rows.length);
  return { filename: `forecast-${f.currency}-${f.period}.xlsx`, data: toXlsx([sheet]), count: f.rows.length, truncated: false };
}

/**
 * 导出应收账款 Excel：汇总（未收、逾期、近 30 天收款、账龄分布）、按客户汇总、未收发票明细三个工作表。
 * Export receivables as Excel: summary (outstanding, overdue, collected, aging), by account, and open invoices.
 * @param now 统计时间（测试用）/ reference time (for tests)
 * @param limit 明细最多行数 / max invoice rows
 */
export async function exportReceivablesXlsx(ctx: AuthContext, input: Record<string, string>, now = new Date(), limit = EXPORT_MAX): Promise<XlsxExport> {
  requirePermission(ctx, 'data.export');
  const { lang, ...params } = input;
  const locale = parseLang(lang);
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
  const query = receivablesQuerySchema.parse(params);
  const r = await receivablesReport(ctx, query, now, limit);
  const s = r.summary;
  const summary = table(
    t('reportExport.summary'),
    [t('reportExport.metric'), t('reportExport.value'), t('receivables.invoices')],
    [
      [t('receivables.outstanding'), money(s.outstanding), int(s.outstandingCount)],
      [t('receivables.overdue'), money(s.overdue), int(s.overdueCount)],
      [t('receivables.collected'), money(s.collected), int(s.collectedCount)],
      [],
      [t('receivables.aging')],
      ...r.buckets.map((b) => [t(`receivables.bucket.${b.bucket}` as MessageKey), money(b.amount), int(b.count)]),
    ],
    [[t('receivables.title')], [t('reports.currency'), r.currency], [t('xlsx.asOf'), r.asOf]],
    [4],
  );
  const byAccount = table(
    t('receivables.byAccount'),
    [t('quotes.account'), t('receivables.outstanding'), t('receivables.invoices'), t('receivables.oldestDue'), t('receivables.daysOverdueHeader')],
    r.accounts.map((a) => [a.name, money(a.outstanding), int(a.count), a.oldestDueDate, int(a.maxDaysOverdue)]),
  );
  const invoices = table(
    t('receivables.openInvoices'),
    [
      t('invoices.number'),
      t('quotes.account'),
      t('reports.owner'),
      t('invoices.invoiceDate'),
      t('invoices.dueDate'),
      t('invoices.total'),
      t('invoices.paidAmount'),
      t('invoices.balance'),
      t('receivables.daysOverdueHeader'),
      t('receivables.agingColumn'),
    ],
    r.invoices.map((i) => [
      i.invoiceNumber,
      i.account.name,
      i.owner?.name,
      i.invoiceDate.toISOString().slice(0, 10),
      i.dueDate.toISOString().slice(0, 10),
      money(i.total.toString()),
      money(i.paidAmount.toString()),
      money(i.balance.toString()),
      int(i.daysOverdue),
      t(`receivables.bucket.${i.bucket}` as MessageKey),
    ]),
  );
  const count = r.invoices.length;
  await prisma.$transaction((tx) =>
    audit(tx, {
      ...by(ctx),
      action: 'invoice.export',
      entityType: 'invoice',
      changes: { report: 'receivables', format: 'xlsx', count, truncated: r.truncated, filters: { currency: query.currency, ...(query.ownerId ? { ownerId: query.ownerId } : {}) } },
    }),
  );
  return { filename: `receivables-${r.currency}-${r.asOf.replace(/-/g, '')}.xlsx`, data: toXlsx([summary, byAccount, invoices]), count, truncated: r.truncated };
}
