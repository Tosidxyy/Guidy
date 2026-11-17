import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { clearPersisted } from '@/lib/storage';

function toastError(err: unknown, fallback: string) {
  const e = err instanceof ApiError ? err : new ApiError('service_unavailable', 503, fallback);
  toast.error(e.message, { description: e.diagnosticId ? `诊断 ID：${e.diagnosticId}` : undefined });
}

function resetLocal() {
  clearPersisted();
  window.location.reload();
}

export function useRecovery() {
  const qc = useQueryClient();
  const generate = useMutation({
    mutationFn: () => api.recoveryGenerate(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); },
    onError: (err) => toastError(err, '生成恢复码失败，请重试'),
  });
  const claim = useMutation({
    mutationFn: (code: string) => api.recoveryClaim(code),
    onSuccess: () => resetLocal(),
    onError: (err) => toastError(err, '认领失败，请重试'),
  });
  const deleteAll = useMutation({
    mutationFn: () => api.deleteAll(),
    onSuccess: () => resetLocal(),
    onError: (err) => toastError(err, '删除失败，请重试'),
  });
  return {
    generate: () => generate.mutate(),
    generatedCode: generate.data?.code ?? null,
    clearCode: () => generate.reset(),
    isGenerating: generate.isPending,
    claim: (code: string) => claim.mutate(code),
    isClaiming: claim.isPending,
    deleteAll: () => deleteAll.mutate(),
    isDeleting: deleteAll.isPending,
  };
}