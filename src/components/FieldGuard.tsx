/**
 * 按字段权限包裹表单项：隐藏的字段不渲染，只读的字段禁用（服务端仍会拒绝修改）。
 * Wrap a form item by field-level security: hidden fields are not rendered, read-only ones are disabled (the server
 * still refuses changes).
 */
'use client';

import type { ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import { fieldHidden, fieldReadOnly, type FieldEntity } from '@/lib/field-access';

export function FieldGuard({ entity, field, children }: { entity: FieldEntity; field: string; children: ReactNode }) {
  if (fieldHidden(entity, field)) return null;
  if (fieldReadOnly(entity, field)) return <ConfigProvider componentDisabled>{children}</ConfigProvider>;
  return <>{children}</>;
}

/**
 * 生成某对象的判断函数：show(字段) 是否显示。
 * A per-entity helper: show(field) tells whether a field is shown.
 */
export const visibleIn = (entity: FieldEntity) => (field: string) => !fieldHidden(entity, field);
