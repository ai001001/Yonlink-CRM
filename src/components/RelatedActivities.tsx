/**
 * 详情页中的跟进记录列表（客户/线索/商机）。
 * Activity timeline shown inside account / lead / deal details.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, List, Space, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { api, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Activity, ActivityRelation } from '@/lib/types';
import { ActivityFormModal } from './ActivityFormModal';

const TYPE_COLOR: Record<string, string> = { CALL: 'blue', MEETING: 'purple', VISIT: 'orange', TASK: 'cyan' };

export function RelatedActivities({ relation }: { relation: ActivityRelation }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
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

  return (
    <div data-testid="related-activities">
      <Space style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          {t('activities.new')}
        </Button>
      </Space>
      <List
        loading={loading}
        dataSource={items}
        locale={{ emptyText: <Empty description={t('common.empty')} /> }}
        renderItem={(a) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Space>
                  <Tag color={TYPE_COLOR[a.type]}>{tEnum('activityType', a.type)}</Tag>
                  <span>{a.subject}</span>
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
        open={open}
        relation={relation}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          void load();
        }}
      />
    </div>
  );
}
