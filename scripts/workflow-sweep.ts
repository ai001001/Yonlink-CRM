/**
 * 定时工作流与销售节奏（服务器定时任务）：检查全部组织启用的“相对日期”“无跟进”规则并执行到期的动作，
 * 然后处理销售节奏中到期的步骤与退出，最后检查低库存并提醒管理员与经理。
 * 由 systemd 用户定时器 yonlink-workflow.timer 每 15 分钟触发；同一记录同一触发键只执行一次、每个节奏参与只处理一次，
 * 重复运行安全。有规则或参与出错时退出码为 1（其他照常处理）。
 * Scheduled workflows and cadences (server job): runs the due actions of every organization's active relative-date
 * and inactivity rules, then processes due cadence steps and exits, then sends low-stock alerts. Triggered every 15 minutes by the systemd user
 * timer yonlink-workflow.timer; each record and trigger key runs once and each enrollment is processed once, so re-runs
 * are safe. Exits 1 when any rule or enrollment failed (others are still processed).
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
const { sweepCadences } = await import('../src/server/modules/cadences');
const { sweepLowStock } = await import('../src/server/modules/low-stock');

const started = Date.now();
try {
  const r = await sweepScheduledWorkflows();
  console.log(`定时工作流完成 / scheduled workflows done: 规则 ${r.rules} 条，检查 ${r.checked} 条记录，执行 ${r.ran} 次，出错 ${r.failures.length} 条；用时 ${Date.now() - started}ms`);
  for (const f of r.failures) console.error(`  规则 ${f.ruleId} 出错 / failed: ${f.error}`);
  const c = await sweepCadences();
  console.log(`销售节奏完成 / cadences done: 节奏 ${c.cadences} 个，退出 ${c.exited} 个参与，处理 ${c.processed} 个参与，创建跟进 ${c.activities} 条，出错 ${c.failures.length} 个`);
  for (const f of c.failures) console.error(`  参与 ${f.enrollmentId} 出错 / failed: ${f.error}`);
  const s = await sweepLowStock();
  console.log(`低库存提醒完成 / low-stock alerts done: 低库存 ${s.checked} 个，新提醒 ${s.alerted} 个产品，发出通知 ${s.notifications} 条，恢复 ${s.recovered} 个`);
  process.exitCode = r.failures.length || c.failures.length ? 1 : 0;
} catch (err) {
  console.error(`定时工作流失败 / scheduled workflows failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
