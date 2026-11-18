/**
 * 评分界面（线索、客户、联系人共用）：评分设置读取、评分标签（分数 + 分级颜色）、分级筛选与排序、得分明细、
 * 评分规则编辑弹窗。所有用户可查看规则；有 scoring.manage 时可编辑并保存（保存后服务端重算该对象的全部记录）。
 * Scoring UI shared by leads, accounts and contacts: loading the setup, the score tag (score + grade colour), grade filter
 * and sort, the breakdown and the rules editor. Everyone can view the rules; users with scoring.manage can edit and save
 * them (the server then rescores every record of that entity).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Form, InputNumber, Modal, Select, Space, Switch, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { t, tEnum, type MessageKey } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';

/** 评分对象 / scored entity */
export type ScoreEntity = 'lead' | 'account' | 'contact';

/** 规则类型 / rule kind */
export type RuleKind = 'FIELD_EQUALS' | 'FIELD_FILLED' | 'ACTIVITY_COUNT' | 'RELATED_COUNT';

/** 评分规则 / scoring rule */
export interface ScoringRule {
  id?: string;
  kind: RuleKind;
  field?: string | null;
  value?: string | null;
  points: number;
  maxCount?: number | null;
  isActive?: boolean;
}

/** 评分设置 / scoring setup */
export interface ScoringConfig {
  rules: ScoringRule[];
  hotScore: number;
  warmScore: number;
}

/** 分级 / grade */
export type Grade = 'hot' | 'warm' | 'cold';

const GRADE_COLOR: Record<Grade, string> = { hot: 'red', warm: 'orange', cold: 'blue' };
const SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'];
const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'];
const INDUSTRIES = ['MANUFACTURING', 'IT', 'FINANCE', 'RETAIL', 'EDUCATION', 'HEALTHCARE', 'CONSTRUCTION', 'LOGISTICS', 'GOVERNMENT', 'OTHER'];

/**
 * 各对象可用的规则：类型 → 字段；“字段等于”的取值另见 valueOptions。须与服务端校验及数据库约束一致。
 * Rules available per entity: kind → fields; FIELD_EQUALS values are in valueOptions. Must match the server and database.
 */
const SCHEMA: Record<ScoreEntity, Partial<Record<RuleKind, string[]>>> = {
  lead: {
    FIELD_EQUALS: ['source', 'status'],
    FIELD_FILLED: ['company', 'title', 'email', 'phone', 'mobile', 'description', 'campaign', 'web_form'],
    ACTIVITY_COUNT: [],
  },
  account: {
    FIELD_EQUALS: ['industry'],
    FIELD_FILLED: ['phone', 'website', 'address', 'description', 'price_book'],
    ACTIVITY_COUNT: [],
    RELATED_COUNT: ['contacts', 'won_deals', 'open_deals'],
  },
  contact: {
    FIELD_EQUALS: ['is_primary'],
    FIELD_FILLED: ['title', 'phone', 'email'],
    RELATED_COUNT: ['deal_roles', 'decision_roles'],
  },
};

/** “字段等于”的取值选项 / value options of a FIELD_EQUALS rule */
function valueOptions(field: string | null | undefined): { value: string; label: string }[] {
  if (field === 'status') return STATUSES.map((v) => ({ value: v, label: tEnum('leadStatus', v) }));
  if (field === 'industry') return INDUSTRIES.map((v) => ({ value: v, label: tEnum('industry', v) }));
  if (field === 'is_primary') return [{ value: 'true', label: t('common.yes') }];
  return SOURCES.map((v) => ({ value: v, label: tEnum('leadSource', v) }));
}

/** 字段名称 / field label */
function fieldLabel(field: string | null | undefined): string {
  return t(`scoring.field.${field}` as MessageKey);
}

/**
 * 按阈值分级。
 * Grade a score by the thresholds.
 */
export function gradeOf(score: number, c: { hotScore: number; warmScore: number }): Grade {
  return score >= c.hotScore ? 'hot' : score >= c.warmScore ? 'warm' : 'cold';
}

/**
 * 读取某对象的评分设置。
 * Load an entity's scoring setup.
 */
