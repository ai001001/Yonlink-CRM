/**
 * 工作流规则页：规则列表（对象、触发时机、条件、动作、启停、执行次数）与新建/编辑弹窗。
 * 所有用户可查看；有 workflow.manage（管理员、经理）时可新建、编辑、启停、删除。
 * Workflow rules page: the rule list (entity, trigger, conditions, actions, on/off, runs) and the create/edit dialog.
 * Everyone can view; users with workflow.manage (admins, managers) can create, edit, toggle and delete.
 */
'use client';

import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { CampaignSelect } from '@/components/CampaignSelect';
import { useTags } from '@/components/Tags';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOwners, usePagedList } from '@/lib/hooks';

type Entity = 'LEAD' | 'DEAL';
type Trigger = 'CREATE' | 'UPDATE' | 'CREATE_OR_UPDATE' | 'FIELD_CHANGE';
type FieldType = 'enum' | 'text' | 'number' | 'id';

/** 条件字段（与服务端一致）/ condition fields (same as the server) */
const FIELDS: Record<Entity, Record<string, { type: FieldType; enumPrefix?: string; values?: string[] }>> = {
  LEAD: {
    status: { type: 'enum', enumPrefix: 'leadStatus', values: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'] },
    source: { type: 'enum', enumPrefix: 'leadSource', values: ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] },
    name: { type: 'text' },
    company: { type: 'text' },
    title: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    description: { type: 'text' },
    score: { type: 'number' },
    ownerId: { type: 'id' },
    campaignId: { type: 'id' },
  },
  DEAL: {
    stage: { type: 'enum', enumPrefix: 'dealStage', values: ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'] },
    currency: { type: 'enum', values: ['CNY', 'USD', 'EUR', 'HKD', 'JPY'] },
    name: { type: 'text' },
    description: { type: 'text' },
    amount: { type: 'number' },
    score: { type: 'number' },
    ownerId: { type: 'id' },
    campaignId: { type: 'id' },
  },
};
const TRIGGER_FIELDS: Record<Entity, string[]> = { LEAD: ['status', 'source', 'ownerId', 'campaignId'], DEAL: ['stage', 'amount', 'currency', 'ownerId', 'expectedCloseDate'] };
const UPDATE_FIELDS: Record<Entity, Record<string, { enumPrefix: string; values: string[] }>> = {
  LEAD: {
    status: { enumPrefix: 'leadStatus', values: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED'] },
    source: { enumPrefix: 'leadSource', values: FIELDS.LEAD.source!.values! },
  },
  DEAL: { stage: { enumPrefix: 'dealStage', values: FIELDS.DEAL.stage!.values! } },
};
const OPS: Record<FieldType, string[]> = {
  enum: ['EQUALS', 'NOT_EQUALS'],
  text: ['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'IS_EMPTY', 'NOT_EMPTY'],
  number: ['GTE', 'LTE'],
  id: ['EQUALS', 'IS_EMPTY', 'NOT_EMPTY'],
};
const NO_VALUE = new Set(['IS_EMPTY', 'NOT_EMPTY']);
const ACTION_TYPES = ['UPDATE_FIELD', 'ASSIGN_OWNER', 'CREATE_TASK', 'NOTIFY', 'ADD_TAG', 'WEBHOOK'] as const;

interface Condition {
  field: string;
  op: string;
  value?: string;
}
interface Action {
  type: (typeof ACTION_TYPES)[number];
  field?: string;
  value?: string;
  userId?: string;
  subject?: string;
  dueInDays?: number;
  assignTo?: string;
  recipient?: string;
  message?: string;
  tagId?: string;
  webhookId?: string;
}
interface Rule {
  id: string;
  name: string;
  entity: Entity;
  trigger: Trigger;
  triggerField: string | null;
  conditions: Condition[];
  actions: Action[];
  isActive: boolean;
  runCount: number;
  lastRunAt: string | null;
  createdBy: { id: string; name: string } | null;
}
type FormValues = Omit<Rule, 'id' | 'runCount' | 'lastRunAt' | 'createdBy'>;

/** 字段名称 / field label */
const fieldLabel = (f: string) => t(`workflows.field.${f}` as MessageKey);

export default function WorkflowsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('workflow.manage');
  const owners = useOwners();
  const [tags] = useTags();
  const [webhooks, setWebhooks] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  useEffect(() => {
    if (!canManage) return;
    api<{ items: { id: string; name: string; isActive: boolean }[] }>('/api/webhooks')
      .then((r) => setWebhooks(r.items))
      .catch(() => setWebhooks([]));
  }, [canManage]);
  const [entity, setEntity] = useState<'ALL' | Entity>('ALL');
  const { data, loading, reload, pagination } = usePagedList<Rule>('/api/workflows', { entity: entity === 'ALL' ? undefined : entity });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const formEntity = (Form.useWatch('entity', form) ?? 'LEAD') as Entity;
  const trigger = Form.useWatch('trigger', form) as Trigger | undefined;
  const conditions = (Form.useWatch('conditions', form) ?? []) as Condition[];
  const actions = (Form.useWatch('actions', form) ?? []) as Action[];

  const userName = (id?: string) => owners.find((u) => u.id === id)?.name ?? t('workflows.unknownUser');
  /** 值的显示 / display a value */
  const valueText = (e: Entity, field: string, v?: string) => {
    const def = FIELDS[e][field];
    if (!v) return '';
    if (def?.enumPrefix) return tEnum(def.enumPrefix, v);
    if (field === 'ownerId') return userName(v);
    if (def?.type === 'text') return t('assignment.quoted', { value: v });
    return v;
  };
  const conditionText = (e: Entity, c: Condition) => `${fieldLabel(c.field)} ${t(`workflows.op.${c.op}` as MessageKey)}${NO_VALUE.has(c.op) ? '' : ` ${valueText(e, c.field, c.value)}`}`;
  const actionText = (e: Entity, a: Action) => {
    switch (a.type) {
      case 'UPDATE_FIELD':
        return t('workflows.actionText.UPDATE_FIELD', { field: fieldLabel(a.field ?? ''), value: tEnum(UPDATE_FIELDS[e][a.field ?? '']?.enumPrefix ?? '', a.value) });
      case 'ASSIGN_OWNER':
        return t('workflows.actionText.ASSIGN_OWNER', { user: userName(a.userId) });
      case 'CREATE_TASK':
        return t('workflows.actionText.CREATE_TASK', { subject: a.subject ?? '', days: a.dueInDays ?? 0, user: a.assignTo === 'OWNER' ? t('workflows.recordOwner') : userName(a.assignTo) });
      case 'NOTIFY':
        return t('workflows.actionText.NOTIFY', { user: a.recipient === 'OWNER' ? t('workflows.recordOwner') : userName(a.recipient), message: a.message ?? '' });
      case 'ADD_TAG':
        return t('workflows.actionText.ADD_TAG', { tag: tags.find((x) => x.id === a.tagId)?.name ?? t('workflows.deletedTag') });
      case 'WEBHOOK':
        return t('workflows.actionText.WEBHOOK', { name: webhooks.find((x) => x.id === a.webhookId)?.name ?? t('workflows.webhookHidden') });
    }
  };
  const triggerText = (r: Pick<Rule, 'trigger' | 'triggerField'>) =>
    r.trigger === 'FIELD_CHANGE' ? t('workflows.trigger.fieldChanged', { field: fieldLabel(r.triggerField ?? '') }) : t(`workflows.trigger.${r.trigger}` as MessageKey);

  const openForm = (r: Rule | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      r === 'new'
        ? { name: '', entity: 'LEAD', trigger: 'CREATE', triggerField: null, conditions: [], actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '' }], isActive: true }
        : { name: r.name, entity: r.entity, trigger: r.trigger, triggerField: r.triggerField, conditions: r.conditions, actions: r.actions, isActive: r.isActive },
    );
    setEditing(r);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = {
      ...v,
      triggerField: v.trigger === 'FIELD_CHANGE' ? v.triggerField : null,
      conditions: (v.conditions ?? []).map((c) => (NO_VALUE.has(c.op) ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value: String(c.value ?? '') })),
      actions: (v.actions ?? []).map((a) => {
        switch (a.type) {
          case 'UPDATE_FIELD':
            return { type: a.type, field: a.field, value: a.value };
          case 'ASSIGN_OWNER':
            return { type: a.type, userId: a.userId };
          case 'CREATE_TASK':
            return { type: a.type, subject: a.subject, dueInDays: a.dueInDays ?? 0, assignTo: a.assignTo ?? 'OWNER' };
          case 'NOTIFY':
            return { type: a.type, recipient: a.recipient ?? 'OWNER', message: a.message };
          case 'ADD_TAG':
            return { type: a.type, tagId: a.tagId };
          case 'WEBHOOK':
            return { type: a.type, webhookId: a.webhookId };
        }
      }),
    };
    setSaving(true);
    try {
      if (editing === 'new') await api('/api/workflows', { method: 'POST', body });
      else await api(`/api/workflows/${(editing as Rule).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      void reload();
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.name?.[0] === 'taken') form.setFields([{ name: 'name', errors: [t('workflows.error.taken')] }]);
      else message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (r: Rule, isActive: boolean) => {
    try {
      await api(`/api/workflows/${r.id}`, { method: 'PATCH', body: { isActive } });
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const remove = async (r: Rule) => {
    try {
      await api(`/api/workflows/${r.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      void reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const required = (key: MessageKey) => [{ required: true, message: t('common.required', { field: t(key) }) }];
  const userOptions = owners.map((u) => ({ value: u.id, label: u.name }));
  const ownerOrUser = [{ value: 'OWNER', label: t('workflows.recordOwner') }, ...userOptions];

  return (
    <Card
      title={t('workflows.title')}
      extra={
        canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('workflows.new')}
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('workflows.hint')}</Typography.Paragraph>
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
        loading={loading}
        dataSource={data.items}
        scroll={{ x: 'max-content' }}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          { title: t('workflows.name'), dataIndex: 'name' },
          { title: t('workflows.entityLabel'), render: (_, r) => <Tag>{t(`workflows.entity.${r.entity}`)}</Tag> },
          { title: t('workflows.triggerLabel'), render: (_, r) => triggerText(r) },
          {
            title: t('workflows.conditions'),
            render: (_, r) => (r.conditions.length ? r.conditions.map((c, i) => <div key={i}>{conditionText(r.entity, c)}</div>) : <Typography.Text type="secondary">{t('workflows.always')}</Typography.Text>),
          },
          { title: t('workflows.actions'), render: (_, r) => r.actions.map((a, i) => <div key={i}>{actionText(r.entity, a)}</div>) },
          {
            title: t('workflows.active'),
            render: (_, r) => <Switch size="small" checked={r.isActive} disabled={!canManage} aria-label={`${t('workflows.active')} ${r.name}`} onChange={(v) => void toggle(r, v)} />,
          },
          { title: t('workflows.runCount'), dataIndex: 'runCount', align: 'right' },
          { title: t('workflows.lastRunAt'), render: (_, r) => fmtDateTime(r.lastRunAt) || '—' },
          ...(canManage
            ? [
                {
                  title: t('common.actions'),
                  render: (_: unknown, r: Rule) => (
                    <Space>
                      <Button type="link" size="small" onClick={() => openForm(r)}>
                        {t('common.edit')}
                      </Button>
                      <Popconfirm title={t('workflows.confirmDelete', { name: r.name })} onConfirm={() => void remove(r)}>
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

      <Modal
        title={editing === 'new' ? t('workflows.new') : t('workflows.edit')}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={save}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saving}
        width={900}
        forceRender
        destroyOnHidden
      >
        <Form form={form} name="workflow" layout="vertical">
          <Space align="start" wrap>
            <Form.Item name="name" label={t('workflows.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('workflows.name') }) }]}>
              <Input maxLength={100} style={{ width: 260 }} />
            </Form.Item>
            <Form.Item name="entity" label={t('workflows.entityLabel')}>
              <Select
                style={{ width: 120 }}
                disabled={editing !== 'new'}
                options={(['LEAD', 'DEAL'] as const).map((e) => ({ value: e, label: t(`workflows.entity.${e}`) }))}
                onChange={() => form.setFieldsValue({ triggerField: null, conditions: [], actions: [{ type: 'NOTIFY', recipient: 'OWNER', message: '' }] })}
              />
            </Form.Item>
            <Form.Item name="trigger" label={t('workflows.triggerLabel')}>
              <Select style={{ width: 180 }} options={(['CREATE', 'UPDATE', 'CREATE_OR_UPDATE', 'FIELD_CHANGE'] as const).map((x) => ({ value: x, label: t(`workflows.trigger.${x}`) }))} />
            </Form.Item>
            {trigger === 'FIELD_CHANGE' && (
              <Form.Item name="triggerField" label={t('workflows.triggerField')} rules={required('workflows.triggerField')}>
                <Select style={{ width: 160 }} options={TRIGGER_FIELDS[formEntity].map((f) => ({ value: f, label: fieldLabel(f) }))} />
              </Form.Item>
            )}
            <Form.Item name="isActive" label={t('workflows.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>

          <Typography.Title level={5}>{t('workflows.conditionsTitle')}</Typography.Title>
          <Form.List name="conditions">
            {(rows, { add, remove: drop }) => (
              <div data-testid="workflow-conditions">
                {!rows.length && <Typography.Paragraph type="secondary">{t('workflows.always')}</Typography.Paragraph>}
                {rows.map((row, i) => {
                  const c = conditions[row.name];
                  const def = c ? FIELDS[formEntity][c.field] : undefined;
                  const label = `${i + 1}`;
                  return (
                    <Space key={row.key} align="start" wrap style={{ display: 'flex' }}>
                      <Form.Item name={[row.name, 'field']} style={{ width: 150 }} rules={required('workflows.field')}>
                        <Select
                          aria-label={`${t('workflows.field')} ${label}`}
                          options={Object.keys(FIELDS[formEntity]).map((f) => ({ value: f, label: fieldLabel(f) }))}
                          onChange={(f: string) => {
                            const next = [...(form.getFieldValue('conditions') as Condition[])];
                            next[row.name] = { field: f, op: OPS[FIELDS[formEntity][f]!.type][0]!, value: undefined };
                            form.setFieldValue('conditions', next);
                          }}
                        />
                      </Form.Item>
                      <Form.Item name={[row.name, 'op']} style={{ width: 120 }}>
                        <Select aria-label={`${t('workflows.op')} ${label}`} options={(def ? OPS[def.type] : []).map((o) => ({ value: o, label: t(`workflows.op.${o}` as MessageKey) }))} />
                      </Form.Item>
                      {def && !NO_VALUE.has(c!.op) && (
                        <Form.Item name={[row.name, 'value']} style={{ width: 240 }} rules={required('workflows.value')}>
                          {def.type === 'enum' ? (
                            <Select aria-label={`${t('workflows.value')} ${label}`} options={def.values!.map((v) => ({ value: v, label: def.enumPrefix ? tEnum(def.enumPrefix, v) : v }))} />
                          ) : def.type === 'number' ? (
                            <Input aria-label={`${t('workflows.value')} ${label}`} inputMode="decimal" maxLength={19} />
                          ) : c!.field === 'ownerId' ? (
                            <Select aria-label={`${t('workflows.value')} ${label}`} options={userOptions} />
                          ) : c!.field === 'campaignId' ? (
                            <CampaignSelect aria-label={`${t('workflows.value')} ${label}`} />
                          ) : (
                            <Input aria-label={`${t('workflows.value')} ${label}`} maxLength={200} />
                          )}
                        </Form.Item>
                      )}
                      <Button icon={<DeleteOutlined />} aria-label={`${t('workflows.removeCondition')} ${label}`} onClick={() => drop(row.name)} />
                    </Space>
                  );
                })}
                {rows.length < 5 && (
                  <Button size="small" type="dashed" icon={<PlusOutlined />} data-testid="workflow-add-condition" onClick={() => add({ field: Object.keys(FIELDS[formEntity])[0], op: 'EQUALS' })}>
                    {t('workflows.addCondition')}
                  </Button>
                )}
              </div>
            )}
          </Form.List>

          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('workflows.actionsTitle')}
          </Typography.Title>
          <Form.List name="actions">
            {(rows, { add, remove: drop }) => (
              <div data-testid="workflow-actions">
                {rows.map((row, i) => {
                  const a = actions[row.name];
                  const label = `${i + 1}`;
                  return (
                    <Space key={row.key} align="start" wrap style={{ display: 'flex' }}>
                      <Form.Item name={[row.name, 'type']} style={{ width: 150 }}>
                        <Select
                          aria-label={`${t('workflows.actionType')} ${label}`}
                          options={ACTION_TYPES.map((x) => ({ value: x, label: t(`workflows.action.${x}`) }))}
                          onChange={(type: Action['type']) => {
                            const next = [...(form.getFieldValue('actions') as Action[])];
                            next[row.name] =
                              type === 'CREATE_TASK' ? { type, dueInDays: 1, assignTo: 'OWNER' } : type === 'NOTIFY' ? { type, recipient: 'OWNER' } : type === 'UPDATE_FIELD' ? { type, field: Object.keys(UPDATE_FIELDS[formEntity])[0] } : { type };
                            form.setFieldValue('actions', next);
                          }}
                        />
                      </Form.Item>
                      {a?.type === 'UPDATE_FIELD' && (
                        <>
                          <Form.Item name={[row.name, 'field']} style={{ width: 130 }}>
                            <Select aria-label={`${t('workflows.field')} ${t('workflows.action.UPDATE_FIELD')} ${label}`} options={Object.keys(UPDATE_FIELDS[formEntity]).map((f) => ({ value: f, label: fieldLabel(f) }))} />
                          </Form.Item>
                          <Form.Item name={[row.name, 'value']} style={{ width: 160 }} rules={required('workflows.value')}>
                            <Select
                              aria-label={`${t('workflows.newValue')} ${label}`}
                              options={(UPDATE_FIELDS[formEntity][a.field ?? '']?.values ?? []).map((v) => ({ value: v, label: tEnum(UPDATE_FIELDS[formEntity][a.field ?? '']!.enumPrefix, v) }))}
                            />
                          </Form.Item>
                        </>
                      )}
                      {a?.type === 'ASSIGN_OWNER' && (
                        <Form.Item name={[row.name, 'userId']} style={{ width: 200 }} rules={required('workflows.user')}>
                          <Select aria-label={`${t('workflows.user')} ${label}`} options={userOptions} />
                        </Form.Item>
                      )}
                      {a?.type === 'CREATE_TASK' && (
                        <>
                          <Form.Item name={[row.name, 'subject']} style={{ width: 240 }} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('workflows.taskSubject') }) }]}>
                            <Input aria-label={`${t('workflows.taskSubject')} ${label}`} placeholder={t('workflows.taskSubject')} maxLength={200} />
                          </Form.Item>
                          <Form.Item name={[row.name, 'dueInDays']}>
                            <InputNumber aria-label={`${t('workflows.dueInDays')} ${label}`} min={0} max={365} precision={0} suffix={t('workflows.daysLater')} />
                          </Form.Item>
                          <Form.Item name={[row.name, 'assignTo']} style={{ width: 160 }}>
                            <Select aria-label={`${t('workflows.assignTo')} ${label}`} options={ownerOrUser} />
                          </Form.Item>
                        </>
                      )}
                      {a?.type === 'NOTIFY' && (
                        <>
                          <Form.Item name={[row.name, 'recipient']} style={{ width: 160 }}>
                            <Select aria-label={`${t('workflows.recipient')} ${label}`} options={ownerOrUser} />
                          </Form.Item>
                          <Form.Item name={[row.name, 'message']} style={{ width: 300 }} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('workflows.message') }) }]}>
                            <Input aria-label={`${t('workflows.message')} ${label}`} placeholder={t('workflows.message')} maxLength={150} />
                          </Form.Item>
                        </>
                      )}
                      {a?.type === 'WEBHOOK' && (
                        <Form.Item name={[row.name, 'webhookId']} style={{ width: 220 }} rules={required('workflows.webhook')}>
                          <Select aria-label={`${t('workflows.webhook')} ${label}`} options={webhooks.map((x) => ({ value: x.id, label: x.isActive ? x.name : t('workflows.webhookInactive', { name: x.name }) }))} />
                        </Form.Item>
                      )}
                      {a?.type === 'ADD_TAG' && (
                        <Form.Item name={[row.name, 'tagId']} style={{ width: 200 }} rules={required('workflows.tag')}>
                          <Select aria-label={`${t('workflows.tag')} ${label}`} options={tags.map((x) => ({ value: x.id, label: x.name }))} />
                        </Form.Item>
                      )}
                      <Button icon={<DeleteOutlined />} disabled={rows.length === 1} aria-label={`${t('workflows.removeAction')} ${label}`} onClick={() => drop(row.name)} />
                    </Space>
                  );
                })}
                {rows.length < 5 && (
                  <Button size="small" type="dashed" icon={<PlusOutlined />} data-testid="workflow-add-action" onClick={() => add({ type: 'NOTIFY', recipient: 'OWNER' })}>
                    {t('workflows.addAction')}
                  </Button>
                )}
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  );
}
