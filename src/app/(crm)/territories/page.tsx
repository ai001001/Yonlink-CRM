/**
 * 区域管理页（设置 › 区域管理）：区域树（负责人、成员、分配规则、优先级、客户与商机统计）、新建/编辑弹窗、重新分配。
 * 所有用户可查看（统计只含自己能看到的记录）；有 territory.manage（管理员、经理）时可维护。
 * Territories page (Setup › Territories): the territory tree (manager, members, rules, priority, account and deal
 * statistics), the create/edit dialog and "apply rules". Everyone can view (statistics cover visible records only);
 * territory.manage (admins, managers) can maintain.
 */
'use client';

import { useMemo, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Typography } from 'antd';
import { PlusOutlined, SyncOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { ConditionRows, conditionText, type Condition, type FieldDef } from '@/components/ConditionRows';
import { territoryOptions, useTerritories, type Territory } from '@/components/Territories';
import { t, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { useOwners } from '@/lib/hooks';
import { fmtMoney } from '@/lib/format';

/** 规则可用的客户字段（与服务端一致）/ account fields usable in rules (same as the server) */
const FIELDS: Record<string, FieldDef> = {
  name: { type: 'text' },
  industry: { type: 'enum', enumPrefix: 'industry', values: ['MANUFACTURING', 'IT', 'FINANCE', 'RETAIL', 'EDUCATION', 'HEALTHCARE', 'CONSTRUCTION', 'LOGISTICS', 'GOVERNMENT', 'OTHER'] },
  address: { type: 'text' },
  phone: { type: 'text' },
  website: { type: 'text' },
  ownerId: { type: 'id' },
};

interface FormValues {
  name: string;
  description?: string | null;
  parentId?: string | null;
  managerId?: string | null;
  memberIds: string[];
  priority: number;
  match: 'ALL' | 'ANY';
  conditions: Condition[];
}
/** 树节点 / tree node */
type Node = Territory & { children?: Node[] };

/** 去掉不需要值的条件中的值 / drop values of value-less conditions */
const clean = (list: Condition[] = []) => list.map((c) => (['IS_EMPTY', 'NOT_EMPTY'].includes(c.op) ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value: String(c.value ?? '') }));

/** 服务端字段错误代码 → 提示 / server field error codes → messages */
const ERRORS: Record<string, MessageKey> = { taken: 'territories.taken', cycle: 'territories.cycle', too_deep: 'territories.tooDeep', limit_reached: 'territories.limit', not_found: 'territories.userNotFound' };

export default function TerritoriesPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canManage = perm.can('territory.manage');
  const { data, items, reload } = useTerritories();
  const owners = useOwners();
  const users = owners.map((u) => ({ value: u.id, label: u.name }));
  const userName = (id: string) => owners.find((u) => u.id === id)?.name ?? t('workflows.unknownUser');
  const [editing, setEditing] = useState<Territory | 'new' | null>(null);
  /** 用户收起的区域（其余有下级的区域默认展开）/ territories the user collapsed (others with children start expanded) */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [form] = Form.useForm<FormValues>();
  const base = data?.baseCurrency ?? 'CNY';

  /** 树形数据 / tree data */
  const tree = useMemo(() => {
    const build = (parent: string | null): Node[] =>
      items
        .filter((x) => x.parentId === parent)
        .map((x) => {
          const children = build(x.id);
          return children.length ? { ...x, children } : { ...x };
        });
    return build(null);
  }, [items]);

  /** 自己与下级（不能作为上级）/ itself and descendants (not allowed as parent) */
  const excluded = (id: string) => {
    const out = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of items) {
        if (x.parentId && out.has(x.parentId) && !out.has(x.id)) {
          out.add(x.id);
          grew = true;
        }
      }
    }
    return out;
  };

  const open = (r: Territory | 'new') => {
    form.resetFields();
    form.setFieldsValue(
      r === 'new'
        ? { name: '', description: null, parentId: null, managerId: null, memberIds: [], priority: 100, match: 'ALL', conditions: [] }
        : { name: r.name, description: r.description, parentId: r.parentId, managerId: r.managerId, memberIds: r.members.map((m) => m.id), priority: r.priority, match: r.match, conditions: r.conditions },
    );
    setEditing(r);
  };

  /** 显示服务端字段错误 / show server field errors */
  const showError = (err: unknown) => {
    if (err instanceof ClientApiError && err.details) {
      const fields = Object.entries(err.details).filter(([f]) => ['name', 'parentId', 'managerId', 'memberIds'].includes(f));
      if (fields.length) {
        form.setFields(fields.map(([f, codes]) => ({ name: f as keyof FormValues, errors: [ERRORS[codes[0] ?? ''] ? t(ERRORS[codes[0]!]!) : String(codes[0])] })));
        return;
      }
    }
    message.error((err as Error).message);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, description: v.description || null, parentId: v.parentId ?? null, managerId: v.managerId ?? null, memberIds: v.memberIds ?? [], conditions: clean(v.conditions) };
    try {
      if (editing === 'new') await api('/api/territories', { method: 'POST', body });
      else await api(`/api/territories/${(editing as Territory).id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      reload();
    } catch (err) {
      showError(err);
    }
  };

  const remove = async (r: Territory) => {
    try {
      const res = await api<{ cleared: number }>(`/api/territories/${r.id}`, { method: 'DELETE' });
      message.success(t('territories.deleted', { count: res.cleared }));
      reload();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.details?.parentId?.[0] === 'has_children' ? t('territories.hasChildren') : (err as Error).message);
    }
  };

  const apply = async () => {
    try {
      const res = await api<{ checked: number; changed: number }>('/api/territories/apply', { method: 'POST' });
      message.success(t('territories.applied', res));
      reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const money = (amount: string) => fmtMoney(amount, base);

  return (
    <Card
      title={t('territories.title')}
      extra={
        canManage && (
          <Space>
            <Popconfirm title={t('territories.applyConfirm')} onConfirm={() => void apply()}>
              <Button icon={<SyncOutlined />} data-testid="territory-apply">
                {t('territories.apply')}
              </Button>
            </Popconfirm>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} data-testid="territory-new">
              {t('territories.new')}
            </Button>
          </Space>
        )
      }
    >
      <Typography.Paragraph type="secondary">{t('territories.hint')}</Typography.Paragraph>
      <Table<Node>
        rowKey="id"
        dataSource={tree}
        pagination={false}
        expandable={{
          expandedRowKeys: items.filter((x) => !collapsed.has(x.id) && items.some((c) => c.parentId === x.id)).map((x) => x.id),
          onExpand: (expanded, r) =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (expanded) next.delete(r.id);
              else next.add(r.id);
              return next;
            }),
        }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('territories.empty') }}
        data-testid="territory-table"
        columns={[
          { title: t('territories.name'), dataIndex: 'name' },
          { title: t('territories.manager'), render: (_, r) => r.manager?.name ?? '—' },
          { title: t('territories.members'), render: (_, r) => (r.members.length ? r.members.map((m) => m.name).join(t('common.listSep')) : '—') },
          {
            title: t('territories.rules'),
            render: (_, r) =>
              r.conditions.length ? (
                <>
                  <Typography.Text type="secondary">{t(`territories.match.${r.match}`)}</Typography.Text>
                  {r.conditions.map((c, i) => (
                    <div key={i}>{conditionText(FIELDS, c, userName)}</div>
                  ))}
                </>
              ) : (
                <Typography.Text type="secondary">{t('territories.noRule')}</Typography.Text>
              ),
          },
          { title: t('territories.priority'), dataIndex: 'priority' },
          { title: t('territories.accounts'), render: (_, r) => r.stats.accounts },
          { title: t('territories.openDeals'), render: (_, r) => t('territories.countAmount', { count: r.stats.openCount, amount: money(r.stats.openAmount) }) },
          {
            title: t('territories.won'),
            render: (_, r) => (
              <>
                {t('territories.countAmount', { count: r.stats.wonCount, amount: money(r.stats.wonAmount) })}
                {r.stats.missingRates.length > 0 && (
                  <div>
                    <Typography.Text type="warning">{t('territories.missingRates', { list: r.stats.missingRates.join(t('common.listSep')) })}</Typography.Text>
                  </div>
                )}
              </>
            ),
          },
          ...(canManage
            ? [
                {
                  title: t('common.actions'),
                  render: (_: unknown, r: Node) => (
                    <Space>
                      <Button type="link" size="small" onClick={() => open(r)}>
                        {t('common.edit')}
                      </Button>
                      <Popconfirm title={t('territories.confirmDelete', { name: r.name })} onConfirm={() => void remove(r)}>
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
      {data && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 16 }} data-testid="territory-unassigned">
          {t('territories.unassigned', { accounts: data.unassigned.accounts, open: data.unassigned.openCount, amount: money(data.unassigned.openAmount) })}
        </Typography.Paragraph>
      )}
      <Modal title={editing === 'new' ? t('territories.new') : t('territories.edit')} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} okText={t('common.save')} cancelText={t('common.cancel')} width={860} forceRender destroyOnHidden>
        <Form form={form} name="territory" layout="vertical">
          <Space align="start" wrap>
            <Form.Item name="name" label={t('territories.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('territories.name') }) }]}>
              <Input maxLength={100} style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="parentId" label={t('territories.parent')}>
              <Select allowClear style={{ width: 200 }} placeholder={t('territories.topLevel')} options={territoryOptions(items, editing && editing !== 'new' ? excluded(editing.id) : new Set())} />
            </Form.Item>
            <Form.Item name="priority" label={t('territories.priority')} extra={t('territories.priorityHint')} rules={[{ required: true, message: t('common.required', { field: t('territories.priority') }) }]}>
              <InputNumber min={1} max={999} precision={0} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Space align="start" wrap>
            <Form.Item name="managerId" label={t('territories.manager')}>
              <Select allowClear showSearch optionFilterProp="label" style={{ width: 200 }} options={users} />
            </Form.Item>
            <Form.Item name="memberIds" label={t('territories.members')}>
              <Select mode="multiple" allowClear showSearch optionFilterProp="label" style={{ width: 420 }} options={users} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label={t('territories.description')}>
            <Input maxLength={500} />
          </Form.Item>
          <Typography.Title level={5}>{t('territories.rules')}</Typography.Title>
          <Form.Item name="match" label={t('territories.match')}>
            <Segmented options={(['ALL', 'ANY'] as const).map((m) => ({ value: m, label: t(`territories.match.${m}`) }))} />
          </Form.Item>
          <ConditionRows form={form} name="conditions" fields={FIELDS} users={users} prefix={t('territories.condition')} emptyText={t('territories.noRule')} max={10} testId="territory-conditions" />
        </Form>
      </Modal>
    </Card>
  );
}
