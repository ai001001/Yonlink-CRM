/**
 * 报价单详情抽屉：基本信息、明细与合计、状态流转、编辑草稿、从商机同步明细、打印、删除草稿。
 * Quote detail drawer: info, lines and totals, status transitions, draft editing, re-sync from the deal,
 * print and draft deletion.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { PrinterOutlined, SyncOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import type { Quote, QuoteLine, QuoteStatus } from '@/lib/types';
import { usePermissions } from './AuthProvider';

/** 状态颜色 / Status colours */
export const QUOTE_STATUS_COLOR: Record<QuoteStatus, string> = { DRAFT: 'default', SENT: 'blue', ACCEPTED: 'green', REJECTED: 'red' };

/** 允许的状态流转（与服务端一致，仅用于显示按钮）/ allowed transitions (mirrors the server; UI only) */
const NEXT: Record<QuoteStatus, QuoteStatus[]> = { DRAFT: ['SENT'], SENT: ['ACCEPTED', 'REJECTED', 'DRAFT'], ACCEPTED: [], REJECTED: [] };

/**
 * 已发送且已过有效期。
 * Sent and past its validity date.
 */
export function isQuoteExpired(q: Pick<Quote, 'status' | 'validUntil'>): boolean {
  return q.status === 'SENT' && !!q.validUntil && dayjs(q.validUntil.slice(0, 10)).isBefore(dayjs(), 'day');
}

/**
 * 状态标签（含过期提示）。
 * Status tag (with the expiry hint).
 */
export function QuoteStatusTag({ quote }: { quote: Pick<Quote, 'status' | 'validUntil'> }) {
  return (
    <Space size={4}>
      <Tag color={QUOTE_STATUS_COLOR[quote.status]}>{tEnum('quoteStatus', quote.status)}</Tag>
      {isQuoteExpired(quote) && <Tag color="orange">{t('quotes.expired')}</Tag>}
    </Space>
  );
}

/**
 * 报价单相关错误提示。
 * Messages for quote errors.
 */
export function quoteError(err: unknown): string {
  const d = err instanceof ClientApiError ? err.details : undefined;
  const code = d?.status?.[0] ?? d?.dealId?.[0];
  if (code === 'not_draft' || code === 'no_items') return t(`quotes.error.${code}` as MessageKey);
  return (err as Error).message;
}

interface EditForm {
  subject?: string;
  validUntil?: Dayjs | null;
  taxPercent?: string | null;
  terms?: string | null;
  notes?: string | null;
}

/**
 * 报价单明细表格（详情与打印共用）。
 * Quote lines table (shared by the drawer and the print page).
 */
export function QuoteLinesTable({ quote, size = 'small' }: { quote: Quote; size?: 'small' | 'middle' }) {
  return (
    <Table<QuoteLine>
      rowKey="id"
      size={size}
      pagination={false}
      dataSource={quote.lines ?? []}
      columns={[
        { title: t('quotes.lineNo'), dataIndex: 'position', width: 56 },
        { title: t('products.sku'), dataIndex: 'productSku', width: 140 },
        { title: t('products.name'), dataIndex: 'productName' },
        { title: t('items.quantity'), align: 'right', render: (_, r) => `${r.quantity} ${r.unit}` },
        { title: t('products.unitPrice'), dataIndex: 'unitPrice', align: 'right', render: (v: string) => fmtMoney(v, quote.currency) },
        { title: t('items.discount'), dataIndex: 'discountPercent', align: 'right', render: (v: string) => `${Number(v)}%` },
        { title: t('items.lineTotal'), dataIndex: 'lineTotal', align: 'right', render: (v: string) => fmtMoney(v, quote.currency) },
      ]}
      summary={() => (
        <>
          {[
            ['quotes.subtotal', quote.subtotal, 'quote-subtotal'],
            [`quotes.taxAmount`, quote.taxAmount, 'quote-tax'],
            ['quotes.total', quote.total, 'quote-total'],
          ].map(([key, v, id]) => (
            <Table.Summary.Row key={id}>
              <Table.Summary.Cell index={0} colSpan={6} align="right">
                <Typography.Text strong={id === 'quote-total'}>
                  {t(key as MessageKey)}
                  {id === 'quote-tax' && `（${Number(quote.taxPercent)}%）`}
                </Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong={id === 'quote-total'} data-testid={id}>
                  {fmtMoney(v, quote.currency)}
                </Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          ))}
        </>
      )}
    />
  );
}

interface Props {
  /** 打开的报价单 ID；null 表示关闭 / quote to show; null closes the drawer */
  quoteId: string | null;
  onClose: () => void;
  /** 报价单变化（修改、状态、删除）后 / called after any change */
  onChanged: () => void;
}