export function useScoring(entity: ScoreEntity): { config: ScoringConfig | null; reload: () => void } {
  const [config, setConfig] = useState<ScoringConfig | null>(null);
  const reload = useCallback(() => {
    api<ScoringConfig>(`/api/scoring/${entity}`)
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [entity]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { config, reload };
}

/**
 * 规则的说明文字，如“来源为网站”“已填写邮箱”“每条已完成跟进（最多 3 条）”“每个赢单商机（最多 5 个）”。
 * Describe a rule, e.g. "Source is Website", "Email filled", "Each completed activity (up to 3)", "Each won deal (up to 5)".
 */
export function ruleLabel(r: ScoringRule): string {
  if (r.kind === 'FIELD_EQUALS') {
    if (r.field === 'is_primary') return t('scoring.rule.isPrimary');
    const value = valueOptions(r.field).find((o) => o.value === r.value)?.label ?? r.value ?? '';
    return t('scoring.rule.equals', { field: fieldLabel(r.field), value });
  }
  if (r.kind === 'FIELD_FILLED') return t('scoring.rule.filled', { field: fieldLabel(r.field) });
  if (r.kind === 'RELATED_COUNT') return t(`scoring.rule.related.${r.field}` as MessageKey, { n: r.maxCount ?? 0 });
  return t('scoring.rule.activities', { n: r.maxCount ?? 0 });
}

/** 分值文字 / points text */
function pts(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * 评分标签：分数与分级。
 * Score tag: the score and its grade.
 */
export function ScoreTag({ score, config }: { score: number; config: ScoringConfig | null }) {
  if (!config) return <Tag>{score}</Tag>;
  const grade = gradeOf(score, config);
  return (
    <Tag color={GRADE_COLOR[grade]} data-testid="lead-score">
      {score} · {t(`scoring.grade.${grade}`)}
    </Tag>
  );
}

/**
 * 分级筛选与排序选择（列表页工具栏）。
 * Grade filter and sort selects for list toolbars.
 */
export function ScoreFilters({ grade, onGrade, sort, onSort }: { grade?: string; onGrade: (v: string | undefined) => void; sort?: string; onSort: (v: string | undefined) => void }) {
  return (
    <>
      <Select
        allowClear
        aria-label={t('scoring.gradeFilter')}
        placeholder={t('scoring.gradeFilter')}
        style={{ width: 120 }}
        value={grade}
        onChange={onGrade}
        options={(['hot', 'warm', 'cold'] as const).map((g) => ({ value: g, label: t(`scoring.grade.${g}`) }))}
      />
      <Select
        aria-label={t('scoring.sort')}
        style={{ width: 150 }}
        value={sort ?? 'newest'}
        onChange={(v: string) => onSort(v === 'newest' ? undefined : v)}
        options={[
          { value: 'newest', label: t('scoring.sortNewest') },
          { value: 'score', label: t('scoring.sortScore') },
        ]}
      />
    </>
  );
}

/**
 * 记录的得分明细（命中的规则与分值）。
 * A record's score breakdown (matched rules and points).
 */
export function ScoreDetail({ entity, id, version }: { entity: ScoreEntity; id: string; version: string }) {
  const [data, setData] = useState<{ score: number; items: (ScoringRule & { ruleId: string })[] } | null>(null);
  useEffect(() => {
    api<{ score: number; items: (ScoringRule & { ruleId: string })[] }>(`/api/${entity}s/${id}/score`)
      .then(setData)
      .catch(() => setData(null));
  }, [entity, id, version]);
  if (!data) return null;
  if (!data.items.length) return <Typography.Text type="secondary">{t('scoring.noMatch')}</Typography.Text>;
  return (
    <Space wrap size={4} data-testid="lead-score-items">
      {data.items.map((i) => (
        <Tag key={i.ruleId} color={i.points > 0 ? 'green' : 'volcano'}>
          {ruleLabel(i)} {pts(i.points)}
        </Tag>
      ))}
    </Space>
  );
}

interface RuleForm {
  kind: RuleKind;
  field?: string | null;
  value?: string | null;
  points?: number | null;
  maxCount?: number | null;
  isActive?: boolean;
}

/**
 * 评分规则弹窗：查看或编辑规则与分级阈值。
 * Scoring rules modal: view or edit the rules and grade thresholds.
 */
export function ScoringRulesModal({
  entity,
  open,
  onClose,
  config,
  canManage,
  onSaved,
}: {
  entity: ScoreEntity;
  open: boolean;
  onClose: () => void;
  config: ScoringConfig | null;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ hotScore: number; warmScore: number; rules: RuleForm[] }>();
  const [saving, setSaving] = useState(false);
  const rules = Form.useWatch('rules', form) ?? [];

  useEffect(() => {
    if (open && config) form.setFieldsValue({ hotScore: config.hotScore, warmScore: config.warmScore, rules: config.rules.map((r) => ({ ...r, isActive: r.isActive ?? true })) });
  }, [open, config, form]);

  const save = async () => {
    const v = await form.validateFields();
    const body = {
      hotScore: v.hotScore,
      warmScore: v.warmScore,
      // 按类型只提交对应字段 / send only the fields of each kind
      rules: (v.rules ?? []).map((r) => {
        const common = { kind: r.kind, points: r.points, isActive: r.isActive ?? true };
        if (r.kind === 'ACTIVITY_COUNT') return { ...common, maxCount: r.maxCount };
        if (r.kind === 'RELATED_COUNT') return { ...common, field: r.field, maxCount: r.maxCount };
        if (r.kind === 'FIELD_FILLED') return { ...common, field: r.field };
        return { ...common, field: r.field, value: r.value };
      }),
    };
    setSaving(true);
    try {
      const r = await api<{ rescored: number }>(`/api/scoring/${entity}`, { method: 'PUT', body });
      message.success(t('scoring.saved', { n: r.rescored }));
      onSaved();
      onClose();
    } catch (err) {
      message.error(err instanceof ClientApiError && err.details?.hotScore ? t('scoring.error.thresholds') : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const kinds = Object.keys(SCHEMA[entity]) as RuleKind[];
  const fieldOptions = (kind: RuleKind) => (SCHEMA[entity][kind] ?? []).map((f) => ({ value: f, label: fieldLabel(f) }));

  return (
    <Modal
      title={t('scoring.title')}
      open={open}
      onCancel={onClose}
      width={820}
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
      <Alert type="info" showIcon title={t(entity === 'lead' ? 'scoring.hint' : entity === 'account' ? 'scoring.hint.account' : 'scoring.hint.contact')} style={{ marginBottom: 16 }} />
      <Form form={form} name="scoring" layout="vertical" disabled={!canManage}>
        <Space wrap>
          <Form.Item name="hotScore" label={t('scoring.hotScore')} rules={[{ required: true, message: t('common.required', { field: t('scoring.hotScore') }) }]}>
            <InputNumber min={1} max={1000} precision={0} />
          </Form.Item>
          <Form.Item name="warmScore" label={t('scoring.warmScore')} rules={[{ required: true, message: t('common.required', { field: t('scoring.warmScore') }) }]}>
            <InputNumber min={0} max={999} precision={0} />
          </Form.Item>
        </Space>
        <Typography.Title level={5}>{t('scoring.rules')}</Typography.Title>
        <Form.List name="rules">
          {(rows, { add, remove }) => (
            <div data-testid="scoring-rules">
              {!rows.length && <Typography.Paragraph type="secondary">{t('scoring.noRules')}</Typography.Paragraph>}
              {rows.map((row, i) => {
                const kind = rules[row.name]?.kind ?? kinds[0]!;
                const field = rules[row.name]?.field;
                return (
                  <Space key={row.key} align="start" wrap style={{ display: 'flex' }}>
                    <Form.Item name={[row.name, 'kind']} style={{ width: 150 }}>
                      <Select
                        aria-label={`${t('scoring.kind')} ${i + 1}`}
                        options={kinds.map((k) => ({ value: k, label: t(`scoring.kind.${k}`) }))}
                        onChange={(k: RuleKind) => {
                          const next = [...(form.getFieldValue('rules') as RuleForm[])];
                          const counted = k === 'ACTIVITY_COUNT' || k === 'RELATED_COUNT';
                          next[row.name] = { kind: k, points: next[row.name]?.points ?? 10, isActive: next[row.name]?.isActive ?? true, ...(counted ? { maxCount: 3 } : {}) };
                          form.setFieldsValue({ rules: next });
                        }}
                      />
                    </Form.Item>
                    {kind !== 'ACTIVITY_COUNT' && (
                      <Form.Item name={[row.name, 'field']} rules={[{ required: true, message: t('common.required', { field: t('scoring.fieldLabel') }) }]} style={{ width: 130 }}>
                        <Select aria-label={`${t('scoring.fieldLabel')} ${i + 1}`} placeholder={t('scoring.fieldLabel')} options={fieldOptions(kind)} />
                      </Form.Item>
                    )}
                    {kind === 'FIELD_EQUALS' && (
                      <Form.Item name={[row.name, 'value']} rules={[{ required: true, message: t('common.required', { field: t('scoring.value') }) }]} style={{ width: 130 }}>
                        <Select
                          aria-label={`${t('scoring.value')} ${i + 1}`}
                          placeholder={t('scoring.value')}
                          options={valueOptions(field)}
                        />
                      </Form.Item>
                    )}
                    {(kind === 'ACTIVITY_COUNT' || kind === 'RELATED_COUNT') && (
                      <Form.Item name={[row.name, 'maxCount']} rules={[{ required: true, message: t('common.required', { field: t('scoring.maxCount') }) }]}>
                        <InputNumber min={1} max={50} precision={0} prefix={t('scoring.maxCountPrefix')} aria-label={`${t('scoring.maxCount')} ${i + 1}`} />
                      </Form.Item>
                    )}
                    <Form.Item
                      name={[row.name, 'points']}
                      rules={[
                        { required: true, message: t('common.required', { field: t('scoring.points') }) },
                        { validator: (_, v) => (v === 0 ? Promise.reject(new Error(t('scoring.error.zero'))) : Promise.resolve()) },
                      ]}
                    >
                      <InputNumber min={-100} max={100} precision={0} suffix={t('scoring.pointsSuffix')} aria-label={`${t('scoring.points')} ${i + 1}`} />
                    </Form.Item>
                    <Form.Item name={[row.name, 'isActive']} valuePropName="checked">
                      <Switch checkedChildren={t('scoring.on')} unCheckedChildren={t('scoring.off')} aria-label={`${t('scoring.active')} ${i + 1}`} />
                    </Form.Item>
                    {canManage && <Button type="text" danger icon={<DeleteOutlined />} aria-label={`${t('scoring.remove')} ${i + 1}`} onClick={() => remove(row.name)} />}
                  </Space>
                );
              })}
              {canManage && rows.length < 50 && (
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ kind: 'FIELD_FILLED', points: 10, isActive: true })} data-testid="scoring-add">
                  {t('scoring.add')}
                </Button>
              )}
            </div>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
