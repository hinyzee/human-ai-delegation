const demoReady = true;
const demoParticipantId = null;
const demoAuthReady = false;

// Session start time for relative timestamps (0-based)
const sessionStartTime = Date.now();

/* =========================================================
  Experiment params (default values; overridden per block)
  ========================================================= */
const params = {
  nLanes: 1,
  nPackages: 1,
  stepsToComplete: 12,
  robotMoveCooldownMs: 2000,
  humanMoveCooldownMs: 2000,
  robotErrorsPerPackage: 0,
  humanErrorsPerPackage: 0,
  nRobotLanes: 0,
  isRobotMode: false
};

/* =========================================================
   Data Manager Helper
   ========================================================= */
const DB = {
  // Base path for this user
  get base() { return `${studyId}/participantData/${demoParticipantId}`; },

  // Standard metadata injected into every save
  get meta() {
    return {
      timestamp: Date.now() - sessionStartTime, // Relative to session start
      userId: demoParticipantId
    };
  },

  // Generic save function
  async save() {},

  // Specific shortcuts
  async logConsent(agreed) {
    await this.save('consent', { 
      agreed,
      blockOrder: blockSequence, // Log the randomized block order
      buttonOrderHumanFirst: buttonOrderHumanFirst // Log the randomized button order
    });
  },
  
  async logTutorialComplete() {
    await this.save('tutorial', { completed: true });
  },

  async logAllocation(round, block, mode) {
    await this.save(`rounds/round${round}/allocation`, {
      roundIndex: round,
      blockIndex: block,
      isRobotMode: mode,
      robotSpeed: params.robotMoveCooldownMs,
      humanSpeed: params.humanMoveCooldownMs
    });
  },

  async logRoundStart(round, block, mode) {
    await this.save(`rounds/round${round}/start`, {
      roundIndex: round,
      blockIndex: block,
      isRobotMode: mode,
      config: { ...params }, // Save all current params at once
      errorPositions: pkgs.map((p, i) => ({ lane: i, errorSteps: p.errorSteps }))
    });
  },

  async logRoundResult(round, metrics, events) {
    await this.save(`rounds/round${round}/result`, {
      roundIndex: round,
      metrics,
      events
    });
  },

  async logStudyCompletion() {}
};

/* =========================================================
   Study meta
   ========================================================= */
// Parse studyId from URL, fallback to default
const urlParams = new URLSearchParams(window.location.search);
const studyId = urlParams.get('STUDY_ID') || urlParams.get('studyId') || 'delegation_study';
console.info('[Study] Study ID:', studyId);

let roundIndex = 0; // Start at 0 for practice round
const totalRounds = 16;

// Randomize block order (which block comes first)
const blockSequence = Math.random() < 0.5 ? [1, 2] : [2, 1];
let currentBlock = blockSequence[0]; // Start with the first block in the sequence

// Randomize button order (Human first vs Robot first in allocation UI)
const buttonOrderHumanFirst = Math.random() < 0.5;

let hasSeenTutorial = false; // Track if tutorial has been shown
let isPracticeRound = true; // Track if this is the practice round

console.info('[Experiment] Block Sequence:', blockSequence, 'Starting with Block:', currentBlock);
console.info('[Experiment] Button Order:', buttonOrderHumanFirst ? 'Human First' : 'Robot First');

/* ---------------------------------------------------------
   CONDITION: TIME CONSTANT, EFFORT VARIES (CROSSED DESIGN)
   - Same total completion time: 24s for both agents in both blocks
   - Effort varies: Robot requires error supervision (2 clicks per error)
                    Human requires manual pushes (1 click per step)
   
   Block 1: Robot HIGH effort (10 clicks), Human LOW effort (4 clicks)
   Block 2: Robot LOW effort (4 clicks), Human HIGH effort (10 clicks)
   
   Design is CROSSED and BALANCED:
   - Time is constant across agents and blocks (24s)
   - High effort agent always requires 10 clicks
   - Low effort agent always requires 4 clicks
   - Click difference: 6 clicks
   --------------------------------------------------------- */
const BLOCKS = {
  1: {
    // Robot HIGH effort, Human LOW effort
    nLanes: 1,
    stepsToComplete: 4,           // 4 steps for human (4 push clicks)
    robotMoveCooldownMs: 6000,   
    humanMoveCooldownMs: 8000,    
    robotErrorsPerPackage: 6,     // Robot: 6 errors × 2 clicks = 12 clicks (HIGH)
    humanErrorsPerPackage: 0      
  },
  2: {
    // Robot LOW effort, Human HIGH effort
    nLanes: 1,
    stepsToComplete: 12,          // 12 steps for human (12 push clicks)
    robotMoveCooldownMs: 2000,    // Robot: 24s total (12 × 2000ms)
    humanMoveCooldownMs: 2000,    // Human: 24s total (12 × 2000ms)
    robotErrorsPerPackage: 2,     // Robot: 2 errors × 2 clicks = 4 clicks (LOW)
    humanErrorsPerPackage: 0      // Human: 12 push clicks (HIGH)
  }
};


const MSG_ERR  = "Dropped! Click to Fix";
const MSG_DONE = "delivered";

/* relative robot icon placement */
const ROBOT_GAP_PCT      = 0.6;
const ROBOT_Y_OFFSET_PCT = 0;

/* =========================================================
   DOM refs
   ========================================================= */
let fieldWrap, fieldBox, controlsCol;
let allocOverlay, allocOptionsContainer, allocContinue;
let roundBanner, restartBtn;
let consentOverlay, consentCheckbox, consentAgreeBtn;

// Control panel elements
let btnHumanPush;
let actionSection; // For dynamic color theming

// Tutorial instance (for checking tutorial state during slider changes)
let tutorialIntro = null;

/* =========================================================
   State
   ========================================================= */
let running = false;
let rafId = null;

let pkgs = [];          // per-lane package states
let lanes = [];         // lane elements
let finishDots = [];    // finish dots

let robot = null;                 // {fieldEl, nextMoveAt}
let robotActualLane = null;       // current robot lane index

let human = null;                 // {fieldEl} - single human icon
let humanActualLane = null;       // current human lane index

let roundStartMs = null;
let humanGlobalCooldownUntil = 0; // mute ALL human buttons until this time
let manualNextMoveAt = [];        // per-lane human cooldowns (timestamps)

// Event tracking for detailed analytics
let eventLog = [];                // stores all events during a round
let errorEventLog = [];           // stores error-specific events
let clickEventLog = [];           // stores all user clicks

// Q1, Q2, Q3 tracking variables
let humanFinishTime = null;       // Q2: When human completes their lanes (ms from round start)
let robotFinishTime = null;       // Q2: When robot completes its lanes (ms from round start)
let humanPushCount = 0;           // Q3: Count of push clicks
let humanFixCount = 0;            // Q3: Count of error fixes

// Sequential work flow tracking
let workPhase = 'manual';         // 'manual' | 'robot' | 'complete'

/* small diagnostics */
window.addEventListener('error',  e => console.error('[WindowError]', e.message));
window.addEventListener('unhandledrejection', e => console.error('[PromiseRejection]', e.reason));

/* =========================================================
   Optimal allocation calculator (for Q1)
   ========================================================= */
function calculateOptimalAllocation() {
  // Balance total completion time, but favor human work slightly
  // This creates a preference for keeping more control
  
  const totalLanes = params.nLanes;
  const stepsPerLane = params.stepsToComplete;
  const robotSpeed = params.robotMoveCooldownMs;
  const humanSpeed = params.humanMoveCooldownMs;
  
  let bestAllocation = 0;
  let bestMaxTime = Infinity;
  
  for (let k = 0; k <= totalLanes; k++) {
    const robotTime = k * stepsPerLane * robotSpeed;
    const humanTime = (totalLanes - k) * stepsPerLane * humanSpeed;
    const maxTime = Math.max(robotTime, humanTime);
    
    // Add a small penalty to robot allocation to favor human work
    // 5% penalty per robot lane makes optimal favor human by 1-2 lanes
    const robotPenalty = k * robotSpeed * stepsPerLane * 0.05;
    const adjustedTime = maxTime + robotPenalty;
    
    if (adjustedTime < bestMaxTime) {
      bestMaxTime = adjustedTime;
      bestAllocation = k;
    }
  }
  
  return bestAllocation;
}

function getDeviationFromOptimal() {
  const optimal = calculateOptimalAllocation();
  const chosen = params.nRobotLanes;
  return {
    optimal,
    chosen,
    deviation: chosen - optimal,
    overDelegated: chosen > optimal
  };
}

/* =========================================================
   Event Logging Helper
   ========================================================= */
function logEvent(eventType, data = {}) {
  const now = performance.now();
  const timestamp = Date.now() - sessionStartTime; // Relative to session start
  const elapsed = roundStartMs ? now - roundStartMs : 0;
  
  const event = {
    timestamp,
    eventType,
    elapsedMs: Math.round(elapsed),
    roundIndex,
    ...data
  };
  
  eventLog.push(event);
  
  // Also categorize specific event types
  if (eventType.includes('click')) {
    clickEventLog.push(event);
  }
  if (eventType.includes('error')) {
    errorEventLog.push(event);
  }
  
  return event;
}

/* =========================================================
   Layout helpers
   ========================================================= */
const layout = (() => {
  let startPct = 0, endPct = 0, pkgStartPct = 0;
  const toPct = (v) => parseFloat(String(v || "0").replace("%", "")) || 0;

  function recompute() {
    const rs    = getComputedStyle(document.documentElement);
    const padL  = toPct(rs.getPropertyValue("--pad-l"));
    const padR  = toPct(rs.getPropertyValue("--pad-r"));
    const zoneW = toPct(rs.getPropertyValue("--zone-w"));
    const pkgL  = toPct(rs.getPropertyValue("--pkg-left"));
    startPct = padL;
    endPct   = 100 - (zoneW + padR);
    const minStart = startPct + 3.6 + ROBOT_GAP_PCT + 0.2;
    pkgStartPct = Math.max(pkgL, minStart);
  }
  function get() { return { startPct, endPct, pkgStartPct }; }
  return { recompute, get };
})();

