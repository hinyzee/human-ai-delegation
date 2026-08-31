/* =========================================================
   TSA Baggage Screening: Automation Bias Experiment
   Configuration
   ========================================================= */

const CONFIG = {

  /* --- Experiment structure --- */
  experimentName: 'tsa_choice_pilot_v2',
  experimentVersion: '2.0',
  // === TIMING (milliseconds) ===
  timing: {
    fixation: 500,
    feedbackDuration: 1000,
    iti: 750,
    responseEnableDelayMs: 1500,
  },

  // === CAROUSEL / BATCH ===
  carousel: {
    bagsPerBatch: 4,            // bags shown sequentially per batch
    targetPresentPerBatch: 2,   // 2 target-present and 2 target-absent per batch (50/50)
    batchesPerBlock: 8,         // batches per condition block (8 x 4 = 32 trials each)
    practiceBatches: 0,         // practice batches before real experiment
  },

  // ==================================================================
  //  2 × 2 WITHIN-SUBJECTS CONDITIONS  (Speed × Effort)
  //
  //                  Low Effort        High Effort
  //  Fast (2s)       control           effort_penalty
  //  Slow (8s)       time_penalty      full_suboptimal
  // ==================================================================
  conditions: {
    optimal: {
      label:      'Optimal',
      aiDelayMs:  1000,     // fast
      snippetCount: 3,      // low effort: 3 total snippets
    },
    time_penalty: {
      label:      'Time Penalty',
      aiDelayMs:  8000,     // slow
      snippetCount: 3,      // low effort: 3 total snippets
    },
    effort_penalty: {
      label:      'Effort Penalty',
      aiDelayMs:  1000,     // fast
      snippetCount: 9,      // high effort: 9 total snippets
    },
    full_suboptimal: {
      label:      'Complete Betrayal',
      aiDelayMs:  8000,     // slow
      snippetCount: 9,      // high effort: 9 total snippets
    },
  },

  // Block 1 condition order for counterbalancing (block 2 is always full_suboptimal).
  conditionOrder: ['optimal', 'time_penalty', 'effort_penalty', 'full_suboptimal'],

  // === PATHS (relative to this demo directory) ===
  paths: {
    folderManifest: './stimuli/folder_manifest.json',
    targetPresent: './stimuli/target_present/',
    targetAbsent: './stimuli/target_absent/',
  },

  // === DISPLAY ===
  display: {
    imageMaxWidth: 800,
    imageMaxHeight: 600,
    snippetCardWidth: 200,
  },

  // === ACCURACY ===
  diyClickTolerance: 20,

  demoName: 'tsa_choice_demo',

  // ==================================================================
  //  PILOT MODE
  //  Each pilot participant gets 2 locked blocks (no mode choice):
  //    Block order is counterbalanced: Manual → AI or AI → Manual
  //    AI block gets one balanced AI condition.
  //    Images are assigned by image-level Demo counters.
  //  Effort survey after each block.
  //  Between-subjects: each participant sees only 1 of 4 AI conditions.
  // ==================================================================
  pilot: {
    enabled: false,              // set true to run pilot instead of main experiment
    bagsPerBatch: 6,             // pilot uses 6 bags per batch (main experiment uses carousel.bagsPerBatch)
    targetPresentPerBatch: 3,    // 3 target-present, 3 target-absent per batch
    batchesPerBlock: 5,          // 5 batches of 6 bags = 30 bags per block
    blockOrders: [
      ['manual', 'ai'],
      ['ai', 'manual'],
    ],
  },

  // === DEBUG ===
  DEBUG_MODE: false,
  debugForceCondition: null,
  debugSkipConsent: false,
  debugLogEvents: true,
};
