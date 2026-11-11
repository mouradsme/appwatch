// Dependency-free SVG charts.
import { barClass, esc, fmtDay, fmtDuration, fmtMs, fmtPct, raw } from './ui.js';

/** Tiny response-time sparkline. points: [t, ok, ms][] oldest → newest */
export function sparkline(points, { width = 96, height = 28 } = {}) {
  if (!points?.length) return raw(`<svg class="spark" width="${width}" height="${height}"></svg>`);
  const vals = points.map((p) => (p[1] ? p[2] : null));
  const max = Math.max(1, ...vals.filter((v) => v != null));
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const y = (v) => height - 2 - (v / max) * (height - 6);
  let d = '';
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const fails = points
    .map((p, i) => (p[1] ? '' : `<circle cx="${(i * step).toFixed(1)}" cy="${height - 3}" r="2.4" fill="var(--down)"/>`))
    .join('');
  return raw(
    `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>${fails}</svg>`,
  );
}

/** Daily uptime bars. days: [{from, pct, down, count}] */
export function uptimeBars(days, { large = false } = {}) {
  const bars = days
    .map((d) => {
      const tip =
        d.pct == null
          ? `<b>${esc(fmtDay(d.from))}</b><br>No data`
          : `<b>${esc(fmtDay(d.from))}</b><br>Uptime <b>${fmtPct(d.pct)}</b>` +
            (d.count ? `<br>${d.count} incident${d.count > 1 ? 's' : ''} · ${esc(fmtDuration(d.down))} down` : '<br>No incidents');
      return `<i class="${barClass(d.pct)}" data-tip="${esc(tip)}"></i>`;
    })
    .join('');
  return raw(`<div class="bars${large ? ' lg' : ''}">${bars}</div>`);
}

