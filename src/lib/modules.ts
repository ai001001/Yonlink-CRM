/**
 * 自定义模块的前端类型与导航刷新事件。
 * Front-end types for custom modules and the navigation refresh event.
 */

/** 模块变化后通知导航刷新的事件名 / event telling the navigation to reload modules */
export const MODULES_CHANGED = 'yonlink:modules-changed';

/** 通知导航刷新 / ask the navigation to reload */
export const notifyModulesChanged = (): void => {
  window.dispatchEvent(new Event(MODULES_CHANGED));
};

/** 模块 / module */
export interface CustomModule {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  position: number;
  _count?: { fields: number; records: number };
}
