import { useEffect, useRef } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePlanSync } from '@/store/usePlanSync';
import type { PlanLayerSource } from '@/lib/calendarLayers';
import type { PlanState } from '@/shared/types';

// 所有非活动计划的块层；活动计划由 usePlanStore 提供，保证本地编辑立即生效。
export function usePlanLayers(activePlanId: string | null) {
  const list = useQuery({ queryKey: ['plans'], queryFn: () => api.plans(), retry: false });
  const plans = list.data?.items ?? [];
  const details = useQueries({
    queries: plans.map((p) => ({
      queryKey: ['plan', p.id],
      queryFn: () => api.plan(p.id) as Promise<PlanState>,
      staleTime: 15_000,
    })),
  });

  const layers: PlanLayerSource[] = [];
  plans.forEach((p, i) => {
    if (p.id === activePlanId) return;
    const state = details[i]?.data;
    if (state) layers.push({ id: p.id, title: state.plan.title, state });
  });

  const versionKey = layers.map((l) => `${l.id}:${l.state.plan.version}`).join('|');
  const layersRef = useRef(layers);
  layersRef.current = layers;
  useEffect(() => {
    for (const layer of layersRef.current) usePlanSync.getState().setServerVersion(layer.id, layer.state.plan.version);
  }, [versionKey]);

  return { plans, layers, isLoading: list.isLoading || details.some((d) => d.isLoading) };
}