/**
 * 客户整页详情（/accounts/view?id=）：摘要（行业、评分、负责人、区域、标签）、字段直接编辑、时间线、联系人、商机、跟进、
 * 备注、附件、自定义模块记录。
 * Account full page (/accounts/view?id=): summary (industry, score, owner, territory, tags), in-place field editing,
 * timeline, contacts, deals, activities, notes, attachments and custom module records.
 */
'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Tag } from 'antd';
import { AccountDeals } from '@/components/AccountDeals';
import { AccountModuleRecords } from '@/components/AccountModuleRecords';
import { AttachmentsPanel } from '@/components/AttachmentsPanel';
import { AuditTrail } from '@/components/AuditTrail';
import { usePermissions } from '@/components/AuthProvider';
import { ContactsPanel } from '@/components/ContactsPanel';
import { NotesPanel } from '@/components/NotesPanel';
import { PhoneLink } from '@/components/PhoneLink';
import { RecordPage, type FieldConfig } from '@/components/RecordPage';
import { RelatedActivities } from '@/components/RelatedActivities';
import { ScoreTag, useScoring } from '@/components/Scoring';
import { TagEditor } from '@/components/Tags';
import { t, tEnum } from '@/i18n';
import { pickOptions } from '@/lib/picklists';
import type { Account } from '@/lib/types';

const INDUSTRIES = ['MANUFACTURING', 'IT', 'FINANCE', 'RETAIL', 'EDUCATION', 'HEALTHCARE', 'CONSTRUCTION', 'LOGISTICS', 'GOVERNMENT', 'OTHER'] as const;

function AccountView({ id }: { id: string }) {
  const perm = usePermissions();
  const scoring = useScoring('account');
  const fields: FieldConfig<Account>[] = [
    { key: 'name', label: 'accounts.name', editor: 'text', required: true, render: (r) => r.name, value: (r) => r.name },
    { key: 'industry', label: 'accounts.industry', editor: 'select', render: (r) => tEnum('industry', r.industry) || null, value: (r) => r.industry, options: (r) => pickOptions('industry', INDUSTRIES, 'active', r.industry) },
    { key: 'phone', label: 'accounts.phone', editor: 'text', render: (r) => <PhoneLink value={r.phone} />, value: (r) => r.phone },
    { key: 'website', label: 'accounts.website', editor: 'text', render: (r) => r.website, value: (r) => r.website },
    { key: 'address', label: 'accounts.address', editor: 'textarea', render: (r) => r.address, value: (r) => r.address },
    { key: 'ownerId', label: 'common.owner', editor: 'owner', render: (r) => r.owner?.name ?? t('common.unassigned'), value: (r) => r.ownerId, editable: () => perm.canAssign },
    { key: 'territoryId', label: 'territories.territory', editor: 'none', render: (r) => r.territory?.name ?? null },
    { key: 'description', label: 'common.description', editor: 'textarea', render: (r) => r.description, value: (r) => r.description },
  ];
  return (
    <RecordPage<Account>
      id={id}
      path="/api/accounts"
      listPath="/accounts"
      customEntity="ACCOUNT"
      title="accounts.detail"
      fields={fields}
      summary={(r, reload) => (
        <>
          {r.industry && <Tag color="blue">{tEnum('industry', r.industry)}</Tag>}
          <ScoreTag score={r.score} config={scoring.config} />
          <Tag>{r.owner?.name ?? t('common.unassigned')}</Tag>
          {r.territory && <Tag color="geekblue">{r.territory.name}</Tag>}
          <TagEditor path="/api/accounts" record={r} onChanged={reload} />
        </>
      )}
      tabs={(r, reload, version) => [
        {
          key: 'contacts',
          label: `${t('accounts.tabContacts')} (${r.contacts?.length ?? 0})`,
          children: <ContactsPanel editable={perm.canEdit(r)} accountId={r.id} contacts={r.contacts ?? []} onChanged={reload} />,
        },
        { key: 'deals', label: `${t('accounts.tabDeals')} (${r._count.deals})`, children: <AccountDeals key={`deals-${version}`} accountId={r.id} /> },
        { key: 'activities', label: t('accounts.tabActivities'), children: <RelatedActivities relation={{ accountId: r.id }} /> },
        { key: 'notes', label: t('notes.title'), children: <NotesPanel key={`notes-${version}`} parent={{ accountId: r.id }} ownerId={r.ownerId} /> },
        { key: 'attachments', label: t('attachments.title'), children: <AttachmentsPanel parent={{ accountId: r.id }} ownerId={r.ownerId} /> },
        { key: 'modules', label: t('nav.group.modules'), children: <AccountModuleRecords accountId={r.id} /> },
        ...(perm.can('audit.read') ? [{ key: 'audit', label: t('audit.trail'), children: <AuditTrail entityType="account" entityId={r.id} version={version} /> }] : []),
      ]}
    />
  );
}

function Inner() {
  const id = useSearchParams().get('id');
  return id ? <AccountView key={id} id={id} /> : null;
}

export default function AccountViewPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
