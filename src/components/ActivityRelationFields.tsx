/**
 * 跟进记录表单中的关联对象选择（客户/线索/商机）。
 * Relation pickers (account / lead / deal) for the activity form.
 */
'use client';

import { Form } from 'antd';
import { t } from '@/i18n';
import type { Activity } from '@/lib/types';
import { RecordSelect } from './RecordSelect';

export function ActivityRelationFields({ editing }: { editing?: Activity | null }) {
  return (
    <div className="form-row">
      <Form.Item name="accountId" label={t('activities.account')}>
        <RecordSelect resource="/api/accounts" initialLabel={editing?.account?.name} />
      </Form.Item>
      <Form.Item name="leadId" label={t('activities.lead')}>
        <RecordSelect resource="/api/leads" initialLabel={editing?.lead?.name} />
      </Form.Item>
      <Form.Item name="dealId" label={t('activities.deal')}>
        <RecordSelect resource="/api/deals" initialLabel={editing?.deal?.name} />
      </Form.Item>
    </div>
  );
}
