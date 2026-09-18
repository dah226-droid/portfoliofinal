(() => {
  const pin = document.getElementById('heroPin');
  const hero = document.getElementById('hero');
  const field = document.getElementById('blockField');
  const aboutBlocks = document.getElementById('aboutBlocks');
  const tagline = document.getElementById('heroTagline');
  const scrollCue = document.getElementById('scrollCue');
  const stackHint = document.getElementById('stackHint');
  const towerMore = document.getElementById('towerMore');
  const towerPhew = document.getElementById('towerPhew');
  const heroName = document.querySelector('.hero-name');
  const aboutName = document.querySelector('.about-name');
  const blocks = field ? Array.from(field.querySelectorAll('.block')) : [];
  const isHomePage = Boolean(pin && hero);
  const hasBlockField = Boolean(field && blocks.length);
  const aboutTargets = aboutBlocks
    ? Array.from(aboutBlocks.querySelectorAll('.block'))
    : [];
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Font-drop order (into hero cluster)
  const DROP_ORDER = [5, 4, 3, 2, 1, 0];
  const SLOT = 0.14;
  const GAP = 0.04;
  const DROP_RANGE_VH = 1.75;
  const SHAKE_HOLD_VH = 0.55;
  const GREY_HOLD_VH = 0.4;
  // Stagger (vh of scroll) before each next box starts falling.
  // Higher values spread the falling boxes farther apart vertically.
  const EXIT_JOIN_VH = 0.18;

  // Exit: fall in order that builds a 3-2-1 pyramid (bottom row → middle → top)
  const EXIT_ORDER = [3, 4, 5, 1, 2, 0];
  // Tower slots: 0–2 bottom L/C/R, 3–4 middle L/R, 5 top — offsets in block-widths
  const TOWER_SLOTS = [
    { col: -1, row: 0 },
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: -0.5, row: 1 },
    { col: 0.5, row: 1 },
    { col: 0, row: 2 },
  ];
  const TOWER_BOTTOM_PAD = 0.45; // fraction of block size above page bottom
  const AUTO_STACK_MS = 650;

  let ticking = false;
  let starts = [];
  let motion = [];
  let landRects = null;
  let fixedActive = false;
  let exitOrigin = null; // { scrollY, clusterY, size } captured once when fall starts
  let cascadeLayer = null;
  let magneticCursor = null;
  let autoStackState = null;
  let autoStackFrame = null;
  let landingReleased = false;

  function blockTiltDeg(block) {
    if (block.dataset.tilt != null && block.dataset.tilt !== '') {
      const fromData = parseFloat(block.dataset.tilt);
      if (!Number.isNaN(fromData)) return fromData;
    }
    const css = parseFloat(getComputedStyle(block).getPropertyValue('--tilt'));
    return Number.isNaN(css) ? 0 : css;
  }

  // Layout box position in the field (ignores shake/rotation AABB shifts)
  function measureBlockLayout(block) {
    block.style.animation = 'none';
    block.style.transform = 'none';
    void block.offsetWidth;
    const r = block.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      width: block.offsetWidth || 72,
    };
  }

  // Live on-screen position (keeps shake / tilt; size stays at layout width, not rotated bbox)
  function measureBlockVisual(block) {
    const layoutSize = block.offsetWidth || block.offsetHeight || 72;
    const r = block.getBoundingClientRect();
    return {
      left: r.left + (r.width - layoutSize) / 2,
      top: r.top + (r.height - layoutSize) / 2,
      width: layoutSize,
    };
  }

  function clusterBlockSize(block) {
    return block.offsetWidth || block.offsetHeight || 72;
  }

  function blockVisualRotation(block) {
    const tr = getComputedStyle(block).transform;
    if (tr && tr !== 'none') {
      const m = tr.match(/matrix\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',').map(Number);
        if (parts.length >= 2) {
          return Math.atan2(parts[1], parts[0]) * (180 / Math.PI);
        }
      }
    }
    return blockTiltDeg(block);
  }

  function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
  }

  function easeInQuad(t) {
    return t * t;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function seeded(i, salt) {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function buildMotion() {
    motion = blocks.map((_, i) => {
      const r1 = seeded(i, 1);
      const r3 = seeded(i, 3);
      const r4 = seeded(i, 4);
      return {
        spawnX: (r1 - 0.5) * 28,
        spawnY: 2 + seeded(i, 2) * 6,
        sway: (r3 - 0.5) * 55,
        swayFreq: 0.9 + r4 * 1.0,
        tumble: (seeded(i, 5) - 0.5) * 110,
        wobble: 3 + seeded(i, 6) * 8,
        exitSpin: (seeded(i, 7) - 0.5) * 120,
        exitDrift: (seeded(i, 8) - 0.5) * 60,
      };
    });
  }

  function cmToPx(cm) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;height:${cm}cm;`;
    document.body.appendChild(probe);
    const px = probe.offsetHeight;
    probe.remove();
    return px;
  }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function lerpColor(fromHex, toHex, t) {
    const a = hexToRgb(fromHex);
    const b = hexToRgb(toHex);
    const u = clamp(t, 0, 1);
    const r = Math.round(a.r + (b.r - a.r) * u);
    const g = Math.round(a.g + (b.g - a.g) * u);
    const bl = Math.round(a.b + (b.b - a.b) * u);
    return `rgb(${r}, ${g}, ${bl})`;
  }

  const COLOR_GREY = '#9a9a9a';
  const COLOR_PURPLE = '#8c4a97';

  function pagePurpleProgress() {
    const maxScroll = Math.max(
      document.documentElement.scrollHeight - window.innerHeight,
      1
    );
    const start = exitOrigin ? exitOrigin.scrollY : 0;
    const span = Math.max(maxScroll - start, 1);
    const t = clamp((window.scrollY - start) / span, 0, 1);
    // Smooth grey → purple across the whole fall (ease-in so it finishes near the end)
    return easeInOutCubic(t);
  }

  function computeMagneticNudge(rect, cursorX, cursorY, index, options = {}) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = cx - cursorX;
    const dy = cy - cursorY;
    const distance = Math.hypot(dx, dy);
    const radiusScale = options.radiusScale ?? 1.3;
    const strengthX = options.strengthX ?? (18 + (index % 2) * 4);
    const strengthY = options.strengthY ?? 14;
    const radius = Math.max(rect.width, rect.height) * radiusScale;

    if (distance > radius || distance === 0) {
      return { x: 0, y: 0 };
    }

    const force = Math.pow(1 - distance / radius, 1.35);
    const nudgeX = (dx / distance) * force * strengthX;
    const nudgeY = (dy / distance) * force * strengthY;
    return { x: nudgeX, y: nudgeY };
  }

  function isMagneticGreyBlock(block) {
    if (block.classList.contains('gray') || block.classList.contains('to-grey')) return true;
    return Boolean(aboutBlocks && aboutBlocks.contains(block));
  }

  function getMagneticGreyBlocks() {
    const seen = new Set();
    const layer = cascadeLayer || document.getElementById('cascadeLayer');
    // No magnetic pull on the falling / finished tower boxes
    const candidates = [
      ...document.querySelectorAll('.block-field .block'),
      ...(aboutBlocks ? aboutBlocks.querySelectorAll('.block') : []),
    ];

    return candidates.filter((block) => {
      if (seen.has(block) || !isMagneticGreyBlock(block)) return false;
      if (layer && layer.contains(block)) return false;
      if (block.style.position === 'fixed' || block.style.position === 'absolute') {
        // Absolute/cascade fall boxes stay still under the cursor
        if (block.parentElement === layer) return false;
      }
      seen.add(block);

      const opacity = block.style.opacity;
      if (opacity !== '' && parseFloat(opacity) === 0) return false;

      const rect = block.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function setBlockMagneticOffset(block, x, y) {
    block._magX = x;
    block._magY = y;
    block.style.setProperty('--mag-x', `${x.toFixed(1)}px`);
    block.style.setProperty('--mag-y', `${y.toFixed(1)}px`);
  }

  function withMagTransform(block, transform) {
    if (!isMagneticGreyBlock(block)) return transform;
    const mx = block._magX || 0;
    const my = block._magY || 0;
    if (!mx && !my) return transform;
    return `${transform} translate3d(${mx.toFixed(1)}px, ${my.toFixed(1)}px, 0)`;
  }

  function refreshBlockMagTransform(block) {
    const mx = block._magX || 0;
    const my = block._magY || 0;
    const mag = ` translate3d(${mx.toFixed(1)}px, ${my.toFixed(1)}px, 0)`;

    if (block.style.position === 'fixed' || block.style.position === 'absolute') {
      const rotMatch = block.style.transform.match(/rotate\(([-\d.]+)deg\)/);
      const rot = rotMatch ? rotMatch[1] : blockTiltDeg(block);
      block.style.transform = `rotate(${rot}deg)${mag}`;
      return;
    }

    if (aboutBlocks && aboutBlocks.classList.contains('is-visible') && aboutBlocks.contains(block)) {
      block.style.transform = `rotate(${blockTiltDeg(block)}deg)${mag}`;
    }
  }

  function applyMagneticBlocks(cursorX, cursorY) {
    getMagneticGreyBlocks().forEach((block, index) => {
      const { x, y } = computeMagneticNudge(
        block.getBoundingClientRect(),
        cursorX,
        cursorY,
        index
      );
      setBlockMagneticOffset(block, x, y);
      refreshBlockMagTransform(block);
    });
  }

  function resetMagneticBlocks() {
    getMagneticGreyBlocks().forEach((block) => {
      setBlockMagneticOffset(block, 0, 0);
      refreshBlockMagTransform(block);
    });
  }

  function initMagneticBlocks() {
    if (prefersReducedMotion || !window.matchMedia('(pointer: fine)').matches) return;

    window.addEventListener('mousemove', (e) => {
      magneticCursor = { x: e.clientX, y: e.clientY };
      applyMagneticBlocks(e.clientX, e.clientY);
    });
    window.addEventListener('blur', () => {
      magneticCursor = null;
      resetMagneticBlocks();
    });
  }

  function initMagneticText(el) {
    if (!el || prefersReducedMotion || !window.matchMedia('(pointer: fine)').matches) return;

    const lines = Array.from(el.childNodes).map((node) => {
      if (node.nodeName === 'BR') return '<br>';
      return node.textContent || '';
    }).join('');

    const html = lines
      .split('<br>')
      .map((line) => line.trim())
      .map((line) => {
        const words = line.split(/\s+/).filter(Boolean);
        return words.map((word) => `<span class="hero-word">${word}</span>`).join(' ');
      })
      .join('<br>');

    el.innerHTML = html;

    const words = Array.from(el.querySelectorAll('.hero-word'));

    function resetWords() {
      words.forEach((word) => {
        word.style.transform = '';
      });
    }

    el.addEventListener('mousemove', (e) => {
      words.forEach((word, index) => {
        const { x, y } = computeMagneticNudge(
          word.getBoundingClientRect(),
          e.clientX,
          e.clientY,
          index
        );
        word.style.transform = x || y
          ? `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
          : '';
      });
    });

    el.addEventListener('mouseleave', resetWords);
    window.addEventListener('blur', resetWords);
  }

  function initMagneticHeroName() {
    initMagneticText(heroName);
  }

  function initMagneticAboutName() {
    initMagneticText(aboutName);
  }

  function initMagneticDisciplines() {
    if (prefersReducedMotion || !window.matchMedia('(pointer: fine)').matches) return;

    const disciplines = Array.from(document.querySelectorAll('.discipline'));
    if (!disciplines.length) return;

    function apply(cursorX, cursorY) {
      disciplines.forEach((el, index) => {
        const { x, y } = computeMagneticNudge(
          el.getBoundingClientRect(),
          cursorX,
          cursorY,
          index,
          { radiusScale: 2.6, strengthX: 28, strengthY: 22 }
        );
        el.style.setProperty('--mag-x', `${x.toFixed(1)}px`);
        el.style.setProperty('--mag-y', `${y.toFixed(1)}px`);
      });
    }

    function reset() {
      disciplines.forEach((el) => {
        el.style.setProperty('--mag-x', '0px');
        el.style.setProperty('--mag-y', '0px');
      });
    }

    window.addEventListener('mousemove', (e) => {
      apply(e.clientX, e.clientY);
    });
    window.addEventListener('blur', reset);
  }

  function ensureCascadeLayer() {
    if (cascadeLayer) return cascadeLayer;
    cascadeLayer = document.createElement('div');
    cascadeLayer.id = 'cascadeLayer';
    cascadeLayer.setAttribute('aria-hidden', 'true');
    cascadeLayer.style.cssText =
      'position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:40;overflow:visible;';
    document.body.appendChild(cascadeLayer);
    return cascadeLayer;
  }

  function mountBlockToCascade(block) {
    const layer = ensureCascadeLayer();
    if (block.parentElement !== layer) layer.appendChild(block);
  }

  function returnBlockToField(block) {
    if (block.parentElement !== field) field.appendChild(block);
  }

  function returnBlocksToField() {
    blocks.forEach(returnBlockToField);
    if (cascadeLayer && cascadeLayer.childElementCount === 0) {
      cascadeLayer.remove();
      cascadeLayer = null;
    }
  }

  function clearFixed() {
    fixedActive = false;
    landRects = null;
    exitOrigin = null;
    autoStackState = null;
    if (autoStackFrame) {
      cancelAnimationFrame(autoStackFrame);
      autoStackFrame = null;
    }
    setTowerMoreReady(false);
    blocks.forEach((block) => {
      delete block._fallFrom;
      block.style.position = '';
      block.style.left = '';
      block.style.top = '';
      block.style.width = '';
      block.style.height = '';
      block.style.margin = '';
      block.style.zIndex = '';
      block.style.transformOrigin = '';
      block.style.boxSizing = '';
      block.style.animation = '';
      block.style.pointerEvents = '';
      block.style.background = '';
      block.classList.remove('to-grey');
    });
    returnBlocksToField();
    if (aboutBlocks) aboutBlocks.style.opacity = '';
    aboutTargets.forEach((t) => { t.style.opacity = ''; });
  }

  function animateAutoStack() {
    if (!autoStackState) {
      autoStackFrame = null;
      return;
    }

    applyScroll();

    if (autoStackState && autoStackState.doneAt == null) {
      autoStackFrame = requestAnimationFrame(animateAutoStack);
    } else {
      autoStackFrame = null;
    }
  }

  function captureLandRects() {
    field.classList.remove('is-bouncing', 'is-piled', 'is-exiting');
    field.classList.add('is-landed', 'is-greyed');
    blocks.forEach((block) => {
      block.style.animation = 'none';
      const tilt = blockTiltDeg(block);
      block.style.transform = `rotate(${tilt}deg)`;
      block.style.opacity = '1';
      block.style.width = '';
      block.style.height = '';
      block.style.position = '';
      block.style.left = '';
      block.style.top = '';
      block.classList.add('to-grey');
    });

    void field.offsetWidth;

    landRects = blocks.map((block) => {
      const r = block.getBoundingClientRect();
      const size = block.offsetWidth;
      return { left: r.left, top: r.top, width: size, height: size };
    });
  }

  function measureStarts() {
    clearFixed();
    field.classList.remove(
      'is-dropping', 'is-landed', 'is-bouncing', 'is-piled',
      'is-greyed', 'is-exiting', 'is-gone'
    );
    if (aboutBlocks) aboutBlocks.classList.remove('is-visible');
    blocks.forEach((b) => {
      b.style.transform = '';
      b.style.opacity = '';
    });

    const tag = tagline.getBoundingClientRect();
    const underOffset = 6 + cmToPx(0.8);

    starts = blocks.map((block, i) => {
      const r = block.getBoundingClientRect();
      const along = 0.25 + ((i + 0.5) / blocks.length) * 0.55;
      const tagCX = tag.left + tag.width * along;
      const tagCY = tag.bottom + underOffset;
      return {
        x: tagCX - (r.left + r.width / 2),
        y: tagCY - (r.top + r.height / 2),
      };
    });
  }

  function lastDropEndProgress() {
    return (blocks.length - 1) * (SLOT + GAP) + SLOT;
  }

  function getPhaseRanges() {
    const vh = window.innerHeight;
    // Scroll budget so every box can finish appearing before the drop phase ends
    const dropRange = Math.max(vh * DROP_RANGE_VH, 1);
    const shakeRange = Math.max(vh * SHAKE_HOLD_VH, 1);
    const greyRange = Math.max(vh * GREY_HOLD_VH, 1);
    const preExit = dropRange + shakeRange + greyRange;
    return { vh, dropRange, shakeRange, greyRange, preExit };
  }

  // Keep the landing pinned through drop + shake + grey (hint stays visible)
  function getLandingScrollCapPx() {
    const { dropRange, shakeRange, greyRange } = getPhaseRanges();
    return dropRange + shakeRange + greyRange;
  }

  function syncLandingPinHeight() {
    if (!pin) return;
    pin.style.height = `${window.innerHeight + getLandingScrollCapPx()}px`;
  }

  function enforceLandingScrollLock() {
    if (prefersReducedMotion || landingReleased) return;

    const cap = getLandingScrollCapPx();
    if (window.scrollY >= cap - 2) {
      landingReleased = true;
      return;
    }

    if (window.scrollY > cap) {
      window.scrollTo(0, cap);
    }
  }

  function getPhases() {
    const { dropRange, shakeRange, greyRange, preExit } = getPhaseRanges();
    const lastEnd = lastDropEndProgress();

    // One scroll pixel = one progress pixel (avoid pinScroll + afterPin double-count)
    const totalScroll = window.scrollY;

    // Map full drop scroll → 0…lastEnd so the final box fully lands at drop end
    const dropProgress = clamp(totalScroll / dropRange, 0, 1) * Math.max(lastEnd, 1);
    const afterDrop = totalScroll - dropRange;
    const shakeProgress = clamp(afterDrop / shakeRange, 0, 1);
    const afterShake = afterDrop - shakeRange;
    const greyProgress = clamp(afterShake / greyRange, 0, 1);
    const exitScrollPx = Math.max(0, totalScroll - preExit);

    return { dropProgress, shakeProgress, greyProgress, exitScrollPx };
  }

  function exitSlotForIndex(blockIndex) {
    const orderPos = EXIT_ORDER.indexOf(blockIndex);
    const i = orderPos === -1 ? blockIndex : orderPos;
    return { slotIndex: i, joinAt: i * window.innerHeight * EXIT_JOIN_VH };
  }

  function setStackHintVisible(visible) {
    if (!stackHint) return;
    stackHint.classList.toggle('is-visible', Boolean(visible));
  }

  function setTowerMoreReady(ready, bounds) {
    if (towerMore) {
      if (!ready || !bounds) {
        towerMore.classList.remove('is-ready');
        towerMore.setAttribute('aria-hidden', 'true');
        towerMore.setAttribute('tabindex', '-1');
      } else {
        towerMore.style.left = `${bounds.left.toFixed(1)}px`;
        towerMore.style.top = `${bounds.top.toFixed(1)}px`;
        towerMore.style.width = `${bounds.width.toFixed(1)}px`;
        towerMore.style.height = `${bounds.height.toFixed(1)}px`;
        towerMore.classList.add('is-ready');
        towerMore.setAttribute('aria-hidden', 'false');
        towerMore.removeAttribute('tabindex');
      }
    }

    if (!towerPhew) return;
    if (!ready || !bounds) {
      towerPhew.classList.remove('is-visible');
      towerPhew.setAttribute('aria-hidden', 'true');
      return;
    }

    const gap = 18;
    const labelWidth = Math.min(220, window.innerWidth * 0.32);
    towerPhew.style.width = `${labelWidth}px`;
    towerPhew.style.left = `${Math.max(12, bounds.left - labelWidth - gap).toFixed(1)}px`;
    towerPhew.style.top = `${(bounds.top + bounds.height * 0.35).toFixed(1)}px`;
    towerPhew.classList.add('is-visible');
    towerPhew.setAttribute('aria-hidden', 'false');
  }

  function applyShakeHold() {
    clearFixed();
    if (hero) hero.classList.remove('is-releasing');
    field.classList.remove(
      'is-dropping', 'is-bouncing', 'is-piled', 'is-greyed', 'is-exiting', 'is-gone'
    );
    field.classList.add('is-landed');
    if (aboutBlocks) aboutBlocks.classList.remove('is-visible');
    if (scrollCue) scrollCue.style.opacity = '1';
    setStackHintVisible(true);
    blocks.forEach((block) => {
      block.style.transform = '';
      block.style.opacity = '1';
      block.classList.remove('to-grey');
    });
  }

  function applyGreyHold() {
    if (scrollCue) scrollCue.style.opacity = '0';
    setStackHintVisible(true);
    setTowerMoreReady(false);
    if (hero) hero.classList.remove('is-releasing');
    if (aboutBlocks) aboutBlocks.classList.remove('is-visible');

    exitOrigin = null;
    fixedActive = false;
    autoStackState = null;
    if (autoStackFrame) {
      cancelAnimationFrame(autoStackFrame);
      autoStackFrame = null;
    }

    // Turn grey only — keep landed angles (--tilt) and shake
    field.classList.remove('is-dropping', 'is-bouncing', 'is-piled', 'is-exiting', 'is-gone');
    field.classList.add('is-landed', 'is-greyed');

    blocks.forEach((block) => {
      delete block._fallFrom;
      returnBlockToField(block);
      block.style.position = '';
      block.style.left = '';
      block.style.top = '';
      block.style.width = '';
      block.style.height = '';
      block.style.margin = '';
      block.style.zIndex = '';
      block.style.transformOrigin = '';
      block.style.boxSizing = '';
      block.style.pointerEvents = '';
      block.style.animation = '';
      block.style.transform = '';
      block.style.background = '';
      block.style.opacity = '1';
      block.classList.add('to-grey');
    });

    if (cascadeLayer && cascadeLayer.childElementCount === 0) {
      cascadeLayer.remove();
      cascadeLayer = null;
    }
  }

  function resetWaitingBlock(block) {
    delete block._fallFrom;
    returnBlockToField(block);
    block.style.position = '';
    block.style.left = '';
    block.style.top = '';
    block.style.width = '';
    block.style.height = '';
    block.style.margin = '';
    block.style.zIndex = '';
    block.style.transformOrigin = '';
    block.style.boxSizing = '';
    block.style.pointerEvents = '';
    block.style.animation = '';
    block.style.transform = '';
    block.style.background = '';
    block.style.opacity = '1';
    block.classList.add('to-grey');
  }

  function slotForIndex(blockIndex) {
    const orderPos = DROP_ORDER.indexOf(blockIndex);
    const i = orderPos === -1 ? blockIndex : orderPos;
    const start = i * (SLOT + GAP);
    const end = start + SLOT;
    return { start, end };
  }

  function applyFontDrop(progress) {
    if (hero) hero.classList.remove('is-releasing');
    field.classList.remove('is-exiting', 'is-gone', 'is-bouncing', 'is-piled', 'is-greyed');
    if (aboutBlocks) aboutBlocks.classList.remove('is-visible');
    if (fixedActive) clearFixed();
    setStackHintVisible(false);

    if (progress <= 0.0005) {
      field.classList.add('is-dropping');
      field.classList.remove('is-landed');
      if (scrollCue) scrollCue.style.opacity = '1';
      blocks.forEach((block, i) => {
        const s = starts[i] || { x: 0, y: -200 };
        const m = motion[i] || { spawnX: 0, spawnY: 0 };
        block.style.opacity = '0';
        block.style.transform = withMagTransform(
          block,
          `translate3d(${(s.x + m.spawnX).toFixed(1)}px, ${(s.y + m.spawnY).toFixed(1)}px, 0) rotate(0deg)`
        );
      });
      return;
    }

    const lastEnd = lastDropEndProgress();
    if (progress >= lastEnd) {
      field.classList.remove('is-dropping');
      field.classList.add('is-landed');
      if (scrollCue) scrollCue.style.opacity = '0';
      setStackHintVisible(true);
      blocks.forEach((block) => {
        block.style.transform = '';
        block.style.opacity = '1';
        block.classList.remove('to-grey');
      });
      return;
    }

    field.classList.add('is-dropping');
    field.classList.remove('is-landed');
    if (scrollCue) scrollCue.style.opacity = '1';

    blocks.forEach((block, i) => {
      const s = starts[i] || { x: 0, y: -200 };
      const m = motion[i] || {
        spawnX: 0, spawnY: 0, sway: 40, swayFreq: 2, tumble: 90, wobble: 10, exitDrift: 0,
      };
      const tilt = parseFloat(block.dataset.tilt) || 0;
      const { start, end } = slotForIndex(i);

      if (progress < start) {
        block.style.opacity = '0';
        block.style.transform = withMagTransform(
          block,
          `translate3d(${(s.x + m.spawnX).toFixed(1)}px, ${(s.y + m.spawnY).toFixed(1)}px, 0) rotate(${(m.tumble * 0.1).toFixed(1)}deg)`
        );
        return;
      }

      if (progress >= end) {
        block.style.opacity = '1';
        block.style.transform = withMagTransform(
          block,
          `translate3d(0px, 0px, 0) rotate(${tilt}deg)`
        );
        return;
      }

      const local = (progress - start) / (end - start);
      const settle = easeInOutCubic(
        clamp(
          local < 0.78
            ? easeInQuad(local / 0.78) * 0.78
            : 0.78 + easeOutCubic((local - 0.78) / 0.22) * 0.22,
          0,
          1
        )
      );
      const remain = 1 - settle;
      const sway = m.sway * Math.sin(settle * Math.PI * m.swayFreq) * remain;
      const wander = (m.exitDrift || 0) * Math.sin(settle * Math.PI * (m.swayFreq * 0.45 + 0.35)) * remain;
      const wobbleY = m.wobble * Math.sin(settle * Math.PI * (m.swayFreq + 0.5)) * remain;
      const x = (s.x + m.spawnX) * remain + sway + wander;
      const y = (s.y + m.spawnY) * remain + wobbleY;
      const rot = m.tumble * remain + tilt * settle
        + Math.sin(settle * Math.PI * 2) * 8 * remain;

      block.style.opacity = String(clamp(local * 10, 0, 1));
      block.style.transform = withMagTransform(
        block,
        `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${rot.toFixed(1)}deg)`
      );
    });
  }

  function applyExit(exitScrollPx) {
    if (scrollCue) scrollCue.style.opacity = '0';
    if (hero) hero.classList.add('is-releasing');

    if (exitScrollPx <= 1) {
      applyGreyHold();
      return;
    }

    setStackHintVisible(false);

    // Snapshot cluster layout for tower targets (keep boxes shaking in place)
    if (!exitOrigin) {
      field.classList.remove('is-dropping', 'is-bouncing', 'is-piled', 'is-exiting', 'is-gone');
      field.classList.add('is-landed', 'is-greyed');
      blocks.forEach((block) => {
        delete block._fallFrom;
        if (block.parentElement !== field) returnBlockToField(block);
        block.style.opacity = '1';
        block.classList.add('to-grey');
      });
      void field.offsetWidth;

      const starts = blocks.map((block) => measureBlockVisual(block));
      const clusterSize = clusterBlockSize(blocks[0]) || starts[0]?.width || 72;

      exitOrigin = {
        scrollY: window.scrollY,
        size: clusterSize,
        starts,
      };
    }

    field.classList.remove('is-dropping', 'is-piled', 'is-gone');
    field.classList.add('is-landed', 'is-greyed');

    if (aboutBlocks) {
      aboutBlocks.classList.remove('is-visible');
      aboutBlocks.style.opacity = '0';
    }
    aboutTargets.forEach((t) => { t.style.opacity = '0'; });

    fixedActive = true;

    const size = exitOrigin.size;
    const scrollY = window.scrollY;
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    const layer = ensureCascadeLayer();
    layer.style.height = `${pageHeight}px`;
    // Bottom row sits just above the page end; higher rows stack on top (touching)
    const towerBottomDocY =
      pageHeight - size * (1 + TOWER_BOTTOM_PAD);
    // Keep the tower under the original cluster (right side), not page center
    const towerCenterX =
      exitOrigin.starts.reduce((sum, s) => sum + s.left + (s.width || size) / 2, 0) /
      Math.max(exitOrigin.starts.length, 1);

    function towerRestForSlot(slotIndex) {
      const slot = TOWER_SLOTS[slotIndex % TOWER_SLOTS.length];
      return {
        left: towerCenterX + (slot.col - 0.5) * size,
        docY: towerBottomDocY - slot.row * size,
        tilt: 0,
      };
    }

    const falling = [];
    const maxScroll = Math.max(pageHeight - window.innerHeight, 1);
    const exitBudget = Math.max(maxScroll - exitOrigin.scrollY, 1);
    const maxExitScroll = Math.max(maxScroll - exitOrigin.scrollY, 0);
    const atPageEnd = maxExitScroll > 0 && exitScrollPx >= maxExitScroll - 2;

    blocks.forEach((block, i) => {
      const { slotIndex, joinAt } = exitSlotForIndex(i);

      if (exitScrollPx < joinAt) {
        resetWaitingBlock(block);
        return;
      }

      // Measure live in the grey pile right before this box leaves (shake still active)
      if (!block._fallFrom) {
        const snap = measureBlockVisual(block);
        const joinScrollY = window.scrollY;
        const startDocY = joinScrollY + snap.top;
        const joinTilt = blockVisualRotation(block);
        const rest = towerRestForSlot(slotIndex);
        const m = motion[i] || {};
        block._fallFrom = {
          left: snap.left,
          top: snap.top,
          width: size,
          startDocY,
          joinScrollY,
          tilt: joinTilt,
          restLeft: rest.left,
          restTilt: rest.tilt,
          restDocY: Math.max(startDocY + size * 0.5, rest.docY),
          driftAmp: (8 + Math.abs(m.exitDrift || 30) * 0.28) * 0.6,
          driftK1: 0.003 + seeded(i, 21) * 0.004,
          driftK2: 0.005 + seeded(i, 22) * 0.004,
          driftPhase: seeded(i, 23) * Math.PI * 2,
        };
        mountBlockToCascade(block);
        block.style.position = 'absolute';
        block.style.left = `${snap.left.toFixed(1)}px`;
        block.style.top = `${startDocY.toFixed(1)}px`;
        block.style.width = `${size.toFixed(1)}px`;
        block.style.height = `${size.toFixed(1)}px`;
        block.style.minWidth = `${size.toFixed(1)}px`;
        block.style.minHeight = `${size.toFixed(1)}px`;
        block.style.maxWidth = `${size.toFixed(1)}px`;
        block.style.maxHeight = `${size.toFixed(1)}px`;
        block.style.background = COLOR_GREY;
        block.style.transform = `rotate(${joinTilt.toFixed(1)}deg)`;
        block.style.opacity = '1';
      } else {
        // Keep tower targets live (resize / late layout)
        const rest = towerRestForSlot(slotIndex);
        block._fallFrom.restLeft = rest.left;
        block._fallFrom.restDocY = Math.max(
          block._fallFrom.startDocY + size * 0.5,
          rest.docY
        );
      }

      const from = block._fallFrom;
      const fallScroll = Math.max(0, exitScrollPx - joinAt);
      const pathScroll = Math.max(exitBudget - joinAt, 1);
      const scrollFallT = clamp(fallScroll / pathScroll, 0, 1);

      falling.push({
        block,
        slotIndex,
        from,
        boxSize: size,
        joinAt,
        pathScroll,
        scrollFallT,
      });
    });

    falling.sort((a, b) => a.slotIndex - b.slotIndex);

    if (falling.length > 0) {
      field.classList.add('is-exiting');
    } else {
      field.classList.remove('is-exiting');
    }

    const bottomRow = falling.filter((item) => TOWER_SLOTS[item.slotIndex % TOWER_SLOTS.length].row === 0);
    const bottomRowSettled = bottomRow.length > 0 && bottomRow.every((item) => item.scrollFallT >= 0.995);

    if (atPageEnd && bottomRowSettled) {
      if (!autoStackState) {
        autoStackState = {
          startedAt: performance.now(),
          doneAt: null,
          initialBySlot: new Map(
            falling.map((item) => [item.slotIndex, item.scrollFallT])
          ),
        };
      }
      if (!autoStackFrame) {
        autoStackFrame = requestAnimationFrame(animateAutoStack);
      }
    } else if (autoStackState) {
      autoStackState = null;
      if (autoStackFrame) {
        cancelAnimationFrame(autoStackFrame);
        autoStackFrame = null;
      }
    }

    falling.forEach((item) => {
      const travel = Math.max(item.from.restDocY - item.from.startDocY, 1);
      let fallT = item.scrollFallT;
      const row = TOWER_SLOTS[item.slotIndex % TOWER_SLOTS.length].row;

      if (row > 0 && autoStackState) {
        const elapsed = performance.now() - autoStackState.startedAt;
        const autoT = clamp(elapsed / AUTO_STACK_MS, 0, 1);
        const startT = autoStackState.initialBySlot.get(item.slotIndex) ?? fallT;
        fallT = Math.max(fallT, startT + (1 - startT) * easeOutCubic(autoT));
        if (autoT >= 1) {
          autoStackState.doneAt = performance.now();
        }
      }

      let docY = item.from.startDocY + travel * fallT;
      const settled = fallT >= 0.995;

      // Hold the captured grey-pile spot on the first frames, then assemble into the tower
      const assembleT = fallT <= 0.001 ? 0 : fallT;
      let left = item.from.left;
      let rot = item.from.tilt;
      let docTop = docY;

      if (fallT > 0.001) {
        left = item.from.left + (item.from.restLeft - item.from.left) * assembleT;
        rot = item.from.tilt + (item.from.restTilt - item.from.tilt) * assembleT;
      }

      // Slow left/right wander + light shake while falling (stops once settled)
      if (!settled && fallT > 0.02) {
        const motionFade = clamp((fallT - 0.02) / 0.12, 0, 1);
        const wanderFade = (1 - fallT * 0.45) * motionFade;
        const d = item.from;
        const wanderX =
          Math.sin(docY * d.driftK1 + d.driftPhase) * d.driftAmp * wanderFade +
          Math.sin(docY * d.driftK2 + d.driftPhase * 1.4) * d.driftAmp * 0.55 * wanderFade;
        left += wanderX;

        const phase = docY * 0.018 + item.slotIndex * 1.7;
        const shakeX = (Math.sin(phase) * 1.2 + Math.sin(phase * 1.35) * 0.6) * motionFade;
        const shakeY = Math.cos(phase * 0.9) * 0.8 * motionFade;
        rot += Math.sin(phase * 1.05) * 1.2 * motionFade;
        left += shakeX;
        docTop += shakeY;
      } else if (settled) {
        left = item.from.restLeft;
        rot = item.from.restTilt;
        docTop = item.from.restDocY;
      }

      const z = settled ? 40 + row : 30 - item.slotIndex;
      const boxSize = item.boxSize;
      const viewTop = docTop - scrollY;

      let opacity = 1;
      if (viewTop > window.innerHeight + boxSize * 0.2) {
        opacity = clamp(
          1 - (viewTop - window.innerHeight - boxSize * 0.2) / (boxSize * 2),
          0,
          1
        );
      } else if (viewTop + boxSize < -boxSize * 0.2) {
        opacity = clamp(1 + (viewTop + boxSize * 0.2) / (boxSize * 2), 0, 1);
      }

      const block = item.block;
      const purpleT = pagePurpleProgress();
      block.classList.remove('to-grey');
      block.style.background = lerpColor(COLOR_GREY, COLOR_PURPLE, purpleT);
      block.style.animation = 'none';
      block.style.pointerEvents = 'none';
      block.style.position = 'absolute';
      block.style.left = `${left.toFixed(1)}px`;
      block.style.top = `${docTop.toFixed(1)}px`;
      block.style.width = `${boxSize.toFixed(1)}px`;
      block.style.height = `${boxSize.toFixed(1)}px`;
      block.style.minWidth = `${boxSize.toFixed(1)}px`;
      block.style.minHeight = `${boxSize.toFixed(1)}px`;
      block.style.maxWidth = `${boxSize.toFixed(1)}px`;
      block.style.maxHeight = `${boxSize.toFixed(1)}px`;
      block.style.margin = '0';
      block.style.zIndex = String(z);
      block.style.transformOrigin = 'center center';
      block.style.boxSizing = 'border-box';
      block.style.opacity = String(opacity);
      const mx = 0;
      const my = 0;
      block.style.transform = `rotate(${rot.toFixed(1)}deg) translate3d(${mx.toFixed(1)}px, ${my.toFixed(1)}px, 0)`;
      block._magX = 0;
      block._magY = 0;
      block.style.setProperty('--mag-x', '0px');
      block.style.setProperty('--mag-y', '0px');
    });

    const allSettled =
      falling.length === blocks.length &&
      falling.every((item) => {
        if (item.scrollFallT >= 0.995) return true;
        if (!autoStackState) return false;
        const elapsed = performance.now() - autoStackState.startedAt;
        return elapsed >= AUTO_STACK_MS;
      });

    if (allSettled && falling.length) {
      let minL = Infinity;
      let minT = Infinity;
      let maxR = -Infinity;
      let maxB = -Infinity;
      falling.forEach((item) => {
        const left = item.from.restLeft;
        const top = item.from.restDocY;
        const s = item.boxSize;
        minL = Math.min(minL, left);
        minT = Math.min(minT, top);
        maxR = Math.max(maxR, left + s);
        maxB = Math.max(maxB, top + s);
      });
      setTowerMoreReady(true, {
        left: minL,
        top: minT,
        width: Math.max(maxR - minL, 1),
        height: Math.max(maxB - minT, 1),
      });
    } else {
      setTowerMoreReady(false);
    }
  }

  function applyScroll() {
    const { dropProgress, shakeProgress, greyProgress, exitScrollPx } = getPhases();

    if (exitScrollPx > 0) {
      applyExit(exitScrollPx);
    } else if (greyProgress > 0) {
      applyGreyHold();
    } else if (dropProgress >= 1 || shakeProgress > 0) {
      applyShakeHold();
    } else {
      applyFontDrop(dropProgress);
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      if (magneticCursor) {
        applyMagneticBlocks(magneticCursor.x, magneticCursor.y);
      }
      applyScroll();
      enforceLandingScrollLock();
      ticking = false;
    });
  }

  function onResize() {
    landingReleased = false;
    syncLandingPinHeight();
    measureStarts();
    applyScroll();
  }

  if (prefersReducedMotion && hasBlockField) {
    field.classList.add('is-landed', 'is-greyed');
    if (aboutBlocks) aboutBlocks.classList.add('is-visible');
    blocks.forEach((b) => {
      b.style.animation = 'none';
      b.style.opacity = '1';
      b.style.transform = '';
      b.classList.add('to-grey');
    });
  }

  function initPhotoCarousel() {
    const pin = document.getElementById('photoPin');
    const carousel = document.getElementById('photoCarousel');
    const track = document.getElementById('photoTrack');
    if (!pin || !carousel || !track) return;
    if (prefersReducedMotion) return;

    carousel.classList.add('is-scroll-driven');

    let extra = 0;
    let ticking = false;
    const nav = document.querySelector('.site-nav');

    function overflow() {
      return Math.max(0, track.scrollWidth - carousel.clientWidth);
    }

    function layout() {
      const navH = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
      const viewH = Math.max(0, window.innerHeight - navH);
      carousel.style.top = `${navH}px`;
      carousel.style.height = `${viewH}px`;
      extra = overflow();
      pin.style.height = `${viewH + extra}px`;
    }

    function apply() {
      extra = overflow();
      const range = pin.offsetHeight - carousel.offsetHeight;
      if (range <= 0 || extra <= 0) {
        track.style.transform = 'translate3d(0,0,0)';
        return;
      }
      const progress = Math.min(1, Math.max(0, window.scrollY / range));
      track.style.transform = `translate3d(${(-extra * progress).toFixed(2)}px,0,0)`;
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        apply();
      });
    }

    function onResize() {
      layout();
      apply();
    }

    Array.from(track.querySelectorAll('img')).forEach((img) => {
      if (img.complete) return;
      img.addEventListener('load', onResize, { once: true });
      img.addEventListener('error', onResize, { once: true });
    });

    layout();
    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(onResize).observe(track);
    }
  }

  function initPhotoLightbox() {
    const track = document.getElementById('photoTrack');
    const panel = document.getElementById('photoPanel');
    const panelImg = document.getElementById('photoPanelImage');
    const panelTitle = document.getElementById('photoPanelTitle');
    const prevBtn = document.getElementById('photoPrev');
    const nextBtn = document.getElementById('photoNext');
    if (!track || !panel || !panelImg || !panelTitle) return;

    const slides = Array.from(track.querySelectorAll('.photo-slide-open'));
    let index = 0;
    let lastTrigger = null;

    function showAt(i) {
      if (!slides.length) return;
      index = (i + slides.length) % slides.length;
      const button = slides[index];
      const img = button.querySelector('img');
      if (!img) return;
      panelImg.src = img.currentSrc || img.src;
      panelImg.alt = img.alt || '';
      panelTitle.textContent = 'Photography';
      lastTrigger = button;
    }

    function openFrom(button) {
      const found = slides.indexOf(button);
      showAt(found < 0 ? 0 : found);
      panel.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      if (nextBtn) nextBtn.focus();
    }

    function close() {
      if (!panel.classList.contains('is-open')) return;
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (lastTrigger) lastTrigger.focus();
    }

    function step(delta) {
      if (!panel.classList.contains('is-open')) return;
      showAt(index + delta);
    }

    track.addEventListener('click', (e) => {
      const button = e.target.closest('.photo-slide-open');
      if (!button) return;
      e.preventDefault();
      openFrom(button);
    });

    if (prevBtn) {
      prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        step(-1);
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        step(1);
      });
    }

    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-photo-close]')) close();
    });

    window.addEventListener('keydown', (e) => {
      if (!panel.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      }
    });
  }

  function initCustomCursor() {
    if (prefersReducedMotion || !window.matchMedia('(pointer: fine)').matches) return;

    const cursor = document.createElement('div');
    cursor.className = 'custom-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cursor);
    document.body.classList.add('custom-cursor-active');

    if (document.body.classList.contains('is-about-page')) {
      cursor.classList.add('is-about');
    }

    let x = -100;
    let y = -100;
    let scale = 1;
    let ticking = false;
    const navLinks = Array.from(document.querySelectorAll('.site-nav-link'));
    const hobbyLinks = Array.from(document.querySelectorAll('.hobby-link'));

    function hoverScale(target) {
      if (!target || typeof target.closest !== 'function') return 1;
      if (target.closest('.site-nav-link')) return 1.45;
      if (target.closest('.about-resume')) return 1.12;
      if (target.closest('.photo-slide, .photo-slide-open, .photo-panel-close, .photo-panel-nav')) return 1.12;
      if (target.closest('.ig-action, .ig-dialog-choice')) return 1.12;
      if (target.closest('.hobby-link')) return 1.45;
      if (target.closest('.work-feature-link, .work-feature-name, .work-feature-clip, .project-hero-clip')) {
        return 1.12;
      }
      return 1;
    }

    function paint() {
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
      ticking = false;
    }

    function onMove(e) {
      x = e.clientX;
      y = e.clientY;
      const hit = document.elementFromPoint(e.clientX, e.clientY) || e.target;
      scale = hoverScale(hit);
      navLinks.forEach((el) => {
        el.classList.toggle(
          'is-hot',
          Boolean(hit && typeof hit.closest === 'function' && hit.closest('.site-nav-link') === el)
        );
      });
      hobbyLinks.forEach((el) => {
        el.classList.toggle(
          'is-hot',
          Boolean(hit && typeof hit.closest === 'function' && hit.closest('.hobby-link') === el)
        );
      });
      cursor.classList.toggle('is-resume', scale > 1 && hit && hit.closest && hit.closest('.about-resume'));
      cursor.classList.toggle('is-image', scale > 1 && hit && hit.closest && hit.closest('.work-feature-link, .work-feature-clip, .project-hero-clip, .photo-slide'));
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(paint);
      }
    }

    window.addEventListener('mousemove', onMove, { passive: true });
    navLinks.forEach((link) => {
      link.addEventListener('mouseenter', () => {
        navLinks.forEach((el) => el.classList.toggle('is-hot', el === link));
        scale = 1.45;
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(paint);
        }
      });
      link.addEventListener('mouseleave', (e) => {
        link.classList.remove('is-hot');
        const next = e.relatedTarget;
        scale = next && next.closest && next.closest('.site-nav-link') ? 1.45 : 1;
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(paint);
        }
      });
    });
    hobbyLinks.forEach((link) => {
      link.addEventListener('mouseenter', () => {
        hobbyLinks.forEach((el) => el.classList.toggle('is-hot', el === link));
        scale = 1.45;
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(paint);
        }
      });
      link.addEventListener('mouseleave', () => {
        link.classList.remove('is-hot');
        scale = 1;
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(paint);
        }
      });
    });
  }

  function initNavAboutCue() {
    const contact = document.getElementById('contact');
    const aboutLink = document.getElementById('navAbout');
    const cue = document.getElementById('navAboutCue');
    if (!contact || !aboutLink || !cue) return;

    function placeCue() {
      const rect = aboutLink.getBoundingClientRect();
      const cueWidth = cue.offsetWidth || 56;
      cue.style.transform = `translate3d(${rect.left + rect.width / 2 - cueWidth / 2}px, ${rect.bottom + 6}px, 0)`;
    }

    function setVisible(visible) {
      cue.classList.toggle('is-visible', visible);
      cue.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if (visible) placeCue();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => setVisible(entry.isIntersecting));
      },
      { threshold: 0.35 }
    );
    observer.observe(contact);

    window.addEventListener('resize', () => {
      if (cue.classList.contains('is-visible')) placeCue();
    });
    window.addEventListener('scroll', () => {
      if (cue.classList.contains('is-visible')) placeCue();
    }, { passive: true });
  }

  if (isHomePage) {
    initMagneticHeroName();
    initMagneticBlocks();
    initMagneticDisciplines();
    initNavAboutCue();
  }

  initMagneticAboutName();

  if (hasBlockField && !prefersReducedMotion) {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }

    function forceTop() {
      window.scrollTo(0, 0);
      landingReleased = false;
    }

    function bootLayout() {
      syncLandingPinHeight();
      measureStarts();
      applyScroll();
    }

    forceTop();
    window.addEventListener('pageshow', (e) => {
      if (e.persisted || window.scrollY > 0) {
        forceTop();
        bootLayout();
      }
    });

    const toTopBtn = document.getElementById('toTop');
    if (toTopBtn) {
      toTopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        landingReleased = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const settle = () => {
          if (window.scrollY > 1) {
            requestAnimationFrame(settle);
            return;
          }
          forceTop();
          bootLayout();
        };
        requestAnimationFrame(settle);
      });
    }

    buildMotion();
    bootLayout();
    requestAnimationFrame(bootLayout);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        forceTop();
        bootLayout();
      });
    }
  } else if (isHomePage) {
    const toTopBtn = document.getElementById('toTop');
    if (toTopBtn) {
      toTopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      });
    }
  }

  function initUmamiFlavorCarousel() {
    const pin = document.getElementById('umamiFlavorPin');
    const carousel = document.getElementById('umamiFlavorCarousel');
    const track = document.getElementById('umamiFlavorTrack');
    if (!pin || !carousel || !track) return;

    if (prefersReducedMotion) {
      carousel.style.overflowX = 'auto';
      return;
    }

    let progress = 0;
    let extra = 0;
    let lockY = null;
    let capturing = false;

    function overflow() {
      return Math.max(0, track.scrollWidth - carousel.clientWidth);
    }

    function stickyTopPx() {
      const gapCm = 37.7952755906;
      const baseH = Math.max(carousel.offsetHeight, 1);
      return Math.max(0, window.innerHeight - baseH - gapCm);
    }

    function layout() {
      carousel.style.top = `${stickyTopPx()}px`;
      extra = overflow();
      if (!capturing) pin.style.height = '';
      apply();
    }

    function apply() {
      extra = overflow();
      track.style.transform = `translate3d(${(-extra * progress).toFixed(2)}px,0,0)`;
    }

    function startCapture() {
      if (capturing) return;
      const rect = carousel.getBoundingClientRect();
      capturing = true;
      lockY = window.scrollY;
      pin.style.height = `${rect.height}px`;
      carousel.style.position = 'fixed';
      carousel.style.left = `${rect.left}px`;
      carousel.style.width = `${rect.width}px`;
      carousel.style.top = `${rect.top}px`;
      carousel.style.right = 'auto';
      carousel.style.zIndex = '5';
    }

    function endCapture() {
      if (!capturing) return;
      capturing = false;
      lockY = null;
      carousel.style.position = '';
      carousel.style.left = '';
      carousel.style.width = '';
      carousel.style.right = '';
      carousel.style.zIndex = '';
      carousel.style.top = `${stickyTopPx()}px`;
      pin.style.height = '';
    }

    function isReadyToCapture() {
      const top = stickyTopPx();
      const pinTop = pin.getBoundingClientRect().top;
      return pinTop <= top + 2;
    }

    function onWheel(e) {
      extra = overflow();
      if (extra <= 0) return;

      const down = e.deltaY > 0;
      const up = e.deltaY < 0;

      if (!capturing) {
        if (!(isReadyToCapture() && ((down && progress < 1) || (up && progress > 0)))) {
          return;
        }
        startCapture();
      }

      if (down && progress >= 1) {
        endCapture();
        return;
      }
      if (up && progress <= 0) {
        endCapture();
        return;
      }

      e.preventDefault();
      progress = Math.min(1, Math.max(0, progress + e.deltaY / extra));
      apply();
      if (lockY !== null) window.scrollTo(0, lockY);
    }

    function onScroll() {
      if (!capturing || lockY === null) return;
      if (Math.abs(window.scrollY - lockY) > 0.5) {
        window.scrollTo(0, lockY);
      }
    }

    function onResize() {
      if (capturing) endCapture();
      layout();
    }

    Array.from(track.querySelectorAll('img')).forEach((img) => {
      if (img.complete) return;
      img.addEventListener('load', onResize, { once: true });
      img.addEventListener('error', onResize, { once: true });
    });

    layout();
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('scroll', onScroll, { passive: false });
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(onResize).observe(track);
    }
  }

  function initLuagReveal() {
    const targets = Array.from(document.querySelectorAll('.luag-reveal, .luag-hero-copy'));
    if (!targets.length) return;

    if (prefersReducedMotion) {
      targets.forEach((el) => el.classList.add('is-in'));
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach((el) => el.classList.add('is-in'));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.2 }
    );
    targets.forEach((el) => io.observe(el));
  }

  function initNabiFlipbook() {
    const roots = Array.from(document.querySelectorAll('[data-nabi-flipbook]'));
    if (!roots.length) return;

    roots.forEach((root) => {
      const book = root.querySelector('[data-flipbook-book]');
      const mode = root.getAttribute('data-flip-mode') || 'cover';
      const allSheets = Array.from(root.querySelectorAll('.nabi-flipbook-sheet'));
      const sheets = allSheets.filter((s) => !s.classList.contains('nabi-flipbook-sheet--base'));
      const prevBtn = root.querySelector('.nabi-flipbook-prev');
      const nextBtn = root.querySelector('.nabi-flipbook-next');
      const meta = root.parentElement?.querySelector('[data-flipbook-meta]');
      if (!book || !sheets.length) return;

      let index = 0;
      let dragging = false;
      let startX = 0;
      let views;
      let turnable;
      let labels;

      if (mode === 'spread') {
        // Last sheet stays on the right; base sheet stays on the left
        turnable = sheets.slice(0, -1);
        views = turnable.length + 1;
        labels = [
          '1 / 3 — pages 1–2',
          '2 / 3 — pages 3–4',
          '3 / 3 — pages 5–6',
        ];
      } else {
        turnable = sheets;
        views = sheets.length + 1;
        labels = [
          '1 / 3 — cover',
          '2 / 3 — pages 2–3',
          '3 / 3 — last page',
        ];
      }

      function syncSheets() {
        const base = root.querySelector('.nabi-flipbook-sheet--base');
        if (base) {
          base.classList.add('is-flipped');
          base.style.zIndex = '1';
        }

        sheets.forEach((sheet, i) => {
          const isLast = mode === 'spread' && i === sheets.length - 1;
          const flipped = !isLast && i < index;
          sheet.classList.toggle('is-flipped', flipped);
          sheet.style.zIndex = String(flipped ? i + 2 : sheets.length - i + 3);
        });

        book.dataset.view = String(index);
        book.dataset.mode = mode;
      }

      function updateUI() {
        syncSheets();
        if (prevBtn) prevBtn.disabled = index <= 0;
        if (nextBtn) nextBtn.disabled = index >= views - 1;
        if (meta) {
          const label = labels[index] || `${index + 1} / ${views}`;
          meta.textContent = `${label} — click or drag to flip`;
        }
      }

      function goTo(next) {
        index = Math.max(0, Math.min(views - 1, next));
        updateUI();
      }

      function flipNext() {
        if (index < views - 1) goTo(index + 1);
      }

      function flipPrev() {
        if (index > 0) goTo(index - 1);
      }

      function sheetForDrag(dx) {
        if (dx < 0 && index < views - 1) return turnable[index] || null;
        if (dx > 0 && index > 0) return turnable[index - 1] || null;
        return null;
      }

      prevBtn?.addEventListener('click', flipPrev);
      nextBtn?.addEventListener('click', flipNext);

      book.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        book.setPointerCapture?.(e.pointerId);
      });

      book.addEventListener('pointermove', (e) => {
        if (!dragging || prefersReducedMotion) return;
        const dx = e.clientX - startX;
        const sheet = sheetForDrag(dx);
        sheets.forEach((s) => {
          s.classList.remove('is-dragging');
          s.style.transform = '';
        });
        if (!sheet) return;
        const width = (book.clientWidth || 1) * 0.5;
        sheet.classList.add('is-dragging');
        if (dx < 0) {
          const deg = Math.max(-180, (dx / width) * 180);
          sheet.style.transform = `rotateY(${deg}deg)`;
        } else {
          const deg = Math.min(0, -180 + (dx / width) * 180);
          sheet.style.transform = `rotateY(${deg}deg)`;
        }
      });

      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        const dx = e.clientX - startX;
        const threshold = Math.min(70, (book.clientWidth || 320) * 0.12);

        sheets.forEach((sheet) => {
          sheet.classList.remove('is-dragging');
          sheet.style.transform = '';
        });

        if (dx < -threshold) flipNext();
        else if (dx > threshold) flipPrev();
        else if (Math.abs(dx) < 8) {
          const rect = book.getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          if (e.clientX >= mid) flipNext();
          else flipPrev();
        } else {
          updateUI();
        }
      }

      book.addEventListener('pointerup', endDrag);
      book.addEventListener('pointercancel', endDrag);

      root.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          flipNext();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          flipPrev();
        }
      });
      root.tabIndex = 0;

      updateUI();
    });
  }

  initPhotoCarousel();
  initPhotoLightbox();
  initUmamiFlavorCarousel();
  initLuagReveal();
  initNabiFlipbook();
  initCustomCursor();
  initResumePreview();
  initIgProfile();
  initIgPost();
  initCaseNav();
})();

