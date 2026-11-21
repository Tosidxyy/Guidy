import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { clearPersisted } from '@/lib/storage';
import { flushDraftSave } from '@/lib/planActions';
import { usePlanStore } from '@/store/usePlanStore';
import { flushBlockHistoryWrites } from '@/store/useBlockHistory';

function toastError(err: unknown, fallback: string) {
  const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, fallback);
  toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
}

function resetLocal() {
  window.location.reload();
}

/** 本地模式只保留「删除全部数据」；恢复码/跨设备认领已移除。 */
export function useRecovery() {
  const deleteAll = useMutation({
    mutationFn: async () => {
      usePlanStore.setState({ ready: false });
      await flushDraftSave();
      await usePlanStore.getState().flush();
      await flushBlockHistoryWrites();
      clearPersisted();
      return api.deleteAll();
    },
    onSuccess: () => resetLocal(),
    onError: (err) => {
      usePlanStore.setState({ ready: true });
      toastError(err, '删除失败，请重试');
    },
  });
  return {
    deleteAll: () => deleteAll.mutate(),
    isDeleting: deleteAll.isPending,
  };
}
