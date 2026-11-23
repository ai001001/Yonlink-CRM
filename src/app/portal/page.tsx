/**
 * 客户门户首页：我的工单（可提交新工单）、所属客户的报价单与发票。
 * Customer portal home: my tickets (raise new ones), the account's quotes and invoices.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Select, Table, Tabs, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { PortalShell } from '@/components/PortalShell';
import { t, tEnum } from '@/i18n';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { portalApi, siteUrl } from '@/lib/portal-api';

interface Ticket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  type: string;
  createdAt: string;
  updatedAt: string;
}
interface Quote {
  id: string;
  quoteNumber: string;
  subject: string;
  status: string;
  currency: string;
  total: string;
  validUntil: string | null;
}
interface Invoice {
  id: string;
  invoiceNumber: string;
  subject: string;
  status: string;
  currency: string;
  total: string;
  paidAmount: string;
  balance: string;
  invoiceDate: string;
  dueDate: string;
}

/** 我的工单 / my tickets */
function Tickets() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Ticket[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ subject: string; description?: string; type: string }>();
  const load = useCallback(() => {
    portalApi<{ items: Ticket[] }>('/api/portal/tickets')
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [message]);
  useEffect(load, [load]);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const r = await portalApi<Ticket>('/api/portal/tickets', { method: 'POST', body: { subject: v.subject, description: v.description || null, type: v.type } });
      message.success(t('portal.ticketCreated', { number: r.ticketNumber }));
      setOpen(false);
      load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 12 }} onClick={() => (form.resetFields(), setOpen(true))} data-testid="portal-new-ticket">
        {t('portal.newTicket')}
      </Button>
      <Table<Ticket>
        rowKey="id"
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('portal.noTickets') }}
        columns={[
          { title: t('portal.number'), dataIndex: 'ticketNumber' },
          {
            title: t('portal.subject'),
            render: (_, r) => (
              <a href={siteUrl('portal/ticket', { id: r.id })} data-testid="portal-ticket-link">
                {r.subject}
              </a>
            ),
          },
          { title: t('portal.type'), render: (_, r) => tEnum('ticketType', r.type) },
          { title: t('portal.status'), render: (_, r) => <Tag>{tEnum('ticketStatus', r.status)}</Tag> },
          { title: t('portal.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
          { title: t('portal.updatedAt'), render: (_, r) => fmtDateTime(r.updatedAt) },
        ]}
      />
      <Modal title={t('portal.newTicket')} open={open} onOk={submit} confirmLoading={saving} onCancel={() => setOpen(false)} okText={t('portal.submit')} cancelText={t('common.cancel')} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" name="portal-ticket" initialValues={{ type: 'QUESTION' }}>
          <Form.Item name="subject" label={t('portal.subject')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('portal.subject') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="type" label={t('portal.type')}>
            <Select options={['QUESTION', 'PROBLEM', 'FEATURE_REQUEST'].map((v) => ({ value: v, label: tEnum('ticketType', v) }))} />
          </Form.Item>
          <Form.Item name="description" label={t('portal.description')}>
            <Input.TextArea rows={5} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

/** 报价单 / quotes */
function Quotes() {
  const [rows, setRows] = useState<Quote[]>([]);
  useEffect(() => {
    portalApi<{ items: Quote[] }>('/api/portal/quotes')
      .then((r) => setRows(r.items))
      .catch(() => setRows([]));
  }, []);
  return (
    <Table<Quote>
      rowKey="id"
      dataSource={rows}
      pagination={{ pageSize: 20 }}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: t('portal.noQuotes') }}
      columns={[
        { title: t('portal.quoteNumber'), dataIndex: 'quoteNumber' },
        { title: t('portal.subject'), dataIndex: 'subject' },
        { title: t('portal.status'), render: (_, r) => <Tag>{tEnum('quoteStatus', r.status)}</Tag> },
        { title: t('portal.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
        { title: t('portal.validUntil'), render: (_, r) => fmtDate(r.validUntil) },
      ]}
    />
  );
}

/** 发票 / invoices */
function Invoices() {
  const [rows, setRows] = useState<Invoice[]>([]);
  useEffect(() => {
    portalApi<{ items: Invoice[] }>('/api/portal/invoices')
      .then((r) => setRows(r.items))
      .catch(() => setRows([]));
  }, []);
  return (
    <Table<Invoice>
      rowKey="id"
      dataSource={rows}
      pagination={{ pageSize: 20 }}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: t('portal.noInvoices') }}
      columns={[
        { title: t('portal.invoiceNumber'), dataIndex: 'invoiceNumber' },
        { title: t('portal.subject'), dataIndex: 'subject' },
        { title: t('portal.status'), render: (_, r) => <Tag>{tEnum('invoiceStatus', r.status)}</Tag> },
        { title: t('portal.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
        { title: t('portal.paid'), align: 'right', render: (_, r) => fmtMoney(r.paidAmount, r.currency) },
        { title: t('portal.balance'), align: 'right', render: (_, r) => fmtMoney(r.balance, r.currency) },
        { title: t('portal.invoiceDate'), render: (_, r) => fmtDate(r.invoiceDate) },
        { title: t('portal.dueDate'), render: (_, r) => fmtDate(r.dueDate) },
      ]}
    />
  );
}

export default function PortalHomePage() {
  return (
    <PortalShell>
      <Tabs
        items={[
          { key: 'tickets', label: t('portal.tabTickets'), children: <Tickets /> },
          { key: 'quotes', label: t('portal.tabQuotes'), children: <Quotes /> },
          { key: 'invoices', label: t('portal.tabInvoices'), children: <Invoices /> },
        ]}
      />
    </PortalShell>
  );
}
