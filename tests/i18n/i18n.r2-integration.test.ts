/**
 * 英文界面 第二轮：集成测试（界面源码无硬编码中文与全角标点、浏览器语言读取与回退、非法语言参数、四类导出的英文表头、用户数据不被翻译）。
 * English UI round 2: integration tests.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as accountExport from '@/app/api/accounts/export/route';
import * as accounts from '@/app/api/accounts/route';
import * as activityExport from '@/app/api/activities/export/route';
import * as dealExport from '@/app/api/deals/export/route';
import * as deals from '@/app/api/deals/route';
import * as leadExport from '@/app/api/leads/export/route';
import * as leadImport from '@/app/api/leads/import/route';
import * as leadTemplate from '@/app/api/leads/import/template/route';
import { call, createTenant, resetDb } from '../helpers';

const CJK = /[　-〿一-鿿＀-￯]/;

/**
 * 去掉注释后的源码（块注释、JSX 注释、行注释；保留字符串中的 //）。
 * Source without comments (block, JSX and line comments; `//` inside strings is kept).
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1))
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length - 1; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === '\\') i++;
          else if (c === quote) quote = null;
        } else if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

describe('i18n R2 source guard', () => {
  it('界面源码（src/app、src/components、src/lib）不含硬编码中文或全角标点 / no hardcoded CJK in UI code', () => {
    const files = [...globSync('src/app/**/*.tsx'), ...globSync('src/components/**/*.tsx'), ...globSync('src/lib/**/*.ts')];
    expect(files.length).toBeGreaterThan(30);
    const hits: string[] = [];
    for (const f of files) {
      codeOnly(readFileSync(f, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (CJK.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('扫描器本身能发现问题（自检）/ the scanner itself detects violations', () => {
    expect(CJK.test(codeOnly("const a = '中文'; // 注释"))).toBe(true);
    expect(CJK.test(codeOnly("const a = 'x'; // 注释\n/* 块注释 */"))).toBe(false);
    expect(CJK.test(codeOnly("const u = 'https://a.b/c'; const z = '中';"))).toBe(true);
  });
});

describe('i18n R2 browser locale', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const withStorage = async (getItem: () => string | null) => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: { getItem, setItem: () => undefined } });
    return import('@/i18n');
  };

  it('读取浏览器保存的英文；非法值或存储不可用时回退中文 / stored locale and fallbacks', async () => {
    let m = await withStorage(() => 'en-US');
    expect(m.getLocale()).toBe('en-US');
    expect(m.t('nav.leads')).toBe('Leads');
    expect(m.tEnum('quoteStatus', 'SENT')).toBe('Sent');
    m = await withStorage(() => 'fr-FR');
    expect(m.getLocale()).toBe('zh-CN');
    m = await withStorage(() => {
      throw new Error('blocked');
    });
    expect(m.t('nav.leads')).toBe('线索');
  });
});

describe('i18n R2 server parameters', () => {
  let a: Awaited<ReturnType<typeof createTenant>>;
  beforeEach(async () => {
    await resetDb();
    a = await createTenant('A');
  });

  /** 读取 CSV / read CSV */
  async function csv(handler: Parameters<typeof call>[0], query: Record<string, string>) {
    const url = new URL('http://localhost/api/x');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await handler(new Request(url, { headers: { authorization: `Bearer ${a.token}` } }), { params: Promise.resolve({}) });
    return { status: res.status, text: (await res.text()).replace(/^﻿/, '') };
  }

  it('非法语言参数：导出、模板、导入均 400 / invalid locale parameters', async () => {
    expect((await csv(leadExport.GET, { lang: 'fr-FR' })).status).toBe(400);
    expect((await csv(leadTemplate.GET, { lang: 'english' })).status).toBe(400);
    expect((await call(leadImport.POST, { token: a.token, body: { csv: 'Name\r\nA', lang: 'xx' } })).status).toBe(400);
  });

  it('四类导出的英文表头不含中文；用户录入的中文数据原样保留 / English headers, user data untouched', async () => {
    const acc = (await call(accounts.POST, { token: a.token, body: { name: '中文客户', industry: 'MANUFACTURING' } })).json;
    await call(deals.POST, { token: a.token, body: { name: '中文商机', accountId: acc.id, stage: 'PROPOSAL' } });
    for (const h of [leadExport.GET, accountExport.GET, dealExport.GET, activityExport.GET]) {
      const r = await csv(h, { lang: 'en-US' });
      expect(r.status).toBe(200);
      expect(CJK.test(r.text.split('\r\n')[0]!)).toBe(false);
    }
    const accountsCsv = (await csv(accountExport.GET, { lang: 'en-US' })).text;
    expect(accountsCsv).toContain('中文客户');
    expect(accountsCsv).toContain('Manufacturing');
    expect((await csv(dealExport.GET, { lang: 'en-US' })).text).toContain('中文商机,中文客户,0.00,CNY,Proposal');
  });

  it('语言参数不影响筛选，也不写入导出审计的筛选条件 / the locale is not a filter', async () => {
    await call(accounts.POST, { token: a.token, body: { name: '甲' } });
    await csv(accountExport.GET, { lang: 'en-US', industry: 'IT' });
    const { prisma } = await import('@/server/db');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'account.export' } });
    expect(log.changes).toMatchObject({ filters: { industry: 'IT' } });
    expect(JSON.stringify(log.changes)).not.toContain('en-US');
  });
});
