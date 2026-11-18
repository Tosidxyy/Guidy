import { beforeEach, describe, expect, it } from 'vitest';
import { usePlanSync } from '../usePlanSync';

beforeEach(() => usePlanSync.setState({ serverVersions: {} }));

describe('usePlanSync', () => {
  it('按计划写入与覆盖版本', () => {
    usePlanSync.getState().setServerVersion('p1', 1);
    usePlanSync.getState().setServerVersion('p1', 3);
    expect(usePlanSync.getState().serverVersions.p1).toBe(3);
  });
  it('forget 删除计划版本', () => {
    usePlanSync.getState().setServerVersion('p1', 2);
    usePlanSync.getState().forget('p1');
    expect(usePlanSync.getState().serverVersions.p1).toBeUndefined();
  });
});