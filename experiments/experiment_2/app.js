/* =========================================================
   TSA Baggage Screening: Automation Bias Experiment
   Main application — Carousel / Batch mechanic
   4 within-subjects conditions (Speed × Effort)
   ========================================================= */
import {
  assignCondition,
  demoParticipantId,
  finalizeAssignment,
  getDemoParams,
  initDemo,
  readDemoState,
  restartDemo,
  writeDemoState,
} from './demo.js';
import { DB, logEvent, buildSessionInfo } from './data.js';
import { shuffleArray } from './utils.js';

/* =========================================================
   State
   ========================================================= */
const sessionStartTime = Date.now();
let demoParams = {};
let assignment = null;
let pilotAssignment = null;

// Loaded from folder_manifest.json + individual meta.json files
let allTrials = [];          // { imageId, category, meta, basePath }
let batches = [];            // array of arrays, each inner array has 6 trial objects

let currentBatchIndex = 0;   // global batch index (includes practice)
let currentBagIndex = 0;     // 0–5 within current batch
let blockBatchIndex = 0;     // 0-based batch index within current block
let blockBatchTotal = 0;     // total batches in current block
let batchMode = null;        // 'manual' | 'ai'
let globalTrialIndex = 0;
let isPractice = true;

// Block / condition tracking
let blockOrder = [];          // e.g. ['optimal','effort_penalty']
let currentBlockIndex = 0;
let currentConditionKey = null;  // key into CONFIG.conditions
let currentCondition = null;     // the condition object { aiDelayMs, snippetCount, label }

let appBootstrapPromise = null;
const COMPLETION_BUTTON_LABEL = 'Restart Demo';
const COMPLETION_BUTTON_COUNTDOWN_SECONDS = 3;
const THREAT_BUTTON_LABEL = 'Threat - Knife';
const SAFE_BUTTON_LABEL = 'Safe - No Knife';
// Welcome-page instruction preview icons. Swap these placeholders if you want different
// emojis, image tags, or inline SVG for the two batch-choice buttons.
const INSTRUCTION_CHOICE_PREVIEW = {
  manual: {
    iconHtml: '&#128269;',
    label: 'Manual Scan',
  },
  ai: {
    iconHtml: '&#129302;',
    label: 'AI Assisted Scan',
  },
};
let isStartingExperiment = false;

/* =========================================================
   Helpers
   ========================================================= */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(r));

function getResponseEnableDelayMs() {
  return CONFIG.timing?.responseEnableDelayMs ?? 1500;
}

function getBagsPerBatch() {
  return CONFIG.pilot?.enabled ? CONFIG.pilot.bagsPerBatch : CONFIG.carousel.bagsPerBatch;
}

function getTargetPresentPerBatch() {
  return CONFIG.pilot?.enabled ? CONFIG.pilot.targetPresentPerBatch : CONFIG.carousel.targetPresentPerBatch;
}

function waitForImageLoad(img) {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();

  return new Promise(resolve => {
    const done = () => {
      img.onload = null;
      img.onerror = null;
      resolve();
    };

    img.onload = done;
    img.onerror = done;
  });
}

// Block 1 = counterbalanced across 4 conditions; block 2 = always full_suboptimal.
function buildExperimentCells() {
  return CONFIG.conditionOrder.map(conditionKey => ({
    cellId: `${conditionKey}_full_suboptimal`,
    blockOrder: [conditionKey, 'full_suboptimal'],
  }));
}

function buildPilotCells() {
  const blockOrders = CONFIG.pilot.blockOrders || [['manual', 'ai'], ['ai', 'manual']];
  const cells = [];

  for (const aiConditionKey of CONFIG.conditionOrder) {
    for (const order of blockOrders) {
      cells.push({
        cellId: `${order.join('_')}_${aiConditionKey}`,
        blockOrder: [...order],
        aiConditionKey,
      });
    }
  }

  return cells;
}

function getPilotBlockCount() {
  const firstOrder = CONFIG.pilot.blockOrders?.[0];
  return firstOrder ? firstOrder.length : 2;
}

function setConsentStatus(message = '', state = '') {
  const status = $('consent-status');
  if (!status) return;
  status.textContent = message;
  if (state) {
    status.dataset.state = state;
  } else {
    delete status.dataset.state;
  }
}

