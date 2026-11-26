/**
 * 自定义报表页（分析 › 自定义报表）：
 * - 列表（自己的与共享的报表）；?id= 运行并查看报表（明细或汇总、图表、导出）；?edit=新建或报表 ID 打开构建器。
 * - 构建器：对象、分组（日期可按月/季/年）、明细列或汇总指标、筛选、排序、图表；可预览后保存，共享需 view.share。
 * Custom reports (Analytics › Custom reports): the list (own and shared); ?id= runs and shows a report (details or
 * summary, chart, export); ?edit=new or a report id opens the builder (module, grouping, columns or measures, filters,
 * sort, chart) with preview before saving; sharing needs view.share.
 */
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { App, Button, Card, Checkbox, Divider, Form, Input, Popconfirm, Result as AntResult, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { FilterValue, measureLabel, NO_VALUE, ReportResultView, useCatalog, type Catalog, type Definition, type Entity, type Filter, type Measure, type Result } from '@/components/CustomReport';
import { ExportButton } from '@/components/ExportButton';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

const ENTITIES: Entity[] = ['LEAD', 'ACCOUNT', 'DEAL', 'ACTIVITY'];

/** 已保存的报表 / a saved report */
interface Saved extends Definition {
  id: string;
  name: string;
  description: string | null;
  shared: boolean;
  ownerId: string;
  updatedAt: string;
  owner: { id: string; name: string };
}

/** 新报表的默认定义 / default definition of a new report */
const DEFAULT_COLUMNS: Record<Entity, string[]> = { LEAD: ['name', 'company', 'status', 'source'], ACCOUNT: ['name', 'industry', 'ownerId'], DEAL: ['name', 'accountId', 'amount', 'stage'], ACTIVITY: ['subject', 'type', 'dueAt'] };
const blank = (entity: Entity): Definition => ({ entity, columns: DEFAULT_COLUMNS[entity], filters: [], groupBy: null, measures: [], chart: 'NONE', sort: null });

/** 服务端定义错误转为提示 / server definition errors as a message */
function definitionError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  const codes = Object.values(d ?? {}).flat();
  if (codes.includes('single_currency')) return t('customReports.singleCurrency');
  if (codes.includes('group_required')) return t('customReports.groupRequired');
  if (d?.columns?.includes('required')) return t('customReports.columnsRequired');
  if (d?.name?.[0] === 'taken') return t('customReports.taken');
  return (err as Error).message;
}

/**
 * 报表列表。
 * The report list.
 */
