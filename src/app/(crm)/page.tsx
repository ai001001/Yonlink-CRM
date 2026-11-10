/**
 * 工作台（Dashboard 模块阶段实现）/ Dashboard (implemented in the Dashboard phase).
 */
'use client';

import { redirect } from 'next/navigation';

export default function DashboardPage() {
  redirect('/leads');
}
