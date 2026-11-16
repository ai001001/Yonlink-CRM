/**
 * SLA 定时任务 第一轮：功能测试（检查全部已启用 SLA 的组织、跳过未配置与已停用的组织、重复运行不重复升级；
 * 命令行脚本对真实测试库运行：输出统计、升级工单、退出码；缺少 DATABASE_URL 退出码 2；
 * systemd 单元文件指向仓库中的脚本、每 5 分钟触发）。
 * SLA scheduler round 1: functional tests.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import * as accounts from '@/app/api/accounts/route';
import * as tickets from '@/app/api/tickets/route';
import * as sla from '@/app/api/tickets/sla/route';
import { prisma } from '@/server/db';
import { sweepAllEscalations } from '@/server/modules/ticket-sla';
import { call, createTenant, resetDb } from '../helpers';

const run = promisify(execFile);
const past = () => new Date(Date.now() - 3_600_000).toISOString();
const policy = (enabled = true) => ({ enabled, urgentHours: 4, highHours: 24, mediumHours: 72, lowHours: 168, escalateToId: null });

/** 建一个组织：可选 SLA 状态与若干超时工单 / an organization with an optional SLA and overdue tickets */
async function tenant(label: string, slaState: 'on' | 'off' | 'none', overdue: number) {
  const t = await createTenant(label);
  if (slaState !== 'none') await call(sla.PUT, { token: t.token, body: policy(slaState === 'on'), method: 'PUT' });
  const acc = (await call(accounts.POST, { token: t.token, body: { name: `${label}客户` } })).json;
  for (let i = 0; i < overdue; i++) await call(tickets.POST, { token: t.token, body: { subject: `${label}超时${i}`, accountId: acc.id, dueAt: past() } });
  return t;
}

beforeEach(async () => {
  await resetDb();
});

describe('SLA scheduler R1', () => {
  it('检查全部已启用的组织，跳过未配置与停用的；重复运行不重复 / all enabled organizations', async () => {
    const a = await tenant('A', 'on', 2);
    const b = await tenant('B', 'on', 1);
    const c = await tenant('C', 'off', 3);
    const d = await tenant('D', 'none', 1);
    const r = await sweepAllEscalations();
    expect(r).toEqual({ organizations: 2, escalated: 3, failures: [] });
    expect(await prisma.ticket.count({ where: { organizationId: a.org.id, escalatedAt: { not: null } } })).toBe(2);
    expect(await prisma.ticket.count({ where: { organizationId: b.org.id, escalatedAt: { not: null } } })).toBe(1);
    expect(await prisma.ticket.count({ where: { organizationId: { in: [c.org.id, d.org.id] }, escalatedAt: { not: null } } })).toBe(0);
    expect(await sweepAllEscalations()).toEqual({ organizations: 2, escalated: 0, failures: [] });
    expect(await prisma.notification.count({ where: { type: 'TICKET_ESCALATED' } })).toBe(3);
  });

  it('命令行脚本对测试库运行：输出统计并升级；缺少连接串退出码 2 / the CLI script', async () => {
    const a = await tenant('A', 'on', 2);
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL! };
    const { stdout } = await run('npx', ['tsx', 'scripts/sla-sweep.ts'], { env, timeout: 60_000 });
    expect(stdout).toMatch(/SLA 检查完成 \/ SLA sweep done: 组织 1 个，升级工单 2 张，出错 0 个/);
    expect(await prisma.ticket.count({ where: { organizationId: a.org.id, escalatedAt: { not: null } } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'ticket.escalate', actorId: null } })).toBe(2);
    // 再次运行：0 张 / a second run escalates none
    expect((await run('npx', ['tsx', 'scripts/sla-sweep.ts'], { env, timeout: 60_000 })).stdout).toMatch(/升级工单 0 张/);
    // 缺少 DATABASE_URL：退出码 2（显式置空；dotenv 不会覆盖已存在的变量）/ missing DATABASE_URL exits 2 (dotenv never overrides an existing variable)
    const noDb = { ...process.env, DATABASE_URL: '' };
    const err = await run('npx', ['tsx', 'scripts/sla-sweep.ts'], { env: noDb, timeout: 60_000 }).catch((e: { code: number; stderr: string }) => e);
    expect(err).toMatchObject({ code: 2 });
    expect((err as { stderr: string }).stderr).toContain('需要 DATABASE_URL');
  }, 120_000);

  it('systemd 单元：运行仓库中的脚本、每 5 分钟、依赖数据库 / unit files', () => {
    const service = readFileSync('deploy/systemd/yonlink-sla.service', 'utf8');
    const timer = readFileSync('deploy/systemd/yonlink-sla.timer', 'utf8');
    const script = /ExecStart=.*tsx (\S+)/.exec(service)?.[1];
    expect(script).toBe('scripts/sla-sweep.ts');
    expect(existsSync(script!)).toBe(true);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^Requires=yonlink-postgres\.service$/m);
    expect(service).toMatch(/^EnvironmentFile=%h\/yonlink-deploy\/shared\/app\.env$/m);
    expect(service).toMatch(/^TimeoutStartSec=\d+$/m);
    expect(timer).toMatch(/^OnCalendar=\*:0\/5$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });
});
