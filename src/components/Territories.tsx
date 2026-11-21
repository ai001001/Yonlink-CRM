/**
 * 区域的共用界面：读取区域列表、列表筛选（全部区域 / 我的区域 / 无区域 / 某区域含下级）、客户表单中的区域选择。
 * Shared territory UI: loading the list, the list filter (my territories / none / a territory with its children) and
 * the territory picker on the account form.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Form, Select, Tag } from 'antd';
import { t } from '@/i18n';
import { api } from '@/lib/api';

/** 条件 / condition */
export interface TerritoryCondition {
  field: string;
  op: string;
  value?: string;
}
/** 区域统计（含下级）/ territory statistics (with descendants) */
export interface TerritoryStats {
  directAccounts: number;
  accounts: number;
  openCount: number;
  openAmount: string;
  wonCount: number;
  wonAmount: string;
  missingRates: string[];
}
/** 区域 / territory */
export interface Territory {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  managerId: string | null;
  priority: number;
  match: 'ALL' | 'ANY';
  conditions: TerritoryCondition[];
  manager: { id: string; name: string } | null;
  members: { id: string; name: string }[];
  stats: TerritoryStats;
}
/** 区域列表 / territory list */
export interface TerritoryList {
  items: Territory[];
  unassigned: Omit<TerritoryStats, 'directAccounts'>;
  baseCurrency: string;
}

/** 区域选项 / territory option */
export type TerritoryOption = Pick<Territory, 'id' | 'parentId' | 'name'>;

/** 表单中“无区域”的取值（提交时转为 null）/ form value for "no territory" (sent as null) */
export const NO_TERRITORY = '__NONE__';

/**
 * 读取区域列表（含统计，区域管理页使用）。
 * Load the territory list with statistics (territories page).
 */
export function useTerritories() {
  const [data, setData] = useState<TerritoryList | null>(null);
  const reload = useCallback(() => {
    api<TerritoryList>('/api/territories')
      .then(setData)
      .catch(() => setData(null));
  }, []);
  useEffect(reload, [reload]);
  return { data, items: data?.items ?? [], reload };
}

/**
 * 读取区域选项（筛选与下拉使用，不计算统计）。
 * Load territory options for filters and pickers (no statistics).
 */
export function useTerritoryOptions(): TerritoryOption[] {
  const [items, setItems] = useState<TerritoryOption[]>([]);
  useEffect(() => {
    api<{ items: TerritoryOption[] }>('/api/territories?view=options')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  return items;
}

/**
 * 按树形排序并缩进的选项（下级排在上级之后）。
 * Options in tree order with indentation (children follow their parent).
 */
export function territoryOptions(items: TerritoryOption[], exclude: Set<string> = new Set()) {
  const out: { value: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of items.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (exclude.has(t.id)) continue;
      out.push({ value: t.id, label: `${'\u00a0\u00a0\u00a0'.repeat(depth)}${t.name}` });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * 列表的区域筛选。
 * Territory filter for lists.
 */
export function TerritoryFilter({ items, value, onChange }: { items: TerritoryOption[]; value?: string; onChange: (v?: string) => void }) {
  return (
    <Select
      allowClear
      aria-label={t('territories.territory')}
      placeholder={t('territories.territory')}
      style={{ width: 160 }}
      value={value}
      onChange={onChange}
      data-testid="territory-filter"
      options={[{ value: 'MINE', label: t('territories.mine') }, { value: 'NONE', label: t('territories.none') }, ...territoryOptions(items)]}
    />
  );
}

/**
 * 区域显示（手工指定时加标记）。
 * Territory display (marked when set by hand).
 */
export function TerritoryLabel({ territory, manual }: { territory?: { name: string } | null; manual?: boolean }) {
  return (
    <>
      {territory?.name ?? t('territories.none')}
      {manual && (
        <Tag style={{ marginInlineStart: 8 }} color="default">
          {t('territories.manual')}
        </Tag>
      )}
    </>
  );
}

/**
 * 客户表单中的区域（仅 territory.manage 显示）：自动、无区域或指定区域。
 * Territory on the account form (territory.manage only): automatic, none or a territory.
 */
export function TerritoryFormItem({ items }: { items: TerritoryOption[] }) {
  return (
    <Form.Item name="territoryId" label={t('territories.territory')} extra={t('territories.formHint')}>
      <Select
        showSearch
        optionFilterProp="label"
        data-testid="territory-select"
        options={[{ value: 'AUTO', label: t('territories.auto') }, { value: NO_TERRITORY, label: t('territories.none') }, ...territoryOptions(items)]}
      />
    </Form.Item>
  );
}

/**
 * 表单初始值：自动分配时为 AUTO，手工时为区域或“无区域”。
 * Initial form value: AUTO when automatic, otherwise the territory or "none".
 */
export const territoryFormValue = (a?: { territoryId?: string | null; territoryManual?: boolean } | null) => (a?.territoryManual ? (a.territoryId ?? NO_TERRITORY) : 'AUTO');
/** 提交值：“无区域”转为 null / submitted value: "none" becomes null */
export const territorySubmitValue = (v: unknown) => (v === NO_TERRITORY ? null : v);
