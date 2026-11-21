/**
 * 自定义字段界面：读取定义、表单中的输入项（按类型）、详情中的显示。表单字段名为 ['custom', 字段键]，
 * 随表单其他值一起提交；停用字段不显示。
 * Custom field UI: loading definitions, form inputs per type and detail display. Form names are ['custom', key] and are
 * submitted with the other values; inactive fields are hidden.
 */
'use client';

import { useEffect, useState } from 'react';
import { DatePicker, Descriptions, Form, Input, InputNumber, Select, Switch } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { t } from '@/i18n';
import { api } from '@/lib/api';

/** 对象 / entity */
export type CustomEntity = 'LEAD' | 'ACCOUNT' | 'CONTACT' | 'DEAL';
/** 字段定义 / field definition */
export interface CustomFieldDef {
  id: string;
  entity: CustomEntity;
  key: string;
  label: string;
  type: 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'DATE' | 'PICKLIST' | 'CHECKBOX' | 'URL' | 'EMAIL';
  options: string[];
  required: boolean;
  isActive: boolean;
}

/**
 * 读取某对象启用的自定义字段（定义很少变化，打开页面时读取一次）。
 * Load an entity's active custom fields (definitions rarely change; loaded once per page).
 */
export function useCustomFields(entity: CustomEntity): CustomFieldDef[] {
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);
  useEffect(() => {
    api<{ items: CustomFieldDef[] }>(`/api/custom-fields?entity=${entity}`)
      .then((r) => setDefs(r.items.filter((d) => d.isActive)))
      .catch(() => setDefs([]));
  }, [entity]);
  return defs;
}

/**
 * 表单中的自定义字段输入项。
 * Custom field inputs inside a form.
 */
export function CustomFieldItems({ defs }: { defs: CustomFieldDef[] }) {
  if (!defs.length) return null;
  return (
    <div data-testid="custom-field-items">
      {defs.map((d) => {
        const rules = d.required ? [{ required: true, message: t('common.required', { field: d.label }) }] : [];
        const name = ['custom', d.key];
        switch (d.type) {
          case 'TEXTAREA':
            return (
              <Form.Item key={d.key} name={name} label={d.label} rules={rules}>
                <Input.TextArea rows={2} maxLength={5000} />
              </Form.Item>
            );
          case 'NUMBER':
            return (
              <Form.Item key={d.key} name={name} label={d.label} rules={rules}>
                <InputNumber<string> stringMode precision={4} style={{ width: '100%' }} />
              </Form.Item>
            );
          case 'DATE':
            return (
              <Form.Item
                key={d.key}
                name={name}
                label={d.label}
                rules={rules}
                getValueProps={(v: string | null) => ({ value: v ? dayjs(v) : null })}
                normalize={(v: Dayjs | null) => (v ? v.format('YYYY-MM-DD') : null)}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            );
          case 'PICKLIST':
            return (
              <Form.Item key={d.key} name={name} label={d.label} rules={rules}>
                <Select allowClear options={d.options.map((o) => ({ value: o, label: o }))} />
              </Form.Item>
            );
          case 'CHECKBOX':
            return (
              <Form.Item key={d.key} name={name} label={d.label} valuePropName="checked">
                <Switch />
              </Form.Item>
            );
          case 'URL':
            return (
              <Form.Item key={d.key} name={name} label={d.label} rules={[...rules, { pattern: /^https?:\/\/\S+$/i, message: t('customFields.invalidUrl') }]}>
                <Input maxLength={500} placeholder="https://" />
              </Form.Item>
            );
          case 'EMAIL':
            return (
              <Form.Item key={d.key} name={name} label={d.label} rules={[...rules, { type: 'email', message: t('customFields.invalidEmail') }]}>
                <Input maxLength={254} />
              </Form.Item>
            );
          default:
            return (
              <Form.Item key={d.key} name={name} label={d.label} rules={rules}>
                <Input maxLength={255} />
              </Form.Item>
            );
        }
      })}
    </div>
  );
}

/** 值的显示 / display a value */
function show(d: CustomFieldDef, v: unknown): React.ReactNode {
  if (v === undefined || v === null || v === '') return '—';
  if (d.type === 'CHECKBOX') return v ? t('common.yes') : t('common.no');
  if (d.type === 'URL')
    return (
      <a href={String(v)} target="_blank" rel="noopener noreferrer">
        {String(v)}
      </a>
    );
  return String(v);
}

/**
 * 详情中的自定义字段（没有字段时不显示）。
 * Custom fields in a detail view (hidden when there are none).
 */
export function CustomFieldValues({ defs, values }: { defs: CustomFieldDef[]; values: Record<string, unknown> | null | undefined }) {
  if (!defs.length) return null;
  return (
    <Descriptions column={2} bordered size="small" title={t('customFields.section')} style={{ marginTop: 16 }} data-testid="custom-field-values">
      {defs.map((d) => (
        <Descriptions.Item key={d.key} label={d.label} span={d.type === 'TEXTAREA' ? 2 : 1}>
          <span style={{ whiteSpace: d.type === 'TEXTAREA' ? 'pre-wrap' : undefined }}>{show(d, values?.[d.key])}</span>
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}