export function QuoteDrawer({ quoteId, onClose, onChanged }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm<EditForm>();

  const load = useCallback(async () => {
    if (!quoteId) return;
    try {
      setQuote(await api<Quote>(`/api/quotes/${quoteId}`));
    } catch (err) {
      message.error((err as Error).message);
      onClose();
    }
  }, [quoteId, message, onClose]);

  useEffect(() => {
    // 打开时加载详情 / load on open
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!quoteId) setQuote(null);
    else void load();
  }, [quoteId, load]);

  /**
   * 执行修改类请求并刷新。
   * Run a mutation and refresh.
   */
  const run = async (fn: () => Promise<Quote | undefined>, ok: string) => {
    try {
      const next = await fn();
      message.success(ok);
      if (next) setQuote(next);
      onChanged();
    } catch (err) {
      message.error(quoteError(err));
    }
  };

  const editable = !!quote && perm.canEdit(quote.deal);
  const draft = quote?.status === 'DRAFT';

  const openEdit = () => {
    if (!quote) return;
    form.setFieldsValue({
      subject: quote.subject,
      validUntil: quote.validUntil ? dayjs(quote.validUntil.slice(0, 10)) : null,
      taxPercent: quote.taxPercent,
      terms: quote.terms,
      notes: quote.notes,
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!quote) return;
    const v = await form.validateFields();
    await run(async () => {
      const next = await api<Quote>(`/api/quotes/${quote.id}`, {
        method: 'PATCH',
        body: { subject: v.subject, validUntil: v.validUntil ? v.validUntil.format('YYYY-MM-DD') : null, taxPercent: String(v.taxPercent ?? '0'), terms: v.terms ?? null, notes: v.notes ?? null },
      });
      setEditing(false);
      return next;
    }, t('common.saved'));
  };

  return (
    <Drawer title={quote ? `${t('quotes.detail')} · ${quote.quoteNumber}` : t('quotes.detail')} size={760} open={quoteId !== null} onClose={onClose} destroyOnHidden>
      {quote && (
        <div data-testid="quote-detail">
          <Space wrap style={{ marginBottom: 16 }}>
            <Link href={`/print/quote?id=${quote.id}`} target="_blank" rel="noopener">
              <PrinterOutlined /> {t('quotes.print')}
            </Link>
            {editable && draft && <Button onClick={openEdit}>{t('common.edit')}</Button>}
            {editable && draft && (
              <Button icon={<SyncOutlined />} onClick={() => run(() => api<Quote>(`/api/quotes/${quote.id}/sync`, { method: 'POST' }), t('quotes.synced'))}>
                {t('quotes.sync')}
              </Button>
            )}
            {editable &&
              NEXT[quote.status].map((s) => (
                <Popconfirm
                  key={s}
                  title={t('quotes.confirmStatus', { status: tEnum('quoteStatus', s) })}
                  onConfirm={() => run(() => api<Quote>(`/api/quotes/${quote.id}/status`, { method: 'POST', body: { status: s } }), t('common.saved'))}
                >
                  <Button type={s === 'DRAFT' ? 'default' : 'primary'} danger={s === 'REJECTED'} ghost={s === 'REJECTED'}>
                    {t(`quotes.action.${s}` as MessageKey)}
                  </Button>
                </Popconfirm>
              ))}
            {editable && draft && (
              <Popconfirm
                title={t('common.confirmDelete')}
                onConfirm={() =>
                  run(async () => {
                    await api(`/api/quotes/${quote.id}`, { method: 'DELETE' });
                    onClose();
                    return undefined;
                  }, t('common.deleted'))
                }
              >
                <Button danger>{t('common.delete')}</Button>
              </Popconfirm>
            )}
          </Space>
          {editable && !draft && <Alert type="info" showIcon title={t('quotes.draftOnly')} style={{ marginBottom: 12 }} />}
          <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('quotes.number')}>{quote.quoteNumber}</Descriptions.Item>
            <Descriptions.Item label={t('quotes.status')}>
              <QuoteStatusTag quote={quote} />
            </Descriptions.Item>
            <Descriptions.Item label={t('quotes.subject')} span={2}>
              {quote.subject}
            </Descriptions.Item>
            <Descriptions.Item label={t('quotes.account')}>{quote.deal.account.name}</Descriptions.Item>
            <Descriptions.Item label={t('quotes.deal')}>{quote.deal.name}</Descriptions.Item>
            <Descriptions.Item label={t('quotes.validUntil')}>{fmtDate(quote.validUntil?.slice(0, 10))}</Descriptions.Item>
            <Descriptions.Item label={t('quotes.createdBy')}>{quote.createdBy?.name}</Descriptions.Item>
            <Descriptions.Item label={t('common.createdAt')}>{fmtDateTime(quote.createdAt)}</Descriptions.Item>
            <Descriptions.Item label={t('quotes.sentAt')}>{fmtDateTime(quote.sentAt)}</Descriptions.Item>
            {quote.decidedAt && <Descriptions.Item label={t('quotes.decidedAt')}>{fmtDateTime(quote.decidedAt)}</Descriptions.Item>}
            <Descriptions.Item label={t('quotes.terms')} span={2}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{quote.terms}</span>
            </Descriptions.Item>
            <Descriptions.Item label={t('quotes.notes')} span={2}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{quote.notes}</span>
            </Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5}>{t('quotes.lines')}</Typography.Title>
          <QuoteLinesTable quote={quote} />
        </div>
      )}
      <Modal title={t('quotes.edit')} open={editing} onOk={saveEdit} onCancel={() => setEditing(false)} okText={t('common.save')} forceRender zIndex={1200}>
        <Form form={form} name="quote-edit" layout="vertical">
          <Form.Item name="subject" label={t('quotes.subject')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('quotes.subject') }) }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Space size="large">
            <Form.Item name="validUntil" label={t('quotes.validUntil')}>
              <DatePicker />
            </Form.Item>
            <Form.Item name="taxPercent" label={t('quotes.taxPercent')}>
              <InputNumber<string> stringMode min="0" max="100" precision={2} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item name="terms" label={t('quotes.terms')}>
            <Input.TextArea rows={4} maxLength={5000} />
          </Form.Item>
          <Form.Item name="notes" label={t('quotes.notes')}>
            <Input.TextArea rows={2} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  );
}