function sizeField() {
  if (!fieldWrap || !fieldBox) return;
  const rs = getComputedStyle(document.documentElement);
  const W = (rs.getPropertyValue('--field-fixed-w').trim() || '1200px');
  const H = (rs.getPropertyValue('--field-fixed-h').trim() || '675px');
  fieldBox.style.width  = W;
  fieldBox.style.height = H;
}

function syncControlsPanel() {
  if (!controlsCol || !fieldBox) return;
  const fb = fieldBox.getBoundingClientRect();
  controlsCol.style.height = fb.height + "px";
}

/* =========================================================
   Build / Reset
   ========================================================= */
function clearField() {
  if (!fieldBox) return;
  fieldBox.querySelectorAll(".lane,.finish-dot,.package,.field-robot,.field-human,.err-bubble,.note-bubble,.delivery-zone-label").forEach(n => n.remove());
  pkgs = []; lanes = []; finishDots = [];
}

function buildField() {
  clearField();
  const { pkgStartPct } = layout.get();
  const L = params.nLanes;
  // Center single lane at 50% vertically
  const topMin = (L === 1) ? 50 : 15;
  const topMax = (L === 1) ? 50 : 95;
  const step = (L > 1) ? (topMax - topMin) / (L - 1) : 0;

  // Add delivery zone label bubble
  const zoneLabel = document.createElement("div");
  zoneLabel.className = "delivery-zone-label";
  const labelText = document.createElement("span");
  labelText.textContent = "DELIVERY ZONE";
  zoneLabel.appendChild(labelText);
  fieldBox.appendChild(zoneLabel);

  // lanes & dots
  for (let i = 0; i < L; i++) {
    const y = topMin + i * step;

    const lane = document.createElement("div");
    lane.className = "lane";
    // Binary mode: Apply color based on allocation choice
    if (params.isRobotMode) {
      lane.classList.add('lane-robot');
    } else {
      lane.classList.add('lane-human');
    }
    lane.style.top = y + "%";
    fieldBox.appendChild(lane);
    lanes.push(lane);

    const dot = document.createElement("div");
    dot.className = "finish-dot";
    dot.style.top = y + "%";
    fieldBox.appendChild(dot);
    finishDots.push(dot);
  }

  // one package per lane
  for (let i = 0; i < L; i++) {
    const y = topMin + i * step;
    const pkg = document.createElement("div");
    pkg.className = "package";
    pkg.style.top = y + "%";
    pkg.style.left = pkgStartPct + "%";

    const img = document.createElement("img");
    img.src = "package_icon.png";
    img.alt = `Package ${i + 1}`;
    pkg.appendChild(img);
    fieldBox.appendChild(pkg);

    pkgs.push({
      el: pkg,
      laneY: y,
      posPct: pkgStartPct,
      done: false,
      inError: false,
      errorWasFixed: false,  // Flag for robot mode: error fixed but needs resume
      errEl: null,
      noteEl: null,
      anim: { active: false, fromPct: 0, toPct: 0, start: 0, duration: 0 },
      errorSteps: [],         // predetermined steps where errors will occur
      errorIndex: 0,          // tracks which error we're on (for stacked errors)
      moveCount: 0            // count of moves made in this lane
    });
  }

  syncControlsPanel();
}

/* =========================================================
   Phase Mask Management (Sequential Work Flow)
   ========================================================= */
function updatePhaseMask(preserveOpacity = false) {
  // Binary mode: No phase transitions, so no mask needed
  // This function is obsolete in binary choice system
  const mask = document.getElementById("robot-phase-mask");
  if (!mask) return;
  
  // Always hide mask in binary mode
  mask.style.opacity = "0";
  mask.style.visibility = "hidden";
}

function transitionToRobotPhase() {
  console.info('[Phase] Transitioning from manual → robot');
  workPhase = 'robot';
  
  // Log phase transition
  logEvent('phase_transition', {
    fromPhase: 'manual',
    toPhase: 'robot',
    humanFinishTimeMs: humanFinishTime
  });
  
  // Remove phase mask with animation
  const mask = document.getElementById("robot-phase-mask");
  if (mask) {
    mask.style.transition = 'opacity 0.5s ease-out';
    mask.style.opacity = '0';
    setTimeout(() => {
      mask.style.visibility = 'hidden';
    }, 500);
  }
  
  // Initialize robot
  if (params.nRobotLanes > 0) {
    const nHuman = params.nLanes - params.nRobotLanes;
    // Robot lanes are now nHuman to params.nLanes-1 (bottom of field)
    robotActualLane = nHuman;
    createFieldRobotForLane(robotActualLane);
    robot.nextMoveAt = performance.now();
  }
  
  // Show notification
  showPhaseNotification("✓ Manual Work Complete", "Now supervise the robot");
}

function showPhaseNotification(title, message) {
  const notification = document.createElement('div');
  notification.className = 'phase-notification';
  notification.innerHTML = `
    <div class="phase-notification-card">
      <h3>${title}</h3>
      <p>${message}</p>
    </div>
  `;
  document.body.appendChild(notification);
  
  // Fade in
  requestAnimationFrame(() => {
    notification.style.opacity = '1';
  });
  
  // Fade out and remove after 2.5 seconds
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 500);
  }, 2500);
}

/* =========================================================
   Robot (sequential over first nRobotLanes)
   ========================================================= */
function resetRobot() {
  if (robot && robot.fieldEl) robot.fieldEl.remove();
  robot = { fieldEl: null, nextMoveAt: 0 };
  robotActualLane = null; // Robot doesn't start until manual phase complete
}

function createFieldRobotForLane(laneIndex) {
  if (robot.fieldEl) robot.fieldEl.remove();
  const el = document.createElement("div");
  el.className = "field-robot";
  const img = document.createElement("img");
  img.src = "robot_icon.png";
  img.alt = "Robot";
  el.appendChild(img);
  fieldBox.appendChild(el);
  robot.fieldEl = el;

  requestAnimationFrame(() => positionFieldRobot(laneIndex));
}

function positionFieldRobot(laneIndex) {
  if (laneIndex == null) return;
  const p = pkgs[laneIndex];
  const rEl = robot.fieldEl;
  if (!p || !rEl) return;

  const fb = fieldBox.getBoundingClientRect();
  const pr = p.el.getBoundingClientRect();
  const rr = rEl.getBoundingClientRect();

  const fieldW = fb.width, fieldH = fb.height;
  const robWPct = (rr.width / fieldW) * 100;
  const { startPct } = layout.get();

  const desiredLeft = p.posPct - robWPct - ROBOT_GAP_PCT;
  const leftPct = Math.max(startPct, desiredLeft);

  const centerYpx = pr.top - fb.top + pr.height / 2;
  const topPct = (centerYpx / fieldH) * 100 + ROBOT_Y_OFFSET_PCT;

  rEl.style.left = leftPct + "%";
  rEl.style.top  = topPct + "%";
}

/* =========================================================
   Human Icons (for manual lanes)
   ========================================================= */
function resetHuman() {
  if (human && human.fieldEl) human.fieldEl.remove();
  human = { fieldEl: null };
  // Human lanes are now 0 to nHuman-1 (top of field)
  humanActualLane = (params.nRobotLanes < params.nLanes) ? 0 : null;
}

function createFieldHumanForLane(laneIndex) {
  if (human.fieldEl) human.fieldEl.remove();
  const el = document.createElement("div");
  el.className = "field-human";
  const img = document.createElement("img");
  img.src = "human_icon.png";
  img.alt = "Human";
  el.appendChild(img);
  fieldBox.appendChild(el);
  human.fieldEl = el;

  requestAnimationFrame(() => positionFieldHuman(laneIndex));
}

function positionFieldHuman(laneIndex) {
  if (laneIndex == null) return;
  const p = pkgs[laneIndex];
  const hEl = human.fieldEl;
  if (!p || !hEl) return;

  const fb = fieldBox.getBoundingClientRect();
  const pr = p.el.getBoundingClientRect();
  const hr = hEl.getBoundingClientRect();

  const fieldW = fb.width, fieldH = fb.height;
  const humanWPct = (hr.width / fieldW) * 100;
  const { startPct } = layout.get();

  const desiredLeft = p.posPct - humanWPct - ROBOT_GAP_PCT;
  const leftPct = Math.max(startPct, desiredLeft);

  const centerYpx = pr.top - fb.top + pr.height / 2;
  const topPct = (centerYpx / fieldH) * 100 + ROBOT_Y_OFFSET_PCT;

  hEl.style.left = leftPct + "%";
  hEl.style.top  = topPct + "%";
}

/* =========================================================
   Movement / Errors / Bubbles
   ========================================================= */
const easeInOut = (t) => 0.5 * (1 - Math.cos(Math.PI * t));

function assignErrorsForLane(laneIndex) {
  const p = pkgs[laneIndex];
  if (!p) return;
  
  // Binary mode: Errors only occur in robot mode
  let numErrors = 0;
  if (params.isRobotMode) {
    if (isPracticeRound) {
      numErrors = 2; // Force 2 errors in practice round
    } else {
      numErrors = params.robotErrorsPerPackage;
    }
  }
  
  // Generate random step positions for errors (excluding step 0 and final step)
  // Errors can now stack on the same step (multiple errors per step)
  const maxStep = params.stepsToComplete - 1; // Don't put error on last step
  const availableSteps = [];
  for (let i = 1; i <= maxStep; i++) {
    availableSteps.push(i);
  }
  
  // Distribute errors across available steps, allowing duplicates (stacking)
  const errorSteps = [];
  for (let i = 0; i < numErrors; i++) {
    // Pick a random step from available positions (with replacement for stacking)
    const randomIndex = Math.floor(Math.random() * availableSteps.length);
    errorSteps.push(availableSteps[randomIndex]);
  }
  
  p.errorSteps = errorSteps.sort((a, b) => a - b); // Sort for easier debugging
  p.errorIndex = 0; // Track which error we're on (for stacked errors)
  p.moveCount = 0;
  
  console.log('[Errors] Lane', laneIndex, 'assigned', numErrors, 'errors at steps:', p.errorSteps);
}

