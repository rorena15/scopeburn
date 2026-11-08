import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const template = readFileSync(new URL('../src/report/template.html', import.meta.url), 'utf8');

// Run the real template script with a small DOM substitute, without browser layout.
function dashboard() {
  let document: any;
  class Element {
    tagName: string;
    children: Element[] = [];
    parentElement: Element | null = null;
    attrs: Record<string, string> = {};
    dataset: Record<string, string> = {};
    style: any = { setProperty() {} };
    events: Record<string, { fn: Function; options: any }[]> = {};
    value = '';
    get id() { return this.attrs.id || ''; }
    set id(value: string) { this.attrs.id = value; }
    scrollTop = 0;
    scrollLeft = 0;
    clientWidth = 640;
    offsetWidth = 100;
    offsetHeight = 30;
    private text = '';
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    get className() { return this.attrs.class || ''; }
    set className(value: string) { this.attrs.class = value; }
    classList = {
      toggle: (name: string, force?: boolean) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        const on = force ?? !names.has(name);
        if (on) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
      remove: (name: string) => this.classList.toggle(name, false),
      add: (name: string) => this.classList.toggle(name, true),
    };
    get textContent(): string { return this.text + this.children.map(n => n.textContent).join(''); }
    set textContent(value: string) { this.text = String(value); this.children = []; }
    setAttribute(key: string, value: any) {
      this.attrs[key] = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (key === 'value') this.value = String(value);
    }
    getAttribute(key: string) { return this.attrs[key] ?? null; }
    append(...nodes: (Element | string)[]) {
      for (const value of nodes) {
        const n = typeof value === 'string' ? new Element('#text') : value;
        if (typeof value === 'string') n.textContent = value;
        if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(c => c !== n);
        n.parentElement = this; this.children.push(n);
      }
    }
    prepend(...nodes: Element[]) { for (const n of nodes.reverse()) { n.parentElement = this; this.children.unshift(n); } }
    replaceChildren(...nodes: (Element | string)[]) { this.text = ''; this.children = []; this.append(...nodes); }
    addEventListener(type: string, fn: Function, options?: any) { (this.events[type] ??= []).push({ fn, options }); }
    fire(type: string, props: any = {}) {
      const event = { target: this, preventDefault() {}, stopPropagation() {}, ...props };
      for (const { fn } of this.events[type] || []) fn(event);
      (this as any)['on' + type]?.(event);
    }
    matches(selector: string): boolean {
      const parts = selector.trim().split(/\s+/);
      const last = parts.pop()!;
      const attr = last.match(/\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
      const tag = last.match(/^[\w-]+/)?.[0];
      const id = last.match(/#([\w-]+)/)?.[1];
      const cls = last.match(/\.([\w-]+)/)?.[1];
      if (tag && this.tagName !== tag.toUpperCase() || id && this.attrs.id !== id || cls && !this.className.split(' ').includes(cls)) return false;
      if (attr && (!(attr[1] in this.attrs) || attr[2] !== undefined && this.attrs[attr[1]] !== attr[2])) return false;
      if (!parts.length) return true;
      for (let n = this.parentElement; n; n = n.parentElement) if (n.matches(parts.join(' '))) return true;
      return false;
    }
    querySelectorAll(selector: string): Element[] {
      const all = this.children.flatMap(n => [n, ...n.querySelectorAll('*')]);
      return selector === '*' ? all : all.filter(n => selector.split(',').some(s => n.matches(s)));
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector: string): Element | null { return selector.split(',').some(s => this.matches(s)) ? this : this.parentElement?.closest(selector) || null; }
    focus(_options?: any) { document.activeElement = this; }
    getBoundingClientRect() { return { top: 10, left: 10, right: 100, bottom: 30 }; }
    scrollIntoView() { (this as any).scrolled = true; }
  }
  const root = new Element('html');
  const ids: Record<string, Element> = {};
  for (const match of template.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const n = new Element(match[1]);
    n.setAttribute('id', match[2]);
    const cls = match[0].match(/class="([^"]+)"/);
    if (cls) n.className = cls[1];
    ids[match[2]] = n;
    root.append(n);
  }
  ids.main.append(ids.content);
  ids.content.append(ids.detail, ids.statusTable);
  const day = (offset: number) => {
    const d = new Date(); d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const item = { key: 'A', title: 'Alpha', status: 'open', ageDays: 20, leadDays: null, size: 'M', points: 2, usd: 0 };
  const project = (name: string) => ({ name, scope: 2, done: 0, growthRatio: null, scopeAdded14d: 0, done14d: 0, usdPerPoint: null, spend: { total: 0, outside: 0 }, items: [{ ...item }], burnup: [], doneMix: { planned: 0, reactive: 0, windowDays: 30 } });
  const data = { config: {}, generatedAt: 0, dims: { projects: ['one', 'two'], models: ['model'] }, daily: [[day(-2), 0, 0, 0, 2, 20], [day(0), 1, 0, 0, 4, 40]], projects: [project('one'), project('two')], limits: { five: null, week: null, samples: 0 }, prices: { source: 'test', checked: '', unpriced: [] } };
  ids.data.textContent = JSON.stringify(data);
  document = {
    documentElement: root, activeElement: null,
    getElementById: (id: string) => ids[id] || root.querySelector('#' + id),
    querySelector: (s: string) => root.querySelector(s), querySelectorAll: (s: string) => root.querySelectorAll(s),
    createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (s: string) => { const n = new Element('#text'); n.textContent = s; return n; },
    events: {} as any,
    addEventListener(type: string, fn: Function, options?: any) { (this.events[type] ??= []).push({ fn, options }); },
  };
  const code = template.match(/<script>([\s\S]*?)<\/script>/)![1].replace(/\}\)\(\);\s*$/, 'globalThis.api = { st, DATA, windowCard, selectProject, filteredRows, renderKpis, renderDaily, renderDay, itemsTable, showTip, hideTip, update, go, renderAttention }; })();');
  const context: any = { document, Node: Element, location: { protocol: 'file:', hash: '' }, navigator: { language: 'en' }, history: { replaceState() {} }, URLSearchParams, innerWidth: 1000, innerHeight: 800, ResizeObserver: class { observe() {} }, addEventListener() {}, localStorage: { getItem() { return null; } }, setTimeout, clearTimeout, getComputedStyle: () => ({ getPropertyValue: () => '#000' }) };
  runInNewContext(code, context);
  return { ...context.api, ids, document, root, day };
}

