/**
 * 线索分配规则弹窗：按顺序列出规则（名称、启用、条件、轮流分配的负责人、已分配次数），可上下调整顺序。
 * 所有用户可查看；有 assignment.manage 时可编辑并保存（整体替换，保存后轮转从头开始）。
 * Lead assignment rules dialog: rules in order (name, active, conditions, round-robin users, assignments made) with
 * move up/down. Everyone can view; users with assignment.manage can edit and save (replaces all, restarts rotation).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Modal, Select, Space, Switch, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { api } from '@/lib/api';
import { useOwners } from '@/lib/hooks';
import { CampaignSelect } from './CampaignSelect';

/** 条件字段 / condition fields */
const FIELDS = ['source', 'campaign', 'webForm', 'company', 'title', 'email', 'description'] as const;
type Field = (typeof FIELDS)[number];
/** 文本比较方式 / text operators */
const TEXT_OPS = ['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH'] as const;
/** 线索来源 / lead sources */
const SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] as const;

/** 条件 / condition */
interface Condition {
  field: Field;
  op: string;
  value: string;
}

/** 服务端返回的规则 / rule from the server */
interface Rule {
  id: string;
  name: string;
  isActive: boolean;
  cursor: number;
  conditions: Condition[];
  users: { id: string; name: string; isActive: boolean }[];
}

/** 分配规则设置 / assignment setup */
export interface AssignmentSetup {
  rules: Rule[];
  names: { campaign: Record<string, string>; webForm: Record<string, string> };
}

/** 表单中的规则 / rule in the form */
interface RuleForm {
  name: string;
  isActive: boolean;
  conditions: Condition[];
  userIds: string[];
  cursor?: number;
}

/** 是否为“等于”专用字段 / fields that only support "equals" */
const equalsOnly = (f: Field | undefined) => f === 'source' || f === 'campaign' || f === 'webForm';

/**
 * 条件的显示文本（查看与审计共用）。
 * Display text of a condition (used by the dialog and audit view).
 */
export function conditionText(c: Condition, names?: AssignmentSetup['names']): string {
  const value =
    c.field === 'source' ? tEnum('leadSource', c.value) : c.field === 'campaign' || c.field === 'webForm' ? (names?.[c.field][c.value] ?? t('assignment.deleted')) : t('assignment.quoted', { value: c.value });
  return `${t(`assignment.field.${c.field}`)} ${t(`assignment.op.${c.op as (typeof TEXT_OPS)[number]}`)} ${value}`;
}

/** 网页表单选项 / web form options */
function useWebForms(open: boolean) {
  const [forms, setForms] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    api<{ items: { id: string; name: string }[] }>('/api/web-forms?pageSize=100')
      .then((r) => setForms(r.items.map((f) => ({ value: f.id, label: f.name }))))
      .catch(() => setForms([]));
  }, [open]);
  return forms;
}

/**
 * 读取分配规则。
 * Load the assignment rules.
 */
export function useAssignmentRules() {
  const [setup, setSetup] = useState<AssignmentSetup | null>(null);
  const reload = useCallback(() => {
    api<AssignmentSetup>('/api/assignment-rules')
      .then(setSetup)
      .catch(() => setSetup(null));
  }, []);
  useEffect(reload, [reload]);
  return { setup, reload };
}

