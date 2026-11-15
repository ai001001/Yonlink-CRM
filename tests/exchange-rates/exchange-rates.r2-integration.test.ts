/**
 * 汇率 第二轮：集成测试（只有管理员能录入与删除、各组织汇率互相独立、参数校验与数据库约束、同币种同日并发录入、
 * 销售代表的本币汇总只含自己的数据、未登录、跨域预检）。
 * Exchange rates round 2: integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as deals from '@/app/api/deals/route';
import * as rateItem from '@/app/api/exchange-rates/[id]/route';
import * as rates from '@/app/api/exchange-rates/route';
import * as sales from '@/app/api/reports/sales/route';
import { prisma } from '@/server/db';
import { ratesOn } from '@/server/modules/exchange-rates';
import { addUser, call, createTenant, resetDb } from '../helpers';

type Who = { user: { id: string }; token: string };
let admin: Who & { org: { id: string } };
let other: Who & { org: { id: string } };
let manager: Who;
let sales1: Who;
let viewer: Who;
const put = (who: Who, body: object) => call(rates.PUT, { token: who.token, body, method: 'PUT' });

beforeEach(async () => {
  await resetDb();
  admin = await createTenant('A', 'ADMIN');
  other = await createTenant('B', 'ADMIN');
  manager = await addUser(admin.org.id, 'MANAGER');
  sales1 = await addUser(admin.org.id, 'SALES', 'S1');
  viewer = await addUser(admin.org.id, 'READONLY');
});

describe('exchange rates R2 permissions & isolation', () => {
  it('只有管理员能录入与删除；其他角色只能查看 / only admins manage rates', async () => {
    const r = (await put(admin, { currency: 'USD', rate: '7.2', effectiveDate: '2026-11-01' })).json;
    for (const who of [manager, sales1, viewer]) {
      expect((await call(rates.GET, { token: who.token })).json.current.find((c: { currency: string }) => c.currency === 'USD').rate).toBe('7.2');
      expect((await put(who, { currency: 'USD', rate: '1', effectiveDate: '2026-11-01' })).status).toBe(403);
      expect((await call(rateItem.DELETE, { token: who.token, params: { id: r.id }, method: 'DELETE' })).status).toBe(403);
    }
    expect((await prisma.exchangeRate.findUniqueOrThrow({ where: { id: r.id } })).rate.toString()).toBe('7.2');
    expect(await prisma.auditLog.count({ where: { entityType: 'rate' } })).toBe(1);
  });

  it('各组织汇率互相独立，不能删除对方汇率 / rates are per organization', async () => {
    const mine = (await put(admin, { currency: 'USD', rate: '7.2', effectiveDate: '2026-11-01' })).json;
    await put(other, { currency: 'USD', rate: '9.9', effectiveDate: '2026-11-01' });
    expect((await ratesOn(admin.org.id, new Date('2026-11-10T00:00:00Z'))).get('USD')?.toString()).toBe('7.2');
    expect((await ratesOn(other.org.id, new Date('2026-11-10T00:00:00Z'))).get('USD')?.toString()).toBe('9.9');
    expect((await call(rates.GET, { token: other.token })).json.history.map((h: { rate: string }) => h.rate)).toEqual(['9.9']);
    expect((await call(rateItem.DELETE, { token: other.token, params: { id: mine.id }, method: 'DELETE' })).status).toBe(404);
    expect(await prisma.exchangeRate.count({ where: { id: mine.id } })).toBe(1);
  });

  it('销售代表的本币汇总只含自己负责的商机 / base totals follow visibility', async () => {
    await put(admin, { currency: 'USD', rate: '7', effectiveDate: '2026-01-01' });
    const mk = async (who: Who, amount: string, currency: string) => {
      const acc = (await call(accounts.POST, { token: who.token, body: { name: `客户${amount}` } })).json;
      expect((await call(deals.POST, { token: who.token, body: { name: `商机${amount}`, accountId: acc.id, amount, currency } })).status).toBe(201);
    };
    await mk(sales1, '100', 'USD');
    await mk(admin, '1000', 'CNY');
    expect((await call(sales.GET, { token: sales1.token })).json.base.openAmount).toBe('700.00');
    expect((await call(sales.GET, { token: admin.token })).json.base.openAmount).toBe('1700.00');
  });
});

describe('exchange rates R2 validation & integrity', () => {
  it('参数校验与未登录 / validation and auth', async () => {
    const bad = [
      {},
      { currency: 'CNY', rate: '1', effectiveDate: '2026-11-01' },
      { currency: 'GBP', rate: '9', effectiveDate: '2026-11-01' },
      { currency: 'USD', rate: '0', effectiveDate: '2026-11-01' },
      { currency: 'USD', rate: '-7', effectiveDate: '2026-11-01' },
      { currency: 'USD', rate: '7.123456789', effectiveDate: '2026-11-01' },
      { currency: 'USD', rate: 'abc', effectiveDate: '2026-11-01' },
      { currency: 'USD', rate: '7', effectiveDate: '2026-02-30' },
      { currency: 'USD', rate: '7', effectiveDate: '2026-11-01', organizationId: other.org.id },
    ];
    for (const body of bad) expect((await put(admin, body)).status).toBe(400);
    expect((await call(rates.GET)).status).toBe(401);
    expect((await call(rates.PUT, { body: { currency: 'USD', rate: '7', effectiveDate: '2026-11-01' }, method: 'PUT' })).status).toBe(401);
    expect(await prisma.exchangeRate.count()).toBe(0);
  });

  it('数据库约束：本币、非正汇率、非法币种代码被拒绝 / DB guards', async () => {
    const base = { organizationId: admin.org.id, effectiveDate: new Date('2026-11-01') };
    await expect(prisma.exchangeRate.create({ data: { ...base, currency: 'CNY', rate: '1' } })).rejects.toThrow();
    await expect(prisma.exchangeRate.create({ data: { ...base, currency: 'USD', rate: '0' } })).rejects.toThrow();
    await expect(prisma.exchangeRate.create({ data: { ...base, currency: 'usd', rate: '7' } })).rejects.toThrow();
    expect(await prisma.exchangeRate.count()).toBe(0);
  });

  it('同币种同日并发录入：最终只有一条 / concurrent entries for the same day', async () => {
    const results = await Promise.all(['7.1', '7.2', '7.3', '7.4', '7.5'].map((rate) => put(admin, { currency: 'USD', rate, effectiveDate: '2026-11-01' })));
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(await prisma.exchangeRate.count()).toBe(1);
  });
});

describe('exchange rates R2 cors', () => {
  const saved = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = saved;
  });

  it('跨域预检允许 GET/PUT/DELETE / preflight', async () => {
    process.env.CORS_ORIGINS = 'https://ai001001.github.io';
    const res = await rateItem.OPTIONS(new Request('http://localhost/api/exchange-rates/x', { method: 'OPTIONS', headers: { Origin: 'https://ai001001.github.io' } }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ai001001.github.io');
    for (const m of ['GET', 'PUT', 'DELETE']) expect(res.headers.get('Access-Control-Allow-Methods')).toContain(m);
  });
});
