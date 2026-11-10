/**
 * 单条记录的操作记录（详情抽屉中使用）。
 * Activity log of a single record (used inside detail drawers).
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Empty, Timeline, Typography } from 'antd';
import { t } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOwners } from '@/lib/hooks';
import { actionLabel, AuditChanges, type AuditLogEntry } from './AuditChanges';

interface Props {
  entityType: 'lead' | 'account' | 'deal';
  entityId: string;
  /** 变化时重新加载（如保存后）/ reload when this changes (e.g. after saving) */
  version?: string;
}

export function AuditTrail({ entityType, entityId, version }: Props) {
  const owners = useOwners();
  const users = useMemo(() => new Map(owners.map((u) => [u.id, u.name])), [owners]);
  const [items, setItems] = useState<AuditLogEntry[] | null>(null);

  useEffect(() => {
    api<{ items: AuditLogEntry[] }>(`/api/audit-logs${qs({ entityType, entityId, pageSize: 50 })}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [entityType, entityId, version]);

  if (items === null) return null;
  if (!items.length) return <Empty description={t('common.empty')} />;
  return (
    <Timeline
      data-testid="audit-trail"
      items={items.map((e) => ({
        key: e.id,
        content: (
          <>
            <Typography.Text strong>{actionLabel(e.action)}</Typography.Text>{' '}
            <Typography.Text type="secondary">
              {fmtDateTime(e.createdAt)} · {e.actor?.name ?? t('audit.system')}
            </Typography.Text>
            <div>
              <AuditChanges entry={e} users={users} />
            </div>
          </>
        ),
      }))}
    />
  );
}
