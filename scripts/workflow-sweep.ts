/**
 * 定时工作流（服务器定时任务）：检查全部组织启用的“相对日期”“无跟进”规则并执行到期的动作。
 * 由 systemd 用户定时器 yonlink-workflow.timer 每 15 分钟触发；同一记录同一触发键只执行一次，重复运行安全。
 * 有规则出错时退出码为 1（其他规则照常处理）。
 * Scheduled workflows (server job): checks every organization's active relative-date and inactivity rules and runs the
 * due actions. Triggered every 15 minutes by the systemd user timer yonlink-workflow.timer; each record and trigger key
 * runs once, so re-runs are safe. Exits 1 when any rule failed (others are still processed).
 *
 * 用法 / usage: DATABASE_URL=… npx tsx scripts/workflow-sweep.ts
 */
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  console.error('需要 DATABASE_URL / DATABASE_URL is required');
  process.exit(2);
}

// 数据库模块加载时即需要连接串，因此在检查之后动态加载 / the database module needs the URL when loaded
const { prisma } = await import('../src/server/db');
const { sweepScheduledWorkflows } = await import('../src/server/modules/workflow-schedule');

const started = Date.now();
try {
  const r = await sweepScheduledWorkflows();
  console.log(`定时工作流完成 / scheduled workflows done: 规则 ${r.rules} 条，检查 ${r.checked} 条记录，执行 ${r.ran} 次，出错 ${r.failures.length} 条；用时 ${Date.now() - started}ms`);
  for (const f of r.failures) console.error(`  规则 ${f.ruleId} 出错 / failed: ${f.error}`);
  process.exitCode = r.failures.length ? 1 : 0;
} catch (err) {
  console.error(`定时工作流失败 / scheduled workflows failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
