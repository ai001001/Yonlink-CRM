/**
 * 商机管理页：列表、搜索、阶段筛选、金额合计、新增/编辑、详情（含跟进记录）、删除。
 * Deals page: list, search, stage filter, totals, create/edit, detail (with activities), delete.
 */
'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { App, Button, Card, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Statistic, Table, Tabs, Tag, Typography } from 'antd';
import { PlusOutlined, StarOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { AuditTrail } from '@/components/AuditTrail';
import { DealBoard } from '@/components/DealBoard';
import { ScoreDetail, ScoreFilters, ScoreTag, ScoringRulesModal, useScoring } from '@/components/Scoring';
import { DealItemsPanel } from '@/components/DealItemsPanel';
import { DealQuotesPanel } from '@/components/DealQuotesPanel';
import { DealContactRolesPanel } from '@/components/DealContactRolesPanel';
import { DealCompetitorsPanel } from '@/components/DealCompetitorsPanel';
import { DealStageHistoryPanel } from '@/components/DealStageHistoryPanel';
import { NotesPanel } from '@/components/NotesPanel';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { usePermissions } from '@/components/AuthProvider';
import { BulkBar } from '@/components/BulkBar';
import { CampaignSelect } from '@/components/CampaignSelect';
import { SavedViews } from '@/components/SavedViews';
import { TagEditor, TagFilter, TagList, tagsOf } from '@/components/Tags';
import { ExportButton } from '@/components/ExportButton';
import { RecordSelect } from '@/components/RecordSelect';
import { RelatedActivities } from '@/components/RelatedActivities';
import { t, tEnum } from '@/i18n';
import { pickOptions, pickValues } from '@/lib/picklists';
import { api, ClientApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { toFormErrors, useOpenFromUrl, useOwners, usePagedList, useSearch, useSelection, type PageResult } from '@/lib/hooks';
import type { Deal } from '@/lib/types';
import { CustomFieldItems, CustomFieldValues, useCustomFields } from '@/components/CustomFields';
import { TerritoryFilter, useTerritoryOptions } from '@/components/Territories';
import { MacroRunner } from '@/components/Macros';
import { BlueprintPanel, useBlueprintStatus } from '@/components/Blueprint';
import { CadenceEnroller, CadencePanel } from '@/components/Cadences';

const DEAL_STAGES = ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'] as const;
const STAGE_COLOR: Record<string, string> = {
  QUALIFICATION: 'default',
  NEEDS_ANALYSIS: 'blue',
  PROPOSAL: 'cyan',
  NEGOTIATION: 'orange',
  CLOSED_WON: 'green',
  CLOSED_LOST: 'red',
};
const currencyOptions = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'].map((v) => ({ value: v, label: v }));

interface FormValues extends Omit<Partial<Deal>, 'expectedCloseDate'> {
  expectedCloseDate?: Dayjs | null;
}

export default function DealsPage() {
  const { message } = App.useApp();
  const owners = useOwners();
  const perm = usePermissions();
  const search = useSearch();
  const q = search.q;
  const [campaignId, setCampaignId] = useState<string>();
  const [tagId, setTagId] = useState<string>();
  const [view, setView] = useState<'list' | 'board'>('list');
  const [boardVersion, setBoardVersion] = useState(0);
  const [stage, setStage] = useState<string>();
  const [grade, setGrade] = useState<string>();
  const [sort, setSort] = useState<string>();
  const [territoryId, setTerritoryId] = useState<string>();
  const territoryItems = useTerritoryOptions();
  const { data, loading, reload, pagination } = usePagedList<Deal>('/api/deals', { q, stage, tagId, campaignId, grade, sort, territoryId });
  const scoring = useScoring('deal');
  const [scoringOpen, setScoringOpen] = useState(false);
  /** 套用视图（null 恢复列表默认筛选）/ apply a saved view (null resets the list filters) */
  const applyView = (f: Record<string, string> | null) => {
    search.set(f?.q ?? '');
    setStage(f?.stage);
    setTagId(f?.tagId);
    setTerritoryId(f?.territoryId);
  };
  const sel = useSelection(data.items, perm.can('record.update.own') || perm.canDelete);
  // 列表与看板一起刷新 / refresh both the list and the board
  const refresh = () => {
    void reload();
    setBoardVersion((v) => v + 1);
  };
  const sums = (data as PageResult<Deal> & { sums?: { currency: string; amount: string }[] }).sums ?? [];

  const [form] = Form.useForm<FormValues>();
  const customDefs = useCustomFields('DEAL');
  const [editing, setEditing] = useState<Deal | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Deal | null>(null);
  const blueprint = useBlueprintStatus('DEAL');
  /** 宏执行后递增，使详情内的面板重新加载 / bumped after a macro run so the detail panels reload */
  const [detailVersion, setDetailVersion] = useState(0);
  /** 重新读取详情并刷新列表（宏执行后）/ reload the detail and the list (after a macro run) */
  const refreshDetail = async (id: string) => {
    try {
      setDetail(await api<Deal>(`/api/deals/${id}`));
      setDetailVersion((v) => v + 1);
    } catch {
      setDetail(null);
    }
    void reload();
  };
  // 有产品明细时金额由明细计算、币种锁定 / with line items the amount is computed and the currency locked
  const amountLocked = editing !== null && editing !== 'new' && (editing._count?.lineItems ?? 0) > 0;

  useOpenFromUrl(
    useCallback(
      (id: string) => {
        api<Deal>(`/api/deals/${id}`)
          .then(setDetail)
          .catch((err: Error) => message.error(err.message));
      },
      [message],
    ),
  );

  const openForm = (deal: Deal | 'new') => {
    form.resetFields();
    if (deal !== 'new') form.setFieldsValue({ ...deal, expectedCloseDate: deal.expectedCloseDate ? dayjs(deal.expectedCloseDate.slice(0, 10)) : null });
    setEditing(deal);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = {
      ...v,
      amount: v.amount === undefined || v.amount === null ? '0' : String(v.amount),
      expectedCloseDate: v.expectedCloseDate ? v.expectedCloseDate.format('YYYY-MM-DD') : null,
    };
    setSaving(true);
    try {
      const saved =
        editing === 'new'
          ? await api<Deal>('/api/deals', { method: 'POST', body })
          : await api<Deal>(`/api/deals/${(editing as Deal).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      if (detail?.id === saved.id) setDetail(saved);
      refresh();
    } catch (err) {
      if (err instanceof ClientApiError) form.setFields(toFormErrors(err.details) as never);
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (deal: Deal) => {
    try {
      await api(`/api/deals/${deal.id}`, { method: 'DELETE' });
      message.success(t('recycle.moved', { days: 30 }));
      if (detail?.id === deal.id) setDetail(null);
      refresh();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.details?.salesOrders ? t('deals.hasOrders') : (err as Error).message);
    }
  };

  const isOverdue = (d: Deal) =>
    d.expectedCloseDate && !d.stage.startsWith('CLOSED') && dayjs(d.expectedCloseDate.slice(0, 10)).isBefore(dayjs(), 'day');

  return (
    <Card
      title={t('deals.title')}
      extra={
        <Space>
          <Button icon={<StarOutlined />} onClick={() => setScoringOpen(true)}>
            {t('scoring.title')}
          </Button>
          <ExportButton excel resource="deals" filters={{ q, stage, campaignId, grade, territoryId }} />
          {perm.canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
              {t('deals.new')}
            </Button>
          )}
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Space wrap>
          <Segmented
            value={view}
            onChange={(v) => setView(v as 'list' | 'board')}
            options={[
              { value: 'list', label: t('deals.viewList') },
              { value: 'board', label: t('deals.viewBoard') },
            ]}
          />
          {view === 'list' && <SavedViews entity="deals" filters={{ q, stage, tagId }} onApply={applyView} />}
          <Input.Search allowClear placeholder={t('deals.searchPlaceholder')} style={{ width: 280 }} {...search.inputProps} />
          {view === 'list' && <TagFilter value={tagId} onChange={setTagId} onManaged={() => refresh()} />}
          {view === 'list' && <TerritoryFilter items={territoryItems} value={territoryId} onChange={setTerritoryId} />}
          {view === 'list' && (
            <CampaignSelect aria-label={t('campaigns.filter')} placeholder={t('campaigns.filter')} style={{ width: 180 }} value={campaignId} onChange={(v) => setCampaignId(v ?? undefined)} />
          )}
          {view === 'list' && (
            <Select allowClear aria-label={t('deals.stage')} placeholder={t('deals.stage')} style={{ width: 140 }} options={pickOptions('dealStage', DEAL_STAGES)} value={stage} onChange={setStage} />
          )}
          {view === 'list' && <ScoreFilters grade={grade} onGrade={setGrade} sort={sort} onSort={setSort} />}
        </Space>
        {view === 'list' && (
          <Space size="large" data-testid="deal-sums">
            {sums.map((s) => (
              <Statistic key={s.currency} title={`${t('deals.sum')} (${s.currency})`} value={fmtMoney(s.amount, s.currency)} />
            ))}
          </Space>
        )}
      </Space>
      {view === 'board' && <DealBoard q={q} version={boardVersion} onOpen={setDetail} scoreConfig={scoring.config} />}
      {view === 'list' && (
        <BulkBar
          path="/api/deals"
          taggable
          macroEntity="DEAL"
          cadenceEntity="DEAL"
          selected={sel.selected}
          names={Object.fromEntries(data.items.map((r) => [r.id, r.name]))}
          valueChange={{ action: 'stage', field: 'stage', options: pickOptions('dealStage', DEAL_STAGES, 'active') }}
          onDone={() => {
            sel.clear();
            refresh();
          }}
          onClear={sel.clear}
        />
      )}
      {view === 'list' && (
        <Table<Deal>
          rowKey="id"
          rowSelection={sel.rowSelection}
          loading={loading}
          dataSource={data.items}
          pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
          columns={[
            {
              title: t('deals.name'),
              dataIndex: 'name',
              render: (v: string, r) => (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setDetail(r)}>
                  {v}
                </Button>
              ),
            },
            { title: t('deals.account'), render: (_, r) => r.account.name },
            { title: t('deals.amount'), dataIndex: 'amount', align: 'right', render: (v: string, r) => fmtMoney(v, r.currency) },
            { title: t('deals.stage'), dataIndex: 'stage', render: (v: string) => <Tag color={STAGE_COLOR[v]}>{tEnum('dealStage', v)}</Tag> },
            { title: t('scoring.score'), dataIndex: 'score', render: (v: number) => <ScoreTag score={v} config={scoring.config} /> },
            {
              title: t('deals.expectedCloseDate'),
              dataIndex: 'expectedCloseDate',
              render: (v: string | null, r) => <span style={isOverdue(r) ? { color: '#d4380d' } : undefined}>{fmtDate(v?.slice(0, 10))}</span>,
            },
            { title: t('tags.title'), render: (_, r) => <TagList tags={tagsOf(r)} /> },
            { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
            {
              title: t('common.actions'),
              render: (_, r) => (
                <Space>
                  {perm.canEdit(r) && (
                    <Button type="link" size="small" onClick={() => openForm(r)}>
                      {t('common.edit')}
                    </Button>
                  )}
                  {perm.canDelete && (
                    <Popconfirm title={t('recycle.confirmDelete')} onConfirm={() => remove(r)}>
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
      )}

      <Modal
        title={editing === 'new' ? t('deals.new') : t('deals.edit')}
        open={editing !== null}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        okText={t('common.save')}
        width={640}
        forceRender
        zIndex={1100}
      >
        <Form form={form} name="deal" layout="vertical" initialValues={{ stage: pickValues('dealStage', DEAL_STAGES.slice(0, 4), 'active')[0] ?? 'QUALIFICATION', currency: 'CNY' }}>
          <Form.Item
            name="name"
            label={t('deals.name')}
            rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('deals.name') }) }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="accountId" label={t('deals.account')} rules={[{ required: true, message: t('common.required', { field: t('deals.account') }) }]}>
            <RecordSelect resource="/api/accounts" initialLabel={editing && editing !== 'new' ? editing.account.name : undefined} />
          </Form.Item>
          <div className="form-row">
            <Form.Item
              name="amount"
              label={t('deals.amount')}
              rules={[{ pattern: /^\d{1,16}(\.\d{1,2})?$/, message: t('deals.invalidAmount') }]}
            >
              <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} disabled={amountLocked} />
            </Form.Item>
            <Form.Item name="currency" label={t('deals.currency')}>
              <Select options={currencyOptions} disabled={amountLocked} />
            </Form.Item>
          </div>
          {amountLocked && <Typography.Paragraph type="secondary">{t('items.amountLocked')}</Typography.Paragraph>}
          <div className="form-row">
            <Form.Item name="stage" label={t('deals.stage')} extra={blueprint && editing !== 'new' ? t('blueprints.lockedHint', { name: blueprint.name }) : undefined}>
              <Select options={pickOptions('dealStage', DEAL_STAGES, 'active', editing && editing !== 'new' ? editing.stage : null)} disabled={!!blueprint && editing !== 'new'} />
            </Form.Item>
            <Form.Item name="expectedCloseDate" label={t('deals.expectedCloseDate')}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
              <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            </Form.Item>
          </div>
          <Form.Item name="campaignId" label={t('campaigns.source')}>
            <CampaignSelect key={editing && editing !== 'new' ? editing.id : 'new'} />
          </Form.Item>
          <CustomFieldItems defs={customDefs} />
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detail ? `${t('deals.detail')} · ${detail.name}` : t('deals.detail')}
        // 9 个页签需一行放下：页签折叠到“…”菜单后点击不稳定 / 9 tabs must fit on one line: tab clicks are unreliable once tabs collapse into the “…” menu
        size={900}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail &&
          perm.canEdit(detail) && (
            <Space>
              <CadenceEnroller entity="DEAL" ids={[detail.id]} names={{ [detail.id]: detail.name }} onDone={() => void refreshDetail(detail.id)} />
              <MacroRunner entity="DEAL" ids={[detail.id]} names={{ [detail.id]: detail.name }} onDone={() => void refreshDetail(detail.id)} />
              <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>
            </Space>
          )
        }
      >
        {detail && (
          <Tabs
            key={detailVersion}
            items={[
              {
                key: 'profile',
                label: t('accounts.tabProfile'),
                children: (
                  <>
                    <CadencePanel entity="DEAL" id={detail.id} editable={perm.canEdit(detail)} version={detailVersion} />
                    <BlueprintPanel entity="DEAL" record={detail as unknown as { id: string } & Record<string, unknown>} onDone={() => void refreshDetail(detail.id)} />
                    <Descriptions column={2} bordered size="small">
                      <Descriptions.Item label={t('deals.name')} span={2}>
                        {detail.name}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('deals.account')}>{detail.account.name}</Descriptions.Item>
                      <Descriptions.Item label={t('deals.amount')}>{fmtMoney(detail.amount, detail.currency)}</Descriptions.Item>
                      <Descriptions.Item label={t('deals.stage')}>
                        <Tag color={STAGE_COLOR[detail.stage]}>{tEnum('dealStage', detail.stage)}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('scoring.score')} span={2}>
                        <Space orientation="vertical" size={4}>
                          <ScoreTag score={detail.score} config={scoring.config} />
                          <ScoreDetail entity="deal" id={detail.id} version={`${detail.updatedAt}:${detail.score}`} />
                        </Space>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('deals.expectedCloseDate')}>
                        {fmtDate(detail.expectedCloseDate?.slice(0, 10))}
                        {isOverdue(detail) && (
                          <Tag color="red" style={{ marginLeft: 8 }}>
                            {t('deals.overdueClose')}
                          </Tag>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
                      <Descriptions.Item label={t('campaigns.source')}>
                        {detail.campaign ? <Link href={`/campaigns?id=${detail.campaign.id}`}>{detail.campaign.name}</Link> : null}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
                      <Descriptions.Item label={t('tags.title')} span={2}>
                        <TagEditor key={`tags-${detail.id}`} path="/api/deals" record={detail} onChanged={() => refresh()} />
                      </Descriptions.Item>
                      <Descriptions.Item label={t('common.description')} span={2}>
                        {detail.description}
                      </Descriptions.Item>
                    </Descriptions>
                    <CustomFieldValues defs={customDefs} values={detail.custom} />
                  </>
                ),
              },
              {
                key: 'items',
                label: t('items.tab'),
                children: (
                  <DealItemsPanel
                    key={`items-${detail.id}`}
                    deal={detail}
                    onChanged={() => {
                      api<Deal>(`/api/deals/${detail.id}`)
                        .then(setDetail)
                        .catch(() => undefined);
                      refresh();
                    }}
                  />
                ),
              },
              {
                key: 'quotes',
                label: t('quotes.tab'),
                children: <DealQuotesPanel key={`quotes-${detail.id}`} deal={detail} />,
              },
              {
                key: 'contact-roles',
                label: t('contactRoles.tab'),
                children: <DealContactRolesPanel key={`roles-${detail.id}-${detail.accountId}`} deal={detail} />,
              },
              {
                key: 'competitors',
                label: t('competitors.tab'),
                children: <DealCompetitorsPanel key={`competitors-${detail.id}`} deal={detail} />,
              },
              {
                key: 'notes',
                label: t('notes.title'),
                children: <NotesPanel key={`notes-${detail.id}`} parent={{ dealId: detail.id }} ownerId={detail.ownerId} />,
              },
              {
                key: 'attachments',
                label: t('attachments.title'),
                children: <AttachmentsPanel key={`files-${detail.id}`} parent={{ dealId: detail.id }} ownerId={detail.ownerId} />,
              },
              { key: 'stage-history', label: t('stageHistory.tab'), children: <DealStageHistoryPanel key={`stages-${detail.id}`} dealId={detail.id} version={detail.updatedAt} /> },
              { key: 'activities', label: t('deals.tabActivities'), children: <RelatedActivities relation={{ dealId: detail.id }} /> },
              { key: 'audit', label: t('audit.trail'), children: <AuditTrail entityType="deal" entityId={detail.id} version={detail.updatedAt} /> },
            ]}
          />
        )}
      </Drawer>
      <ScoringRulesModal entity="deal" open={scoringOpen} onClose={() => setScoringOpen(false)} config={scoring.config} canManage={perm.can('scoring.manage')} onSaved={() => { scoring.reload(); refresh(); }} />
    </Card>
  );
}