function nextStop(fromPct, p) {
  if (!fieldBox) return fromPct;
  
  const { endPct, pkgStartPct } = layout.get();
  
  // Calculate based on move count to avoid drift
  const totalDistance = endPct - pkgStartPct;
  const stepSize = totalDistance / params.stepsToComplete;
  
  let nextPct;
  
  if (p) {
    // Target step is next integer step
    const targetStep = p.moveCount + 1;
    nextPct = pkgStartPct + (targetStep * stepSize);
  } else {
    // Fallback
    nextPct = fromPct + stepSize;
  }
  
  // Ensure we reach at least endPct on the final step
  // Use a small epsilon for comparison to handle float issues
  if (nextPct >= endPct - 0.01) {
    return Math.max(nextPct, endPct + 0.1); // Slight overshoot to ensure delivery
  }
  
  console.log('[nextStop] from', fromPct.toFixed(1), '% to', nextPct.toFixed(1), 
              '% (stepSize:', stepSize.toFixed(1), '%, endPct:', endPct.toFixed(1), '%)');
  
  return nextPct;
}

function startAnim(i, toPct, customDuration) {
  const p = pkgs[i];
  if (!p) return;
  const dist = Math.max(0, toPct - p.posPct);
  if (dist === 0) return;

  const now = performance.now();
  // Use custom duration if provided, otherwise fallback to calculation
  const duration = customDuration || Math.max(120, (dist / 80) * 1000);

  p.anim.active   = true;
  p.anim.fromPct  = p.posPct;
  p.anim.toPct    = toPct;
  p.anim.start    = now;
  p.anim.duration = duration;
  
  // Increment move count when animation starts
  p.moveCount++;
}

function maybeError(i) {
  const p = pkgs[i];
  if (!p || p.done || p.inError) return false;
  
  // Check if current move count matches the next scheduled error
  // errorIndex tracks which error we're on (supports stacked errors on same step)
  if (p.errorIndex < p.errorSteps.length && p.errorSteps[p.errorIndex] === p.moveCount) {
    p.inError = true;
    p.errorIndex++; // Move to next error in the list
    
    console.log('[Error] Triggered error', p.errorIndex, 'of', p.errorSteps.length, 'at step', p.moveCount);
    
    // Always create the error bubble (no masking)
    setBubble(i, MSG_ERR, "error");
    
    return true;
  }
  
  return false;
}
function clearError(i) {
  const p = pkgs[i];
  if (!p) return;
  p.inError = false;
  hideBubble(i, "error");
  
  // In robot mode, set flag that requires resume button click
  if (params.isRobotMode) {
    p.errorWasFixed = true; // require user to press Resume
    console.log('[Error] Error fixed - now press Resume Robot button to continue');
  }

  // Log error fix
  logEvent('error_fixed', {
    laneIndex: i,
    isRobotMode: params.isRobotMode,
    requiresResume: params.isRobotMode
  });
}

function setBubble(i, text, kind) {
  const p = pkgs[i];
  if (!p) return;
  const cls  = (kind === "error") ? "err-bubble"  : "note-bubble";
  const prop = (kind === "error") ? "errEl"       : "noteEl";

  if (!p[prop]) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    
    // Make error bubbles clickable to fix the error
    if (kind === "error") {
      // Log when error bubble appears (time when fix action is available)
      logEvent('error_occurred', {
        laneIndex: i,
        isRobotMode: params.isRobotMode,
        moveCount: p.moveCount,
        packagePosition: p.posPct,
        errorStep: p.moveCount,
        availableAt: Date.now()
      });

      el.addEventListener("click", () => {
        humanFixCount++; // Q3: Track supervision effort
        
        // Log error bubble click
        logEvent('click_error_bubble', {
          action: 'fix_error',
          laneIndex: i,
          isRobotMode: params.isRobotMode,
          totalFixes: humanFixCount
        });
        
        clearError(i);
        renderPackage(i);
      });
    }
    
    fieldBox.appendChild(el);
    p[prop] = el;
  } else {
    p[prop].textContent = text;
    p[prop].style.display = "block";
  }

  const fb = fieldBox.getBoundingClientRect();
  const pr = p.el.getBoundingClientRect();
  const bubble = p[prop];
  const gap = 8;
  const bw = bubble.offsetWidth || 120;
  const bh = bubble.offsetHeight || 40;

  if (kind === "error") {
    // Check if we are at late steps (last 3 steps)
    // If so, place bubble to the LEFT to avoid going off-screen
    const isLateStep = p.moveCount >= (params.stepsToComplete - 3);
    
    if (isLateStep) {
      // Place to the LEFT
      // Increased padding from 20px to 60px to avoid overlap with robot
      const leftPx = (pr.left - fb.left) - bw - gap - 60; 
      bubble.style.left = leftPx + "px";
    } else {
      // Place to the RIGHT (default)
      const leftPx = (pr.left - fb.left) + pr.width + gap;
      bubble.style.left = leftPx + "px";
    }
    
    // Center vertically
    bubble.style.top  = ((pr.top - fb.top) + (pr.height / 2) - (bh / 2)) + "px";
  } else {
    // Place note bubbles to the RIGHT as well
    const leftPx = (pr.left - fb.left) + pr.width + gap;
    bubble.style.left = leftPx + "px";
    // Center vertically
    bubble.style.top  = ((pr.top - fb.top) + (pr.height / 2) - (bh / 2)) + "px";
  }
}

function hideBubble(i, kind) {
  const p = pkgs[i];
  if (!p) return;
  const prop = (kind === "error") ? "errEl" : "noteEl";
  if (p[prop]) p[prop].style.display = "none";
}

/* =========================================================
   Render loop
   ========================================================= */
function renderPackage(i) {
  const p = pkgs[i];
  if (!p) return;
  p.el.style.left = p.posPct + "%";
  
  // Position robot icon if this is the robot's lane
  if (robot && robot.fieldEl && robotActualLane === i && !p.done) {
    positionFieldRobot(i);
  }
  
  // Position human icon if this is the human's current lane
  if (human && human.fieldEl && humanActualLane === i && !p.done) {
    positionFieldHuman(i);
  }

  if (p.inError) setBubble(i, MSG_ERR, "error");
  if (p.done && p.noteEl && p.noteEl.style.display !== "none") setBubble(i, MSG_DONE, "note");
}

function allDelivered(){ return pkgs.every(p => p.done); }

