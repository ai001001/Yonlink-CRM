/**
 * 商机详情的“竞争对手”页签：记录竞争对手的威胁程度、优势与劣势。
 * Deal "Competitors" tab: competitors with threat level, strengths and weaknesses.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { t, tEnum } from '@/i18n';
import { api, ClientApiError } from '@/lib/api';
import { usePermissions } from './AuthProvider';

/** 威胁程度（与服务端一致）/ threat levels (same as the server) */
const THREATS = ['HIGH', 'MEDIUM', 'LOW'] as const;
const THREAT_COLOR: Record<string, string> = { HIGH: 'red', MEDIUM: 'orange', LOW: 'green' };

/** 竞争对手 / Competitor */
interface Competitor {
  id: string;
  name: string;
  threatLevel: string;
  strengths: string | null;
  weaknesses: string | null;
}

interface Props {
  deal: { id: string; ownerId: string | null };
}

interface CompetitorForm {
  name?: string;
  threatLevel?: string;
  strengths?: string | null;
  weaknesses?: string | null;
}

export function DealCompetitorsPanel({ deal }: Props) {
  const { message } = App.useApp();
  const perm = usePermissions();
  const editable = perm.canEdit(deal);
  const [items, setItems] = useState<Competitor[]>([]);
  /** 正在编辑：'new' 为新增 / being edited; 'new' for a new one */
  const [editing, setEditing] = useState<Competitor | 'new' | null>(null);
  const [form] = Form.useForm<CompetitorForm>();

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Competitor[] }>(`/api/deals/${deal.id}/competitors`)).items);
    } catch (err) {
      message.error((err as Error).message);
    }
  }, [deal.id, message]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const open = (c: Competitor | 'new') => {
    form.resetFields();
    if (c !== 'new') form.setFieldsValue({ name: c.name, threatLevel: c.threatLevel, strengths: c.strengths, weaknesses: c.weaknesses });
    setEditing(c);
  };

  const save = async () => {
    const v = await form.validateFields();
    const body = { name: v.name, threatLevel: v.threatLevel, strengths: v.strengths ?? null, weaknesses: v.weaknesses ?? null };
    try {
      if (editing === 'new') await api(`/api/deals/${deal.id}/competitors`, { method: 'POST', body });
      else if (editing) await api(`/api/deal-competitors/${editing.id}`, { method: 'PATCH', body });
      message.success(t('common.saved'));
      setEditing(null);
      void load();
    } catch (err) {
      if (err instanceof ClientApiError && err.details?.name?.[0] === 'duplicate') {
        form.setFields([{ name: 'name', errors: [t('competitors.error.duplicate')] }]);
        return;
      }
      message.error((err as Error).message);
    }
  };

  const remove = async (c: Competitor) => {
    try {
      await api(`/api/deal-competitors/${c.id}`, { method: 'DELETE' });
      message.success(t('common.deleted'));
      void load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const text = (v: string | null) => (v ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }} ellipsis={{ rows: 3, expandable: true }}>{v}</Typography.Paragraph> : null);

  return (
    <div data-testid="deal-competitors">
      {editable && (
        <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 12 }} onClick={() => open('new')}>
          {t('competitors.add')}
        </Button>
      )}
      <Table<Competitor>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={items}
        locale={{ emptyText: t('common.empty') }}
        columns={[
          { title: t('competitors.name'), dataIndex: 'name', width: 160 },
          { title: t('competitors.threatLevel'), width: 90, render: (_, c) => <Tag color={THREAT_COLOR[c.threatLevel]}>{tEnum('competitorThreat', c.threatLevel)}</Tag> },
          { title: t('competitors.strengths'), render: (_, c) => text(c.strengths) },
          { title: t('competitors.weaknesses'), render: (_, c) => text(c.weaknesses) },
          {
            title: t('common.actions'),
            hidden: !editable,
            width: 120,
            render: (_, c) => (
              <Space>
                <Button type="link" size="small" aria-label={`${t('common.edit')} ${c.name}`} onClick={() => open(c)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm title={t('common.confirmDelete')} onConfirm={() => remove(c)}>
                  <Button type="link" size="small" danger aria-label={`${t('common.delete')} ${c.name}`}>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing === 'new' ? t('competitors.add') : t('competitors.edit')}
        open={editing !== null}
        onOk={save}
        onCancel={() => setEditing(null)}
        okText={t('common.save')}
        forceRender
        zIndex={1100}
      >
        <Form form={form} name="competitor" layout="vertical" initialValues={{ threatLevel: 'MEDIUM' }}>
          <Form.Item name="name" label={t('competitors.name')} rules={[{ required: true, whitespace: true, message: t('common.required', { field: t('competitors.name') }) }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="threatLevel" label={t('competitors.threatLevel')}>
            <Select options={THREATS.map((v) => ({ value: v, label: tEnum('competitorThreat', v) }))} />
          </Form.Item>
          <Form.Item name="strengths" label={t('competitors.strengths')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
          <Form.Item name="weaknesses" label={t('competitors.weaknesses')}>
            <Input.TextArea rows={3} maxLength={5000} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
