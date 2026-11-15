/**
 * 汇率页：本币为人民币；显示各外币今天的有效汇率与历史；管理员可按生效日期录入（同日即修改）或删除汇率。
 * Exchange rates page: the base currency is CNY; today's effective rate per foreign currency and the history;
 * admins enter rates by effective date (same date updates) or delete them.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, DatePicker, Form, InputNumber, Popconfirm, Row, Select, Space, Statistic, Table, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { usePermissions } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

/** 汇率记录 / rate entry */
interface Rate {
  id: string;
  currency: string;
  rate: string;
  effectiveDate: string;
  updatedAt: string;
  createdBy: { id: string; name: string } | null;
}
/** 页面数据 / payload */
interface Rates {
  base: string;
  asOf: string;
  current: { currency: string; rate: string | null }[];
  history: Rate[];
}

export default function ExchangeRatesPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('rate.manage');
  const [data, setData] = useState<Rates | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ currency: string; rate: string; effectiveDate: Dayjs }>();

  const load = useCallback(async () => {
    try {
      setData(await api<Rates>('/api/exchange-rates'));
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [message]);

  useEffect(() => {
    // 打开页面时加载 / load on open
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api('/api/exchange-rates', { method: 'PUT', body: { currency: v.currency, rate: String(v.rate), effectiveDate: v.effectiveDate.format('YYYY-MM-DD') } });
      message.success(t('common.saved'));
      form.setFieldsValue({ rate: undefined });
      void load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: Rate) => {
    try {
      await api(`/api/exchange-rates/${r.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card title={t('rates.title')}>
      <Alert type="info" showIcon title={t('rates.hint', { base: data?.base ?? 'CNY' })} style={{ marginBottom: 16 }} />
      {data && (
        <>
          <Typography.Title level={5}>{t('rates.current', { date: data.asOf })}</Typography.Title>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }} data-testid="rates-current">
            {data.current.map((c) => (
              <Col key={c.currency} xs={12} md={6}>
                <Card size="small">
                  <Statistic title={`1 ${c.currency} = ? ${data.base}`} value={c.rate ?? t('rates.none')} />
                </Card>
              </Col>
            ))}
          </Row>
          {canManage && (
            <Form
              form={form}
              name="rate"
              layout="inline"
              initialValues={{ currency: data.current[0]?.currency, effectiveDate: dayjs() }}
              onFinish={save}
              style={{ marginBottom: 16, rowGap: 8 }}
            >
              <Form.Item name="currency" label={t('rates.currency')} rules={[{ required: true }]}>
                <Select style={{ width: 100 }} options={data.current.map((c) => ({ value: c.currency, label: c.currency }))} />
              </Form.Item>
              <Form.Item name="rate" label={t('rates.rate', { base: data.base })} rules={[{ required: true, message: t('common.required', { field: t('rates.rate', { base: data.base }) }) }]}>
                <InputNumber<string> stringMode min="0.00000001" precision={8} style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name="effectiveDate" label={t('rates.effectiveDate')} rules={[{ required: true }]}>
                <DatePicker allowClear={false} />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={saving}>
                {t('common.save')}
              </Button>
            </Form>
          )}
          <Typography.Title level={5}>{t('rates.history')}</Typography.Title>
          <Table<Rate>
            rowKey="id"
            size="small"
            dataSource={data.history}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            locale={{ emptyText: t('rates.empty') }}
            data-testid="rates-history"
            columns={[
              { title: t('rates.effectiveDate'), dataIndex: 'effectiveDate', render: (v: string) => v.slice(0, 10) },
              { title: t('rates.currency'), dataIndex: 'currency' },
              { title: t('rates.rate', { base: data.base }), dataIndex: 'rate', align: 'right' },
              { title: t('rates.enteredBy'), render: (_, r) => r.createdBy?.name },
              { title: t('rates.updatedAt'), dataIndex: 'updatedAt', render: fmtDateTime },
              ...(canManage
                ? [
                    {
                      title: t('common.actions'),
                      key: 'actions',
                      render: (_: unknown, r: Rate) => (
                        <Popconfirm title={t('rates.deleteConfirm')} onConfirm={() => remove(r)}>
                          <Button type="link" size="small" danger>
                            {t('common.delete')}
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {!canManage && (
            <Space style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">{t('rates.adminOnly')}</Typography.Text>
            </Space>
          )}
        </>
      )}
    </Card>
  );
}