function initCaseNav() {
  const nav = document.getElementById('caseNav');
  if (!nav) return;

  const links = Array.from(nav.querySelectorAll('[data-case-nav]'));
  const sections = links
    .map((link) => document.getElementById(link.getAttribute('data-case-nav')))
    .filter(Boolean);

  if (!links.length || !sections.length) return;

  function setActive(id) {
    links.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('data-case-nav') === id);
    });
  }

  function updateActive() {
    const offset = 120;
    let current = sections[0]?.id || '';
    sections.forEach((section) => {
      const top = section.getBoundingClientRect().top;
      if (top - offset <= 0) current = section.id;
    });
    if (current) setActive(current);
  }

  links.forEach((link) => {
    link.addEventListener('click', () => {
      const id = link.getAttribute('data-case-nav');
      if (id) setActive(id);
    });
  });

  window.addEventListener('scroll', updateActive, { passive: true });
  window.addEventListener('resize', updateActive);
  updateActive();
}

function initIgProfile() {
  const followBtn = document.getElementById('igFollow');
  const messageBtn = document.getElementById('igMessage');
  const thanksDialog = document.getElementById('igThanksDialog');
  const mailDialog = document.getElementById('igMailDialog');
  const mailYes = document.getElementById('igMailYes');
  if (!followBtn && !messageBtn) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mailTo = 'mailto:hada031114@gmail.com';
  let thanksTimer = 0;

  function openDialog(dialog) {
    if (!dialog) return;
    dialog.classList.add('is-open');
    dialog.setAttribute('aria-hidden', 'false');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    dialog.classList.remove('is-open');
    dialog.setAttribute('aria-hidden', 'true');
  }

  function burstConfetti(origin) {
    if (prefersReducedMotion) return;
    const rect = origin.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const canvas = document.createElement('canvas');
    canvas.className = 'ig-confetti';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      return;
    }

    function sizeCanvas() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    sizeCanvas();

    const colors = ['#8c4a97', '#6f3a7c', '#c989d1', '#e7c7ee', '#fffcf2', '#d4a0c8'];
    const pieces = Array.from({ length: 110 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 9;
      return {
        x: startX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4,
        w: 6 + Math.random() * 7,
        h: 8 + Math.random() * 10,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1,
      };
    });

    const started = performance.now();
    function tick(now) {
      const elapsed = now - started;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach((p) => {
        p.vy += 0.18;
        p.vx *= 0.992;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life = Math.max(0, 1 - elapsed / 1800);
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (elapsed < 1800) {
        requestAnimationFrame(tick);
      } else {
        canvas.remove();
      }
    }
    requestAnimationFrame(tick);
    window.addEventListener('resize', sizeCanvas, { once: true });
  }

  if (followBtn && thanksDialog) {
    let hasCelebrated = false;
    followBtn.addEventListener('click', () => {
      const isFollowing = followBtn.classList.contains('is-following');
      if (isFollowing) {
        followBtn.classList.remove('is-following');
        followBtn.textContent = 'Follow';
        return;
      }

      followBtn.classList.add('is-following');
      followBtn.textContent = 'Following';
      if (hasCelebrated) return;
      hasCelebrated = true;
      burstConfetti(followBtn);
      openDialog(thanksDialog);
      window.clearTimeout(thanksTimer);
      thanksTimer = window.setTimeout(() => closeDialog(thanksDialog), 1000);
    });
    thanksDialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-ig-thanks-close]') || e.target.closest('.ig-dialog-card')) {
        closeDialog(thanksDialog);
      }
    });
  }

  if (messageBtn && mailDialog) {
    messageBtn.addEventListener('click', () => {
      openDialog(mailDialog);
      if (mailYes) mailYes.focus();
    });
    mailDialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-ig-mail-close]')) closeDialog(mailDialog);
    });
    if (mailYes) {
      mailYes.addEventListener('click', () => {
        closeDialog(mailDialog);
        window.location.href = mailTo;
      });
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeDialog(thanksDialog);
    closeDialog(mailDialog);
  });
}

