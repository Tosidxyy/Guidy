import type { PlanState } from '@/shared/types';

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let budget = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (size > budget) {
      parts.push(current);
      current = ' ' + ch;
      budget = 74 - size;
    } else {
      current += ch;
      budget -= size;
    }
  }
  parts.push(current);
  return parts.join('\r\n');
}

function utcBasic(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function buildIcs(state: PlanState, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Guidy//Guidy Scheduler//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(state.plan.title || 'plan')}`,
  ];
  const stamp = utcBasic(now.toISOString());
  for (const b of state.blocks) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:guidy-${b.id}@guidy`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utcBasic(b.start_utc)}`,
      `DTEND:${utcBasic(b.end_utc)}`,
      `SUMMARY:${escapeText(b.title)}`,
      `CATEGORIES:${b.category}`,
    );
    if (b.notes) lines.push(`DESCRIPTION:${escapeText(b.notes)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function icsFileName(title: string): string {
  const cleaned = title.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').trim();
  return `guidy-${cleaned || 'plan'}.ics`;
}