async function prepareReferenceTables() {
  const conditions = {
    manual: { label: 'Manual' },
  };

  for (const [key, condition] of Object.entries(CONFIG.conditions)) {
    conditions[`ai_${key}`] = {
      label: condition.label,
      aiDelayMs: condition.aiDelayMs,
      snippetCount: getConditionSnippetCount(condition),
    };
  }

  const stimuli = {};
  for (const trial of allTrials) {
    stimuli[trial.imageId] = {
      category: trial.category,
      fileName: trial.meta.file_name,
      basePath: trial.basePath,
    };
  }

  await writeDemoState(`${CONFIG.demoName}/studyInfo/reference`, {
    updatedAt: Date.now(),
    conditions,
    experimentCells: buildExperimentCells(),
    pilotCells: buildPilotCells(),
    stimuli,
  });
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getExperimentAssignmentPath(participantId = demoParticipantId) {
  return `${CONFIG.demoName}/studyInfo/experimentAssignments/${participantId}`;
}

function buildExperimentAssignmentBlocks(blockOrder, imageCounts) {
  const selectedIds = new Set();
  const batchesPerBlock = CONFIG.carousel.batchesPerBlock;
  const targetPerBlock = batchesPerBlock * CONFIG.carousel.targetPresentPerBatch;
  const absentPerBlock = batchesPerBlock * (CONFIG.carousel.bagsPerBatch - CONFIG.carousel.targetPresentPerBatch);

  return blockOrder.map((conditionKey, blockIndex) => {
    const imageConditionKey = conditionKey;
    const targetTrials = selectBalancedTrialsForCondition({
      category: 'target_present',
      count: targetPerBlock,
      imageConditionKey,
      excludeIds: selectedIds,
      imageCounts,
      seed: `${demoParticipantId}:${blockIndex}:target`,
    });
    targetTrials.forEach(trial => selectedIds.add(trial.imageId));

    const absentTrials = selectBalancedTrialsForCondition({
      category: 'target_absent',
      count: absentPerBlock,
      imageConditionKey,
      excludeIds: selectedIds,
      imageCounts,
      seed: `${demoParticipantId}:${blockIndex}:absent`,
    });
    absentTrials.forEach(trial => selectedIds.add(trial.imageId));

    return {
      blockIndex,
      conditionKey,
      imageConditionKey,
      targetImageIds: targetTrials.map(trial => trial.imageId),
      absentImageIds: absentTrials.map(trial => trial.imageId),
      imageIds: shuffleArray([...targetTrials, ...absentTrials]).map(trial => trial.imageId),
    };
  });
}

async function reserveImageCounts(blocks, imageCounts) {
  for (const block of blocks) {
    for (const imageId of block.imageIds) {
      const current = getConditionCountsForImage(imageCounts, imageId, block.imageConditionKey);
      const next = {
        ...current,
        started: current.started + 1,
        updatedAt: Date.now(),
      };

      imageCounts[imageId] = {
        ...(imageCounts[imageId] || {}),
        [block.imageConditionKey]: next,
      };

      await writeDemoState(`${getImageCountsPath()}/${imageId}/${block.imageConditionKey}`, next);
    }
  }
}

function buildBatchesFromAssignment(assignmentRecord) {
  const trialById = new Map(allTrials.map(trial => [trial.imageId, trial]));
  const builtBatches = [];
  const presentPerBatch = CONFIG.carousel.targetPresentPerBatch;
  const absentPerBatch = CONFIG.carousel.bagsPerBatch - presentPerBatch;
  const batchesPerBlock = CONFIG.carousel.batchesPerBlock;

  for (const block of assignmentRecord.blocks) {
    const targetTrials = block.targetImageIds.map(id => trialById.get(id)).filter(Boolean);
    const absentTrials = block.absentImageIds.map(id => trialById.get(id)).filter(Boolean);

    for (let b = 0; b < batchesPerBlock; b++) {
      const targetSlice = targetTrials.slice(b * presentPerBatch, (b + 1) * presentPerBatch);
      const absentSlice = absentTrials.slice(b * absentPerBatch, (b + 1) * absentPerBatch);
      builtBatches.push(shuffleArray([...targetSlice, ...absentSlice]));
    }
  }

  return builtBatches;
}

async function markExperimentImageCountsCompleted() {
  if (!assignment?.blocks) return;

  const imageCounts = await readDemoState(getImageCountsPath(), {}) || {};

  for (const block of assignment.blocks) {
    for (const imageId of block.imageIds) {
      const current = getConditionCountsForImage(imageCounts, imageId, block.imageConditionKey);
      const next = {
        ...current,
        started: Math.max(0, current.started - 1),
        completed: current.completed + 1,
        updatedAt: Date.now(),
      };

      imageCounts[imageId] = {
        ...(imageCounts[imageId] || {}),
        [block.imageConditionKey]: next,
      };

      await writeDemoState(`${getImageCountsPath()}/${imageId}/${block.imageConditionKey}`, next);
    }
  }
}

async function createExperimentAssignment() {
  const cells = buildExperimentCells();
  const forcedCondition = CONFIG.experimentConditionOverride;
  const forcedCellIndex = forcedCondition && CONFIG.conditions[forcedCondition]
    ? cells.findIndex(cell => cell.blockOrder[0] === forcedCondition)
    : -1;
  const fallbackIndex = hashString(demoParticipantId) % cells.length;
  let cellIndex = forcedCellIndex >= 0 ? forcedCellIndex : fallbackIndex;

  if (forcedCellIndex < 0) {
    try {
      cellIndex = await assignCondition(
        CONFIG.demoName, 'experimentCell', cells.length, 60
      );
    } catch (error) {
      console.warn('[Experiment] Demo-balanced assignment failed; using deterministic fallback.', error);
    }
  }

  const cell = cells[cellIndex] || cells[fallbackIndex];
  const choiceButtonOrder = Math.random() < 0.5
    ? ['manual', 'ai']
    : ['ai', 'manual'];

  const imageCounts = await readDemoState(getImageCountsPath(), {}) || {};
  const blocks = buildExperimentAssignmentBlocks(cell.blockOrder, imageCounts);

  const assignmentRecord = {
    status: 'reserved',
    createdAt: Date.now(),
    expiresAt: Date.now() + (60 * 60 * 1000),
    participantId: demoParticipantId,
    cellIndex,
    cellId: cell.cellId,
    blockOrder: cell.blockOrder,
    choiceButtonOrder,
    imageCounterPath: getImageCountsPath(),
    forcedConditionOverride: forcedCellIndex >= 0 ? forcedCondition : null,
    selectionStrategy: forcedCellIndex >= 0
      ? `config override experimentConditionOverride=${forcedCondition}; button order randomized independently; images balanced per block condition`
      : 'demo balanced assignment across ordered condition pairs; button order randomized independently; images balanced per block condition',
    blocks,
  };

  await reserveImageCounts(blocks, imageCounts);
  await writeDemoState(getExperimentAssignmentPath(), assignmentRecord);
  await DB.save('experiment/assignment', assignmentRecord);
  return assignmentRecord;
}

async function markExperimentAssignmentCompleted() {
  if (!assignment || CONFIG.pilot?.enabled) return;

  const completedAssignment = {
    ...assignment,
    status: 'completed',
    completedAt: Date.now(),
  };

  assignment = completedAssignment;
  await writeDemoState(getExperimentAssignmentPath(), completedAssignment);
  await DB.save('experiment/completion', {
    assignment_status: 'completed',
    cell_id: completedAssignment.cellId,
    block_order: completedAssignment.blockOrder,
    choice_button_order: completedAssignment.choiceButtonOrder,
  });
}

function applyChoiceButtonOrder(choiceButtonOrder = assignment?.choiceButtonOrder) {
  const container = document.querySelector('.choice-buttons');
  const btnDiy = $('btn-diy');
  const btnAi = $('btn-ai');
  if (!container || !btnDiy || !btnAi) return;

  const order = Array.isArray(choiceButtonOrder) && choiceButtonOrder.length === 2
    ? choiceButtonOrder
    : ['manual', 'ai'];
  const buttonByMode = {
    manual: btnDiy,
    ai: btnAi,
  };

  order.forEach(mode => {
    const button = buttonByMode[mode];
    if (button) container.appendChild(button);
  });

  container.dataset.choiceOrder = order.join('_');
}

/* =========================================================
   Screen management
   ========================================================= */
const screenIds = [
  'choice-screen', 'diy-screen',
  'ai-processing-screen', 'ai-screen',
];

function showScreen(id) {
  screenIds.forEach(s => $(s).classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function getTotalImageCount() {
  const total = batches.reduce((sum, batch) => sum + batch.length, 0);
  return total > 0 ? total : getBagsPerBatch();
}

function getTotalTrialCount() {
  return batches.length > 0 ? batches.length : 1;
}

function updateTrialCounter() {
  const totalImages = getTotalImageCount();
  const totalTrials = getTotalTrialCount();
  const imageNumber = Math.min(totalImages, Math.max(1, globalTrialIndex + 1));
  const trialNumber = Math.min(
    totalTrials,
    Math.max(1, Math.floor((imageNumber - 1) / getBagsPerBatch()) + 1)
  );
  const pct = (imageNumber / totalImages) * 100;
  const label = `Image ${imageNumber} of ${totalImages} | Batch ${trialNumber} of ${totalTrials}`;

  $('progress-label').textContent = label;
  $('progress-fill').style.width = `${pct}%`;
  $('progress-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('progress-bar').setAttribute('aria-valuetext', label);
}

/* =========================================================
   Data loading
   ========================================================= */
async function loadFolderManifest() {
  const resp = await fetch(CONFIG.paths.folderManifest);
  const manifest = await resp.json();

  const trials = [];

  for (const imageId of manifest.target_present) {
    const basePath = `${CONFIG.paths.targetPresent}${imageId}/`;
    try {
      const metaResp = await fetch(`${basePath}meta.json`);
      const meta = await metaResp.json();
      trials.push({ imageId, category: 'target_present', meta, basePath });
    } catch (e) {
      console.warn(`[Data] Failed to load meta for ${imageId}`, e);
    }
  }

  for (const imageId of manifest.target_absent) {
    const basePath = `${CONFIG.paths.targetAbsent}${imageId}/`;
    try {
      const metaResp = await fetch(`${basePath}meta.json`);
      const meta = await metaResp.json();
      trials.push({ imageId, category: 'target_absent', meta, basePath });
    } catch (e) {
      console.warn(`[Data] Failed to load meta for ${imageId}`, e);
    }
  }

  allTrials = trials;
  console.log(`[Data] Loaded ${trials.length} trial folders`);
}

/**
 * Build batches from the trial pool.
 * Adapts to pilot mode (fewer batches) or main experiment.
 */
function buildBatches() {
  const present = shuffleArray(allTrials.filter(t => t.category === 'target_present'));
  const absent = shuffleArray(allTrials.filter(t => t.category === 'target_absent'));

  const perBatch = getBagsPerBatch();
  const presPerBatch = getTargetPresentPerBatch();
  const absPerBatch = perBatch - presPerBatch;

  let totalBatches;
  if (CONFIG.pilot.enabled) {
    // Pilot: assigned block order length x batchesPerBlock.
    totalBatches = getPilotBlockCount() * CONFIG.pilot.batchesPerBlock;
  } else {
    const numBlocks = assignment?.blockOrder?.length || 2;
    totalBatches = CONFIG.carousel.practiceBatches + (numBlocks * CONFIG.carousel.batchesPerBlock);
  }

  batches = [];
  let pi = 0, ai = 0;

  for (let b = 0; b < totalBatches; b++) {
    const batch = [];
    for (let i = 0; i < presPerBatch; i++) {
      batch.push(present[pi % present.length]);
      pi++;
    }
    for (let i = 0; i < absPerBatch; i++) {
      batch.push(absent[ai % absent.length]);
      ai++;
    }
    batches.push(shuffleArray(batch));
  }

  console.log(`[Data] Built ${batches.length} batches of ${perBatch}`);
}

/* =========================================================
   Path helpers
   ========================================================= */
function getBaseImagePath(trial) {
  return `${trial.basePath}${trial.meta.file_name}`;
}

function getSnippetPath(trial, filename) {
  return `${trial.basePath}${filename}`;
}

function getConditionSnippetCount(condition = currentCondition) {
  return condition?.snippetCount ?? 3;
}

function getLureSnippets(trial) {
  const lures = Array.isArray(trial?.meta?.lures) ? trial.meta.lures : null;

  if (lures && lures.length > 0) {
    return lures
      .map((lure, idx) => ({
        filename: `lure_${String(Number(lure?.index) || (idx + 1)).padStart(2, '0')}.png`,
        bbox: Array.isArray(lure?.bbox) ? lure.bbox : null,
        bboxPadded: null,
        role: 'lure',
      }))
      .filter(snippet => Array.isArray(snippet.bbox) && snippet.bbox.length >= 4);
  }

  const legacyBboxes = Array.isArray(trial?.meta?.lure_bboxes) ? trial.meta.lure_bboxes : [];
  const legacyBboxesPadded = Array.isArray(trial?.meta?.lure_bboxes_padded) ? trial.meta.lure_bboxes_padded : [];

  return legacyBboxes
    .map((bbox, idx) => ({
      filename: `lure_${String(idx + 1).padStart(2, '0')}.png`,
      bbox,
      bboxPadded: legacyBboxesPadded[idx] ?? null,
      role: 'lure',
    }))
    .filter(snippet => Array.isArray(snippet.bbox) && snippet.bbox.length >= 4);
}

function buildInstructionBoxStyle(bbox, imageWidth, imageHeight) {
  if (!Array.isArray(bbox) || bbox.length < 4 || !imageWidth || !imageHeight) return '';

  const [left, top, width, height] = bbox;
  return [
    `--instruction-box-left:${(left / imageWidth) * 100}%`,
    `--instruction-box-top:${(top / imageHeight) * 100}%`,
    `--instruction-box-width:${(width / imageWidth) * 100}%`,
    `--instruction-box-height:${(height / imageHeight) * 100}%`,
  ].join(';');
}

function getInstructionSampleAssets() {
  const sampleTrial = allTrials.find(trial =>
    trial.category === 'target_present' &&
    trial.meta?.file_name &&
    Array.isArray(trial.meta?.target_bbox) &&
    trial.meta.target_bbox.length >= 4 &&
    Number(trial.meta.image_width) > 0 &&
    Number(trial.meta.image_height) > 0
  );

  if (!sampleTrial) {
    return {
      sampleXray: '',
      sampleSnippet: '',
      sampleBoxStyle: '',
    };
  }

  return {
    sampleXray: getBaseImagePath(sampleTrial),
    sampleSnippet: getSnippetPath(sampleTrial, 'target.png'),
    sampleBoxStyle: buildInstructionBoxStyle(
      sampleTrial.meta.target_bbox,
      sampleTrial.meta.image_width,
      sampleTrial.meta.image_height
    ),
  };
}

/**
 * Build the list of snippet objects for the AI panel.
 * Uses the current condition's total snippet count.
 * Target-present bags always include the target snippet, then fill the rest with lures.
 * Target-absent/null bags use the same total number of lure snippets.
 */
function buildSnippetList(trial) {
  const totalSnippets = getConditionSnippetCount();
  const snippets = [];

  if (trial.category === 'target_present' && trial.meta.target_bbox) {
    snippets.push({
      filename: 'target.png',
      bbox: trial.meta.target_bbox,
      bboxPadded: trial.meta.target_bbox_padded,
      role: 'target',
    });
  }

  const availableLures = shuffleArray(getLureSnippets(trial));
  const luresNeeded = Math.max(0, totalSnippets - snippets.length);
  snippets.push(...availableLures.slice(0, luresNeeded));

  return shuffleArray(snippets);
}

function buildBagDecisionResult(trial, userSaidThreat, rtMs, extra = {}) {
  const actualThreat = trial.category === 'target_present';
  return {
    decision: userSaidThreat ? 'threat' : 'safe',
    correct: userSaidThreat === actualThreat,
    rt_ms: rtMs,
    hit: actualThreat && userSaidThreat,
    false_alarm: !actualThreat && userSaidThreat,
    miss: actualThreat && !userSaidThreat,
    correct_rejection: !actualThreat && !userSaidThreat,
    ...extra,
  };
}

function setDecisionButtons(threatBtn, safeBtn, { enabled = false, onDecision = null } = {}) {
  threatBtn.disabled = !enabled;
  safeBtn.disabled = !enabled;
  threatBtn.onclick = onDecision ? () => onDecision(true) : null;
  safeBtn.onclick = onDecision ? () => onDecision(false) : null;
}

function setBBoxState(box, { active = false, inspected = false, interactiveEnabled = true } = {}) {
  if (!box) return;

  box.classList.toggle('bbox-active', active);
  box.classList.toggle('bbox-inspected', inspected);
  box.classList.toggle('bbox-disabled', !interactiveEnabled);
  box.tabIndex = -1;
}

function renderAiSelectionPanel({
  trial,
  snippets,
  selectedIdx,
}) {
  const panel = $('snippet-panel');
  panel.className = 'snippet-panel ai-selection-panel';
  panel.innerHTML = '';

  if (selectedIdx === null || !snippets[selectedIdx]) {
    const emptyState = document.createElement('div');
    emptyState.className = 'ai-selection-empty';
    panel.appendChild(emptyState);
  } else {
    const snippet = snippets[selectedIdx];
    const card = document.createElement('div');
    card.className = 'snippet-card ai-selection-card';

    const img = document.createElement('img');
    img.className = 'snippet-card-image ai-selection-image';
    img.src = getSnippetPath(trial, snippet.filename);
    img.alt = `Flagged region ${selectedIdx + 1}`;

    card.appendChild(img);
    panel.appendChild(card);
  }
}

function syncAiBBoxStates({ snippets, bboxElements, selectedIdx, inspectedSet, interactiveEnabled }) {
  snippets.forEach((snippet, idx) => {
    const box = bboxElements[idx];
    setBBoxState(box, {
      active: idx === selectedIdx,
      inspected: inspectedSet.has(idx),
      interactiveEnabled,
    });
  });
}

function getHoveredSnippetIndex(pointerX, pointerY, bboxEntries) {
  let best = null;

  bboxEntries.forEach(entry => {
    if (!entry) return;
    const withinX = pointerX >= entry.left && pointerX <= entry.left + entry.width;
    const withinY = pointerY >= entry.top && pointerY <= entry.top + entry.height;
    if (!withinX || !withinY) return;

    const dx = pointerX - entry.centerX;
    const dy = pointerY - entry.centerY;
    const distanceSq = (dx * dx) + (dy * dy);

    if (!best || distanceSq < best.distanceSq || (distanceSq === best.distanceSq && entry.idx < best.idx)) {
      best = {
        idx: entry.idx,
        distanceSq,
      };
    }
  });

  return best ? best.idx : null;
}

function installAiHoverSelection({ imageWrap, baseImg, bboxEntries, onHoverSnippet, isEnabled, onLeave }) {
  if (typeof imageWrap._cleanupAiHoverSelection === 'function') {
    imageWrap._cleanupAiHoverSelection();
  }

  const handlePointerMove = (event) => {
    if (!isEnabled()) return;

    const imgRect = baseImg.getBoundingClientRect();
    const pointerX = event.clientX - imgRect.left;
    const pointerY = event.clientY - imgRect.top;

    if (pointerX < 0 || pointerY < 0 || pointerX > imgRect.width || pointerY > imgRect.height) {
      if (onLeave) onLeave();
      return;
    }

    const hoveredIdx = getHoveredSnippetIndex(pointerX, pointerY, bboxEntries);
    if (hoveredIdx === null) {
      if (onLeave) onLeave();
      return;
    }

    onHoverSnippet(hoveredIdx, {
      pointerX,
      pointerY,
      imageWidth: imgRect.width,
      imageHeight: imgRect.height,
    });
  };

  const handlePointerLeave = () => {
    if (onLeave) onLeave();
  };

  imageWrap.addEventListener('mousemove', handlePointerMove);
  imageWrap.addEventListener('mouseleave', handlePointerLeave);

  const cleanup = () => {
    imageWrap.removeEventListener('mousemove', handlePointerMove);
    imageWrap.removeEventListener('mouseleave', handlePointerLeave);
    if (imageWrap._cleanupAiHoverSelection === cleanup) {
      delete imageWrap._cleanupAiHoverSelection;
    }
  };

  imageWrap._cleanupAiHoverSelection = cleanup;
  return cleanup;
}

async function mountAiBoundingBoxes({ imageWrap, baseImg, snippets }) {
  const sx = baseImg.naturalWidth > 0 ? baseImg.clientWidth / baseImg.naturalWidth : 0;
  const sy = baseImg.naturalHeight > 0 ? baseImg.clientHeight / baseImg.naturalHeight : 0;
  const bboxEntries = [];

  snippets.forEach((snippet, idx) => {
    const bbox = snippet.bbox;
    if (!bbox || bbox.length < 4) return;

    const left = bbox[0] * sx;
    const top = bbox[1] * sy;
    const width = bbox[2] * sx;
    const height = bbox[3] * sy;
    const box = document.createElement('div');
    box.className = 'bbox-overlay';
    box.dataset.snippetIdx = idx;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.setAttribute('aria-label', `Inspect AI region ${idx + 1}`);

    imageWrap.appendChild(box);
    bboxEntries[idx] = {
      idx,
      box,
      left,
      top,
      width,
      height,
      centerX: left + (width / 2),
      centerY: top + (height / 2),
    };
  });

  return bboxEntries;
}

/* =========================================================
   Instructions
   ========================================================= */
/**
 * Build instruction pages.
 * @param {object} opts
 * @param {boolean} opts.showIntro — include the general welcome page
 * @param {string}  opts.blockMode — 'manual' or 'ai' (single block to explain)
 */
function buildInstructionPages({ showIntro = true, blockMode = null } = {}) {
  const container = $('instructions-pages-container');
  container.innerHTML = '';
  const pageEntries = [];

  const { sampleXray, sampleSnippet, sampleBoxStyle } = getInstructionSampleAssets();
  const sampleBoxAttr = sampleBoxStyle ? ` style="${sampleBoxStyle}"` : '';

  const batchCount = CONFIG.pilot && CONFIG.pilot.enabled
    ? CONFIG.pilot.batchesPerBlock : CONFIG.carousel.batchesPerBlock;
  const isExperimentInstructions = !blockMode;
  const bagsPerBatch = isExperimentInstructions
    ? CONFIG.carousel.bagsPerBatch
    : CONFIG.pilot.bagsPerBatch;
  const bagIconsHtml = Array.from(
    { length: bagsPerBatch },
    () => '<span class="instructions-bag-icon">&#129523;</span>'
  ).join('');

  const addPage = (section, html) => {
    const page = document.createElement('div');
    page.className = 'instructions-page' + (pageEntries.length > 0 ? ' hidden' : '');
    page.dataset.section = section;
    page.innerHTML = html;
    pageEntries.push({ section, el: page });
  };

  if (showIntro) {
    if (isExperimentInstructions) {
      addPage('intro', `
        <h2>Welcome to the Study</h2>
        <p>In this study you will take on the role of a Transportation Security Officer at an airport checkpoint. Your job is to screen carry-on baggage by examining X-ray scans.</p>
        <p>You are assigned to look for one type of threat: <strong>knives</strong>. For each bag, decide whether a knife is present or the bag is safe.</p>
        <p>Bags arrive in <strong>batches of ${bagsPerBatch}</strong>. At the start of each batch, you will choose either <strong>doing it yourself</strong> or <strong>having AI help you with scanning</strong>. That choice applies to the next ${bagsPerBatch} bags.</p>
        <div class="instructions-batch-demo">
          <div class="instructions-choice-preview" aria-hidden="true">
            <div class="instructions-choice-preview-label">Choose one:</div>
            <button class="choice-btn choice-btn-diy" disabled>
              <span class="choice-btn-icon">${INSTRUCTION_CHOICE_PREVIEW.manual.iconHtml}</span>
              <span class="choice-btn-label">${INSTRUCTION_CHOICE_PREVIEW.manual.label}</span>
            </button>
            <button class="choice-btn choice-btn-ai" disabled>
              <span class="choice-btn-icon">${INSTRUCTION_CHOICE_PREVIEW.ai.iconHtml}</span>
              <span class="choice-btn-label">${INSTRUCTION_CHOICE_PREVIEW.ai.label}</span>
            </button>
          </div>
          <div class="instructions-batch-arrow" aria-hidden="true">&rarr;</div>
          <div class="instructions-batch-preview">
            <div class="instructions-batch-preview-label">This choice applies to ${bagsPerBatch} bags</div>
            <div class="instructions-bag-grid" aria-hidden="true">
              ${bagIconsHtml}
            </div>
            <div class="instructions-caption">After the ${bagsPerBatch} bags are complete, you will choose again for the next batch.</div>
          </div>
        </div>
      `);
    } else {
      addPage('intro', `
        <h2>Welcome to the Study</h2>
        <p>In this study you will take on the role of a Transportation Security Officer at an airport checkpoint. Your job is to screen carry-on baggage by examining X-ray scans.</p>
        <p>You are assigned to look for one type of threat: <strong>knives</strong>. For each bag, decide whether a knife is present or the bag is safe.</p>
        <p>Bags arrive in batches of ${bagsPerBatch}. You will review each bag in a batch one at a time before moving on to the next batch.</p>
        <p>You will receive feedback after each image.</p>
      `);
    }
  }

  if (blockMode === 'manual' || isExperimentInstructions) {
    addPage('manual', isExperimentInstructions ? `
      <h2>Manual Scanning</h2>
      <p>If you choose to do the scans yourself, you will inspect each X-ray scan and decide on your own whether a knife is present.</p>
      <p>This choice applies to the full batch of ${bagsPerBatch} bags. You will make one threat-or-safe decision for each bag in the batch.</p>
      <img src="${sampleXray}" alt="Example X-ray scan" class="instructions-sample-img" />
      <p>Use the two buttons below each scan:</p>
      <div class="instructions-ui-preview">
        <button class="action-btn action-btn-threat" disabled>${THREAT_BUTTON_LABEL}</button>
        <button class="action-btn action-btn-safe" disabled>${SAFE_BUTTON_LABEL}</button>
      </div>
    ` : `
      <h2>Your Screening Station</h2>
      <p>You have been assigned to a standard screening lane. You will inspect each X-ray scan and decide on your own whether a knife is present. You will process <strong>${batchCount} batches</strong> at this station.</p>
      <img src="${sampleXray}" alt="Example X-ray scan" class="instructions-sample-img" />
      <p>Use the two buttons below each scan:</p>
      <div class="instructions-ui-preview">
        <button class="action-btn action-btn-threat" disabled>${THREAT_BUTTON_LABEL}</button>
        <button class="action-btn action-btn-safe" disabled>${SAFE_BUTTON_LABEL}</button>
      </div>
    `);
  }

  if (blockMode === 'ai' || isExperimentInstructions) {
    addPage('ai', isExperimentInstructions ? `
      <h2>AI Assisted Scanning</h2>
      <p>If you choose to have AI assist you with the scans, the AI will highlight suspicious regions on the X-ray for each bag in the batch.</p>
      <p>Hover over a highlighted region to view a cropped preview in the side panel. Use the full X-ray as your main source of information. The preview is optional.</p>
      <p>This choice also applies to the full batch of ${bagsPerBatch} bags. You do not need to inspect every highlighted region before deciding.</p>
      <div class="instructions-sample-row instructions-hover-demo">
        <div class="instructions-xray-demo">
          <img src="${sampleXray}" alt="Full X-ray" />
          <span class="instructions-hover-box"${sampleBoxAttr}></span>
        </div>
        <div class="instructions-snippet-demo" tabindex="0" aria-label="Example cropped AI detection card">
          <img src="${sampleSnippet}" alt="Flagged region" />
        </div>
      </div>
      <div class="instructions-ui-preview">
        <button class="action-btn action-btn-threat" disabled>${THREAT_BUTTON_LABEL}</button>
        <button class="action-btn action-btn-safe" disabled>${SAFE_BUTTON_LABEL}</button>
      </div>
    ` : `
      <h2>Your New Screening Station</h2>
      <p>This station includes AI assistance. You will process <strong>${batchCount} batches</strong> here.</p>
      <p>For each bag, the AI highlights suspicious regions on the X-ray. Hover over a highlighted region to view a cropped preview in the side panel.</p>
      <p>Use the full X-ray as your main source of information. The preview is optional. Choose <strong>${THREAT_BUTTON_LABEL}</strong> if you think a knife is present, or <strong>${SAFE_BUTTON_LABEL}</strong> if not. You do not need to inspect every highlighted region before deciding.</p>
      <div class="instructions-sample-row instructions-hover-demo">
        <div class="instructions-xray-demo">
          <img src="${sampleXray}" alt="Full X-ray" />
          <span class="instructions-hover-box"${sampleBoxAttr}></span>
        </div>
        <div class="instructions-snippet-demo" tabindex="0" aria-label="Example cropped AI detection card">
          <img src="${sampleSnippet}" alt="Flagged region" />
        </div>
      </div>
      <div class="instructions-ui-preview">
        <button class="action-btn action-btn-threat" disabled>${THREAT_BUTTON_LABEL}</button>
        <button class="action-btn action-btn-safe" disabled>${SAFE_BUTTON_LABEL}</button>
      </div>
    `);
  }

  if (blockMode || isExperimentInstructions) {
    addPage('reminder', `
      <h2>Before You Start</h2>
      <p>Your target is <strong>knives only</strong>.</p>
      <p>Choose <strong>${THREAT_BUTTON_LABEL}</strong> only when you think a knife is present.</p>
      <p>Choose <strong>${SAFE_BUTTON_LABEL}</strong> when you do not see a knife, even if another object looks unusual or hazardous.</p>
      <div class="instructions-ui-preview">
        <button class="action-btn action-btn-threat" disabled>${THREAT_BUTTON_LABEL}</button>
        <button class="action-btn action-btn-safe" disabled>${SAFE_BUTTON_LABEL}</button>
      </div>
    `);
  }

  pageEntries.forEach(({ el }) => container.appendChild(el));
  return pageEntries;
}

async function showInstructions({ showIntro = true, blockMode = null, startSection = null } = {}) {
  const overlay = $('instructions-overlay');
  const pageEntries = buildInstructionPages({ showIntro, blockMode });
  const pages = pageEntries.map(entry => entry.el);
  const back = $('instructions-back');
  const next = $('instructions-next');
  const start = $('instructions-start');
  const advanceDelaySeconds = 5;
  let advanceTimer = null;
  let advanceEnabled = false;

  let page = Math.max(0, pageEntries.findIndex(entry => entry.section === startSection));
  const totalPages = pages.length;

  const getAdvanceButton = () => page === totalPages - 1 ? start : next;

  const clearAdvanceTimer = () => {
    if (advanceTimer) {
      clearInterval(advanceTimer);
      advanceTimer = null;
    }
  };

  const startAdvanceDelay = () => {
    clearAdvanceTimer();
    advanceEnabled = false;

    const btn = getAdvanceButton();
    const baseText = page === totalPages - 1 ? 'Start' : 'Next';
    let remaining = advanceDelaySeconds;

    btn.disabled = true;
    btn.textContent = `${baseText} (${remaining})`;

    advanceTimer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        btn.textContent = `${baseText} (${remaining})`;
        return;
      }

      clearAdvanceTimer();
      advanceEnabled = true;
      btn.disabled = false;
      btn.textContent = baseText;
    }, 1000);
  };

  const setPage = (p) => {
    page = p;
    pages.forEach((el, i) => el.classList.toggle('hidden', i !== page));
    back.disabled = page === 0;
    next.classList.toggle('hidden', page === totalPages - 1);
    start.classList.toggle('hidden', page !== totalPages - 1);
    next.textContent = 'Next';
    start.textContent = 'Start';
    next.disabled = true;
    start.disabled = true;
    startAdvanceDelay();
  };

  setPage(0);
  overlay.classList.remove('hidden');

  return new Promise(resolve => {
    back.onclick = () => { if (page > 0) setPage(page - 1); };
    next.onclick = () => {
      if (!advanceEnabled) return;
      if (page < totalPages - 1) setPage(page + 1);
    };
    start.onclick = () => {
      if (!advanceEnabled) return;
      clearAdvanceTimer();
      overlay.classList.add('hidden');
      $('app').classList.remove('hidden');
      resolve();
    };
  });
}

/* =========================================================
   Transition overlay
   ========================================================= */
async function showTransition(title, message, { html = false, continueDelaySeconds = 0 } = {}) {
  const overlay = $('block-transition-overlay');
  $('block-transition-title').textContent = title;
  if (html) {
    $('block-transition-text').innerHTML = message;
  } else {
    $('block-transition-text').textContent = message;
  }
  overlay.classList.remove('hidden');
  await new Promise(resolve => {
    prepareTransitionContinueButton({
      delaySeconds: continueDelaySeconds,
      onClick: () => {
      overlay.classList.add('hidden');
      resolve();
      },
    });
  });
}

function getReassignmentTransitionHtml() {
  return `
    <div class="transition-copy">
      <div class="transition-chip">Message</div>
      <p>Good job completing your work at your first TSA station. You have now been reassigned to a new screening station.</p>
      <p class="transition-focus"><strong>Please note:</strong> any AI assistance available at this station may work somewhat differently from before, but your task remains the same. Continue deciding whether a knife is present or the bag is safe.</p>
    </div>
  `;
}

function prepareTransitionContinueButton({ delaySeconds = 0, onClick }) {
  const button = $('block-transition-continue');
  const defaultLabel = button.dataset.defaultLabel || button.textContent || 'Continue';
  button.dataset.defaultLabel = defaultLabel;

  if (button._countdownIntervalId) {
    clearInterval(button._countdownIntervalId);
    button._countdownIntervalId = null;
  }

  button.disabled = false;
  button.textContent = defaultLabel;
  button.onclick = onClick;

  if (delaySeconds <= 0) return;

  let remaining = delaySeconds;
  button.disabled = true;
  button.textContent = `${defaultLabel} (${remaining})`;

  button._countdownIntervalId = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      button.textContent = `${defaultLabel} (${remaining})`;
      return;
    }

    clearInterval(button._countdownIntervalId);
    button._countdownIntervalId = null;
    button.disabled = false;
    button.textContent = defaultLabel;
  }, 1000);
}

