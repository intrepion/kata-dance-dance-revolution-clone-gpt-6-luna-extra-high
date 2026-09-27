(() => {
  "use strict";

  const BPM = 128;
  const BEAT = 60 / BPM;
  const BEATS = 64;
  const SONG_LENGTH = BEAT * BEATS;
  const APPROACH = 1.9;
  const HIT_LINE = 0.8;
  const WINDOWS = { perfect: 0.055, great: 0.105, good: 0.16 };
  const ARROWS = ["←", "↓", "↑", "→"];
  const KEY_LANES = { ArrowLeft: 0, a: 0, A: 0, ArrowDown: 1, s: 1, S: 1, ArrowUp: 2, w: 2, W: 2, ArrowRight: 3, d: 3, D: 3 };
  const $ = (id) => document.getElementById(id);
  const field = $("playfield");
  const laneEls = [...document.querySelectorAll(".lane")];
  const receptorEls = [...document.querySelectorAll(".receptor")];
  const difficultyButtons = [...document.querySelectorAll(".chart-option")];
  const touchButtons = [...document.querySelectorAll("[data-touch-lane]")];
  const chartSettings = {
    basic: { label: "BASIC", multiplier: 1, subdivisions: false },
    standard: { label: "STANDARD", multiplier: 1.28, subdivisions: true },
    expert: { label: "EXPERT", multiplier: 1.55, subdivisions: true },
  };

  let difficulty = "basic";
  let chart = [];
  let noteElements = [];
  let state = "ready";
  let audioContext = null;
  let masterGain = null;
  let songStart = 0;
  let pauseAt = 0;
  let audioTick = null;
  let raf = 0;
  let lastMusicBeat = -1;
  let lastVisualBeat = -1;
  let lastJudgementTimer = 0;
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let life = 100;
  let hits = { perfect: 0, great: 0, good: 0, miss: 0 };
  let best = 0;
  let fieldHeight = 0;
  let resizeObserver;

  function seededRandom(seed) {
    let value = seed >>> 0;
    return () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 4294967296;
    };
  }

  function generateChart(level) {
    const config = chartSettings[level];
    const random = seededRandom(92817);
    const notes = [];
    let previousLane = -1;
    for (let beat = 4; beat < BEATS; beat += 1) {
      const phrase = Math.floor(beat / 8);
      const lane = (beat + phrase + (random() < 0.3 ? 1 : 0)) % 4;
      const shouldStep = level === "basic" ? beat % 5 !== 3 : random() < (level === "standard" ? 0.93 : 0.99);
      if (shouldStep) {
        const safeLane = lane === previousLane && beat % 4 !== 0 ? (lane + 1 + Math.floor(random() * 2)) % 4 : lane;
        notes.push({ beat, lane: safeLane, hit: false, missed: false });
        previousLane = safeLane;
      }
      if (config.subdivisions && beat > 3 && beat < 61 && (level === "expert" ? random() < 0.48 : random() < 0.24)) {
        let extraLane = Math.floor(random() * 4);
        if (extraLane === previousLane) extraLane = (extraLane + 1) % 4;
        notes.push({ beat: beat + 0.5, lane: extraLane, hit: false, missed: false });
        previousLane = extraLane;
      }
      if (level !== "basic" && beat % (level === "expert" ? 8 : 16) === 6 && random() > 0.35) {
        let chordLane = (lane + 2) % 4;
        if (chordLane === previousLane) chordLane = (chordLane + 1) % 4;
        notes.push({ beat, lane: chordLane, hit: false, missed: false });
      }
    }
    notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane);
    const seen = new Set();
    for (const note of notes) {
      const key = `${note.beat}:${note.lane}`;
      if (seen.has(key)) note.duplicate = true;
      seen.add(key);
    }
    return notes.filter((note) => !note.duplicate).map((note, index) => ({ ...note, id: index, time: note.beat * BEAT }));
  }

  function installChart(level) {
    difficulty = level;
    chart = generateChart(level);
    $("difficulty-label").innerHTML = `${chartSettings[level].label} <b>${level === "basic" ? "●●○" : level === "standard" ? "●●●" : "●●●●"}</b>`;
    $("note-total").textContent = chart.length;
    $("chart-combo").textContent = chart.length;
    let stream = 0;
    let longestStream = 0;
    let previousBeat = null;
    for (const note of chart) {
      stream = previousBeat === null || note.beat - previousBeat > 1.01 ? 1 : stream + 1;
      longestStream = Math.max(longestStream, stream);
      previousBeat = note.beat;
    }
    $("chart-stream").textContent = longestStream;
    difficultyButtons.forEach((button) => {
      const selected = button.dataset.difficulty === level;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    clearNotes();
    resetStats();
  }

  function clearNotes() {
    noteElements.forEach((entry) => entry.element.remove());
    noteElements = [];
  }

  function resetStats() {
    score = 0;
    combo = 0;
    maxCombo = 0;
    life = 100;
    hits = { perfect: 0, great: 0, good: 0, miss: 0 };
    updateHud();
  }

  function updateHud() {
    $("score").textContent = String(score).padStart(7, "0");
    $("best-score").textContent = String(best).padStart(7, "0");
    $("combo").innerHTML = `${String(combo).padStart(2, "0")}<span>×</span>`;
    $("combo-caption").textContent = combo === 0 ? "BUILD YOUR STREAK" : combo >= 32 ? "UNSTOPPABLE!" : combo >= 16 ? "ON FIRE!" : "KEEP IT GOING";
    $("combo-meter-fill").style.width = `${Math.min(100, combo * 2)}%`;
    $("perfect-count").textContent = hits.perfect;
    $("great-count").textContent = hits.great;
    $("good-count").textContent = hits.good;
    $("miss-count").textContent = hits.miss;
    $("life-fill").style.width = `${life}%`;
    $("life-fill").style.background = life > 40 ? "linear-gradient(90deg,#4cdbd4,#b4ed64)" : life > 20 ? "linear-gradient(90deg,#ffd95d,#fa873e)" : "linear-gradient(90deg,#fa6a59,#ed337d)";
    $("life-text").textContent = `${Math.round(life)}%`;
  }

  function makeAudio() {
    if (audioContext) return;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    audioContext = new AudioCtor();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.22;
    masterGain.connect(audioContext.destination);
  }

  function tone(frequency, start, duration, type = "sine", volume = 0.15, endFrequency = frequency) {
    if (!audioContext || !masterGain) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.012, duration / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(masterGain);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.015);
  }

  function drum(start, kind) {
    if (!audioContext || !masterGain) return;
    if (kind === "kick") {
      tone(135, start, 0.19, "sine", 0.55, 42);
      return;
    }
    if (kind === "snare") {
      tone(185, start, 0.11, "triangle", 0.13, 105);
      const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * 0.12), audioContext.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const noise = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      noise.buffer = buffer;
      filter.type = "highpass";
      filter.frequency.value = 1100;
      gain.gain.setValueAtTime(0.18, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
      noise.connect(filter).connect(gain).connect(masterGain);
      noise.start(start);
      noise.stop(start + 0.13);
      return;
    }
    tone(8000, start, 0.035, "square", 0.025, 2400);
  }

  function startMusic(resuming = false) {
    if (!audioContext) {
      if (!resuming) songStart = performance.now() / 1000;
      return;
    }
    if (!resuming) {
      songStart = audioContext.currentTime + 0.075;
      lastMusicBeat = -1;
    } else {
      const elapsed = audioContext.currentTime - songStart;
      lastMusicBeat = Math.floor(elapsed / BEAT);
    }
    clearInterval(audioTick);
    const scale = [0, 3, 7, 10, 12, 10, 7, 3];
    const bassRoot = 55;
    function schedule() {
      if (state !== "playing") return;
      const elapsed = audioContext.currentTime - songStart;
      if (elapsed >= SONG_LENGTH + 0.15) {
        clearInterval(audioTick);
        return;
      }
      const from = Math.max(0, Math.floor(elapsed / BEAT) - 1);
      const to = Math.min(BEATS, Math.floor((elapsed + 0.16) / BEAT));
      for (let beat = from; beat <= to; beat += 1) {
        if (beat <= lastMusicBeat || beat > BEATS) continue;
        lastMusicBeat = beat;
        const t = songStart + beat * BEAT;
        if (beat % 4 === 0) drum(t, "kick");
        else if (beat % 4 === 2) drum(t, "snare");
        else drum(t, "hat");
        const bass = bassRoot * Math.pow(2, scale[Math.floor(beat / 2) % scale.length] / 12);
        if (beat % 2 === 0) tone(bass, t, 0.28, "triangle", 0.045, bass);
        const melody = 392 * Math.pow(2, scale[(beat + Math.floor(beat / 8)) % scale.length] / 12);
        tone(melody, t + 0.025, 0.13, "square", 0.018, melody);
        if (chartSettings[difficulty].subdivisions && beat < BEATS) {
          tone(melody * 1.5, t + BEAT / 2, 0.12, "square", 0.019, melody * 1.5);
        }
      }
    }
    schedule();
    audioTick = setInterval(schedule, 45);
  }

  function stopMusic() {
    clearInterval(audioTick);
    audioTick = null;
  }

  function syncField() {
    fieldHeight = field.clientHeight;
    document.documentElement.style.setProperty("--hit-line", `${Math.round(fieldHeight * HIT_LINE)}px`);
  }

  function createNotes() {
    clearNotes();
    for (const note of chart) {
      const element = document.createElement("div");
      element.className = "note";
      element.textContent = ARROWS[note.lane];
      element.dataset.id = note.id;
      element.style.setProperty("--lane", ["#4ce6e0", "#79a7ff", "#c77bff", "#fb4b91"][note.lane]);
      element.style.setProperty("--lane-rgb", ["76,230,224", "121,167,255", "199,123,255", "251,75,145"][note.lane]);
      laneEls[note.lane].appendChild(element);
      noteElements.push({ note, element });
    }
  }

  function beginCountdown() {
    if (state === "playing" || state === "countdown") return;
    state = "countdown";
    songStart = 0;
    lastVisualBeat = -1;
    $("intro-overlay").classList.add("hidden");
    $("result-overlay").classList.add("hidden");
    $("pause-overlay").classList.add("hidden");
    $("countdown").classList.remove("hidden");
    $("countdown").textContent = "3";
    resetStats();
    createNotes();
    syncField();
    makeAudio();
    if (audioContext && audioContext.state === "suspended") audioContext.resume();
    let count = 3;
    const countdownTimer = setInterval(() => {
      count -= 1;
      if (count > 0) {
        $("countdown").textContent = String(count);
      } else {
        clearInterval(countdownTimer);
        $("countdown").textContent = "GO!";
        window.setTimeout(() => {
          if (state !== "countdown") return;
          $("countdown").classList.add("hidden");
          state = "playing";
          startMusic();
          raf = requestAnimationFrame(frame);
        }, 430);
      }
    }, 700);
  }

  function pauseGame() {
    if (state !== "playing") return;
    state = "paused";
    pauseAt = audioContext ? audioContext.currentTime : performance.now() / 1000;
    stopMusic();
    cancelAnimationFrame(raf);
    $("pause-overlay").classList.remove("hidden");
  }

  function resumeGame() {
    if (state !== "paused") return;
    $("pause-overlay").classList.add("hidden");
    if (pauseAt) {
      const duration = audioContext ? audioContext.currentTime - pauseAt : performance.now() / 1000 - pauseAt;
      songStart += duration;
    }
    state = "playing";
    if (audioContext && audioContext.state === "suspended") audioContext.resume();
    startMusic(songStart > 0);
    pauseAt = 0;
    raf = requestAnimationFrame(frame);
  }

  function showJudgement(name, lane) {
    const label = $("hit-label");
    clearTimeout(lastJudgementTimer);
    label.className = `hit-label ${name} show`;
    label.textContent = name.toUpperCase();
    laneEls[lane].classList.add("is-hit");
    receptorEls[lane].classList.add("is-lit");
    window.setTimeout(() => {
      laneEls[lane].classList.remove("is-hit");
      receptorEls[lane].classList.remove("is-lit");
    }, 120);
    lastJudgementTimer = window.setTimeout(() => { label.className = "hit-label"; }, 650);
  }

  function onMiss(note) {
    note.missed = true;
    const entry = noteElements[note.id];
    if (entry) entry.element.classList.add("missed");
    hits.miss += 1;
    combo = 0;
    life = Math.max(0, life - 4.2);
    updateHud();
    showJudgement("miss", note.lane);
  }

  function tap(lane) {
    if (state !== "playing") return;
    const now = (audioContext ? audioContext.currentTime : performance.now() / 1000) - songStart;
    let target = null;
    let delta = Infinity;
    for (const note of chart) {
      if (note.hit || note.missed || note.lane !== lane) continue;
      const difference = Math.abs(note.time - now);
      if (difference < delta) { delta = difference; target = note; }
    }
    if (!target || delta > WINDOWS.good) {
      receptorEls[lane].classList.add("is-lit");
      window.setTimeout(() => receptorEls[lane].classList.remove("is-lit"), 75);
      return;
    }
    target.hit = true;
    const entry = noteElements[target.id];
    if (entry) entry.element.classList.add("hit");
    let judgement;
    let points;
    if (delta <= WINDOWS.perfect) { judgement = "perfect"; points = 1000; }
    else if (delta <= WINDOWS.great) { judgement = "great"; points = 700; }
    else { judgement = "good"; points = 400; }
    hits[judgement] += 1;
    combo += 1;
    maxCombo = Math.max(maxCombo, combo);
    score += Math.round(points * chartSettings[difficulty].multiplier + Math.min(combo, 100) * 10);
    life = Math.min(100, life + (judgement === "perfect" ? 0.6 : 0.3));
    updateHud();
    showJudgement(judgement, lane);
    if (score > best) {
      best = score;
      try { localStorage.setItem("pulse-step-best", String(best)); } catch { /* Local score still works when storage is unavailable. */ }
      $("best-score").textContent = String(best).padStart(7, "0");
    }
    if (life <= 0) finishGame(true);
  }

  function frame() {
    if (state !== "playing") return;
    const elapsed = (audioContext ? audioContext.currentTime : performance.now() / 1000) - songStart;
    if (!fieldHeight) syncField();
    for (const entry of noteElements) {
      const { note, element } = entry;
      if (note.hit || note.missed) continue;
      const delta = note.time - elapsed;
      if (delta < -WINDOWS.good) {
        onMiss(note);
        continue;
      }
      const progress = 1 - delta / APPROACH;
      const y = Math.max(-15, Math.min(fieldHeight + 40, progress * fieldHeight * HIT_LINE));
      element.style.top = `${y}px`;
    }
    if (life <= 0) {
      finishGame(true);
      return;
    }
    const fraction = Math.max(0, Math.min(1, elapsed / SONG_LENGTH));
    $("progress-fill").style.width = `${fraction * 100}%`;
    $("time-current").textContent = formatTime(elapsed);
    const beat = Math.floor(elapsed / BEAT);
    if (beat !== lastVisualBeat && beat >= 0 && beat < BEATS) {
      lastVisualBeat = beat;
      $("beat-flash").classList.remove("on");
      void $("beat-flash").offsetWidth;
      $("beat-flash").classList.add("on");
    }
    if (elapsed >= SONG_LENGTH + WINDOWS.good) {
      finishGame(false);
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function finishGame(failed) {
    state = "finished";
    stopMusic();
    cancelAnimationFrame(raf);
    for (const note of chart) if (!note.hit && !note.missed) onMiss(note);
    const total = chart.length;
    const accuracy = total ? Math.round(((hits.perfect + hits.great * 0.75 + hits.good * 0.4) / total) * 100) : 0;
    const grade = accuracy >= 95 ? "AAA" : accuracy >= 87 ? "AA" : accuracy >= 74 ? "A" : accuracy >= 58 ? "B" : accuracy >= 40 ? "C" : "D";
    $("result-title").textContent = failed ? "KEEP PRACTICING." : accuracy >= 90 ? "FLOOR DESTROYED." : "NICE MOVES.";
    $("result-grade").textContent = failed ? "F" : grade;
    $("result-score").textContent = score.toLocaleString();
    $("result-combo").textContent = maxCombo;
    $("result-accuracy").textContent = `${accuracy}%`;
    $("result-overlay").classList.remove("hidden");
  }

  function setDifficulty(button) {
    if (state === "playing" || state === "countdown" || state === "paused") return;
    installChart(button.dataset.difficulty);
  }

  document.addEventListener("keydown", (event) => {
    const lane = KEY_LANES[event.key];
    if (lane !== undefined) {
      event.preventDefault();
      if (!event.repeat) tap(lane);
      return;
    }
    if (event.key === "Enter" && (state === "ready" || state === "finished")) beginCountdown();
    if (event.key === "Escape" || event.key.toLowerCase() === "p") {
      if (state === "playing" || state === "countdown") pauseGame();
      else if (state === "paused") resumeGame();
    }
  });

  document.addEventListener("keyup", (event) => {
    const lane = KEY_LANES[event.key];
    if (lane !== undefined) receptorEls[lane].classList.remove("is-lit");
  });

  $("start-button").addEventListener("click", beginCountdown);
  $("replay-button").addEventListener("click", beginCountdown);
  $("pause-button").addEventListener("click", () => state === "paused" ? resumeGame() : pauseGame());
  $("resume-button").addEventListener("click", resumeGame);
  difficultyButtons.forEach((button) => button.addEventListener("click", () => setDifficulty(button)));
  touchButtons.forEach((button) => {
    const lane = Number(button.dataset.touchLane);
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.classList.add("is-pressed"); tap(lane); });
    for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(eventName, () => button.classList.remove("is-pressed"));
  });
  window.addEventListener("resize", syncField);
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(syncField);
    resizeObserver.observe(field);
  }
  try { best = Number(localStorage.getItem("pulse-step-best") || 0); } catch { best = 0; }
  if (document.hidden) pauseAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "playing") pauseGame();
  });

  $("time-total").textContent = formatTime(SONG_LENGTH);
  $("best-score").textContent = String(best).padStart(7, "0");
  installChart("basic");
  syncField();
})();