test('uncalibrated windows hide meters and cap predictions in both languages', () => {
  const d = dashboard();
  const w = { spent: 2, cap: null, reportedPct: null, end: Date.now() + 3600000, burnPerHour: 1, hitsCapAt: null };
  for (const [lang, badge] of [['en', 'cap not calibrated'], ['ko', '한도 미보정']]) {
    d.st.lang = lang;
    for (const compact of [false, true]) {
      const card = d.windowCard('fiveHour', w, compact);
      assert.equal(card.querySelector('.meter'), null);
      assert.ok(card.textContent.includes(badge));
      assert.ok(!card.textContent.includes(lang === 'en' ? 'stays under the cap' : '한도 안'));
    }
  }
  d.st.lang = 'en';
  const calibrated = d.windowCard('fiveHour', { ...w, cap: { median: 10 } });
  assert.equal(calibrated.querySelector('[role=meter]').getAttribute('aria-valuenow'), '20');
  assert.ok(calibrated.textContent.includes('stays under the cap'));
  assert.ok(!d.windowCard('fiveHour', { ...w, cap: { median: 10 }, burnPerHour: 0 }).textContent.includes('stays under the cap'));
  assert.equal(d.windowCard('fiveHour', { ...w, reportedPct: 25 }).querySelector('.meter'), null);
});

test('project navigation preserves global filters and uses selected project spend', () => {
  const d = dashboard();
  d.st.project = 'two';
  d.selectProject('one');
  assert.equal(d.st.project, 'two');
  assert.equal(d.st.sel, 'one');
  assert.ok(d.ids.projectMeta.textContent.includes('$2.00'));
  assert.equal(d.ids.projectFilter.disabled, true);
  d.go('overview');
  assert.equal(d.st.project, 'two');
  assert.equal(d.filteredRows().length, 1);
  assert.equal(d.filteredRows()[0][1], 1);
  assert.equal(d.ids.projectFilter.disabled, false);
});