function formatTrialFeedback(bagEntry) {
  return bagEntry.correct ? 'Correct' : 'Incorrect';
}

async function showTrialFeedback(bagEntry) {
  const overlay = $('block-transition-overlay');
  const title = $('block-transition-title');
  const text = $('block-transition-text');
  const button = $('block-transition-continue');
  const lines = formatTrialFeedback(bagEntry);

  title.textContent = lines;
  text.textContent = '';
  button.classList.add('hidden');
  overlay.classList.remove('hidden');

  await sleep(CONFIG.timing.feedbackDuration ?? 1000);

  overlay.classList.add('hidden');
  button.classList.remove('hidden');
}

function formatBatchFeedback() {
  return [
    'Another batch incoming.',
  ];
}

async function showBatchFeedback(batchSummary, nextMessage) {
  void batchSummary;
  void nextMessage;
  const lines = formatBatchFeedback();
  await showTransition('You have completed a batch of images.', lines.join('\n'));
}

/**
 * Show a fullscreen countdown (3… 2… 1…) before the first bag appears.
 */
async function showCountdown(seconds = 3) {
  const overlay = $('block-transition-overlay');
  const title = $('block-transition-title');
  const text = $('block-transition-text');
  const btn = $('block-transition-continue');

  btn.classList.add('hidden');
  text.textContent = '';
  overlay.classList.remove('hidden');

  for (let i = seconds; i >= 1; i--) {
    title.textContent = `Starting in ${i}…`;
    await sleep(1000);
  }

  overlay.classList.add('hidden');
  btn.classList.remove('hidden');
}

