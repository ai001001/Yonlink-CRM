/**
 * 市场活动页：活动列表（含线索、转化、商机、赢单与投入产出统计）、筛选搜索、详情（统计与最近关联的线索、商机）、
 * 新建、编辑、删除（后三者需 campaign.manage）。
 * Campaigns page: list with lead / conversion / deal / revenue / ROI statistics, filters and search, detail with
 * statistics and recent linked leads and deals, and create / edit / delete (campaign.manage).
 */
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, Card, Col, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { usePermissions } from '@/components/AuthProvider';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useOpenFromUrl, useOwners, usePagedList, useSearch } from '@/lib/hooks';

const TYPES = ['EXHIBITION', 'ADVERTISEMENT', 'EMAIL', 'WEBINAR', 'SOCIAL_MEDIA', 'OTHER'] as const;
const STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];
const STATUS_COLOR: Record<string, string> = { PLANNED: 'default', ACTIVE: 'blue', COMPLETED: 'green', CANCELLED: 'red' };

/** 活动统计 / campaign statistics */
interface Stats {
  leads: number;
  convertedLeads: number;
  conversionRate: number | null;
  deals: number;
  wonDeals: number;
  openAmount: string;
  wonAmount: string;
  costInBase: string | null;
  roi: number | null;
  baseCurrency: string;
  missing: string[];
}

/** 市场活动 / campaign */
interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  currency: string;
  budget: string | null;
  actualCost: string | null;
  description: string | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  stats: Stats;
  leads?: { id: string; name: string; company: string | null; status: string }[];
  deals?: { id: string; name: string; stage: string; amount: string; currency: string }[];
}

interface CampaignForm {
  name: string;
  type: string;
  status: string;
  startDate?: Dayjs | null;
  endDate?: Dayjs | null;
  currency: string;
  budget?: string | null;
  actualCost?: string | null;
  description?: string | null;
  ownerId?: string | null;
}

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const base = (v: string | null) => (v === null ? '—' : fmtMoney(v, 'CNY'));

