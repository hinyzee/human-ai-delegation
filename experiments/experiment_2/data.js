export const DB = {
  init() {},
  async save(_path, value) { return value; },
  async logSessionStart(value) { return value; },
  async logConsent() {},
  async logTrialResult(_trial, value) { return value; },
  async logBlockSurvey(_block, _condition, value) { return value; },
  async logCompletion() {},
};

export function logEvent() {}

export function buildSessionInfo(config, blockOrder) {
  return {
    experimentName: config.experimentName,
    experimentVersion: config.experimentVersion,
    blockOrder,
  };
}