/* =========================================================
   Manual (DIY) bag screen
   ========================================================= */
async function runManualBag(trial) {
  const diyImg = $('diy-image');
  const threatBtn = $('diy-threat-btn');
  const safeBtn = $('diy-safe-btn');

  setDecisionButtons(threatBtn, safeBtn);

  diyImg.src = getBaseImagePath(trial);
  await waitForImageLoad(diyImg);

  showScreen('diy-screen');
  const bagStart = performance.now();

  await sleep(getResponseEnableDelayMs());

  return new Promise(resolve => {
    const finish = (userSaidThreat) => {
      setDecisionButtons(threatBtn, safeBtn);
      resolve(buildBagDecisionResult(trial, userSaidThreat, performance.now() - bagStart));
    };

    setDecisionButtons(threatBtn, safeBtn, { enabled: true, onDecision: finish });
  });
}

/* =========================================================
   AI Mode: processing delay → image-first review
   Participants can inspect highlighted regions and decide on the bag when ready.
   ========================================================= */
async function runAiBag(trial) {
  const delayMs = currentCondition ? currentCondition.aiDelayMs : 0;

  // --- Show processing spinner (no countdown) ---
  if (delayMs > 0) {
    showScreen('ai-processing-screen');
    await sleep(delayMs);
  }

  // --- Build and show the split layout ---
  const baseImg = $('ai-base-image');
  const imageWrap = $('ai-image-wrap');
  const threatBtn = $('ai-threat-btn');
  const safeBtn = $('ai-safe-btn');

  baseImg.src = getBaseImagePath(trial);
  await waitForImageLoad(baseImg);
  setDecisionButtons(threatBtn, safeBtn);

  // Clear old bounding boxes
  imageWrap.querySelectorAll('.bbox-overlay').forEach(el => el.remove());

  // Build snippets for this condition
  const snippets = buildSnippetList(trial);
  const bboxElements = [];
  const inspectedSet = new Set();
  const inspectedOrder = [];
  let selectedIdx = null;
  let hoverEnabled = false;
  let decisionEnabled = false;
  let finished = false;

  return new Promise(resolve => {
    let bagStart = 0;
    let cleanupHoverSelection = () => {};
    const refreshAiUi = () => {
      renderAiSelectionPanel({
        trial,
        snippets,
        selectedIdx,
      });

      syncAiBBoxStates({
        snippets,
        bboxElements,
        selectedIdx,
        inspectedSet,
        interactiveEnabled: hoverEnabled,
      });
    };

    const hoverEvents = [];

    const recordHoverSelection = (idx, pointerMeta = null) => {
      if (!inspectedSet.has(idx)) {
        inspectedSet.add(idx);
        inspectedOrder.push(idx);
      }

      const hoverRtMs = Math.round(performance.now() - bagStart);
      const hoverEvent = {
        snippet_index: idx + 1,
        snippet_role: snippets[idx]?.role ?? null,
        hover_rt_ms: hoverRtMs,
        cursor_x_pct: pointerMeta && pointerMeta.imageWidth > 0
          ? Number((pointerMeta.pointerX / pointerMeta.imageWidth).toFixed(4))
          : null,
        cursor_y_pct: pointerMeta && pointerMeta.imageHeight > 0
          ? Number((pointerMeta.pointerY / pointerMeta.imageHeight).toFixed(4))
          : null,
      };

      hoverEvents.push(hoverEvent);
      logEvent('ai_snippet_hovered', hoverEvent);
    };

    const selectSnippet = (idx, pointerMeta = null) => {
      if (!hoverEnabled || finished || idx === selectedIdx) return;
      recordHoverSelection(idx, pointerMeta);
      selectedIdx = idx;
      refreshAiUi();
    };

    let finish = (userSaidThreat) => {
      if (!decisionEnabled || finished) return;
      finished = true;
      cleanupHoverSelection();
      setDecisionButtons(threatBtn, safeBtn);

      logEvent('ai_bag_decision', {
        decision: userSaidThreat ? 'threat' : 'safe',
        snippets_total: snippets.length,
        snippets_hovered_count: inspectedSet.size,
        snippet_hover_event_count: hoverEvents.length,
      });

      resolve(buildBagDecisionResult(trial, userSaidThreat, performance.now() - bagStart, {
        selection_method: 'hover_nearest_center',
        snippets_total: snippets.length,
        snippets_hovered_count: inspectedSet.size,
        snippets_hovered_order: inspectedOrder.map(idx => idx + 1),
        snippet_hover_event_count: hoverEvents.length,
        snippet_hover_events: hoverEvents,
        hovered_all_snippets: inspectedSet.size === snippets.length,
        selected_region_index: selectedIdx === null ? null : selectedIdx + 1,
      }));
    };

    refreshAiUi();

    showScreen('ai-screen');
    bagStart = performance.now();

    nextFrame().then(async () => {
      const mounted = await mountAiBoundingBoxes({
        imageWrap,
        baseImg,
        snippets,
      });
      mounted.forEach((entry, idx) => { bboxElements[idx] = entry?.box; });
      hoverEnabled = true;
      cleanupHoverSelection = installAiHoverSelection({
        imageWrap,
        baseImg,
        bboxEntries: mounted,
        onHoverSnippet: selectSnippet,
        isEnabled: () => hoverEnabled && !finished,
      });
      refreshAiUi();

      await sleep(getResponseEnableDelayMs());
      decisionEnabled = true;
      setDecisionButtons(threatBtn, safeBtn, { enabled: true, onDecision: finish });
      refreshAiUi();
    });
  });
}

