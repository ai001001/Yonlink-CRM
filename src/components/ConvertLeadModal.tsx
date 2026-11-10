/**
 * 线索转化弹窗：新建或关联客户、自动创建联系人、可选创建商机。
 * Lead conversion modal: new or existing account, automatic contact, optional deal.
 */
'use client';

import { useEffect, useState } from 'react';
import { Alert, App, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Radio, Select, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import type { Ref } from '@/lib/types';
import { RecordSelect } from './RecordSelect';

/** 被转化的线索（所需字段）/ Lead being converted (fields needed here) */
export interface ConvertibleLead {
  id: string;
  name: string;
  company: string | null;
}

/** 转化结果 / Conversion result */
export interface ConvertResult {
  account: Ref;
  contact: Ref;
  deal: Ref | null;
}

interface FormValues {
  accountMode: 'new' | 'existing';
  accountName?: string;
  accountId?: string;
  createDeal: boolean;
  dealName?: string;
  amount?: string | null;
  currency?: string;
  stage?: string;
  expectedCloseDate?: Dayjs | null;
}

const STAGES = ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'];

interface Props {
  lead: ConvertibleLead | null;
  onClose: () => void;
  onConverted: (result: ConvertResult) => void;
}

export function ConvertLeadModal({ lead, onClose, onConverted }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const accountMode = Form.useWatch('accountMode', form);
  const createDeal = Form.useWatch('createDeal', form);

  useEffect(() => {
    if (!lead) return;
    form.resetFields();
    const base = lead.company ?? lead.name;
    form.setFieldsValue({ accountName: base, dealName: base });
  }, [lead, form]);

  const submit = async () => {
    if (!lead) return;
    const v = await form.validateFields();
    const body = {
      account: v.accountMode === 'new' ? { mode: 'new', name: v.accountName } : { mode: 'existing', accountId: v.accountId },
      deal: v.createDeal
        ? {
            name: v.dealName,
            amount: v.amount ? String(v.amount) : '0',
            currency: v.currency,
            stage: v.stage,
            expectedCloseDate: v.expectedCloseDate ? v.expectedCloseDate.format('YYYY-MM-DD') : null,
          }
        : null,
    };
    setSaving(true);
    try {
      const res = await api<ConvertResult>(`/api/leads/${lead.id}/convert`, { method: 'POST', body });
      message.success(t('convert.success'));
      onConverted(res);
    } catch (err) {
      message.error(err instanceof ClientApiError && err.code === 'CONFLICT' ? t('convert.alreadyConverted') : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('convert.title')}
      open={lead !== null}
      onOk={submit}
      onCancel={onClose}
      confirmLoading={saving}
      okText={t('convert.submit')}
      width={640}
      forceRender
      zIndex={1100}
    >
      {lead && <Alert type="info" showIcon style={{ marginBottom: 16 }} title={t('convert.intro', { name: lead.name })} />}
      <Form form={form} name="convert" layout="vertical" initialValues={{ accountMode: 'new', createDeal: false, currency: 'CNY', stage: 'QUALIFICATION' }}>
        <Form.Item name="accountMode" label={t('convert.account')}>
          <Radio.Group
            options={[
              { value: 'new', label: t('convert.newAccount') },
              { value: 'existing', label: t('convert.existingAccount') },
            ]}
          />
        </Form.Item>
        {accountMode === 'existing' ? (
          <Form.Item name="accountId" label={t('convert.selectAccount')} rules={[{ required: true, message: t('common.required', { field: t('convert.selectAccount') }) }]}>
            <RecordSelect resource="/api/accounts" />
          </Form.Item>
        ) : (
          <Form.Item
            name="accountName"
            label={t('convert.accountName')}
            rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('convert.accountName') }) }]}
          >
            <Input maxLength={200} />
          </Form.Item>
        )}
        <Form.Item label={t('convert.contact')}>
          <Typography.Text type="secondary">{lead && t('convert.contactHint', { name: lead.name })}</Typography.Text>
        </Form.Item>
        <Form.Item name="createDeal" valuePropName="checked">
          <Checkbox>{t('convert.createDeal')}</Checkbox>
        </Form.Item>
        {createDeal && (
          <>
            <Form.Item
              name="dealName"
              label={t('deals.name')}
              rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('deals.name') }) }]}
            >
              <Input maxLength={200} />
            </Form.Item>
            <div className="form-row">
              <Form.Item name="amount" label={t('deals.amount')} rules={[{ pattern: /^\d{1,16}(\.\d{1,2})?$/, message: t('deals.invalidAmount') }]}>
                <InputNumber<string> stringMode min="0" precision={2} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="currency" label={t('deals.currency')}>
                <Select options={['CNY', 'USD', 'EUR', 'HKD', 'JPY'].map((v) => ({ value: v, label: v }))} />
              </Form.Item>
            </div>
            <div className="form-row">
              <Form.Item name="stage" label={t('deals.stage')}>
                <Select options={STAGES.map((v) => ({ value: v, label: tEnum('dealStage', v) }))} />
              </Form.Item>
              <Form.Item name="expectedCloseDate" label={t('deals.expectedCloseDate')}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </div>
          </>
        )}
      </Form>
    </Modal>
  );
}
