/**
 * 条件编辑行（验证规则使用）：字段、比较方式、值；值的输入按字段类型变化（枚举下拉、负责人、市场活动、数字、日期、文本）。
 * Condition editor rows (used by validation rules): field, operator and value, with the value input following the field
 * type (enum select, owner, campaign, number, date, text).
 */
'use client';

import { Button, Form, Input, Select, Space, Typography, type FormInstance } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { pickValues } from '@/lib/picklists';
import { t, tEnum, type MessageKey } from '@/i18n';
import { CampaignSelect } from './CampaignSelect';

/** 字段类型 / field type */
export type FieldType = 'enum' | 'text' | 'number' | 'id' | 'date';
/** 字段定义 / field definition */
export interface FieldDef {
  type: FieldType;
  enumPrefix?: string;
  values?: string[];
}
/** 条件 / condition */
export interface Condition {
  field: string;
  op: string;
  value?: string;
}

/** 各类型的比较方式（与服务端一致）/ operators per type (same as the server) */
export const OPS: Record<FieldType, string[]> = {
  enum: ['EQUALS', 'NOT_EQUALS'],
  text: ['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'IS_EMPTY', 'NOT_EMPTY'],
  number: ['GTE', 'LTE'],
  id: ['EQUALS', 'IS_EMPTY', 'NOT_EMPTY'],
  date: ['IS_EMPTY', 'NOT_EMPTY', 'GTE', 'LTE'],
};
/** 不需要值的比较方式 / operators without a value */
export const NO_VALUE = new Set(['IS_EMPTY', 'NOT_EMPTY']);

/** 字段名称 / field label */
export const fieldLabel = (f: string) => t(`workflows.field.${f}` as MessageKey);

/**
 * 条件的显示文本。
 * Display text of a condition.
 * @param userName 负责人 ID → 姓名 / owner id → name
 */
export function conditionText(fields: Record<string, FieldDef>, c: Condition, userName: (id: string) => string): string {
  const def = fields[c.field];
  const op = t(`workflows.op.${c.op}` as MessageKey);
  if (NO_VALUE.has(c.op) || !c.value) return `${fieldLabel(c.field)} ${op}`;
  const value = def?.enumPrefix ? tEnum(def.enumPrefix, c.value) : c.field === 'ownerId' ? userName(c.value) : def?.type === 'text' ? t('assignment.quoted', { value: c.value }) : c.value;
  return `${fieldLabel(c.field)} ${op} ${value}`;
}

/**
 * 条件编辑行。
 * Condition editor rows.
 * @param name 表单列表名 / form list name
 * @param prefix 无障碍标签前缀（区分多组条件）/ accessible-label prefix (tells groups apart)
 * @param min 至少几条 / minimum rows
 * @param max 最多几条 / maximum rows
 */
export function ConditionRows({
  form,
  name,
  fields,
  users,
  prefix,
  emptyText,
  min = 0,
  max = 5,
  testId,
}: {
  form: FormInstance;
  name: string;
  fields: Record<string, FieldDef>;
  users: { value: string; label: string }[];
  prefix: string;
  emptyText: string;
  min?: number;
  max?: number;
  testId: string;
}) {
  const conditions = (Form.useWatch(name, form) ?? []) as Condition[];
  const required = (key: MessageKey) => [{ required: true, message: t('common.required', { field: t(key) }) }];
  return (
    <Form.List name={name}>
      {(rows, { add, remove }) => (
        <div data-testid={testId}>
          {!rows.length && <Typography.Paragraph type="secondary">{emptyText}</Typography.Paragraph>}
          {rows.map((row, i) => {
            const c = conditions[row.name];
            const def = c ? fields[c.field] : undefined;
            const label = `${prefix} ${i + 1}`;
            return (
              <Space key={row.key} align="start" wrap style={{ display: 'flex' }}>
                <Form.Item name={[row.name, 'field']} style={{ width: 150 }} rules={required('workflows.field')}>
                  <Select
                    aria-label={`${t('workflows.field')} ${label}`}
                    options={Object.keys(fields).map((f) => ({ value: f, label: fieldLabel(f) }))}
                    onChange={(f: string) => {
                      const next = [...(form.getFieldValue(name) as Condition[])];
                      next[row.name] = { field: f, op: OPS[fields[f]!.type][0]!, value: undefined };
                      form.setFieldValue(name, next);
                    }}
                  />
                </Form.Item>
                <Form.Item name={[row.name, 'op']} style={{ width: 120 }}>
                  <Select aria-label={`${t('workflows.op')} ${label}`} options={(def ? OPS[def.type] : []).map((o) => ({ value: o, label: t(`workflows.op.${o}` as MessageKey) }))} />
                </Form.Item>
                {def && !NO_VALUE.has(c!.op) && (
                  <Form.Item
                    name={[row.name, 'value']}
                    style={{ width: 220 }}
                    rules={[...required('workflows.value'), ...(def.type === 'date' ? [{ pattern: /^\d{4}-\d{2}-\d{2}$/, message: t('validationRules.dateFormat') }] : [])]}
                  >
                    {def.type === 'enum' ? (
                      <Select aria-label={`${t('workflows.value')} ${label}`} options={(def.enumPrefix ? pickValues(def.enumPrefix, def.values!) : def.values!).map((v) => ({ value: v, label: def.enumPrefix ? tEnum(def.enumPrefix, v) : v }))} />
                    ) : c!.field === 'ownerId' ? (
                      <Select aria-label={`${t('workflows.value')} ${label}`} options={users} />
                    ) : c!.field === 'campaignId' ? (
                      <CampaignSelect aria-label={`${t('workflows.value')} ${label}`} />
                    ) : (
                      <Input aria-label={`${t('workflows.value')} ${label}`} maxLength={def.type === 'text' ? 200 : 19} placeholder={def.type === 'date' ? 'YYYY-MM-DD' : undefined} inputMode={def.type === 'number' ? 'decimal' : undefined} />
                    )}
                  </Form.Item>
                )}
                <Button icon={<DeleteOutlined />} disabled={rows.length <= min} aria-label={`${t('workflows.removeCondition')} ${label}`} onClick={() => remove(row.name)} />
              </Space>
            );
          })}
          {rows.length < max && (
            <Button size="small" type="dashed" icon={<PlusOutlined />} data-testid={`${testId}-add`} onClick={() => add({ field: Object.keys(fields)[0], op: OPS[fields[Object.keys(fields)[0]!]!.type][0] })}>
              {t('workflows.addCondition')}
            </Button>
          )}
        </div>
      )}
    </Form.List>
  );
}