/* =========================================================
   Carousel: run a single batch
   Feedback is shown after each image.
   ========================================================= */
async function runBatch(batchIdx) {
  const batch = batches[batchIdx];
  const batchResults = [];
  const batchStartTime = performance.now();

  for (let bagIdx = 0; bagIdx < batch.length; bagIdx++) {
    currentBagIndex = bagIdx;
    updateTrialCounter();

    const trial = batch[bagIdx];

    // Run the bag — next bag loads instantly after resolution
    let result;
    if (batchMode === 'manual') {
      result = await runManualBag(trial);
    } else {
      result = await runAiBag(trial);
    }

    // Log per-bag data.
    const bagEntry = {
      participant_id: demoParticipantId,
      batch_index: batchIdx,
      bag_index: bagIdx,
      global_trial: globalTrialIndex + 1,
      block_index: isPractice ? null : currentBlockIndex,
      condition: isPractice ? 'practice' : currentConditionKey,
      condition_label: isPractice ? 'Practice' : currentCondition.label,
      image_condition: isPractice ? 'practice' : getImageConditionKey(batchMode, currentConditionKey),
      ai_delay_ms: !isPractice && batchMode === 'ai' ? currentCondition.aiDelayMs : null,
      snippet_count: !isPractice && batchMode === 'ai' ? getConditionSnippetCount(currentCondition) : null,
      is_practice: isPractice,
      mode: batchMode,
      image_id: trial.imageId,
      category: trial.category,
      ...result,
      timestamp: new Date().toISOString(),
    };

    DB.logTrialResult(globalTrialIndex, bagEntry);
    logEvent('bag_complete', bagEntry);
    batchResults.push(bagEntry);
    globalTrialIndex++;
    await showTrialFeedback(bagEntry);
  }

  const totalBatchTime = performance.now() - batchStartTime;
  const correctCount = batchResults.filter(r => r.correct).length;
  const accuracy = (correctCount / batchResults.length * 100).toFixed(0);

  return {
    batch_index: batchIdx,
    block_index: isPractice ? null : currentBlockIndex,
    condition: isPractice ? 'practice' : currentConditionKey,
    image_condition: isPractice ? 'practice' : getImageConditionKey(batchMode, currentConditionKey),
    is_practice: isPractice,
    mode: batchMode,
    snippet_count: !isPractice && batchMode === 'ai' ? getConditionSnippetCount(currentCondition) : null,
    total_rt_ms: Math.round(totalBatchTime),
    accuracy_pct: parseFloat(accuracy),
    correct_count: correctCount,
    total_bags: batchResults.length,
    hits: batchResults.filter(r => r.hit).length,
    false_alarms: batchResults.filter(r => r.false_alarm).length,
    misses: batchResults.filter(r => r.miss).length,
    correct_rejections: batchResults.filter(r => r.correct_rejection).length,
  };
}

/* =========================================================
   Mode choice screen
   ========================================================= */
async function runModeChoice() {
  updateTrialCounter();
  applyChoiceButtonOrder();
  const heading = $('choice-batch-heading');
  if (heading) heading.textContent = `New Batch of ${getBagsPerBatch()} Bags`;
  showScreen('choice-screen');
  const btnDiy = $('btn-diy');
  const btnAi = $('btn-ai');
  btnDiy.disabled = false;
  btnAi.disabled = false;

  const choiceStart = performance.now();

  batchMode = await new Promise(resolve => {
    btnDiy.onclick = () => resolve('manual');
    btnAi.onclick = () => resolve('ai');
  });

  const choiceRt = performance.now() - choiceStart;

  logEvent('mode_choice', {
    batch_index: currentBatchIndex,
    block_index: isPractice ? null : currentBlockIndex,
    condition: isPractice ? 'practice' : currentConditionKey,
    is_practice: isPractice,
    mode: batchMode,
    choice_button_order: assignment?.choiceButtonOrder || null,
    left_button_mode: assignment?.choiceButtonOrder?.[0] || 'manual',
    choice_rt_ms: choiceRt,
  });

  DB.save(`mode_choices/batch${currentBatchIndex}`, {
    batch_index: currentBatchIndex,
    block_index: isPractice ? null : currentBlockIndex,
    condition: isPractice ? 'practice' : currentConditionKey,
    is_practice: isPractice,
    mode: batchMode,
    choice_button_order: assignment?.choiceButtonOrder || null,
    left_button_mode: assignment?.choiceButtonOrder?.[0] || 'manual',
    choice_rt_ms: choiceRt,
    timestamp: new Date().toISOString(),
  });

}

/* =========================================================
   Experiment flow
   2 assigned condition blocks, each with batchesPerBlock batches.
   Participants choose manual or AI before each batch.
   ========================================================= */
async function runExperiment() {
  const practiceCount = CONFIG.carousel.practiceBatches;
  const batchesPerBlock = CONFIG.carousel.batchesPerBlock;
  let globalBatchIdx = 0;

  // --- Practice ---
  currentConditionKey = 'optimal';
  currentCondition = CONFIG.conditions.control;

  blockBatchTotal = practiceCount;
  for (let i = 0; i < practiceCount; i++) {
    isPractice = true;
    currentBatchIndex = i;
    blockBatchIndex = i;
    updateTrialCounter();

    await runModeChoice();
    await showCountdown();
    const batchSummary = await runBatch(globalBatchIdx);
    globalBatchIdx++;

    if (i === practiceCount - 1) {
      await showBatchFeedback(
        batchSummary,
        'The real experiment will now begin.'
      );
    } else {
      await showBatchFeedback(batchSummary, 'Next batch incoming...');
    }
  }

  // --- Real blocks (2 assigned AI conditions) ---
  blockOrder = assignment.blockOrder;

  for (let block = 0; block < blockOrder.length; block++) {
    currentBlockIndex = block;
    currentConditionKey = blockOrder[block];
    currentCondition = CONFIG.conditions[currentConditionKey];
    isPractice = false;

    if (block > 0) {
      await showTransition(
        'You Have Been Reassigned',
        getReassignmentTransitionHtml(),
        { html: true, continueDelaySeconds: 3 }
      );
    }

    blockBatchTotal = batchesPerBlock;
    for (let b = 0; b < batchesPerBlock; b++) {
      currentBatchIndex = block * batchesPerBlock + b;
      blockBatchIndex = b;
      updateTrialCounter();

      await runModeChoice();
      await showCountdown();
      const batchSummary = await runBatch(globalBatchIdx);
      globalBatchIdx++;

      if (b === batchesPerBlock - 1) {
        await showBatchFeedback(
          batchSummary,
          'Please answer a few quick questions about this station.'
        );
      } else {
        await showBatchFeedback(batchSummary, 'Next batch incoming...');
      }
    }

    await runBlockSurvey(block, { isLastBlock: block === blockOrder.length - 1 });
  }

  await endExperiment();
}

/* =========================================================
   Pilot mode
   2 locked blocks per participant (no mode choice):
     Block order is counterbalanced: manual → AI or AI → manual
     AI mode gets one balanced AI condition
     Images are selected by image-level Demo counters
   Effort survey after each block.
   Between-subjects: participant gets 1 of 8 pilot cells.
   ========================================================= */
function getImageConditionKey(mode, aiConditionKey) {
  return mode === 'ai' ? `ai_${aiConditionKey}` : 'manual';
}

function getImageCountsPath() {
  return `${CONFIG.demoName}/studyInfo/imageCounts`;
}

function getPilotAssignmentPath(participantId = demoParticipantId) {
  return `${CONFIG.demoName}/studyInfo/pilotAssignments/${participantId}`;
}

function normalizeImageConditionCounts(record = {}) {
  return {
    started: Number(record.started || 0),
    completed: Number(record.completed || 0),
    updatedAt: record.updatedAt || null,
  };
}

function getConditionCountsForImage(imageCounts, imageId, imageConditionKey) {
  return normalizeImageConditionCounts(imageCounts?.[imageId]?.[imageConditionKey]);
}

function getTotalCountsForImage(imageCounts, imageId) {
  const conditionCounts = Object.values(imageCounts?.[imageId] || {});
  return conditionCounts.reduce((sum, record) => {
    const normalized = normalizeImageConditionCounts(record);
    return sum + normalized.started + normalized.completed;
  }, 0);
}

function getEffectiveImageCount(imageCounts, imageId, imageConditionKey) {
  const counts = getConditionCountsForImage(imageCounts, imageId, imageConditionKey);
  return counts.completed + (0.8 * counts.started);
}

function selectBalancedTrialsForCondition({ category, count, imageConditionKey, excludeIds, imageCounts, seed }) {
  const candidates = allTrials.filter(trial => (
    trial.category === category && !excludeIds.has(trial.imageId)
  ));

  if (candidates.length === 0) {
    console.warn(`[ImageBalance] No eligible ${category} images remain for ${imageConditionKey}.`);
    return [];
  }

  const ranked = candidates
    .map(trial => ({
      trial,
      conditionCount: getEffectiveImageCount(imageCounts, trial.imageId, imageConditionKey),
      totalCount: getTotalCountsForImage(imageCounts, trial.imageId),
      tieBreak: hashString(`${seed}:${trial.imageId}:${imageConditionKey}`),
    }))
    .sort((a, b) => (
      a.conditionCount - b.conditionCount ||
      a.totalCount - b.totalCount ||
      a.tieBreak - b.tieBreak
    ));

  if (ranked.length < count) {
    console.warn(`[ImageBalance] Needed ${count} ${category} images for ${imageConditionKey}, but only ${ranked.length} were available without reuse.`);
  }

  return ranked.slice(0, count).map(entry => entry.trial);
}

async function assignPilotCell() {
  const cells = buildPilotCells();
  const idx = await assignCondition(
    CONFIG.demoName, 'pilotCell', cells.length, 60
  );
  return {
    cellIndex: idx,
    ...cells[idx],
  };
}

function buildPilotAssignmentBlocks(cell, imageCounts) {
  const selectedIds = new Set();
  const targetPerBlock = CONFIG.pilot.batchesPerBlock * CONFIG.pilot.targetPresentPerBatch;
  const absentPerBlock = CONFIG.pilot.batchesPerBlock * (
    CONFIG.pilot.bagsPerBatch - CONFIG.pilot.targetPresentPerBatch
  );

  return cell.blockOrder.map((mode, blockIndex) => {
    const imageConditionKey = getImageConditionKey(mode, cell.aiConditionKey);
    const targetTrials = selectBalancedTrialsForCondition({
      category: 'target_present',
      count: targetPerBlock,
      imageConditionKey,
      excludeIds: selectedIds,
      imageCounts,
      seed: `${demoParticipantId}:${blockIndex}:target`,
    });

    targetTrials.forEach(trial => selectedIds.add(trial.imageId));

    const absentTrials = selectBalancedTrialsForCondition({
      category: 'target_absent',
      count: absentPerBlock,
      imageConditionKey,
      excludeIds: selectedIds,
      imageCounts,
      seed: `${demoParticipantId}:${blockIndex}:absent`,
    });

    absentTrials.forEach(trial => selectedIds.add(trial.imageId));

    return {
      blockIndex,
      mode,
      conditionKey: mode === 'ai' ? cell.aiConditionKey : 'manual',
      imageConditionKey,
      targetImageIds: targetTrials.map(trial => trial.imageId),
      absentImageIds: absentTrials.map(trial => trial.imageId),
      imageIds: shuffleArray([...targetTrials, ...absentTrials]).map(trial => trial.imageId),
    };
  });
}