function tick() {
  try {
    const now = performance.now();
    const { endPct } = layout.get();

    updateHumanCooldownButtons(now);

    // Binary mode: Only one phase runs (either human OR robot)
    // Check for completion
    if (running && allDelivered()) {
      running = false;
      workPhase = 'complete';
      
      // Record finish time
      if (params.isRobotMode) {
        robotFinishTime = now - roundStartMs;
        logEvent('robot_finished', {
          robotFinishTimeMs: robotFinishTime,
          mode: 'robot'
        });
      } else {
        humanFinishTime = now - roundStartMs;
        logEvent('human_finished', {
          humanFinishTimeMs: humanFinishTime,
          mode: 'human'
        });
      }
      
      // Clean up icons
      if (robot.fieldEl) {
        robot.fieldEl.remove();
        robot.fieldEl = null;
      }
      if (human.fieldEl) {
        human.fieldEl.remove();
        human.fieldEl = null;
      }
      
      const end = performance.now();
      const ms = Math.round(end - roundStartMs);
      const sec = (ms/1000).toFixed(2);
      const tEl = document.getElementById("round-time");
      if (tEl) tEl.textContent = `Time: ${sec}s`;
      console.info("[Round] duration_ms=", ms);

      // Update banner text for practice vs actual
      const bannerTitle = roundBanner.querySelector('.rb-title');
      if (isPracticeRound) {
        bannerTitle.textContent = "✓ Practice Complete!";
        restartBtn.textContent = "Start Actual Rounds"; // Should be handled by restartBtn logic but good to set here
      } else {
        bannerTitle.textContent = "✓ Round Complete!";
        if (roundIndex === totalRounds) {
            restartBtn.textContent = "Complete Study";
        } else {
            restartBtn.textContent = "Next Round";
        }
      }

      (async () => {
        // Skip Demo logging for practice round
        if (isPracticeRound) {
          console.info('[Practice] Round complete - no Demo logging');
          document.getElementById("round-banner").classList.remove("hidden");
          return;
        }

        try {
          // 1. Calculate metrics
          const metrics = {
            totalClicks: clickEventLog.length,
            pushClicks: clickEventLog.filter(e => e.eventType === 'click_push').length,
            errorBubbleClicks: clickEventLog.filter(e => e.eventType === 'click_error_bubble').length,
            revealClicks: clickEventLog.filter(e => e.eventType === 'click_reveal').length,
            totalErrors: errorEventLog.filter(e => e.eventType === 'error_occurred').length,
            robotErrors: errorEventLog.filter(e => e.eventType === 'error_occurred' && e.isRobotLane).length,
            humanErrors: errorEventLog.filter(e => e.eventType === 'error_occurred' && !e.isRobotLane).length,
            errorsFixed: errorEventLog.filter(e => e.eventType === 'error_fixed').length,
            timeToFirstErrorMs: errorEventLog.find(e => e.eventType === 'error_occurred')?.elapsedMs || null,
            
            // Capture current config state
            config: {
              robotSpeed: params.robotMoveCooldownMs,
              humanSpeed: params.humanMoveCooldownMs,
              steps: params.stepsToComplete
            }
          };

          const totalEffort = humanPushCount + humanFixCount;
          const supervisionRatio = totalEffort > 0 ? humanFixCount / totalEffort : 0;
          
          const workPreference = {
            pushClicks: humanPushCount,
            fixClicks: humanFixCount,
            totalEffort: totalEffort,
            supervisionRatio: supervisionRatio,
            robotErrorsEncountered: metrics.robotErrors
          };
          
          // 2. Save using DB helper
          // Snapshot events
          const eventsSnapshot = [...eventLog];

          await DB.logRoundResult(roundIndex, { ...metrics, ...workPreference, totalTimeMs: ms, deliveredAll: true }, eventsSnapshot);
          
          console.info('[Demo] result saved');
        } catch (e) {
          console.warn('[Demo] result save failed:', e);
        }
      })();

      document.getElementById("round-banner").classList.remove("hidden");
      return;
    }

    // animate packages
    pkgs.forEach((p, i) => {
      if (!p.anim.active) return;
      const t = Math.min(1, (now - p.anim.start) / p.anim.duration);
      const k = easeInOut(t);
      p.posPct = p.anim.fromPct + (p.anim.toPct - p.anim.fromPct) * k;

      if (t >= 1) {
        p.posPct = p.anim.toPct;
        p.anim.active = false;

        if (p.posPct >= endPct && !p.done) {
          p.done = true;
          p.el.classList.add("done");
          finishDots[i]?.classList?.add("done");
          setBubble(i, MSG_DONE, "note");
          
          // Log package delivery
          logEvent('package_delivered', {
            laneIndex: i,
            isRobotMode: params.isRobotMode,
            totalMoves: p.moveCount,
            phase: workPhase
          });
        } else if (!p.done) {
          maybeError(i);
        }
      }
      renderPackage(i);
    });

    if (running) {
      // Robot cadence (ONLY in robot mode)
      if (params.isRobotMode && workPhase === 'robot') {
        const p = pkgs[0]; // Single package
        // console.log('[Tick] Robot mode check - p:', !!p, 'done:', p?.done, 'anim:', p?.anim.active, 'inError:', p?.inError, 'fixed:', p?.errorWasFixed);
        if (p && !p.done && !p.anim.active && !p.inError && !p.errorWasFixed) {
          // console.log('[Tick] Robot ready to move - now:', now, 'nextMoveAt:', robot.nextMoveAt);
          if (now >= robot.nextMoveAt) {
            console.log('[Tick] Robot moving - from:', p.posPct);
            const to = nextStop(p.posPct, p);
            if (to > p.posPct) {
              console.log('[Tick] Starting animation to:', to);
              // Use robot cooldown as duration for smooth movement
              startAnim(0, to, params.robotMoveCooldownMs);
            }
            robot.nextMoveAt = now + params.robotMoveCooldownMs;
          }
        }
      } else {
        // if (!params.isRobotMode) console.log('[Tick] Not robot mode');
        // if (workPhase !== 'robot') console.log('[Tick] workPhase is:', workPhase);
      }
    } else {
      // console.log('[Tick] Not running');
    }

    if (running || pkgs.some(p => p.anim.active)) rafId = requestAnimationFrame(tick);
    else rafId = null;
  } catch (e) {
    console.error('[Tick] Fatal error in game loop:', e);
    running = false;
    rafId = null;
  }
}
function ensureLoop(){ if (rafId == null) rafId = requestAnimationFrame(tick); }

/* =========================================================
   Interactions
   ========================================================= */
function pushHumanSerial(){
  console.log('[Push] Button clicked. Running:', running, 'isRobotMode:', params.isRobotMode);
  
  if (!running) {
    console.log('[Push] Blocked: Game not running');
    return;
  }
  
  const p = pkgs[0]; // Single package in binary mode
  if (!p) {
    console.log('[Push] Blocked: No package found');
    return;
  }
  if (p.done) {
    console.log('[Push] Blocked: Package already done');
    return;
  }
  
  // Robot mode: This button resumes robot after error was fixed
  if (params.isRobotMode) {
    // Check if there was an error that was just fixed
    if (!p.inError && p.errorWasFixed) {
      console.log('[Push] Resuming robot after error fix');

      // Clear the fixed flag (user indicated resume)
      p.errorWasFixed = false;

      // If the next scheduled error is on the same step, show it now
      if (p.errorIndex < p.errorSteps.length && p.errorSteps[p.errorIndex] === p.moveCount) {
        console.log('[Push] Next error scheduled at same step — showing after resume');
        // Trigger the next error bubble (maybeError will increment errorIndex)
        maybeError(0);

        // Log that resume revealed another error
        logEvent('robot_resumed', {
          laneIndex: 0,
          packagePosition: p.posPct,
          note: 'resume_shows_next_error'
        });

        // Do not resume robot movement; user must fix and press Resume again
        return;
      }

      // Otherwise, resume robot movement normally
      robot.nextMoveAt = performance.now();

      logEvent('robot_resumed', {
        laneIndex: 0,
        packagePosition: p.posPct
      });

      ensureLoop();
      return;
    } else if (p.inError) {
      console.log('[Push] Blocked: Error not fixed yet - click error bubble first');
      return;
    } else {
      console.log('[Push] Blocked: Robot mode - no action needed');
      return;
    }
  }
  
  // Manual mode: Normal push functionality
  if (p.inError) {
    console.log('[Push] Blocked: Package in error state');
    return;
  }
  if (p.anim.active) {
    console.log('[Push] Blocked: Animation active');
    return;
  }

  const now = performance.now();
  if (now < (manualNextMoveAt[0] || 0)) {
    console.log('[Push] Blocked: Cooldown active');
    return;
  }

  const to = nextStop(p.posPct, p);
  if (to > p.posPct) {
    console.log('[Push] Moving package from', p.posPct, 'to', to);
    // Use human cooldown as duration for smooth movement
    startAnim(0, to, params.humanMoveCooldownMs);
  }
  manualNextMoveAt[0] = now + params.humanMoveCooldownMs;

  humanPushCount++; // Track push effort

  // Log the push button click
  logEvent('click_push', {
    action: 'human_push',
    laneIndex: 0,
    packagePosition: p.posPct,
    moveCount: p.moveCount,
    isRobotMode: false,
    totalPushes: humanPushCount
  });

  humanGlobalCooldownUntil = manualNextMoveAt[0]; // global mute
  updateHumanCooldownButtons(performance.now());
  ensureLoop();
}


/* =========================================================
   Intro.js Tutorial
   ========================================================= */
function showDummyError() {
  if (document.getElementById('dummy-pkg')) return;
  
  // Hide any existing packages on the field to avoid clutter (e.g. the one on the left)
  const existingPackages = fieldBox.querySelectorAll('.package');
  existingPackages.forEach(p => p.style.display = 'none');

  // 1. Create Robot (behind package)
  const robot = document.createElement("div");
  robot.id = 'dummy-robot';
  robot.className = "field-robot";
  robot.style.top = "50%";
  robot.style.left = "35%"; // Behind package
  
  const robotImg = document.createElement("img");
  robotImg.src = "robot_icon.png";
  robot.appendChild(robotImg);
  fieldBox.appendChild(robot);

  // 2. Create Package
  const pkg = document.createElement("div");
  pkg.id = 'dummy-pkg';
  pkg.className = "package";
  pkg.style.top = "50%";
  pkg.style.left = "42%"; // Slightly ahead of robot
  
  const img = document.createElement("img");
  img.src = "package_icon.png";
  pkg.appendChild(img);
  fieldBox.appendChild(pkg);

  // 3. Create Error Bubble (attached to fieldBox, matching real game structure)
  const bubble = document.createElement("div");
  bubble.id = 'dummy-bubble';
  bubble.className = "err-bubble";
  bubble.textContent = "Dropped! Click to Fix";
  
  // Position relative to fieldBox to match real game exactly
  // Package is at 42% left, 7% width.
  // Bubble left = 42% + 7% + small gap (e.g. 1%)
  bubble.style.position = "absolute"; // Force absolute to prevent override by highlight class
  bubble.style.left = "calc(42% + 7% + 10px)"; 
  bubble.style.top = "50%"; 
  bubble.style.transform = "translateY(-50%)"; // Center vertically
  bubble.style.width = "max-content"; // Ensure it doesn't stretch
  
  fieldBox.appendChild(bubble);
}

function hideDummyError() {
  const r = document.getElementById('dummy-robot');
  if (r) r.remove();
  const p = document.getElementById('dummy-pkg');
  if (p) p.remove();
  const b = document.getElementById('dummy-bubble');
  if (b) b.remove();
  
  // Restore existing packages
  const existingPackages = fieldBox.querySelectorAll('.package');
  existingPackages.forEach(p => {
    if (p.id !== 'dummy-pkg') p.style.display = '';
  });
}

function highlightErrorSteps(active) {
  const bubble = document.getElementById('dummy-bubble');
  const btn = document.getElementById('global-human-push');
  
  if (active) {
    if (bubble) bubble.classList.add('tutorial-highlight-1');
    if (btn) btn.classList.add('tutorial-highlight-2');
  } else {
    if (bubble) bubble.classList.remove('tutorial-highlight-1');
    if (btn) btn.classList.remove('tutorial-highlight-2');
  }
}

