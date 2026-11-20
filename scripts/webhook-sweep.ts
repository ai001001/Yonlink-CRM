/**
 * Webhook 投递（服务器定时任务）：发送全部组织到期的投递（含按退避重试的），每次最多 200 条。
 * 由 systemd 用户定时器 yonlink-webhook.timer 每分钟触发；多个进程同时运行也不会重复领取同一条投递。
 * Webhook delivery (server job): sends due deliveries for every organization (back-off retries included), up to 200 per
 * run. Triggered every minute by the systemd user timer yonlink-webhook.timer; concurrent runs never claim the same item.
 *
 * 用法 / usage: DATABASE_URL=… npx tsx scripts/webhook-sweep.ts
 */
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  console.error('需要 DATABASE_URL / DATABASE_URL is required');
  process.exit(2);
}

// 数据库模块加载时即需要连接串，因此在检查之后动态加载 / the database module needs the URL when loaded
const { prisma } = await import('../src/server/db');
const { sweepDeliveries } = await import('../src/server/modules/webhooks');

const started = Date.now();
try {
  const r = await sweepDeliveries(200);
  console.log(`Webhook 投递完成 / webhook sweep done: 领取 ${r.claimed}，成功 ${r.succeeded}，待重试 ${r.retry}，失败 ${r.failed}；用时 ${Date.now() - started}ms`);
  process.exitCode = 0;
} catch (err) {
  console.error(`Webhook 投递失败 / webhook sweep failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
