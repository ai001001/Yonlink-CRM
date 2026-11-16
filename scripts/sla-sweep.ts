/**
 * 工单 SLA 超时升级检查（服务器定时任务）：检查全部已启用 SLA 的组织，升级超时的未解决工单并发通知。
 * 由 systemd 用户定时器 yonlink-sla.timer 每 5 分钟触发；可重复运行（每张工单只升级一次）。
 * 有组织出错时退出码为 1（其他组织照常处理），便于在 systemctl status / journalctl 中发现。
 * Ticket SLA escalation check (server job): checks every organization with an enabled SLA, escalates overdue
 * unresolved tickets and sends notifications. Triggered every 5 minutes by the systemd user timer yonlink-sla.timer;
 * safe to re-run (each ticket escalates once). Exits 1 when any organization failed (others are still processed).
 *
 * 用法 / usage: DATABASE_URL=… npx tsx scripts/sla-sweep.ts
 */
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  console.error('需要 DATABASE_URL / DATABASE_URL is required');
  process.exit(2);
}

// 静态 import 会先于上面的检查执行（数据库模块加载时即需要连接串），因此在检查之后动态加载
// static imports run before the check above (the database module needs the URL when loaded), so load them afterwards
const { prisma } = await import('../src/server/db');
const { sweepAllEscalations } = await import('../src/server/modules/ticket-sla');

const started = Date.now();
try {
  const r = await sweepAllEscalations();
  console.log(`SLA 检查完成 / SLA sweep done: 组织 ${r.organizations} 个，升级工单 ${r.escalated} 张，出错 ${r.failures.length} 个；用时 ${Date.now() - started}ms`);
  for (const f of r.failures) console.error(`  组织 ${f.organizationId} 出错 / failed: ${f.error}`);
  process.exitCode = r.failures.length ? 1 : 0;
} catch (err) {
  console.error(`SLA 检查失败 / SLA sweep failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