function startInstructions() {
  // Check if intro.js is available
  if (typeof introJs === 'undefined') {
    console.warn('[Intro.js] Library not loaded, skipping tutorial');
    return;
  }

  // Create permanent anchor for tutorial positioning
  let anchor = document.getElementById('tutorial-anchor');
  if (!anchor && fieldBox) {
    anchor = document.createElement('div');
    anchor.id = 'tutorial-anchor';
    anchor.style.position = 'absolute';
    anchor.style.top = '0';
    anchor.style.left = '50%';
    anchor.style.width = '1px';
    anchor.style.height = '1px';
    anchor.style.pointerEvents = 'none';
    fieldBox.appendChild(anchor);
  }

  tutorialIntro = introJs();
  const intro = tutorialIntro; // Keep local reference for convenience
  
  intro.setOptions({
    steps: [
      {
        title: 'Welcome to the Warehouse!',
        intro: 'You will act as a <strong>warehouse worker</strong>. Your job is to move a package from the storage area into the green delivery zone.<br><br><strong>Your goal: Complete each round with as little effort as possible!</strong>'
      },
      {
        element: document.querySelector('#field-box'),
        title: 'The Playing Field',
        intro: 'The package starts on the <strong>left</strong> and must reach the <strong>green delivery zone</strong> on the right.',
        position: 'right',
        tooltipClass: 'customTooltip customTooltip-small'
      },
      {
        element: document.querySelector('#alloc-options'),
        title: 'Make Your Choice',
        intro: 'Before each round, decide: Will <strong>YOU</strong> move the package manually, or let the <strong>ROBOT</strong> do it automatically?',
        position: 'left'
      },
      {
        element: document.querySelector('#global-human-push'),
        title: 'Do It Yourself',
        intro: 'If you choose <strong>"I will do it"</strong>, you must click the <strong>Push</strong> button repeatedly.<br><br>Each click moves the package <strong>one step</strong> forward.',
        position: 'right'
      },
      {
        element: document.querySelector('#field-box'),
        title: '<span style="color:#d97706">Giving it to the Robot</span>',
        intro: 'If you choose <strong>"Robot will do it"</strong>, the robot moves the package automatically. However, the robot may make errors that you must fix.',
        position: 'right'
      },
      {
        element: '#tutorial-anchor',
        title: 'Handling Robot Errors',
        intro: 'The robot may drop the package!<br><br>1. Click the <span style="color:#dc2626; font-weight:bold">red error bubble</span> to fix the error.<br>2. Then click the <strong>Resume Robot</strong> button to continue.',
        position: 'bottom',
        tooltipClass: 'customTooltip customTooltip-wide'
      },
      {
        title: 'Ready for Practice?',
        intro: '<strong>Remember: Minimize your clicks!</strong><br>Let\'s do a quick practice round!'
      }
    ],
    showProgress: true,
    showBullets: false,
    exitOnOverlayClick: false,
    exitOnEsc: false,
    showSkipButton: false, // Hide skip/exit buttons
    keyboardNavigation: false,
    disableInteraction: true,
    scrollToElement: true,
    scrollPadding: 30,
    tooltipClass: 'customTooltip customTooltip-medium',
    nextLabel: 'Next →',
    prevLabel: '← Back',
    doneLabel: 'Start Practice!',
    hidePrev: true
  });

  // Control phase mask and UI visibility during tutorial
  intro.onchange(function(targetElement) {
    const stepIndex = this._currentStep;
    const allocOptions = document.getElementById("alloc-options");
    const dimOverlay = document.getElementById('tutorial-dim-overlay');
    
    // Control tutorial dimming overlay (custom)
    // Only show on first step (index 0)
    if (dimOverlay) {
      if (stepIndex === 0) {
        dimOverlay.style.opacity = '1';
      } else {
        dimOverlay.style.opacity = '0';
      }
    }

    // Also handle intro.js native overlay
    // We need to wait for intro.js to create/update the overlay
    setTimeout(() => {
      const introOverlay = document.querySelector('.introjs-overlay');
      const helperLayer = document.querySelector('.introjs-helperLayer');
      
      if (introOverlay) {
        if (stepIndex === 0) {
          introOverlay.style.opacity = ''; // Default (visible)
        } else {
          introOverlay.style.opacity = '0'; // Transparent
        }
      }
      
      // Hide helper layer for the anchor step (step 5) to avoid seeing a box around the invisible anchor
      if (helperLayer) {
         if (stepIndex === 5) {
             helperLayer.style.opacity = '0';
         } else {
             helperLayer.style.opacity = '';
         }
      }
    }, 10);
    
    // Show allocation overlay during step 2 (allocation explanation)
    if (stepIndex === 2) {
      allocOverlay.classList.remove('hidden');
    } else {
      allocOverlay.classList.add('hidden');
    }

    // Dynamic state updates for tutorial
    if (stepIndex === 3) { // Do It Yourself
       updateAllocationSelection(false); // Human mode
       highlightErrorSteps(false);
    } else if (stepIndex === 4) { // Robot steps
       updateAllocationSelection(true); // Robot mode
       hideDummyError();
       highlightErrorSteps(false);
    } else if (stepIndex === 5) { // Handling Robot Errors
       updateAllocationSelection(true); // Robot mode
       showDummyError();
       
       // Force button text for tutorial context (since updateAllocationSelection sets it to "Robot Working...")
       const btn = document.getElementById('global-human-push');
       if (btn) btn.textContent = 'Resume Robot';

       // Small delay to ensure DOM is ready
       setTimeout(() => highlightErrorSteps(true), 50);
    } else {
       hideDummyError();
       highlightErrorSteps(false);
    }
  });

  // When tutorial completes, remove dim overlay and log it
  intro.oncomplete(() => {
    console.info('[Intro.js] Tutorial completed');
    
    // Clear tutorial reference
    tutorialIntro = null;
    hideDummyError();
    
    // Remove dimming overlay
    const dimOverlay = document.getElementById('tutorial-dim-overlay');
    if (dimOverlay) {
      dimOverlay.style.opacity = '0';
      setTimeout(() => dimOverlay.remove(), 500);
    }
    
    // Clear any selection highlights from tutorial
    const allOptions = document.querySelectorAll('.alloc-option');
    allOptions.forEach(opt => opt.classList.remove('selected'));
    
    // Show allocation overlay after tutorial
    resetAgentInfo();
    allocOverlay.classList.remove('hidden');
    
    // Log tutorial completion to Demo
    (async () => {
      try {
        await DB.logTutorialComplete();
      } catch (e) {
        console.warn('[Demo] tutorial log failed:', e);
      }
    })();
  });

  intro.onexit(() => {
    console.info('[Intro.js] Tutorial exited');
    
    // Clear tutorial reference
    tutorialIntro = null;
    hideDummyError();
    
    // Remove dimming overlay on exit
    const dimOverlay = document.getElementById('tutorial-dim-overlay');
    if (dimOverlay) {
      dimOverlay.style.opacity = '0';
      setTimeout(() => dimOverlay.remove(), 500);
    }
    
    // Also ensure intro.js elements are cleaned up
    const introjsOverlay = document.querySelector('.introjs-overlay');
    if (introjsOverlay) {
      introjsOverlay.remove();
    }
    const introjsLayer = document.querySelector('.introjs-helperLayer');
    if (introjsLayer) {
      introjsLayer.remove();
    }
    
    // Clear any selection highlights from tutorial
    const allOptions = document.querySelectorAll('.alloc-option');
    allOptions.forEach(opt => opt.classList.remove('selected'));
    
    // Show allocation overlay on exit
    allocOverlay.classList.remove('hidden');
  });

  intro.start();
}

/* =========================================================
   Allocation overlay helpers (icon-based)
   ========================================================= */
function buildIcon(imgSrc, emojiFallback) {
  const img = document.createElement('img');
  img.src = imgSrc;
  img.alt = '';
  img.style.width = 'var(--alloc-icon)';
  img.style.height = 'var(--alloc-icon)';
  img.style.objectFit = 'contain';
  img.onerror = () => {
    const span = document.createElement('span');
    span.textContent = emojiFallback;
    span.style.fontSize = 'calc(var(--alloc-icon) - 4px)';
    img.replaceWith(span);
  };
  return img;
}

function generateAllocationOptions() {
  if (!allocOptionsContainer) return;
  
  // Log that allocation options are shown (time when things are available)
  logEvent('allocation_options_shown', {
    roundIndex: roundIndex,
    blockIndex: currentBlock,
    isPractice: isPracticeRound
  });
  
  allocOptionsContainer.innerHTML = '';
  
  // Determine labels based on block
  let humanLabel = 'I will do it';
  let robotLabel = 'Robot will do it';
  
  // Binary choice: Human or Robot (order randomized per participant)
  let choices = buttonOrderHumanFirst 
    ? [
        { mode: false, label: humanLabel, icon: 'human_icon.png', theme: 'human' },
        { mode: true, label: robotLabel, icon: 'robot_icon.png', theme: 'robot' }
      ]
    : [
        { mode: true, label: robotLabel, icon: 'robot_icon.png', theme: 'robot' },
        { mode: false, label: humanLabel, icon: 'human_icon.png', theme: 'human' }
      ];
  
  choices.forEach(choice => {
    // Create option container
    const option = document.createElement('div');
    option.className = 'alloc-option binary-choice';
    option.dataset.robotMode = choice.mode;
    
    // Create radio input
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'allocation';
    radio.value = choice.mode;
    radio.id = `alloc-option-${choice.mode}`;
    
    // Create label
    const label = document.createElement('div');
    label.className = `alloc-option-label ${choice.theme}-choice`;
    
    // Create icon
    const icon = buildIcon(choice.icon, choice.mode ? '🤖' : '👤');
    label.appendChild(icon);
    
    // Create text
    const text = document.createElement('div');
    text.className = 'choice-text';
    text.textContent = choice.label;
    
    label.appendChild(text);
    
    // Assemble option
    option.appendChild(radio);
    option.appendChild(label);
    
    // Click handler
    option.addEventListener('click', () => {
      radio.checked = true;
      updateAllocationSelection(choice.mode);
    });
    
    allocOptionsContainer.appendChild(option);
  });
  
  // No default selection - user must choose
}

function resetAgentInfo() {
  // Hide agent info when starting new round (before selection)
  const agentInfo = document.getElementById('agent-info');
  if (agentInfo) {
    agentInfo.style.display = 'none';
  }
  
  // Reset action section to neutral theme
  if (actionSection) {
    actionSection.classList.remove('human-theme', 'robot-theme');
    actionSection.classList.add('action-theme');
  }
}

