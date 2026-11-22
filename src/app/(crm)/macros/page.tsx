/**
 * 宏页（设置 › 宏）：可用的宏列表（对象、范围、动作、创建人、执行次数）与新建/编辑弹窗。
 * 有 record.update.own 的用户可建个人宏；共享宏需 macro.manage（管理员、经理）。
 * Macros page (Setup › Macros): available macros (module, scope, actions, creator, runs) and the create/edit dialog.
 * Users with record.update.own create personal macros; shared macros need macro.manage (admins, managers).
 */
'use client';

import { useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { MACRO_ACTION_TYPES, MACRO_UPDATE_FIELDS, useActionText, useMacros, type Macro, type MacroAction, type MacroEntity } from '@/components/Macros';
import { useTags } from '@/components/Tags';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOwners } from '@/lib/hooks';

interface FormValues {
  name: string;
  description?: string | null;
  entity: MacroEntity;
  scope: 'PERSONAL' | 'SHARED';
  actions: MacroAction[];
}

/** 服务端错误代码 → 提示 / server error codes → messages */
const ERRORS: Record<string, MessageKey> = {
  taken: 'macros.taken',
  limit_reached: 'macros.limit',
  personal_limit_reached: 'macros.personalLimit',
  'owner.assign required': 'macros.ownerAssign',
  user_not_found: 'macros.refMissing',
  tag_not_found: 'macros.refMissing',
  duplicate: 'macros.duplicate',
};

/** 新动作的默认值 / defaults for a new action */
const defaults = (type: MacroAction['type'], entity: MacroEntity): MacroAction =>
  type === 'CREATE_TASK' ? { type, dueInDays: 1, assignTo: 'OWNER' } : type === 'UPDATE_FIELD' ? { type, field: Object.keys(MACRO_UPDATE_FIELDS[entity])[0] } : { type };

/** 保存前去掉与类型无关的项 / keep only the fields of each action type */
function clean(a: MacroAction): MacroAction {
  switch (a.type) {
    case 'UPDATE_FIELD':
      return { type: a.type, field: a.field, value: a.value };
    case 'ASSIGN_OWNER':
      return { type: a.type, userId: a.userId };
    case 'ADD_TAG':
    case 'REMOVE_TAG':
      return { type: a.type, tagId: a.tagId };
    case 'CREATE_TASK':
      return { type: a.type, subject: a.subject, dueInDays: a.dueInDays ?? 0, assignTo: a.assignTo ?? 'OWNER' };
  }
}

