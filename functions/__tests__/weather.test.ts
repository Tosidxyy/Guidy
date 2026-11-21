import { afterEach, describe, expect, it, vi } from 'vitest';
import { weather } from '../qca/openai';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    for (const [prefix, body] of Object.entries(routes)) {
      if (String(url).startsWith(prefix)) return { ok: true, json: async () => body } as Response;
    }
    return { ok: false, status: 500 } as Response;
  }));
}

describe('Weather 工具（Open-Meteo）', () => {
  it('返回实时与逐日高低温度，中文天气描述', async () => {
    stubFetch({
      'https://geocoding-api.open-meteo.com/': { results: [{ name: '武汉', latitude: 30.59, longitude: 114.3, country: '中国' }] },
      'https://api.open-meteo.com/': {
        current: { temperature_2m: 18, apparent_temperature: 17, relative_humidity_2m: 60, weather_code: 2, wind_speed_10m: 12, time: '2026-11-21T10:00' },
        daily: { time: ['2026-11-21', '2026-11-22'], temperature_2m_max: [20, 22], temperature_2m_min: [9, 11], weather_code: [2, 61], precipitation_probability_max: [10, 70] },
      },
    });
    const r = JSON.parse(await weather('武汉', 2));
    expect(r.city).toBe('武汉');
    expect(r.current.temp_c).toBe(18);
    expect(r.current.weather).toBe('局部多云');
    expect(r.daily).toHaveLength(2);
    expect(r.daily[1]).toMatchObject({ max_c: 22, min_c: 11, weather: '小雨', precip_prob_pct: 70 });
  });
  it('城市不存在：明确报错不编造', async () => {
    stubFetch({ 'https://geocoding-api.open-meteo.com/': { results: [] } });
    const r = JSON.parse(await weather('不存在的地方', 3));
    expect(r.error).toBe('city_not_found');
  });
  it('服务不可用：返回 weather_unavailable 并提示不要编造', async () => {
    stubFetch({});
    const r = JSON.parse(await weather('武汉', 3));
    expect(r.error).toBe('weather_unavailable');
    expect(r.note).toContain('不要编造');
  });
});