function updateAllocationSelection(isRobotMode) {
  // Update params
  params.isRobotMode = isRobotMode;
  
  // Update visual selection
  const allOptions = document.querySelectorAll('.alloc-option');
  allOptions.forEach(opt => {
    const optMode = opt.dataset.robotMode === 'true';
    if (optMode === isRobotMode) {
      opt.classList.add('selected');
    } else {
      opt.classList.remove('selected');
    }
  });
  
  // Update lane colors to match selection
  lanes.forEach(lane => {
    lane.classList.remove('lane-human', 'lane-robot');
    if (isRobotMode) {
      lane.classList.add('lane-robot');
    } else {
      lane.classList.add('lane-human');
    }
  });
  
  // Update action section theme based on selection
  if (actionSection) {
    actionSection.classList.remove('action-theme', 'human-theme', 'robot-theme');
    if (isRobotMode) {
      actionSection.classList.add('robot-theme');
    } else {
      actionSection.classList.add('human-theme');
    }
  }
  
  // Update agent info display
  const agentInfo = document.getElementById('agent-info');
  const agentIcon = document.getElementById('agent-icon');
  const agentName = document.getElementById('agent-name');
  const agentDescription = document.getElementById('agent-description');
  const pushButton = btnHumanPush;
  
  if (agentInfo && agentIcon && agentName && agentDescription) {
    // Show agent info after selection
    agentInfo.style.display = 'block';
    
    if (isRobotMode) {
      agentIcon.src = 'robot_icon.png';
      agentIcon.alt = 'Robot';
      agentName.textContent = 'Robot';
      agentDescription.textContent = 'Robot delivering... You should monitor for errors';
      
      // Change button text for robot mode
      if (pushButton) {
        pushButton.textContent = 'Robot Working...';
        pushButton.setAttribute('data-mode', 'robot');
      }
    } else {
      agentIcon.src = 'human_icon.png';
      agentIcon.alt = 'You';
      agentName.textContent = 'You';
      agentDescription.textContent = 'You are handling the delivery';
      
      // Change button text for manual mode
      if (pushButton) {
        pushButton.textContent = 'Push';
        pushButton.setAttribute('data-mode', 'manual');
      }
    }
  }
  
  // Enable continue button
  if (allocContinue) {
    allocContinue.disabled = false;
  }
}

/* =========================================================
   Cooldown / Button enablement
   ========================================================= */
function updateHumanCooldownButtons(now) {
  const globalPush = btnHumanPush;

  // Binary mode: Different logic for robot vs manual mode
  const muteAll = now < humanGlobalCooldownUntil;
  
  // Only log during active gameplay to reduce console spam
  // console.log('[ButtonUpdate] muteAll:', muteAll, 'isRobotMode:', params.isRobotMode, 'pkgs.length:', pkgs.length);
  
  // Human Push / Robot Resume
  if (globalPush){
    let disable = false;

    if (muteAll) {
      disable = true;
      // console.log('[ButtonUpdate] Disabled: global cooldown');
    }
    else if (params.isRobotMode) {
      // Robot mode: Button only enabled when error was fixed and needs resume
      const p = pkgs[0];
      // Only enable if there's an error that was fixed waiting for resume
      // Otherwise keep disabled (robot runs automatically)
      if (!p || p.done || !p.errorWasFixed) {
        disable = true;
        
        // Update text to indicate status
        if (p && p.inError) {
            globalPush.textContent = "Fix Error";
        } else if (p && !p.done) {
            globalPush.textContent = "Robot Working...";
        } else {
            globalPush.textContent = "Resume Robot";
        }
        
        // console.log('[ButtonUpdate] Disabled: robot mode, no resume needed. p:', !!p, 'done:', p?.done, 'errorWasFixed:', p?.errorWasFixed);
      } else {
        // console.log('[ButtonUpdate] Enabled: robot mode, resume needed');
        globalPush.textContent = "Resume Robot";
      }
    }
    else {
      // Human mode: Normal push button logic
      globalPush.textContent = "Push";
      const p = pkgs[0]; // Single package
      if (!p || p.done) {
        disable = true;
        // console.log('[ButtonUpdate] Disabled: no package or done. p:', !!p, 'done:', p?.done);
      }
      else {
        const inCd = now < (manualNextMoveAt[0] || 0);
        if (inCd || p.inError || p.anim.active) {
          disable = true;
          // console.log('[ButtonUpdate] Disabled: cooldown/error/anim. inCd:', inCd, 'inError:', p.inError, 'animActive:', p.anim.active);
        } else {
          // console.log('[ButtonUpdate] Enabled: human mode, ready to push');
        }
      }
    }

    if (disable) globalPush.setAttribute("disabled", "true");
    else globalPush.removeAttribute("disabled");
  }
}

/* =========================================================
   Start / Reset flow
   ========================================================= */
function updateRoundTitle() {
  const el = document.getElementById("round-counter");
  if (el) {
    if (isPracticeRound) {
      el.textContent = `Practice Round`;
    } else {
      el.textContent = `Round ${roundIndex}/${totalRounds}`;
    }
  }
}

function placeInitial() {
  const { pkgStartPct } = layout.get();
  pkgs.forEach((p, i) => {
    p.posPct = pkgStartPct;
    p.done = false;
    p.inError = false;
    p.errorWasFixed = false; // Reset resume flag
    p.anim.active = false;
    p.el.className = "package";
    p.moveCount = 0;
    
    // Assign predetermined error positions for this lane
    assignErrorsForLane(i);
  });
  manualNextMoveAt = Array.from({ length: params.nLanes }, () => 0);
  humanGlobalCooldownUntil = 0;

  resetRobot();
  resetHuman();
  
  // Reset to manual phase (will be overridden by startGame if robot mode)
  workPhase = 'manual';
  updatePhaseMask();
  
  // Don't update button state here - it will be updated when game starts
  // updateHumanCooldownButtons(performance.now());
}

function startGame() {
  console.log('[StartGame] Called - params.isRobotMode:', params.isRobotMode, 'pkgs.length:', pkgs.length);
  
  // Re-assign errors based on the FINAL selection for this round
  // This ensures human mode never has errors, even if previous round was robot
  pkgs.forEach((p, i) => {
    assignErrorsForLane(i);
  });

  updateRoundTitle();
  running = true;
  roundStartMs = performance.now();
  
  // Reset Q2/Q3 tracking
  humanFinishTime = null;
  robotFinishTime = null;
  humanPushCount = 0;
  humanFixCount = 0;
  
  // Reset event logs for new round
  eventLog = [];
  errorEventLog = [];
  clickEventLog = [];
  
  // Log round start event (time when controls become active)
  logEvent('round_start', {
    blockIndex: currentBlock,
    isPractice: isPracticeRound,
    isRobotMode: params.isRobotMode,
    robotSpeed: params.robotMoveCooldownMs,
    humanSpeed: params.humanMoveCooldownMs,
    robotErrorsPerPackage: params.robotErrorsPerPackage,
    controlsActiveAt: Date.now() - sessionStartTime
  });

  // Save round start config to Demo (skip practice)
  if (!isPracticeRound) {
    (async () => {
      try {
        await DB.logRoundStart(roundIndex, currentBlock, params.isRobotMode);
      } catch (e) {
        console.warn('[Demo] round start log failed:', e);
      }
    })();
  }

  // Binary mode: Either robot does it OR human does it
  if (params.isRobotMode) {
    console.log('[StartGame] Robot mode - creating robot');
    // Robot mode: Skip manual phase, go straight to robot
    workPhase = 'robot';
    humanFinishTime = 0; // No manual work
    
    // Start robot on the single package
    robotActualLane = 0;
    createFieldRobotForLane(0);
    robot.nextMoveAt = performance.now();
    
    logEvent('robot_started', {
      mode: 'robot',
      note: 'Robot mode - robot processes package'
    });
  } else {
    console.log('[StartGame] Human mode - creating human');
    // Human mode: Start in manual phase
    workPhase = 'manual';
    
    // Human works on the single package
    humanActualLane = 0;
    createFieldHumanForLane(0);
    
    logEvent('human_started', {
      mode: 'human',
      note: 'Human mode - user processes package'
    });
  }

  console.log('[StartGame] Final state - running:', running, 'workPhase:', workPhase, 'calling ensureLoop()');


  // log round start (skip Demo for practice)
  // Handled by DB.logRoundStart at the top of startGame
  /* 
  if (!isPracticeRound) {
     ... removed old logging code ...
  }
  */
  
  console.log('[StartGame] Updating button state and starting loop');
  updateHumanCooldownButtons(performance.now());
  
  // Ensure any previous loop is cancelled before starting a new one
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  ensureLoop();
}

/* =========================================================
   Init
   ========================================================= */
