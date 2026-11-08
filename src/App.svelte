<script>
  import { onMount } from 'svelte';
  import { makeText } from './sentences.js';

  const LENGTHS = [
    { id: 'short', label: 'Short', parts: 1 },
    { id: 'medium', label: 'Medium', parts: 2 },
    { id: 'long', label: 'Long', parts: 4 }
  ];

  // localStorage can be unavailable (private mode, blocked storage) — never let it break the test.
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('ticker:' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('ticker:' + key, JSON.stringify(value));
      } catch {}
    }
  };

  // ---- state -------------------------------------------------------------
  let length = $state(store.get('length', 'medium'));
  if (!LENGTHS.some((l) => l.id === length)) length = 'medium';

  let text = $state('');
  let status = $state([]); // per character: 0 pending · 1 correct · 2 wrong
  let pos = $state(0);
  let phase = $state('idle'); // idle | running | done
  let elapsed = $state(0); // ms
  let typedKeys = $state(0); // every character key pressed
  let correctKeys = $state(0); // keys that matched when pressed
  let netCorrect = $state(0); // characters currently correct on the tape
  let samples = $state([]); // { t, wpm, err } once per second
  let typing = $state(false);
  let best = $state(store.get('best', {}));
  let newBest = $state(false);
  let cw = $state(0); // measured character advance in px; the tape slides by pos * cw

  // Hot-path bookkeeping that the UI never reads directly.
  let startAt = 0;
  let raf = 0;
  let idleTimer = 0;
  let secErrors = 0;
  let slips = new Uint8Array(0); // characters that were ever mistyped
  let sink; // hidden input that summons the on-screen keyboard on touch devices
  let ruler; // ten zeros in the tape font, re-measured when the font loads or resizes
  let composed = ''; // text an Android-style keyboard has composed so far in the sink

  // ---- derived -----------------------------------------------------------
  // Each character's 5-bit hole pattern, like a teleprinter code column.
  const cells = $derived(
    text.split('').map((ch) => {
      const code = ch.charCodeAt(0) & 31;
      return { ch, bits: [0, 1, 2, 3, 4].map((k) => (code >> k) & 1) };
    })
  );

  const showRate = $derived(phase === 'done' || elapsed >= 1000);
  const wpm = $derived(showRate ? Math.round(netCorrect / 5 / (elapsed / 60000)) : 0);
  const raw = $derived(showRate ? Math.round(typedKeys / 5 / (elapsed / 60000)) : 0);
  const accuracy = $derived(typedKeys === 0 ? 100 : Math.round((correctKeys / typedKeys) * 100));
  const seconds = $derived((elapsed / 1000).toFixed(1));

  const words = $derived.by(() => {
    if (phase !== 'done') return [];
    const out = [];
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || text[i] === ' ') {
        if (i > start) {
          let right = true;
          let slipped = false;
          for (let j = start; j < i; j++) {
            if (status[j] !== 1) right = false;
            if (slips[j]) slipped = true;
          }
          out.push({ word: text.slice(start, i).replace(/[.,!?;:]+$/, ''), right, slipped });
        }
        start = i + 1;
      }
    }
    return out;
  });
  const wordsRight = $derived(words.filter((w) => w.right).length);
  const trouble = $derived([...new Set(words.filter((w) => w.slipped).map((w) => w.word))]);

  const chart = $derived.by(() => {
    if (phase !== 'done' || samples.length < 2) return null;
    const W = 600;
    const H = 120;
    const top = Math.max(...samples.map((s) => s.wpm));
    const max = Math.max(40, Math.ceil(top / 20) * 20);
    const t0 = samples[0].t;
    const span = samples[samples.length - 1].t - t0 || 1;
    const x = (t) => ((t - t0) / span) * W;
    const y = (v) => H - (v / max) * (H - 6);
    const line = samples.map((s) => `${x(s.t).toFixed(1)},${y(s.wpm).toFixed(1)}`).join(' ');
    return {
      W,
      H,
      max,
      line,
      area: `0,${H} ${line} ${W},${H}`,
      errors: samples.filter((s) => s.err > 0).map((s) => x(s.t)),
      from: (t0 / 1000).toFixed(0),
      to: (samples[samples.length - 1].t / 1000).toFixed(1)
    };
  });

  // ---- test lifecycle ----------------------------------------------------
  function reset(newText = true) {
    cancelAnimationFrame(raf);
    if (newText) {
      const parts = LENGTHS.find((l) => l.id === length).parts;
      text = makeText(parts, text);
    }
    status = new Array(text.length).fill(0);
    slips = new Uint8Array(text.length);
    pos = 0;
    phase = 'idle';
    elapsed = 0;
    typedKeys = 0;
    correctKeys = 0;
    netCorrect = 0;
    samples = [];
    composed = '';
    if (sink) sink.value = '';
    secErrors = 0;
    newBest = false;
    typing = false;
  }

  function start() {
    phase = 'running';
    startAt = performance.now();
    raf = requestAnimationFrame(tickFrame);
  }

  // Display clock only. Sampling also happens on every keystroke, so the chart
  // stays correct even when frames are throttled (background tab, slow device).
  function tickFrame(now) {
    catchUp(now);
    raf = requestAnimationFrame(tickFrame);
  }

  function catchUp(now) {
    elapsed = now - startAt;
    const whole = Math.floor(elapsed / 1000);
    while (samples.length < whole) pushSample((samples.length + 1) * 1000);
  }

  function pushSample(t) {
    samples.push({ t, wpm: netCorrect / 5 / (t / 60000), err: secErrors });
    secErrors = 0;
  }

  function finish() {
    cancelAnimationFrame(raf);
    catchUp(performance.now());
    if (samples.length === 0 || elapsed - samples.length * 1000 > 250) pushSample(elapsed);
    phase = 'done';
    typing = false;

    const final = Math.round(netCorrect / 5 / (elapsed / 60000));
    if (final > (best[length] ?? 0)) {
      newBest = true;
      best = { ...best, [length]: final };
      store.set('best', best);
    }
  }

  // ---- editing -----------------------------------------------------------
  function type(ch) {
    if (phase === 'done' || pos >= text.length) return;
    if (phase === 'idle') start();
    else catchUp(performance.now());

    const ok = ch === text[pos];
    status[pos] = ok ? 1 : 2;
    typedKeys++;
    if (ok) {
      correctKeys++;
      netCorrect++;
    } else {
      slips[pos] = 1;
      secErrors++;
    }
    pos++;
    poke();
    if (pos === text.length) finish();
  }

  function back() {
    if (pos === 0 || phase === 'done') return;
    pos--;
    if (status[pos] === 1) netCorrect--;
    status[pos] = 0;
    poke();
  }

  function backWord() {
    while (pos > 0 && text[pos - 1] === ' ') back();
    while (pos > 0 && text[pos - 1] !== ' ') back();
  }

  function poke() {
    typing = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (typing = false), 650);
  }

  // ---- input -------------------------------------------------------------
  function onKey(e) {
    if (e.isComposing) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      reset();
      return;
    }

    // Let focused buttons and Tab navigation behave normally.
    const onControl = e.target instanceof Element && e.target.closest('button, a');
    if (e.key === 'Tab' || (onControl && (e.key === 'Enter' || e.key === ' '))) return;

    if (phase === 'done') {
      if (e.key === 'Enter') {
        e.preventDefault();
        reset();
      }
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      if (e.ctrlKey || e.altKey || e.metaKey) backWord();
      else back();
      return;
    }

    // Single printable characters only. Ctrl+Alt is AltGr on many layouts, so allow it.
    if (e.key.length !== 1 || e.metaKey || (e.ctrlKey && !e.altKey)) return;
    e.preventDefault();
    type(e.key);
  }

  // Touch keyboards often report keydown as "Unidentified"; read the text from beforeinput instead.
  function onBeforeInput(e) {
    // Composition (Gboard and other predictive keyboards) can't be cancelled; onInput diffs it.
    if (e.inputType === 'insertCompositionText') return;
    e.preventDefault();
    if (e.inputType === 'deleteContentBackward') back();
    else if (e.inputType === 'deleteWordBackward') backWord();
    else if (e.data) for (const ch of e.data) type(ch);
  }

  // Only reached for composed text: apply the difference between the old and new composition.
  function onInput() {
    const next = sink.value;
    let same = 0;
    while (same < next.length && same < composed.length && next[same] === composed[same]) same++;
    for (let i = composed.length; i > same; i--) back();
    for (const ch of next.slice(same)) type(ch);
    composed = next;
  }

  function endComposition() {
    composed = '';
    sink.value = '';
  }

  function focusSink() {
    sink?.focus({ preventScroll: true });
  }

  function chooseLength(id) {
    length = id;
    store.set('length', id);
    reset();
    focusSink();
  }

  function next() {
    reset();
    focusSink();
  }

  function retry() {
    reset(false);
    focusSink();
  }

  onMount(() => {
    reset();
    focusSink();
    const measure = () => (cw = ruler.getBoundingClientRect().width / 10);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ruler);
    document.fonts?.ready.then(measure);
    window.addEventListener('keydown', onKey);
    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      clearTimeout(idleTimer);
    };
  });
