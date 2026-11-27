/**
 * 商机整页详情（/deals/view?id=）：摘要（阶段、金额、评分、负责人、标签）、字段直接编辑、时间线、产品明细、报价单、
 * 联系人角色、竞争对手、阶段历史、跟进、备注、附件。有产品明细时金额由明细计算；启用流程蓝图时阶段只能通过转换修改。
 * Deal full page (/deals/view?id=): summary (stage, amount, score, owner, tags), in-place field editing, timeline, line
 * items, quotes, contact roles, competitors, stage history, activities, notes and attachments. With line items the
 * amount is computed; with a blueprint the stage changes through transitions only.
 */
'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Tag } from 'antd';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { AuditTrail } from '@/components/AuditTrail';
import { usePermissions } from '@/components/AuthProvider';
import { BlueprintPanel, useBlueprintStatus } from '@/components/Blueprint';
import { DealCompetitorsPanel } from '@/components/DealCompetitorsPanel';
import { DealContactRolesPanel } from '@/components/DealContactRolesPanel';
import { DealItemsPanel } from '@/components/DealItemsPanel';
import { DealQuotesPanel } from '@/components/DealQuotesPanel';
import { DealStageHistoryPanel } from '@/components/DealStageHistoryPanel';
import { NotesPanel } from '@/components/NotesPanel';
import { RecordPage, type FieldConfig } from '@/components/RecordPage';
import { RelatedActivities } from '@/components/RelatedActivities';
import { ScoreTag, useScoring } from '@/components/Scoring';
import { TagEditor } from '@/components/Tags';
import { t, tEnum } from '@/i18n';
import { fmtDate, fmtMoney } from '@/lib/format';
import { pickOptions } from '@/lib/picklists';
import type { Deal } from '@/lib/types';

const STAGES = ['QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'] as const;
const CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY'];

function DealView({ id }: { id: string }) {
  const perm = usePermissions();
  const scoring = useScoring('deal');
  const blueprint = useBlueprintStatus('DEAL');
  const hasItems = (r: Deal) => (r._count?.lineItems ?? 0) > 0;
  const fields: FieldConfig<Deal>[] = [
    { key: 'name', label: 'deals.name', editor: 'text', required: true, render: (r) => r.name, value: (r) => r.name },
    { key: 'accountId', label: 'deals.account', editor: 'none', render: (r) => <Link href={`/accounts/view?id=${r.account.id}`}>{r.account.name}</Link> },
    // 有产品明细时金额与币种由明细决定 / with line items the amount and currency follow the items
    { key: 'amount', label: 'deals.amount', editor: 'amount', required: true, render: (r) => fmtMoney(r.amount, r.currency), value: (r) => r.amount, editable: (r) => !hasItems(r) },
    { key: 'currency', label: 'deals.currency', editor: 'select', required: true, render: (r) => r.currency, value: (r) => r.currency, options: () => CURRENCIES.map((c) => ({ value: c, label: c })), editable: (r) => !hasItems(r) },
    { key: 'stage', label: 'deals.stage', editor: 'select', required: true, render: (r) => tEnum('dealStage', r.stage), value: (r) => r.stage, options: (r) => pickOptions('dealStage', STAGES, 'active', r.stage), editable: () => !blueprint },
    { key: 'expectedCloseDate', label: 'deals.expectedCloseDate', editor: 'date', render: (r) => (r.expectedCloseDate ? fmtDate(r.expectedCloseDate) : null), value: (r) => r.expectedCloseDate?.slice(0, 10) ?? null },
    { key: 'ownerId', label: 'common.owner', editor: 'owner', render: (r) => r.owner?.name ?? t('common.unassigned'), value: (r) => r.ownerId, editable: () => perm.canAssign },
    { key: 'description', label: 'common.description', editor: 'textarea', render: (r) => r.description, value: (r) => r.description },
  ];
  return (
    <RecordPage<Deal>
      id={id}
      path="/api/deals"
      listPath="/deals"
      customEntity="DEAL"
      title="deals.detail"
      fields={fields}
      summary={(r, reload) => (
        <>
          <Tag color="blue">{tEnum('dealStage', r.stage)}</Tag>
          <Tag color="gold">{fmtMoney(r.amount, r.currency)}</Tag>
          <ScoreTag score={r.score} config={scoring.config} />
          <Tag>{r.owner?.name ?? t('common.unassigned')}</Tag>
          <TagEditor path="/api/deals" record={r} onChanged={reload} />
        </>
      )}
      tabs={(r, reload, version) => [
        ...(blueprint ? [{ key: 'blueprint', label: t('nav.blueprints'), children: <BlueprintPanel entity="DEAL" record={r as unknown as { id: string } & Record<string, unknown>} onDone={reload} /> }] : []),
        { key: 'items', label: t('items.tab'), children: <DealItemsPanel key={`items-${version}`} deal={r} onChanged={reload} /> },
        { key: 'quotes', label: t('quotes.tab'), children: <DealQuotesPanel key={`quotes-${version}`} deal={r} /> },
        { key: 'contact-roles', label: t('contactRoles.tab'), children: <DealContactRolesPanel key={`roles-${version}`} deal={r} /> },
        { key: 'competitors', label: t('competitors.tab'), children: <DealCompetitorsPanel key={`competitors-${version}`} deal={r} /> },
        { key: 'stage-history', label: t('stageHistory.tab'), children: <DealStageHistoryPanel dealId={r.id} version={version} /> },
        { key: 'activities', label: t('deals.tabActivities'), children: <RelatedActivities relation={{ dealId: r.id }} /> },
        { key: 'notes', label: t('notes.title'), children: <NotesPanel key={`notes-${version}`} parent={{ dealId: r.id }} ownerId={r.ownerId} /> },
        { key: 'attachments', label: t('attachments.title'), children: <AttachmentsPanel parent={{ dealId: r.id }} ownerId={r.ownerId} /> },
        ...(perm.can('audit.read') ? [{ key: 'audit', label: t('audit.trail'), children: <AuditTrail entityType="deal" entityId={r.id} version={version} /> }] : []),
      ]}
    />
  );
}

function Inner() {
  const id = useSearchParams().get('id');
  return id ? <DealView key={id} id={id} /> : null;
}

export default function DealViewPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