function niceStep(range, ticks) {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/**
 * Response time chart with min–max band, average line, outage shading and a hover cursor.
 * data: { from, to, size, points: [{t, n, up, avg, min, max}] }
 */
export function responseChart(container, data) {
  const H = 260;
  const M = { l: 52, r: 14, t: 14, b: 28 };
  let tipEl;

  function draw() {
    const W = Math.max(280, container.clientWidth);
    const pw = W - M.l - M.r;
    const ph = H - M.t - M.b;
    const pts = data.points;
    if (!pts.length) {
      container.innerHTML = `<div class="empty" style="padding-top:90px">No checks recorded in this period yet.</div>`;
      return;
    }
    const maxV = Math.max(10, ...pts.map((p) => p.max ?? p.avg ?? 0));
    const step = niceStep(maxV * 1.1, 4);
    const yMax = Math.ceil((maxV * 1.1) / step) * step;
    const x = (t) => M.l + ((t - data.from) / (data.to - data.from)) * pw;
    const y = (v) => M.t + ph - (v / yMax) * ph;
    const bw = Math.max(1, (data.size / (data.to - data.from)) * pw);

    // grid + y axis
    let grid = '';
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      grid += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    }
    let yAxis = '';
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      yAxis += `<text x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? `${+(v / 1000).toFixed(1)}s` : `${v}ms`}</text>`;
    }
    // x axis
    const span = data.to - data.from;
    const fmt =
      span <= 36 * 3600_000
        ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
        : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    const ticks = Math.max(2, Math.min(7, Math.floor(pw / 110)));
    let xAxis = '';
    for (let i = 0; i <= ticks; i++) {
      const t = data.from + (span * i) / ticks;
      xAxis += `<text x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${esc(fmt.format(t))}</text>`;
    }

    // outage shading + failure ticks
    let fails = '';
    for (const p of pts) {
      if (p.up >= p.n) continue;
      const ratio = (p.n - p.up) / p.n;
      if (p.up === 0) fails += `<rect x="${x(p.t)}" y="${M.t}" width="${bw}" height="${ph}" fill="var(--down)" opacity="0.13"/>`;
      fails += `<rect class="fail" x="${x(p.t)}" y="${M.t + ph - 5}" width="${bw}" height="5" opacity="${0.35 + 0.65 * ratio}"/>`;
    }

    // band, area and line (broken where there is no successful data)
    let band = '';
    let line = '';
    let area = '';
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      const top = seg.map((p) => `${x(p.t + data.size / 2).toFixed(1)},${y(p.max).toFixed(1)}`);
      const bottom = seg.map((p) => `${x(p.t + data.size / 2).toFixed(1)},${y(p.min).toFixed(1)}`).reverse();
      band += `<polygon class="band" points="${[...top, ...bottom].join(' ')}"/>`;
      const l = seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t + data.size / 2).toFixed(1)},${y(p.avg).toFixed(1)}`).join('');
      line += `<path class="line" d="${l}"/>`;
      const first = x(seg[0].t + data.size / 2).toFixed(1);
      const last = x(seg[seg.length - 1].t + data.size / 2).toFixed(1);
      area += `<path class="area" d="${l}L${last},${y(0)}L${first},${y(0)}Z"/>`;
      seg = [];
    };
    // A gap much longer than the polling interval (e.g. monitor paused) breaks the line.
    const maxGap = 2.5 * Math.max(data.size, data.intervalMs ?? 0);
    let prevT = null;
    for (const p of pts) {
      if (p.avg == null) {
        flush();
        prevT = null;
        continue;
      }
      if (prevT != null && p.t - prevT > maxGap) flush();
      seg.push(p);
      prevT = p.t;
    }
    flush();

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Response time chart">
        <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="var(--accent)" stop-opacity="0.22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient></defs>
        <g class="grid">${grid}</g>
        ${fails}${area}${band}${line}
        <g class="axis">${yAxis}${xAxis}</g>
        <line class="cursor" x1="0" x2="0" y1="${M.t}" y2="${M.t + ph}" visibility="hidden"/>
        <circle class="cursor-dot" r="4" cx="0" cy="0" visibility="hidden"/>
        <rect x="${M.l}" y="${M.t}" width="${pw}" height="${ph}" fill="transparent" class="hit"/>
      </svg>`;

    const svg = container.querySelector('svg');
    const cursor = svg.querySelector('.cursor');
    const dot = svg.querySelector('.cursor-dot');
    const hit = svg.querySelector('.hit');
    const hide = () => {
      cursor.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tipEl?.remove();
      tipEl = null;
    };
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * W;
      const t = data.from + ((sx - M.l) / pw) * span;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t + data.size / 2 - t) < Math.abs(best.t + data.size / 2 - t)) best = p;
      const cx = x(best.t + data.size / 2);
      cursor.setAttribute('x1', cx);
      cursor.setAttribute('x2', cx);
      cursor.setAttribute('visibility', 'visible');
      if (best.avg != null) {
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', y(best.avg));
        dot.setAttribute('visibility', 'visible');
      } else dot.setAttribute('visibility', 'hidden');
      if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.className = 'chart-tip';
        container.append(tipEl);
      }
      const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(best.t);
      const failed = best.n - best.up;
      tipEl.innerHTML = `<div class="faint">${esc(when)}</div>
        ${best.avg != null ? `Avg <b>${fmtMs(best.avg)}</b> · min ${fmtMs(best.min)} · max ${fmtMs(best.max)}<br>` : ''}
        ${best.n} check${best.n > 1 ? 's' : ''}${failed ? ` · <span class="c-down">${failed} failed</span>` : ''}`;
      const left = (cx / W) * rect.width;
      tipEl.style.left = `${Math.min(rect.width - 90, Math.max(90, left))}px`;
      tipEl.style.top = `${((best.avg != null ? y(best.avg) : M.t + ph / 2) / H) * rect.height}px`;
    });
  }

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
  return () => {
    ro.disconnect();
    tipEl?.remove();
  };
}