export function AssignmentRulesModal({ open, onClose, canManage }: { open: boolean; onClose: () => void; canManage: boolean }) {
  const { message } = App.useApp();
  const { setup, reload } = useAssignmentRules();
  const owners = useOwners();
  const webForms = useWebForms(open);
  const [form] = Form.useForm<{ rules: RuleForm[] }>();
  const [saving, setSaving] = useState(false);
  const rules = Form.useWatch('rules', form) ?? [];

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);
  useEffect(() => {
    if (open && setup) form.setFieldsValue({ rules: setup.rules.map((r) => ({ name: r.name, isActive: r.isActive, conditions: r.conditions, userIds: r.users.map((u) => u.id), cursor: r.cursor })) });
  }, [open, setup, form]);

  // 已停用的负责人也要能显示名称 / show names of inactive users too
  const userOptions = [
    ...owners.map((u) => ({ value: u.id, label: u.name })),
    ...(setup?.rules.flatMap((r) => r.users.filter((u) => !owners.some((o) => o.id === u.id)).map((u) => ({ value: u.id, label: t('assignment.inactiveUser', { name: u.name }) }))) ?? []),
  ].filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api('/api/assignment-rules', {
        method: 'PUT',
        body: { rules: (v.rules ?? []).map((r) => ({ name: r.name, isActive: r.isActive ?? true, conditions: r.conditions ?? [], userIds: r.userIds })) },
      });
      message.success(t('assignment.saved'));
      reload();
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('assignment.title')}
      open={open}
      onCancel={onClose}
      width={880}
      forceRender
      zIndex={1100}
      footer={
        canManage
          ? [
              <Button key="cancel" onClick={onClose}>
                {t('common.cancel')}
              </Button>,
              <Button key="save" type="primary" loading={saving} onClick={save}>
                {t('common.save')}
              </Button>,
            ]
          : [
              <Button key="close" onClick={onClose}>
                {t('common.close')}
              </Button>,
            ]
      }
    >
      <Alert type="info" showIcon title={t('assignment.hint')} style={{ marginBottom: 16 }} />
      <Form form={form} name="assignment" layout="vertical" disabled={!canManage}>
        <Form.List name="rules">
          {(rows, { add, remove, move }) => (
            <div data-testid="assignment-rules">
              {!rows.length && <Typography.Paragraph type="secondary">{t('assignment.noRules')}</Typography.Paragraph>}
              {rows.map((row, i) => {
                const conditions = rules[row.name]?.conditions ?? [];
                return (
                  <Card
                    key={row.key}
                    size="small"
                    style={{ marginBottom: 12 }}
                    data-testid="assignment-rule"
                    title={t('assignment.ruleN', { n: i + 1 })}
                    extra={
                      <Space>
                        <Typography.Text type="secondary">{t('assignment.cursor', { n: rules[row.name]?.cursor ?? 0 })}</Typography.Text>
                        <Button size="small" icon={<ArrowUpOutlined />} disabled={i === 0} aria-label={`${t('assignment.up')} ${i + 1}`} onClick={() => move(i, i - 1)} />
                        <Button size="small" icon={<ArrowDownOutlined />} disabled={i === rows.length - 1} aria-label={`${t('assignment.down')} ${i + 1}`} onClick={() => move(i, i + 1)} />
                        <Button size="small" danger icon={<DeleteOutlined />} aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => remove(row.name)} />
                      </Space>
                    }
                  >
                    {/* 已分配次数只用于显示；注册为隐藏字段，useWatch 才能读到 / display only; registered so useWatch returns it */}
                    <Form.Item name={[row.name, 'cursor']} hidden noStyle>
                      <input type="hidden" />
                    </Form.Item>
                    <Space align="start" wrap style={{ display: 'flex' }}>
                      <Form.Item name={[row.name, 'name']} label={t('assignment.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('assignment.name') }) }]}>
                        <Input maxLength={100} style={{ width: 220 }} aria-label={`${t('assignment.name')} ${i + 1}`} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'isActive']} label={t('assignment.active')} valuePropName="checked">
                        <Switch aria-label={`${t('assignment.active')} ${i + 1}`} />
                      </Form.Item>
                      <Form.Item name={[row.name, 'userIds']} label={t('assignment.users')} rules={[{ required: true, message: t('common.required', { field: t('assignment.users') }) }]}>
                        <Select mode="multiple" maxCount={20} style={{ width: 360 }} options={userOptions} optionFilterProp="label" aria-label={`${t('assignment.users')} ${i + 1}`} />
                      </Form.Item>
                    </Space>
                    <Typography.Text strong>{t('assignment.conditions')}</Typography.Text>
                    <Form.List name={[row.name, 'conditions']}>
                      {(conds, ops) => (
                        <div style={{ marginTop: 8 }}>
                          {!conds.length && <Typography.Paragraph type="secondary">{t('assignment.matchAll')}</Typography.Paragraph>}
                          {conds.map((cond, j) => {
                            const field = conditions[cond.name]?.field;
                            const label = `${i + 1}.${j + 1}`;
                            return (
                              <Space key={cond.key} align="start" wrap style={{ display: 'flex' }}>
                                <Form.Item name={[cond.name, 'field']} style={{ width: 140 }} rules={[{ required: true, message: t('common.required', { field: t('assignment.field') }) }]}>
                                  <Select
                                    aria-label={`${t('assignment.field')} ${label}`}
                                    options={FIELDS.map((f) => ({ value: f, label: t(`assignment.field.${f}`) }))}
                                    onChange={(f: Field) => {
                                      const next = [...(form.getFieldValue(['rules', row.name, 'conditions']) as Condition[])];
                                      next[cond.name] = { field: f, op: equalsOnly(f) ? 'EQUALS' : 'CONTAINS', value: '' };
                                      form.setFieldValue(['rules', row.name, 'conditions'], next);
                                    }}
                                  />
                                </Form.Item>
                                <Form.Item name={[cond.name, 'op']} style={{ width: 120 }}>
                                  <Select
                                    aria-label={`${t('assignment.op')} ${label}`}
                                    disabled={!canManage || equalsOnly(field)}
                                    options={(equalsOnly(field) ? (['EQUALS'] as const) : TEXT_OPS).map((o) => ({ value: o, label: t(`assignment.op.${o}`) }))}
                                  />
                                </Form.Item>
                                <Form.Item name={[cond.name, 'value']} style={{ width: 240 }} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('assignment.value') }) }]}>
                                  {field === 'source' ? (
                                    <Select aria-label={`${t('assignment.value')} ${label}`} options={SOURCES.map((s) => ({ value: s, label: tEnum('leadSource', s) }))} />
                                  ) : field === 'campaign' ? (
                                    <CampaignSelect aria-label={`${t('assignment.value')} ${label}`} />
                                  ) : field === 'webForm' ? (
                                    <Select aria-label={`${t('assignment.value')} ${label}`} options={webForms} />
                                  ) : (
                                    <Input maxLength={200} aria-label={`${t('assignment.value')} ${label}`} />
                                  )}
                                </Form.Item>
                                <Button icon={<DeleteOutlined />} aria-label={`${t('assignment.removeCondition')} ${label}`} onClick={() => ops.remove(cond.name)} />
                              </Space>
                            );
                          })}
                          {canManage && conds.length < 5 && (
                            <Button size="small" type="dashed" icon={<PlusOutlined />} data-testid="assignment-add-condition" onClick={() => ops.add({ field: 'source', op: 'EQUALS', value: '' })}>
                              {t('assignment.addCondition')}
                            </Button>
                          )}
                        </div>
                      )}
                    </Form.List>
                  </Card>
                );
              })}
              {canManage && rows.length < 50 && (
                <Button type="dashed" block icon={<PlusOutlined />} data-testid="assignment-add" onClick={() => add({ name: '', isActive: true, conditions: [], userIds: [] })}>
                  {t('assignment.add')}
                </Button>
              )}
            </div>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
