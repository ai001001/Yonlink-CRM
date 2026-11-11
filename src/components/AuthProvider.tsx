/**
 * 登录状态上下文。会话有效性始终以服务端 /api/auth/me 为准。
 * Auth state context. Session validity is always decided by the server (/api/auth/me).
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, STATIC_PREVIEW } from '@/lib/api';

/** 当前用户 / Current user */
export interface Me {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'SALES' | 'READONLY';
  isDemo: boolean;
  /** 服务端返回的权限点（仅用于界面显示，服务端仍逐请求校验）/ permissions from the server (UI only) */
  permissions: string[];
  organization: { id: string; name: string };
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInDemo: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (STATIC_PREVIEW || !getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api<Me>('/api/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 首次挂载时向服务端确认会话 / confirm the session with the server on mount
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const onUnauthorized = () => setMe(null);
    window.addEventListener('yonlink:unauthorized', onUnauthorized);
    return () => window.removeEventListener('yonlink:unauthorized', onUnauthorized);
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ token: string }>('/api/auth/login', { method: 'POST', body: { email, password } });
      setToken(res.token);
      await refresh();
    },
    [refresh],
  );

  const signInDemo = useCallback(
    async (userId: string) => {
      const res = await api<{ token: string }>('/api/auth/demo-login', { method: 'POST', body: { userId } });
      setToken(res.token);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setToken(null);
    setMe(null);
  }, []);

  return <AuthContext.Provider value={{ me, loading, signIn, signInDemo, signOut }}>{children}</AuthContext.Provider>;
}

/**
 * 读取登录状态。
 * Read the auth state.
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/**
 * 权限辅助（仅决定界面是否显示操作，真正的授权在服务端）。
 * Permission helpers (only decide what the UI shows; real authorization is server-side).
 */
export function usePermissions() {
  const { me } = useAuth();
  const can = (permission: string) => !!me?.permissions.includes(permission);
  return {
    can,
    /** 能否编辑该记录 / whether the record can be edited */
    canEdit: (record: { ownerId: string | null }) => can('record.update.all') || (can('record.update.own') && record.ownerId === me?.id),
    canCreate: can('record.create'),
    canDelete: can('record.delete'),
    canAssign: can('owner.assign'),
    meId: me?.id ?? null,
  };
}
