/**
 * 服务工单页：按状态分组的数量、搜索与筛选（状态、优先级、负责人、逾期）、详情与处理（开始处理、等待客户、解决、关闭、
 * 重新打开）、新建、编辑、删除。
 * Service tickets page: per-status counts, search and filters (status, priority, owner, overdue), detail with
 * status actions (start, wait for customer, resolve, close, reopen), create, edit and delete.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { AuditTrail } from '@/components/AuditTrail';
import { ExportButton } from '@/components/ExportButton';
import { usePermissions } from '@/components/AuthProvider';
import { RecordSelect } from '@/components/RecordSelect';
import { TicketComments } from '@/components/TicketComments';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOpenFromUrl, useOwners, usePagedList, useSearch } from '@/lib/hooks';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
const TYPES = ['QUESTION', 'PROBLEM', 'FEATURE_REQUEST'] as const;
const CHANNELS = ['PHONE', 'EMAIL', 'WEB', 'ONSITE', 'OTHER'] as const;
const DONE = ['RESOLVED', 'CLOSED'];
const STATUS_COLOR: Record<string, string> = { OPEN: 'blue', IN_PROGRESS: 'processing', WAITING_CUSTOMER: 'orange', RESOLVED: 'green', CLOSED: 'default' };
const PRIORITY_COLOR: Record<string, string> = { URGENT: 'red', HIGH: 'volcano', MEDIUM: 'gold', LOW: 'default' };

/** 服务工单 / service ticket */
interface Ticket {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string | null;
  accountId: string;
  account: { id: string; name: string };
  contactId: string | null;
  contact: { id: string; name: string; phone: string | null; email: string | null } | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  status: string;
  priority: string;
  type: string;
  channel: string;
  dueAt: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  overdue: boolean;
}

interface TicketForm {
  subject: string;
  description?: string | null;
  accountId: string;
  contactId?: string | null;
  ownerId?: string | null;
  priority: string;
  type: string;
  channel: string;
  dueAt?: Dayjs | null;
}

/**
 * 工单错误提示。
 * Messages for ticket errors.
 */
function ticketError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  if (d?.contactId?.[0] === 'other_account') return t('tickets.error.contactAccount');
  if (d?.resolution?.[0] === 'required') return t('tickets.error.resolutionRequired');
  if (d?.ticket?.[0] === 'stale') return t('tickets.error.stale');
  return (err as Error).message;
}

