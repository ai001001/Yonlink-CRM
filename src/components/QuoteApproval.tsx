/**
 * 报价单审批：审批状态标签、原因说明、报价单详情中的审批面板（提交、撤回、批准、驳回、审批历史）。
 * Quote approval UI: status tag, reason text and the approval panel in the quote detail (submit, recall, approve,
 * reject, history).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Descriptions, Input, Modal, Space, Tag, Timeline, Typography } from 'antd';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import type { Quote } from '@/lib/types';
import { usePermissions } from './AuthProvider';

type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
const COLOR: Record<ApprovalStatus, string> = { PENDING: 'orange', APPROVED: 'green', REJECTED: 'red' };

/** 审批状态标签 / approval status tag */
export function ApprovalTag({ status }: { status: ApprovalStatus | null | undefined }) {
  if (!status) return null;
  return (
    <Tag color={COLOR[status]} data-testid="approval-status">
      {tEnum('approvalStatus', status)}
    </Tag>
  );
}

/**
 * 审批原因的显示，如“折扣 20% 超过上限 15%”“折合 ¥1,200,000.00 达到 ¥1,000,000”“缺少汇率”。
 * Display a reason such as "discount 20% above the 15% cap".
 */
export function reasonText(reason: string): string {
  const m = /^discount:([\d.]+)>([\d.]+)$/.exec(reason);
  if (m) return t('approvals.reason.discount', { actual: m[1]!, max: m[2]! });
  const n = /^total:([\d.]+)>=([\d.]+)$/.exec(reason);
  if (n) return t('approvals.reason.total', { amount: fmtMoney(n[1]!, 'CNY'), min: fmtMoney(n[2]!, 'CNY') });
  if (reason === 'total:no_rate') return t('approvals.reason.noRate');
  return reason;
}

/**
 * 审批相关错误提示（不需要审批、待审批、需要审批后发送、不能审批自己的等）。
 * Messages for approval errors.
 */
export function approvalError(err: unknown): string | null {
  const d = err instanceof ClientApiError ? err.details : undefined;
  const codes = d?.approvalStatus;
  if (!codes?.length) return null;
  if (codes[0] === 'required') return t('approvals.error.required', { reasons: codes.slice(1).map(reasonText).join(t('common.listSep')) });
  return t(`approvals.error.${codes[0]}` as Parameters<typeof t>[0]);
}

interface HistoryItem {
  id: string;
  action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'RECALL';
  comment: string | null;
  reasons: string[] | null;
  createdAt: string;
  actor: { id: string; name: string };
}

/**
 * 报价单详情中的审批面板。
 * The approval panel inside the quote detail.
 * @param editable 当前用户能编辑该报价单 / the user may edit the quote
 * @param onChanged 审批状态变化后刷新报价单 / reload the quote after a change
 */
export function QuoteApprovalPanel({ quote, editable, onChanged }: { quote: Quote; editable: boolean; onChanged: () => void }) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [dialog, setDialog] = useState<'SUBMIT' | 'APPROVE' | 'REJECT' | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ items: HistoryItem[] }>(`/api/quotes/${quote.id}/approval`)
      .then((r) => setHistory(r.items))
      .catch(() => setHistory([]));
  }, [quote.id]);
  // 报价单变化（状态、审批）后重新加载 / reload when the quote changes
  useEffect(load, [load, quote.updatedAt, quote.approvalStatus]);

  const status = quote.approvalStatus ?? null;
  const submitter = history.find((h) => h.action === 'SUBMIT')?.actor.id;
  const draft = quote.status === 'DRAFT';
  const canSubmit = editable && draft && status !== 'PENDING' && status !== 'APPROVED';
  const canDecide = status === 'PENDING' && perm.can('quote.approve') && submitter !== perm.meId;
  const canRecall = status === 'PENDING' && (submitter === perm.meId || perm.can('quote.approve'));

  const call = async (path: string, body: object, ok: string) => {
    setBusy(true);
    try {
      await api(`/api/quotes/${quote.id}/approval/${path}`, { method: 'POST', body });
      message.success(ok);
      setDialog(null);
      setComment('');
      onChanged();
    } catch (err) {
      message.error(approvalError(err) ?? (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (dialog === 'SUBMIT') void call('submit', { comment: comment.trim() || null }, t('approvals.submitted'));
    else if (dialog) void call('decide', { decision: dialog, comment: comment.trim() || null }, t(dialog === 'APPROVE' ? 'approvals.approved' : 'approvals.rejected'));
  };

  if (!status && !history.length && !canSubmit) return null;
  return (
    <div data-testid="quote-approval" style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>{t('approvals.title')}</Typography.Title>
      <Descriptions column={1} bordered size="small" style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('approvals.status')}>{status ? <ApprovalTag status={status} /> : t('approvals.notSubmitted')}</Descriptions.Item>
        {!!quote.approvalReasons?.length && <Descriptions.Item label={t('approvals.reasons')}>{quote.approvalReasons.map(reasonText).join(t('common.listSep'))}</Descriptions.Item>}
      </Descriptions>
      <Space wrap style={{ marginBottom: 12 }}>
        {canSubmit && (
          <Button onClick={() => setDialog('SUBMIT')} data-testid="approval-submit">
            {t('approvals.submit')}
          </Button>
        )}
        {canDecide && (
          <>
            <Button type="primary" onClick={() => setDialog('APPROVE')} data-testid="approval-approve">
              {t('approvals.approve')}
            </Button>
            <Button danger onClick={() => setDialog('REJECT')} data-testid="approval-reject">
              {t('approvals.reject')}
            </Button>
          </>
        )}
        {canRecall && (
          <Button onClick={() => void call('recall', {}, t('approvals.recalled'))} loading={busy} data-testid="approval-recall">
            {t('approvals.recall')}
          </Button>
        )}
      </Space>
      {!!history.length && (
        <Timeline
          data-testid="approval-history"
          items={history.map((h) => ({
            key: h.id,
            color: h.action === 'APPROVE' ? 'green' : h.action === 'REJECT' ? 'red' : h.action === 'SUBMIT' ? 'blue' : 'gray',
            content: (
              <div>
                <Typography.Text strong>{t(`approvals.action.${h.action}`)}</Typography.Text> · {h.actor.name} · {fmtDateTime(h.createdAt)}
                {h.comment && <div style={{ whiteSpace: 'pre-wrap' }}>{h.comment}</div>}
                {!!h.reasons?.length && <Typography.Text type="secondary">{h.reasons.map(reasonText).join(t('common.listSep'))}</Typography.Text>}
              </div>
            ),
          }))}
        />
      )}
      <Modal
        title={dialog ? t(dialog === 'SUBMIT' ? 'approvals.submit' : dialog === 'APPROVE' ? 'approvals.approve' : 'approvals.reject') : ''}
        open={dialog !== null}
        onCancel={() => setDialog(null)}
        onOk={confirm}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: dialog === 'REJECT' && !comment.trim(), loading: busy }}
        zIndex={1200}
      >
        <Input.TextArea
          rows={3}
          maxLength={500}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t(dialog === 'REJECT' ? 'approvals.commentRequired' : 'approvals.commentOptional')}
          aria-label={t('approvals.comment')}
        />
      </Modal>
    </div>
  );
}
