/**
 * 线索整页详情（/leads/view?id=）：摘要（状态、评分、负责人、标签）、字段直接编辑、时间线、跟进、备注、附件。
 * 已转化的线索只读；启用流程蓝图时状态只能通过蓝图转换修改。
 * Lead full page (/leads/view?id=): summary (status, score, owner, tags), in-place field editing, timeline, activities,
 * notes and attachments. Converted leads are read-only; with a blueprint the status changes through transitions only.
 */
'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Tag } from 'antd';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { AuditTrail } from '@/components/AuditTrail';
import { usePermissions } from '@/components/AuthProvider';
import { BlueprintPanel, useBlueprintStatus } from '@/components/Blueprint';
import { NotesPanel } from '@/components/NotesPanel';
import { EmailLink, PhoneLink } from '@/components/PhoneLink';
import { RecordPage, type FieldConfig } from '@/components/RecordPage';
import { RelatedActivities } from '@/components/RelatedActivities';
import { ScoreTag, useScoring } from '@/components/Scoring';
import { TagEditor } from '@/components/Tags';
import { t, tEnum } from '@/i18n';
import { pickOptions } from '@/lib/picklists';
import type { RecordTags } from '@/lib/types';

const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED'] as const;
const SOURCES = ['WEBSITE', 'REFERRAL', 'EXHIBITION', 'COLD_CALL', 'ADVERTISEMENT', 'SOCIAL_MEDIA', 'OTHER'] as const;

/** 线索 / lead */
interface Lead {
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  source: string | null;
  status: string;
  description: string | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  convertedAt: string | null;
  score: number;
  tags?: RecordTags;
  custom?: Record<string, unknown> | null;
  updatedAt: string;
}

const text = (key: keyof Lead, label: Parameters<typeof t>[0], required = false): FieldConfig<Lead> => ({ key, label, editor: 'text', required, render: (r) => (r[key] as string | null) ?? null, value: (r) => (r[key] as string | null) ?? null });

function LeadView({ id }: { id: string }) {
  const perm = usePermissions();
  const scoring = useScoring('lead');
  const blueprint = useBlueprintStatus('LEAD');
  const fields: FieldConfig<Lead>[] = [
    text('name', 'leads.name', true),
    text('company', 'leads.company'),
    text('title', 'leads.jobTitle'),
    { key: 'phone', label: 'leads.phone', editor: 'text', render: (r) => <PhoneLink value={r.phone} />, value: (r) => r.phone },
    { key: 'mobile', label: 'leads.mobile', editor: 'text', render: (r) => <PhoneLink value={r.mobile} />, value: (r) => r.mobile },
    { key: 'email', label: 'leads.email', editor: 'text', render: (r) => <EmailLink value={r.email} />, value: (r) => r.email },
    { key: 'source', label: 'leads.source', editor: 'select', render: (r) => tEnum('leadSource', r.source) || null, value: (r) => r.source, options: (r) => pickOptions('leadSource', SOURCES, 'active', r.source) },
    {
      key: 'status',
      label: 'leads.status',
      editor: 'select',
      required: true,
      render: (r) => tEnum('leadStatus', r.status),
      value: (r) => r.status,
      options: (r) => pickOptions('leadStatus', STATUSES.filter((s) => s !== 'CONVERTED'), 'active', r.status),
      editable: () => !blueprint,
    },
    { key: 'ownerId', label: 'common.owner', editor: 'owner', render: (r) => r.owner?.name ?? t('common.unassigned'), value: (r) => r.ownerId, editable: () => perm.canAssign },
    { key: 'description', label: 'common.description', editor: 'textarea', wide: true, render: (r) => r.description, value: (r) => r.description },
  ];
  return (
    <RecordPage<Lead>
      id={id}
      path="/api/leads"
      listPath="/leads"
      customEntity="LEAD"
      title="leads.detail"
      fields={fields}
      extraEditable={(r) => r.convertedAt === null}
      summary={(r, reload) => (
        <>
          <Tag color="blue">{tEnum('leadStatus', r.status)}</Tag>
          <ScoreTag score={r.score} config={scoring.config} />
          <Tag>{r.owner?.name ?? t('common.unassigned')}</Tag>
          <TagEditor path="/api/leads" record={r} onChanged={reload} />
        </>
      )}
      tabs={(r, reload, version) => [
        ...(blueprint && r.convertedAt === null ? [{ key: 'blueprint', label: t('nav.blueprints'), children: <BlueprintPanel entity="LEAD" record={r as unknown as { id: string } & Record<string, unknown>} onDone={reload} /> }] : []),
        { key: 'activities', label: t('accounts.tabActivities'), children: <RelatedActivities relation={{ leadId: r.id }} /> },
        { key: 'notes', label: t('notes.title'), children: <NotesPanel key={`notes-${version}`} parent={{ leadId: r.id }} ownerId={r.ownerId} /> },
        { key: 'attachments', label: t('attachments.title'), children: <AttachmentsPanel parent={{ leadId: r.id }} ownerId={r.ownerId} /> },
        ...(perm.can('audit.read') ? [{ key: 'audit', label: t('audit.trail'), children: <AuditTrail entityType="lead" entityId={r.id} version={version} /> }] : []),
      ]}
    />
  );
}

function Inner() {
  const id = useSearchParams().get('id');
  return id ? <LeadView key={id} id={id} /> : null;
}

export default function LeadViewPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
