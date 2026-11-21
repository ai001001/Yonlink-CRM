/**
 * 审批页：待我审批（有 quote.approve 时）与我提交的报价单审批；报价单审批规则（有 approval.manage 时可修改）。
 * Approvals page: pending approvals (with quote.approve) and my submissions; the quote approval policy (editable with
 * approval.manage).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Form, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Table, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { usePermissions } from '@/components/AuthProvider';
import { approvalError, ApprovalTag, levelText, reasonText, type Step } from '@/components/QuoteApproval';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { usePagedList } from '@/lib/hooks';

interface Row {
  id: string;
  quoteNumber: string;
  subject: string;
  currency: string;
  total: string;
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  approvalReasons: string[] | null;
  deal: { id: string; name: string; account: { id: string; name: string } };
  submittedBy: { id: string; name: string } | null;
  submittedAt: string | null;
  canDecide: boolean;
  approvalStep: number | null;
  approvalSteps: Step[] | null;
}

/** 审批级别 / approval level */
interface Level {
  name: string;
  approverRole: 'ADMIN' | 'MANAGER';
  minDiscountPercent: string | null;
  minTotal: string | null;
}

interface Settings {
  enabled: boolean;
  maxDiscountPercent: string | null;
  minTotal: string | null;
  levels: Level[];
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}

/**
 * 审批规则卡片。
 * The approval policy card.
 */
function SettingsCard({ canManage }: { canManage: boolean }) {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form] = Form.useForm<{ enabled: boolean; maxDiscountPercent: string | null; minTotal: string | null; levels: Level[] }>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<Settings>('/api/approvals/settings')
      .then((s) => {
        setSettings(s);
        form.setFieldsValue({ enabled: s.enabled, maxDiscountPercent: s.maxDiscountPercent, minTotal: s.minTotal, levels: s.levels });
      })
      .catch(() => setSettings(null));
  }, [form]);
  useEffect(load, [load]);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api('/api/approvals/settings', { method: 'PUT', body: {
          enabled: v.enabled,
          maxDiscountPercent: v.maxDiscountPercent ?? null,
          minTotal: v.minTotal ?? null,
          levels: (v.levels ?? []).map((l) => ({ name: l.name, approverRole: l.approverRole, minDiscountPercent: l.minDiscountPercent ?? null, minTotal: l.minTotal ?? null })),
        },
      });
      message.success(t('common.saved'));
      load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="small" title={t('approvals.settings')} style={{ marginBottom: 16 }} data-testid="approval-settings">
      <Typography.Paragraph type="secondary">{t('approvals.settingsHint')}</Typography.Paragraph>
      <Form form={form} name="approval-settings" layout="vertical" disabled={!canManage}>
        <Space wrap align="start">
          <Form.Item name="enabled" label={t('approvals.enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="maxDiscountPercent" label={t('approvals.maxDiscount')}>
            <InputNumber<string> stringMode min="0" max="100" precision={2} suffix="%" style={{ width: 140 }} placeholder={t('approvals.notUsed')} />
          </Form.Item>
          <Form.Item name="minTotal" label={t('approvals.minTotal')}>
            <InputNumber<string> stringMode min="0" precision={2} prefix="¥" style={{ width: 200 }} placeholder={t('approvals.notUsed')} />
          </Form.Item>
        </Space>
        <Typography.Text strong>{t('approvals.levels')}</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {t('approvals.levelsHint')}
        </Typography.Paragraph>
        <Form.List name="levels">
          {(rows, { add, remove }) => (
            <div data-testid="approval-levels">
              {rows.map((row, i) => (
                <Space key={row.key} wrap align="start" style={{ display: 'flex' }}>
                  <Typography.Text style={{ lineHeight: '32px' }}>{t('approvals.levelN', { n: i + 1 })}</Typography.Text>
                  <Form.Item name={[row.name, 'name']} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('approvals.levelName') }) }]}>
                    <Input maxLength={50} style={{ width: 140 }} placeholder={t('approvals.levelName')} aria-label={`${t('approvals.levelName')} ${i + 1}`} />
                  </Form.Item>
                  <Form.Item name={[row.name, 'approverRole']}>
                    <Select
                      style={{ width: 130 }}
                      aria-label={`${t('approvals.approverRole')} ${i + 1}`}
                      options={(['MANAGER', 'ADMIN'] as const).map((r) => ({ value: r, label: t(`approvals.role.${r}`) }))}
                    />
                  </Form.Item>
                  <Form.Item name={[row.name, 'minDiscountPercent']}>
                    <InputNumber<string> stringMode min="0" max="100" precision={2} prefix={t('approvals.discountAbove')} suffix="%" style={{ width: 190 }} placeholder={t('approvals.notUsed')} aria-label={`${t('approvals.discountAbove')} ${i + 1}`} />
                  </Form.Item>
                  <Form.Item name={[row.name, 'minTotal']}>
                    <InputNumber<string> stringMode min="0" precision={2} prefix={t('approvals.totalAtLeast')} style={{ width: 230 }} placeholder={t('approvals.notUsed')} aria-label={`${t('approvals.totalAtLeast')} ${i + 1}`} />
                  </Form.Item>
                  {canManage && <Button icon={<DeleteOutlined />} aria-label={`${t('approvals.removeLevel')} ${i + 1}`} onClick={() => remove(row.name)} />}
                </Space>
              ))}
              {!rows.length && <Typography.Paragraph type="secondary">{t('approvals.noLevels')}</Typography.Paragraph>}
              {canManage && rows.length < 5 && (
                <Button size="small" type="dashed" icon={<PlusOutlined />} data-testid="approval-add-level" onClick={() => add({ name: '', approverRole: 'MANAGER', minDiscountPercent: null, minTotal: null })}>
                  {t('approvals.addLevel')}
                </Button>
              )}
            </div>
          )}
        </Form.List>
        {canManage && (
          <Button type="primary" loading={saving} onClick={save} style={{ marginTop: 12 }}>
            {t('common.save')}
          </Button>
        )}
      </Form>
      {settings?.updatedAt && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {t('approvals.updated', { name: settings.updatedBy?.name ?? '—', time: fmtDateTime(settings.updatedAt) })}
        </Typography.Text>
      )}
    </Card>
  );
}

