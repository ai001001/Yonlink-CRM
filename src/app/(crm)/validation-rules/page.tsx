/**
 * 字段验证规则页（设置 › 验证规则）：规则列表（对象、适用条件、要求、提示、启停）与新建/编辑弹窗。
 * 所有用户可查看；有 validation.manage（管理员、经理）时可维护。
 * Validation rules page (Setup › Validation rules): the rule list (module, when, require, message, on/off) and the
 * create/edit dialog. Everyone can view; validation.manage (admins, managers) can maintain.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { ConditionRows, conditionText, fieldLabel, type Condition, type FieldDef } from '@/components/ConditionRows';
import { t } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { useOwners } from '@/lib/hooks';

type Entity = 'LEAD' | 'DEAL';

/** 可用字段（与服务端一致）/ fields (same as the server) */
const FIELDS: Record<Entity, Record<string, FieldDef>> = {
  LEAD: {
    status: { type: 'enum', enumPrefix: 'leadStatus', values: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'] },
    source: { type: 'enum', enumPrefix: 'leadSource', values: ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] },
    name: { type: 'text' },
    company: { type: 'text' },
    title: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    mobile: { type: 'text' },
    description: { type: 'text' },
    ownerId: { type: 'id' },
    campaignId: { type: 'id' },
  },
  DEAL: {
    stage: { type: 'enum', enumPrefix: 'dealStage', values: ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'] },
    currency: { type: 'enum', values: ['CNY', 'USD', 'EUR', 'HKD', 'JPY'] },
    name: { type: 'text' },
    description: { type: 'text' },
    amount: { type: 'number' },
    expectedCloseDate: { type: 'date' },
    ownerId: { type: 'id' },
    campaignId: { type: 'id' },
  },
};

interface Rule {
  id: string;
  name: string;
  entity: Entity;
  when: Condition[];
  require: Condition[];
  message: string;
  errorField: string | null;
  isActive: boolean;
}
type FormValues = Omit<Rule, 'id'>;

/** 去掉不需要值的条件中的值 / drop values of value-less conditions */
const clean = (list: Condition[] = []) => list.map((c) => (['IS_EMPTY', 'NOT_EMPTY'].includes(c.op) ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value: String(c.value ?? '') }));