export default function CampaignsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('campaign.manage');
  const owners = useOwners();
  const search = useSearch();
  const [status, setStatus] = useState<string>();
  const [type, setType] = useState<string>();
  const { data, loading, reload, pagination } = usePagedList<Campaign>('/api/campaigns', { q: search.q || undefined, status, type });
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<CampaignForm>();

  const openDetail = useCallback(
    (id: string) => {
      api<Campaign>(`/api/campaigns/${id}`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  const openForm = (c: Campaign | 'new') => {
    form.resetFields();
    if (c === 'new') form.setFieldsValue({ type: 'EXHIBITION', status: 'PLANNED', currency: 'CNY' });
    else
      form.setFieldsValue({
        ...c,
        startDate: c.startDate ? dayjs(c.startDate.slice(0, 10)) : null,
        endDate: c.endDate ? dayjs(c.endDate.slice(0, 10)) : null,
      });
    setEditing(c);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = {
      ...v,
      startDate: v.startDate ? v.startDate.format('YYYY-MM-DD') : null,
      endDate: v.endDate ? v.endDate.format('YYYY-MM-DD') : null,
      budget: v.budget === undefined || v.budget === null || v.budget === '' ? null : String(v.budget),
      actualCost: v.actualCost === undefined || v.actualCost === null || v.actualCost === '' ? null : String(v.actualCost),
      description: v.description ?? null,
      ownerId: v.ownerId ?? null,
    };
    setSaving(true);
    try {
      const saved =
        editing === 'new'
          ? await api<Campaign>('/api/campaigns', { method: 'POST', body })
          : await api<Campaign>(`/api/campaigns/${(editing as Campaign).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      void reload();
      if (detail?.id === saved.id) setDetail(saved);
    } catch (err) {
      const code = err instanceof ClientApiError ? (err.details?.name?.[0] ?? err.details?.endDate?.[0]) : undefined;
      if (code === 'taken') form.setFields([{ name: 'name', errors: [t('campaigns.error.taken')] }]);
      if (code === 'before_start') form.setFields([{ name: 'endDate', errors: [t('campaigns.error.before_start')] }]);
      message.error(code ? t(`campaigns.error.${code}` as MessageKey) : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Campaign) => {
    try {
      await api(`/api/campaigns/${c.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === c.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.details?.campaign ? t('campaigns.hasLinks') : (err as Error).message);
    }
  };

  return (
    <Card
      title={t('campaigns.title')}
      extra={
        canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('campaigns.new')}
          </Button>
        )
      }
    >
      <Alert type="info" showIcon title={`${t('campaigns.hint')}${canManage ? '' : t('campaigns.manageOnly')}`} style={{ marginBottom: 16 }} />
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder={t('campaigns.searchPlaceholder')} style={{ width: 260 }} {...search.inputProps} />
        <Select allowClear aria-label={t('campaigns.type')} placeholder={t('campaigns.type')} style={{ width: 140 }} value={type} onChange={setType} options={TYPES.map((v) => ({ value: v, label: tEnum('campaignType', v) }))} />
        <Select allowClear aria-label={t('campaigns.status')} placeholder={t('campaigns.status')} style={{ width: 120 }} value={status} onChange={setStatus} options={STATUSES.map((v) => ({ value: v, label: tEnum('campaignStatus', v) }))} />
      </Space>
      <Table<Campaign>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('campaigns.name'),
            dataIndex: 'name',
            render: (v: string, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                {v}
              </Button>
            ),
          },
          { title: t('campaigns.type'), dataIndex: 'type', render: (v: string) => tEnum('campaignType', v) },
          { title: t('campaigns.status'), dataIndex: 'status', render: (v: string) => <Tag color={STATUS_COLOR[v]}>{tEnum('campaignStatus', v)}</Tag> },
          { title: t('campaigns.startDate'), render: (_, r) => `${fmtDate(r.startDate?.slice(0, 10))}${r.endDate ? ` ~ ${fmtDate(r.endDate.slice(0, 10))}` : ''}` },
          { title: t('campaigns.actualCost'), align: 'right', render: (_, r) => (r.actualCost === null ? '—' : fmtMoney(r.actualCost, r.currency)) },
          { title: t('campaigns.leads'), align: 'right', render: (_, r) => `${r.stats.leads} / ${r.stats.convertedLeads}` },
          { title: t('campaigns.deals'), align: 'right', render: (_, r) => `${r.stats.deals} / ${r.stats.wonDeals}` },
          { title: t('campaigns.wonAmount'), align: 'right', render: (_, r) => base(r.stats.wonAmount) },
          { title: t('campaigns.roi'), align: 'right', render: (_, r) => pct(r.stats.roi) },
          { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
          ...(canManage
            ? [
                {
                  title: t('common.actions'),
                  key: 'actions',
                  render: (_: unknown, r: Campaign) => (
                    <Space>
                      <Button type="link" size="small" onClick={() => openForm(r)}>
                        {t('common.edit')}
                      </Button>
                      <Popconfirm title={t('common.confirmDelete')} onConfirm={() => remove(r)}>
                        <Button type="link" size="small" danger>
                          {t('common.delete')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Drawer title={detail ? `${t('campaigns.detail')} · ${detail.name}` : t('campaigns.detail')} size={760} open={detail !== null} onClose={() => setDetail(null)}>
        {detail && (
          <div data-testid="campaign-detail">
            {canManage && (
              <Button style={{ marginBottom: 16 }} onClick={() => openForm(detail)}>
                {t('common.edit')}
              </Button>
            )}
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              {(
                [
                  ['campaigns.leads', String(detail.stats.leads)],
                  ['campaigns.conversionRate', pct(detail.stats.conversionRate)],
                  ['campaigns.openAmount', base(detail.stats.openAmount)],
                  ['campaigns.wonAmount', base(detail.stats.wonAmount)],
                  ['campaigns.cost', base(detail.stats.costInBase)],
                  ['campaigns.roi', pct(detail.stats.roi)],
                ] as [MessageKey, string][]
              ).map(([k, v]) => (
                <Col key={k} xs={12} md={8}>
                  <Card size="small" data-testid={`campaign-${k.split('.')[1]}`}>
                    <Statistic title={t(k)} value={v} />
                  </Card>
                </Col>
              ))}
            </Row>
            <Typography.Paragraph type="secondary">{`${t('campaigns.roi')}${t('common.colon')}${t('campaigns.roiHint')}`}</Typography.Paragraph>
            {detail.stats.missing.length > 0 && <Alert type="warning" showIcon title={t('campaigns.missing', { list: detail.stats.missing.join(t('common.listSep')) })} style={{ marginBottom: 12 }} />}
            <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('campaigns.type')}>{tEnum('campaignType', detail.type)}</Descriptions.Item>
              <Descriptions.Item label={t('campaigns.status')}>
                <Tag color={STATUS_COLOR[detail.status]}>{tEnum('campaignStatus', detail.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('campaigns.startDate')}>{fmtDate(detail.startDate?.slice(0, 10))}</Descriptions.Item>
              <Descriptions.Item label={t('campaigns.endDate')}>{fmtDate(detail.endDate?.slice(0, 10))}</Descriptions.Item>
              <Descriptions.Item label={t('campaigns.budget')}>{detail.budget === null ? '—' : fmtMoney(detail.budget, detail.currency)}</Descriptions.Item>
              <Descriptions.Item label={t('campaigns.actualCost')}>{detail.actualCost === null ? '—' : fmtMoney(detail.actualCost, detail.currency)}</Descriptions.Item>
              <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
              <Descriptions.Item label={t('campaigns.deals')}>{`${detail.stats.deals} / ${detail.stats.wonDeals}`}</Descriptions.Item>
              <Descriptions.Item label={t('common.description')} span={2}>
                <span style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</span>
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5}>{t('campaigns.linkedLeads')}</Typography.Title>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              style={{ marginBottom: 16 }}
              dataSource={detail.leads ?? []}
              data-testid="campaign-linked-leads"
              columns={[
                { title: t('leads.name'), render: (_, r) => <Link href={`/leads?id=${r.id}`}>{r.name}</Link> },
                { title: t('leads.company'), dataIndex: 'company' },
                { title: t('leads.status'), dataIndex: 'status', render: (v: string) => tEnum('leadStatus', v) },
              ]}
            />
            <Typography.Title level={5}>{t('campaigns.linkedDeals')}</Typography.Title>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={detail.deals ?? []}
              data-testid="campaign-linked-deals"
              columns={[
                { title: t('deals.name'), render: (_, r) => <Link href={`/deals?id=${r.id}`}>{r.name}</Link> },
                { title: t('deals.stage'), dataIndex: 'stage', render: (v: string) => tEnum('dealStage', v) },
                { title: t('deals.amount'), align: 'right', render: (_, r) => fmtMoney(r.amount, r.currency) },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal title={editing === 'new' ? t('campaigns.new') : t('campaigns.edit')} open={editing !== null} onOk={save} confirmLoading={saving} onCancel={() => setEditing(null)} okText={t('common.save')} width={640} forceRender zIndex={1100}>
        <Form form={form} name="campaign" layout="vertical">
          <Form.Item name="name" label={t('campaigns.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('campaigns.name') }) }]}>
            <Input maxLength={100} />
          </Form.Item>
          <div className="form-row">
            <Form.Item name="type" label={t('campaigns.type')} rules={[{ required: true }]}>
              <Select options={TYPES.map((v) => ({ value: v, label: tEnum('campaignType', v) }))} />
            </Form.Item>
            <Form.Item name="status" label={t('campaigns.status')} rules={[{ required: true }]}>
              <Select options={STATUSES.map((v) => ({ value: v, label: tEnum('campaignStatus', v) }))} />
            </Form.Item>
            <Form.Item name="ownerId" label={t('common.owner')}>
              <Select allowClear options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="startDate" label={t('campaigns.startDate')}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="endDate" label={t('campaigns.endDate')}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="currency" label={t('campaigns.currency')}>
              <Select options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
            </Form.Item>
            <Form.Item name="budget" label={t('campaigns.budget')}>
              <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="actualCost" label={t('campaigns.actualCost')}>
              <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
