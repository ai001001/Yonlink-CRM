/**
 * 详情页中的跟进记录时间线（客户/线索/商机）：新增、编辑、完成、删除。
 * Activity timeline inside account / lead / deal details: create, edit, complete, delete.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Checkbox, Empty, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Activity, ActivityRelation } from '@/lib/types';
import { ActivityFormModal } from './ActivityFormModal';

export const ACTIVITY_TYPE_COLOR: Record<string, string> = { CALL: 'blue', MEETING: 'purple', VISIT: 'orange', TASK: 'cyan' };

/**
 * 切换完成状态。
 * Toggle the completed flag.
 */
export async function toggleActivity(a: Activity): Promise<Activity> {
  return api<Activity>(`/api/activities/${a.id}`, { method: 'PATCH', body: { completed: !a.completed } });
}

export function RelatedActivities({ relation }: { relation: ActivityRelation }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<{ editing: Activity | null } | null>(null);
  const key = JSON.stringify(relation);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ items: Activity[] }>(`/api/activities${qs({ ...JSON.parse(key), pageSize: 100 })}`);
      setItems(res.items);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [key, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) message.success(ok);
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div data-testid="related-activities">
      <Button icon={<PlusOutlined />} onClick={() => setModal({ editing: null })} style={{ marginBottom: 12 }}>
        {t('activities.new')}
      </Button>
      <List
        loading={loading}
        dataSource={items}
        locale={{ emptyText: <Empty description={t('common.empty')} /> }}
        renderItem={(a) => (
          <List.Item
            actions={[
              <Button key="edit" type="link" size="small" onClick={() => setModal({ editing: a })}>
                {t('common.edit')}
              </Button>,
              <Popconfirm
                key="del"
                title={t('common.confirmDelete')}
                onConfirm={() => run(() => api(`/api/activities/${a.id}`, { method: 'DELETE' }), t('common.deleted'))}
              >
                <Button type="link" size="small" danger>
                  {t('common.delete')}
                </Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              avatar={<Checkbox checked={a.completed} aria-label={t('activities.markDone')} onChange={() => run(() => toggleActivity(a))} />}
              title={
                <Space>
                  <Tag color={ACTIVITY_TYPE_COLOR[a.type]}>{tEnum('activityType', a.type)}</Tag>
                  <span style={a.completed ? { textDecoration: 'line-through', color: '#8c8c8c' } : undefined}>{a.subject}</span>
                  {a.completed ? <Tag color="green">{t('activities.completed')}</Tag> : <Tag>{t('activities.pending')}</Tag>}
                </Space>
              }
              description={
                <>
                  {a.content && <Typography.Paragraph style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>{a.content}</Typography.Paragraph>}
                  <Typography.Text type="secondary">
                    {fmtDateTime(a.createdAt)} · {a.owner?.name ?? t('common.unassigned')}
                    {a.dueAt ? ` · ${t('activities.dueAt')} ${fmtDateTime(a.dueAt)}` : ''}
                  </Typography.Text>
                </>
              }
            />
          </List.Item>
        )}
      />
      <ActivityFormModal
        open={modal !== null}
        editing={modal?.editing}
        relation={modal?.editing ? undefined : relation}
        onClose={() => setModal(null)}
        onSaved={() => {
          setModal(null);
          void load();
        }}
      />
    </div>
  );
}