export default function MacrosPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canShare = perm.can('macro.manage');
  const canCreate = perm.can('record.update.own');
  const [entity, setEntity] = useState<'ALL' | MacroEntity>('ALL');
  const { items, reload } = useMacros(entity === 'ALL' ? undefined : entity);
  const describe = useActionText();
  const owners = useOwners();
  const [tags] = useTags();
  const userOptions = owners.map((u) => ({ value: u.id, label: u.name }));
  const ownerOrUser = [{ value: 'OWNER', label: t('workflows.recordOwner') }, ...userOptions];
  const [editing, setEditing] = useState<Macro | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const formEntity = (Form.useWatch('entity', form) ?? 'LEAD') as MacroEntity;
  const actions = (Form.useWatch('actions', form) ?? []) as MacroAction[];
  const required = (key: MessageKey) => [{ required: true, message: t('common.required', { field: t(key) }) }];

  const open = (m: Macro | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      m === 'new'
        ? { name: '', description: null, entity: 'LEAD', scope: 'PERSONAL', actions: [defaults('UPDATE_FIELD', 'LEAD')] }
        : { name: m.name, description: m.description, entity: m.entity, scope: m.scope, actions: m.actions },
    );
    setEditing(m);
  };

  const showError = (err: unknown) => {
    const details = err instanceof ClientApiError ? err.details : undefined;
    const name = details?.name?.[0];
    if (name && ERRORS[name]) {
      form.setFields([{ name: 'name', errors: [t(ERRORS[name]!)] }]);
      return;
    }
    const code = details?.actions?.[0] ?? Object.entries(details ?? {}).find(([k]) => k.startsWith('actions.'))?.[1]?.[0];
    message.error(code && ERRORS[code] ? t(ERRORS[code]!) : (err as Error).message);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { name: v.name, description: v.description || null, entity: v.entity, scope: v.scope, actions: v.actions.map(clean) };
    try {
      if (editing === 'new') await api('/api/macros', { method: 'POST', body });
      else await api(`/api/macros/${(editing as Macro).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      reload();
    } catch (err) {
      showError(err);
    }
  };

  const remove = async (m: Macro) => {
    try {
      await api(`/api/macros/${m.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Card
      title={t('macros.title')}
      extra={
        canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="macro-new">
            {t('macros.new')}
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('macros.hint')}</Typography.Paragraph>
      <Segmented
        style={{ marginBottom: 16 }}
        value={entity}
        onChange={(v) => setEntity(v as 'ALL' | MacroEntity)}
        options={[
          { value: 'ALL', label: t('workflows.all') },
          { value: 'LEAD', label: t('workflows.entity.LEAD') },
          { value: 'DEAL', label: t('workflows.entity.DEAL') },
        ]}
      />
      <Table<Macro>
        rowKey="id"
        dataSource={items}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('macros.empty') }}
        columns={[
          {
            title: t('macros.name'),
            render: (_, m) => (
              <>
                {m.name}
                {m.description && (
                  <div>
                    <Typography.Text type="secondary">{m.description}</Typography.Text>
                  </div>
                )}
              </>
            ),
          },
          { title: t('macros.entity'), render: (_, m) => <Tag>{t(`workflows.entity.${m.entity}`)}</Tag> },
          { title: t('macros.scope'), render: (_, m) => <Tag color={m.scope === 'SHARED' ? 'blue' : 'default'}>{t(`macros.scope.${m.scope}`)}</Tag> },
          { title: t('macros.actions'), render: (_, m) => m.actions.map((a, i) => <div key={i}>{describe(m.entity, a)}</div>) },
          { title: t('macros.creator'), render: (_, m) => m.createdBy.name },
          { title: t('macros.runCount'), dataIndex: 'runCount' },
          { title: t('macros.lastRun'), render: (_, m) => (m.lastRunAt ? fmtDateTime(m.lastRunAt) : t('macros.never')) },
          {
            title: t('common.actions'),
            render: (_, m) =>
              m.editable && (
                <Space>
                  <Button type="link" size="small" onClick={() => open(m)}>
                    {t('common.edit')}
                  </Button>
                  <Popconfirm title={t('macros.confirmDelete', { name: m.name })} onConfirm={() => void remove(m)}>
                    <Button type="link" size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />
      <Modal title={editing === 'new' ? t('macros.new') : t('macros.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} width={900} forceRender destroyOnHidden>
        <Form form={form} name="macro" layout="vertical">
          <Space align="start" wrap>
            <Form.Item name="name" label={t('macros.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('macros.name') }) }]}>
              <Input maxLength={100} style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="entity" label={t('macros.entity')}>
              <Select
                style={{ width: 120 }}
                disabled={editing !== 'new'}
                options={(['LEAD', 'DEAL'] as const).map((e) => ({ value: e, label: t(`workflows.entity.${e}`) }))}
                onChange={(e: MacroEntity) => form.setFieldValue('actions', [defaults('UPDATE_FIELD', e)])}
              />
            </Form.Item>
            <Form.Item name="scope" label={t('macros.scope')} extra={canShare ? undefined : t('macros.sharedNeedsManage')}>
              <Segmented options={(['PERSONAL', 'SHARED'] as const).map((s) => ({ value: s, label: t(`macros.scope.${s}`), disabled: s === 'SHARED' && !canShare }))} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label={t('macros.description')}>
            <Input maxLength={500} />
          </Form.Item>
          <Typography.Title level={5}>{t('macros.actions')}</Typography.Title>
          <Form.List name="actions">
            {(rows, { add, remove: drop }) => (
              <div data-testid="macro-actions">
                {rows.map((row, i) => {
                  const a = actions[row.name];
                  const label = `${i + 1}`;
                  const field = MACRO_UPDATE_FIELDS[formEntity][a?.field ?? ''];
                  return (
                    <Space key={row.key} align="start" wrap style={{ display: 'flex' }}>
                      <Form.Item name={[row.name, 'type']} style={{ width: 150 }}>
                        <Select
                          aria-label={`${t('workflows.actionType')} ${label}`}
                          options={MACRO_ACTION_TYPES.map((x) => ({ value: x, label: t(`workflows.action.${x}`) }))}
                          onChange={(type: MacroAction['type']) => {
                            const next = [...(form.getFieldValue('actions') as MacroAction[])];
                            next[row.name] = defaults(type, formEntity);
                            form.setFieldValue('actions', next);
                          }}
                        />
                      </Form.Item>
                      {a?.type === 'UPDATE_FIELD' && (
                        <>
                          <Form.Item name={[row.name, 'field']} style={{ width: 130 }}>
                            <Select aria-label={`${t('workflows.field')} ${label}`} options={Object.keys(MACRO_UPDATE_FIELDS[formEntity]).map((f) => ({ value: f, label: t(`workflows.field.${f}` as MessageKey) }))} />
                          </Form.Item>
                          <Form.Item name={[row.name, 'value']} style={{ width: 160 }} rules={required('workflows.value')}>
                            <Select aria-label={`${t('workflows.newValue')} ${label}`} options={(field?.values ?? []).map((v) => ({ value: v, label: tEnum(field!.enumPrefix, v) }))} />
                          </Form.Item>
                        </>
                      )}
                      {a?.type === 'ASSIGN_OWNER' && (
                        <Form.Item name={[row.name, 'userId']} style={{ width: 200 }} rules={required('workflows.user')}>
                          <Select aria-label={`${t('workflows.user')} ${label}`} options={userOptions} />
                        </Form.Item>
                      )}
                      {(a?.type === 'ADD_TAG' || a?.type === 'REMOVE_TAG') && (
                        <Form.Item name={[row.name, 'tagId']} style={{ width: 200 }} rules={required('workflows.tag')}>
                          <Select aria-label={`${t('workflows.tag')} ${label}`} options={tags.map((x) => ({ value: x.id, label: x.name }))} />
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
                      <Button icon={<DeleteOutlined />} disabled={rows.length === 1} aria-label={`${t('workflows.removeAction')} ${label}`} onClick={() => drop(row.name)} />
                    </Space>
                  );
                })}
                {rows.length < 5 && (
                  <Button size="small" type="dashed" icon={<PlusOutlined />} data-testid="macro-add-action" onClick={() => add(defaults('ADD_TAG', formEntity))}>
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