async function reservePilotImageCounts(blocks, imageCounts) {
  for (const block of blocks) {
    for (const imageId of block.imageIds) {
      const current = getConditionCountsForImage(imageCounts, imageId, block.imageConditionKey);
      const next = {
        ...current,
        started: current.started + 1,
        updatedAt: Date.now(),
      };

      imageCounts[imageId] = {
        ...(imageCounts[imageId] || {}),
        [block.imageConditionKey]: next,
      };

      await writeDemoState(`${getImageCountsPath()}/${imageId}/${block.imageConditionKey}`, next);
    }
  }
}

async function createPilotAssignment() {
  const cell = await assignPilotCell();
  const aiCondition = CONFIG.conditions[cell.aiConditionKey];
  const imageCounts = await readDemoState(getImageCountsPath(), {}) || {};
  const blocks = buildPilotAssignmentBlocks(cell, imageCounts);

  const assignmentRecord = {
    status: 'reserved',
    createdAt: Date.now(),
    expiresAt: Date.now() + (60 * 60 * 1000),
    participantId: demoParticipantId,
    cellIndex: cell.cellIndex,
    cellId: cell.cellId,
    blockOrder: cell.blockOrder,
    aiCondition: cell.aiConditionKey,
    aiConditionLabel: aiCondition.label,
    aiDelayMs: aiCondition.aiDelayMs,
    snippetCount: getConditionSnippetCount(aiCondition),
    imageCounterPath: getImageCountsPath(),
    selectionStrategy: 'lowest completed + 0.8 * started, balanced separately by target/non-target category',
    blocks,
  };

  await reservePilotImageCounts(blocks, imageCounts);
  await writeDemoState(getPilotAssignmentPath(), assignmentRecord);
  await DB.save('pilot/assignment', assignmentRecord);

  return assignmentRecord;
}

function buildPilotBatchesFromAssignment(assignmentRecord) {
  const trialById = new Map(allTrials.map(trial => [trial.imageId, trial]));
  const builtBatches = [];
  const presentPerBatch = CONFIG.pilot.targetPresentPerBatch;
  const absentPerBatch = CONFIG.pilot.bagsPerBatch - presentPerBatch;

  for (const block of assignmentRecord.blocks) {
    const targetTrials = block.targetImageIds.map(id => trialById.get(id)).filter(Boolean);
    const absentTrials = block.absentImageIds.map(id => trialById.get(id)).filter(Boolean);

    for (let b = 0; b < CONFIG.pilot.batchesPerBlock; b++) {
      const targetSlice = targetTrials.slice(b * presentPerBatch, (b + 1) * presentPerBatch);
      const absentSlice = absentTrials.slice(b * absentPerBatch, (b + 1) * absentPerBatch);
      builtBatches.push(shuffleArray([...targetSlice, ...absentSlice]));
    }
  }

  return builtBatches;
}

async function markPilotImageCountsCompleted() {
  if (!pilotAssignment) return;

  const imageCounts = await readDemoState(getImageCountsPath(), {}) || {};

  for (const block of pilotAssignment.blocks) {
    for (const imageId of block.imageIds) {
      const current = getConditionCountsForImage(imageCounts, imageId, block.imageConditionKey);
      const next = {
        ...current,
        started: Math.max(0, current.started - 1),
        completed: current.completed + 1,
        updatedAt: Date.now(),
      };

      imageCounts[imageId] = {
        ...(imageCounts[imageId] || {}),
        [block.imageConditionKey]: next,
      };

      await writeDemoState(`${getImageCountsPath()}/${imageId}/${block.imageConditionKey}`, next);
    }
  }

  const completedAssignment = {
    ...pilotAssignment,
    status: 'completed',
    completedAt: Date.now(),
  };
  pilotAssignment = completedAssignment;
  await writeDemoState(getPilotAssignmentPath(), completedAssignment);
  await DB.save('pilot/completion', {
    assignment_status: 'completed',
    cell_id: pilotAssignment.cellId,
    ai_condition: pilotAssignment.aiCondition,
    block_order: pilotAssignment.blockOrder,
  });
}

async function runPilotExperiment() {
  const batchesPerBlock = CONFIG.pilot.batchesPerBlock;
  let globalBatchIdx = 0;

  pilotAssignment = await createPilotAssignment();
  blockOrder = pilotAssignment.blockOrder;
  batches = buildPilotBatchesFromAssignment(pilotAssignment);

  console.log('[Pilot] Assignment:', pilotAssignment);

  for (let block = 0; block < pilotAssignment.blocks.length; block++) {
    const assignedBlock = pilotAssignment.blocks[block];
    const blockMode = assignedBlock.mode;
    const pilotConditionKey = pilotAssignment.aiCondition;
    const pilotCondition = CONFIG.conditions[pilotConditionKey];
    currentBlockIndex = block;
    isPractice = false;

    currentConditionKey = assignedBlock.conditionKey;
    currentCondition = blockMode === 'ai'
      ? pilotCondition
      : { label: 'Manual', aiDelayMs: null, snippetCount: null };

    // Force the mode — no choice screen
    batchMode = blockMode;

    // Show block-specific instructions (intro only on first block)
    await showInstructions({ showIntro: block === 0, blockMode });

    blockBatchTotal = batchesPerBlock;

    for (let b = 0; b < batchesPerBlock; b++) {
      currentBatchIndex = block * batchesPerBlock + b;
      blockBatchIndex = b;
      updateTrialCounter();

      // Log the forced mode (no choice RT)
      logEvent('mode_forced', {
        batch_index: currentBatchIndex,
        block_index: block,
        condition: assignedBlock.conditionKey,
        image_condition: assignedBlock.imageConditionKey,
        mode: blockMode,
        pilot: true,
      });

      DB.save(`mode_choices/batch${currentBatchIndex}`, {
        batch_index: currentBatchIndex,
        block_index: block,
        condition: assignedBlock.conditionKey,
        image_condition: assignedBlock.imageConditionKey,
        mode: blockMode,
        forced: true,
        pilot: true,
        timestamp: new Date().toISOString(),
      });

      await showCountdown();
      const batchSummary = await runBatch(globalBatchIdx);
      globalBatchIdx++;

      if (b === batchesPerBlock - 1) {
        await showBatchFeedback(
          batchSummary,
          'You have completed all tasks at this screening station.'
        );
      } else {
        await showBatchFeedback(batchSummary, 'Next batch incoming...');
      }
    }

    // Effort survey after each block
    const isLastBlock = block === pilotAssignment.blocks.length - 1;
    await runBlockSurvey(block, { blockMode, conditionKey: assignedBlock.conditionKey, isLastBlock, pilot: true });
  }

  await endExperiment();
}

/**
 * Show a single survey page and wait for valid submission.
 * Returns an object with the collected data.
 */
function showSurveyPage(html) {
  const card = $('survey-card');
  card.innerHTML = html;
  card.querySelectorAll('input').forEach(input => {
    input.autocomplete = 'off';
    if (input.type === 'radio' || input.type === 'checkbox') {
      input.checked = false;
    } else {
      input.value = '';
    }
  });
  $('block-survey-overlay').classList.remove('hidden');

  return new Promise(resolve => {
    card.querySelector('.survey-submit-btn').onclick = () => {
      const error = card.querySelector('.survey-error');
      const numericInputs = Array.from(card.querySelectorAll('input[type="number"]'));
      const prefRadio = card.querySelector('input[name="preference"]:checked');

      for (const input of numericInputs) {
        const raw = input.value.trim();
        const value = Number(raw);
        const min = input.min !== '' ? Number(input.min) : -Infinity;
        const max = input.max !== '' ? Number(input.max) : Infinity;
        const needsInt = input.dataset.surveyParse === 'int';

        if (raw === '' || !Number.isFinite(value) || value < min || value > max || (needsInt && !Number.isInteger(value))) {
          error.textContent = input.dataset.error || 'Please complete all fields with valid values.';
          error.classList.remove('hidden');
          input.focus();
          return;
        }
      }

      if (card.querySelector('input[name="preference"]') && !prefRadio) {
        error.textContent = 'Please select your preference.';
        error.classList.remove('hidden');
        return;
      }

      error.classList.add('hidden');

      const data = {};
      numericInputs.forEach(input => {
        const key = input.dataset.surveyKey || input.id.replace(/^survey-/, '').replace(/-/g, '_');
        data[key] = input.dataset.surveyParse === 'int'
          ? parseInt(input.value, 10)
          : parseFloat(input.value);
      });
      if (prefRadio) data.preference = prefRadio.value;
      $('block-survey-overlay').classList.add('hidden');
      resolve(data);
    };
  });
}

/* =========================================================
   Survey helpers — shared HTML templates
   ========================================================= */
const SURVEY_TIME_EFFORT_HTML = `
  <h2>Quick Reflection</h2>
  <p>Think back to the batches you just completed in this station.</p>
  <div class="survey-question">
    <label for="survey-time">How many seconds did it take to complete one batch (${CONFIG.pilot.bagsPerBatch} bags)?</label>
    <input type="number" id="survey-time" class="survey-number-input"
      min="1" max="600" step="1"
      data-survey-key="estimated_time_sec" data-survey-parse="int"
      data-error="Please enter a whole number of seconds (1–600)."
      autocomplete="off" />
  </div>
  <div class="survey-question">
    <label for="survey-effort">How much effort did it take to complete one batch? (0 = no effort, 10 = extreme effort)</label>
    <input type="number" id="survey-effort" class="survey-number-input"
      min="0" max="10" step="1"
      data-survey-key="effort_rating" data-survey-parse="int"
      data-error="Please enter a whole number between 0 and 10."
      autocomplete="off" />
  </div>
  <div class="survey-question">
    <label for="survey-accuracy">How accurate do you think you were? (0–100%)</label>
    <input type="number" id="survey-accuracy" class="survey-number-input"
      min="0" max="100" step="1"
      data-survey-key="perceived_accuracy_pct" data-survey-parse="int"
      data-error="Please enter a whole number between 0 and 100."
      autocomplete="off" />
  </div>
  <div class="survey-error hidden"></div>
  <div class="survey-foot">
    <button class="primary-btn survey-submit-btn">Continue</button>
  </div>
`;

