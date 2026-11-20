/* 隔离演示：示例数据驱动周历，FLIP 位移只动 transform/opacity。 */
(function () {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const START = 7, END = 23, SPAN = END - START;
  const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const SENTENCE = '下周要交报告，工作日九点上班，周三晚上有课。';

  const work = () => [0, 1, 2, 3, 4].map((d) => ({ id: 'work' + d, d, s: 9, e: 18, t: 4, label: '上班', time: '09:00–18:00' }));
  const report = (d, s, e, n) => ({ id: 'rep' + n, d, s, e, t: 1, label: '写报告 ' + n + '/4', time: fmt(s) + '–' + fmt(e) });
  const fmt = (h) => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0');

  const SCENARIOS = {
    base: {
      chips: ['报告 · 分 4 段', '上班 09:00–18:00', '周五前交'],
      note: '四段报告都在下班后的晚上，周末空着。',
      blocks: () => [...work(), report(0, 19, 21, 1), report(1, 19, 21, 2), report(2, 19, 21, 3), report(3, 19, 21, 4), { id: 'submit', d: 4, s: 19, e: 20, t: 2, label: '检查提交', time: '19:00–20:00' }],
    },
    class: {
      chips: ['报告 · 分 4 段', '上班 09:00–18:00', '周三 19:00 有课', '周五前交'],
      note: '周三的课不可取消：那段报告挪到周六上午，其余不动。',
      blocks: () => [...work(), report(0, 19, 21, 1), report(1, 19, 21, 2), { id: 'class', d: 2, s: 19, e: 21, t: 3, label: '线上课程', time: '19:00–21:00' }, report(5, 10, 12, 3), report(3, 19, 21, 4), { id: 'submit', d: 4, s: 19, e: 20, t: 2, label: '检查提交', time: '19:00–20:00' }],
    },
    overtime: {
      chips: ['报告 · 分 4 段', '上班 09:00–18:00', '周四加班到 22:00', '周五前交'],
      note: '周四加班到十点：报告那段挪去周日上午，截止日仍赶得上。',
      blocks: () => [...work(), report(0, 19, 21, 1), report(1, 19, 21, 2), report(2, 19, 21, 3), { id: 'ot', d: 3, s: 19, e: 22, t: 3, label: '加班', time: '19:00–22:00' }, report(6, 10, 12, 4), { id: 'submit', d: 4, s: 19, e: 20, t: 2, label: '检查提交', time: '19:00–20:00' }],
    },
    weekend: {
      chips: ['报告 · 分 4 段', '周三 19:00 有课', '周末完全空出'],
      note: '周六那段也挪回周五晚上：周末整块留白，课和截止日都没动。',
      blocks: () => [...work(), report(0, 19, 21, 1), report(1, 19, 21, 2), { id: 'class', d: 2, s: 19, e: 21, t: 3, label: '线上课程', time: '19:00–21:00' }, report(3, 19, 21, 3), report(4, 21, 23, 4), { id: 'submit', d: 4, s: 12.5, e: 13.5, t: 2, label: '检查提交', time: '12:30–13:30' }],
    },
  };

  const daysEl = document.getElementById('calDays');
  const chipsEl = document.getElementById('chips');
  const noteEl = document.getElementById('stageNote');
  const sayEl = document.getElementById('sayText');
  const cols = DAYS.map((name) => {
    const col = document.createElement('div');
    col.className = 'cal-day';
    col.innerHTML = '<span>' + name + '</span>';
    daysEl.appendChild(col);
    return col;
  });
  const els = new Map();

  function place(el, b) {
    el.style.top = ((b.s - START) / SPAN * 100) + '%';
    el.style.height = ((b.e - b.s) / SPAN * 100) + '%';
  }
  function make(b) {
    const el = document.createElement('div');
    el.className = 'cal-block t' + b.t;
    el.innerHTML = b.label + '<small>' + b.time + '</small>';
    place(el, b);
    cols[b.d].appendChild(el);
    els.set(b.id, el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
    return el;
  }
  function apply(blocks, stagger) {
    const seen = new Set();
    blocks.forEach((b, i) => {
      seen.add(b.id);
      let el = els.get(b.id);
      if (!el) {
        el = make(b);
        if (stagger && !reduce) el.style.transitionDelay = (i * 55) + 'ms';
        setTimeout(() => { el.style.transitionDelay = ''; }, 900);
        return;
      }
      const old = el.getBoundingClientRect();
      place(el, b);
      if (reduce) return;
      const now = el.getBoundingClientRect();
      const dy = old.top - now.top;
      if (Math.abs(dy) < 1 && Math.abs(old.height - now.height) < 1) return;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + dy + 'px)';
      void el.offsetHeight;
      el.style.transition = '';
      el.style.transform = '';
      el.classList.add('on');
    });
    for (const [id, el] of [...els]) {
      if (seen.has(id)) continue;
      els.delete(id);
      el.classList.remove('on');
      setTimeout(() => el.remove(), reduce ? 0 : 420);
    }
  }
  function setChips(list) {
    chipsEl.innerHTML = '';
    list.forEach((c, i) => {
      const li = document.createElement('li');
      li.textContent = c;
      chipsEl.appendChild(li);
      setTimeout(() => li.classList.add('on'), reduce ? 0 : 240 + i * 140);
    });
  }
  function setScenario(key, replay) {
    const sc = SCENARIOS[key];
    document.querySelectorAll('[data-scenario]').forEach((b) => b.classList.toggle('is-on', b.dataset.scenario === key));
    setChips(sc.chips);
    noteEl.textContent = sc.note;
    apply(sc.blocks(), replay);
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    if (reduce) {
      sayEl.textContent = SENTENCE;
      setScenario('base', false);
      return;
    }
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      sayEl.textContent = SENTENCE.slice(0, i);
      if (i >= SENTENCE.length) {
        clearInterval(timer);
        setTimeout(() => setScenario('base', true), 260);
      }
    }, 42);
  }
  const stage = document.querySelector('.stage');
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { start(); io.disconnect(); }
    }, { threshold: 0.25 });
    io.observe(stage);
  } else {
    start();
  }
  document.querySelectorAll('[data-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => setScenario(btn.dataset.scenario, false));
  });
})();