import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getQuestionHistory } from '../goals/api';
import type { QuestionHistory as HistoryPage } from '../goals/question-history';
import { useTheme } from '../theme/ThemeProvider';
import { Action, AppText, Caption, Card } from './ui';

export function QuestionHistory({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const viewport = Math.min(width, 600);
  const [pages, setPages] = useState<HistoryPage[]>([]);
  const [page, setPage] = useState(0);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [height, setHeight] = useState(0);
  const scroll = useRef<ScrollView>(null);
  const busy = useRef(false);
  const shownPage = useRef(0);
  const intended = useRef<number | null>(null);
  const position = useRef<{ page: number; width: number; x: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const failedBefore = useRef<number | undefined>(undefined);
  const active = useRef(true);
  async function read(before?: number) {
    if (busy.current) return;
    busy.current = true;
    failedBefore.current = before;
    const request = new AbortController();
    controller.current = request;
    try {
      const result = await getQuestionHistory(goalId, before, request.signal);
      if (!active.current || controller.current !== request) return;
      shownPage.current = before === undefined ? 0 : shownPage.current + 1;
      intended.current = Math.max(0, result.cards.length - 1);
      setPages(previous => before === undefined ? [result] : [...previous, result]);
      setPage(previous => before === undefined ? 0 : previous + 1);
      setIndex(Math.max(0, result.cards.length - 1));
    } catch (cause) {
      if (active.current && controller.current === request) setError(cause instanceof Error ? cause.message : '回答历史未能读取。');
    } finally {
      if (controller.current === request) { busy.current = false; if (active.current) setLoading(false); }
    }
  }
  useEffect(() => {
    active.current = true;
    busy.current = true;
    const request = new AbortController();
    controller.current = request;
    getQuestionHistory(goalId, undefined, request.signal).then(result => {
      if (!active.current || controller.current !== request) return;
      shownPage.current = 0;
      intended.current = Math.max(0, result.cards.length - 1);
      setPages([result]);
      setIndex(Math.max(0, result.cards.length - 1));
    }).catch(cause => {
      if (active.current && controller.current === request) setError(cause instanceof Error ? cause.message : '回答历史未能读取。');
    }).finally(() => {
      if (controller.current === request) { busy.current = false; if (active.current) setLoading(false); }
    });
    return () => { active.current = false; request.abort(); busy.current = false; };
  }, [goalId]);
  const current = pages[page];
  function select(next: number) { intended.current = next; setIndex(next); scroll.current?.scrollTo({ x: next * viewport, animated: false }); }
  function earlier() {
    if (loading || !current) return;
    if (index > 0) { select(index - 1); return; }
    if (pages[page + 1]) { shownPage.current = page + 1; intended.current = pages[page + 1].cards.length - 1; setPage(page + 1); setIndex(pages[page + 1].cards.length - 1); }
    else if (current.next_before !== null) { setLoading(true); setError(''); void read(current.next_before); }
  }
  function newer() {
    if (loading || !current) return;
    if (index < current.cards.length - 1) select(index + 1);
    else if (page > 0) { shownPage.current = page - 1; intended.current = 0; setPage(page - 1); setIndex(0); }
  }
  function scrolled(x: number) {
    if (shownPage.current !== page || !current) return;
    position.current = { page, width: viewport, x };
    if (intended.current !== null) {
      if (Math.abs(x - intended.current * viewport) > 2) return;
      intended.current = null;
    }
    setIndex(Math.max(0, Math.min(current.cards.length - 1, Math.round(x / viewport))));
  }
  const wheelProps = Platform.OS === 'web' ? { onWheel: () => { intended.current = null; } } : {};
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, width: '100%', maxWidth: 600, alignSelf: 'center' }} edges={['top', 'bottom', 'left', 'right']}>
      <View style={{ padding: 20, flexDirection: 'row', alignItems: 'center' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭回答回看" onPress={onClose} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><AppText style={{ fontSize: 28 }}>‹</AppText></Pressable>
        <AppText accessibilityRole="header" style={{ flex: 1, fontSize: 22, fontWeight: '700' }}>我的回答</AppText>
      </View>
      {!!error && <View style={{ paddingHorizontal: 20, gap: 12 }}><AppText accessibilityRole="alert">{error}</AppText><Action label="重试读取回答" secondary disabled={loading} onPress={() => { setLoading(true); setError(''); void read(failedBefore.current); }} /></View>}
      {loading && <View style={{ padding: 20 }}><Caption>正在读取已保存的回答…</Caption></View>}
      {current?.cards.length ? <ScrollView key={`${page}:${viewport}`} ref={scroll} {...wheelProps} onTouchStart={() => { intended.current = null; }} horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ height: '100%' }}
        onLayout={e => setHeight(e.nativeEvent.layout.height)} onContentSizeChange={() => { if (shownPage.current === page) { intended.current = index === 0 || (position.current?.page === page && position.current.width === viewport && Math.abs(position.current.x - index * viewport) < 2) ? null : index; scroll.current?.scrollTo({ x: index * viewport, animated: false }); } }}
        onScrollBeginDrag={() => { intended.current = null; }} scrollEventThrottle={64} onScroll={e => scrolled(e.nativeEvent.contentOffset.x)}
        onMomentumScrollEnd={e => scrolled(e.nativeEvent.contentOffset.x)}>
        {current.cards.map(card => <View key={card.id} style={{ width: viewport, height: height || undefined, paddingHorizontal: 20, paddingBottom: 16 }}>
          <Card style={{ flex: 1, padding: 24 }}><ScrollView contentContainerStyle={{ gap: 24 }}>
            <Caption>问题与回答 · 左右滑动回看</Caption>
            <AppText style={{ fontSize: 24, lineHeight: 32, fontWeight: '600' }}>{card.question}</AppText>
            <View style={{ borderRadius: 16, backgroundColor: colors.subtle, padding: 16 }}><AppText>{card.answer ?? '这条问题尚未收到回答。'}</AppText></View>
          </ScrollView></Card>
        </View>)}
      </ScrollView> : !loading && !error ? <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}><AppText>还没有已保存的问题与回答。</AppText></View> : <View style={{ flex: 1 }} />}
      {!!current?.cards.length && <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 8 }}>
        <Caption>本页 {index + 1} / {current.cards.length} · 仅回看，不会重新提问</Caption>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Pressable accessibilityRole="button" accessibilityLabel="查看更早回答" disabled={loading || (index === 0 && current.next_before === null)} onPress={earlier} style={{ minHeight: 44, justifyContent: 'center', opacity: index === 0 && current.next_before === null ? 0.35 : 1 }}><AppText>← 更早</AppText></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="查看较新回答" disabled={loading || (page === 0 && index === current.cards.length - 1)} onPress={newer} style={{ minHeight: 44, justifyContent: 'center', opacity: page === 0 && index === current.cards.length - 1 ? 0.35 : 1 }}><AppText>较新 →</AppText></Pressable>
        </View>
      </View>}
    </SafeAreaView>
  </Modal>;
}
