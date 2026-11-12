/**
 * 商机管理页：列表、搜索、阶段筛选、金额合计、新增/编辑、详情（含跟进记录）、删除。
 * Deals page: list, search, stage filter, totals, create/edit, detail (with activities), delete.
 */
'use client';

import { useCallback, useState } from 'react';
import { App, Button, Card, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Statistic, Table, Tabs, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { AuditTrail } from '@/components/AuditTrail';
import { DealBoard } from '@/components/DealBoard';
import { NotesPanel } from '@/components/NotesPanel';
import { usePermissions } from '@/components/AuthProvider';
import { BulkBar } from '@/components/BulkBar';
import { ExportButton } from '@/components/ExportButton';
import { RecordSelect } from '@/components/RecordSelect';
import { RelatedActivities } from '@/components/RelatedActivities';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { toFormErrors, useOpenFromUrl, useOwners, usePagedList, useSelection, type PageResult } from '@/lib/hooks';
import type { Deal } from '@/lib/types';

const DEAL_STAGES = ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'] as const;
const STAGE_COLOR: Record<string, string> = {
  QUALIFICATION: 'default',
  NEEDS_ANALYSIS: 'blue',
  PROPOSAL: 'cyan',
  NEGOTIATION: 'orange',
  CLOSED_WON: 'green',
  CLOSED_LOST: 'red',
};
const stageOptions = DEAL_STAGES.map((v) => ({ value: v, label: tEnum('dealStage', v) }));
const currencyOptions = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'].map((v) => ({ value: v, label: v }));

interface FormValues extends Omit<Partial<Deal>, 'expectedCloseDate'> {
  expectedCloseDate?: Dayjs | null;
}

export default function DealsPage() {
  const { message } = App.useApp();
  const owners = useOwners();
  const perm = usePermissions();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [boardVersion, setBoardVersion] = useState(0);
  const [stage, setStage] = useState<string>();
  const { data, loading, reload, pagination } = usePagedList<Deal>('/api/deals', { q, stage });
  const sel = useSelection(data.items, perm.can('record.update.own') || perm.canDelete);
  // 列表与看板一起刷新 / refresh both the list and the board
  const refresh = () => {
    void reload();
    setBoardVersion((v) => v + 1);
  };
  const sums = (data as PageResult<Deal> & { sums?: { currency: string; amount: string }[] }).sums ?? [];

  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<Deal | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Deal | null>(null);

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
      message.success(t('common.deleted'));
      if (detail?.id === deal.id) setDetail(null);
      refresh();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const isOverdue = (d: Deal) =>
    d.expectedCloseDate && !d.stage.startsWith('CLOSED') && dayjs(d.expectedCloseDate.slice(0, 10)).isBefore(dayjs(), 'day');

  return (
    <Card
      title={t('deals.title')}
      extra={
        <Space>
          <ExportButton resource="deals" filters={{ q, stage }} />
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
          <Input.Search allowClear placeholder={t('deals.searchPlaceholder')} style={{ width: 280 }} onSearch={setQ} />
          {view === 'list' && (
            <Select allowClear placeholder={t('deals.stage')} style={{ width: 140 }} options={stageOptions} value={stage} onChange={setStage} />
          )}
        </Space>
        {view === 'list' && (
          <Space size="large" data-testid="deal-sums">
            {sums.map((s) => (
              <Statistic key={s.currency} title={`${t('deals.sum')} (${s.currency})`} value={fmtMoney(s.amount, s.currency)} />
            ))}
          </Space>
        )}
      </Space>
      {view === 'board' && <DealBoard q={q} version={boardVersion} onOpen={setDetail} />}
      {view === 'list' && (
        <BulkBar
          path="/api/deals"
          selected={sel.selected}
          names={Object.fromEntries(data.items.map((r) => [r.id, r.name]))}
          valueChange={{ action: 'stage', field: 'stage', options: stageOptions }}
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
            {
              title: t('deals.expectedCloseDate'),
              dataIndex: 'expectedCloseDate',
              render: (v: string | null, r) => <span style={isOverdue(r) ? { color: '#d4380d' } : undefined}>{fmtDate(v?.slice(0, 10))}</span>,
            },
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
                    <Popconfirm title={t('common.confirmDelete')} onConfirm={() => remove(r)}>
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
        <Form form={form} name="deal" layout="vertical" initialValues={{ stage: 'QUALIFICATION', currency: 'CNY' }}>
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
              <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="currency" label={t('deals.currency')}>
              <Select options={currencyOptions} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="stage" label={t('deals.stage')}>
              <Select options={stageOptions} />
            </Form.Item>
            <Form.Item name="expectedCloseDate" label={t('deals.expectedCloseDate')}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
              <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detail ? `${t('deals.detail')} · ${detail.name}` : t('deals.detail')}
        size={720}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={detail && perm.canEdit(detail) && <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>}
      >
        {detail && (
          <Tabs
            items={[
              {
                key: 'profile',
                label: t('accounts.tabProfile'),
                children: (
                  <Descriptions column={2} bordered size="small">
                    <Descriptions.Item label={t('deals.name')} span={2}>
                      {detail.name}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('deals.account')}>{detail.account.name}</Descriptions.Item>
                    <Descriptions.Item label={t('deals.amount')}>{fmtMoney(detail.amount, detail.currency)}</Descriptions.Item>
                    <Descriptions.Item label={t('deals.stage')}>
                      <Tag color={STAGE_COLOR[detail.stage]}>{tEnum('dealStage', detail.stage)}</Tag>
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
                    <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
                    <Descriptions.Item label={t('common.description')} span={2}>
                      {detail.description}
                    </Descriptions.Item>
                  </Descriptions>
                ),
              },
              {
                key: 'notes',
                label: t('notes.title'),
                children: <NotesPanel key={`notes-${detail.id}`} parent={{ dealId: detail.id }} ownerId={detail.ownerId} />,
              },
              { key: 'activities', label: t('deals.tabActivities'), children: <RelatedActivities relation={{ dealId: detail.id }} /> },
              { key: 'audit', label: t('audit.trail'), children: <AuditTrail entityType="deal" entityId={detail.id} version={detail.updatedAt} /> },
            ]}
          />
        )}
      </Drawer>
    </Card>
  );
}