function init() {
  console.info('[Game] init()');

  // Consent form elements
  consentOverlay = document.getElementById('consent-overlay');
  consentCheckbox = document.getElementById('consent-checkbox');
  consentAgreeBtn = document.getElementById('consent-agree');

  // DOM lookups
  controlsCol   = document.getElementById("controls-col");
  fieldWrap     = document.getElementById("field-wrap");
  fieldBox      = document.getElementById("field-box");

  // Control panel buttons and status
  btnHumanPush = document.getElementById("global-human-push");
  actionSection = document.getElementById("action-section");

  // Overlays
  allocOverlay  = document.getElementById("alloc-overlay");
  allocOptionsContainer = document.getElementById("alloc-options");
  allocContinue = document.getElementById("alloc-continue");
  roundBanner   = document.getElementById("round-banner");
  restartBtn    = document.getElementById("restart-btn");
  
  // Block transition overlay
  const blockTransitionOverlay = document.getElementById("block-transition-overlay");
  const blockTransitionBtn = document.getElementById("block-transition-continue");
  const blockTransitionTitle = document.getElementById("block-transition-title");
  const blockTransitionText = document.getElementById("block-transition-text");
  
  // Block survey overlay
  const blockSurveyOverlay = document.getElementById("block-survey-overlay");
  const blockSurveySubmitBtn = document.getElementById("block-survey-submit");
  const surveyRobotTimeInput = document.getElementById("survey-robot-time");
  const surveyHumanTimeInput = document.getElementById("survey-human-time");
  const surveyRobotClicksInput = document.getElementById("survey-robot-clicks");
  const surveyHumanClicksInput = document.getElementById("survey-human-clicks");
  
  // Feedback overlay
  const feedbackOverlay = document.getElementById("feedback-overlay");
  const feedbackSubmitBtn = document.getElementById("feedback-submit");

  [allocOverlay, roundBanner, blockSurveyOverlay].forEach(el => {
    if (!el) return;
    el.style.pointerEvents = 'auto';
    el.style.zIndex = 99999;
  });

  // Consent form handlers
  if (consentCheckbox && consentAgreeBtn) {
    consentCheckbox.addEventListener('change', () => {
      consentAgreeBtn.disabled = !consentCheckbox.checked;
    });
    
    consentAgreeBtn.addEventListener('click', async () => {
      console.info('[Consent] User agreed to participate');
      
      // Wait for Demo to be ready before logging
      if (!demoReady) {
        console.info('[Consent] Waiting for Demo to initialize...');
        let attempts = 0;
        while (!demoReady && attempts < 50) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
      }
      
      // Log consent to Demo
      if (demoParticipantId && demoAuthReady) {
        try {
          console.info('[Consent] Attempting to log consent with userId:', demoParticipantId);
          await DB.logConsent(true);
          console.info('[Demo] Consent logged successfully');
        } catch (e) {
          console.error('[Demo] Consent logging failed:', e);
        }
      } else {
        console.warn('[Demo] Skipping consent log - authentication not ready. demoAuthReady:', demoAuthReady);
      }
      
      // Hide consent overlay and show app
      consentOverlay.classList.add('hidden');
      const appElement = document.getElementById('app');
      if (appElement) {
        appElement.classList.remove('hidden');
        console.info('[Consent] App element now visible');
      }
      
      // Update UI after app becomes visible
      setTimeout(() => {
        syncControlsPanel();
        // Don't call updateHumanCooldownButtons here - it will be called when game starts
        console.info('[Consent] UI synchronized');
      }, 100);
      
      // Show tutorial after consent
      if (!hasSeenTutorial) {
        hasSeenTutorial = true;
        setTimeout(() => {
          // Add dimming overlay before tutorial
          const dimOverlay = document.createElement('div');
          dimOverlay.id = 'tutorial-dim-overlay';
          dimOverlay.className = 'tutorial-dim-overlay';
          document.body.appendChild(dimOverlay);
          
          // Small delay to ensure DOM is fully ready, then fade in overlay
          setTimeout(() => {
            dimOverlay.style.opacity = '1';
            setTimeout(() => {
              startInstructions();
            }, 300);
          }, 100);
        }, 500);
      }
    });
  }

  // URL parameters will be written inline with each DB.save() call

  // Initialize with Block 1 settings
  // Initialize with settings from the FIRST block in the sequence
  params.nLanes = BLOCKS[currentBlock].nLanes;
  params.nPackages = BLOCKS[currentBlock].nLanes;
  params.stepsToComplete = BLOCKS[currentBlock].stepsToComplete || 12;
  params.robotMoveCooldownMs = BLOCKS[currentBlock].robotMoveCooldownMs;
  params.humanMoveCooldownMs = BLOCKS[currentBlock].humanMoveCooldownMs;
  params.robotErrorsPerPackage = BLOCKS[currentBlock].robotErrorsPerPackage;
  params.humanErrorsPerPackage = BLOCKS[currentBlock].humanErrorsPerPackage;
  params.nRobotLanes = Math.min(params.nRobotLanes, params.nLanes);

  // First screen: Consent form (allocation overlay stays hidden until after consent)
  updateRoundTitle();
  // Don't show allocation overlay yet - wait for consent
  // allocOverlay.classList.remove('hidden');

  // Build field (in background, hidden behind consent)
  layout.recompute();
  sizeField();
  buildField();
  placeInitial();

  // Generate allocation radio button options
  generateAllocationOptions();

  // Tutorial will be shown after consent - removed automatic start

  // Continue -> log allocation + go to Ready
  allocContinue.addEventListener("click", () => {
    // Verify a selection was made
    const selectedRadio = document.querySelector('input[name="allocation"]:checked');
    if (!selectedRadio) {
      console.warn('[Allocation] No option selected');
      return;
    }

    // Get the selected mode and ensure UI is updated
    const selectedMode = selectedRadio.value === 'true'; // Convert string to boolean
    console.log('[Allocation] Continue clicked - selectedRadio.value:', selectedRadio.value, '→ selectedMode:', selectedMode);
    
    // Ensure agent info and themes are updated (in case user didn't click option again)
    updateAllocationSelection(selectedMode);
    console.log('[Allocation] After updateAllocationSelection - params.isRobotMode:', params.isRobotMode);

    // Log allocation (skip Demo for practice)
    if (!isPracticeRound) {
      (async () => {
        try {
          await DB.logAllocation(roundIndex, currentBlock, params.isRobotMode);
        } catch(e) {
          console.warn('[Demo] allocation save failed:', e);
        }
      })();
    }

    // Hide allocation overlay
    allocOverlay.classList.add('hidden');
    
    // Add 1 second delay before starting the round
    setTimeout(() => {
      startGame();
    }, 1000);
  });

  // Button handlers
  if (btnHumanPush) btnHumanPush.addEventListener("click", pushHumanSerial);

  // Next round / end
  restartBtn.addEventListener("click", async () => {
    // Check if we are in the "End Experiment" state (Round > Total)
    if (roundIndex > totalRounds) {
        restartDemo();
        return;
    }

    if (isPracticeRound) {
      // End practice, start actual experiment
      isPracticeRound = false;
      roundIndex = 1;
      roundBanner.classList.add('hidden');
      
      // Show transition message
      const practiceComplete = document.createElement('div');
      practiceComplete.className = 'overlay';
      practiceComplete.innerHTML = `
        <div class="ready-card">
        <p>Great job! Now let's begin the actual study.<br><br>You'll complete <strong>16 rounds</strong> across two factories.</p>
          <h2>✅ Practice Complete!</h2>
          <button class="rb-btn" id="start-actual-btn">Start Actual Rounds</button>
        </div>
      `;
      document.body.appendChild(practiceComplete);
      
      document.getElementById('start-actual-btn').addEventListener('click', () => {
        practiceComplete.remove();
        layout.recompute();
        sizeField();
        buildField();
        placeInitial();
        updateRoundTitle();
        resetAgentInfo();
        allocOverlay.classList.remove('hidden');
      });
      
    } else if (roundIndex <= totalRounds) {
      
      // Check if this is end of block 1 (round 8) - show block survey first
      if (roundIndex === 8 && blockSurveyOverlay) {
        roundBanner.classList.add('hidden');
        
        // Clear previous survey inputs
        if (surveyRobotTimeInput) surveyRobotTimeInput.value = '';
        if (surveyHumanTimeInput) surveyHumanTimeInput.value = '';
        
        // Store that this is the mid-study survey (after block 1)
        blockSurveyOverlay.dataset.surveyType = 'block1';
        blockSurveyOverlay.classList.remove('hidden');
        return;
      }
      
      // Check if this is round 16 - show block survey before final feedback
      if (roundIndex === totalRounds) {
        roundBanner.classList.add('hidden');
        
        // Clear previous survey inputs
        if (surveyRobotTimeInput) surveyRobotTimeInput.value = '';
        if (surveyHumanTimeInput) surveyHumanTimeInput.value = '';
        
        // Store that this is the end-study survey (after block 2)
        blockSurveyOverlay.dataset.surveyType = 'block2';
        blockSurveyOverlay.classList.remove('hidden');
        return;
      }
      
      roundIndex += 1;
      
      // Normal round transition (block transitions handled by survey submit)
      roundBanner.classList.add('hidden');
      layout.recompute();
      sizeField();
      buildField();
      placeInitial();
      updateRoundTitle();
      resetAgentInfo();
      allocOverlay.classList.remove('hidden');
    }
  });

  // Demo redirect function
  function restartDemo() {
    window.location.reload();
  }
  
  // Block transition continue button
  if (blockTransitionBtn) {
    blockTransitionBtn.addEventListener("click", () => {
      blockTransitionOverlay.classList.add('hidden');
      layout.recompute();
      sizeField();
      buildField();
      placeInitial();
      updateRoundTitle();
      generateAllocationOptions();  // Regenerate allocation options
      // updateLaneRegions();       // REMOVED: Function does not exist and caused crash
      allocOverlay.classList.remove('hidden');
    });
  }

  // Block survey submit button
  if (blockSurveySubmitBtn) {
    // Clear error state when user starts typing
    [surveyRobotTimeInput, surveyHumanTimeInput, surveyRobotClicksInput, surveyHumanClicksInput].forEach(input => {
      if (input) {
        input.addEventListener('input', () => {
          input.classList.remove('invalid');
          const surveyError = document.getElementById('survey-error');
          if (surveyError) {
            surveyError.style.display = 'none';
          }
        });
      }
    });
    
    blockSurveySubmitBtn.addEventListener("click", async () => {
      // Get the error message element (or create one if it doesn't exist)
      let surveyError = document.getElementById('survey-error');
      if (!surveyError) {
        surveyError = document.createElement('div');
        surveyError.id = 'survey-error';
        surveyError.className = 'survey-error';
        blockSurveySubmitBtn.parentElement.insertBefore(surveyError, blockSurveySubmitBtn);
      }
      
      // Clear previous error and invalid states
      surveyError.textContent = '';
      surveyError.style.display = 'none';
      surveyRobotTimeInput?.classList.remove('invalid');
      surveyHumanTimeInput?.classList.remove('invalid');
      
      // Validate inputs
      const robotValue = surveyRobotTimeInput?.value?.trim();
      const humanValue = surveyHumanTimeInput?.value?.trim();
      const robotClicksValue = surveyRobotClicksInput?.value?.trim();
      const humanClicksValue = surveyHumanClicksInput?.value?.trim();

      // Check if all fields have values
      if (!robotValue || !humanValue || !robotClicksValue || !humanClicksValue) {
        surveyError.textContent = 'Please answer all questions before continuing.';
        surveyError.style.display = 'block';
        if (!robotValue) surveyRobotTimeInput?.classList.add('invalid');
        if (!humanValue) surveyHumanTimeInput?.classList.add('invalid');
        if (!robotClicksValue) surveyRobotClicksInput?.classList.add('invalid');
        if (!humanClicksValue) surveyHumanClicksInput?.classList.add('invalid');
        return;
      }

      // Check if values are valid positive numbers
      const perceivedRobotTime = parseFloat(robotValue);
      const perceivedHumanTime = parseFloat(humanValue);
      const perceivedRobotClicks = parseInt(robotClicksValue, 10);
      const perceivedHumanClicks = parseInt(humanClicksValue, 10);

      if (isNaN(perceivedRobotTime) || isNaN(perceivedHumanTime) || isNaN(perceivedRobotClicks) || isNaN(perceivedHumanClicks)) {
        surveyError.textContent = 'Please enter valid numbers for all questions.';
        surveyError.style.display = 'block';
        if (isNaN(perceivedRobotTime)) surveyRobotTimeInput?.classList.add('invalid');
        if (isNaN(perceivedHumanTime)) surveyHumanTimeInput?.classList.add('invalid');
        if (isNaN(perceivedRobotClicks)) surveyRobotClicksInput?.classList.add('invalid');
        if (isNaN(perceivedHumanClicks)) surveyHumanClicksInput?.classList.add('invalid');
        return;
      }

      if (perceivedRobotTime < 1 || perceivedHumanTime < 1 || perceivedRobotTime > 50 || perceivedHumanTime > 50) {
        surveyError.textContent = 'Please enter a time between 1 and 50 seconds.';
        surveyError.style.display = 'block';
        if (perceivedRobotTime < 1 || perceivedRobotTime > 50) surveyRobotTimeInput?.classList.add('invalid');
        if (perceivedHumanTime < 1 || perceivedHumanTime > 50) surveyHumanTimeInput?.classList.add('invalid');
        return;
      }

      // Click counts must be integers between 1 and 20
      if (!Number.isInteger(perceivedRobotClicks) || perceivedRobotClicks < 1 || perceivedRobotClicks > 20) {
        surveyError.textContent = 'Please enter a whole number of clicks between 1 and 20 for the robot.';
        surveyError.style.display = 'block';
        surveyRobotClicksInput?.classList.add('invalid');
        return;
      }
      if (!Number.isInteger(perceivedHumanClicks) || perceivedHumanClicks < 1 || perceivedHumanClicks > 20) {
        surveyError.textContent = 'Please enter a whole number of clicks between 1 and 20 for you.';
        surveyError.style.display = 'block';
        surveyHumanClicksInput?.classList.add('invalid');
        return;
      }

      // Check for integers only (no decimals) for time too
      if (!Number.isInteger(perceivedRobotTime) || !Number.isInteger(perceivedHumanTime)) {
        surveyError.textContent = 'Please enter whole numbers only for time (no decimals).';
        surveyError.style.display = 'block';
        if (!Number.isInteger(perceivedRobotTime)) surveyRobotTimeInput?.classList.add('invalid');
        if (!Number.isInteger(perceivedHumanTime)) surveyHumanTimeInput?.classList.add('invalid');
        return;
      }
      
      const surveyType = blockSurveyOverlay?.dataset.surveyType || 'unknown';
      
      // Log survey response
      const surveyData = {
        timestamp: Date.now(),
        surveyType: surveyType,
        block: currentBlock,
        blockOrder: blockSequence,
        perceivedRobotTimeSeconds: perceivedRobotTime,
        perceivedHumanTimeSeconds: perceivedHumanTime
        , perceivedRobotClicks: perceivedRobotClicks
        , perceivedHumanClicks: perceivedHumanClicks
      };
      
      try {
        logEvent('block_survey', surveyData);
        await DB.save(`surveys/${surveyType}`, surveyData);
        console.log("[Block Survey] Submitted:", surveyData);
      } catch (err) {
        console.error("[Block Survey] Error logging:", err);
      }
      
      // Hide survey overlay
      blockSurveyOverlay.classList.add('hidden');
      
      // Determine next action based on survey type
      if (surveyType === 'block1') {
        // After block 1 survey, proceed to block transition
        roundIndex += 1;
        
        // Switch to the second block in the sequence
        const prevBlock = currentBlock;
        currentBlock = blockSequence[1];
        
        // Update ALL block parameters for the new block
        params.nLanes = BLOCKS[currentBlock].nLanes;
        params.nPackages = BLOCKS[currentBlock].nLanes;
        params.stepsToComplete = BLOCKS[currentBlock].stepsToComplete || 12;
        params.robotMoveCooldownMs = BLOCKS[currentBlock].robotMoveCooldownMs;
        params.humanMoveCooldownMs = BLOCKS[currentBlock].humanMoveCooldownMs;
        params.robotErrorsPerPackage = BLOCKS[currentBlock].robotErrorsPerPackage;
        params.humanErrorsPerPackage = BLOCKS[currentBlock].humanErrorsPerPackage;
        
        // Regenerate allocation options for new lane count
        generateAllocationOptions();
        
        // Reset allocation to reasonable starting point
        params.nRobotLanes = Math.min(params.nRobotLanes, params.nLanes);
        
        // Show block transition overlay
        blockTransitionTitle.textContent = "New Factory";
        blockTransitionText.innerHTML = `
          Welcome to a new factory!<br><br>
          Your goal is to complete each round with as little effort as possible.
        `;
        
        if (blockTransitionBtn) {
          blockTransitionBtn.textContent = "Continue to New Factory";
        }
        
        blockTransitionOverlay.classList.remove('hidden');
        
        // Log block transition
        logEvent('block_transition', {
          fromBlock: prevBlock,
          toBlock: currentBlock,
          blockOrder: blockSequence,
          newLaneCount: params.nLanes,
          newRobotSpeed: params.robotMoveCooldownMs,
          newHumanSpeed: params.humanMoveCooldownMs
        });
        
      } else if (surveyType === 'block2') {
        // After block 2 survey, show final feedback
        roundIndex += 1;
        feedbackOverlay.classList.remove('hidden');
        
      }
    });
  }

  // Feedback submit button
  if (feedbackSubmitBtn) {
    feedbackSubmitBtn.addEventListener("click", restartDemo);
  }

  // Resize handling
  let rAF;
  window.addEventListener("resize", () => {
    if (rAF) cancelAnimationFrame(rAF);
    rAF = requestAnimationFrame(() => {
      layout.recompute();
      sizeField();
      syncControlsPanel();
      updateHumanCooldownButtons(performance.now());
    });
  });

  // final alignment
  requestAnimationFrame(() => {
    syncControlsPanel();
    updateHumanCooldownButtons(performance.now());
  });

  /* =========================================================
     Debug Helpers (Exposed to Console)
     ========================================================= */
  window.debugJumpToState = function(state) {
    console.log(`🚀 Jumping to state: ${state}`);
    
    // Stop game loop
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    
    // Hide all overlays first
    const overlays = [
      'consent-overlay', 'round-banner', 'block-transition-overlay', 
      'feedback-overlay', 'tutorial-dim-overlay', 'alloc-overlay'
    ];
    overlays.forEach(id => {
      const el = document.getElementById(id);
      if(el) el.classList.add('hidden');
    });

    if (state === 'round10_complete') {
        isPracticeRound = false;
        roundIndex = 10;
        
        // Show banner
        roundBanner.classList.remove('hidden');
        roundBanner.querySelector('.rb-title').textContent = "✓ Round Complete!";
        restartBtn.textContent = "Complete Study";
        restartBtn.style.display = "inline-block";
        
    } else if (state === 'feedback') {
        isPracticeRound = false;
        roundIndex = 11; // Post round 10
        
        // Show feedback
        feedbackOverlay.classList.remove('hidden');
        
    } else if (state === 'feedback') {
        isPracticeRound = false;
        roundIndex = 11; // Post round 10
        
        // Show feedback
        feedbackOverlay.classList.remove('hidden');
        
    } else if (state === 'block_transition') {
        isPracticeRound = false;
        roundIndex = 6; // Start of Block 2
        
        // Show Block Transition Overlay
        const transOverlay = document.getElementById("block-transition-overlay");
        const title = document.getElementById("block-transition-title");
        const text = document.getElementById("block-transition-text");
        const btn = document.getElementById("block-transition-continue");
        
        title.textContent = "New Factory";
        text.innerHTML = `
          You've been assigned to a <strong>NEW factory</strong>: This factory has a slightly different set of equipments and speed will be affected.<br><br>
          Your goal is to finish delivering packages as quickly as possible in this new factory.
        `;
        
        if (btn) btn.textContent = "Continue to New Factory";
        
        transOverlay.classList.remove('hidden');
    } else if (state === 'block1_survey') {
    isPracticeRound = false;
    roundIndex = 8;
    currentBlock = blockSequence[0];
    document.getElementById('block-survey-overlay').dataset.surveyType = 'block1';
    document.getElementById('block-survey-overlay').classList.remove('hidden');
    
} else if (state === 'block2_survey') {
    isPracticeRound = false;
    roundIndex = 16;
    currentBlock = blockSequence[1];
    document.getElementById('block-survey-overlay').dataset.surveyType = 'block2';
    document.getElementById('block-survey-overlay').classList.remove('hidden');
    
} else if (state === 'feedback') {
    isPracticeRound = false;
    roundIndex = 17;
    document.getElementById('feedback-overlay').classList.remove('hidden');
}
  };
}

window.addEventListener("load", init);