export default function ValidationRulesPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('validation.manage');
  const owners = useOwners();
  const users = owners.map((u) => ({ value: u.id, label: u.name }));
  const userName = (id: string) => owners.find((u) => u.id === id)?.name ?? t('workflows.unknownUser');
  const [entity, setEntity] = useState<'ALL' | Entity>('ALL');
  const [rows, setRows] = useState<Rule[]>([]);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const formEntity = (Form.useWatch('entity', form) ?? 'LEAD') as Entity;

  const load = useCallback(() => {
    api<{ items: Rule[] }>(`/api/validation-rules${entity === 'ALL' ? '' : `?entity=${entity}`}`)
      .then((r) => setRows(r.items))
      .catch((err: Error) => message.error(err.message));
  }, [entity, message]);
  useEffect(load, [load]);

  const open = (r: Rule | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      r === 'new'
        ? { name: '', entity: 'DEAL', when: [], require: [{ field: 'expectedCloseDate', op: 'NOT_EMPTY' }], message: '', errorField: null, isActive: true }
        : { name: r.name, entity: r.entity, when: r.when, require: r.require, message: r.message, errorField: r.errorField, isActive: r.isActive },
    );
    setEditing(r);
  };

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      load();
      return true;
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.name?.[0] === 'taken') form.setFields([{ name: 'name', errors: [t('validationRules.taken')] }]);
      else message.error((err as Error).message);
      return false;
    }
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, when: clean(v.when), require: clean(v.require), errorField: v.errorField ?? null };
    const ok = await run(() => (editing === 'new' ? api('/api/validation-rules', { method: 'POST', body }) : api(`/api/validation-rules/${(editing as Rule).id}`, { method: 'PATCH', body })), t('common.saved'));
    if (ok) setEditing(null);
  };

  return (
    <Card
      title={t('validationRules.title')}
      extra={
        canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="validation-new">
            {t('validationRules.new')}
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('validationRules.hint')}</Typography.Paragraph>
      <Segmented
        style={{ marginBottom: 16 }}
        value={entity}
        onChange={(v) => setEntity(v as 'ALL' | Entity)}
        options={[
          { value: 'ALL', label: t('workflows.all') },
          { value: 'LEAD', label: t('workflows.entity.LEAD') },
          { value: 'DEAL', label: t('workflows.entity.DEAL') },
        ]}
      />
      <Table<Rule>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('validationRules.empty') }}
        columns={[
          { title: t('validationRules.name'), dataIndex: 'name' },
          { title: t('workflows.entityLabel'), render: (_, r) => <Tag>{t(`workflows.entity.${r.entity}`)}</Tag> },
          {
            title: t('validationRules.when'),
            render: (_, r) => (r.when.length ? r.when.map((c, i) => <div key={i}>{conditionText(FIELDS[r.entity], c, userName)}</div>) : <Typography.Text type="secondary">{t('validationRules.always')}</Typography.Text>),
          },
          { title: t('validationRules.require'), render: (_, r) => r.require.map((c, i) => <div key={i}>{conditionText(FIELDS[r.entity], c, userName)}</div>) },
          { title: t('validationRules.message'), render: (_, r) => `${r.message}${r.errorField ? ` → ${fieldLabel(r.errorField)}` : ''}` },
          {
            title: t('workflows.active'),
            render: (_, r) => (
              <Switch size="small" checked={r.isActive} disabled={!canManage} aria-label={`${t('workflows.active')} ${r.name}`} onChange={(v) => void run(() => api(`/api/validation-rules/${r.id}`, { method: 'PATCH', body: { isActive: v } }))} />
            ),
          },
          ...(canManage
            ? [
                {
                  title: t('common.actions'),
                  render: (_: unknown, r: Rule) => (
                    <Space>
                      <Button type="link" size="small" onClick={() => open(r)}>
                        {t('common.edit')}
                      </Button>
                      <Popconfirm title={t('validationRules.confirmDelete', { name: r.name })} onConfirm={() => void run(() => api(`/api/validation-rules/${r.id}`, { method: 'DELETE' }), t('common.deleted'))}>
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
      <Modal title={editing === 'new' ? t('validationRules.new') : t('validationRules.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} width={860} forceRender destroyOnHidden>
        <Form form={form} name="validation-rule" layout="vertical">
          <Space align="start" wrap>
            <Form.Item name="name" label={t('validationRules.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('validationRules.name') }) }]}>
              <Input maxLength={100} style={{ width: 260 }} />
            </Form.Item>
            <Form.Item name="entity" label={t('workflows.entityLabel')}>
              <Select
                style={{ width: 120 }}
                disabled={editing !== 'new'}
                options={(['LEAD', 'DEAL'] as const).map((e) => ({ value: e, label: t(`workflows.entity.${e}`) }))}
                onChange={(e: Entity) => form.setFieldsValue({ when: [], require: [{ field: Object.keys(FIELDS[e])[0]!, op: 'EQUALS' }], errorField: null })}
              />
            </Form.Item>
            <Form.Item name="isActive" label={t('workflows.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Typography.Title level={5}>{t('validationRules.whenTitle')}</Typography.Title>
          <ConditionRows form={form} name="when" fields={FIELDS[formEntity]} users={users} prefix={t('validationRules.when')} emptyText={t('validationRules.always')} testId="validation-when" />
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('validationRules.requireTitle')}
          </Typography.Title>
          <ConditionRows form={form} name="require" fields={FIELDS[formEntity]} users={users} prefix={t('validationRules.require')} emptyText="" min={1} testId="validation-require" />
          <Space align="start" wrap style={{ marginTop: 16 }}>
            <Form.Item name="message" label={t('validationRules.message')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('validationRules.message') }) }]}>
              <Input maxLength={200} style={{ width: 420 }} />
            </Form.Item>
            <Form.Item name="errorField" label={t('validationRules.errorField')}>
              <Select allowClear style={{ width: 180 }} placeholder={t('validationRules.formTop')} options={Object.keys(FIELDS[formEntity]).map((f) => ({ value: f, label: fieldLabel(f) }))} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