const SURVEY_MAIN_TIME_EFFORT_HTML = `
  <h2>Quick Reflection</h2>
  <p>Think back to the batches you just completed in this station.</p>
  <div class="survey-question">
    <label>How many seconds did it take to complete one batch (${CONFIG.carousel.bagsPerBatch} bags)?</label>
    <div class="survey-dual-inputs">
      <div class="survey-dual-col">
        <span class="survey-dual-col-label">Using AI</span>
        <input type="number" id="survey-time-ai" class="survey-number-input" min="1" max="600" step="1"
          data-survey-key="estimated_time_ai_sec" data-survey-parse="int"
          data-error="Please enter a whole number of seconds (1–600) for AI-assisted batches."
          autocomplete="off" />
      </div>
      <div class="survey-dual-col">
        <span class="survey-dual-col-label">Doing it yourself</span>
        <input type="number" id="survey-time-manual" class="survey-number-input" min="1" max="600" step="1"
          data-survey-key="estimated_time_manual_sec" data-survey-parse="int"
          data-error="Please enter a whole number of seconds (1–600) for manual batches."
          autocomplete="off" />
      </div>
    </div>
  </div>
  <div class="survey-question">
    <label>How much effort did it take to complete one batch? (0 = no effort, 10 = extreme effort)</label>
    <div class="survey-dual-inputs">
      <div class="survey-dual-col">
        <span class="survey-dual-col-label">Using AI</span>
        <input type="number" id="survey-effort-ai" class="survey-number-input" min="0" max="10" step="1"
          data-survey-key="effort_ai_rating" data-survey-parse="int"
          data-error="Please enter a whole number between 0 and 10 for AI-assisted batches."
          autocomplete="off" />
      </div>
      <div class="survey-dual-col">
        <span class="survey-dual-col-label">Doing it yourself</span>
        <input type="number" id="survey-effort-manual" class="survey-number-input" min="0" max="10" step="1"
          data-survey-key="effort_manual_rating" data-survey-parse="int"
          data-error="Please enter a whole number between 0 and 10 for manual batches."
          autocomplete="off" />
      </div>
    </div>
  </div>
  <div class="survey-question">
    <label>How accurate do you think you were? (0–100%)</label>
    <div class="survey-dual-inputs">
      <div class="survey-dual-col">
        <span class="survey-dual-col-label">Using AI</span>
        <input type="number" id="survey-accuracy-ai" class="survey-number-input" min="0" max="100" step="1"
          data-survey-key="perceived_accuracy_ai_pct" data-survey-parse="int"
          data-error="Please enter an accuracy estimate (0–100) for AI-assisted batches."
          autocomplete="off" />
      </div>
      <div class="survey-dual-col">
        <span class="survey-dual-col-label">Doing it yourself</span>
        <input type="number" id="survey-accuracy-manual" class="survey-number-input" min="0" max="100" step="1"
          data-survey-key="perceived_accuracy_manual_pct" data-survey-parse="int"
          data-error="Please enter an accuracy estimate (0–100) for manual batches."
          autocomplete="off" />
      </div>
    </div>
  </div>
  <div class="survey-error hidden"></div>
  <div class="survey-foot">
    <button class="primary-btn survey-submit-btn">Continue</button>
  </div>
`;

/* =========================================================
   Block survey — works for both pilot and main experiment
   ========================================================= */
async function runBlockSurvey(blockIndex, { blockMode = null, conditionKey = null, isLastBlock = false, pilot = false } = {}) {
  const cKey = conditionKey || currentConditionKey;
  const cLabel = cKey === 'manual' ? 'Manual' : CONFIG.conditions[cKey]?.label || '';

  const page1Data = await showSurveyPage(pilot ? SURVEY_TIME_EFFORT_HTML : SURVEY_MAIN_TIME_EFFORT_HTML);

  const surveyData = {
    block_index: blockIndex,
    condition: cKey,
    condition_label: cLabel,
    ...(blockMode && { block_mode: blockMode }),
    ...(pilot && { pilot: true }),
    ...page1Data,
  };

  DB.logBlockSurvey(blockIndex, cKey, surveyData);
}

/* =========================================================
   Debug navigation helpers
   ========================================================= */
function getExperimentState() {
  const visibleScreen = screenIds.find(id => !$(`${id}`).classList.contains('hidden')) || null;
  const visibleOverlays = [
    'consent-overlay',
    'instructions-overlay',
    'block-transition-overlay',
    'block-survey-overlay',
    'feedback-overlay',
  ].filter(id => {
    const el = $(id);
    return el && !el.classList.contains('hidden');
  });

  return {
    visibleScreen,
    visibleOverlays,
    currentBatchIndex,
    currentBagIndex,
    blockBatchIndex,
    blockBatchTotal,
    batchMode,
    globalTrialIndex,
    isPractice,
    currentBlockIndex,
    currentConditionKey,
    currentCondition,
    blockOrder,
    trialsLoaded: allTrials.length,
    batchesBuilt: batches.length,
  };
}

function hideDebugSurfaces() {
  $('app').classList.remove('hidden');
  [
    'consent-overlay',
    'instructions-overlay',
    'block-transition-overlay',
    'block-survey-overlay',
    'feedback-overlay',
  ].forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
}

function getDebugConditionKey(conditionKey = 'optimal') {
  if (CONFIG.conditions[conditionKey]) return conditionKey;
  console.warn(`[Debug] Unknown condition "${conditionKey}". Falling back to "optimal".`);
  return 'optimal';
}

function getDebugTrial(category = 'target_present') {
  const trial = allTrials.find(t => t.category === category) || allTrials[0];
  if (!trial) {
    console.warn('[Debug] Trial data has not loaded yet.');
    return null;
  }
  return trial;
}

function setDebugBlockState({ mode = 'manual', conditionKey = 'optimal', batchIndex = 0, bagIndex = 0, practice = false } = {}) {
  currentConditionKey = getDebugConditionKey(conditionKey);
  currentCondition = CONFIG.conditions[currentConditionKey];
  batchMode = mode;
  isPractice = practice;
  currentBlockIndex = 0;
  currentBatchIndex = batchIndex;
  blockBatchIndex = batchIndex;
  blockBatchTotal = CONFIG.pilot?.enabled ? CONFIG.pilot.batchesPerBlock : CONFIG.carousel.batchesPerBlock;
  currentBagIndex = bagIndex;
  updateTrialCounter();
}

function summarizeImageCountBalance(imageCounts = {}) {
  const summary = new Map();

  for (const conditions of Object.values(imageCounts)) {
    for (const [imageConditionKey, record] of Object.entries(conditions || {})) {
      const normalized = normalizeImageConditionCounts(record);
      const current = summary.get(imageConditionKey) || {
        image_condition: imageConditionKey,
        images_touched: 0,
        started: 0,
        completed: 0,
        effective_count: 0,
      };

      current.images_touched += 1;
      current.started += normalized.started;
      current.completed += normalized.completed;
      current.effective_count += normalized.completed + (0.8 * normalized.started);
      summary.set(imageConditionKey, current);
    }
  }

  return [...summary.values()].sort((a, b) => a.image_condition.localeCompare(b.image_condition));
}

async function getImageCountBalanceData() {
  const path = getImageCountsPath();
  const raw = await readDemoState(path, {}) || {};
  const summary = summarizeImageCountBalance(raw);

  console.info('[Debug] Image count balance path:', path);
  if (summary.length > 0) {
    console.table(summary);
  } else {
    console.info('[Debug] No image count balance data found.');
  }

  return { path, summary, raw };
}

function setCompletionButton({ label = COMPLETION_BUTTON_LABEL, disabled = false, onClick = null } = {}) {
  const button = $('feedback-submit');
  button.textContent = label;
  button.disabled = disabled;
  button.onclick = onClick;
  return button;
}

function renderDebugSurveyPage(page = 'time') {
  hideDebugSurfaces();
  const normalized = String(page).toLowerCase();
  const card = $('survey-card');
  card.innerHTML = normalized.includes('pilot')
    ? SURVEY_TIME_EFFORT_HTML
    : SURVEY_MAIN_TIME_EFFORT_HTML;

  card.querySelectorAll('input').forEach(input => {
    input.autocomplete = 'off';
    if (input.type === 'radio' || input.type === 'checkbox') input.checked = false;
    else input.value = '';
  });

  const submit = card.querySelector('.survey-submit-btn');
  if (submit) {
    submit.onclick = () => console.info('[Debug] Survey preview only; no data was saved.');
  }

  $('block-survey-overlay').classList.remove('hidden');
  return getExperimentState();
}

function renderDebugInstructions(mode = 'experiment', { showIntro = true } = {}) {
  hideDebugSurfaces();

  const normalized = String(mode).toLowerCase();
  const blockMode = normalized.includes('pilot-ai') ? 'ai'
    : normalized.includes('pilot-manual') ? 'manual'
      : null;
  const startSection = normalized.includes('reminder') || normalized.includes('before')
    ? 'reminder'
    : normalized.includes('ai')
      ? 'ai'
      : normalized.includes('manual')
        ? 'manual'
        : 'intro';

  void showInstructions({ showIntro, blockMode, startSection });
  return getExperimentState();
}

function renderDebugManualBlock(options = {}) {
  const trial = getDebugTrial(options.category || 'target_present');
  if (!trial) return null;

  hideDebugSurfaces();
  setDebugBlockState({ ...options, mode: 'manual' });

  const diyImg = $('diy-image');
  const threatBtn = $('diy-threat-btn');
  const safeBtn = $('diy-safe-btn');

  diyImg.src = getBaseImagePath(trial);
  threatBtn.disabled = false;
  safeBtn.disabled = false;
  threatBtn.onclick = () => console.info('[Debug] Manual preview threat button clicked.');
  safeBtn.onclick = () => console.info('[Debug] Manual preview safe button clicked.');

  showScreen('diy-screen');
  return getExperimentState();
}

async function renderDebugAiBlock(options = {}) {
  const trial = getDebugTrial(options.category || 'target_present');
  if (!trial) return null;

  hideDebugSurfaces();
  setDebugBlockState({
    ...options,
    mode: 'ai',
    conditionKey: options.conditionKey || options.condition || 'optimal',
  });

  const baseImg = $('ai-base-image');
  const imageWrap = $('ai-image-wrap');
  const threatBtn = $('ai-threat-btn');
  const safeBtn = $('ai-safe-btn');

  baseImg.src = getBaseImagePath(trial);
  await waitForImageLoad(baseImg);

  imageWrap.querySelectorAll('.bbox-overlay').forEach(el => el.remove());

  const snippets = buildSnippetList(trial);
  const bboxElements = [];
  const inspectedSet = new Set();
  const inspectedOrder = [];
  let selectedIdx = null;
  let cleanupHoverSelection = () => {};

  const refreshPreview = () => {
    renderAiSelectionPanel({
      trial,
      snippets,
      selectedIdx,
    });

    syncAiBBoxStates({
      snippets,
      bboxElements,
      selectedIdx,
      inspectedSet,
      interactiveEnabled: true,
    });
  };

  const selectSnippet = (idx) => {
    if (idx === selectedIdx) return;
    if (!inspectedSet.has(idx)) {
      inspectedSet.add(idx);
      inspectedOrder.push(idx);
    }
    selectedIdx = idx;
    refreshPreview();
  };

  refreshPreview();
  setDecisionButtons(threatBtn, safeBtn, {
    enabled: true,
    onDecision: (userSaidThreat) => {
      console.info('[Debug] AI preview bag decision:', userSaidThreat ? 'threat' : 'safe');
    },
  });

  showScreen('ai-screen');
  await nextFrame();

  const mounted = await mountAiBoundingBoxes({
    imageWrap,
    baseImg,
    snippets,
  });
  mounted.forEach((entry, idx) => { bboxElements[idx] = entry?.box; });

  cleanupHoverSelection = installAiHoverSelection({
    imageWrap,
    baseImg,
    bboxEntries: mounted,
    onHoverSnippet: selectSnippet,
    isEnabled: () => true,
  });

  refreshPreview();

  return getExperimentState();
}

function renderDebugEnd() {
  hideDebugSurfaces();

  setCompletionButton({
    label: COMPLETION_BUTTON_LABEL,
    disabled: false,
    onClick: () => console.info('[Debug] End preview only; Demo redirect was not triggered.'),
  });
  $('feedback-overlay').classList.remove('hidden');

  return getExperimentState();
}

function renderDebugChoice() {
  hideDebugSurfaces();
  showScreen('choice-screen');
  $('btn-diy').disabled = false;
  $('btn-ai').disabled = false;
  return getExperimentState();
}

