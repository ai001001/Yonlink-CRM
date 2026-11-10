/**
 * 业务页面布局（需登录）/ Layout for business pages (sign-in required).
 */
import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';

export default function CrmLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
