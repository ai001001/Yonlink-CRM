/**
 * 自定义字段页（设置 › 自定义字段，需 customfield.manage）：按对象列出字段（名称、类型、选项、必填、启用），新建、编辑、删除。
 * Custom fields page (Setup › Custom fields, customfield.manage): fields per entity (name, type, options, required,
 * active) with create, edit and delete.
 */
'use client';

import { useRef, useState } from 'react';
import { Button, Card, Segmented, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { CustomEntity } from '@/components/CustomFields';
import { FieldManager } from '@/components/FieldManager';
import { t } from '@/i18n';

const ENTITIES: CustomEntity[] = ['LEAD', 'ACCOUNT', 'CONTACT', 'DEAL'];

export default function CustomFieldsPage() {
  const [entity, setEntity] = useState<CustomEntity>('LEAD');
  const openNew = useRef<() => void>(undefined);

  return (
    <Card
      title={t('customFields.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openNew.current?.()} data-testid="custom-field-new">
          {t('customFields.new')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('customFields.hint')}</Typography.Paragraph>
      <Segmented style={{ marginBottom: 16 }} value={entity} onChange={(v) => setEntity(v as CustomEntity)} options={ENTITIES.map((e) => ({ value: e, label: t(`customFields.entity.${e}`) }))} />
      <FieldManager
        listUrl={`/api/custom-fields?entity=${entity}`}
        createUrl="/api/custom-fields"
        createExtra={{ entity }}
        itemUrl={(id) => `/api/custom-fields/${id}`}
        onReady={(fn) => {
          openNew.current = fn;
        }}
      />
    </Card>
  );
}
