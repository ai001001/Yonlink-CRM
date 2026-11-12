/**
 * 商机详情的“报价单”页签：该商机的报价单列表、由商机生成报价单、打开报价单详情。
 * Deal "Quotes" tab: the deal's quotes, generate a quote from the deal, open quote details.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Space, Table } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import type { Quote } from '@/lib/types';
import { usePermissions } from './AuthProvider';
import { QuoteDrawer, quoteError, QuoteStatusTag } from './QuoteDrawer';

interface Props {
  deal: { id: string; name: string; ownerId: string | null; _count?: { lineItems: number } };
}

interface CreateForm {
  subject?: string;
  validUntil?: Dayjs | null;
  taxPercent?: string | null;
  terms?: string | null;
}

export function DealQuotesPanel({ deal }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const editable = perm.canEdit(deal);
  const hasItems = (deal._count?.lineItems ?? 0) > 0;
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form] = Form.useForm<CreateForm>();

  const load = useCallback(async () => {
    try {
      setQuotes((await api<{ items: Quote[] }>(`/api/quotes?dealId=${deal.id}&pageSize=100`)).items);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [deal.id, message]);

  useEffect(() => {
    // 打开页签时加载 / load when the tab opens
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const openCreate = () => {
    form.setFieldsValue({ subject: deal.name, validUntil: dayjs().add(30, 'day'), taxPercent: '0', terms: null });
    setCreating(true);
  };

  const create = async () => {
    const v = await form.validateFields();
    try {
      const q = await api<Quote>('/api/quotes', {
        method: 'POST',
        body: { dealId: deal.id, subject: v.subject, validUntil: v.validUntil ? v.validUntil.format('YYYY-MM-DD') : null, taxPercent: String(v.taxPercent ?? '0'), terms: v.terms ?? null },
      });
      message.success(t('common.saved'));
      setCreating(false);
      void load();
      setOpenId(q.id);
    } catch (err) {
      message.error(quoteError(err));
    }
  };

  const closeDrawer = useCallback(() => setOpenId(null), []);

  return (
    <div data-testid="deal-quotes">
      {editable && (
        <Space style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} disabled={!hasItems} onClick={openCreate}>
            {t('quotes.new')}
          </Button>
        </Space>
      )}
      {editable && !hasItems && <Alert type="warning" showIcon title={t('quotes.noItems')} style={{ marginBottom: 12 }} />}
      <Table<Quote>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={quotes}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          {
            title: t('quotes.number'),
            render: (_, r) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setOpenId(r.id)}>
                {r.quoteNumber}
              </Button>
            ),
          },
          { title: t('quotes.subject'), dataIndex: 'subject' },
          { title: t('quotes.status'), render: (_, r) => <QuoteStatusTag quote={r} /> },
          { title: t('quotes.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
          { title: t('quotes.validUntil'), render: (_, r) => fmtDate(r.validUntil?.slice(0, 10)) },
          { title: t('common.createdAt'), render: (_, r) => fmtDateTime(r.createdAt) },
        ]}
      />
      <Modal title={t('quotes.new')} open={creating} onOk={create} onCancel={() => setCreating(false)} okText={t('common.save')} forceRender zIndex={1200}>
        <Alert type="info" showIcon title={t('quotes.newHint')} style={{ marginBottom: 12 }} />
        <Form form={form} name="quote-create" layout="vertical">
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
        </Form>
      </Modal>
      <QuoteDrawer quoteId={openId} onClose={closeDrawer} onChanged={() => void load()} />
    </div>
  );
}