test('successive touch points and mouse movement update the pinned tooltip', () => {
  const d = dashboard();
  const chart = d.ids.dailyChart;
  for (const value of ['first', 'second']) {
    for (const listener of d.document.events.pointerdown) {
      assert.equal(listener.options.capture, true);
      listener.fn({ pointerType: 'touch', target: chart });
    }
    d.showTip({ clientX: 10, clientY: 10 }, () => [d.document.createTextNode(value)]);
    for (const listener of d.document.events.pointerup) listener.fn({ pointerType: 'touch', target: chart });
    d.hideTip();
    assert.equal(d.ids.tip.style.display, 'block');
    assert.equal(d.ids.tip.textContent, value);
  }
  d.showTip({ clientX: 20, clientY: 20 }, () => [d.document.createTextNode('mouse')]);
  assert.equal(d.ids.tip.textContent, 'mouse');
  for (const listener of d.document.events.pointerdown) listener.fn({ pointerType: 'touch', target: d.ids.main });
  assert.equal(d.ids.tip.style.display, 'none');
});

test('KPI sparkline includes zero days and a lone recorded day', () => {
  const d = dashboard(); d.st.period = 7;
  d.renderKpis([d.DATA.daily[0]]);
  const points = d.ids.tiles.querySelector('polyline').getAttribute('points').split(' ').map((p: string) => p.split(',').map(Number));
  assert.equal(points.length, 7);
  assert.equal(points.filter((p: number[]) => p[1] === 30).length, 6);
  assert.equal(points[4][1], 2);
  d.renderKpis([]);
  assert.equal(d.ids.tiles.querySelector('polyline').getAttribute('points').split(' ').length, 7);
});

test('item lead and age stay separate; local updates preserve wrapper, search and focus', () => {
  const d = dashboard();
  const section = d.itemsTable(d.DATA.projects[0]); d.ids.detail.replaceChildren(section);
  const wrap = section.querySelector('.table-wrap'); wrap.scrollLeft = 90;
  let row = section.querySelector('tr.item');
  assert.equal(row.children[5].textContent, '—');
  assert.equal(row.children[6].textContent, '20');
  row.focus(); row.fire('keydown', { key: 'Enter' });
  row = section.querySelector('tr.item');
  assert.equal(d.document.activeElement, row);
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(section.querySelector('.table-wrap'), wrap);
  assert.equal(wrap.scrollLeft, 90);
  const sort = section.querySelector('[data-focus="item-sort-lead"]'); sort.focus(); sort.fire('click');
  assert.equal(d.document.activeElement, sort);
  const search = section.querySelector('input'); search.focus(); search.value = 'missing'; search.fire('input');
  assert.equal(section.querySelector('tr.item'), null);
  assert.equal(d.document.activeElement, search);
  assert.equal(d.ids.detail.children[0], section);
});

test('daily chart and table are built exclusively and day detail controls split layout', () => {
  const d = dashboard();
  d.renderDaily(d.DATA.daily);
  assert.equal(d.ids.dailyTable.children.length, 0);
  assert.ok(d.ids.dailyChart.querySelector('svg'));
  d.st.dailyTable = true; d.renderDaily(d.DATA.daily);
  assert.equal(d.ids.dailyChart.children.length, 0);
  assert.ok(d.ids.dailyTable.querySelector('table'));
  d.renderDay(d.DATA.daily);
  assert.ok(!d.ids.dailySplit.className.includes('split'));
  assert.ok(d.ids.dayDetail.className.includes('hidden'));
  d.st.day = d.day(0); d.renderDay(d.DATA.daily);
  assert.ok(d.ids.dailySplit.className.includes('split'));
});

test('full updates restore item table scroll and project sort focus; attention opens its row', () => {
  const d = dashboard();
  d.selectProject('one');
  d.ids.detail.querySelector('.table-wrap').scrollLeft = 125;
  d.update();
  assert.equal(d.ids.detail.querySelector('.table-wrap').scrollLeft, 125);
  d.go('overview');
  const sort = d.ids.statusTable.querySelector('[data-focus="project-sort-done"]');
  sort.focus(); sort.fire('click');
  assert.equal(d.document.activeElement.getAttribute('data-focus'), 'project-sort-done');
  assert.equal(d.ids.statusTable.querySelector('tr').getAttribute('role'), null);
  assert.ok(d.ids.statusTable.querySelector('tbody button'));
  d.st.q = 'missing';
  d.ids.attention.querySelector('button').fire('click');
  const row = d.ids.detail.querySelector('tr.item');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(row.scrolled, true);
});