export default function TicketsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const owners = useOwners();
  const search = useSearch();
  const [status, setStatus] = useState<string>('open');
  const [priority, setPriority] = useState<string>();
  const [ownerId, setOwnerId] = useState<string>();
  const [overdue, setOverdue] = useState(false);
  // 列表与导出共用筛选 / filters shared by the list and the export
  const filters = { q: search.q || undefined, status: status === 'all' ? undefined : status, priority, ownerId, overdue: overdue ? 'true' : undefined };
  const { data, loading, reload, pagination } = usePagedList<Ticket>('/api/tickets', filters);
  const counts = (data as unknown as { counts?: Record<string, number> }).counts ?? {};
  const [detail, setDetail] = useState<Ticket | null>(null);
  const [editing, setEditing] = useState<Ticket | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState<'RESOLVED' | 'CLOSED' | null>(null);
  const [resolution, setResolution] = useState('');
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([]);
  const [form] = Form.useForm<TicketForm>();
  const accountId = Form.useWatch('accountId', form);

  const openDetail = useCallback(
    (id: string) => {
      api<Ticket>(`/api/tickets/${id}`)
        .then(setDetail)
        .catch((err: Error) => message.error(err.message));
    },
    [message],
  );
  useOpenFromUrl(openDetail);

  // 选择客户后加载其联系人 / load the chosen account's contacts
  useEffect(() => {
    if (!accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContacts([]);
      return;
    }
    api<{ items: { id: string; name: string }[] }>(`/api/accounts/${accountId}/contacts`)
      .then((r) => setContacts(r.items))
      .catch(() => setContacts([]));
  }, [accountId]);

  const openForm = (tk: Ticket | 'new') => {
    form.resetFields();
    if (tk === 'new') form.setFieldsValue({ priority: 'MEDIUM', type: 'QUESTION', channel: 'PHONE' });
    else form.setFieldsValue({ ...tk, dueAt: tk.dueAt ? dayjs(tk.dueAt) : null });
    setEditing(tk);
  };

  /** 保存后刷新列表与详情 / refresh the list and the open detail after a save */
  const saved = (tk: Ticket) => {
    message.success(t('common.saved'));
    void reload();
    if (detail?.id === tk.id) setDetail(tk);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, description: v.description ?? null, contactId: v.contactId ?? null, ownerId: v.ownerId ?? null, dueAt: v.dueAt ? v.dueAt.toISOString() : null };
    setSaving(true);
    try {
      const tk =
        editing === 'new'
          ? await api<Ticket>('/api/tickets', { method: 'POST', body })
          : await api<Ticket>(`/api/tickets/${(editing as Ticket).id}`, { method: 'PATCH', body });
      setEditing(null);
      saved(tk);
    } catch (err) {
      message.error(ticketError(err));
    } finally {
      setSaving(false);
    }
  };

  /** 状态流转 / change status */
  const transition = async (tk: Ticket, next: string, extra: object = {}) => {
    try {
      saved(await api<Ticket>(`/api/tickets/${tk.id}`, { method: 'PATCH', body: { status: next, ...extra } }));
      return true;
    } catch (err) {
      message.error(ticketError(err));
      return false;
    }
  };

  const remove = async (tk: Ticket) => {
    try {
      await api(`/api/tickets/${tk.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      if (detail?.id === tk.id) setDetail(null);
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const openCount = (counts.OPEN ?? 0) + (counts.IN_PROGRESS ?? 0) + (counts.WAITING_CUSTOMER ?? 0);
  const editable = detail ? perm.canEdit(detail) : false;

  return (
    <Card
      title={t('tickets.title')}
      extra={
        <Space>
          <ExportButton resource="tickets" filters={filters} />
          {perm.can('record.create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
              {t('tickets.new')}
            </Button>
          )}
        </Space>
      }
    >
      <Segmented
        style={{ marginBottom: 16 }}
        value={status}
        onChange={(v) => setStatus(String(v))}
        options={[
          { value: 'open', label: `${t('tickets.openGroup')} (${openCount})` },
          ...STATUSES.map((s) => ({ value: s, label: `${tEnum('ticketStatus', s)} (${counts[s] ?? 0})` })),
          { value: 'all', label: t('tickets.all') },
        ]}
      />
      <Space wrap style={{ marginBottom: 16, display: 'flex' }}>
        <Input.Search allowClear placeholder={t('tickets.searchPlaceholder')} style={{ width: 280 }} {...search.inputProps} />
        <Select allowClear aria-label={t('tickets.priority')} placeholder={t('tickets.priority')} style={{ width: 120 }} value={priority} onChange={setPriority} options={PRIORITIES.map((v) => ({ value: v, label: tEnum('ticketPriority', v) }))} />
        <Select allowClear aria-label={t('common.owner')} placeholder={t('common.owner')} style={{ width: 140 }} value={ownerId} onChange={setOwnerId} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
        <Checkbox checked={overdue} onChange={(e) => setOverdue(e.target.checked)}>
          {t('tickets.overdueOnly')}
        </Checkbox>
      </Space>
      <Table<Ticket>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('tickets.number'), dataIndex: 'ticketNumber', width: 130 },
          {
            title: t('tickets.subject'),
            dataIndex: 'subject',
            render: (v: string, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(r.id)}>
                {v}
              </Button>
            ),
          },
          { title: t('tickets.account'), render: (_, r) => r.account.name },
          { title: t('tickets.priority'), dataIndex: 'priority', render: (v: string) => <Tag color={PRIORITY_COLOR[v]}>{tEnum('ticketPriority', v)}</Tag> },
          { title: t('tickets.status'), dataIndex: 'status', render: (v: string) => <Tag color={STATUS_COLOR[v]}>{tEnum('ticketStatus', v)}</Tag> },
          {
            title: t('tickets.dueAt'),
            render: (_, r) => (
              <Space size={4}>
                {fmtDateTime(r.dueAt)}
                {r.overdue && <Tag color="red">{t('tickets.overdue')}</Tag>}
              </Space>
            ),
          },
          { title: t('common.owner'), render: (_, r) => r.owner?.name ?? t('common.unassigned') },
          { title: t('common.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
        ]}
      />

      <Drawer
        title={detail ? `${t('tickets.detail')} · ${detail.ticketNumber}` : t('tickets.detail')}
        size={760}
        open={detail !== null}
        onClose={() => setDetail(null)}
        extra={
          detail && (
            <Space>
              {editable && <Button onClick={() => openForm(detail)}>{t('common.edit')}</Button>}
              {perm.can('record.delete') && (
                <Popconfirm title={t('common.confirmDelete')} onConfirm={() => remove(detail)}>
                  <Button danger>{t('common.delete')}</Button>
                </Popconfirm>
              )}
            </Space>
          )
        }
      >
        {detail && (
          <div data-testid="ticket-detail">
            {editable && (
              <Space wrap style={{ marginBottom: 16 }} data-testid="ticket-actions">
                {detail.status === 'OPEN' && <Button onClick={() => transition(detail, 'IN_PROGRESS')}>{t('tickets.action.start')}</Button>}
                {['OPEN', 'IN_PROGRESS'].includes(detail.status) && <Button onClick={() => transition(detail, 'WAITING_CUSTOMER')}>{t('tickets.action.wait')}</Button>}
                {detail.status === 'WAITING_CUSTOMER' && <Button onClick={() => transition(detail, 'IN_PROGRESS')}>{t('tickets.action.resume')}</Button>}
                {!DONE.includes(detail.status) && (
                  <Button
                    type="primary"
                    onClick={() => {
                      setResolution(detail.resolution ?? '');
                      setResolving('RESOLVED');
                    }}
                  >
                    {t('tickets.action.resolve')}
                  </Button>
                )}
                {detail.status === 'RESOLVED' && <Button onClick={() => transition(detail, 'CLOSED')}>{t('tickets.action.close')}</Button>}
                {DONE.includes(detail.status) && <Button onClick={() => transition(detail, 'IN_PROGRESS')}>{t('tickets.action.reopen')}</Button>}
              </Space>
            )}
            <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('tickets.subject')} span={2}>
                {detail.subject}
              </Descriptions.Item>
              <Descriptions.Item label={t('tickets.status')}>
                <Space size={4}>
                  <Tag color={STATUS_COLOR[detail.status]}>{tEnum('ticketStatus', detail.status)}</Tag>
                  {detail.overdue && <Tag color="red">{t('tickets.overdue')}</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('tickets.priority')}>
                <Tag color={PRIORITY_COLOR[detail.priority]}>{tEnum('ticketPriority', detail.priority)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('tickets.account')}>
                <Link href={`/accounts?id=${detail.accountId}`}>{detail.account.name}</Link>
              </Descriptions.Item>
              <Descriptions.Item label={t('tickets.contact')}>
                {detail.contact ? [detail.contact.name, detail.contact.phone, detail.contact.email].filter(Boolean).join(' · ') : null}
              </Descriptions.Item>
              <Descriptions.Item label={t('tickets.type')}>{tEnum('ticketType', detail.type)}</Descriptions.Item>
              <Descriptions.Item label={t('tickets.channel')}>{tEnum('ticketChannel', detail.channel)}</Descriptions.Item>
              <Descriptions.Item label={t('common.owner')}>{detail.owner?.name ?? t('common.unassigned')}</Descriptions.Item>
              <Descriptions.Item label={t('tickets.dueAt')}>{fmtDateTime(detail.dueAt)}</Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label={t('tickets.resolvedAt')}>{fmtDateTime(detail.resolvedAt)}</Descriptions.Item>
              <Descriptions.Item label={t('common.description')} span={2}>
                <span style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('tickets.resolution')} span={2}>
                <span style={{ whiteSpace: 'pre-wrap' }} data-testid="ticket-resolution">
                  {detail.resolution}
                </span>
              </Descriptions.Item>
            </Descriptions>
            <TicketComments key={`comments-${detail.id}`} ticket={detail} />
            <Typography.Title level={5}>{t('audit.trail')}</Typography.Title>
            <AuditTrail entityType="ticket" entityId={detail.id} version={detail.updatedAt} />
          </div>
        )}
      </Drawer>

      <Modal
        title={t(resolving === 'CLOSED' ? 'tickets.action.close' : 'tickets.action.resolve')}
        open={resolving !== null}
        onCancel={() => setResolving(null)}
        okText={t('common.save')}
        okButtonProps={{ disabled: !resolution.trim() }}
        zIndex={1100}
        onOk={async () => {
          if (detail && resolving && (await transition(detail, resolving, { resolution }))) setResolving(null);
        }}
      >
        <Typography.Paragraph type="secondary">{t('tickets.resolutionHint')}</Typography.Paragraph>
        <Input.TextArea aria-label={t('tickets.resolution')} rows={5} maxLength={10000} value={resolution} onChange={(e) => setResolution(e.target.value)} />
      </Modal>

      <Modal title={editing === 'new' ? t('tickets.new') : t('tickets.edit')} open={editing !== null} onOk={save} confirmLoading={saving} onCancel={() => setEditing(null)} okText={t('common.save')} width={680} forceRender zIndex={1100}>
        <Form form={form} name="ticket" layout="vertical">
          <Form.Item name="subject" label={t('tickets.subject')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('tickets.subject') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <div className="form-row">
            <Form.Item name="accountId" label={t('tickets.account')} rules={[{ required: true, message: t('common.required', { field: t('tickets.account') }) }]}>
              <RecordSelect
                key={editing && editing !== 'new' ? editing.id : 'new'}
                resource="/api/accounts"
                initialLabel={editing && editing !== 'new' ? editing.account.name : undefined}
                onChange={() => form.setFieldValue('contactId', null)}
              />
            </Form.Item>
            <Form.Item name="contactId" label={t('tickets.contact')}>
              <Select allowClear disabled={!accountId} options={contacts.map((c) => ({ value: c.id, label: c.name }))} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="priority" label={t('tickets.priority')}>
              <Select options={PRIORITIES.map((v) => ({ value: v, label: tEnum('ticketPriority', v) }))} />
            </Form.Item>
            <Form.Item name="type" label={t('tickets.type')}>
              <Select options={TYPES.map((v) => ({ value: v, label: tEnum('ticketType', v) }))} />
            </Form.Item>
            <Form.Item name="channel" label={t('tickets.channel')}>
              <Select options={CHANNELS.map((v) => ({ value: v, label: tEnum('ticketChannel', v) }))} />
            </Form.Item>
          </div>
          <div className="form-row">
            <Form.Item name="ownerId" label={t('common.owner')} extra={perm.canAssign ? undefined : t('common.ownerLocked')}>
              <Select allowClear={perm.canAssign} disabled={!perm.canAssign} options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            </Form.Item>
            <Form.Item name="dueAt" label={t('tickets.dueAt')}>
              <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={4} maxLength={10000} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