function renderDebugProcessing() {
  hideDebugSurfaces();
  showScreen('ai-processing-screen');
  return getExperimentState();
}

function renderDebugImageFeedback(options = {}) {
  hideDebugSurfaces();

  const bagEntry = {
    correct: options.correct !== false,
  };

  $('block-transition-title').textContent = options.title || formatTrialFeedback(bagEntry);
  $('block-transition-text').textContent = '';
  $('block-transition-continue').onclick = () => {
    $('block-transition-overlay').classList.add('hidden');
  };
  $('block-transition-overlay').classList.remove('hidden');

  return getExperimentState();
}

function renderDebugBatchFeedback(options = {}) {
  hideDebugSurfaces();

  const title = options.title || 'You have completed a batch of images.';
  const nextMessage = options.message || 'Another batch incoming.';

  $('block-transition-title').textContent = title;
  const lines = nextMessage ? [nextMessage] : formatBatchFeedback();
  $('block-transition-text').innerHTML = lines.join('\n');
  $('block-transition-continue').onclick = () => {
    $('block-transition-overlay').classList.add('hidden');
  };
  $('block-transition-overlay').classList.remove('hidden');

  return getExperimentState();
}

function renderDebugBlockTransition(options = {}) {
  hideDebugSurfaces();

  $('block-transition-title').textContent = options.title || 'You Have Been Reassigned';
  if (options.html) {
    $('block-transition-text').innerHTML = options.message || getReassignmentTransitionHtml();
  } else if (options.message) {
    $('block-transition-text').textContent = options.message;
  } else {
    $('block-transition-text').innerHTML = getReassignmentTransitionHtml();
  }
  prepareTransitionContinueButton({
    delaySeconds: options.continueDelaySeconds ?? 3,
    onClick: () => {
      $('block-transition-overlay').classList.add('hidden');
    },
  });
  $('block-transition-overlay').classList.remove('hidden');

  return getExperimentState();
}

function jumpExperimentState(target = 'state', options = {}) {
  const name = String(target).toLowerCase();

  if (['state', 'status'].includes(name)) return getExperimentState();
  if (['choice', 'mode-choice'].includes(name)) return renderDebugChoice();
  if (['processing', 'ai-processing'].includes(name)) return renderDebugProcessing();
  if (['manual', 'diy', 'manual-block', 'diy-block', 'do-it-yourself'].includes(name)) return renderDebugManualBlock(options);
  if (['ai', 'ai-block'].includes(name)) return renderDebugAiBlock(options);
  if (['survey', 'survey-time', 'survey-effort', 'survey-1'].includes(name)) return renderDebugSurveyPage('time');
  if (['survey-pilot', 'survey-pilot-time', 'pilot-survey'].includes(name)) return renderDebugSurveyPage('pilot-time');
  if (['survey-final', 'survey-preference', 'survey-2', 'preference'].includes(name)) return renderDebugSurveyPage('preference');
  if (['instructions', 'instructions-experiment', 'experiment-instructions'].includes(name)) return renderDebugInstructions('experiment', options);
  if (['instructions-manual', 'manual-instructions'].includes(name)) return renderDebugInstructions('manual', options);
  if (['instructions-ai', 'ai-instructions'].includes(name)) return renderDebugInstructions('ai', options);
  if (['instructions-intro', 'intro-instructions'].includes(name)) return renderDebugInstructions('intro', options);
  if (['instructions-reminder', 'reminder-instructions', 'before-you-start'].includes(name)) return renderDebugInstructions('reminder', options);
  if (['image-feedback', 'feedback-image', 'bag-feedback'].includes(name)) return renderDebugImageFeedback(options);
  if (['batch-feedback', 'feedback-batch', 'batch-complete'].includes(name)) return renderDebugBatchFeedback(options);
  if (['block-transition', 'station-transition', 'last-block-feedback'].includes(name)) return renderDebugBlockTransition(options);
  if (['end', 'complete', 'completion'].includes(name)) return renderDebugEnd();

  console.warn('[Debug] Unknown target:', target);
  printExperimentDebugHelp();
  return getExperimentState();
}

function printExperimentDebugHelp() {
  const commands = {
    "jumpExperimentState('manual')": 'Preview the do-it-yourself/manual block screen.',
    "jumpExperimentState('ai')": 'Preview the AI block screen.',
    "jumpExperimentState('ai', { condition: 'full_suboptimal' })": 'Preview AI with a specific condition.',
    "jumpExperimentState('survey-time')": 'Preview the main-experiment dual-input time/effort survey.',
    "jumpExperimentState('survey-pilot')": 'Preview the pilot single-mode time/effort survey.',
    "jumpExperimentState('instructions')": 'Preview the full main-experiment instruction sequence.',
    "jumpExperimentState('instructions-intro')": 'Preview the intro section of the main-experiment instructions.',
    "jumpExperimentState('instructions-manual')": 'Preview the manual section of the main-experiment instructions.',
    "jumpExperimentState('instructions-ai')": 'Preview the AI section of the main-experiment instructions.',
    "jumpExperimentState('instructions-reminder')": 'Preview the final reminder section of the instructions.',
    "jumpExperimentState('image-feedback', { correct: true, actualThreat: true })": 'Preview the post-image feedback page.',
    "jumpExperimentState('batch-feedback', { correct: 4, total: 6 })": 'Preview the post-batch feedback page.',
    "jumpExperimentState('block-transition')": 'Preview the transition overlay between experiment blocks.',
    "jumpExperimentState('end')": 'Preview the end-of-experiment screen without logging completion.',
    'await experimentDebug.imageCounts()': 'Read studyInfo/imageCounts and print the per-condition balance summary.',
    'experimentDebug.state()': 'Return the current experiment state snapshot.',
  };
  console.table(commands);
  return commands;
}

function installExperimentDebug() {
  const api = {
    jump: jumpExperimentState,
    state: getExperimentState,
    manualBlock: renderDebugManualBlock,
    aiBlock: renderDebugAiBlock,
    imageFeedback: renderDebugImageFeedback,
    batchFeedback: renderDebugBatchFeedback,
    survey: renderDebugSurveyPage,
    instructions: renderDebugInstructions,
    imageCounts: getImageCountBalanceData,
    end: renderDebugEnd,
    help: printExperimentDebugHelp,
  };

  window.experimentDebug = api;
  window.jumpExperimentState = jumpExperimentState;
  window.getImageCountBalanceData = getImageCountBalanceData;
  console.info('[Debug] Experiment jump helpers loaded. Type experimentDebug.help() for commands.');
  return api;
}

/* =========================================================
   End experiment
   ========================================================= */
async function endExperiment() {
  $('feedback-overlay').classList.remove('hidden');
  let countdownComplete = false;
  let cleanupComplete = false;

  const syncCompletionButton = () => {
    if (countdownComplete && cleanupComplete) {
      setCompletionButton({
        label: COMPLETION_BUTTON_LABEL,
        disabled: false,
        onClick: restartDemo,
      });
      return;
    }

    if (countdownComplete && !cleanupComplete) {
      setCompletionButton({
        label: 'Finalizing...',
        disabled: true,
      });
    }
  };

  setCompletionButton({
    label: `${COMPLETION_BUTTON_LABEL} (${COMPLETION_BUTTON_COUNTDOWN_SECONDS})`,
    disabled: true,
  });

  await nextFrame();

  const countdownPromise = new Promise(resolve => {
    let remaining = COMPLETION_BUTTON_COUNTDOWN_SECONDS;
    const intervalId = setInterval(() => {
      remaining -= 1;

      if (remaining > 0) {
        setCompletionButton({
          label: `${COMPLETION_BUTTON_LABEL} (${remaining})`,
          disabled: true,
        });
        return;
      }

      clearInterval(intervalId);
      countdownComplete = true;
      syncCompletionButton();
      resolve();
    }, 1000);
  });

  const cleanupPromise = (async () => {
    try {
      await DB.logCompletion();

      // Mark pilot assignment and image reservations as completed.
      if (CONFIG.pilot && CONFIG.pilot.enabled) {
        await finalizeAssignment(CONFIG.demoName, 'pilotCell');
        await markPilotImageCountsCompleted();
      } else {
        await finalizeAssignment(CONFIG.demoName, 'experimentCell');
        await markExperimentImageCountsCompleted();
        await markExperimentAssignmentCompleted();
      }
    } catch (error) {
      console.error('[Completion] Failed to finalize study cleanup.', error);
    } finally {
      cleanupComplete = true;
      syncCompletionButton();
    }
  })();

  await Promise.all([countdownPromise, cleanupPromise]);
}

/* =========================================================
   Initialization
   ========================================================= */
async function bootstrapApp() {
  await initDemo();
  DB.init(CONFIG.demoName);
  await loadFolderManifest();

  assignment = CONFIG.pilot?.enabled
    ? {
        participantId: demoParticipantId,
        blockOrder: [],
        choiceButtonOrder: ['manual', 'ai'],
      }
    : await createExperimentAssignment();
  console.log('[Assignment]', assignment);

  await prepareReferenceTables();

  if (CONFIG.pilot?.enabled) {
    buildBatches();
  } else {
    batches = buildBatchesFromAssignment(assignment);
  }

  installExperimentDebug();

  const sessionInfo = buildSessionInfo(CONFIG, assignment.blockOrder, demoParams);
  await DB.logSessionStart({ ...sessionInfo, assignment });
}

async function init() {
  demoParams = getDemoParams();

  appBootstrapPromise = (async () => {
    setConsentStatus('Preparing study materials...', 'info');

    try {
      await bootstrapApp();
      setConsentStatus('');
    } catch (error) {
      console.error('[Init] Failed to prepare study', error);
      setConsentStatus('Study failed to finish loading. Please refresh the page and try again.', 'error');
      throw error;
    }
  })();

  setupConsent();

  try {
    await appBootstrapPromise;
  } catch (error) {
    // Consent remains visible; the status message above explains the failure.
  }
}

function setupConsent() {
  const checkbox = $('consent-checkbox');
  const btn = $('consent-agree');
  const defaultButtonLabel = btn.textContent;

  const syncConsentButton = () => {
    btn.disabled = !checkbox.checked || isStartingExperiment;
  };

  syncConsentButton();

  checkbox.addEventListener('change', syncConsentButton);

  const startExperiment = async () => {
    if (CONFIG.pilot.enabled) {
      // Pilot: instructions shown per-block inside runPilotExperiment
      await runPilotExperiment();
    } else {
      await showInstructions();
      await runExperiment();
    }
  };

  const handleConsentStart = async () => {
    if (!checkbox.checked || isStartingExperiment) return;

    isStartingExperiment = true;
    btn.textContent = 'Preparing Study...';
    setConsentStatus('Loading study materials...', 'info');
    syncConsentButton();

    try {
      await appBootstrapPromise;
      setConsentStatus('');
      $('consent-overlay').classList.add('hidden');
      await DB.logConsent(true, assignment.blockOrder, assignment?.choiceButtonOrder?.[0] === 'manual');
      await startExperiment();
    } catch (error) {
      console.error('[Consent] Unable to start experiment', error);
      btn.textContent = defaultButtonLabel;
      isStartingExperiment = false;
      setConsentStatus('Study failed to finish loading. Please refresh the page and try again.', 'error');
      syncConsentButton();
    }
  };

  btn.onclick = handleConsentStart;

  if (CONFIG.DEBUG_MODE && CONFIG.debugSkipConsent) {
    checkbox.checked = true;
    syncConsentButton();
    handleConsentStart();
  }
}

// Boot
init();