</script>

<div class="page">
  <header class="bar">
    <span class="mark">ticker</span>
    <div class="lengths" role="group" aria-label="Sentence length">
      {#each LENGTHS as l (l.id)}
        <button
          type="button"
          aria-pressed={length === l.id}
          onclick={() => chooseLength(l.id)}>{l.label}</button>
      {/each}
    </div>
  </header>

  <main>
    <p class="sr-only">Type this: {text}</p>

    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="band" class:done={phase === 'done'} onclick={focusSink} aria-hidden="true">
      <span class="ruler" bind:this={ruler}>0000000000</span>
      <div class="track" style:transform={`translate3d(${-pos * cw}px,0,0)`}>
        {#each cells as cell, i}
          <span
            class="c"
            class:ok={status[i] === 1}
            class:bad={status[i] === 2}
            class:sp={cell.ch === ' '}>
            <span class="holes">
              <i class:on={cell.bits[0]}></i><i class:on={cell.bits[1]}></i><b></b><i
                class:on={cell.bits[2]}></i><i class:on={cell.bits[3]}></i><i class:on={cell.bits[4]}></i>
            </span>
            <span class="g">{cell.ch}</span>
          </span>
        {/each}
      </div>
      {#if phase !== 'done'}
        <span class="head" class:typing></span>
      {/if}
    </div>

    <input
      bind:this={sink}
      class="sink"
      type="text"
      aria-label="Typing input"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      onbeforeinput={onBeforeInput}
      oninput={onInput}
      oncompositionend={endComposition} />

    {#if phase === 'done'}
      <section class="results" aria-live="polite">
        <div class="score">
          <span class="big">{wpm}</span>
          <span class="unit">
            words per minute
            {#if newBest}<span class="best">New best for {length}</span>{/if}
          </span>
        </div>

        <dl class="facts">
          <div><dt>Accuracy</dt><dd>{accuracy}%</dd></div>
          <div><dt>Raw speed</dt><dd>{raw} wpm</dd></div>
          <div><dt>Words right</dt><dd>{wordsRight} of {words.length}</dd></div>
          <div><dt>Time</dt><dd>{seconds}s</dd></div>
          <div><dt>Your best</dt><dd>{best[length] ?? wpm} wpm</dd></div>
        </dl>

        {#if chart}
          <figure class="chart">
            <span class="ymax">{chart.max} wpm</span>
            <svg
              viewBox="0 0 {chart.W} {chart.H}"
              preserveAspectRatio="none"
              role="img"
              aria-label="Speed over time, ending at {wpm} words per minute">
              <line class="grid" x1="0" x2={chart.W} y1={chart.H / 2} y2={chart.H / 2} />
              {#each chart.errors as ex}
                <line class="err" x1={ex} x2={ex} y1="0" y2={chart.H} />
              {/each}
              <polygon class="area" points={chart.area} />
              <polyline class="line" points={chart.line} />
            </svg>
            <figcaption>
              <span>{chart.from}s</span>
              <span class="key"><i class="k-line"></i>speed <i class="k-err"></i>mistakes</span>
              <span>{chart.to}s</span>
            </figcaption>
          </figure>
        {/if}

        {#if trouble.length}
          <p class="trouble">
            <span>You slipped on</span>
            {#each trouble as w}<span class="chip">{w}</span>{/each}
          </p>
        {/if}

        <div class="actions">
          <button type="button" class="primary" onclick={next}>Next sentence</button>
          <button type="button" class="ghost" onclick={retry}>Try this one again</button>
        </div>
      </section>
    {:else}
      <div class="live" class:idle={phase === 'idle'}>
        <div class="stat"><span class="num">{showRate ? wpm : '–'}</span><span class="lbl">wpm</span></div>
        <div class="stat"><span class="num">{accuracy}%</span><span class="lbl">accuracy</span></div>
        <div class="stat"><span class="num">{seconds}</span><span class="lbl">seconds</span></div>
      </div>
    {/if}
  </main>

  <footer class="hint">
    {#if phase === 'idle'}
      Tap the tape and start typing. The clock starts on your first key.
      <button type="button" class="link" onclick={next}>New sentence <kbd>Esc</kbd></button>
    {:else if phase === 'running'}
      <kbd>Backspace</kbd> fixes a mistake.
      <button type="button" class="link" onclick={next}>Start over <kbd>Esc</kbd></button>
    {:else}
      Press <kbd>Enter</kbd> for the next sentence.
    {/if}
  </footer>
</div>

<style>
  .page {
    min-height: 100%;
    display: grid;
    grid-template-rows: auto 1fr auto;
  }

  /* ---- header ---- */
  .bar {
    width: min(1040px, 100%);
    margin: 0 auto;
    padding-block: 22px;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .mark {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.03em;
    font-variation-settings: 'opsz' 96;
  }

  .lengths {
    display: flex;
    padding: 3px;
    border-radius: 999px;
    background: var(--tape);
    border: 1px solid var(--tape-edge);
  }

  .lengths button {
    border: 0;
    background: none;
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 15px;
    color: var(--muted);
    cursor: pointer;
  }

  .lengths button:hover {
    color: var(--ink);
  }

  .lengths button[aria-pressed='true'] {
    background: var(--ink);
    color: var(--tape);
  }

  /* ---- tape ---- */
  main {
    align-self: center;
    padding-bottom: 6vh;
  }

  .band {
    --anchor: 36%;
    position: relative;
    height: 132px;
    overflow: hidden;
    background: var(--tape);
    border-block: 1px solid var(--tape-edge);
    font-family: var(--mono);
    font-size: clamp(26px, 4vw, 42px);
    cursor: text;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
    mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
  }

  .track {
    position: absolute;
    inset-block: 0;
    left: var(--anchor);
    display: flex;
    white-space: pre;
    will-change: transform;
    transition: transform 110ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .ruler {
    position: absolute;
    visibility: hidden;
    white-space: pre;
  }

  .c {
    width: 1ch;
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 16px 0 22px;
    color: var(--pending);
  }

  .holes {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }

  .holes i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    transform: scale(0);
    transition: transform 120ms cubic-bezier(0.3, 1.6, 0.5, 1);
  }

  /* sprocket feed hole: present on every column, so the tape has texture before you type */
  .holes b {
    width: 4px;
    height: 4px;
    margin: 1.5px 0;
    border-radius: 50%;
    background: var(--feed);
  }

  .c.ok {
    color: var(--ink);
  }

  .c.ok .holes i.on {
    transform: scale(1);
  }

  /* a mistake punches every hole: the old paper-tape "rubout" */
  .c.bad {
    color: var(--error);
  }

  .c.bad .holes i {
    transform: scale(1);
    background: var(--error);
  }

  .c.bad .g {
    background: var(--error-soft);
    border-radius: 3px;
  }

  .g {
    line-height: 1;
    display: block;
    width: 100%;
    text-align: center;
  }

  .head {
    position: absolute;
    inset-block: 0;
    left: var(--anchor);
    width: 1ch;
    background: var(--accent-soft);
    pointer-events: none;
  }

  .head::after {
    content: '';
    position: absolute;
    left: 3px;
    right: 3px;
    bottom: 12px;
    height: 3px;
    border-radius: 2px;
    background: var(--accent);
    animation: blink 1.05s steps(1) infinite;
  }

  .head.typing::after {
    animation: none;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  .sink {
    position: fixed;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    border: 0;
    padding: 0;
    font-size: 16px; /* below 16px, iOS zooms the page when the input gets focus */
    pointer-events: none;
  }

  /* ---- live stats ---- */
  .live {
    width: min(1040px, 100%);
    margin: 28px auto 0;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
    display: flex;
    justify-content: center;
    gap: clamp(28px, 7vw, 72px);
    transition: opacity 200ms;
  }

  .live.idle {
    opacity: 0.55;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .num {
    font-size: 34px;
    font-weight: 600;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .lbl {
    font-size: 14px;
    color: var(--muted);
  }

  /* ---- results ---- */
  .results {
    width: min(760px, 100%);
    margin: 32px auto 0;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }

  .score {
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex-wrap: wrap;
  }

  .big {
    font-size: clamp(72px, 13vw, 120px);
    font-weight: 700;
    line-height: 0.9;
    letter-spacing: -0.05em;
    font-variation-settings: 'opsz' 96;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }

  .unit {
    display: flex;
    flex-direction: column;
    font-size: 19px;
    color: var(--muted);
  }

  .best {
    color: var(--ink);
    font-weight: 600;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
    gap: 16px 20px;
    margin: 28px 0 0;
    padding: 18px 0;
    border-block: 1px solid var(--tape-edge);
  }

  .facts div {
    display: flex;
    flex-direction: column-reverse;
  }

  .facts dt {
    font-size: 14px;
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .chart {
    position: relative;
    margin: 24px 0 0;
  }

  .chart svg {
    display: block;
    width: 100%;
    height: 120px;
    overflow: visible;
  }

  .chart .grid {
    stroke: var(--tape-edge);
    stroke-dasharray: 3 4;
    vector-effect: non-scaling-stroke;
  }

  .chart .err {
    stroke: var(--error);
    stroke-width: 2;
    opacity: 0.35;
    vector-effect: non-scaling-stroke;
  }

  .chart .area {
    fill: var(--accent-soft);
  }

  .chart .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }

  .chart figcaption {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .key {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .key i {
    display: inline-block;
    width: 14px;
    height: 3px;
    border-radius: 2px;
  }

  .k-line {
    background: var(--accent);
  }

  .k-err {
    margin-left: 10px;
    width: 3px !important;
    height: 12px !important;
    background: var(--error);
    opacity: 0.5;
  }

  .ymax {
    position: absolute;
    top: -4px;
    left: 0;
    font-size: 12px;
    color: var(--muted);
    transform: translateY(-100%);
  }

  .trouble {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 24px 0 0;
    color: var(--muted);
    font-size: 15px;
  }

  .chip {
    font-family: var(--mono);
    font-size: 14px;
    padding: 2px 9px;
    border-radius: 6px;
    color: var(--error);
    background: var(--error-soft);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 28px;
  }

  .actions button {
    padding: 11px 20px;
    border-radius: 10px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
  }

  .primary {
    border: 0;
    background: var(--accent);
    color: #fff;
  }

  .primary:hover {
    filter: brightness(1.08);
  }

  .ghost {
    border: 1px solid var(--tape-edge);
    background: var(--tape);
  }

  .ghost:hover {
    border-color: var(--muted);
  }

  /* ---- footer ---- */
  .hint {
    padding-block: 20px 28px;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
    text-align: center;
    font-size: 15px;
    color: var(--muted);
  }

  .link {
    border: 0;
    background: none;
    padding: 2px 4px;
    margin-left: 6px;
    color: var(--ink);
    font-size: 15px;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--tape-edge);
    text-underline-offset: 4px;
  }

  .link:hover {
    text-decoration-color: var(--accent);
  }

  kbd {
    font-family: var(--mono);
    font-size: 13px;
    padding: 1px 6px;
    border-radius: 5px;
    border: 1px solid var(--tape-edge);
    border-bottom-width: 2px;
    background: var(--tape);
    color: var(--ink);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 560px) {
    .band {
      --anchor: 26%;
      height: 116px;
    }
    .mark {
      font-size: 22px;
    }
    .lengths button {
      padding: 6px 11px;
      font-size: 14px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .track,
    .holes i,
    .live {
      transition: none;
    }
    .head::after {
      animation: none;
    }
  }
</style>
