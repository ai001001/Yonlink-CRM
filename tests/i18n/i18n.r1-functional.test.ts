/**
 * 英文界面 第一轮：功能测试（文案完整性与占位符一致、翻译函数、按语言导出与模板、英文模板可直接导入、多语言列名与枚举识别）。
 * English UI round 1: functional tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leadTemplate from '@/app/api/leads/import/template/route';
import * as accountTemplate from '@/app/api/accounts/import/template/route';
import * as leads from '@/app/api/leads/route';
import { allTranslations, enumCodes, t, tEnum, tEnumIn, translate } from '@/i18n';
import { enUS } from '@/i18n/en-US';
import { zhCN } from '@/i18n/zh-CN';
import { prisma } from '@/server/db';
import { call, createTenant, resetDb } from '../helpers';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const CJK = /[　-〿一-鿿＀-￯]/;

/** 读取 CSV 文本响应 / read a CSV response as text */
async function csvText(handler: Parameters<typeof call>[0], token: string, query: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/x');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await handler(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  return { status: res.status, text: (await res.text()).replace(/^﻿/, '') };
}

describe('i18n R1 dictionaries', () => {
  it('英文覆盖全部 key，且没有多余 key、没有空值 / English covers every key', () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
    for (const [k, v] of Object.entries(enUS)) expect(v.trim(), k).not.toBe('');
  });

  it('每个 key 的占位符在中英文中一致 / placeholders match per key', () => {
    for (const k of Object.keys(zhCN) as (keyof typeof zhCN)[]) expect(placeholders(enUS[k]), k).toEqual(placeholders(zhCN[k]));
  });

  it('英文文案不含中文与全角标点（语言名“中文”除外）/ no CJK in English except the language name', () => {
    const bad = Object.entries(enUS).filter(([k, v]) => k !== 'lang.zh-CN' && CJK.test(v));
    expect(bad).toEqual([]);
  });

  it('翻译函数：服务端默认中文、按语言翻译、枚举、全部语言与枚举代码 / translation helpers', () => {
    expect(t('nav.leads')).toBe('线索');
    expect(tEnum('dealStage', 'CLOSED_WON')).toBe('赢单');
    expect(translate('en-US', 'common.total', { total: 3 })).toBe('3 in total');
    expect(tEnumIn('en-US', 'leadSource', 'EXHIBITION')).toBe('Trade show');
    expect(tEnumIn('en-US', 'leadSource', 'UNKNOWN')).toBe('UNKNOWN');
    expect(allTranslations('nav.deals')).toEqual(['商机', 'Deals']);
    expect(enumCodes('leadStatus')).toEqual(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED']);
  });
});

describe('i18n R1 CSV', () => {
  let a: Awaited<ReturnType<typeof createTenant>>;
  beforeEach(async () => {
    await resetDb();
    a = await createTenant('A');
  });

  it('导出：英文表头、英文枚举与时间列后缀；默认仍为中文 / English export headers and enums', async () => {
    await call(leads.POST, { token: a.token, body: { name: '王五', source: 'EXHIBITION' } });
    const en = await csvText(leadExport.GET, a.token, { lang: 'en-US' });
    const [header, row] = en.text.split('\r\n');
    expect(header).toBe('Name,Company,Job title,Phone,Mobile,Email,Lead source,Lead status,Owner,Owner email,Created (UTC+8),Notes');
    expect(row).toContain('Trade show');
    expect(row).toContain(',New,');
    const zh = await csvText(leadExport.GET, a.token);
    expect(zh.text.split('\r\n')[0]).toContain('姓名,公司');
    expect(zh.text).toContain('（UTC+8）');
  });

  it('模板：英文表头与英文示例行；英文模板可直接预检导入 / English template imports as-is', async () => {
    const tpl = await csvText(leadTemplate.GET, a.token, { lang: 'en-US' });
    expect(tpl.text.split('\r\n')[0]).toBe('Name,Company,Job title,Phone,Mobile,Email,Lead source,Lead status,Owner email,Notes');
    expect(CJK.test(tpl.text)).toBe(false);
    const r = await call(leadImport.POST, { token: a.token, body: { csv: tpl.text, dryRun: true, lang: 'en-US' } });
    expect(r.json).toMatchObject({ total: 1, valid: 1, errors: [], unknownColumns: [] });
    const acc = await csvText(accountTemplate.GET, a.token, { lang: 'en-US' });
    expect(acc.text.split('\r\n')[0]).toContain('Account name,Industry');
    expect(acc.text).toContain('Manufacturing');
  });

  it('导入：中英文列名与字段名、中英文枚举标签与代码混用均可识别 / mixed headers and enum labels', async () => {
    const csv = ['Name,线索来源,status,Email', '甲,Trade show,new,a@example.com', '乙,展会,Contacted,b@example.com', '丙,REFERRAL,已确认,c@example.com'].join('\r\n');
    const r = await call(leadImport.POST, { token: a.token, body: { csv, dryRun: false } });
    expect(r.json).toMatchObject({ created: 3, errors: [], unknownColumns: [] });
    const rows = await prisma.lead.findMany({ orderBy: { email: 'asc' }, select: { source: true, status: true } });
    expect(rows).toEqual([
      { source: 'EXHIBITION', status: 'NEW' },
      { source: 'EXHIBITION', status: 'CONTACTED' },
      { source: 'REFERRAL', status: 'QUALIFIED' },
    ]);
  });

  it('缺少必填列时按请求语言提示列名 / the missing column is reported in the request locale', async () => {
    const r = await call(leadImport.POST, { token: a.token, body: { csv: 'Email\r\na@example.com', lang: 'en-US' } });
    expect(r.status).toBe(400);
    expect(r.json.error.details.csv).toEqual(['missing_column:Name']);
    const zh = await call(leadImport.POST, { token: a.token, body: { csv: 'Email\r\na@example.com' } });
    expect(zh.json.error.details.csv).toEqual(['missing_column:姓名']);
  });
});
