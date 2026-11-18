/**
 * 报表导出 CSV（销售报表、销售预测）：直接复用报表计算，数字与页面一致；需导出权限，写审计（report.export）。
 * - 销售报表：一个文件按板块分段（概览、销售漏斗、按月赢单、负责人排行、线索来源转化、报价单状态），每段一行标题，段间空一行。
 * - 销售预测：按负责人一行，最后一行为团队合计。
 * - 金额为不带货币符号的两位小数；比率为数字（表头带 %），无数据时留空；表头与枚举文字随语言参数（lang）。
 * Report CSV exports (sales report and forecast) reusing the report calculations so figures match the pages; export
 * permission required, audited as report.export. The sales report is one file split into titled sections separated by
 * a blank line; the forecast has one row per owner plus a team total. Amounts are plain two-decimal numbers; rates are
 * numbers (header marked %) or empty; headers and labels follow the lang parameter.
 */
import { tEnumIn, translate, type MessageKey } from '@/i18n';
import { audit, by } from '../audit';
import type { AuthContext } from '../auth';
import { toCsv } from '../csv';
import { prisma } from '../db';
import { requirePermission } from '../permissions';
import { forecastQuerySchema, getForecast } from './forecasts';
import { parseLang, type ExportResult } from './import-export';
import { reportQuerySchema, salesReport } from './reports';

/** 可导出的报表 / exportable reports */
export type ReportName = 'sales' | 'forecast';

/**
 * 记录报表导出审计（只记报表名、筛选与行数）。
 * Audit a report export (report name, filters and row count only).
 */
export async function auditReport(ctx: AuthContext, report: ReportName, filters: Record<string, unknown>, rows: number) {
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));
  await prisma.$transaction((tx) => audit(tx, { ...by(ctx), action: 'report.export', entityType: 'report', changes: { report, filters: clean, rows } }));
}

/** 比率显示（null 为空）/ rate cell (empty when null) */
const pct = (v: number | null) => (v === null ? '' : v);

/** 语言工具 / locale helpers */
export function localeTools(lang: string | undefined) {
  const locale = parseLang(lang);
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
  const tEnum = (prefix: string, value: string | null | undefined) => tEnumIn(locale, prefix, value);
  const percent = (key: MessageKey) => `${t(key)} %`;
  return { t, tEnum, percent };
}

/**
 * 导出销售报表 CSV。
 * Export the sales report as CSV.
 * @param input 查询参数（currency、from、to、ownerId、lang）/ query parameters
 */
export async function exportSalesReport(ctx: AuthContext, input: Record<string, string>): Promise<ExportResult> {
  requirePermission(ctx, 'data.export');
  const { lang, ...params } = input;
  const { t, tEnum, percent } = localeTools(lang);
  const query = reportQuerySchema.parse(params);
  const r = await salesReport(ctx, query);
  const owner = query.ownerId ? ((await prisma.user.findFirst({ where: { id: query.ownerId, organizationId: ctx.organizationId }, select: { name: true } }))?.name ?? '') : t('reports.allOwners');
  const s = r.summary;
  const rows: unknown[][] = [
    [t('reports.currency'), r.currency],
    [t('reports.period'), `${r.from} ~ ${r.to}`],
    [t('reports.owner'), owner],
    [],
    [t('reportExport.summary')],
    [t('reportExport.metric'), t('reportExport.value')],
    [t('reports.openAmount'), s.openAmount],
    [t('reports.col.openCount'), s.openCount],
    [t('reports.wonAmount'), s.wonAmount],
    [t('reports.col.wonCount'), s.wonCount],
    [t('reportExport.lostAmount'), s.lostAmount],
    [t('reports.col.lostCount'), s.lostCount],
    [percent('reports.winRate'), pct(s.winRate)],
    [t('reports.col.leads'), s.leadTotal],
    [t('reports.col.converted'), s.leadConverted],
    [percent('reports.leadConversion'), pct(s.leadConversionRate)],
    [percent('reports.quoteAcceptance'), pct(s.quoteAcceptanceRate)],
    [],
    [t('reports.funnel')],
    [t('reportExport.stage'), t('reports.col.count'), t('reports.col.amount')],
    ...r.funnel.map((f) => [tEnum('dealStage', f.stage), f.count, f.amount]),
    [],
    [t('reportExport.monthly')],
    [t('reportExport.month'), t('reports.col.wonCount'), t('reports.col.wonAmount'), t('reports.col.lostCount')],
    ...r.monthly.map((m) => [m.month, m.wonCount, m.wonAmount, m.lostCount]),
    [],
    [t('reports.owners')],
    [t('reports.owner'), t('reports.col.openCount'), t('reports.col.openAmount'), t('reports.col.wonCount'), t('reports.col.wonAmount'), t('reports.col.lostCount'), percent('reports.col.winRate'), t('reports.col.activities')],
    ...r.owners.map((o) => [o.name ?? t('reports.unassigned'), o.openCount, o.openAmount, o.wonCount, o.wonAmount, o.lostCount, pct(o.winRate), o.activities]),
    [],
    [t('reports.leadSources')],
    [t('reports.col.source'), t('reports.col.leads'), t('reports.col.converted'), percent('reports.col.conversionRate')],
    ...r.leadSources.map((l) => [l.source ? tEnum('leadSource', l.source) : t('reports.noSource'), l.total, l.converted, pct(l.conversionRate)]),
    [],
    [t('reports.quotes')],
    [t('reportExport.status'), t('reports.col.count'), t('reports.col.amount')],
    ...r.quotes.map((q) => [tEnum('quoteStatus', q.status), q.count, q.amount]),
    [],
    [t('reports.competitors')],
    [t('competitors.name'), t('reports.col.openCount'), t('reports.col.wonCount'), t('reports.col.lostCount'), t('reportExport.lostAmount'), percent('reports.col.winRate')],
    ...r.competitors.map((c) => [c.name, c.openCount, c.wonCount, c.lostCount, c.lostAmount, pct(c.winRate)]),
  ];
  const csv = toCsv([t('reports.title')], rows);
  await auditReport(ctx, 'sales', { currency: r.currency, from: r.from, to: r.to, ownerId: query.ownerId }, rows.length);
  return { filename: `sales-report-${r.currency}-${r.from.replace(/-/g, '')}-${r.to.replace(/-/g, '')}.csv`, csv, count: rows.length, truncated: false };
}

/**
 * 导出销售预测 CSV。
 * Export the forecast as CSV.
 * @param input 查询参数（period、currency、lang）/ query parameters
 */
export async function exportForecast(ctx: AuthContext, input: Record<string, string>): Promise<ExportResult> {
  requirePermission(ctx, 'data.export');
  const { lang, ...params } = input;
  const { t, percent } = localeTools(lang);
  const query = forecastQuerySchema.parse(params);
  const f = await getForecast(ctx, query);
  const line = (name: string, r: (typeof f.rows)[number]) => [
    name,
    r.target ?? '',
    r.won,
    r.wonCount,
    pct(r.attainment),
    r.gap ?? '',
    r.open,
    r.openCount,
    r.weighted,
    r.forecast,
    pct(r.forecastAttainment),
    r.bestCase,
  ];
  const csv = toCsv(
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
  );
  await auditReport(ctx, 'forecast', { period: f.period, currency: f.currency }, f.rows.length);
  return { filename: `forecast-${f.currency}-${f.period}.csv`, csv, count: f.rows.length, truncated: false };
}