function ReportList() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [items, setItems] = useState<Saved[]>([]);
  const load = useCallback(() => {
    api<{ items: Saved[] }>('/api/custom-reports')
      .then((r) => setItems(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);
  const remove = async (r: Saved) => {
    try {
      await api(`/api/custom-reports/${r.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };
  return (
    <Card
      title={t('customReports.title')}
      extra={
        <Link href="/custom-reports?edit=new">
          <Button type="primary" icon={<PlusOutlined />} data-testid="report-new">
            {t('customReports.new')}
          </Button>
        </Link>
      }
    >
      <Typography.Paragraph type="secondary">{t('customReports.hint')}</Typography.Paragraph>
      <Table<Saved>
        rowKey="id"
        dataSource={items}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('customReports.none') }}
        columns={[
          {
            title: t('customReports.name'),
            render: (_, r) => (
              <Space>
                <Link href={`/custom-reports?id=${r.id}`}>{r.name}</Link>
                {r.shared && <Tag color="blue">{t('customReports.shared')}</Tag>}
              </Space>
            ),
          },
          { title: t('customReports.entity'), render: (_, r) => t(`customReports.entity.${r.entity}` as MessageKey) },
          { title: t('customReports.owner'), render: (_, r) => r.owner.name },
          { title: t('customReports.updatedAt'), render: (_, r) => fmtDateTime(r.updatedAt) },
          {
            title: t('common.actions'),
            render: (_, r) => (
              <Space>
                {r.ownerId === perm.meId && <Link href={`/custom-reports?edit=${r.id}`}>{t('common.edit')}</Link>}
                {(r.ownerId === perm.meId || (r.shared && perm.can('view.share'))) && (
                  <Popconfirm title={t('customReports.confirmDelete', { name: r.name })} onConfirm={() => void remove(r)}>
                    <Button type="link" size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

/**
 * 查看并运行已保存的报表。
 * View and run a saved report.
 */
function ReportView({ id, catalog }: { id: string; catalog: Catalog }) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [report, setReport] = useState<Saved | null | 'missing'>(null);
  const [result, setResult] = useState<Result | null>(null);
  const run = useCallback(
    (page = 1, pageSize = 50) => {
      api<Result>(`/api/custom-reports/${id}/run?page=${page}&pageSize=${pageSize}`)
        .then(setResult)
        .catch((err: Error) => message.error(err.message));
    },
    [id, message],
  );
  useEffect(() => {
    api<Saved>(`/api/custom-reports/${id}`)
      .then((r) => {
        setReport(r);
        run();
      })
      .catch(() => setReport('missing'));
  }, [id, run]);
  if (report === 'missing') return <AntResult status="404" title={t('common.empty')} extra={<Link href="/custom-reports">{t('customReports.back')}</Link>} />;
  if (!report) return null;
  return (
    <Card
      title={report.name}
      extra={
        <Space>
          <Link href="/custom-reports">{t('customReports.back')}</Link>
          {report.ownerId === perm.meId && <Link href={`/custom-reports?edit=${report.id}`}>{t('common.edit')}</Link>}
          <ExportButton resource={`custom-reports/${report.id}`} fileName="report" filters={{}} excel />
        </Space>
      }
    >
      {report.description && <Typography.Paragraph type="secondary">{report.description}</Typography.Paragraph>}
      {result && <ReportResultView catalog={catalog} definition={report} result={result} onPage={(p, s) => run(p, s)} />}
    </Card>
  );
}

/**
 * 报表构建器（新建或修改）。
 * The report builder (create or edit).
 */
function ReportBuilder({ id, catalog }: { id: string | null; catalog: Catalog }) {
  const { message } = App.useApp();
  const router = useRouter();
  const perm = usePermissions();
  const [def, setDef] = useState<Definition>(blank('DEAL'));
  const [meta, setMeta] = useState<{ name: string; description: string; shared: boolean }>({ name: '', description: '', shared: false });
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return;
    api<Saved>(`/api/custom-reports/${id}`)
      .then((r) => {
        setDef({ entity: r.entity, columns: r.columns, filters: r.filters, groupBy: r.groupBy, measures: r.measures, chart: r.chart, sort: r.sort });
        setMeta({ name: r.name, description: r.description ?? '', shared: r.shared });
      })
      .catch((err: Error) => message.error(err.message));
  }, [id, message]);

  const fields = catalog.fields[def.entity];
  const fieldOptions = (types?: string[]) => Object.entries(fields).filter(([, f]) => !types || types.includes(f.type)).map(([k, f]) => ({ value: k, label: t(f.label) }));
  const set = (patch: Partial<Definition>) => {
    setDef((d) => ({ ...d, ...patch }));
    setResult(null);
  };
  const setFilter = (i: number, patch: Partial<Filter>) => set({ filters: def.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const setMeasure = (i: number, patch: Partial<Measure>) => set({ measures: def.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  // 提交前清理：分组报表不保存明细列与排序，明细报表不保存指标与图表 / tidy before sending
  const payload = (): Definition => (def.groupBy ? { ...def, columns: [], sort: null } : { ...def, measures: [], chart: 'NONE' });

  const preview = async (page = 1, pageSize = 50) => {
    setBusy(true);
    try {
      setResult(await api<Result>(`/api/custom-reports/run?page=${page}&pageSize=${pageSize}`, { method: 'POST', body: payload() }));
    } catch (err) {
      message.error(definitionError(err));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!meta.name.trim()) return message.error(t('common.required', { field: t('customReports.name') }));
    setBusy(true);
    try {
      const body = { ...payload(), name: meta.name, description: meta.description || null, shared: meta.shared };
      const saved = id ? await api<Saved>(`/api/custom-reports/${id}`, { method: 'PUT', body }) : await api<Saved>('/api/custom-reports', { method: 'POST', body });
      message.success(t('common.saved'));
      router.push(`/custom-reports?id=${saved.id}`);
    } catch (err) {
      message.error(definitionError(err));
    } finally {
      setBusy(false);
    }
  };

  const gdef = def.groupBy ? fields[def.groupBy.field] : undefined;
  return (
    <Card
      title={id ? t('customReports.edit') : t('customReports.new')}
      extra={
        <Space>
          <Link href="/custom-reports">{t('customReports.back')}</Link>
          <Button onClick={() => void preview()} loading={busy} data-testid="report-preview">
            {t('customReports.preview')}
          </Button>
          <Button type="primary" onClick={() => void save()} loading={busy} data-testid="report-save">
            {t('common.save')}
          </Button>
        </Space>
      }
    >
      <Form layout="vertical" name="custom-report">
        <div className="form-row">
          <Form.Item label={t('customReports.name')} required>
            <Input maxLength={100} value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} aria-label={t('customReports.name')} />
          </Form.Item>
          <Form.Item label={t('customReports.entity')}>
            <Select
              disabled={!!id}
              aria-label={t('customReports.entity')}
              value={def.entity}
              onChange={(e: Entity) => {
                setDef(blank(e));
                setResult(null);
              }}
              options={ENTITIES.map((e) => ({ value: e, label: t(`customReports.entity.${e}` as MessageKey) }))}
            />
          </Form.Item>
          <Form.Item label={t('customReports.groupBy')}>
            <Select
              aria-label={t('customReports.groupBy')}
              value={def.groupBy?.field ?? ''}
              onChange={(v: string) => set(v ? { groupBy: { field: v, unit: fields[v]?.type === 'date' ? 'month' : null } } : { groupBy: null, measures: [], chart: 'NONE' })}
              options={[{ value: '', label: t('customReports.noGroup') }, ...fieldOptions(catalog.groupable)]}
            />
          </Form.Item>
          {gdef?.type === 'date' && (
            <Form.Item label={t('customReports.unit')}>
              <Select aria-label={t('customReports.unit')} value={def.groupBy!.unit ?? 'month'} onChange={(unit) => set({ groupBy: { ...def.groupBy!, unit } })} options={(['month', 'quarter', 'year'] as const).map((u) => ({ value: u, label: t(`customReports.unit.${u}`) }))} />
            </Form.Item>
          )}
        </div>
        <Form.Item label={t('customReports.description')}>
          <Input.TextArea rows={1} maxLength={500} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
        </Form.Item>
        {perm.can('view.share') && (
          <Form.Item>
            <Checkbox checked={meta.shared} onChange={(e) => setMeta({ ...meta, shared: e.target.checked })}>
              {t('customReports.shared')}
            </Checkbox>
          </Form.Item>
        )}
        {def.groupBy ? (
          <>
            <Divider titlePlacement="start">{t('customReports.measures')}</Divider>
            {def.measures.map((m, i) => (
              <Space key={i} wrap style={{ marginBottom: 8 }}>
                <Select aria-label={`${t('customReports.measures')} ${i + 1}`} style={{ width: 120 }} value={m.fn} onChange={(fn) => setMeasure(i, { fn })} options={(['SUM', 'AVG', 'MIN', 'MAX'] as const).map((f) => ({ value: f, label: t(`customReports.fn.${f}`) }))} />
                <Select aria-label={`${t('customReports.field')} ${i + 1}`} style={{ width: 180 }} value={m.field} onChange={(field) => setMeasure(i, { field })} options={fieldOptions(catalog.measurable)} />
                <Button icon={<DeleteOutlined />} aria-label={`${t('common.delete')} ${measureLabel(fields[m.field], m)}`} onClick={() => set({ measures: def.measures.filter((_, j) => j !== i) })} />
              </Space>
            ))}
            {def.measures.length < 3 && fieldOptions(catalog.measurable).length > 0 && (
              <div>
                <Button icon={<PlusOutlined />} onClick={() => set({ measures: [...def.measures, { fn: 'SUM', field: fieldOptions(catalog.measurable)[0]!.value }] })} data-testid="report-add-measure">
                  {t('customReports.addMeasure')}
                </Button>
              </div>
            )}
            <Form.Item label={t('customReports.chart')} style={{ marginTop: 12 }}>
              <Select aria-label={t('customReports.chart')} style={{ width: 180 }} value={def.chart} onChange={(chart) => set({ chart })} options={(['NONE', 'BAR', 'COLUMN'] as const).map((c) => ({ value: c, label: t(`customReports.chart.${c}`) }))} />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item label={t('customReports.columns')}>
              <Select mode="multiple" aria-label={t('customReports.columns')} value={def.columns} maxCount={15} onChange={(columns) => set({ columns })} options={fieldOptions()} />
            </Form.Item>
            <Form.Item label={t('customReports.sort')}>
              <Space wrap>
                <Select aria-label={t('customReports.sort')} allowClear style={{ width: 180 }} value={def.sort?.field} onChange={(field?: string) => set({ sort: field ? { field, dir: def.sort?.dir ?? 'asc' } : null })} options={fieldOptions(catalog.sortable)} />
                {def.sort && <Select aria-label={`${t('customReports.sort')} ${t('customReports.sortAsc')}`} style={{ width: 120 }} value={def.sort.dir} onChange={(dir) => set({ sort: { ...def.sort!, dir } })} options={[{ value: 'asc', label: t('customReports.sortAsc') }, { value: 'desc', label: t('customReports.sortDesc') }]} />}
              </Space>
            </Form.Item>
          </>
        )}
        <Divider titlePlacement="start">{t('customReports.filters')}</Divider>
        {def.filters.map((f, i) => {
          const fdef = fields[f.field];
          return (
            <Space key={i} wrap style={{ marginBottom: 8 }} data-testid="report-filter">
              <Select aria-label={`${t('customReports.field')} ${t('customReports.filters')} ${i + 1}`} style={{ width: 180 }} value={f.field} onChange={(field: string) => setFilter(i, { field, op: catalog.ops[fields[field]!.type][0]!, value: null })} options={fieldOptions()} />
              {fdef && <Select aria-label={`${t('customReports.op')} ${i + 1}`} style={{ width: 150 }} value={f.op} onChange={(op: string) => setFilter(i, { op, value: NO_VALUE.has(op) ? null : f.value })} options={catalog.ops[fdef.type].map((o) => ({ value: o, label: t(`customReports.op.${o}` as MessageKey) }))} />}
              {fdef && <FilterValue def={fdef} op={f.op} value={f.value} onChange={(value) => setFilter(i, { value })} label={`${t('customReports.value')} ${i + 1}`} />}
              <Button icon={<DeleteOutlined />} aria-label={`${t('common.delete')} ${t('customReports.filters')} ${i + 1}`} onClick={() => set({ filters: def.filters.filter((_, j) => j !== i) })} />
            </Space>
          );
        })}
        {def.filters.length < 10 && (
          <div>
            <Button
              icon={<PlusOutlined />}
              onClick={() => {
                const field = Object.keys(fields)[0]!;
                set({ filters: [...def.filters, { field, op: catalog.ops[fields[field]!.type][0]!, value: null }] });
              }}
              data-testid="report-add-filter"
            >
              {t('customReports.addFilter')}
            </Button>
          </div>
        )}
      </Form>
      {result && (
        <>
          <Divider titlePlacement="start">{t('customReports.preview')}</Divider>
          <ReportResultView catalog={catalog} definition={payload()} result={result} onPage={(p, s) => void preview(p, s)} />
        </>
      )}
    </Card>
  );
}

/**
 * 按地址参数显示列表、报表或构建器。
 * Show the list, a report or the builder by URL parameters.
 */
function CustomReportsInner() {
  const params = useSearchParams();
  const catalog = useCatalog();
  const id = params.get('id');
  const edit = params.get('edit');
  if (!catalog) return null;
  if (edit) return <ReportBuilder key={edit} id={edit === 'new' ? null : edit} catalog={catalog} />;
  if (id) return <ReportView key={id} id={id} catalog={catalog} />;
  return <ReportList />;
}

export default function CustomReportsPage() {
  return (
    <Suspense>
      <CustomReportsInner />
    </Suspense>
  );
}