function initResumePreview() {
  const openBtn = document.getElementById('resumePreviewOpen');
  const modal = document.getElementById('resumePreview');
  const frame = document.getElementById('resumePreviewFrame');
  if (!openBtn || !modal || !frame) return;

  const pdfUrl = openBtn.getAttribute('data-resume-src') || 'assets/Dayna_HA_Resume.pdf';
  let loaded = false;

  function openPreview(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!loaded) {
      frame.src = `${pdfUrl}#view=FitH`;
      loaded = true;
    }
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closePreview() {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  openBtn.addEventListener('click', openPreview);
  modal.querySelectorAll('[data-resume-close]').forEach((el) => {
    el.addEventListener('click', closePreview);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) closePreview();
  });
}

function initIgPost() {
  const triggers = Array.from(document.querySelectorAll('[data-ig-post]'));
  const panel = document.getElementById('igPostPanel');
  const panelImg = document.getElementById('igPostImage');
  const panelVideo = document.getElementById('igPostVideo');
  const prevBtn = document.getElementById('igPostPrev');
  const nextBtn = document.getElementById('igPostNext');
  if (!triggers.length || !panel || !panelImg) return;

  let slides = [];
  let index = 0;
  let activeTrigger = null;
  let videoOnly = false;

  function stopVideo() {
    if (!panelVideo) return;
    panelVideo.pause();
    panelVideo.removeAttribute('src');
    panelVideo.load();
    panelVideo.hidden = true;
  }

  function showAt(i) {
    if (!slides.length) return;
    index = (i + slides.length) % slides.length;
    const slide = slides[index];
    const isVid = slide.tagName === 'VIDEO';

    panel.classList.toggle('is-showing-video', isVid);

    if (isVid && panelVideo) {
      panelImg.removeAttribute('src');
      panelImg.alt = '';
      panelImg.hidden = true;
      panelVideo.hidden = false;
      const nextSrc = slide.getAttribute('src') || slide.currentSrc || slide.src;
      panelVideo.src = nextSrc;
      panelVideo.currentTime = 0;
      const playPromise = panelVideo.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } else {
      stopVideo();
      panelImg.hidden = false;
      panelImg.src = slide.currentSrc || slide.src;
      panelImg.alt = slide.alt || '';
    }
  }

  function openFrom(trigger) {
    const id = trigger.getAttribute('data-ig-post');
    const slidesRoot = document.getElementById(`igPostSlides-${id}`);
    if (!slidesRoot) return;

    slides = Array.from(slidesRoot.querySelectorAll('img, video'));
    if (!slides.length) return;

    videoOnly = slides.length === 1 && slides[0].tagName === 'VIDEO';
    activeTrigger = trigger;
    panel.classList.toggle('is-video-only', videoOnly);
    panel.classList.remove('is-showing-video');

    showAt(0);
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (!videoOnly && nextBtn) nextBtn.focus();
    else if (panelVideo) panelVideo.focus();
  }

  function close() {
    if (!panel.classList.contains('is-open')) return;
    panel.classList.remove('is-open');
    panel.classList.remove('is-video-only');
    panel.classList.remove('is-showing-video');
    panel.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    stopVideo();
    if (activeTrigger) activeTrigger.focus();
  }

  function step(delta) {
    if (!panel.classList.contains('is-open') || videoOnly) return;
    showAt(index + delta);
  }

  triggers.forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      openFrom(trigger);
    });
  });

  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      step(-1);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      step(1);
    });
  }

  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-ig-post-close]')) close();
  });

  window.addEventListener('keydown', (e) => {
    if (!panel.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    }
  });
}