export default function ApprovalsPage() {
  const { message } = App.useApp();
  const perm = usePermissions();
  const canApprove = perm.can('quote.approve');
  const [scope, setScope] = useState<'pending' | 'mine'>(canApprove ? 'pending' : 'mine');
  const { data, loading, reload, pagination } = usePagedList<Row>('/api/approvals', { scope });
  const [deciding, setDeciding] = useState<{ row: Row; decision: 'APPROVE' | 'REJECT' } | null>(null);
  const [comment, setComment] = useState('');

  const decide = async () => {
    if (!deciding) return;
    try {
      await api(`/api/quotes/${deciding.row.id}/approval/decide`, { method: 'POST', body: { decision: deciding.decision, comment: comment.trim() || null } });
      message.success(t(deciding.decision === 'APPROVE' ? 'approvals.approved' : 'approvals.rejected'));
      setDeciding(null);
      setComment('');
      void reload();
    } catch (err) {
      message.error(approvalError(err) ?? (err as Error).message);
    }
  };

  return (
    <Card title={t('approvals.page')}>
      <SettingsCard canManage={perm.can('approval.manage')} />
      <Segmented
        style={{ marginBottom: 16 }}
        value={scope}
        onChange={(v) => setScope(v as 'pending' | 'mine')}
        options={[...(canApprove ? [{ value: 'pending', label: t('approvals.pending') }] : []), { value: 'mine', label: t('approvals.mine') }]}
      />
      <Table<Row>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t(scope === 'pending' ? 'approvals.emptyPending' : 'approvals.emptyMine') }}
        pagination={{ ...pagination, showTotal: (total) => t('common.total', { total }) }}
        columns={[
          { title: t('quotes.number'), render: (_, r) => <Link href={`/quotes?id=${r.id}`}>{r.quoteNumber}</Link> },
          { title: t('quotes.subject'), dataIndex: 'subject' },
          { title: t('quotes.account'), render: (_, r) => r.deal.account.name },
          { title: t('quotes.total'), align: 'right', render: (_, r) => fmtMoney(r.total, r.currency) },
          { title: t('approvals.reasons'), render: (_, r) => (r.approvalReasons ?? []).map((x) => <div key={x}>{reasonText(x)}</div>) },
          { title: t('approvals.submittedBy'), render: (_, r) => r.submittedBy?.name ?? '—' },
          { title: t('approvals.submittedAt'), render: (_, r) => fmtDateTime(r.submittedAt) },
          { title: t('approvals.status'), render: (_, r) => <ApprovalTag status={r.approvalStatus} /> },
          { title: t('approvals.currentLevel'), render: (_, r) => (r.approvalStatus === 'PENDING' ? levelText(r.approvalSteps, r.approvalStep) : '—') },
          {
            title: t('common.actions'),
            render: (_, r) =>
              r.canDecide ? (
                <Space>
                  <Button size="small" type="primary" onClick={() => setDeciding({ row: r, decision: 'APPROVE' })}>
                    {t('approvals.approve')}
                  </Button>
                  <Button size="small" danger onClick={() => setDeciding({ row: r, decision: 'REJECT' })}>
                    {t('approvals.reject')}
                  </Button>
                </Space>
              ) : r.approvalStatus === 'PENDING' && scope === 'pending' ? (
                <Typography.Text type="secondary">{r.submittedBy?.id === perm.meId ? t('approvals.ownSubmission') : t('approvals.waitingOthers')}</Typography.Text>
              ) : null,
          },
        ]}
      />
      <Modal
        title={deciding ? `${t(deciding.decision === 'APPROVE' ? 'approvals.approve' : 'approvals.reject')} · ${deciding.row.quoteNumber}` : ''}
        open={deciding !== null}
        onCancel={() => setDeciding(null)}
        onOk={decide}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: deciding?.decision === 'REJECT' && !comment.trim() }}
      >
        <Input.TextArea
          rows={3}
          maxLength={500}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t(deciding?.decision === 'REJECT' ? 'approvals.commentRequired' : 'approvals.commentOptional')}
          aria-label={t('approvals.comment')}
        />
      </Modal>
    </Card>
  );
}
